// Fetch-native HTTP/SSE router for Swarmboard Modes 2-4 (HOST-9, Swarmboard v2 launch design §4.2).
//
// Mounts:
// - GET  /healthz                       -> health & queue/stream telemetry
// - GET  /api/board                     -> Vercel-compatible discovery + swarmboard Capabilities + fusion block
// - /api/board/*                        -> all 61 OPS with compat !== null, auto-routed from OPS
// - POST /api/v2/rpc/:op                -> universal typed RPC for ALL 84 OPS entries
// - /api/v2/*                           -> ergonomic v2 REST aliases (§1.6) + GET /api/v2/stream (SSE) + POST /api/v2/feedback
// - /_swarm/v1/*                         -> local-only control namespace (403 on tailscale/https)
// - GET  /, GET /assets/*               -> optional uiHandler (Command Center UI) or minimal fallback
//
// Strictly follows F-1 (HS-01: zero host imports/mentions, only ../core/public.ts) and HS-03
// (uses normalizeThrown / clientErrorPayload from ../client/normalize.ts, never core normalizers).
import {
  BoardError,
  badRequest,
  expandPermissions,
  forbidden,
  notFound,
  tooLarge,
  type CallerContext,
} from '../core/public.ts'
import { clientError, isBoardError } from '../client/errors.ts'
import { applyIdempotencyKey, bodyDigest } from '../client/idempotency.ts'
import { guardFor, linkSignals } from '../client/dispatch.ts'
import { clientErrorPayload, normalizeThrown } from '../client/normalize.ts'
import {
  bindArgs,
  isOpName,
  laneKind,
  OP_NAMES,
  OPS,
  validateEnvelope,
  type OpName,
  type OpSpec,
} from '../client/ops.ts'
import { baseCapabilities } from '../client/transport-inproc.ts'
import type { Capabilities } from '../client/types.ts'
import { CLIENT_VERSION, PROTOCOL_VERSION } from '../client/version.ts'
import { RealtimeHub } from './realtime-hub.ts'
import type {
  DaemonHelloPayload,
  ServerAuthResult,
  ServerHandler,
  ServerHandlerOptions,
  ServerIssueTokenRequest,
  ServerListenerClass,
  ServerListenerContext,
} from './types.ts'
import { WriteQueue } from './write-queue.ts'

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024
export const DEFAULT_HTTP_MAX_WAIT_S = 25

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])
const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none'])
const ATTACHMENT_UPLOAD_PATH_RE = /^\/api\/(?:board|v2)\/attachments(?:\/|$)|^\/attachments(?:\/|$)/
const CONTROL_PATH_RE = /^\/_swarm\/v1(?:\/|$)/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const REPOLL_MS = 250

