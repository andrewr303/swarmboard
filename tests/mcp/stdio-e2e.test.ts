import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveLocalIdentity } from '../../src/host/auth/local.ts'
import { parseMcpArgv, runMcpMain } from '../../src/host/bin/swarmboard-mcp.ts'
import { connect } from '../../src/host/connect.ts'
import {
  encodeFrame,
  FrameParser,
  type FramingMode,
  type JsonRpcFailure,
  type JsonRpcResponse,
  type JsonRpcSuccess,
} from '../../src/mcp/framing.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const BIN_PATH = join(ROOT, 'src', 'host', 'bin', 'swarmboard-mcp.ts')

const tmpDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cb-mcp-e2e-'))
  tmpDirs.push(dir)
  return dir
}

const liveChildren: ChildProcessWithoutNullStreams[] = []
afterEach(() => {
  while (liveChildren.length > 0) {
    const child = liveChildren.pop()!
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

interface LiveMcpClient {
  readonly child: ChildProcessWithoutNullStreams
  readonly stderrChunks: string[]
  readonly rawStdoutChunks: string[]
  send(msg: unknown, mode?: FramingMode): void
  waitForId(id: number | string, timeoutMs?: number): Promise<JsonRpcResponse>
  closeAndWaitExit(timeoutMs?: number): Promise<number | null>
}

function spawnMcp(env: Record<string, string | undefined>, args: string[] = []): LiveMcpClient {
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k.startsWith('SWARMBOARD_') || k.startsWith('BOARD_') || k.startsWith('FUSION_')) continue
    cleanEnv[k] = v
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) cleanEnv[k] = v
  }

  const child = spawn(process.execPath, ['--no-warnings', BIN_PATH, ...args], {
    cwd: ROOT,
    env: cleanEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  liveChildren.push(child)

  const parser = new FrameParser()
  const stderrChunks: string[] = []
  const rawStdoutChunks: string[] = []
  const responses = new Map<string, JsonRpcResponse>()
  const waiters = new Map<string, (resp: JsonRpcResponse) => void>()

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk))

  child.stdout.on('data', (chunk: Buffer) => {
    rawStdoutChunks.push(chunk.toString('utf8'))
    for (const frame of parser.push(chunk)) {
      if (frame.kind === 'error') {
        throw new Error(`Invalid JSON-RPC frame on stdout: ${frame.message}\nRaw:\n${rawStdoutChunks.join('')}`)
      }
      const msg = frame.value as JsonRpcResponse
      const key = String(msg.id)
      const waiter = waiters.get(key)
      if (waiter) {
        waiters.delete(key)
        waiter(msg)
      } else {
        responses.set(key, msg)
      }
    }
  })

  return {
    child,
    stderrChunks,
    rawStdoutChunks,
    send(msg: unknown, mode: FramingMode = 'ndjson') {
      child.stdin.write(encodeFrame(msg, mode))
    },
    waitForId(id: number | string, timeoutMs = 10_000): Promise<JsonRpcResponse> {
      const key = String(id)
      const existing = responses.get(key)
      if (existing) {
        responses.delete(key)
        return Promise.resolve(existing)
      }
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(key)
          reject(
            new Error(
              `Timed out waiting for response id=${key} after ${timeoutMs}ms\nstderr:\n${stderrChunks.join('')}\nstdout:\n${rawStdoutChunks.join('')}`,
            ),
          )
        }, timeoutMs)
        waiters.set(key, (resp) => {
          clearTimeout(timer)
          resolvePromise(resp)
        })
      })
    },
    closeAndWaitExit(timeoutMs = 10_000): Promise<number | null> {
      return new Promise((resolvePromise, reject) => {
        if (child.exitCode !== null) return resolvePromise(child.exitCode)
        const timer = setTimeout(() => {
          reject(new Error(`MCP child did not exit within ${timeoutMs}ms\nstderr:\n${stderrChunks.join('')}`))
        }, timeoutMs)
        child.once('exit', (code) => {
          clearTimeout(timer)
          resolvePromise(code)
        })
        child.stdin.end()
      })
    },
  }
}

function parseToolText<T = Record<string, unknown>>(resp: JsonRpcResponse): { readonly data: T; readonly isError: boolean } {
  expect('result' in resp, JSON.stringify(resp)).toBe(true)
  const result = (resp as JsonRpcSuccess).result as { isError?: boolean; content: [{ type: 'text'; text: string }] }
  return {
    data: JSON.parse(result.content[0].text) as T,
    isError: result.isError === true,
  }
}

