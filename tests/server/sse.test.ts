// HOST-9 RealtimeHub & SSE /api/v2/stream tests (V2-15: live daemon writes, WakeBridge Mode 1 writes,
// Last-Event-ID resume, private/DM ACL isolation, notifications, keep-alive, reconnect, shutdown, single listener).
import * as fs from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../src/core/public.ts'
import { createAuthenticator } from '../../src/host/auth/authenticator.ts'
import { WakeBridge } from '../../src/host/wake-bridge.ts'
import {
  createNodeHttpServer,
  createServerHandler,
  RealtimeHub,
  type ServerHandler,
} from '../../src/server/index.ts'

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []
const bridges: WakeBridge[] = []
const handlers: ServerHandler[] = []
const servers: Server[] = []

function tmpDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cb-sse-')))
  dirs.push(d)
  return d
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (servers.length > 0) {
    const srv = servers.pop()!
    await new Promise<void>((r) => {
      srv.close(() => r())
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections()
    })
  }
  while (handlers.length > 0) handlers.pop()!.close()
  while (bridges.length > 0) bridges.pop()!.stop()
  while (stores.length > 0) {
    try {
      stores.pop()!.close()
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

interface ParsedSse {
  id?: string
  event?: string
  data?: string
  json?: unknown
  comment?: string
}

async function openSseReader(url: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController()
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'text/event-stream', ...headers },
    signal: ctrl.signal,
  })
  if (!res.ok) {
    const text = await res.text()
    return { ok: false as const, status: res.status, text, close: () => ctrl.abort() }
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const queue: ParsedSse[] = []
  const waiters: Array<(item: ParsedSse | null) => void> = []
  let ended = false

  const emit = (item: ParsedSse): void => {
    const w = waiters.shift()
    if (w) w(item)
    else queue.push(item)
  }

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split(/\r?\n\r?\n/)
        buf = parts.pop() ?? ''
        for (const raw of parts) {
          if (raw.trim() === '') continue
          const lines = raw.split(/\r?\n/)
          if (lines.every((l) => l.startsWith(':'))) {
            emit({ comment: lines.join('\n') })
            continue
          }
          const frame: ParsedSse = {}
          const dataLines: string[] = []
          for (const line of lines) {
            if (line.startsWith(':')) continue
            const idx = line.indexOf(':')
            const field = idx === -1 ? line : line.slice(0, idx)
            let val = idx === -1 ? '' : line.slice(idx + 1)
            if (val.startsWith(' ')) val = val.slice(1)
            if (field === 'id') frame.id = val
            else if (field === 'event') frame.event = val
            else if (field === 'data') dataLines.push(val)
          }
          if (dataLines.length > 0) {
            frame.data = dataLines.join('\n')
            try {
              frame.json = JSON.parse(frame.data)
            } catch {
              // keep string
            }
          }
          emit(frame)
        }
      }
    } catch {
      // aborted
    } finally {
      ended = true
      while (waiters.length > 0) waiters.shift()!(null)
    }
  })()

  const next = async (predicate?: (f: ParsedSse) => boolean, timeoutMs = 4_000): Promise<ParsedSse> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      while (queue.length > 0) {
        const item = queue.shift()!
        if (!predicate || predicate(item)) return item
      }
      if (ended) throw new Error('SSE stream ended before matching frame')
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out waiting for SSE frame after ${timeoutMs}ms`)
      const item = await new Promise<ParsedSse | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onItem)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(new Error(`timed out waiting for SSE frame after ${timeoutMs}ms`))
        }, remaining)
        const onItem = (v: ParsedSse | null): void => {
          clearTimeout(timer)
          resolve(v)
        }
        waiters.push(onItem)
      })
      if (item === null) throw new Error('SSE stream ended before matching frame')
      if (!predicate || predicate(item)) return item
    }
  }

  return {
    ok: true as const,
    status: res.status,
    headers: res.headers,
    next,
    close: () => {
      ctrl.abort()
      void reader.cancel().catch(() => {})
    },
  }
}

async function startHttpBoard(opts: {
  fileBacked?: boolean
  sseKeepAliveMs?: number
  sseMaxDurationMs?: number
} = {}) {
  const dir = opts.fileBacked ? tmpDir() : null
  const dbPath = dir ? join(dir, 'board.db') : ':memory:'
  const store = new SqliteUnifiedStore({ path: dbPath })
  stores.push(store)
  let bridge: WakeBridge | null = null
  if (opts.fileBacked) {
    bridge = new WakeBridge(store, { safetyPollMs: 100, watch: true })
    bridges.push(bridge)
  }
  const board = new BoardService(store, bridge ? bridge.serviceOptions() : {})
  bridge?.start()
  const authenticator = createAuthenticator({
    store,
    authEnforce: false,
    ownerUserId: 'ada',
    ownerHandle: 'ada',
  })
  const handler = createServerHandler({
    board,
    authenticator,
    ...(opts.sseKeepAliveMs !== undefined ? { sseKeepAliveMs: opts.sseKeepAliveMs } : {}),
    ...(opts.sseMaxDurationMs !== undefined ? { sseMaxDurationMs: opts.sseMaxDurationMs } : {}),
  })
  handlers.push(handler)
  const srv = createNodeHttpServer(handler, () => ({
    listener: 'tcp-loopback',
    port: (srv.address() as AddressInfo).port,
  }))
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as AddressInfo).port
  return { dbPath, store, board, bridge, handler, baseUrl: `http://127.0.0.1:${port}`, port }
}

