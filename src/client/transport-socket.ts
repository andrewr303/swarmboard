// Thin UDS / named-pipe transport for Swarmboard Modes 2-3 (HOST-10, Swarmboard v2 launch design §4.3).
// HS-55 thin-client boundary: ZERO runtime imports from src/core/ and ZERO runtime imports from zod.
// Uses HTTP/1.1 keep-alive over a Unix domain socket or Windows named pipe (`node:http` Agent),
// calls `POST /api/v2/rpc/:op`, auto-mints idempotency keys on `client-id` ops, retries transient
// 503/ECONNRESET via `withRetry`, slices long waits, and streams `events()` over SSE `/api/v2/stream`.
import { Agent, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import type { BoardEventView, EventsPage } from '../core/public.ts'
import { ClientError, clientError, isBoardError, type BoardErrorLike, type ErrorOrigin } from './errors.ts'
import { keyUse, mintKey } from './idempotency.ts'
import {
  isOpName,
  laneKind,
  OP_NAMES,
  OPS,
  validateEnvelope,
  type OpInput,
  type OpName,
  type OpOutput,
} from './ops.ts'
import { withRetry, type RetryPolicy } from './retry.ts'
import type { BoardTransport, CallOptions, Capabilities, EventsFeedQuery, Mode } from './types.ts'
import { CLIENT_VERSION, PROTOCOL_VERSION } from './version.ts'

export interface SocketTransportOptions {
  /** Unix domain socket path or Windows named pipe (`\\.\pipe\...`). */
  readonly socketPath: string
  /** Transport mode label ('daemon' | 'service', default 'daemon'). */
  readonly mode?: Extract<Mode, 'daemon' | 'service'>
  /** Optional bearer token (`sb_...`) sent via Authorization header. */
  readonly token?: string
  /** Default profile sent via X-Board-Profile when `CallOptions.as` is omitted. */
  readonly defaultProfile?: string | null
  /** Optional x-board-can channel narrowing header. */
  readonly canHeader?: string
  /** Request timeout in ms for non-wait RPC calls (default 30_000). */
  readonly requestTimeoutMs?: number
  /** Server wait slice ceiling in seconds (default 25). */
  readonly maxWaitS?: number
  /** Retry policy overrides for transient 503 / socket resets. */
  readonly retryPolicy?: Partial<RetryPolicy>
  /** Pre-populated capabilities (optional; refreshed by ready()). */
  readonly initialCapabilities?: Capabilities
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_SLICE_WAIT_S = 25
const RETRYABLE_ERRNOS: ReadonlySet<string> = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAGAIN'])

class RemoteBoardError extends Error implements BoardErrorLike {
  readonly status: number
  readonly code: string
  readonly hint: string | undefined
  readonly details: unknown
  readonly origin: ErrorOrigin
  readonly retryAfter: number | undefined

  constructor(
    status: number,
    code: string,
    message: string,
    opts: { hint?: string; details?: unknown; retryAfter?: number } = {},
  ) {
    super(message)
    this.name = 'BoardError'
    this.status = status
    this.code = code
    this.hint = opts.hint
    this.details = opts.details
    this.origin = 'board'
    this.retryAfter = opts.retryAfter
  }
}

function isPipePath(socketPath: string): boolean {
  return socketPath.startsWith('\\\\.\\pipe\\')
}

function defaultCapabilities(socketPath: string, mode: 'daemon' | 'service'): Capabilities {
  return Object.freeze({
    protocol: PROTOCOL_VERSION,
    mode,
    transport: isPipePath(socketPath) ? 'pipe' : 'uds',
    coreVersion: CLIENT_VERSION,
    schemaVersion: 0,
    schemaBuild: 0,
    writable: true,
    boardId: null,
    instanceId: null,
    wake: 'sse',
    crossProcessWake: true,
    wakePollMs: null,
    maxWaitS: 300,
    leaseMinS: 10,
    leaseCapS: 3600,
    leaseDefaultS: 300,
    batchMax: 100,
    schedules: 'tick-lease',
    auth: Object.freeze(isPipePath(socketPath) ? (['bearer'] as const) : (['os-user', 'bearer'] as const)),
    assurances: Object.freeze(['human_verified', 'agent_delegated', 'local_unverified'] as const),
    conditionalNeeds: false,
    priorityNative: false,
    defer: false,
    resume: false,
    subtreeRead: true,
    ops: OP_NAMES,
  })
}

function encodeRpcBody(op: OpName, input: Record<string, unknown>): Record<string, unknown> {
  const spec = OPS[op]
  const byteKeys = new Set<string>([
    ...(spec.bytesFields ?? []),
    ...spec.params.filter((p) => p.kind === 'bytes').map((p) => p.name),
  ])
  if (byteKeys.size === 0) return input
  const copy: Record<string, unknown> = { ...input }
  for (const key of byteKeys) {
    const val = copy[key]
    if (val instanceof Uint8Array) {
      copy[key] = { $bytes: Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('base64') }
    }
  }
  return copy
}

function decodeRpcResult(op: OpName, raw: unknown): unknown {
  if (op === 'attachment' && raw !== null && typeof raw === 'object') {
    const rec = raw as { meta?: unknown; data?: unknown }
    if (rec.data !== null && typeof rec.data === 'object' && typeof (rec.data as { $bytes?: unknown }).$bytes === 'string') {
      return {
        meta: rec.meta,
        data: Buffer.from((rec.data as { $bytes: string }).$bytes, 'base64'),
      }
    }
  }
  return raw
}

function parseErrorResponse(status: number, bodyText: string, headers: IncomingMessage['headers']): BoardErrorLike {
  const retryRaw = headers['retry-after']
  const retryNum = typeof retryRaw === 'string' ? Number(retryRaw) : undefined
  const retryAfter = retryNum !== undefined && Number.isFinite(retryNum) && retryNum >= 0 ? retryNum : undefined
  let parsed: unknown = null
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    // non-JSON error body
  }
  if (parsed !== null && typeof parsed === 'object') {
    const errObj = (parsed as { error?: unknown }).error
    if (errObj !== null && typeof errObj === 'object') {
      const e = errObj as { code?: unknown; message?: unknown; hint?: unknown; details?: unknown }
      const code = typeof e.code === 'string' && e.code !== '' ? e.code : status >= 500 ? 'unavailable' : 'invalid_request'
      const message = typeof e.message === 'string' && e.message !== '' ? e.message : `HTTP ${status}`
      return new RemoteBoardError(status, code, message, {
        ...(typeof e.hint === 'string' ? { hint: e.hint } : {}),
        ...(e.details !== undefined ? { details: e.details } : {}),
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      })
    }
  }
  const fallbackCode = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status >= 500 ? 'unavailable' : 'invalid_request'
  return new RemoteBoardError(status, fallbackCode, bodyText.trim() || `HTTP ${status}`, {
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  })
}

function isTransientTransportError(err: unknown, mayRetryBodySent: boolean): boolean {
  if (isBoardError(err)) {
    if (err.status === 503 && typeof err.retryAfter === 'number' && Number.isFinite(err.retryAfter)) {
      return mayRetryBodySent
    }
    return false
  }
  if (err !== null && typeof err === 'object') {
    const errno = (err as { code?: unknown }).code
    if (typeof errno === 'string' && RETRYABLE_ERRNOS.has(errno)) {
      return mayRetryBodySent
    }
  }
  return false
}

function linkTwoSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): { readonly signal: AbortSignal; dispose(): void } {
  if (a === undefined) return { signal: b, dispose: () => {} }
  const ctrl = new AbortController()
  if (a.aborted) {
    ctrl.abort(a.reason)
    return { signal: ctrl.signal, dispose: () => {} }
  }
  if (b.aborted) {
    ctrl.abort(b.reason)
    return { signal: ctrl.signal, dispose: () => {} }
  }
  const onA = (): void => ctrl.abort(a.reason)
  const onB = (): void => ctrl.abort(b.reason)
  a.addEventListener('abort', onA, { once: true })
  b.addEventListener('abort', onB, { once: true })
  let disposed = false
  return {
    signal: ctrl.signal,
    dispose() {
      if (disposed) return
      disposed = true
      a.removeEventListener('abort', onA)
      b.removeEventListener('abort', onB)
    },
  }
}

