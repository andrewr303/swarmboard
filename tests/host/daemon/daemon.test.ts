// HOST-10 lazy UDS + loopback TCP daemon lifecycle, election, SIGKILL recovery, idle-exit + WAL truncate,
// SSE veto, SocketTransport, HttpTransport, and V2-18 thin-transport boundary tests (V2-17, V2-18).
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalCaller } from '../../../src/core/public.ts'
import { isBoardError } from '../../../src/client/errors.ts'
import { HttpTransport } from '../../../src/client/transport-http.ts'
import { SocketTransport } from '../../../src/client/transport-socket.ts'
import { connect } from '../../../src/host/connect.ts'
import {
  boardKeyFor,
  daemonPaths,
  daemonStatus,
  isPidAlive,
  probeDaemon,
  runDaemonServer,
  scrubDaemonEnv,
  startDaemon,
  stopDaemon,
  type DaemonHandle,
} from '../../../src/host/daemon/index.ts'
import { asUrl, importGraph } from '../../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const tempDirs: string[] = []
const spawnedPids: number[] = []
const handles: DaemonHandle[] = []
const closables: Array<{ close(): Promise<void> }> = []

function makeShortTmp(prefix = 'cbd-'): string {
  // Keep paths short on macOS so <runDir>/b.sock stays well under 104 bytes.
  const base = fs.realpathSync(tmpdir())
  const dir = fs.mkdtempSync(join(base, prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (closables.length > 0) {
    await closables.pop()!.close().catch(() => {})
  }
  while (handles.length > 0) {
    await handles.pop()!.close().catch(() => {})
  }
  while (spawnedPids.length > 0) {
    const pid = spawnedPids.pop()!
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already dead
      }
    }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('V2-17 HOST-10 paths, env scrub, election, SIGKILL recovery, idle-exit & SSE veto', () => {
  it('V2-17 daemonPaths computes deterministic boardKey, 0700 runDir, >100 byte fallback, and scrubs agent/secret env', () => {
    const dir = makeShortTmp()
    const db = join(dir, 'board.db')
    fs.writeFileSync(db, '', { mode: 0o600 })

    const k1 = boardKeyFor(db)
    const k2 = boardKeyFor(db)
    expect(k1.boardKey).toBe(k2.boardKey)
    expect(k1.boardKey).toHaveLength(20)

    const pMac = daemonPaths(db, { platform: 'darwin', home: '/Users/test' })
    expect(pMac.transport).toBe('uds')
    expect(pMac.socketPath).toBe(`/Users/test/.swarmboard/run/${k1.boardKey}/b.sock`)

    // Socket path > 100 bytes falls back to /tmp/swarmboard-<uid>/<boardKey>/b.sock
    const longHome = '/Users/' + 'x'.repeat(85)
    const pLong = daemonPaths(db, { platform: 'darwin', home: longHome, uid: process.getuid?.() ?? 501 })
    expect(pLong.socketPath.startsWith('/tmp/swarmboard-')).toBe(true)
    expect(Buffer.byteLength(pLong.socketPath, 'utf8')).toBeLessThanOrEqual(100)

    const pWin = daemonPaths(db, {
      platform: 'win32',
      home: 'C:\\Users\\test',
      env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    })
    expect(pWin.transport).toBe('pipe')
    expect(pWin.socketPath).toBe(`\\\\.\\pipe\\swarmboard-${k1.boardKey}`)

    const scrubbed = scrubDaemonEnv({
      PATH: '/usr/bin',
      HOME: '/Users/test',
      SWARMBOARD_AGENT: 'codex',
      BOARD_PROFILE: 'agy',
      SWARMBOARD_TOKEN: 'sb_secret_token',
      BOARD_TOKEN: 'legacy_secret',
      FUSION_AGENT_ID: 'f1',
      FUSION_SWARM_ID: 's1',
      XDG_RUNTIME_DIR: '/run/user/1000',
    })
    expect(scrubbed.PATH).toBe('/usr/bin')
    expect(scrubbed.XDG_RUNTIME_DIR).toBe('/run/user/1000')
    expect(scrubbed.SWARMBOARD_AGENT).toBeUndefined()
    expect(scrubbed.BOARD_PROFILE).toBeUndefined()
    expect(scrubbed.SWARMBOARD_TOKEN).toBeUndefined()
    expect(scrubbed.BOARD_TOKEN).toBeUndefined()
    expect(scrubbed.FUSION_AGENT_ID).toBeUndefined()
    expect(scrubbed.FUSION_SWARM_ID).toBeUndefined()
  })

  it('V2-17 16 racing connect({ mode: "daemon" }) calls elect exactly 1 daemon PID, and SIGKILL stale b.sock recovers automatically', async () => {
    const dir = makeShortTmp()
    const db = join(dir, 'board.db')
    const runDir = join(dir, 'run')
    const caller = createLocalCaller({ userId: 'ada', profile: 'w1' })

    // 16 concurrent callers race on a brand-new DB
    const racing = Array.from({ length: 16 }, (_, i) =>
      connect({
        db,
        mode: 'daemon',
        caller: createLocalCaller({ userId: 'ada', profile: `r${i}` }),
        context: { env: {}, cwd: dir, home: dir },
        daemon: { runDir, idleExitS: 60, spawnTimeoutMs: 10_000 },
      }),
    )
    const connected = await Promise.all(racing)
    for (const c of connected) closables.push(c)

    const status = await daemonStatus(db, { runDirOverride: runDir })
    expect(status.running).toBe(true)
    expect(status.endpoint).not.toBeNull()
    const firstPid = status.endpoint!.pid
    spawnedPids.push(firstPid)

    // Every client selected Mode 2 daemon and can post through the single elected daemon
    for (const c of connected) {
      expect(c.selection.mode).toBe('daemon')
    }
    const msg = await connected[0]!.post('dev', 'elected single daemon')
    expect(msg.text).toBe('elected single daemon')

    // Verify socket permissions are 0600 inside 0700 runDir on POSIX
    if (process.platform !== 'win32') {
      expect(fs.statSync(runDir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(status.paths!.socketPath).mode & 0o777).toBe(0o600)
    }

    for (const c of connected) await c.close()

    // SIGKILL the daemon, leaving stale b.sock + endpoint.json behind
    process.kill(firstPid, 'SIGKILL')
    const deadWait = Date.now() + 3_000
    while (Date.now() < deadWait && isPidAlive(firstPid)) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(isPidAlive(firstPid)).toBe(false)
    expect(fs.existsSync(status.paths!.socketPath)).toBe(true)
    expect(fs.existsSync(status.paths!.endpointFile)).toBe(true)

    const staleProbe = await probeDaemon(db, { runDirOverride: runDir })
    expect(staleProbe.status).toBe('stale')

    // Next connect({ mode: 'daemon' }) recovers automatically, unlinks stale b.sock, and spawns a fresh daemon
    const recovered = await connect({
      db,
      mode: 'daemon',
      caller,
      context: { env: {}, cwd: dir, home: dir },
      daemon: { runDir, idleExitS: 60, spawnTimeoutMs: 10_000 },
    })
    closables.push(recovered)
    const status2 = await daemonStatus(db, { runDirOverride: runDir })
    expect(status2.running).toBe(true)
    expect(status2.endpoint!.pid).not.toBe(firstPid)
    spawnedPids.push(status2.endpoint!.pid)

    // Prior data persisted across SIGKILL recovery
    const readBack = await recovered.channel('dev').messages()
    expect(readBack.messages.some((m) => m.text === 'elected single daemon')).toBe(true)
    await recovered.close()

    // Clean stopDaemon
    const stopped = await stopDaemon(db, { runDirOverride: runDir })
    expect(stopped.stopped).toBe(true)
    expect(isPidAlive(status2.endpoint!.pid)).toBe(false)
  }, 30_000)

  it('V2-17 idle auto-exit runs PRAGMA wal_checkpoint(TRUNCATE) + cleans endpoint.json/b.sock, and open SSE vetoes idle exit', async () => {
    const dir = makeShortTmp()
    const db = join(dir, 'board.db')
    const runDir = join(dir, 'run')

    const handle = await runDaemonServer({
      db,
      runDir,
      idleExitMs: 220,
      tcp: { host: '127.0.0.1', port: 0 },
      tick: 'off',
    })
    handles.push(handle)

    // Write a few posts so WAL has frames
    const sock = new SocketTransport({ socketPath: handle.paths.socketPath })
    closables.push(sock)
    await sock.ready()
    await sock.call('post', { channel: 'dev', text: 'before idle' })
    await sock.call('post', { channel: 'dev', text: 'second post' })

    // Open an SSE stream on TCP to veto idle exit past 220 ms
    const sseCtrl = new AbortController()
    const sseRes = await fetch(`${handle.tcp!.url}/api/v2/stream`, {
      headers: { accept: 'text/event-stream' },
      signal: sseCtrl.signal,
    })
    expect(sseRes.status).toBe(200)
    const reader = sseRes.body!.getReader()
    await reader.read() // consume ': connected'
    expect(handle.handler.hub.activeStreams).toBe(1)

    // Wait 380 ms (> 220 ms idleExitMs): daemon MUST still be alive due to SSE veto!
    await new Promise((r) => setTimeout(r, 380))
    const stillAlive = await probeDaemon(db, { runDirOverride: runDir })
    expect(stillAlive.status).toBe('live')

    // Close SSE stream -> daemon should idle-exit promptly!
    sseCtrl.abort()
    await reader.cancel().catch(() => {})
    await sock.close()

    await Promise.race([
      handle.done,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('daemon did not idle-exit')), 4_000)),
    ])

    // endpoint.json and b.sock cleaned up; WAL truncated (0 bytes or removed)
    expect(fs.existsSync(handle.paths.endpointFile)).toBe(false)
    expect(fs.existsSync(handle.paths.socketPath)).toBe(false)
    if (fs.existsSync(`${db}-wal`)) {
      expect(fs.statSync(`${db}-wal`).size).toBe(0)
    }
  }, 15_000)

  it('V2-17 startDaemon with tcp activates loopback HTTP and SocketTransport/HttpTransport round-trip RPC, SSE & binary attachments', async () => {
    const dir = makeShortTmp()
    const db = join(dir, 'board.db')
    const runDir = join(dir, 'run')

    const started = await startDaemon(db, {
      runDirOverride: runDir,
      idleExitS: 0, // --no-idle-exit
      tcp: { host: '127.0.0.1', port: 0 },
      spawnTimeoutMs: 10_000,
    })
    spawnedPids.push(started.endpoint.pid)
    expect(started.hello.idleExitS).toBe(0)
    expect(started.hello.tcp).not.toBeNull()

    // 1. SocketTransport over UDS
    const sock = new SocketTransport({ socketPath: started.paths.socketPath, defaultProfile: 'agy' })
    closables.push(sock)
    const sockCaps = await sock.ready()
    expect(sockCaps.mode).toBe('daemon')
    expect(sockCaps.transport).toBe('uds')
    expect(sockCaps.boardId).toBe(started.hello.boardId)

    // Upload & download binary attachment via SocketTransport RPC
    const uploaded = await sock.call('upload', {
      name: 'hello.bin',
      type: 'application/octet-stream',
      data: new Uint8Array([1, 2, 3, 4]),
    })
    const downloaded = await sock.call('attachment', { id: uploaded.id })
    expect(Array.from(downloaded.data)).toEqual([1, 2, 3, 4])

    // 2. HttpTransport over loopback TCP
    const tcpUrl = `http://${started.hello.tcp!.host}:${started.hello.tcp!.port}`
    const http = new HttpTransport({ url: tcpUrl, defaultProfile: 'codex' })
    closables.push(http)
    const httpCaps = await http.ready()
    expect(httpCaps.boardId).toBe(started.hello.boardId)

    // Start SSE events() iterator on SocketTransport, post via HttpTransport, receive live over UDS SSE!
    const feedCtrl = new AbortController()
    const firstLive = (async () => {
      for await (const page of sock.events({ channel: 'dev' }, { signal: feedCtrl.signal })) {
        if (page.events.length > 0) {
          feedCtrl.abort()
          return page.events[0]!
        }
      }
      return null
    })()

    // Small settle so SSE subscription is registered
    await new Promise((r) => setTimeout(r, 80))
    const posted = await http.call('post', { channel: 'dev', text: 'hello over tcp -> uds sse' })
    expect(posted.message.by.actor).toBe('local:user:' + (await http.call('me', {})).principal.slice('local:user:'.length) + '+codex')

    const liveEvent = await firstLive
    expect(liveEvent).not.toBeNull()
    expect((liveEvent!.payload as { text?: string }).text).toBe('hello over tcp -> uds sse')

    // X-Swarmboard-Expect-Instance mismatch -> 410 cursor_expired over HttpTransport
    let staleErr: unknown = null
    try {
      await http.call('me', {}, { expectInstance: 'i_wrong_instance' })
    } catch (e) {
      staleErr = e
    }
    expect(isBoardError(staleErr)).toBe(true)
    expect(staleErr).toMatchObject({ status: 410, code: 'cursor_expired' })

    await sock.close()
    await http.close()
    const stopped = await stopDaemon(db, { runDirOverride: runDir })
    expect(stopped.stopped).toBe(true)
  }, 25_000)

  it('V2-17 auth.enforce=true fails closed (daemon_required) when daemon cannot start', async () => {
    const dir = makeShortTmp()
    const db = join(dir, 'board.db')
    const runDir = join(dir, 'run')
    const caller = createLocalCaller({ userId: 'ada', profile: 'w1' })

    // Force spawn failure by pointing daemonScript at a nonexistent file
    let err: unknown = null
    try {
      await connect({
        db,
        mode: 'daemon',
        caller,
        context: { env: {}, cwd: dir, home: dir },
        daemon: {
          runDir,
          daemonScript: join(dir, 'missing-daemon.mjs'),
          spawnTimeoutMs: 500,
        },
      })
    } catch (e) {
      err = e
    }
    // Without auth.enforce, mode: daemon falls back to shared-file — verify that works below!
    expect(err).toBeNull()

    // Now test with auth.enforce: true in project config -> MUST fail closed with 403 daemon_required!
    const repo = makeShortTmp('cb-auth-')
    fs.mkdirSync(join(repo, '.git'))
    fs.mkdirSync(join(repo, '.swarmboard'), { mode: 0o700 })
    fs.writeFileSync(
      join(repo, '.swarmboard', 'config.json'),
      JSON.stringify({ version: 1, auth: { enforce: true } }),
    )
    let enforcedErr: unknown = null
    try {
      await connect({
        mode: 'daemon',
        caller,
        context: { env: {}, cwd: repo, home: repo },
        daemon: {
          runDir: join(repo, 'run'),
          daemonScript: join(repo, 'missing-daemon.mjs'),
          spawnTimeoutMs: 500,
        },
      })
    } catch (e) {
      enforcedErr = e
    }
    expect(isBoardError(enforcedErr)).toBe(true)
    expect(enforcedErr).toMatchObject({ status: 403, code: 'daemon_required' })
  })

  it('V2-18 thin transport boundary: transport-socket.ts and transport-http.ts resolve zero src/core/ and zero zod edges', async () => {
    const sockFile = join(ROOT, 'src', 'client', 'transport-socket.ts')
    const httpFile = join(ROOT, 'src', 'client', 'transport-http.ts')
    const edges = await importGraph([sockFile, httpFile])
    const targets = new Set([asUrl(sockFile), asUrl(httpFile)])

    for (const [parent, child] of edges) {
      if (!targets.has(parent)) continue
      expect(child, `${parent} -> ${child}`).not.toContain('/src/core/')
      expect(child, `${parent} -> ${child}`).not.toMatch(/\/node_modules\/(\.pnpm\/[^/]*\/node_modules\/)?zod\//)
    }
    // Also check transitive closure from both files has zero src/core and zero zod
    const adj = new Map<string, string[]>()
    for (const [p, c] of edges) {
      const list = adj.get(p) ?? []
      list.push(c)
      adj.set(p, list)
    }
    const visited = new Set<string>()
    const stack = [...targets]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (visited.has(cur)) continue
      visited.add(cur)
      expect(cur).not.toContain('/src/core/')
      expect(cur).not.toMatch(/\/node_modules\/(\.pnpm\/[^/]*\/node_modules\/)?zod\//)
      for (const nxt of adj.get(cur) ?? []) stack.push(nxt)
    }
  }, 60_000)
})