describe('V2-15 RealtimeHub & SSE /api/v2/stream', () => {
  it('V2-15 receives live daemon HTTP writes and direct Mode 1 SQLite writes via WakeBridge + resumes with Last-Event-ID', async () => {
    const { dbPath, baseUrl, handler } = await startHttpBoard({ fileBacked: true })

    const sse = await openSseReader(`${baseUrl}/api/v2/stream`)
    expect(sse.ok).toBe(true)
    if (!sse.ok) return
    await sse.next((f) => Boolean(f.comment?.includes('connected')))
    expect(handler.hub.activeStreams).toBe(1)

    // 1. Daemon HTTP write arrives promptly
    const t0 = performance.now()
    const postRes = await fetch(`${baseUrl}/api/v2/rpc/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'dev', text: 'via daemon http' }),
    })
    expect(postRes.status).toBe(200)
    const ev1 = await sse.next((f) => f.event === 'message')
    const daemonLatencyMs = performance.now() - t0
    expect(daemonLatencyMs).toBeLessThan(200)
    expect((ev1.json as { payload: { text: string } }).payload.text).toBe('via daemon http')
    const cursorAfter1 = ev1.id!

    // 2. Direct external Mode 1 SQLite write reaches SSE via WakeBridge
    const extStore = new SqliteUnifiedStore({ path: dbPath })
    stores.push(extStore)
    const extBoard = new BoardService(extStore)
    const extCaller = createLocalCaller({ userId: 'ada', profile: 'mode1' })
    const t1 = performance.now()
    extBoard.postMessage(extCaller, { channel: 'dev', text: 'via mode1 direct' })
    const ev2 = await sse.next((f) => f.event === 'message' && (f.json as { payload?: { text?: string } })?.payload?.text === 'via mode1 direct')
    const wakeLatencyMs = performance.now() - t1
    expect(wakeLatencyMs).toBeLessThan(500)
    expect(Number(ev2.id)).toBeGreaterThan(Number(cursorAfter1))
    sse.close()

    // 3. Post another message while disconnected, then resume with Last-Event-ID = cursorAfter1
    await fetch(`${baseUrl}/api/v2/rpc/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'dev', text: 'while offline' }),
    })

    const resumed = await openSseReader(`${baseUrl}/api/v2/stream`, { 'last-event-id': cursorAfter1 })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    const replay1 = await resumed.next((f) => f.event === 'message')
    const replay2 = await resumed.next((f) => f.event === 'message')
    expect((replay1.json as { payload: { text: string } }).payload.text).toBe('via mode1 direct')
    expect((replay2.json as { payload: { text: string } }).payload.text).toBe('while offline')
    expect(Number(replay1.id)).toBeGreaterThan(Number(cursorAfter1))
    expect(Number(replay2.id)).toBeGreaterThan(Number(replay1.id))
    resumed.close()
  })

  it('V2-15 enforces private/DM ACL on SSE streams and delivers targeted notification frames', async () => {
    const { baseUrl } = await startHttpBoard()

    // Agent claude opens SSE stream; agent codex opens SSE stream
    const claudeSse = await openSseReader(`${baseUrl}/api/v2/stream`, { 'x-board-profile': 'claude' })
    const codexSse = await openSseReader(`${baseUrl}/api/v2/stream`, { 'x-board-profile': 'codex' })
    expect(claudeSse.ok && codexSse.ok).toBe(true)
    if (!claudeSse.ok || !codexSse.ok) return
    await claudeSse.next((f) => Boolean(f.comment?.includes('connected')))
    await codexSse.next((f) => Boolean(f.comment?.includes('connected')))

    // agy creates a private DM with codex and posts a secret message
    const dmRes = await fetch(`${baseUrl}/api/v2/dm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-profile': 'agy' },
      body: JSON.stringify({ peer: 'codex' }),
    })
    expect(dmRes.status).toBe(200)
    const dmChannel = ((await dmRes.json()) as { channel: { path: string } }).channel.path

    await fetch(`${baseUrl}/api/v2/rpc/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-profile': 'agy' },
      body: JSON.stringify({ channel: dmChannel, text: 'secret dm for @codex' }),
    })

    // codex receives BOTH the DM message event AND a targeted `event: notification`
    const codexMsg = await codexSse.next((f) => f.event === 'message')
    expect((codexMsg.json as { payload: { text: string } }).payload.text).toBe('secret dm for @codex')
    const codexNotif = await codexSse.next((f) => f.event === 'notification')
    expect((codexNotif.json as { channel: string; excerpt: string }).channel).toBe(dmChannel)

    // Now agy posts a public message; claude should see ONLY the public message and NEVER the private DM!
    await fetch(`${baseUrl}/api/v2/rpc/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-profile': 'agy' },
      body: JSON.stringify({ channel: 'general', text: 'public broadcast' }),
    })
    const claudeFirst = await claudeSse.next((f) => f.event === 'message')
    expect((claudeFirst.json as { payload: { text: string } }).payload.text).toBe('public broadcast')

    claudeSse.close()
    codexSse.close()
  })

  it('V2-15 supports keep-alive pings, maxDuration reconnect, shutdown event, 410 on after>head, and C9 single store listener', async () => {
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    stores.push(store)
    const onEventSpy = vi.spyOn(store, 'onEvent')
    const board = new BoardService(store)
    const hub = new RealtimeHub(board, { keepAliveMs: 40, maxDurationMs: 140 })

    // Exactly ONE store.onEvent listener registered regardless of subscriber count!
    expect(onEventSpy).toHaveBeenCalledTimes(1)

    const ada = createLocalCaller({ userId: 'ada' })
    const subs = await Promise.all(Array.from({ length: 5 }, () => hub.subscribe(ada)))
    expect(hub.activeStreams).toBe(5)
    expect(onEventSpy).toHaveBeenCalledTimes(1)

    // Read keep-alive ping and graceful reconnect frame on sub 0
    const reader = subs[0]!.stream.getReader()
    const decoder = new TextDecoder()
    let collected = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      collected += decoder.decode(value, { stream: true })
    }
    expect(collected).toContain(': ping')
    expect(collected).toContain('event: reconnect')
    expect(collected).toContain('max_duration')

    // Check 410 cursor_expired when after > head
    await expect(hub.subscribe(ada, { after: 9999 })).rejects.toMatchObject({
      status: 410,
      code: 'cursor_expired',
    })

    // Check shutdown event on active subscriber
    const subForShutdown = await hub.subscribe(ada)
    const sdReader = subForShutdown.stream.getReader()
    hub.shutdown('retiring')
    let sdText = ''
    for (;;) {
      const { done, value } = await sdReader.read()
      if (done) break
      sdText += decoder.decode(value, { stream: true })
    }
    expect(sdText).toContain('event: shutdown')
    expect(sdText).toContain('retiring')

    for (const s of subs.slice(1)) {
      await s.stream.cancel().catch(() => {})
    }
    hub.close()
    expect(hub.activeStreams).toBe(0)
  })

  it('SD-F2 SSE /api/v2/stream?mentions=<handle> filters live events strictly by mentions', async () => {
    const { baseUrl } = await startHttpBoard()

    const sse = await openSseReader(`${baseUrl}/api/v2/stream?mentions=agy`, { 'x-board-profile': 'observer' })
    expect(sse.ok).toBe(true)
    if (!sse.ok) return
    await sse.next((f) => Boolean(f.comment?.includes('connected')))

    // Post an unrelated message mentioning bob only, then a message mentioning @agy
    await fetch(`${baseUrl}/api/v2/rpc/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-profile': 'claude' },
      body: JSON.stringify({ channel: 'dev', text: 'unrelated message for @bob only' }),
    })
    await fetch(`${baseUrl}/api/v2/rpc/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-profile': 'claude' },
      body: JSON.stringify({ channel: 'dev', text: 'hey @agy please review' }),
    })

    const first = await sse.next((f) => f.event === 'message')
    expect((first.json as { payload: { text: string } }).payload.text).toBe('hey @agy please review')
    sse.close()
  })
})
