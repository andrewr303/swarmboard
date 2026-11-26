// Thin HTTP/HTTPS transport for Swarmboard Modes 3-4 (HOST-9, Swarmboard v2 launch design §4.3).
// HS-55 thin-client boundary: ZERO runtime imports from src/core/ and ZERO runtime imports from zod.
// Speaks `POST /api/v2/rpc/:op` (with automatic `/api/board/*` compat fallback for pure Vercel boards),
// slices long waits to <= 25 s, propagates `X-Swarmboard-Expect-Instance`, auto-mints idempotency keys
// on `client-id` ops, retries transient 503s via `withRetry`, and streams `events()` via SSE `/api/v2/stream`.
import type { BoardEventView, EventsPage } from '../core/public.ts'
import { clientError, isBoardError, type BoardErrorLike, type ErrorOrigin } from './errors.ts'
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

export interface HttpTransportOptions {
  /** Base board URL (e.g. `http://127.0.0.1:4180`, `https://board.example.com`, or `.../api/board`). */
  readonly url: string
  /** Transport mode label ('service' | 'remote', default derived from URL scheme/host). */
  readonly mode?: Extract<Mode, 'daemon' | 'service' | 'remote'>
  /** Optional bearer token (`sb_...` or OIDC JWT). */
  readonly token?: string
  /** Default profile sent via X-Board-Profile when `CallOptions.as` is omitted. */
  readonly defaultProfile?: string | null
  /** Optional x-board-can channel narrowing header. */
  readonly canHeader?: string
  /** Extra static headers (e.g. Cookie for test harnesses). */
  readonly headers?: Readonly<Record<string, string>>
  /** Injectable fetch implementation (defaults to globalThis.fetch). */
  readonly fetch?: typeof globalThis.fetch
  /** Server wait slice ceiling in seconds (default 25). */
  readonly maxWaitS?: number
  /** Retry policy overrides. */
  readonly retryPolicy?: Partial<RetryPolicy>
  /** Pre-populated capabilities (optional; refreshed by ready()). */
  readonly initialCapabilities?: Capabilities
}

const DEFAULT_SLICE_WAIT_S = 25

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