interface SseFrame {
  readonly id?: string
  readonly event?: string
  readonly data?: string
}

function parseSseFrame(raw: string): SseFrame | null {
  let id: string | undefined
  let event: string | undefined
  const dataLines: string[] = []
  let hasField = false

  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue
    hasField = true
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    let value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }

  if (!hasField) return null
  return {
    ...(id !== undefined ? { id } : {}),
    ...(event !== undefined ? { event } : {}),
    ...(dataLines.length > 0 ? { data: dataLines.join('\n') } : {}),
  }
}

export class SocketTransport implements BoardTransport {
  readonly socketPath: string
  readonly #mode: 'daemon' | 'service'
  readonly #token: string | undefined
  readonly #defaultProfile: string | null
  readonly #canHeader: string | undefined
  readonly #requestTimeoutMs: number
  readonly #sliceWaitS: number
  readonly #retryPolicy: Partial<RetryPolicy> | undefined
  readonly #agent: Agent
  readonly #closeCtrl = new AbortController()
  #closed = false
  #caps: Capabilities

  constructor(options: SocketTransportOptions) {
    if (typeof options.socketPath !== 'string' || options.socketPath.trim() === '') {
      throw new TypeError('SocketTransport requires a non-empty socketPath')
    }
    this.socketPath = options.socketPath
    this.#mode = options.mode ?? 'daemon'
    this.#token = options.token
    this.#defaultProfile = options.defaultProfile ?? null
    this.#canHeader = options.canHeader
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#sliceWaitS = Math.max(1, Math.min(options.maxWaitS ?? DEFAULT_SLICE_WAIT_S, 300))
    this.#retryPolicy = options.retryPolicy
    this.#agent = new Agent({ keepAlive: true, maxSockets: 32 })
    this.#caps = options.initialCapabilities ?? defaultCapabilities(this.socketPath, this.#mode)
  }

