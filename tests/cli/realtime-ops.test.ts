// Integration tests for realtime (`wait --hook-rewake`, `tail`), operational commands
// (`doctor`, `backup` via VACUUM INTO, `tick`, `token`, `serve`, `daemon`, `open`),
// zero-secret guarantees, port-78 conflict handling, and real child-process CLI execution.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import {
  EXIT_HOOK_WAKE,
  EXIT_OK,
  EXIT_PORT_TAKEN,
  runCli,
  TRUST_DISCLOSURE,
  type CliIo,
} from '../../src/cli/index.ts'
import { TokenStore } from '../../src/host/auth/tokens.ts'
import { createDefaultHostBridge } from '../../src/host/bin/swarmboard.ts'
import { daemonPaths, probeUdsHello, resolveDaemonEntrypoint } from '../../src/host/daemon/index.ts'
import { openBoardStore } from '../../src/host/layout.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const BIN_TS = path.join(REPO_ROOT, 'src', 'host', 'bin', 'swarmboard.ts')

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

function makeWorkspace() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cli-ops-')))
  tmpDirs.push(dir)
  const db = path.join(dir, 'board.db')
  const xdgConfig = path.join(dir, 'xdg-config')
  fs.mkdirSync(xdgConfig, { recursive: true, mode: 0o700 })
  const bridge = createDefaultHostBridge()

  async function exec(
    args: string[],
    opts: {
      env?: Record<string, string | undefined>
      signal?: AbortSignal
      tty?: boolean
      omitDb?: boolean
    } = {},
  ) {
    let stdout = ''
    let stderr = ''
    const io: CliIo = {
      stdout(s) {
        stdout += s
      },
      stderr(s) {
        stderr += s
      },
      async readStdin() {
        return ''
      },
      stdinIsTTY: opts.tty ?? false,
      stdoutIsTTY: opts.tty ?? false,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }
    const env: Record<string, string | undefined> = {
      HOME: dir,
      XDG_CONFIG_HOME: xdgConfig,
      USER: 'tester',
      ...opts.env,
    }
    const fullArgs = opts.omitDb ? args : ['--db', db, '--mode', 'file', ...args]
    const code = await runCli(fullArgs, env, bridge, { cwd: dir, io })
    let json: unknown
    try {
      if (stdout.trim()) json = JSON.parse(stdout)
    } catch {
      json = undefined
    }
    return { code, stdout, stderr, json }
  }

  return { dir, db, xdgConfig, exec, bridge }
}

function runSubprocess(args: string[], env: Record<string, string | undefined>): Promise<{
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ['--no-warnings', BIN_TS, ...args],
      { cwd: REPO_ROOT, env: { ...process.env, ...env }, timeout: 20_000 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? 1
            : 0
        resolvePromise({ code, stdout, stderr })
      },
    )
  })
}