const FALLBACK_UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Swarmboard</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e6e8ef; margin: 0; padding: 2rem; }
    main { max-width: 640px; margin: 4rem auto; background: #171a23; border: 1px solid #2a2f3d; border-radius: 12px; padding: 1.5rem 2rem; }
    h1 { margin-top: 0; font-size: 1.4rem; }
    code { background: #232836; padding: 0.15rem 0.4rem; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>Swarmboard Local Server</h1>
    <p>API is online at <code>/api/board</code>, <code>/api/v2/rpc/:op</code>, and <code>/api/v2/stream</code>.</p>
    <p>Health status: <a href="/healthz" style="color:#7aa2f7">/healthz</a></p>
  </main>
</body>
</html>
`

// ---------------------------------------------------------------------------------------------------------------
// Loopback guard helper (for routes like /healthz, /api/board, /, /_swarm/v1/hello, /_swarm/v1/login that may run
// before or without full token/session authentication, while still enforcing all 4 DNS-rebinding & CSRF guards).

function parseHostHeader(raw: string): { readonly host: string; readonly port: number | null } | null {
  const trimmed = raw.trim()
  if (trimmed === '' || CONTROL_CHARS.test(trimmed) || /\s/.test(trimmed) || trimmed.includes('@') || trimmed.includes('/')) {
    return null
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) return null
    const host = trimmed.slice(0, end + 1).toLowerCase()
    const rest = trimmed.slice(end + 1)
    if (rest === '') return { host, port: null }
    if (!rest.startsWith(':')) return null
    const portStr = rest.slice(1)
    if (!/^\d{1,5}$/.test(portStr)) return null
    const port = Number(portStr)
    if (port < 1 || port > 65535) return null
    return { host, port }
  }
  const colon = trimmed.indexOf(':')
  if (colon === -1) return { host: trimmed.toLowerCase(), port: null }
  if (trimmed.indexOf(':', colon + 1) !== -1) return null
  const host = trimmed.slice(0, colon).toLowerCase()
  const portStr = trimmed.slice(colon + 1)
  if (host === '' || !/^\d{1,5}$/.test(portStr)) return null
  const port = Number(portStr)
  if (port < 1 || port > 65535) return null
  return { host, port }
}

function enforceLoopbackGuards(req: Request, pathname: string, port: number | undefined): void {
  const rawHost = req.headers.get('host')
  if (rawHost === null || rawHost.trim() === '') {
    throw forbidden('loopback request requires a Host header', 'forbidden', {
      details: { guard: 'host', reason: 'missing' },
    })
  }
  const parsedHost = parseHostHeader(rawHost)
  if (parsedHost === null || !LOOPBACK_HOSTS.has(parsedHost.host)) {
    throw forbidden(`loopback Host "${rawHost}" is not allowed`, 'forbidden', {
      details: { guard: 'host', reason: 'disallowed_host' },
    })
  }
  if (port !== undefined) {
    const effectivePort = parsedHost.port ?? 80
    if (effectivePort !== port) {
      throw forbidden(`loopback Host port ${effectivePort} does not match bound port ${port}`, 'forbidden', {
        details: { guard: 'host', reason: 'port_mismatch' },
      })
    }
  }

  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return

  const rawOrigin = req.headers.get('origin')
  if (rawOrigin !== null) {
    let originUrl: URL
    try {
      originUrl = new URL(rawOrigin)
    } catch {
      throw forbidden('loopback write rejected: invalid Origin header', 'forbidden', {
        details: { guard: 'origin', reason: 'invalid' },
      })
    }
    const originHost = originUrl.hostname.toLowerCase()
    const normalizedOriginHost = originHost.includes(':') && !originHost.startsWith('[') ? `[${originHost}]` : originHost
    const originPort = originUrl.port === '' ? (originUrl.protocol === 'https:' ? 443 : 80) : Number(originUrl.port)
    const allowedPort = port ?? parsedHost.port ?? 80
    const canonicalOrigin = `http://${normalizedOriginHost}${originUrl.port !== '' ? `:${originPort}` : ''}`
    if (
      originUrl.protocol !== 'http:' ||
      !LOOPBACK_HOSTS.has(normalizedOriginHost) ||
      originPort !== allowedPort ||
      originUrl.origin.toLowerCase() !== canonicalOrigin ||
      rawOrigin.trim().toLowerCase() !== canonicalOrigin
    ) {
      throw forbidden(`loopback write rejected: disallowed Origin "${rawOrigin}"`, 'forbidden', {
        details: { guard: 'origin', reason: 'disallowed_origin' },
      })
    }
  }

  const rawFetchSite = req.headers.get('sec-fetch-site')
  if (rawFetchSite !== null) {
    const fetchSite = rawFetchSite.trim().toLowerCase()
    if (!ALLOWED_FETCH_SITES.has(fetchSite)) {
      throw forbidden(`loopback write rejected: disallowed Sec-Fetch-Site "${rawFetchSite}"`, 'forbidden', {
        details: { guard: 'sec-fetch-site', reason: 'cross_site' },
      })
    }
  }

  const rawContentType = req.headers.get('content-type')
  const mediaType = rawContentType !== null ? rawContentType.split(';')[0]!.trim().toLowerCase() : ''
  const allowOctetStream = ATTACHMENT_UPLOAD_PATH_RE.test(pathname)
  const okMedia = mediaType === 'application/json' || (allowOctetStream && mediaType === 'application/octet-stream')
  if (!okMedia) {
    throw forbidden(
      allowOctetStream
        ? 'loopback write requires Content-Type: application/json or application/octet-stream'
        : 'loopback write requires Content-Type: application/json',
      'forbidden',
      { details: { guard: 'content-type', mediaType: mediaType || '(missing)' } },
    )
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Compat route compiler (auto-compiled from OPS where compat !== null)

interface CompiledRoute {
  readonly method: string
  readonly op: OpName
  readonly segments: readonly string[]
  readonly paramNames: readonly (string | null)[]
  readonly staticCount: number
}

function compileCompatRoutes(): readonly CompiledRoute[] {
  const routes: CompiledRoute[] = []
  for (const op of OP_NAMES) {
    const compat = OPS[op].compat
    if (compat === null) continue
    const cleanPath = compat.path.replace(/^\/+|\/+$/g, '')
    const segments = cleanPath === '' ? [] : cleanPath.split('/')
    const paramNames = segments.map((seg) => (seg.startsWith(':') ? seg.slice(1) : null))
    const staticCount = paramNames.filter((p) => p === null).length
    routes.push({
      method: compat.method,
      op,
      segments,
      paramNames,
      staticCount,
    })
  }
  // Prefer routes with more static segments so `/tasks/batch`, `/tasks/claim`, `/grants/explain`,
  // `/attachments/uploads`, `/watchers/matches` always beat `/:id` patterns.
  routes.sort((a, b) => b.staticCount - a.staticCount || a.segments.length - b.segments.length)
  return Object.freeze(routes)
}

const COMPAT_ROUTES = compileCompatRoutes()

function matchCompatRoute(
  method: string,
  subpath: string,
): { readonly op: OpName; readonly params: Record<string, string> } | null {
  const clean = subpath.replace(/^\/+|\/+$/g, '')
  const parts = clean === '' ? [] : clean.split('/')
  for (const route of COMPAT_ROUTES) {
    if (route.method !== method) continue
    if (route.segments.length !== parts.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < route.segments.length; i += 1) {
      const pName = route.paramNames[i]!
      const actual = parts[i]!
      if (pName === null) {
        if (actual !== route.segments[i]) {
          matched = false
          break
        }
      } else {
        try {
          params[pName] = decodeURIComponent(actual)
        } catch {
          throw badRequest(`invalid percent-encoding in path parameter "${pName}"`)
        }
      }
    }
    if (matched) return { op: route.op, params }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Body reading & serialization helpers

async function readBodyBytes(req: Request, maxBodyBytes: number): Promise<Uint8Array> {
  const lenHeader = req.headers.get('content-length')
  if (lenHeader !== null) {
    const parsed = Number(lenHeader)
    if (Number.isFinite(parsed) && parsed > maxBodyBytes) {
      throw tooLarge(`request body exceeds ${Math.round(maxBodyBytes / 1024 / 1024)} MiB limit`)
    }
  }
  if (req.body === null) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => {})
        throw tooLarge(`request body exceeds ${Math.round(maxBodyBytes / 1024 / 1024)} MiB limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function readJsonObject(req: Request, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const bytes = await readBodyBytes(req, maxBodyBytes)
  if (bytes.byteLength === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw badRequest('request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function queryToObject(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of url.searchParams.entries()) {
    const existing = out[k]
    if (existing === undefined) {
      out[k] = v
    } else if (Array.isArray(existing)) {
      existing.push(v)
    } else {
      out[k] = [existing, v]
    }
  }
  return out
}

function decodeWireBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>
    if (typeof rec.$bytes === 'string' && Object.keys(rec).length === 1) {
      return new Uint8Array(Buffer.from(rec.$bytes, 'base64'))
    }
  }
  return value
}

function hydrateRpcBytes(op: OpName, input: Record<string, unknown>): Record<string, unknown> {
  const spec = OPS[op]
  const byteKeys = new Set<string>([
    ...(spec.bytesFields ?? []),
    ...spec.params.filter((p) => p.kind === 'bytes').map((p) => p.name),
  ])
  if (byteKeys.size === 0) return input
  const copy: Record<string, unknown> = { ...input }
  for (const key of byteKeys) {
    if (key in copy) {
      copy[key] = decodeWireBytes(copy[key])
    }
  }
  return copy
}

function serializeRpcResult(op: OpName, result: unknown): unknown {
  if (op === 'attachment' && result !== null && typeof result === 'object') {
    const rec = result as { meta?: unknown; data?: unknown }
    if (rec.data instanceof Uint8Array) {
      return {
        meta: rec.meta,
        data: { $bytes: Buffer.from(rec.data).toString('base64') },
      }
    }
  }
  return result
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

function transportKindFor(listener: ServerListenerClass): Capabilities['transport'] {
  switch (listener) {
    case 'uds':
      return 'uds'
    case 'pipe':
      return 'pipe'
    case 'tcp-loopback':
      return 'tcp'
    case 'tailscale':
    case 'https':
      return 'https'
  }
}

function authKindsFor(listener: ServerListenerClass): Capabilities['auth'] {
  switch (listener) {
    case 'uds':
      return Object.freeze(['os-user', 'bearer'] as const)
    case 'pipe':
      return Object.freeze(['bearer'] as const)
    case 'tcp-loopback':
      return Object.freeze(['os-user', 'bearer'] as const)
    case 'tailscale':
      return Object.freeze(['tailscale', 'bearer'] as const)
    case 'https':
      return Object.freeze(['bearer', 'oidc'] as const)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Main handler factory

type Method = (...args: unknown[]) => unknown

export function createServerHandler(options: ServerHandlerOptions): ServerHandler {
  const board = options.board
  const authenticator = options.authenticator
  const queue = options.writeQueue ?? new WriteQueue()
  const ownsHub = options.realtimeHub === undefined
  const hub =
    options.realtimeHub ??
    new RealtimeHub(board, {
      ...(options.sseKeepAliveMs !== undefined ? { keepAliveMs: options.sseKeepAliveMs } : {}),
      ...(options.sseMaxDurationMs !== undefined ? { maxDurationMs: options.sseMaxDurationMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
  const control = options.control
  const uiHandler = options.uiHandler
  const mode = options.mode ?? 'daemon'
  const now = options.now ?? (() => Date.now())
  const startedAtMs = options.startedAtMs ?? now()
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const maxWaitS = options.maxWaitS ?? DEFAULT_HTTP_MAX_WAIT_S
  const keyGuard = guardFor(board)
  const shutdownController = new AbortController()
  let closed = false

  const instanceHeaders = (): Record<string, string> => {
    const out: Record<string, string> = { 'x-content-type-options': 'nosniff' }
    try {
      const info = board.boardInfo()
      if (info.instanceId !== null) out['x-swarmboard-instance'] = info.instanceId
      if (info.boardId !== null) out['x-swarmboard-board-id'] = info.boardId
    } catch {
      // store may be closing
    }
    return out
  }

  const jsonResponse = (
    status: number,
    body: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Response => {
    const headers = new Headers(instanceHeaders())
    headers.set('content-type', 'application/json; charset=utf-8')
    if (extraHeaders !== undefined) {
      for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v)
    }
    return new Response(JSON.stringify(body), { status, headers })
  }

  const errorResponse = (err: unknown): Response => {
    const { status, payload, retryAfter } = clientErrorPayload(err)
    const extra: Record<string, string> = {}
    if (retryAfter !== undefined) extra['retry-after'] = String(retryAfter)
    return jsonResponse(status, payload, extra)
  }

  const checkExpectInstance = (req: Request): void => {
    const expected = req.headers.get('x-swarmboard-expect-instance')?.trim()
    if (expected === undefined || expected === '') return
    const info = board.boardInfo()
    if (info.instanceId !== expected) {
      throw new BoardError(
        410,
        'cursor_expired',
        'the board instance changed since this cursor was read: resync from head',
        {
          hint: 'drop stale cursors and re-read from the current board head',
          details: {
            reason: 'instance_changed',
            boardId: info.boardId,
            instanceId: info.instanceId,
          },
        },
      )
    }
  }

  const buildCapabilities = (ctx: ServerListenerContext): Capabilities =>
    baseCapabilities(board, {
      mode,
      transport: transportKindFor(ctx.listener),
      wake: 'sse',
      crossProcessWake: true,
      wakePollMs: null,
      maxWaitS,
      schedules: mode === 'daemon' || mode === 'service' ? 'tick-lease' : 'owner',
      auth: authKindsFor(ctx.listener),
      assurances: Object.freeze(['human_verified', 'agent_delegated', 'local_unverified'] as const),
    })

  const executeOp = async (
    op: OpName,
    rawInput: Record<string, unknown>,
    caller: CallerContext,
    req: Request,
    opts?: { readonly clampWait?: boolean },
  ): Promise<unknown> => {
    const spec: OpSpec = OPS[op]
    const hydrated = hydrateRpcBytes(op, rawInput)

    // Envelope validation before touching core or write queue (CF-03 parity).
    validateEnvelope(op, hydrated)

    if (caller.principal.kind === 'deployment') {
      throw forbidden("a transport never acts as the board's deployment")
    }

    // Clamp wait parameter on HTTP wait ops.
    let preparedInput = hydrated
    if (spec.wait !== 'none' && opts?.clampWait !== false && preparedInput['wait'] !== undefined) {
      const w = Number(preparedInput['wait'])
      if (Number.isFinite(w) && w > maxWaitS) {
        preparedInput = { ...preparedInput, wait: maxWaitS }
      }
    }

    // Idempotency key mapping & KeyBodyGuard (exact parity with dispatch.ts).
    const idemHeader = req.headers.get('idempotency-key')?.trim()
    const idempotencyKey = idemHeader !== undefined && idemHeader !== '' ? idemHeader : undefined
    const { input: mapped, nativeId } = applyIdempotencyKey(
      op,
      preparedInput,
      { principalId: caller.principal.id, profile: caller.profile },
      idempotencyKey,
    )
    const guardHandle = nativeId !== null ? keyGuard.begin(nativeId, bodyDigest(op, mapped)) : null

    const link = linkSignals(req.signal, shutdownController.signal)
    try {
      // Check cursor-above-head for events (matching dispatch.ts step 10).
      if (op === 'events' && typeof mapped['after'] === 'string' && /^(0|[1-9]\d{0,15})$/.test(mapped['after'])) {
        const afterNum = Number(mapped['after'])
        const head = board.store.getHeadIndex()
        if (afterNum > head) {
          throw new BoardError(
            410,
            'cursor_expired',
            'this cursor is past the end of the log: the board was rewound or the cursor came from another board instance',
            {
              hint: 'read again from the head (omit after)',
              details: { reason: 'log_rewound', head },
            },
          )
        }
      }

      const invokeCore = async (): Promise<unknown> => {
        const service = (spec.binds.service === 'board' ? board : board.tasks) as unknown as Record<string, Method>
        const method = service[spec.binds.method]!
        return await method.apply(service, bindArgs(op, mapped, caller, link.signal))
      }

      const kind = laneKind(op)
      let result: unknown

      if (spec.wait === 'repoll') {
        const wait0 = Number(mapped['wait'] ?? 0)
        const waitMs = Number.isFinite(wait0) && wait0 > 0 ? Math.min(wait0, maxWaitS) * 1000 : 0
        const started = now()
        for (;;) {
          result = spec.access === 'write' ? await queue.enqueue(invokeCore, link.signal) : await invokeCore()
          if (!Array.isArray(result) || result.length > 0 || waitMs <= 0 || link.signal.aborted) break
          const left = started + waitMs - now()
          if (left <= 0) break
          await abortableSleep(Math.min(REPOLL_MS, left), link.signal)
          if (link.signal.aborted) break
        }
      } else if (kind === 'write') {
        // All non-wait writes serialize fairly through the per-board FIFO queue.
        result = await queue.enqueue(invokeCore, link.signal)
      } else if (op === 'claimReadyTask' && Number(mapped['wait'] ?? 0) === 0) {
        // Non-waiting claimReadyTask is a quick write: enqueue fairly on FIFO queue.
        result = await queue.enqueue(invokeCore, link.signal)
      } else {
        // Reads and bounded core waits execute without blocking the write queue.
        result = await invokeCore()
      }

      guardHandle?.commit()
      return result
    } catch (err) {
      guardHandle?.abort()
      throw normalizeThrown(err)
    } finally {
      link.dispose()
    }
  }

  // ---- Control namespace `/_swarm/v1/*`

  const handleControl = async (
    req: Request,
    url: URL,
    ctx: ServerListenerContext,
  ): Promise<Response> => {
    if (ctx.listener === 'tailscale' || ctx.listener === 'https') {
      throw forbidden('control namespace /_swarm/v1/* is restricted to local listeners', 'forbidden')
    }
    const sub = url.pathname.slice('/_swarm/v1'.length) || '/'
    const method = req.method.toUpperCase()

    // GET /_swarm/v1/hello — election/handshake endpoint (no bearer required on UDS)
    if (method === 'GET' && sub === '/hello') {
      const hello: DaemonHelloPayload = control?.hello
        ? control.hello()
        : (() => {
            const info = board.boardInfo()
            return {
              protocol: [PROTOCOL_VERSION, PROTOCOL_VERSION] as const,
              build: `swarmboard ${CLIENT_VERSION}`,
              pid: process.pid,
              nonce: 'standalone',
              boardId: info.boardId,
              instanceId: info.instanceId,
              schema: info.schema?.version ?? 0,
              db: { realpath: '', dev: 0, ino: 0 },
              sidecars: { wakeup: '', jsonl: '' },
              tcp: ctx.port !== undefined ? { host: '127.0.0.1', port: ctx.port } : null,
              startedAt: new Date(startedAtMs).toISOString(),
              idleExitS: 0,
              capabilities: ['sse', 'rpc', 'v2'],
            }
          })()
      return jsonResponse(200, hello)
    }

    // GET/POST /_swarm/v1/login — single-use login code exchange -> HttpOnly; SameSite=Strict cookie
    if (sub === '/login' && (method === 'POST' || method === 'GET')) {
      if (authenticator.exchangeLoginCode === undefined) {
        throw clientError('not_supported', 'login exchange is not enabled on this server')
      }
      let code: string | null = null
      if (method === 'POST') {
        const body = await readJsonObject(req, maxBodyBytes)
        code = typeof body.code === 'string' ? body.code : null
      } else {
        code = url.searchParams.get('code')
      }
      if (code === null || code.trim() === '') {
        throw badRequest('code is required')
      }
      const session = authenticator.exchangeLoginCode(code, { secure: false })
      const headers = new Headers(instanceHeaders())
      headers.set('set-cookie', session.cookieHeader)
      headers.set('cache-control', 'no-store')
      headers.set('referrer-policy', 'no-referrer')
      if (method === 'GET') {
        headers.set('location', '/')
        return new Response(null, { status: 302, headers })
      }
      headers.set('content-type', 'application/json; charset=utf-8')
      return new Response(JSON.stringify({ ok: true, expiresAt: session.expiresAt }), { status: 200, headers })
    }

    // All other control endpoints require authentication.
    const auth: ServerAuthResult = await authenticator.authenticate(req, ctx)

    const requireControlOwner = (opts?: { readonly requirePerson?: boolean }): void => {
      if (auth.caller.principal.owner !== true) {
        throw forbidden('this control operation requires board owner privileges')
      }
      if (opts?.requirePerson === true && (auth.caller.actor.kind !== 'person' || auth.caller.profile !== null)) {
        throw forbidden('only the human board owner may mint a UI login code', 'agent_cannot_impersonate_human')
      }
      if (auth.tokenRecord !== null && !expandPermissions(auth.tokenRecord.cap).has('manage')) {
        throw forbidden('this control operation requires a token with manage permission')
      }
      const resolved = board.resolveAccess(auth.caller)
      if (!resolved.admits || !resolved.caller.at('manage', '*')) {
        throw forbidden('this control operation requires manage access at *')
      }
    }

    if (method === 'GET' && sub === '/status') {
      const info = board.boardInfo()
      return jsonResponse(200, {
        ok: true,
        boardId: info.boardId,
        instanceId: info.instanceId,
        schemaVersion: info.schema?.version ?? 0,
        mode,
        pid: process.pid,
        uptimeMs: Math.max(0, now() - startedAtMs),
        streams: hub.activeStreams,
        queueDepth: queue.depth,
        queueStats: queue.stats(),
        ...(control?.status ? control.status() : {}),
      })
    }

    if (method === 'POST' && sub === '/retire') {
      requireControlOwner()
      const body = await readJsonObject(req, maxBodyBytes)
      const reason = typeof body.reason === 'string' ? body.reason : 'api-retire'
      if (control?.retire === undefined) {
        return jsonResponse(200, { ok: true, retiring: false })
      }
      const result = await control.retire(reason)
      return jsonResponse(200, { ok: true, ...result })
    }

    if (method === 'POST' && sub === '/listen-tcp') {
      requireControlOwner()
      if (control?.listenTcp === undefined) {
        throw clientError('not_supported', 'dynamic TCP listener activation is not enabled on this server')
      }
      const body = await readJsonObject(req, maxBodyBytes)
      const host = typeof body.host === 'string' ? body.host : undefined
      const port = typeof body.port === 'number' && Number.isInteger(body.port) ? body.port : undefined
      const bound = await control.listenTcp({
        ...(host !== undefined ? { host } : {}),
        ...(port !== undefined ? { port } : {}),
      })
      return jsonResponse(200, { ok: true, ...bound })
    }

    if (method === 'POST' && sub === '/login-code') {
      requireControlOwner({ requirePerson: true })
      if (authenticator.mintLoginCode === undefined) {
        throw clientError('not_supported', 'login code minting is not enabled on this server')
      }
      const body = await readJsonObject(req, maxBodyBytes)
      const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : undefined
      const minted = authenticator.mintLoginCode({ ...(ttlMs !== undefined ? { ttlMs } : {}) })
      return jsonResponse(200, minted, { 'cache-control': 'no-store' })
    }

    // Token management: GET/POST /_swarm/v1/tokens, DELETE/POST /_swarm/v1/tokens/:id(/revoke)
    if (sub === '/tokens' || sub.startsWith('/tokens/')) {
      const tokens = authenticator.tokens
      if (tokens === undefined) {
        throw clientError('not_supported', 'token store is not configured on this server')
      }
      if (sub === '/tokens' && method === 'GET') {
        const includeRevoked = url.searchParams.get('includeRevoked') === 'true'
        const includeExpired = url.searchParams.get('includeExpired') === 'true'
        const principalId =
          auth.caller.principal.owner === true
            ? (url.searchParams.get('principalId') ?? undefined)
            : auth.caller.principal.id
        const list = tokens.listTokens({
          ...(principalId !== undefined ? { principalId } : {}),
          includeRevoked,
          includeExpired,
        })
        return jsonResponse(200, { tokens: list })
      }
      if (sub === '/tokens' && method === 'POST') {
        const body = (await readJsonObject(req, maxBodyBytes)) as ServerIssueTokenRequest
        const issuer =
          auth.tokenRecord !== null
            ? { kind: 'token' as const, token: auth.tokenRecord }
            : { kind: 'caller' as const, caller: auth.caller }
        const issued = await queue.enqueue(() => tokens.issueToken(issuer, body), req.signal)
        return jsonResponse(201, issued, { 'cache-control': 'no-store' })
      }
      const revokeMatch = /^\/tokens\/([^/]+)(?:\/revoke)?$/.exec(sub)
      if (revokeMatch !== null && (method === 'DELETE' || method === 'POST')) {
        const id = decodeURIComponent(revokeMatch[1]!)
        const actor = auth.tokenRecord ?? auth.caller
        const record = await queue.enqueue(() => tokens.revokeToken(id, { actor }), req.signal)
        return jsonResponse(200, { record })
      }
    }

    throw notFound(`unknown control route: ${method} ${url.pathname}`)
  }

  // ---- Ergonomic /api/v2/* routes (§1.6 & §4.2)

  const handleV2 = async (
    req: Request,
    url: URL,
    ctx: ServerListenerContext,
  ): Promise<Response> => {
    const method = req.method.toUpperCase()
    const sub = url.pathname.slice('/api/v2'.length) || '/'

    // 1. Universal typed RPC: POST /api/v2/rpc/:op
    if (sub.startsWith('/rpc/')) {
      if (method !== 'POST') {
        throw badRequest('RPC endpoints require POST')
      }
      const auth = await authenticator.authenticate(req, ctx)
      checkExpectInstance(req)
      const opName = decodeURIComponent(sub.slice('/rpc/'.length))
      if (!isOpName(opName)) {
        throw clientError('not_supported', `no operation named ${opName}`)
      }
      const body = await readJsonObject(req, maxBodyBytes)
      const result = await executeOp(opName, body, auth.caller, req)
      return jsonResponse(200, serializeRpcResult(opName, result))
    }

    // 2. Real-time SSE stream: GET /api/v2/stream
    if (method === 'GET' && sub === '/stream') {
      const auth = await authenticator.authenticate(req, ctx)
      checkExpectInstance(req)
      const lastEventId = req.headers.get('last-event-id')?.trim()
      const afterParam = url.searchParams.get('after')?.trim()
      const rawAfter = lastEventId && lastEventId !== '' ? lastEventId : afterParam
      let after: number | undefined
      if (rawAfter !== undefined && rawAfter !== '') {
        if (!/^(0|[1-9]\d{0,15})$/.test(rawAfter)) {
          throw badRequest(`invalid cursor: ${rawAfter}`, 'invalid_cursor')
        }
        after = Number(rawAfter)
      }
      const typesRaw = url.searchParams.get('types')
      const types = typesRaw ? typesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined
      const { stream } = await hub.subscribe(
        auth.caller,
        {
          ...(after !== undefined ? { after } : {}),
          ...(url.searchParams.get('channel') ? { channel: url.searchParams.get('channel')! } : {}),
          ...(url.searchParams.get('re') ? { re: url.searchParams.get('re')! } : {}),
          ...(url.searchParams.get('by') ? { by: url.searchParams.get('by')! } : {}),
          ...(url.searchParams.get('mentions') ? { mentions: url.searchParams.get('mentions')! } : {}),
          ...(url.searchParams.get('all') === 'true' ? { all: true } : {}),
          ...(types !== undefined && types.length > 0 ? { types } : {}),
        },
        req.signal,
      )
      const headers = new Headers(instanceHeaders())
      headers.set('content-type', 'text/event-stream; charset=utf-8')
      headers.set('cache-control', 'no-cache, no-transform')
      headers.set('connection', 'keep-alive')
      headers.set('x-accel-buffering', 'no')
      return new Response(stream, { status: 200, headers })
    }

    // 3. Ergonomic beta-tester feedback shortcut: POST /api/v2/feedback
    if (method === 'POST' && sub === '/feedback') {
      const auth = await authenticator.authenticate(req, ctx)
      checkExpectInstance(req)
      const body = await readJsonObject(req, maxBodyBytes)
      if (typeof body.summary !== 'string' || body.summary.trim() === '') {
        throw badRequest('summary: required non-empty string')
      }
      const channel = typeof body.channel === 'string' && body.channel.trim() !== '' ? body.channel : 'meta/feedback'
      const kind = typeof body.kind === 'string' ? body.kind : 'other'
      const severity = typeof body.severity === 'string' ? body.severity : 'med'
      const labels: Record<string, string> = {
        kind,
        severity,
        status: 'new',
        ...(typeof body.harness === 'string' && body.harness.trim() !== '' ? { harness: body.harness } : {}),
      }
      const blockPayload = { ...body, kind, severity }
      delete (blockPayload as Record<string, unknown>).channel
      const makeText = (schemaTag: string): string =>
        `${String(body.summary).trim()}\n\n\`\`\`${schemaTag}\n${JSON.stringify(blockPayload, null, 2)}\n\`\`\``
      try {
        const result = await executeOp(
          'post',
          { channel, text: makeText('json#board-feedback@1'), labels },
          auth.caller,
          req,
        )
        return jsonResponse(201, result)
      } catch (err) {
        if (isBoardError(err) && err.code === 'schema_not_found') {
          const result = await executeOp(
            'post',
            { channel, text: makeText('json'), labels },
            auth.caller,
            req,
          )
          return jsonResponse(201, result)
        }
        throw err
      }
    }

    // 4. All 22 §1.6 REST aliases + /api/v2/search
    const auth = await authenticator.authenticate(req, ctx)
    checkExpectInstance(req)

    let op: OpName | null = null
    let input: Record<string, unknown> = {}

    if (method === 'GET' && sub === '/channels/tree') {
      op = 'channelTree'
      input = queryToObject(url)
    } else if (method === 'POST' && sub === '/channels/read') {
      op = 'markChannelRead'
      input = await readJsonObject(req, maxBodyBytes)
    } else if (method === 'PATCH' && sub.startsWith('/channels/')) {
      const chPath = decodeURIComponent(sub.slice('/channels/'.length))
      if (chPath === '') throw badRequest('channel path is required')
      op = 'updateChannel'
      input = { ...(await readJsonObject(req, maxBodyBytes)), path: chPath }
    } else if (method === 'POST' && sub === '/dm') {
      op = 'ensureDm'
      input = await readJsonObject(req, maxBodyBytes)
    } else if (method === 'GET' && sub === '/groups') {
      op = 'groups'
      input = queryToObject(url)
    } else if (method === 'POST' && sub === '/groups') {
      op = 'createGroup'
      input = await readJsonObject(req, maxBodyBytes)
    } else if (method === 'GET' && sub === '/notifications') {
      op = 'notifications'
      input = queryToObject(url)
    } else if (method === 'GET' && sub === '/notifications/count') {
      op = 'notificationCount'
      input = queryToObject(url)
    } else if (method === 'GET' && sub === '/notifications/wait') {
      op = 'waitNotifications'
      input = queryToObject(url)
    } else if (method === 'POST' && sub === '/notifications/ack-all') {
      op = 'ackAllNotifications'
      input = await readJsonObject(req, maxBodyBytes)
    } else if (method === 'GET' && sub === '/inbox') {
      op = 'agentInbox'
      input = queryToObject(url)
    } else if (method === 'GET' && sub === '/pins') {
      op = 'pins'
      input = queryToObject(url)
    } else if (method === 'PUT' && sub === '/presence') {
      op = 'setPresence'
      input = await readJsonObject(req, maxBodyBytes)
    } else if (method === 'GET' && sub === '/presence') {
      op = 'presence'
      input = queryToObject(url)
    } else if (method === 'GET' && sub === '/search') {
      const q = queryToObject(url)
      if (typeof q.limit === 'string') {
        if (!/^[1-9]\d*$/.test(q.limit)) {
          throw badRequest('limit: must be a positive integer')
        }
        q.limit = Number(q.limit)
      }
      if (typeof q.subtree === 'string') {
        if (q.subtree === 'true' || q.subtree === '1') q.subtree = true
        else if (q.subtree === 'false' || q.subtree === '0') q.subtree = false
        else throw badRequest('subtree: must be true or false')
      }
      op = 'search'
      input = q
    } else {
      let m: RegExpExecArray | null
      if ((m = /^\/groups\/([^/]+)\/members\/remove$/.exec(sub)) !== null && method === 'POST') {
        op = 'removeGroupMembers'
        input = { ...(await readJsonObject(req, maxBodyBytes)), handle: decodeURIComponent(m[1]!) }
      } else if ((m = /^\/groups\/([^/]+)\/members$/.exec(sub)) !== null && method === 'POST') {
        op = 'addGroupMembers'
        input = { ...(await readJsonObject(req, maxBodyBytes)), handle: decodeURIComponent(m[1]!) }
      } else if ((m = /^\/groups\/([^/]+)$/.exec(sub)) !== null) {
        const handle = decodeURIComponent(m[1]!)
        if (method === 'GET') {
          op = 'group'
          input = { handle }
        } else if (method === 'PATCH') {
          op = 'updateGroup'
          input = { ...(await readJsonObject(req, maxBodyBytes)), handle }
        } else if (method === 'DELETE') {
          op = 'deleteGroup'
          input = { handle }
        }
      } else if ((m = /^\/notifications\/([^/]+)\/ack$/.exec(sub)) !== null && method === 'POST') {
        op = 'ackNotification'
        input = { ...(await readJsonObject(req, maxBodyBytes)), id: decodeURIComponent(m[1]!) }
      } else if ((m = /^\/messages\/([^/]+)\/pin$/.exec(sub)) !== null && method === 'POST') {
        op = 'pinMessage'
        input = { ...(await readJsonObject(req, maxBodyBytes)), id: decodeURIComponent(m[1]!) }
      } else if ((m = /^\/messages\/([^/]+)\/unpin$/.exec(sub)) !== null && method === 'POST') {
        op = 'unpinMessage'
        input = { ...(await readJsonObject(req, maxBodyBytes)), id: decodeURIComponent(m[1]!) }
      }
    }

    if (op === null) {
      throw notFound(`unknown v2 route: ${method} ${url.pathname}`)
    }
    const result = await executeOp(op, input, auth.caller, req)
    return jsonResponse(200, result)
  }

  // ---- Vercel-compatible `/api/board` & `/api/board/*`

  const handleCompat = async (
    req: Request,
    url: URL,
    ctx: ServerListenerContext,
  ): Promise<Response> => {
    const method = req.method.toUpperCase()
    const sub = url.pathname.slice('/api/board'.length)

    // Discovery document: GET /api/board (or /api/board/)
    if (method === 'GET' && (sub === '' || sub === '/')) {
      const caps = buildCapabilities(ctx)
      const info = board.boardInfo()
      return jsonResponse(200, {
        protocol: PROTOCOL_VERSION,
        version: CLIENT_VERSION,
        boardId: info.boardId,
        instanceId: info.instanceId,
        schema: info.schema,
        swarmboard: caps,
        fusion: {
          lease_cap_s: caps.leaseCapS,
          lease_min_s: caps.leaseMinS,
          lease_default_s: caps.leaseDefaultS,
          batch_max: caps.batchMax,
          conditional_needs: caps.conditionalNeeds,
          priority: caps.priorityNative,
          defer: caps.defer,
          resume: caps.resume,
          subtree_read: caps.subtreeRead,
        },
        endpoints: {
          board: '/api/board',
          v2: '/api/v2',
          rpc: '/api/v2/rpc/:op',
          stream: '/api/v2/stream',
        },
      })
    }

    const matched = matchCompatRoute(method, sub)
    if (matched === null) {
      throw notFound(`unknown board route: ${method} ${url.pathname}`)
    }

    const auth = await authenticator.authenticate(req, ctx)
    checkExpectInstance(req)

    const { op, params } = matched
    let input: Record<string, unknown> = { ...params }

    if (op === 'upload') {
      const ct = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (ct === 'application/json') {
        const body = await readJsonObject(req, maxBodyBytes)
        input = { ...body }
      } else {
        const data = await readBodyBytes(req, maxBodyBytes)
        const name = req.headers.get('x-attachment-name') ?? url.searchParams.get('name') ?? null
        const type = req.headers.get('x-attachment-type') ?? (ct || null)
        input = { name, type, data }
      }
    } else if (op === 'uploadFinish') {
      const ct = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (ct === 'application/json') {
        const body = await readJsonObject(req, maxBodyBytes)
        input = { ...body, ...params }
      } else {
        const data = await readBodyBytes(req, maxBodyBytes)
        input = { ...params, data }
      }
    } else if (method === 'GET') {
      const query = queryToObject(url)
      if (op === 'inbox') {
        // Positional optional params: channel (string), limit (int)
        if (typeof query.channel === 'string') input.channel = query.channel
        if (query.limit !== undefined) {
          const n = Number(query.limit)
          if (!Number.isSafeInteger(n)) throw badRequest('limit: must be an integer')
          input.limit = n
        }
      } else if (OPS[op].body !== 'none') {
        input = { ...query, ...params }
      }
    } else {
      if (OPS[op].body !== 'none') {
        const body = await readJsonObject(req, maxBodyBytes)
        input = { ...body, ...params }
      }
    }

    const result = await executeOp(op, input, auth.caller, req)

    if (op === 'attachment') {
      const att = result as { meta: { id: string; name: string | null; type: string; size: number }; data: Uint8Array }
      const headers = new Headers(instanceHeaders())
      headers.set('content-type', att.meta.type || 'application/octet-stream')
      headers.set('content-length', String(att.data.byteLength))
      headers.set('x-attachment-id', att.meta.id)
      if (att.meta.name !== null) {
        headers.set('x-attachment-name', att.meta.name)
        headers.set('content-disposition', `inline; filename="${att.meta.name.replace(/["\\\r\n]/g, '_')}"`)
      }
      const copy = new Uint8Array(att.data.byteLength)
      copy.set(att.data)
      return new Response(copy, { status: 200, headers })
    }

    return jsonResponse(200, result)
  }

  // ---- Main Fetch dispatch

  const handler = (async (req: Request, ctx: ServerListenerContext): Promise<Response> => {
    control?.onActivity?.()
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return errorResponse(badRequest('malformed request URL'))
    }
    const pathname = url.pathname
    const method = req.method.toUpperCase()

    try {
      // Enforce loopback DNS-rebinding & CSRF guards unconditionally on EVERY tcp-loopback request
      // (even public /healthz, /, /api/board, /_swarm/v1/login, and even when auth.enforce=false).
      if (ctx.listener === 'tcp-loopback') {
        enforceLoopbackGuards(req, pathname, ctx.port)
      }

      // 1. Health endpoint
      if (method === 'GET' && pathname === '/healthz') {
        const info = board.boardInfo()
        return jsonResponse(200, {
          ok: true,
          boardId: info.boardId,
          instanceId: info.instanceId,
          schemaVersion: info.schema?.version ?? 0,
          mode,
          uptimeMs: Math.max(0, now() - startedAtMs),
          streams: hub.activeStreams,
          queueDepth: queue.depth,
        })
      }

      // 2. Control namespace `/_swarm/v1/*`
      if (CONTROL_PATH_RE.test(pathname)) {
        return await handleControl(req, url, ctx)
      }

      // 3. v2 API + RPC + SSE
      if (pathname === '/api/v2' || pathname.startsWith('/api/v2/')) {
        return await handleV2(req, url, ctx)
      }

      // 4. Vercel-compatible `/api/board` + `/api/board/*`
      if (pathname === '/api/board' || pathname.startsWith('/api/board/')) {
        return await handleCompat(req, url, ctx)
      }

      // 5. Static Command Center UI (`GET /`, `GET /assets/*`, `GET /favicon.ico`)
      if ((method === 'GET' || method === 'HEAD') && (pathname === '/' || pathname.startsWith('/assets/') || pathname === '/favicon.ico')) {
        if (ctx.listener === 'tailscale' || ctx.listener === 'https') {
          await authenticator.authenticate(req, ctx)
        }
        if (uiHandler !== undefined) {
          const uiRes = await uiHandler(req, ctx)
          if (uiRes !== null) {
            const headers = new Headers(uiRes.headers)
            for (const [k, v] of Object.entries(instanceHeaders())) {
              if (!headers.has(k)) headers.set(k, v)
            }
            return new Response(uiRes.body, {
              status: uiRes.status,
              statusText: uiRes.statusText,
              headers,
            })
          }
        }
        if (pathname === '/') {
          const headers = new Headers(instanceHeaders())
          headers.set('content-type', 'text/html; charset=utf-8')
          return new Response(method === 'HEAD' ? null : FALLBACK_UI_HTML, { status: 200, headers })
        }
      }

      throw notFound(`not found: ${method} ${pathname}`)
    } catch (err) {
      return errorResponse(err)
    }
  }) as ServerHandler

  Object.defineProperties(handler, {
    queue: { value: queue, enumerable: true },
    hub: { value: hub, enumerable: true },
    close: {
      value: () => {
        if (closed) return
        closed = true
        shutdownController.abort(clientError('unavailable', 'server is shutting down'))
        queue.rejectAll(clientError('unavailable', 'server is shutting down'))
        if (ownsHub) hub.close()
      },
      enumerable: true,
    },
  })

  return handler
}