function normalizeEndpoints(rawUrl: string): {
  readonly originBase: string
  readonly boardBase: string
  readonly isHttps: boolean
  readonly isLoopback: boolean
} {
  const u = new URL(rawUrl)
  const cleanPath = u.pathname.replace(/\/+$/, '')
  let originBase: string
  let boardBase: string
  if (cleanPath.endsWith('/api/board')) {
    originBase = `${u.origin}${cleanPath.slice(0, -'/api/board'.length)}`
    boardBase = `${u.origin}${cleanPath}`
  } else {
    originBase = `${u.origin}${cleanPath}`
    boardBase = `${originBase}/api/board`
  }
  const h = u.hostname.toLowerCase()
  const isLoopback = h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
  return { originBase, boardBase, isHttps: u.protocol === 'https:', isLoopback }
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

function parseFetchError(status: number, bodyText: string, headers: Headers): BoardErrorLike {
  const retryRaw = headers.get('retry-after')
  const retryNum = retryRaw !== null ? Number(retryRaw) : undefined
  const retryAfter = retryNum !== undefined && Number.isFinite(retryNum) && retryNum >= 0 ? retryNum : undefined
  let parsed: unknown = null
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    // non-JSON
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

export class HttpTransport implements BoardTransport {
  readonly url: string
  readonly #originBase: string
  readonly #boardBase: string
  readonly #mode: 'daemon' | 'service' | 'remote'
  readonly #transportKind: 'tcp' | 'https'
  readonly #token: string | undefined
  readonly #defaultProfile: string | null
  readonly #canHeader: string | undefined
  readonly #extraHeaders: Readonly<Record<string, string>>
  readonly #fetchImpl: typeof globalThis.fetch
  readonly #sliceWaitS: number
  readonly #retryPolicy: Partial<RetryPolicy> | undefined
  readonly #closeCtrl = new AbortController()
  #closed = false
  #rpcSupported = true
  #caps: Capabilities

  constructor(options: HttpTransportOptions) {
    if (typeof options.url !== 'string' || options.url.trim() === '') {
      throw new TypeError('HttpTransport requires a non-empty url')
    }
    const endpoints = normalizeEndpoints(options.url)
    this.url = endpoints.originBase
    this.#originBase = endpoints.originBase
    this.#boardBase = endpoints.boardBase
    this.#mode = options.mode ?? (endpoints.isLoopback && !endpoints.isHttps ? 'service' : 'remote')
    this.#transportKind = endpoints.isHttps ? 'https' : 'tcp'
    this.#token = options.token
    this.#defaultProfile = options.defaultProfile ?? null
    this.#canHeader = options.canHeader
    this.#extraHeaders = Object.freeze({ ...(options.headers ?? {}) })
    this.#fetchImpl = options.fetch ?? globalThis.fetch
    this.#sliceWaitS = Math.max(1, Math.min(options.maxWaitS ?? DEFAULT_SLICE_WAIT_S, 300))
    this.#retryPolicy = options.retryPolicy

    this.#caps =
      options.initialCapabilities ??
      Object.freeze({
        protocol: PROTOCOL_VERSION,
        mode: this.#mode,
        transport: this.#transportKind,
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
        schedules: 'owner',
        auth: Object.freeze(this.#transportKind === 'https' ? (['bearer', 'oidc'] as const) : (['os-user', 'bearer'] as const)),
        assurances: Object.freeze(['human_verified', 'agent_delegated', 'local_unverified'] as const),
        conditionalNeeds: false,
        priorityNative: false,
        defer: false,
        resume: false,
        subtreeRead: true,
        ops: OP_NAMES,
      })
  }

  get capabilities(): Capabilities {
    return this.#caps
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Fetches discovery doc from `GET /api/board` to hydrate frozen Capabilities. */
  async ready(): Promise<Capabilities> {
    if (this.#closed) {
      throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
    }
    let res: Response
    try {
      res = await this.#fetchImpl(this.#boardBase, {
        method: 'GET',
        headers: this.#baseHeaders(),
        signal: this.#closeCtrl.signal,
      })
    } catch (err) {
      throw clientError('unavailable', `cannot reach board at ${this.#boardBase}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
    const text = await res.text()
    if (!res.ok) {
      throw parseFetchError(res.status, text, res.headers)
    }
    const doc = (text === '' ? {} : JSON.parse(text)) as {
      swarmboard?: Partial<Capabilities>
      endpoints?: { rpc?: string }
    }
    const serverCaps = doc.swarmboard
    if (serverCaps === undefined && doc.endpoints?.rpc === undefined) {
      // Pure Vercel-compatible host without Swarmboard v2 RPC block
      this.#rpcSupported = false
    }
    const instanceId = res.headers.get('x-swarmboard-instance') ?? serverCaps?.instanceId ?? this.#caps.instanceId
    const boardId = res.headers.get('x-swarmboard-board-id') ?? serverCaps?.boardId ?? this.#caps.boardId
    this.#caps = Object.freeze({
      ...this.#caps,
      ...(serverCaps ?? {}),
      mode: this.#mode,
      transport: this.#transportKind,
      boardId,
      instanceId,
      ops: Object.freeze([...(serverCaps?.ops ?? (this.#rpcSupported ? OP_NAMES : OP_NAMES.filter((o) => OPS[o].compat !== null)))]),
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
    const obj = (input ?? {}) as Record<string, unknown>

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
      if (spec.wait !== 'none' && Number(obj['wait'] ?? 0) > 0) {
        return await this.#callSlicedWait(op, obj, opts, idemKey, mayRetry, linked.signal)
      }
      return await this.#dispatchOnceWithRetry(op, obj, opts, idemKey, mayRetry, linked.signal)
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
      const result = await this.#dispatchOnceWithRetry(op, sliceInput, opts, idemKey, mayRetry, signal)

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

  async #dispatchOnceWithRetry(
    op: OpName,
    obj: Record<string, unknown>,
    opts: CallOptions | undefined,
    idemKey: string | undefined,
    mayRetry: boolean,
    signal: AbortSignal,
  ): Promise<unknown> {
    return withRetry(
      async () => {
        if (this.#rpcSupported) {
          const rpcRes = await this.#tryRpc(op, obj, opts, idemKey, signal)
          if (rpcRes.kind === 'ok') return rpcRes.value
          if (rpcRes.kind === 'fallback' && OPS[op].compat !== null) {
            this.#rpcSupported = false
            return await this.#callCompat(op, obj, opts, idemKey, signal)
          }
          throw rpcRes.error
        }
        if (OPS[op].compat === null) {
          throw clientError('not_supported', `${op} requires a Swarmboard v2 server (/api/v2/rpc/${op})`)
        }
        return await this.#callCompat(op, obj, opts, idemKey, signal)
      },
      {
        isRetryable: (err) => {
          if (!mayRetry) return false
          if (isBoardError(err)) {
            return err.status === 503 && typeof err.retryAfter === 'number' && Number.isFinite(err.retryAfter)
          }
          return false
        },
        policy: { baseMs: 25, capMs: 1000, budgetMs: 15_000, maxAttempts: 5, ...this.#retryPolicy },
        signal,
      },
    )
  }

  async #tryRpc(
    op: OpName,
    obj: Record<string, unknown>,
    opts: CallOptions | undefined,
    idemKey: string | undefined,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'ok'; readonly value: unknown }
    | { readonly kind: 'fallback'; readonly error: BoardErrorLike }
    | { readonly kind: 'error'; readonly error: BoardErrorLike }
  > {
    const encoded = encodeRpcBody(op, obj)
    let res: Response
    try {
      res = await this.#fetchImpl(`${this.#originBase}/api/v2/rpc/${encodeURIComponent(op)}`, {
        method: 'POST',
        headers: this.#callHeaders(opts, idemKey),
        body: JSON.stringify(encoded),
        signal,
      })
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? err
      throw clientError('unavailable', `network error calling ${op}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
        retryAfter: 1,
      })
    }
    this.#observeInstanceHeaders(res.headers)
    const text = await res.text()
    if (res.ok) {
      const parsed: unknown = text === '' ? {} : JSON.parse(text)
      return { kind: 'ok', value: decodeRpcResult(op, parsed) }
    }
    const err = parseFetchError(res.status, text, res.headers)
    if (res.status === 404 && (err.code === 'not_found' || !text.includes('error')) && OPS[op].compat !== null) {
      return { kind: 'fallback', error: err }
    }
    return { kind: 'error', error: err }
  }

  async #callCompat(
    op: OpName,
    obj: Record<string, unknown>,
    opts: CallOptions | undefined,
    idemKey: string | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const spec = OPS[op]
    const compat = spec.compat!
    const usedParams = new Set<string>()
    const path = compat.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
      usedParams.add(name)
      return encodeURIComponent(String(obj[name] ?? ''))
    })
    const remaining: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (!usedParams.has(k) && v !== undefined) remaining[k] = v
    }

    const url = new URL(`${this.#boardBase}${path}`)
    const headers = this.#callHeaders(opts, idemKey)
    let body: BodyInit | undefined

    if (compat.method === 'GET') {
      delete headers['content-type']
      for (const [k, v] of Object.entries(remaining)) {
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item))
        } else {
          url.searchParams.set(k, String(v))
        }
      }
    } else if (op === 'upload' && remaining['data'] instanceof Uint8Array) {
      const bytes = remaining['data']
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      headers['content-type'] = 'application/octet-stream'
      if (typeof remaining['name'] === 'string') headers['x-attachment-name'] = remaining['name']
      if (typeof remaining['type'] === 'string') headers['x-attachment-type'] = remaining['type']
      body = copy
    } else if (op === 'uploadFinish' && remaining['data'] instanceof Uint8Array) {
      const bytes = remaining['data']
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      headers['content-type'] = 'application/octet-stream'
      body = copy
    } else {
      body = JSON.stringify(encodeRpcBody(op, remaining))
    }

    let res: Response
    try {
      res = await this.#fetchImpl(url.toString(), {
        method: compat.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal,
      })
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? err
      throw clientError('unavailable', `network error calling ${op}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
        retryAfter: 1,
      })
    }
    this.#observeInstanceHeaders(res.headers)
    if (!res.ok) {
      const text = await res.text()
      throw parseFetchError(res.status, text, res.headers)
    }

    if (op === 'attachment') {
      const ab = await res.arrayBuffer()
      const data = Buffer.from(ab)
      const meta = {
        id: res.headers.get('x-attachment-id') ?? String(obj['id'] ?? ''),
        name: res.headers.get('x-attachment-name') ?? null,
        type: res.headers.get('content-type') ?? 'application/octet-stream',
        size: data.byteLength,
      }
      return { meta, data }
    }

    const text = await res.text()
    return text === '' ? {} : JSON.parse(text)
  }

  /**
   * Streams live events via SSE `/api/v2/stream` when available, falling back cleanly to 25 s
   * long-polling (`call('events', ...)`) on pure compat servers.
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

        let useLongPoll = !self.#rpcSupported

        while (!linked.signal.aborted && !self.#closed) {
          if (useLongPoll) {
            const page = (await self.#call(
              'events',
              { ...rest, ...(after !== undefined ? { after } : {}), wait: self.#sliceWaitS },
              { ...opts, signal: linked.signal },
            )) as EventsPage
            if (linked.signal.aborted || self.#closed) return
            if (page.events.length > 0 || page.cursor !== after) yield page
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
    const url = new URL(`${this.#originBase}/api/v2/stream`)
    if (after !== undefined) url.searchParams.set('after', after)
    if (typeof filters['channel'] === 'string') url.searchParams.set('channel', filters['channel'])
    if (typeof filters['re'] === 'string' || typeof filters['re'] === 'number') url.searchParams.set('re', String(filters['re']))
    if (typeof filters['by'] === 'string') url.searchParams.set('by', filters['by'])
    if (typeof filters['mentions'] === 'string') url.searchParams.set('mentions', filters['mentions'])
    if (filters['all'] === true) url.searchParams.set('all', 'true')

    const headers = this.#callHeaders(opts, undefined)
    delete headers['content-type']
    headers['accept'] = 'text/event-stream'
    if (after !== undefined) headers['last-event-id'] = after

    let res: Response
    try {
      res = await this.#fetchImpl(url.toString(), { method: 'GET', headers, signal })
    } catch (err) {
      if (signal.aborted || this.#closed) return { action: 'done', ...(after !== undefined ? { cursor: after } : {}) }
      throw clientError('unavailable', `SSE connection failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }

    this.#observeInstanceHeaders(res.headers)
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return { action: 'fallback', ...(after !== undefined ? { cursor: after } : {}) }
    }
    if (!res.ok) {
      const text = await res.text()
      throw parseFetchError(res.status, text, res.headers)
    }
    if (res.body === null) {
      return { action: 'fallback', ...(after !== undefined ? { cursor: after } : {}) }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let cursor = after
    let wantReconnect = false

    const onAbort = (): void => {
      void reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      for (;;) {
        if (signal.aborted || this.#closed) return { action: 'done', ...(cursor !== undefined ? { cursor } : {}) }
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split(/\r?\n\r?\n/)
        buffer = parts.pop() ?? ''
        for (const rawFrame of parts) {
          if (rawFrame.trim() === '') continue
          const frame = parseSseFrame(rawFrame)
          if (frame === null) continue
          if (frame.id !== undefined) cursor = frame.id
          if (frame.event === 'reconnect') {
            wantReconnect = true
            await reader.cancel().catch(() => {})
            break
          }
          if (frame.event === 'shutdown') {
            await reader.cancel().catch(() => {})
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
              // ignore unparseable frame
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
      reader.releaseLock()
    }

    if (signal.aborted || this.#closed) return { action: 'done', ...(cursor !== undefined ? { cursor } : {}) }
    return { action: 'reconnect', ...(cursor !== undefined ? { cursor } : {}) }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#closeCtrl.abort(clientError('unavailable', 'this transport is closed'))
  }

  #baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      ...this.#extraHeaders,
    }
    if (this.#token !== undefined) h['authorization'] = `Bearer ${this.#token}`
    if (this.#canHeader !== undefined) h['x-board-can'] = this.#canHeader
    return h
  }

  #callHeaders(opts: CallOptions | undefined, idemKey: string | undefined): Record<string, string> {
    const h: Record<string, string> = {
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

  #observeInstanceHeaders(headers: Headers): void {
    const inst = headers.get('x-swarmboard-instance')
    const bid = headers.get('x-swarmboard-board-id')
    if ((inst !== null && inst !== this.#caps.instanceId) || (bid !== null && bid !== this.#caps.boardId)) {
      this.#caps = Object.freeze({
        ...this.#caps,
        ...(inst !== null ? { instanceId: inst } : {}),
        ...(bid !== null ? { boardId: bid } : {}),
      })
    }
  }
}