describe('HOST-5 CLI: realtime wait --hook-rewake & tail', () => {
  it('wait --hook-rewake exits 0 on quiet timeout and exits 2 with compact summary on wake', async () => {
    const ws = makeWorkspace()
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)

    // Quiet timeout -> exit 0 (silent in compact mode)
    const quietCompact = await ws.exec(['wait', '--inbox', '--hook-rewake', '--timeout', '150ms', '--as', 'codex'])
    expect(quietCompact.code).toBe(EXIT_OK)
    expect(quietCompact.stdout).toBe('')

    // Quiet timeout in --json -> exit 0 with { woke: false }
    const quietJson = await ws.exec(['wait', '--inbox', '--hook-rewake', '--timeout', '150ms', '--as', 'codex', '--json'])
    expect(quietJson.code).toBe(EXIT_OK)
    expect((quietJson.json as { woke: boolean; reason: string }).woke).toBe(false)
    expect((quietJson.json as { reason: string }).reason).toBe('timeout')

    // Regular wait (without --hook-rewake) -> exit 1 on timeout
    const regularTimeout = await ws.exec(['wait', 'dev', '--timeout', '150ms', '--as', 'codex', '--json'])
    expect(regularTimeout.code).toBe(1)
    expect(JSON.parse(regularTimeout.stderr).error.code).toBe('timeout')

    // Concurrent mention triggers immediate wake with exit 2!
    const waitPromise = ws.exec(['wait', '--hook-rewake', '--timeout', '5s', '--as', 'codex'])
    setTimeout(() => {
      void ws.exec(['post', 'dev', 'Ping @codex wake up!', '--as', 'agy'])
    }, 80)

    const woke = await waitPromise
    expect(woke.code).toBe(EXIT_HOOK_WAKE)
    expect(woke.stdout).toContain('wake:')
    expect(woke.stdout).toContain('Ping @codex wake up!')

    // Channel event mode with --hook-rewake + --json -> exit 2
    const cursorRes = await ws.exec(['read', 'dev', '--as', 'codex', '--json'])
    const cursor = (cursorRes.json as { cursor: string }).cursor
    const evWait = ws.exec(['wait', 'dev', '--after', cursor, '--hook-rewake', '--timeout', '5s', '--as', 'codex', '--json'])
    setTimeout(() => {
      void ws.exec(['post', 'dev', 'Second event for hook', '--as', 'agy'])
    }, 80)
    const evWoke = await evWait
    expect(evWoke.code).toBe(EXIT_HOOK_WAKE)
    expect((evWoke.json as { woke: boolean; count: number }).woke).toBe(true)
    expect((evWoke.json as { count: number }).count).toBeGreaterThanOrEqual(1)

    // CLI-F1 regression: `wait #<id>` and `wait <thread-uuid>` must NOT fail with `invalid_cursor`!
    const rootPost = await ws.exec(['post', 'dev', 'Thread root for wait ref test', '--as', 'agy', '--json'])
    expect(rootPost.code, rootPost.stderr).toBe(0)
    const { id: rootId, thread: rootThread } = rootPost.json as { id: string; thread: string }

    const waitHashTimeout = await ws.exec(['wait', `#${rootId}`, '--timeout', '120ms', '--as', 'codex', '--json'])
    expect(waitHashTimeout.code).toBe(1)
    expect(JSON.parse(waitHashTimeout.stderr).error.code).toBe('timeout')

    const waitUuidWake = ws.exec(['wait', rootThread, '--timeout', '5s', '--as', 'codex', '--json'])
    setTimeout(() => {
      void ws.exec(['reply', rootThread, 'Reply waking thread-uuid wait', '--as', 'agy'])
    }, 80)
    const uuidRes = await waitUuidWake
    expect(uuidRes.code, uuidRes.stderr).toBe(0)
    expect((uuidRes.json as { events: { message?: { text: string } }[] }).events[0]?.message?.text).toContain(
      'Reply waking thread-uuid wait',
    )
  })

  it('tail streams events in NDJSON and compact modes and stops cleanly on --limit', async () => {
    const ws = makeWorkspace()
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)
    expect((await ws.exec(['post', 'dev', 'tail msg 1', '--as', 'agy'])).code).toBe(0)
    expect((await ws.exec(['post', 'dev', 'tail msg 2', '--as', 'agy'])).code).toBe(0)

    const tailJson = await ws.exec(['tail', 'dev', '--last', '2', '--limit', '2', '--as', 'codex', '--json'])
    expect(tailJson.code, tailJson.stderr).toBe(0)
    const lines = tailJson.stdout.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!).message.text).toContain('tail msg 2')
  })
})