describe('HOST-6 live stdio E2E (swarmboard-mcp.ts, V2-20)', () => {
  it('runs NDJSON handshake, 22 tools, claim cache, cross-process @group board_wait wake, board_feedback, and active->offline EOF lifecycle', async () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'board.db')
    const xdgConfig = join(dir, 'xdg-config')

    const mcp = spawnMcp({
      SWARMBOARD_DB: dbPath,
      SWARMBOARD_MODE: 'file',
      SWARMBOARD_AGENT: 'agy',
      SWARMBOARD_HARNESS: 'agy',
      SWARMBOARD_MODEL: 'gemini-pro',
      XDG_CONFIG_HOME: xdgConfig,
    })

    // 1. Initialize & tools/list
    mcp.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agy-test' } },
    })
    const initResp = (await mcp.waitForId(1)) as JsonRpcSuccess
    expect(initResp.result).toMatchObject({
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'swarmboard-mcp' },
    })
    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const listResp = (await mcp.waitForId(2)) as JsonRpcSuccess
    expect((listResp.result as { tools: unknown[] }).tools).toHaveLength(22)

    // 2. Verify auto-presence set 'active' with harness & model from a sibling Mode 1 client
    const codexId = resolveLocalIdentity({ as: 'codex', isTTY: false, env: {} })
    const codex = await connect({ db: dbPath, mode: 'file', identity: codexId.provider })
    try {
      const online = await codex.presence.list()
      const agyPresence = online.find((p) => p.profile === 'agy')
      expect(agyPresence).toMatchObject({ status: 'active', harness: 'agy', model: 'gemini-pro' })

      // 3. Create @reviewers group + test live cross-process @group wake via board_wait!
      await codex.groups.create({
        handle: 'reviewers',
        name: 'Reviewers',
        members: ['agy', 'codex'],
      })

      mcp.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'board_wait', arguments: { mode: 'inbox', timeoutS: 10 } },
      })
      await new Promise((r) => setTimeout(r, 80))

      const tWake = Date.now()
      await codex.post('general', 'Cross-process ping for @reviewers!')
      const wakeResp = parseToolText<{
        woke: boolean
        notifications: Array<{ reason: string; sourceGroup?: string; excerpt: string }>
      }>(await mcp.waitForId(3))
      const wakeLatencyMs = Date.now() - tWake
      expect(wakeResp.isError).toBe(false)
      expect(wakeResp.data.woke).toBe(true)
      expect(wakeResp.data.notifications.some((n) => n.reason === 'group_mention' && n.sourceGroup === 'reviewers')).toBe(
        true,
      )
      expect(wakeLatencyMs).toBeLessThan(3000)

      // 4. Claim cache across board_task_create -> board_task_claim -> board_task_update(complete)
      mcp.send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'board_task_create', arguments: { channel: 'work', text: 'Live stdio task' } },
      })
      const createdTask = parseToolText<{ task: { id: string } }>(await mcp.waitForId(4))
      expect(createdTask.isError).toBe(false)
      const taskId = createdTask.data.task.id

      mcp.send({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'board_task_claim', arguments: { id: taskId } },
      })
      const claimed = parseToolText<{ claimed: boolean; claim: { cached: boolean } }>(await mcp.waitForId(5))
      expect(claimed.data.claimed).toBe(true)
      expect(claimed.data.claim.cached).toBe(true)

      mcp.send({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'board_task_update', arguments: { action: 'complete', id: taskId, result: 'Done over stdio' } },
      })
      const completed = parseToolText<{ ok: boolean; task: { task?: { state: string } } }>(await mcp.waitForId(6))
      expect(completed.isError).toBe(false)
      expect(completed.data.task.task?.state).toBe('completed')

      // 5. board_feedback posts into meta/feedback
      mcp.send({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'board_feedback',
          arguments: { summary: 'Live stdio feedback check', kind: 'perf', severity: 'low' },
        },
      })
      const fb = parseToolText<{ ok: boolean; message: { channel: string; labels?: Record<string, string> } }>(
        await mcp.waitForId(7),
      )
      expect(fb.isError).toBe(false)
      expect(fb.data.message.channel).toBe('meta/feedback')
      expect(fb.data.message.labels?.['harness']).toBe('agy')

      // 6. Close stdin (EOF) -> clean exit 0 + presence transitions to 'offline'
      const exitCode = await mcp.closeAndWaitExit()
      expect(exitCode).toBe(0)

      const afterEof = await codex.presence.list({ includeOffline: true })
      const agyAfter = afterEof.find((p) => p.profile === 'agy')
      expect(agyAfter?.status).toBe('offline')
    } finally {
      await codex.close()
    }
  }, 30_000)

  it('supports Content-Length framing on live stdio and replies with Content-Length headers', async () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'board.db')
    const mcp = spawnMcp({
      SWARMBOARD_DB: dbPath,
      SWARMBOARD_MODE: 'file',
      SWARMBOARD_AGENT: 'claude',
      XDG_CONFIG_HOME: join(dir, 'xdg'),
    })

    mcp.send(
      {
        jsonrpc: '2.0',
        id: 'cl-1',
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', clientInfo: { name: 'lsp-client' } },
      },
      'content-length',
    )
    const init = (await mcp.waitForId('cl-1')) as JsonRpcSuccess
    expect((init.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05')
    expect(mcp.rawStdoutChunks.join('')).toContain('Content-Length:')

    mcp.send({ jsonrpc: '2.0', id: 'cl-2', method: 'ping' }, 'content-length')
    const ping = (await mcp.waitForId('cl-2')) as JsonRpcSuccess
    expect(ping.result).toEqual({})

    expect(await mcp.closeAndWaitExit()).toBe(0)
  }, 20_000)

  it('refuses non-TTY stdio without SWARMBOARD_AGENT/--as (401 agent_identity_required) and handles SIGTERM cleanly', async () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'board.db')

    // Missing agent identity -> initialize returns structured error (never impersonates human)
    const noId = spawnMcp({
      SWARMBOARD_DB: dbPath,
      SWARMBOARD_MODE: 'file',
      XDG_CONFIG_HOME: join(dir, 'xdg'),
    })
    noId.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    const errResp = (await noId.waitForId(1)) as JsonRpcFailure
    expect('error' in errResp).toBe(true)
    expect((errResp.error.data as { code?: string; status?: number })?.code).toBe('agent_identity_required')
    expect((errResp.error.data as { status?: number })?.status).toBe(401)
    expect(await noId.closeAndWaitExit()).toBe(0)

    // SIGTERM during active board_wait exits cleanly with code 0
    const sigChild = spawnMcp({
      SWARMBOARD_DB: dbPath,
      SWARMBOARD_MODE: 'file',
      SWARMBOARD_AGENT: 'codex',
      XDG_CONFIG_HOME: join(dir, 'xdg2'),
    })
    sigChild.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    await sigChild.waitForId(1)
    sigChild.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'board_wait', arguments: { mode: 'inbox', timeoutS: 20 } },
    })
    await new Promise((r) => setTimeout(r, 80))

    const exitPromise = new Promise<number | null>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('SIGTERM shutdown timed out')), 5000)
      sigChild.child.once('exit', (code) => {
        clearTimeout(timer)
        resolvePromise(code)
      })
    })
    sigChild.child.kill('SIGTERM')
    expect(await exitPromise).toBe(0)
  }, 20_000)

  it('parses CLI flags cleanly and writes --help/--version strictly to stderr (never stdout)', async () => {
    expect(parseMcpArgv(['--db', '/tmp/b.db', '--mode=file', '--as', 'agy'])).toEqual({
      flags: { db: '/tmp/b.db', mode: 'file', as: 'agy' },
      help: false,
      version: false,
    })
    expect(() => parseMcpArgv(['--mode', 'bogus'])).toThrow(/--mode/)
    expect(() => parseMcpArgv(['--unknown'])).toThrow(/unknown argument/)

    const out = new PassThrough()
    const err = new PassThrough()
    let stdoutText = ''
    let stderrText = ''
    out.on('data', (c: Buffer) => {
      stdoutText += c.toString('utf8')
    })
    err.on('data', (c: Buffer) => {
      stderrText += c.toString('utf8')
    })

    const codeHelp = await runMcpMain(['--help'], { output: out, stderr: err, installSignalHandlers: false })
    expect(codeHelp).toBe(0)
    expect(stdoutText).toBe('')
    expect(stderrText).toContain('swarmboard-mcp')

    stderrText = ''
    const codeVer = await runMcpMain(['--version'], { output: out, stderr: err, installSignalHandlers: false })
    expect(codeVer).toBe(0)
    expect(stdoutText).toBe('')
    expect(stderrText.trim().length).toBeGreaterThan(0)
  })
})