  get capabilities(): Capabilities {
    return this.#caps
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Fetches `GET /api/board` over UDS/pipe to hydrate frozen Capabilities. */
  async ready(): Promise<Capabilities> {
    if (this.#closed) {
      throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
    }
    const { status, body, headers } = await this.#rawRequest({
      method: 'GET',
      path: '/api/board',
      headers: this.#baseHeaders(),
      timeoutMs: this.#requestTimeoutMs,
      signal: this.#closeCtrl.signal,
    })
    if (status < 200 || status >= 300) {
      throw parseErrorResponse(status, body, headers)
    }
    const doc = JSON.parse(body) as { swarmboard?: Partial<Capabilities> }
    const serverCaps = doc.swarmboard
    const instanceId =
      typeof headers['x-swarmboard-instance'] === 'string'
        ? headers['x-swarmboard-instance']
        : (serverCaps?.instanceId ?? this.#caps.instanceId)
    const boardId =
      typeof headers['x-swarmboard-board-id'] === 'string'
        ? headers['x-swarmboard-board-id']
        : (serverCaps?.boardId ?? this.#caps.boardId)
    this.#caps = Object.freeze({
      ...this.#caps,
      ...(serverCaps ?? {}),
      mode: this.#mode,
      transport: isPipePath(this.socketPath) ? 'pipe' : 'uds',
      boardId,
      instanceId,
      ops: Object.freeze([...(serverCaps?.ops ?? OP_NAMES)]),
    })
    return this.#caps
  }

  call<O extends OpName>(op: O, input: OpInput<O>, opts?: CallOptions): Promise<OpOutput<O>> {
    return this.#call(op, input, opts) as Promise<OpOutput<O>>
  }

  async #call(op: string, input: unknown, opts: CallOptions | undefined): Promise<unknown> {
    if (this.#closed) {
      throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
    }
    if (typeof op !== 'string' || !isOpName(op)) {
      throw clientError('not_supported', `no operation named ${String(op)}`, {
        hint: 'the capabilities list the operations this board serves',
      })
    }
    const kind = laneKind(op)
    if (opts?.signal?.aborted === true && kind !== 'wait') {
      throw opts.signal.reason
    }

    validateEnvelope(op, input)
    const obj = ((input ?? {}) as Record<string, unknown>)

    // Auto-mint idempotency key for client-id writes so transient retries are duplicate-safe.
    let idemKey = opts?.idempotencyKey
    if (idemKey === undefined && keyUse(op, obj) === 'id' && obj['id'] === undefined) {
      idemKey = mintKey()
    }

    const spec = OPS[op]
    const mayRetry =
      spec.access === 'read' ||
      spec.idem === 'natural' ||
      spec.idem === 'fenced' ||
      (spec.idem === 'client-id' && (idemKey !== undefined || obj['id'] !== undefined))

    const linked = linkTwoSignals(opts?.signal, this.#closeCtrl.signal)
    try {
      // Wait slicing: keep individual HTTP requests <= sliceWaitS while honoring caller's total wait.
      if (spec.wait !== 'none' && Number(obj['wait'] ?? 0) > 0) {
        return await this.#callSlicedWait(op, obj, opts, idemKey, mayRetry, linked.signal)
      }
      return await this.#rpcOnceWithRetry(op, obj, opts, idemKey, mayRetry, linked.signal, this.#requestTimeoutMs)
    } catch (err) {
      if (kind === 'wait' && linked.signal.aborted) {
        return this.#emptyWaitAnswer(op, obj)
      }
      if (opts?.signal?.aborted === true && kind !== 'wait') {
        throw opts.signal.reason
      }
      throw err
    } finally {
      linked.dispose()
    }
  }

  async #callSlicedWait(
    op: OpName,
    obj: Record<string, unknown>,
    opts: CallOptions | undefined,
    idemKey: string | undefined,
    mayRetry: boolean,
    signal: AbortSignal,
  ): Promise<unknown> {
    const totalWaitS = Number(obj['wait'] ?? 0)
    const deadline = Date.now() + totalWaitS * 1000
    let cursor = typeof obj['after'] === 'string' ? obj['after'] : undefined

    for (;;) {
      if (signal.aborted) return this.#emptyWaitAnswer(op, obj, cursor)
      const remainingMs = deadline - Date.now()
      const sliceS = Math.max(0, Math.min(this.#sliceWaitS, remainingMs / 1000))
      const sliceInput: Record<string, unknown> = {
        ...obj,
        wait: sliceS,
        ...(cursor !== undefined && (op === 'events' || op === 'waitNotifications') ? { after: cursor } : {}),
      }
      const timeoutMs = Math.max(this.#requestTimeoutMs, Math.ceil(sliceS * 1000) + 10_000)
      const result = await this.#rpcOnceWithRetry(op, sliceInput, opts, idemKey, mayRetry, signal, timeoutMs)

      if (op === 'events') {
        const page = result as EventsPage
        cursor = page.cursor
        if (page.events.length > 0 || Date.now() >= deadline || signal.aborted) return page
      } else if (op === 'waitNotifications') {
        const page = result as { notifications: unknown[]; cursor: string }
        cursor = page.cursor
        if (page.notifications.length > 0 || Date.now() >= deadline || signal.aborted) return page
      } else if (op === 'claimReadyTask') {
        const claimed = result as { task: unknown }
        if (claimed.task !== null || Date.now() >= deadline || signal.aborted) return claimed
      } else if (op === 'matches') {
        if ((Array.isArray(result) && result.length > 0) || Date.now() >= deadline || signal.aborted) return result
      } else {
        return result
      }
    }
  }

  #emptyWaitAnswer(op: OpName, obj: Record<string, unknown>, cursor?: string): unknown {
    const c = cursor ?? (typeof obj['after'] === 'string' ? obj['after'] : '0')
    if (op === 'events') return { events: [], cursor: c }
    if (op === 'waitNotifications') return { notifications: [], cursor: c, unread: 0, urgent: 0 }
    if (op === 'claimReadyTask') return { task: null }
    if (op === 'matches') return []
    return {}
  }

  async #rpcOnceWithRetry(
    op: OpName,
    obj: Record<string, unknown>,
    opts: CallOptions | undefined,
    idemKey: string | undefined,
    mayRetry: boolean,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    const encoded = encodeRpcBody(op, obj)
    const bodyText = JSON.stringify(encoded)
    const headers = this.#callHeaders(opts, idemKey)

    return withRetry(
      async () => {
        const { status, body, headers: resHeaders } = await this.#rawRequest({
          method: 'POST',
          path: `/api/v2/rpc/${encodeURIComponent(op)}`,
          headers,
          body: bodyText,
          timeoutMs,
          signal,
        })
        this.#observeInstanceHeaders(resHeaders)
        if (status < 200 || status >= 300) {
          throw parseErrorResponse(status, body, resHeaders)
        }
        const parsed: unknown = body === '' ? {} : JSON.parse(body)
        return decodeRpcResult(op, parsed)
      },
      {
        isRetryable: (err) => isTransientTransportError(err, mayRetry),
        policy: { baseMs: 20, capMs: 500, budgetMs: 15_000, maxAttempts: 6, ...this.#retryPolicy },
        signal,
      },
    )
  }

  /**
   * Streams live events over SSE `/api/v2/stream` on the UDS/pipe connection, transparently
   * reconnecting with `Last-Event-ID` on `event: reconnect` and falling back to 25 s long-poll
   * if SSE is unsupported.
   */
  events(query: EventsFeedQuery, opts?: CallOptions): AsyncIterable<EventsPage> {
    const self = this
    async function* streamLoop(): AsyncGenerator<EventsPage, void, undefined> {
      const linked = linkTwoSignals(opts?.signal, self.#closeCtrl.signal)
      try {
        if (linked.signal.aborted || self.#closed) return

        const rest: Record<string, unknown> = { ...(query ?? {}) }
        delete rest['wait']
        let after = typeof rest['after'] === 'string' ? rest['after'] : undefined

        if (rest['last'] !== undefined) {
          const first = (await self.#call('events', { ...rest }, { ...opts, signal: linked.signal })) as EventsPage
          yield first
          after = first.cursor
          delete rest['last']
        }

        // Try SSE stream first; fall back to long-poll if server doesn't expose /api/v2/stream.
        let useLongPoll = false

        while (!linked.signal.aborted && !self.#closed) {
          if (useLongPoll) {
            const page = (await self.#call(
              'events',
              { ...rest, ...(after !== undefined ? { after } : {}), wait: self.#sliceWaitS },
              { ...opts, signal: linked.signal },
            )) as EventsPage
            if (linked.signal.aborted || self.#closed) return
            if (page.events.length > 0 || page.cursor !== after) {
              yield page
            }
            after = page.cursor
            continue
          }

          const outcome = yield* self.#readSseOnce(rest, after, opts, linked.signal)
          if (outcome.cursor !== undefined) after = outcome.cursor
          if (outcome.action === 'done') return
          if (outcome.action === 'fallback') {
            useLongPoll = true
            continue
          }
          // action === 'reconnect': loop and reconnect with updated Last-Event-ID
        }
      } finally {
        linked.dispose()
      }
    }
    return streamLoop()
  }

  async *#readSseOnce(
    filters: Record<string, unknown>,
    after: string | undefined,
    opts: CallOptions | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<EventsPage, { readonly action: 'done' | 'reconnect' | 'fallback'; readonly cursor?: string }, undefined> {
    const params = new URLSearchParams()
    if (after !== undefined) params.set('after', after)
    if (typeof filters['channel'] === 'string') params.set('channel', filters['channel'])
    if (typeof filters['re'] === 'string' || typeof filters['re'] === 'number') params.set('re', String(filters['re']))
    if (typeof filters['by'] === 'string') params.set('by', filters['by'])
    if (typeof filters['mentions'] === 'string') params.set('mentions', filters['mentions'])
    if (filters['all'] === true) params.set('all', 'true')

    const qs = params.toString()
    const path = `/api/v2/stream${qs !== '' ? `?${qs}` : ''}`
    const headers: OutgoingHttpHeaders = {
      ...this.#callHeaders(opts, undefined),
      accept: 'text/event-stream',
      ...(after !== undefined ? { 'last-event-id': after } : {}),
    }
    delete headers['content-type']

    const res = await this.#openRawStream(path, headers, signal)
    if (res === null) {
      return { action: 'done', ...(after !== undefined ? { cursor: after } : {}) }
    }
    this.#observeInstanceHeaders(res.headers)
    const status = res.statusCode ?? 500
    if (status === 404 || status === 405 || status === 501) {
      res.resume()
      return { action: 'fallback', ...(after !== undefined ? { cursor: after } : {}) }
    }
    if (status < 200 || status >= 300) {
      const errBody = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', () => resolve(''))
      })
      throw parseErrorResponse(status, errBody, res.headers)
    }

    let cursor = after
    let buffer = ''
    let wantReconnect = false
    const decoder = new TextDecoder()

    const onAbort = (): void => {
      res.destroy()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      for await (const chunk of res) {
        if (signal.aborted || this.#closed) return { action: 'done', ...(cursor !== undefined ? { cursor } : {}) }
        buffer += decoder.decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), { stream: true })
        const parts = buffer.split(/\r?\n\r?\n/)
        buffer = parts.pop() ?? ''
        for (const rawFrame of parts) {
          if (rawFrame.trim() === '') continue
          const frame = parseSseFrame(rawFrame)
          if (frame === null) continue
          if (frame.id !== undefined) cursor = frame.id
          if (frame.event === 'reconnect') {
            wantReconnect = true
            res.destroy()
            break
          }
          if (frame.event === 'shutdown') {
            res.destroy()
            return { action: 'done', ...(cursor !== undefined ? { cursor } : {}) }
          }
          if (frame.event === 'notification') continue
          if (frame.data !== undefined) {
            try {
              const ev = JSON.parse(frame.data) as BoardEventView
              const evCursor = frame.id ?? ev.cursor
              cursor = evCursor
              yield { events: [ev], cursor: evCursor }
            } catch {
              // ignore unparseable frame data
            }
          }
        }
        if (wantReconnect) break
      }
    } catch (err) {
      if (signal.aborted || this.#closed) return { action: 'done', ...(cursor !== undefined ? { cursor } : {}) }
      if (!wantReconnect) throw err
    } finally {
      signal.removeEventListener('abort', onAbort)
    }

    if (signal.aborted || this.#closed) return { action: 'done', ...(cursor !== undefined ? { cursor } : {}) }
    return { action: 'reconnect', ...(cursor !== undefined ? { cursor } : {}) }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#closeCtrl.abort(clientError('unavailable', 'this transport is closed'))
    this.#agent.destroy()
  }

  #baseHeaders(): OutgoingHttpHeaders {
    const h: OutgoingHttpHeaders = {
      host: 'localhost',
      'user-agent': `swarmboard/${CLIENT_VERSION}`,
    }
    if (this.#token !== undefined) h['authorization'] = `Bearer ${this.#token}`
    if (this.#canHeader !== undefined) h['x-board-can'] = this.#canHeader
    return h
  }

  #callHeaders(opts: CallOptions | undefined, idemKey: string | undefined): OutgoingHttpHeaders {
    const h: OutgoingHttpHeaders = {
      ...this.#baseHeaders(),
      'content-type': 'application/json',
    }
    const effectiveAs = opts?.as !== undefined ? opts.as : this.#defaultProfile
    if (typeof effectiveAs === 'string' && effectiveAs !== '') {
      h['x-board-profile'] = effectiveAs
    } else if (opts?.as === null && this.#token !== undefined && this.#defaultProfile !== null) {
      h['x-board-profile'] = ''
    }
    if (idemKey !== undefined) h['idempotency-key'] = idemKey
    if (opts?.expectInstance !== undefined) h['x-swarmboard-expect-instance'] = opts.expectInstance
    return h
  }

  #observeInstanceHeaders(headers: IncomingMessage['headers']): void {
    const inst = typeof headers['x-swarmboard-instance'] === 'string' ? headers['x-swarmboard-instance'] : null
    const bid = typeof headers['x-swarmboard-board-id'] === 'string' ? headers['x-swarmboard-board-id'] : null
    if ((inst !== null && inst !== this.#caps.instanceId) || (bid !== null && bid !== this.#caps.boardId)) {
      this.#caps = Object.freeze({
        ...this.#caps,
        ...(inst !== null ? { instanceId: inst } : {}),
        ...(bid !== null ? { boardId: bid } : {}),
      })
    }
  }

  #openRawStream(
    path: string,
    headers: OutgoingHttpHeaders,
    signal: AbortSignal,
  ): Promise<IncomingMessage | null> {
    if (signal.aborted || this.#closed) return Promise.resolve(null)
    return new Promise<IncomingMessage | null>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method: 'GET',
          path,
          headers,
          // Dedicated unpooled connection for long-lived SSE stream so keep-alive RPC pool stays free.
          agent: false,
        },
        (res) => {
          signal.removeEventListener('abort', onAbort)
          resolve(res)
        },
      )
      const onAbort = (): void => {
        req.destroy()
        resolve(null)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      req.on('error', (err) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted || this.#closed) {
          resolve(null)
          return
        }
        reject(
          clientError('daemon_unavailable', `daemon socket error: ${err.message}`, {
            cause: err,
          }),
        )
      })
      req.end()
    })
  }

  #rawRequest(params: {
    readonly method: string
    readonly path: string
    readonly headers: OutgoingHttpHeaders
    readonly body?: string
    readonly timeoutMs: number
    readonly signal: AbortSignal
  }): Promise<{ readonly status: number; readonly body: string; readonly headers: IncomingMessage['headers'] }> {
    return new Promise((resolve, reject) => {
      if (params.signal.aborted) {
        reject(params.signal.reason ?? clientError('unavailable', 'request aborted'))
        return
      }
      const hdrs: OutgoingHttpHeaders = { ...params.headers }
      const buf = params.body !== undefined ? Buffer.from(params.body, 'utf8') : undefined
      if (buf !== undefined) hdrs['content-length'] = String(buf.byteLength)

      let settled = false
      const finish = (err: unknown, result?: { status: number; body: string; headers: IncomingMessage['headers'] }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        params.signal.removeEventListener('abort', onAbort)
        if (err !== null) reject(err)
        else resolve(result!)
      }

      const req = httpRequest(
        {
          socketPath: this.socketPath,
          agent: this.#agent,
          method: params.method,
          path: params.path,
          headers: hdrs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            finish(null, {
              status: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            })
          })
          res.on('error', (err) => finish(err))
        },
      )

      const onAbort = (): void => {
        req.destroy()
        finish(params.signal.reason ?? clientError('unavailable', 'request aborted'))
      }
      params.signal.addEventListener('abort', onAbort, { once: true })

      const timer = setTimeout(() => {
        req.destroy()
        finish(clientError('daemon_unavailable', `daemon request timed out after ${params.timeoutMs}ms`))
      }, params.timeoutMs)
      timer.unref()

      req.on('error', (err) => {
        const errno = (err as NodeJS.ErrnoException).code
        if (errno !== undefined && RETRYABLE_ERRNOS.has(errno)) {
          finish(err)
          return
        }
        finish(
          clientError('daemon_unavailable', `cannot reach daemon at ${this.socketPath}: ${err.message}`, {
            cause: err,
            details: { errno },
          }),
        )
      })

      if (buf !== undefined) req.write(buf)
      req.end()
    })
  }
}