describe('HOST-5 CLI: doctor, backup (VACUUM INTO), tick, token, serve, and zero-secret output', () => {
  it('doctor is read-only, includes verbatim trust disclosure, and never leaks secrets', async () => {
    const ws = makeWorkspace()
    const fakeSecret = 'sb_abcdefghijkl_9999999999999999999999999999999999999999999'

    // Before init: doctor must NOT create board.db!
    const pre = await ws.exec(['doctor', '--json'], { env: { SWARMBOARD_TOKEN: fakeSecret } })
    expect(pre.code, pre.stderr).toBe(0)
    expect(fs.existsSync(ws.db)).toBe(false)
    expect(pre.stdout).not.toContain('999999999999')
    expect(pre.stderr).not.toContain('999999999999')
    const preDoc = pre.json as { board: { exists: boolean }; identity: { token: string }; trustDisclosure: string }
    expect(preDoc.board.exists).toBe(false)
    expect(preDoc.identity.token).toBe('set')
    expect(preDoc.trustDisclosure).toBe(TRUST_DISCLOSURE)

    // After init: doctor reports schema v5, boardId, and verbatim trust disclosure in text mode too
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)
    const postText = await ws.exec(['doctor'], { env: { SWARMBOARD_TOKEN: fakeSecret } })
    expect(postText.code, postText.stderr).toBe(0)
    expect(postText.stdout).toContain(TRUST_DISCLOSURE)
    expect(postText.stdout).not.toContain('999999999999')
    expect(postText.stderr).not.toContain('999999999999')
  })

  it('backup creates an online VACUUM INTO snapshot verified by PRAGMA integrity_check plus .jsonl copy', async () => {
    const ws = makeWorkspace()
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)
    expect((await ws.exec(['post', 'dev', 'persisted before backup', '--as', 'agy', '--json'])).code).toBe(0)

    const dest = path.join(ws.dir, 'backups', 'snap.db')
    const b = await ws.exec(['backup', dest, '--json'])
    expect(b.code, b.stderr).toBe(0)
    const res = b.json as { destDb: string; integrityOk: boolean; jsonlCopied: boolean; bytes: number }
    expect(res.destDb).toBe(dest)
    expect(res.integrityOk).toBe(true)
    expect(res.jsonlCopied).toBe(true)
    expect(res.bytes).toBeGreaterThan(0)
    expect(fs.existsSync(`${dest}.jsonl`)).toBe(true)

    // Verify snapshot directly via SQLite PRAGMA integrity_check and message query
    const snap = new DatabaseSync(dest, { readOnly: true })
    try {
      const check = snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      expect(check.integrity_check).toBe('ok')
      const rows = snap.prepare('SELECT data FROM board_messages WHERE channel = ?').all('dev') as { data: string }[]
      expect(rows.some((r) => r.data.includes('persisted before backup'))).toBe(true)
    } finally {
      snap.close()
    }

    // Without --force, overwriting existing dest fails; with --force, succeeds
    expect((await ws.exec(['backup', dest, '--json'])).code).toBe(1)
    expect((await ws.exec(['backup', dest, '--force', '--json'])).code).toBe(0)
    // Refuses overwriting live source DB
    expect((await ws.exec(['backup', ws.db, '--force', '--json'])).code).toBe(1)
  })

  it('tick runs one schedule/lease pass and returns TickReport', async () => {
    const ws = makeWorkspace()
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)
    const tick = await ws.exec(['tick', '--json'])
    expect(tick.code, tick.stderr).toBe(0)
    expect((tick.json as { outcome: string }).outcome).toBe('ran')
  })

  it('token issue/list/revoke enforces delegation rules and never leaks secrets on list/revoke', async () => {
    const ws = makeWorkspace()
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)

    const issued = await ws.exec([
      'token',
      'issue',
      '--profile',
      'agy',
      '--cap',
      'read,post,label',
      '--can',
      'dev=read,post',
      '--ttl',
      '2h',
      '--note',
      'worker token',
      '--json',
    ])
    expect(issued.code, issued.stderr).toBe(0)
    const data = issued.json as { token: string; record: { id: string; profile: string; cap: string[] } }
    expect(data.token).toMatch(/^sb_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/)
    expect(data.record.profile).toBe('agy')
    // CLI-F3 regression: slice after `<id>_` instead of split('_') because base64url secrets may contain `_`.
    const secretPart = data.token.slice(data.record.id.length + 1)
    expect(secretPart).toHaveLength(43)

    // Verify token works against real TokenStore
    const opened = openBoardStore({ kind: 'file', db: ws.db, dir: ws.dir, defaultDir: false })
    try {
      const store = new TokenStore(opened.store)
      const verified = store.verifyToken(data.token)
      expect(verified.id).toBe(data.record.id)
      expect(verified.profile).toBe('agy')
    } finally {
      opened.close()
    }

    // token list must NEVER leak plaintext secret or secret_hash
    const listed = await ws.exec(['token', 'list', '--json'])
    expect(listed.code, listed.stderr).toBe(0)
    expect(listed.stdout).not.toContain(secretPart)
    expect(listed.stdout).not.toContain('secret_hash')
    expect((listed.json as { tokens: { id: string }[] }).tokens.some((t) => t.id === data.record.id)).toBe(true)

    // token revoke
    const revoked = await ws.exec(['token', 'revoke', data.record.id, '--json'])
    expect(revoked.code, revoked.stderr).toBe(0)
    expect(revoked.stdout).not.toContain(secretPart)
    expect((revoked.json as { revoked: boolean }).revoked).toBe(true)

    // Agent caller attempting root token issue is refused 403
    const agentAttempt = await ws.exec(['token', 'issue', '--profile', 'codex', '--as', 'agy', '--json'])
    expect(agentAttempt.code).toBe(1)
    expect(JSON.parse(agentAttempt.stderr).error.code).toBe('forbidden')
  })

  it('serve starts HTTP listener, enforces tailscale/allow-host exclusion, and exits 78 when port is taken', async () => {
    const ws = makeWorkspace()
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)

    // Mutual exclusion check
    const conflict = await ws.exec(['serve', '--tailscale-host', 'box.ts.net', '--allow-host', 'foo.local', '--json'])
    expect(conflict.code).toBe(1)
    expect(JSON.parse(conflict.stderr).error.code).toBe('conflicting_options')

    // Occupy an ephemeral port to verify exit code 78 on EADDRINUSE
    const blocker = net.createServer()
    const takenPort = await new Promise<number>((resolvePort, rejectPort) => {
      blocker.once('error', rejectPort)
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address()
        resolvePort(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
    try {
      const portConflict = await ws.exec(['serve', '--host', '127.0.0.1', '--port', String(takenPort), '--json'])
      expect(portConflict.code).toBe(EXIT_PORT_TAKEN)
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()))
    }

    // Start real foreground server on a free port, probe /healthz, then shut down via AbortSignal!
    const probeSrv = net.createServer()
    const freePort = await new Promise<number>((resolvePort, rejectPort) => {
      probeSrv.once('error', rejectPort)
      probeSrv.listen(0, '127.0.0.1', () => {
        const addr = probeSrv.address()
        resolvePort(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
    await new Promise<void>((r) => probeSrv.close(() => r()))

    const serveAbort = new AbortController()
    const servePromise = ws.exec(
      ['serve', '--host', '127.0.0.1', '--port', String(freePort), '--no-idle-exit', '--json'],
      { signal: serveAbort.signal },
    )
    let healthy = false
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${freePort}/healthz`)
        if (res.status === 200) {
          const body = (await res.json()) as { ok: boolean }
          if (body.ok) {
            healthy = true
            break
          }
        }
      } catch {
        // wait for server listen
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(healthy).toBe(true)
    serveAbort.abort()
    const serveDone = await servePromise
    expect(serveDone.code, serveDone.stderr).toBe(0)
  })

  it('daemon start/status/logs/stop and open --no-browser wire through CliHostBridge cleanly', async () => {
    const calls: string[] = []
    const mockBridge = {
      ...createDefaultHostBridge(),
      async daemonControl(_ctx: unknown, req: { action: string; tcp?: boolean; lines?: number }) {
        calls.push(`daemon:${req.action}:tcp=${Boolean(req.tcp)}`)
        if (req.action === 'logs') return { action: 'logs' as const, ok: true, logs: ['line 1', 'line 2'] }
        return {
          action: req.action as 'start' | 'stop' | 'status' | 'restart' | 'logs',
          ok: true,
          status: { running: req.action !== 'stop', pid: req.action !== 'stop' ? 12345 : null, tcpUrl: req.tcp ? 'http://127.0.0.1:4180' : null },
        }
      },
      async openUi(_ctx: unknown, req: { host: string; port: number; noBrowser?: boolean }) {
        calls.push(`open:${req.host}:${req.port}:noBrowser=${Boolean(req.noBrowser)}`)
        return {
          url: `http://${req.host}:${req.port}`,
          loginUrl: `http://${req.host}:${req.port}/_swarm/v1/login?code=testcode`,
          expiresAt: '2026-11-26T00:01:00.000Z',
          opened: !req.noBrowser,
          pid: 12345,
        }
      },
    }
    const runMock = async (args: string[]) => {
      let stdout = ''
      let stderr = ''
      const code = await runCli(args, { HOME: os.tmpdir() }, mockBridge, {
        io: { stdout: (s) => { stdout += s }, stderr: (s) => { stderr += s }, readStdin: async () => '', stdinIsTTY: false, stdoutIsTTY: false },
      })
      return { code, stdout, stderr }
    }

    const started = await runMock(['daemon', 'start', '--tcp', '--json'])
    expect(started.code, started.stderr).toBe(0)
    expect(JSON.parse(started.stdout).status.running).toBe(true)

    const logs = await runMock(['daemon', 'logs', '-n', '20'])
    expect(logs.code).toBe(0)
    expect(logs.stdout).toContain('line 1')

    const stopped = await runMock(['daemon', 'stop', '--compact'])
    expect(stopped.code).toBe(0)
    expect(stopped.stdout).toContain('running=false')

    const openedBrowser = await runMock(['open', '--port', '4180', '--json'])
    expect(openedBrowser.code).toBe(0)
    // Default `open --json` omits one-time loginUrl from stdout!
    expect(JSON.parse(openedBrowser.stdout).loginUrl).toBeUndefined()

    const openedNoBrowser = await runMock(['open', '--port', '4180', '--no-browser', '--json'])
    expect(openedNoBrowser.code).toBe(0)
    expect(JSON.parse(openedNoBrowser.stdout).loginUrl).toContain('code=testcode')

    expect(calls).toEqual([
      'daemon:start:tcp=true',
      'daemon:logs:tcp=false',
      'daemon:stop:tcp=false',
      'open:127.0.0.1:4180:noBrowser=false',
      'open:127.0.0.1:4180:noBrowser=true',
    ])
  })

  it('daemon status works cleanly on an unstarted board and real subprocess executes CLI entrypoint end-to-end', async () => {
    const ws = makeWorkspace()
    const env = {
      HOME: ws.dir,
      XDG_CONFIG_HOME: ws.xdgConfig,
      USER: 'tester',
      SWARMBOARD_DB: ws.db,
      SWARMBOARD_MODE: 'file',
      SWARMBOARD_AGENT: '',
      BOARD_PROFILE: '',
      BOARD_URL: '',
      BOARD_TOKEN: '',
      SWARMBOARD_TOKEN: '',
    }

    const initProc = await runSubprocess(['init', '--universal', '--json'], env)
    expect(initProc.code, initProc.stderr).toBe(0)
    expect(JSON.parse(initProc.stdout).ok).toBe(true)

    const postProc = await runSubprocess(['post', 'general', 'Hello from subprocess @codex', '--as', 'agy', '--compact'], env)
    expect(postProc.code, postProc.stderr).toBe(0)
    expect(postProc.stdout).toContain('Hello from subprocess @codex')

    const statusProc = await runSubprocess(['daemon', 'status', '--json'], env)
    expect(statusProc.code, statusProc.stderr).toBe(0)
    expect(JSON.parse(statusProc.stdout).status.running).toBe(false)

    // Subprocess wait --hook-rewake sees existing unread mention immediately -> exits 2!
    const wakeProc = await runSubprocess(['wait', '--inbox', '--hook-rewake', '--timeout', '1s', '--as', 'codex'], env)
    expect(wakeProc.code).toBe(EXIT_HOOK_WAKE)
    expect(wakeProc.stdout).toContain('Hello from subprocess @codex')
  }, 30_000)

  it('CLI-F4: doctor, daemon status/stop, and open forward SWARMBOARD_TOKEN under auth.enforce=true', async () => {
    const ws = makeWorkspace()
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)

    // Issue a human/owner token (no --profile) with manage capability.
    const issued = await ws.exec(['token', 'issue', '--cap', 'manage', '--ttl', '1h', '--json'])
    expect(issued.code, issued.stderr).toBe(0)
    const ownerToken = (issued.json as { token: string }).token

    const runRoot = path.join(ws.dir, 'run')
    fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 })
    const baseEnv = {
      HOME: ws.dir,
      XDG_CONFIG_HOME: ws.xdgConfig,
      XDG_RUNTIME_DIR: runRoot,
      SWARMBOARD_TOKEN: '',
      BOARD_TOKEN: '',
    }
    const paths = daemonPaths(ws.db, { home: ws.dir, env: baseEnv })
    fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
    const nonce = randomBytes(16).toString('hex')

    const child = spawn(
      process.execPath,
      [
        '--no-warnings',
        resolveDaemonEntrypoint(),
        '--db',
        paths.dbRealpath,
        '--run',
        paths.runDir,
        '--nonce',
        nonce,
        '--no-idle-exit',
        '--auth-enforce',
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ...baseEnv },
        stdio: 'ignore',
      },
    )

    try {
      let ready = false
      for (let i = 0; i < 80; i++) {
        const hello = await probeUdsHello(paths.socketPath, 500)
        if (hello !== null && hello.nonce === nonce) {
          ready = true
          break
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(ready).toBe(true)

      // Reserve an ephemeral free port for lazy TCP activation via `open`.
      const probeSrv = net.createServer()
      const freePort = await new Promise<number>((resolvePort, rejectPort) => {
        probeSrv.once('error', rejectPort)
        probeSrv.listen(0, '127.0.0.1', () => {
          const addr = probeSrv.address()
          resolvePort(typeof addr === 'object' && addr ? addr.port : 0)
        })
      })
      await new Promise<void>((r) => probeSrv.close(() => r()))

      // Without bearer token: /_swarm/v1/status fails 401 (mode=null), /_swarm/v1/login-code fails 401.
      const unauthDoc = await ws.exec(['doctor', '--json'], { env: baseEnv })
      expect(unauthDoc.code, unauthDoc.stderr).toBe(0)
      expect((unauthDoc.json as { daemon: { running: boolean; mode: string | null } }).daemon.running).toBe(true)
      expect((unauthDoc.json as { daemon: { mode: string | null } }).daemon.mode).toBeNull()

      const unauthOpen = await ws.exec(['open', '--port', String(freePort), '--no-browser', '--json'], { env: baseEnv })
      expect(unauthOpen.code).toBe(1)
      expect(JSON.parse(unauthOpen.stderr).error.code).toBe('unauthorized')

      // With owner SWARMBOARD_TOKEN: doctor, daemon status, open (lazy listen-tcp + login-code), and daemon stop all succeed!
      const authEnv = { ...baseEnv, SWARMBOARD_TOKEN: ownerToken }

      const authDoc = await ws.exec(['doctor', '--json'], { env: authEnv })
      expect(authDoc.code, authDoc.stderr).toBe(0)
      expect((authDoc.json as { daemon: { running: boolean; mode: string | null } }).daemon.running).toBe(true)
      expect((authDoc.json as { daemon: { mode: string | null } }).daemon.mode).toBe('daemon')
      expect(authDoc.stdout).not.toContain(ownerToken.slice(-20))

      const authStatus = await ws.exec(['daemon', 'status', '--json'], { env: authEnv })
      expect(authStatus.code, authStatus.stderr).toBe(0)
      expect((authStatus.json as { status: { running: boolean; mode: string | null } }).status.running).toBe(true)
      expect((authStatus.json as { status: { mode: string | null } }).status.mode).toBe('daemon')

      const authOpen = await ws.exec(['open', '--port', String(freePort), '--no-browser', '--json'], { env: authEnv })
      expect(authOpen.code, authOpen.stderr).toBe(0)
      const openPayload = authOpen.json as { url: string; loginUrl?: string }
      expect(openPayload.url).toBe(`http://127.0.0.1:${freePort}`)
      expect(openPayload.loginUrl).toContain(`http://127.0.0.1:${freePort}/_swarm/v1/login?code=`)

      const authStop = await ws.exec(['daemon', 'stop', '--json'], { env: authEnv })
      expect(authStop.code, authStop.stderr).toBe(0)
      expect((authStop.json as { message: string }).message).toBe('daemon stopped')

      const afterStop = await ws.exec(['daemon', 'status', '--json'], { env: authEnv })
      expect(afterStop.code, afterStop.stderr).toBe(0)
      expect((afterStop.json as { status: { running: boolean } }).status.running).toBe(false)
    } finally {
      try {
        if (child.exitCode === null) child.kill('SIGKILL')
      } catch {
        // already exited
      }
      try {
        fs.rmSync(paths.runDir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup when socket path fell back to /tmp/swarmboard-<uid>/<key>
      }
    }
  }, 30_000)
})
