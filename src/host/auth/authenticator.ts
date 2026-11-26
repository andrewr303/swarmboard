// HOST-8: Per-listener authenticator, 4 loopback CSRF guards, UI login codes/cookies, and remote-ready
// Tailscale + OIDC hooks (Swarmboard v2 launch design §4.1).
//
// Invariants:
// - `CallerContext` is built solely from a verified credential (never client-asserted principal fields).
// - All 4 loopback CSRF/DNS-rebinding guards (`Host` on all requests; `Origin`, `Sec-Fetch-Site`,
//   `Content-Type` on all non-GET/HEAD requests) run on `tcp-loopback` EVEN when `auth.enforce=false`.
// - `--tailscale-host` and `--allow-host` are mutually exclusive (`400 conflicting_options`).
// - Control namespace `/_swarm/v1/*` is refused (`403`) on non-local listeners (`tailscale`, `https`).
// - Every allow/deny writes an audit row to `auth_audit_log` (recording ONLY `token_id`, NEVER secrets).
// - Every returned `CallerContext` passes `checkCallerActor` (C10 `agent_cannot_impersonate_human`).
//
// Pure over node:crypto, jose, ../core/public.ts, ../../client/errors.ts, ./local.ts, and ./tokens.ts
// (no internal barrel imports, no core error normalizers, no stdio logging, no process/net/http modules).
import { createHash, randomBytes } from 'node:crypto'
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type CryptoKey,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  type KeyObject,
} from 'jose'
import {
  badRequest,
  BoardError,
  checkCallerActor,
  createLocalCaller,
  forbidden,
  unauthorized,
  type Assurance,
  type BoardIdentity,
  type CallerContext,
  type StorageBackend,
} from '../../core/public.ts'
import { clientError, isBoardError } from '../../client/errors.ts'
import {
  compileCanHeader,
  DEFAULT_AGENT_CAP,
  isValidProfile,
  loadAgentCard,
  resolveOsUser,
  sanitizeOsUser,
} from './local.ts'
import {
  narrowCanHeader,
  parseToken,
  TokenStore,
  type TokenListenerClass,
  type TokenRecord,
} from './tokens.ts'

export type ListenerClass = TokenListenerClass

export const SESSION_COOKIE_NAME = 'sb_session'
export const DEFAULT_LOGIN_CODE_TTL_MS = 60_000
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000

const CONTROL_PATH_RE = /^\/_swarm\/v1(?:\/|$)/
const ATTACHMENT_UPLOAD_PATH_RE = /^\/api\/(?:board|v2)\/attachments(?:\/|$)|^\/attachments(?:\/|$)/
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])
const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none'])
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const SAFE_HOSTNAME_RE = /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::\d{1,5})?$/

export interface ListenerContext {
  readonly listener: ListenerClass
  /** Bound loopback port for `tcp-loopback` (required for exact Host/Origin port validation). */
  readonly port?: number
  /** Allowed `Host` values for `https` / LAN listeners (mutually exclusive with `tailscaleHost`). */
  readonly allowHosts?: readonly string[]
  /** Tailnet hostname for `tailscale` listener (mutually exclusive with `allowHosts`). */
  readonly tailscaleHost?: string
  /** Expected board URL (also used as OIDC `aud` claim on `https`). */
  readonly boardUrl?: string
}

export interface OidcIssuerConfig {
  /** Exact OIDC `iss` claim value. */
  readonly issuer: string
  /** Remote JWKS URL (`https://...`) for live key discovery. */
  readonly jwksUri?: string
  /** In-memory JWKS for static/offline verification or tests. */
  readonly jwks?: JSONWebKeySet
  /** Direct verification key or custom `JWTVerifyGetKey` resolver. */
  readonly key?: CryptoKey | KeyObject | Uint8Array | JWTVerifyGetKey
  /** `'human'` = interactive SSO (`human_verified` person); `'workload'` = CI/agent (`agent_delegated`). */
  readonly kind?: 'human' | 'workload'
  /** Default agent profile for workload OIDC tokens when `X-Board-Profile` is omitted (default `'oidc'`). */
  readonly defaultProfile?: string
}

export interface OidcConfig {
  /** Expected `aud` claim (usually the exact board URL). */
  readonly audience?: string
  readonly issuers: readonly OidcIssuerConfig[]
}

export interface AuthenticatorConfig {
  readonly store: StorageBackend
  readonly tokens?: TokenStore
  readonly authEnforce?: boolean
  /** Local OS user identity for UDS / loopback owner sessions (defaults to `resolveOsUser()`). */
  readonly ownerUserId?: string
  readonly ownerHandle?: string
  readonly ownerName?: string
  /** Optional board dir so local UDS/loopback `X-Board-Profile` respects `agents/<profile>.json` cards. */
  readonly boardDir?: string | null
  /** When true, local token callers receive `member: false` and must match explicit `board_grants`. */
  readonly requireExplicitGrants?: boolean
  /** Default bound TCP loopback port (e.g. `4180`). */
  readonly loopbackPort?: number
  /** Tailscale listener configuration (mutually exclusive with `allowHosts`). */
  readonly tailscaleHost?: string
  /** Tailscale login granted `human_verified` + owner rights (e.g. `alice@example.com`). */
  readonly tailscaleOwnerLogin?: string
  /** Allowed Host values for non-tailscale remote/LAN listeners (mutually exclusive with `tailscaleHost`). */
  readonly allowHosts?: readonly string[]
  /** Expected board URL (used for `https` Host fallback and OIDC `aud`). */
  readonly boardUrl?: string
  /** Mode 4 OIDC JWT verification hook (via `jose`). */
  readonly oidc?: OidcConfig
  /** Injectable clock for deterministic expiry/audit tests. */
  readonly now?: () => number
  /** Current OS uid / platform for agent card hygiene checks. */
  readonly uid?: number | null
  readonly platform?: NodeJS.Platform
}

export interface AuthResult {
  readonly caller: CallerContext
  readonly listener: ListenerClass
  readonly authMethod: 'bearer-token' | 'os-user' | 'session-cookie' | 'loopback-ui' | 'tailscale' | 'oidc'
  readonly tokenId: string | null
  readonly tokenRecord: TokenRecord | null
}

export interface LoginCodeResult {
  readonly code: string
  readonly expiresAt: string
}

export interface SessionResult {
  readonly sessionId: string
  readonly cookieHeader: string
  readonly expiresAt: string
}

interface StoredLoginCode {
  readonly expiresAtMs: number
  readonly assurance: 'local_unverified' | 'human_verified'
}

interface StoredSession {
  readonly expiresAtMs: number
  readonly assurance: 'local_unverified' | 'human_verified'
}

/** True when `pathname` is inside the local-only `/_swarm/v1/*` control namespace. */
export function isControlPath(pathname: string): boolean {
  return CONTROL_PATH_RE.test(pathname)
}

/** True when `pathname` is an attachment upload route that permits `application/octet-stream`. */
export function isAttachmentUploadPath(pathname: string): boolean {
  return ATTACHMENT_UPLOAD_PATH_RE.test(pathname)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function parsePathname(req: Request): string {
  try {
    return new URL(req.url).pathname
  } catch {
    return '/'
  }
}

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
  if (colon === -1) {
    return { host: trimmed.toLowerCase(), port: null }
  }
  // Reject multiple colons outside IPv6 brackets.
  if (trimmed.indexOf(':', colon + 1) !== -1) return null
  const host = trimmed.slice(0, colon).toLowerCase()
  const portStr = trimmed.slice(colon + 1)
  if (host === '' || !/^\d{1,5}$/.test(portStr)) return null
  const port = Number(portStr)
  if (port < 1 || port > 65535) return null
  return { host, port }
}

/**
 * Validates listener host configuration, enforcing mutual exclusion between
 * `--tailscale-host` and `--allow-host` (`400 conflicting_options`).
 */
export function validateListenerConfig(cfg: {
  readonly tailscaleHost?: string
  readonly allowHosts?: readonly string[]
}): void {
  const hasTailscale = cfg.tailscaleHost !== undefined && cfg.tailscaleHost.trim() !== ''
  const hasAllowHosts = cfg.allowHosts !== undefined && cfg.allowHosts.length > 0
  if (hasTailscale && hasAllowHosts) {
    throw clientError(
      'conflicting_options',
      '--tailscale-host and --allow-host are mutually exclusive: a generic proxy can forge Tailscale-User-Login headers',
    )
  }
  if (hasTailscale && !SAFE_HOSTNAME_RE.test(cfg.tailscaleHost!.trim())) {
    throw badRequest(`invalid tailscaleHost: "${cfg.tailscaleHost}"`, 'invalid_request')
  }
  if (hasAllowHosts) {
    for (const h of cfg.allowHosts!) {
      if (typeof h !== 'string' || !SAFE_HOSTNAME_RE.test(h.trim())) {
        throw badRequest(`invalid allowHosts entry: "${String(h)}"`, 'invalid_request')
      }
    }
  }
}

/**
 * Mandatory 4-layer loopback CSRF & DNS-rebinding guards for `tcp-loopback` requests
 * (enforced unconditionally, EVEN when `auth.enforce=false`):
 * 1. `Host` ∈ `{127.0.0.1:<port>, localhost:<port>, [::1]:<port>}` on ALL requests.
 * 2. `Origin` (if present) ∈ `{http://127.0.0.1:<port>, http://localhost:<port>, http://[::1]:<port>}` on non-GET/HEAD.
 * 3. `Sec-Fetch-Site` (if present) ∈ `{'same-origin', 'none'}` on non-GET/HEAD.
 * 4. `Content-Type` === `'application/json'` (or `'application/octet-stream'` on `/attachments` upload routes) on non-GET/HEAD.
 */
export function checkLoopbackGuards(req: Request, opts: { readonly port?: number } = {}): void {
  const expectedPort = opts.port

  // Guard 1: Host header (DNS rebinding protection on ALL requests).
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
  if (expectedPort !== undefined) {
    const effectivePort = parsedHost.port ?? 80
    if (effectivePort !== expectedPort) {
      throw forbidden(`loopback Host port ${effectivePort} does not match bound port ${expectedPort}`, 'forbidden', {
        details: { guard: 'host', reason: 'port_mismatch' },
      })
    }
  }

  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return

  // Guard 2: Origin header (if present, MUST match exact loopback http origin + port).
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
    const allowedPort = expectedPort ?? parsedHost.port ?? 80
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

  // Guard 3: Sec-Fetch-Site header (if present, MUST be 'same-origin' or 'none').
  const rawFetchSite = req.headers.get('sec-fetch-site')
  if (rawFetchSite !== null) {
    const fetchSite = rawFetchSite.trim().toLowerCase()
    if (!ALLOWED_FETCH_SITES.has(fetchSite)) {
      throw forbidden(`loopback write rejected: disallowed Sec-Fetch-Site "${rawFetchSite}"`, 'forbidden', {
        details: { guard: 'sec-fetch-site', reason: 'cross_site' },
      })
    }
  }

  // Guard 4: Content-Type header (MUST be application/json, or application/octet-stream on attachment upload routes).
  const rawContentType = req.headers.get('content-type')
  const mediaType = rawContentType !== null ? rawContentType.split(';')[0]!.trim().toLowerCase() : ''
  const pathname = parsePathname(req)
  const allowOctetStream = isAttachmentUploadPath(pathname)
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

/**
 * Litestream / restore `instanceId` fence hook (§4.1): rejects requests whose
 * `X-Swarmboard-Expect-Instance` header differs from the live board's `instanceId` with `410 cursor_expired`.
 */
export function checkExpectedInstance(
  req: Request,
  liveInfo: Pick<BoardIdentity, 'boardId' | 'instanceId'> | { readonly boardId: string | null; readonly instanceId: string | null },
): void {
  const expected = req.headers.get('x-swarmboard-expect-instance')?.trim()
  if (expected === undefined || expected === '') return
  if (liveInfo.instanceId !== expected) {
    throw new BoardError(
      410,
      'cursor_expired',
      'the board instance changed since this cursor was read: resync from head',
      {
        hint: 'drop stale cursors and re-read from the current board head',
        details: {
          reason: 'instance_changed',
          boardId: liveInfo.boardId,
          instanceId: liveInfo.instanceId,
        },
      },
    )
  }
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth === null) return null
  const trimmed = auth.trim()
  if (trimmed === '') return null
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed)
  if (match === null) {
    throw unauthorized('malformed Authorization header: expected "Bearer <token>"', 'unauthorized')
  }
  return match[1]!
}

function extractSessionCookie(req: Request): string | null {
  const cookieHeader = req.headers.get('cookie')
  if (cookieHeader === null) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim()
      return value === '' ? null : value
    }
  }
  return null
}

function normalizeHostForCompare(hostHeader: string, defaultPort: number): string | null {
  const parsed = parseHostHeader(hostHeader)
  if (parsed === null) return null
  const port = parsed.port ?? defaultPort
  return `${parsed.host}:${port}`
}

function hostMatchesAllowList(rawHost: string | null, allowed: readonly string[], defaultPort: number): boolean {
  if (rawHost === null || allowed.length === 0) return false
  const given = normalizeHostForCompare(rawHost, defaultPort)
  if (given === null) return false
  for (const candidate of allowed) {
    const norm = normalizeHostForCompare(candidate, defaultPort)
    if (norm !== null && norm === given) return true
  }
  return false
}

function parseProfileHeader(req: Request): { readonly present: boolean; readonly value: string | null } {
  const raw = req.headers.get('x-board-profile')
  if (raw === null) return { present: false, value: null }
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { present: true, value: null }
  }
  if (!isValidProfile(trimmed)) {
    throw badRequest(
      'x-board-profile must start with a letter and use up to 32 letters, numbers, and hyphens',
      'invalid_profile',
    )
  }
  return { present: true, value: trimmed }
}

function principalHandleOf(principalId: string, fallback: string): string {
  const prefix = 'local:user:'
  if (principalId.startsWith(prefix)) {
    const rest = principalId.slice(prefix.length)
    if (rest !== '') return rest
  }
  const tsPrefix = 'tailscale:user:'
  if (principalId.startsWith(tsPrefix)) {
    const rest = principalId.slice(tsPrefix.length)
    if (rest !== '') return rest
  }
  return fallback
}

function userIdOf(principalId: string, fallback: string): string {
  return principalHandleOf(principalId, fallback)
}

/**
 * Per-listener request authenticator for Swarmboard Modes 2–4.
 */
export class Authenticator {
  readonly tokens: TokenStore
  readonly #authEnforce: boolean
  readonly #ownerUserId: string
  readonly #ownerHandle: string
  readonly #ownerName: string
  readonly #ownerPrincipalId: string
  readonly #boardDir: string | null
  readonly #requireExplicitGrants: boolean
  readonly #loopbackPort: number | undefined
  readonly #tailscaleHost: string | undefined
  readonly #tailscaleOwnerLogin: string | undefined
  readonly #allowHosts: readonly string[] | undefined
  readonly #boardUrl: string | undefined
  readonly #oidc: OidcConfig | undefined
  readonly #now: () => number
  readonly #uid: number | null
  readonly #platform: NodeJS.Platform
  readonly #loginCodes = new Map<string, StoredLoginCode>()
  readonly #sessions = new Map<string, StoredSession>()
  readonly #oidcKeyCache = new Map<string, CryptoKey | KeyObject | Uint8Array | JWTVerifyGetKey>()

  constructor(config: AuthenticatorConfig) {
    validateListenerConfig({
      ...(config.tailscaleHost !== undefined ? { tailscaleHost: config.tailscaleHost } : {}),
      ...(config.allowHosts !== undefined ? { allowHosts: config.allowHosts } : {}),
    })
    this.#now = config.now ?? (() => Date.now())
    this.tokens = config.tokens ?? new TokenStore(config.store, { now: this.#now })
    this.#authEnforce = config.authEnforce ?? false
    this.#ownerUserId = config.ownerUserId !== undefined ? sanitizeOsUser(config.ownerUserId) : resolveOsUser()
    this.#ownerHandle = config.ownerHandle !== undefined ? sanitizeOsUser(config.ownerHandle) : this.#ownerUserId
    this.#ownerName = config.ownerName ?? this.#ownerHandle
    this.#ownerPrincipalId = `local:user:${this.#ownerUserId}`
    this.#boardDir = config.boardDir ?? null
    this.#requireExplicitGrants = config.requireExplicitGrants ?? false
    this.#loopbackPort = config.loopbackPort
    this.#tailscaleHost = config.tailscaleHost?.trim()
    this.#tailscaleOwnerLogin = config.tailscaleOwnerLogin?.trim().toLowerCase()
    this.#allowHosts = config.allowHosts !== undefined ? Object.freeze([...config.allowHosts]) : undefined
    this.#boardUrl = config.boardUrl
    this.#oidc = config.oidc
    this.#uid = config.uid !== undefined ? config.uid : typeof process.getuid === 'function' ? process.getuid() : null
    this.#platform = config.platform ?? process.platform
  }

  /** Mints a 60 s single-use one-time login code for `swarmboard open` -> `/_swarm/v1/login`. */
  mintLoginCode(opts: { readonly ttlMs?: number; readonly assurance?: 'local_unverified' | 'human_verified' } = {}): LoginCodeResult {
    this.#pruneEphemeral()
    const ttlMs = opts.ttlMs ?? DEFAULT_LOGIN_CODE_TTL_MS
    if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 10 * 60_000) {
      throw badRequest('login code ttlMs must be between 1000 and 600000', 'invalid_request')
    }
    const code = randomBytes(32).toString('base64url')
    const expiresAtMs = this.#now() + Math.floor(ttlMs)
    this.#loginCodes.set(sha256Hex(code), {
      expiresAtMs,
      assurance: opts.assurance ?? 'local_unverified',
    })
    return Object.freeze({ code, expiresAt: new Date(expiresAtMs).toISOString() })
  }

  /** Atomically exchanges a single-use login code for an `HttpOnly; SameSite=Strict` UI session cookie. */
  exchangeLoginCode(
    code: string,
    opts: { readonly sessionTtlMs?: number; readonly secure?: boolean } = {},
  ): SessionResult {
    this.#pruneEphemeral()
    if (typeof code !== 'string' || code.trim() === '') {
      throw unauthorized('invalid or expired login code', 'unauthorized')
    }
    const key = sha256Hex(code.trim())
    const entry = this.#loginCodes.get(key)
    // Consume unconditionally (single-use even on race/expiry).
    this.#loginCodes.delete(key)
    const nowMs = this.#now()
    if (entry === undefined || entry.expiresAtMs <= nowMs) {
      throw unauthorized('invalid or expired login code', 'unauthorized')
    }

    const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    if (!Number.isFinite(sessionTtlMs) || sessionTtlMs < 1000) {
      throw badRequest('sessionTtlMs must be at least 1000ms', 'invalid_request')
    }
    const sessionId = randomBytes(32).toString('base64url')
    const expiresAtMs = nowMs + Math.floor(sessionTtlMs)
    this.#sessions.set(sha256Hex(sessionId), {
      expiresAtMs,
      assurance: entry.assurance,
    })
    const maxAgeS = Math.max(1, Math.floor(sessionTtlMs / 1000))
    const secureAttr = opts.secure === true ? '; Secure' : ''
    const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secureAttr}`
    return Object.freeze({
      sessionId,
      cookieHeader,
      expiresAt: new Date(expiresAtMs).toISOString(),
    })
  }

  /** Revokes an active browser session cookie. */
  revokeSession(sessionId: string): boolean {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    return this.#sessions.delete(sha256Hex(sessionId))
  }

  /**
   * Authenticates an incoming `Request` on the given `ListenerContext`, enforces all listener guards
   * and C10 assurance invariants, and records an entry in `auth_audit_log` for every allow and deny.
   */
  async authenticate(req: Request, ctx: ListenerContext): Promise<AuthResult> {
    const pathname = parsePathname(req)
    const method = req.method.toUpperCase()
    let attemptedTokenId: string | null = null
    let attemptedPrincipalId: string | null = null

    try {
      const effectiveTailscaleHost = ctx.tailscaleHost ?? this.#tailscaleHost
      const effectiveAllowHosts = ctx.allowHosts ?? this.#allowHosts
      validateListenerConfig({
        ...(effectiveTailscaleHost !== undefined ? { tailscaleHost: effectiveTailscaleHost } : {}),
        ...(effectiveAllowHosts !== undefined ? { allowHosts: effectiveAllowHosts } : {}),
      })

      // Refuse /_swarm/v1/* control namespace on non-local listeners.
      if (isControlPath(pathname) && (ctx.listener === 'tailscale' || ctx.listener === 'https')) {
        throw forbidden('control namespace /_swarm/v1/* is restricted to local listeners', 'forbidden')
      }

      // Extract safe token ID prefix (if present) for audit logging even if later checks fail.
      const rawAuth = req.headers.get('authorization')
      if (rawAuth !== null) {
        const match = /^Bearer\s+(\S+)$/i.exec(rawAuth.trim())
        if (match !== null) {
          const parsed = parseToken(match[1]!)
          if (parsed !== null) attemptedTokenId = parsed.tokenId
        }
      }

      let result: AuthResult
      switch (ctx.listener) {
        case 'uds':
          result = this.#authenticateUds(req)
          break
        case 'pipe':
          result = this.#authenticatePipe(req)
          break
        case 'tcp-loopback':
          result = this.#authenticateLoopback(req, ctx.port ?? this.#loopbackPort)
          break
        case 'tailscale':
          result = this.#authenticateTailscale(req, effectiveTailscaleHost)
          break
        case 'https':
          result = await this.#authenticateHttps(req, ctx, effectiveAllowHosts)
          break
      }

      attemptedPrincipalId = result.caller.principal.id
      checkCallerActor(result.caller)

      this.tokens.recordAudit({
        listener: ctx.listener,
        outcome: 'allow',
        code: null,
        principalId: result.caller.principal.id,
        actorId: result.caller.actor.id,
        assurance: result.caller.principal.assurance ?? null,
        tokenId: result.tokenId,
        method,
        path: pathname,
      })

      return result
    } catch (err) {
      const code = isBoardError(err) ? err.code : 'internal'
      try {
        this.tokens.recordAudit({
          listener: ctx.listener,
          outcome: 'deny',
          code,
          principalId: attemptedPrincipalId,
          actorId: null,
          assurance: null,
          tokenId: attemptedTokenId,
          method,
          path: pathname,
        })
      } catch {
        // Never let audit-log persistence failures mask the underlying auth refusal.
      }
      throw err
    }
  }

  #pruneEphemeral(): void {
    const nowMs = this.#now()
    for (const [key, entry] of this.#loginCodes) {
      if (entry.expiresAtMs <= nowMs) this.#loginCodes.delete(key)
    }
    for (const [key, entry] of this.#sessions) {
      if (entry.expiresAtMs <= nowMs) this.#sessions.delete(key)
    }
  }

  #lookupSession(req: Request): StoredSession | null {
    const sid = extractSessionCookie(req)
    if (sid === null) return null
    const entry = this.#sessions.get(sha256Hex(sid))
    if (entry === undefined) return null
    if (entry.expiresAtMs <= this.#now()) {
      this.#sessions.delete(sha256Hex(sid))
      return null
    }
    return entry
  }

  #buildLocalUdsOrLoopbackCaller(req: Request, ownerAssurance: 'local_unverified' | 'human_verified', verifiedHuman: boolean): CallerContext {
    const prof = parseProfileHeader(req)
    const reqCan = req.headers.get('x-board-can')

    if (prof.present) {
      if (prof.value === null) {
        throw badRequest(
          'x-board-profile cannot be empty: omit the header or specify a valid profile name',
          'invalid_profile',
        )
      }
      const profile = prof.value
      const card =
        this.#boardDir !== null
          ? loadAgentCard(this.#boardDir, profile, { uid: this.#uid, platform: this.#platform })
          : null
      const rawCap = card?.cap ?? DEFAULT_AGENT_CAP
      const cap = card?.allowManage === true ? rawCap : rawCap.filter((p) => p !== 'manage')
      const cardCanHeader = card?.can !== undefined ? compileCanHeader(card.can) : null
      const effectiveCan = narrowCanHeader(cardCanHeader, reqCan)
      const base = createLocalCaller({
        userId: this.#ownerUserId,
        handle: this.#ownerHandle,
        name: this.#ownerName,
        profile,
        owner: false,
        member: !this.#requireExplicitGrants,
        cap,
        assurance: 'agent_delegated',
        verified: false,
        ...(effectiveCan !== null ? { canHeader: effectiveCan } : {}),
      })
      return card?.displayName !== undefined ? { ...base, actor: { ...base.actor, name: card.displayName } } : base
    }

    const effectiveCan = narrowCanHeader(null, reqCan)
    return createLocalCaller({
      userId: this.#ownerUserId,
      handle: this.#ownerHandle,
      name: this.#ownerName,
      profile: null,
      owner: true,
      member: true,
      assurance: ownerAssurance,
      verified: verifiedHuman,
      ...(effectiveCan !== null ? { canHeader: effectiveCan } : {}),
    })
  }

  #callerFromToken(record: TokenRecord, req: Request, listener: ListenerClass): CallerContext {
    const prof = parseProfileHeader(req)
    const reqCan = req.headers.get('x-board-can')
    const effectiveCan = narrowCanHeader(record.canHeader, reqCan)

    const isAgentToken = record.assurance === 'agent_delegated' || record.profile !== null
    const handle = principalHandleOf(record.principalId, this.#ownerHandle)
    const userId = userIdOf(record.principalId, this.#ownerUserId)
    const isLocalOwnerPrincipal = record.principalId === this.#ownerPrincipalId
    const localMember =
      listener !== 'https' && isLocalOwnerPrincipal && !this.#requireExplicitGrants

    if (isAgentToken) {
      if (record.profile === null) {
        throw forbidden('agent token without profile cannot act as a person', 'agent_cannot_impersonate_human')
      }
      if (prof.present) {
        if (prof.value === null) {
          throw forbidden(
            'agent token cannot drop its profile to act as a person',
            'agent_cannot_impersonate_human',
          )
        }
        if (prof.value !== record.profile) {
          throw new BoardError(
            403,
            'profile_mismatch',
            `token is bound to profile "${record.profile}" and cannot act as "${prof.value}"`,
          )
        }
      }
      const actorId = `${record.principalId}+${record.profile}`
      return {
        principal: {
          id: record.principalId,
          kind: 'user',
          handle,
          userId,
          member: localMember,
          owner: false,
          cap: record.cap,
          assurance: 'agent_delegated',
          expiresAt: record.expiresAt,
        },
        actor: {
          id: actorId,
          kind: 'agent',
          handle: `${handle}/${record.profile}`,
          name: record.profile,
          avatar: null,
          via: { name: handle, environment: null },
        },
        profile: record.profile,
        ...(effectiveCan !== null ? { canHeader: effectiveCan } : {}),
      }
    }

    // Human token (profile === null)
    if (prof.present && prof.value !== null) {
      const profile = prof.value
      const actorId = `${record.principalId}+${profile}`
      const agentCap = record.cap.filter((p) => p !== 'manage')
      return {
        principal: {
          id: record.principalId,
          kind: 'user',
          handle,
          userId,
          member: localMember,
          owner: false,
          cap: agentCap,
          assurance: 'agent_delegated',
          expiresAt: record.expiresAt,
        },
        actor: {
          id: actorId,
          kind: 'agent',
          handle: `${handle}/${profile}`,
          name: profile,
          avatar: null,
          via: { name: handle, environment: null },
        },
        profile,
        ...(effectiveCan !== null ? { canHeader: effectiveCan } : {}),
      }
    }

    const isOwner = listener !== 'https' && isLocalOwnerPrincipal
    return {
      principal: {
        id: record.principalId,
        kind: 'user',
        handle,
        userId,
        member: isOwner || localMember,
        owner: isOwner,
        cap: record.cap,
        assurance: record.assurance,
        expiresAt: record.expiresAt,
      },
      actor: {
        id: record.principalId,
        kind: 'person',
        handle,
        name: isLocalOwnerPrincipal ? this.#ownerName : handle,
        avatar: null,
        ...(record.assurance === 'human_verified' ? { verified: true as const } : {}),
      },
      profile: null,
      ...(effectiveCan !== null ? { canHeader: effectiveCan } : {}),
    }
  }

  #authenticateBearerToken(req: Request, bearer: string, listener: ListenerClass): AuthResult {
    const record = this.tokens.verifyToken(bearer, { listener })
    const caller = this.#callerFromToken(record, req, listener)
    return Object.freeze({
      caller,
      listener,
      authMethod: 'bearer-token',
      tokenId: record.id,
      tokenRecord: record,
    })
  }

  #authenticateUds(req: Request): AuthResult {
    const bearer = extractBearer(req)
    if (bearer !== null) {
      return this.#authenticateBearerToken(req, bearer, 'uds')
    }
    if (this.#authEnforce) {
      throw unauthorized('bearer token required on UDS listener when auth.enforce is enabled', 'unauthorized')
    }
    const caller = this.#buildLocalUdsOrLoopbackCaller(req, 'local_unverified', false)
    return Object.freeze({
      caller,
      listener: 'uds',
      authMethod: 'os-user',
      tokenId: null,
      tokenRecord: null,
    })
  }

  #authenticatePipe(req: Request): AuthResult {
    const bearer = extractBearer(req)
    if (bearer === null) {
      throw unauthorized('bearer token is mandatory on named pipe listeners', 'unauthorized')
    }
    return this.#authenticateBearerToken(req, bearer, 'pipe')
  }

  #authenticateLoopback(req: Request, port: number | undefined): AuthResult {
    // Mandatory 4-layer CSRF / DNS-rebinding guards run FIRST, even when auth.enforce=false.
    checkLoopbackGuards(req, { ...(port !== undefined ? { port } : {}) })

    const bearer = extractBearer(req)
    if (bearer !== null) {
      return this.#authenticateBearerToken(req, bearer, 'tcp-loopback')
    }

    const session = this.#lookupSession(req)
    if (session !== null) {
      // Cross-site GET/HEAD requests carrying cookies are also refused on API routes.
      const fetchSite = req.headers.get('sec-fetch-site')?.trim().toLowerCase()
      const fetchMode = req.headers.get('sec-fetch-mode')?.trim().toLowerCase()
      if (fetchSite !== undefined && !ALLOWED_FETCH_SITES.has(fetchSite) && fetchMode !== 'navigate') {
        throw forbidden(`session cookie request rejected: disallowed Sec-Fetch-Site "${fetchSite}"`, 'forbidden', {
          details: { guard: 'sec-fetch-site', reason: 'cross_site' },
        })
      }
      const caller = this.#buildLocalUdsOrLoopbackCaller(req, session.assurance, session.assurance === 'human_verified')
      return Object.freeze({
        caller,
        listener: 'tcp-loopback',
        authMethod: 'session-cookie',
        tokenId: null,
        tokenRecord: null,
      })
    }

    if (this.#authEnforce) {
      throw unauthorized('session cookie or bearer token required on loopback TCP listener', 'unauthorized')
    }

    const caller = this.#buildLocalUdsOrLoopbackCaller(req, 'local_unverified', false)
    return Object.freeze({
      caller,
      listener: 'tcp-loopback',
      authMethod: 'loopback-ui',
      tokenId: null,
      tokenRecord: null,
    })
  }

  #authenticateTailscale(req: Request, tailscaleHost: string | undefined): AuthResult {
    if (tailscaleHost === undefined || tailscaleHost.trim() === '') {
      throw forbidden('tailscale listener requires tailscaleHost configuration', 'forbidden')
    }
    if (!hostMatchesAllowList(req.headers.get('host'), [tailscaleHost], 443)) {
      throw forbidden('Host header does not match configured tailscaleHost', 'forbidden', {
        details: { guard: 'host', listener: 'tailscale' },
      })
    }

    // Reject Tailscale Funnel (public internet) unconditionally.
    const funnel = req.headers.get('tailscale-funnel-request')?.trim().toLowerCase()
    if (funnel !== undefined && funnel !== '' && funnel !== '0' && funnel !== 'false' && funnel !== '?0') {
      throw unauthorized('Tailscale Funnel requests are not accepted', 'unauthorized')
    }

    const rawLogin = req.headers.get('tailscale-user-login')
    if (rawLogin !== null) {
      const login = rawLogin.trim()
      const lower = login.toLowerCase()
      if (
        login === '' ||
        CONTROL_CHARS.test(login) ||
        lower === 'tagged-devices' ||
        lower.startsWith('tag:')
      ) {
        throw unauthorized('Tailscale tagged devices and empty logins are not accepted', 'unauthorized')
      }

      const isOwner = this.#tailscaleOwnerLogin !== undefined && lower === this.#tailscaleOwnerLogin
      const principalId = `tailscale:user:${lower}`
      const displayName = req.headers.get('tailscale-user-name')?.trim() || login
      const prof = parseProfileHeader(req)
      const reqCan = req.headers.get('x-board-can')
      const effectiveCan = narrowCanHeader(null, reqCan)

      if (prof.present) {
        if (prof.value === null) {
          throw badRequest(
            'x-board-profile cannot be empty: omit the header or specify a valid profile name',
            'invalid_profile',
          )
        }
        const profile = prof.value
        const caller: CallerContext = {
          principal: {
            id: principalId,
            kind: 'user',
            handle: lower,
            userId: lower,
            member: isOwner && !this.#requireExplicitGrants,
            owner: false,
            cap: DEFAULT_AGENT_CAP,
            assurance: 'agent_delegated',
          },
          actor: {
            id: `${principalId}+${profile}`,
            kind: 'agent',
            handle: `${lower}/${profile}`,
            name: profile,
            avatar: null,
            via: { name: displayName, environment: 'tailscale' },
          },
          profile,
          ...(effectiveCan !== null ? { canHeader: effectiveCan } : {}),
        }
        return Object.freeze({
          caller,
          listener: 'tailscale',
          authMethod: 'tailscale',
          tokenId: null,
          tokenRecord: null,
        })
      }

      const assurance: Assurance = isOwner ? 'human_verified' : 'local_unverified'
      const caller: CallerContext = {
        principal: {
          id: principalId,
          kind: 'user',
          handle: lower,
          userId: lower,
          member: isOwner,
          owner: isOwner,
          assurance,
        },
        actor: {
          id: principalId,
          kind: 'person',
          handle: lower,
          name: displayName,
          avatar: null,
          ...(isOwner ? { verified: true as const } : {}),
        },
        profile: null,
        ...(effectiveCan !== null ? { canHeader: effectiveCan } : {}),
      }
      return Object.freeze({
        caller,
        listener: 'tailscale',
        authMethod: 'tailscale',
        tokenId: null,
        tokenRecord: null,
      })
    }

    const bearer = extractBearer(req)
    if (bearer !== null) {
      return this.#authenticateBearerToken(req, bearer, 'tailscale')
    }

    throw unauthorized('Tailscale-User-Login or bearer token required', 'unauthorized')
  }

  async #authenticateHttps(
    req: Request,
    ctx: ListenerContext,
    allowHosts: readonly string[] | undefined,
  ): Promise<AuthResult> {
    const rawHost = req.headers.get('host')
    if (rawHost === null || parseHostHeader(rawHost) === null) {
      throw forbidden('https listener requires a valid Host header', 'forbidden', {
        details: { guard: 'host', listener: 'https' },
      })
    }
    const boardUrl = ctx.boardUrl ?? this.#boardUrl
    const hostList: string[] = []
    if (allowHosts !== undefined && allowHosts.length > 0) {
      hostList.push(...allowHosts)
    } else if (boardUrl !== undefined) {
      try {
        hostList.push(new URL(boardUrl).host)
      } catch {
        throw forbidden('invalid boardUrl configuration for https listener', 'forbidden')
      }
    }
    if (hostList.length > 0 && !hostMatchesAllowList(rawHost, hostList, 443)) {
      throw forbidden('Host header is not on the https allow-list', 'forbidden', {
        details: { guard: 'host', listener: 'https' },
      })
    }

    const bearer = extractBearer(req)
    if (bearer === null) {
      throw unauthorized('Authorization: Bearer token or OIDC JWT required on https listener', 'unauthorized')
    }

    if (bearer.startsWith('sb_')) {
      return this.#authenticateBearerToken(req, bearer, 'https')
    }

    // Remote Mode 4 OIDC JWT verification via jose.
    return this.#authenticateOidc(req, bearer, boardUrl)
  }

  #resolveOidcVerifier(issuerCfg: OidcIssuerConfig): CryptoKey | KeyObject | Uint8Array | JWTVerifyGetKey {
    const cached = this.#oidcKeyCache.get(issuerCfg.issuer)
    if (cached !== undefined) return cached
    let verifier: CryptoKey | KeyObject | Uint8Array | JWTVerifyGetKey
    if (issuerCfg.key !== undefined) {
      verifier = issuerCfg.key
    } else if (issuerCfg.jwks !== undefined) {
      verifier = createLocalJWKSet(issuerCfg.jwks)
    } else if (issuerCfg.jwksUri !== undefined) {
      verifier = createRemoteJWKSet(new URL(issuerCfg.jwksUri))
    } else {
      throw unauthorized(`OIDC issuer "${issuerCfg.issuer}" has no key or JWKS configured`, 'unauthorized')
    }
    this.#oidcKeyCache.set(issuerCfg.issuer, verifier)
    return verifier
  }

  async #authenticateOidc(req: Request, jwt: string, boardUrl: string | undefined): Promise<AuthResult> {
    const oidc = this.#oidc
    if (oidc === undefined || oidc.issuers.length === 0) {
      throw unauthorized('OIDC authentication is not configured on this listener', 'unauthorized')
    }
    const expectedAudience = boardUrl ?? oidc.audience
    if (expectedAudience === undefined || expectedAudience.trim() === '') {
      throw unauthorized('OIDC audience (boardUrl) is not configured', 'unauthorized')
    }

    let unverified: JWTPayload
    try {
      unverified = decodeJwt(jwt)
    } catch {
      throw unauthorized('invalid OIDC JWT', 'unauthorized')
    }

    const iss = typeof unverified.iss === 'string' ? unverified.iss : null
    if (iss === null) {
      throw unauthorized('OIDC JWT is missing iss claim', 'unauthorized')
    }
    const issuerCfg = oidc.issuers.find((cfg) => cfg.issuer === iss)
    if (issuerCfg === undefined) {
      throw unauthorized(`untrusted OIDC issuer "${iss}"`, 'unauthorized')
    }

    const verifier = this.#resolveOidcVerifier(issuerCfg)
    let payload: JWTPayload
    try {
      const currentDate = new Date(this.#now())
      const verified =
        typeof verifier === 'function'
          ? await jwtVerify(jwt, verifier, { issuer: issuerCfg.issuer, audience: expectedAudience, currentDate })
          : await jwtVerify(jwt, verifier, { issuer: issuerCfg.issuer, audience: expectedAudience, currentDate })
      payload = verified.payload
    } catch {
      throw unauthorized('OIDC JWT verification failed', 'unauthorized')
    }

    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : ''
    if (sub === '' || CONTROL_CHARS.test(sub)) {
      throw unauthorized('OIDC JWT is missing a valid sub claim', 'unauthorized')
    }

    const principalId = `oidc:${issuerCfg.issuer}:${sub}`
    const email = typeof payload.email === 'string' ? payload.email : undefined
    const nameClaim = typeof payload.name === 'string' ? payload.name : undefined
    const preferredHandle = sanitizeOsUser(email ?? nameClaim ?? sub)
    const prof = parseProfileHeader(req)
    if (prof.present && prof.value === null) {
      throw badRequest(
        'x-board-profile cannot be empty: omit the header or specify a valid profile name',
        'invalid_profile',
      )
    }
    const reqCan = req.headers.get('x-board-can')
    const effectiveCan = narrowCanHeader(null, reqCan)
    const claims: Readonly<Record<string, unknown>> = Object.freeze({ ...payload })

    if (issuerCfg.kind === 'human' && !prof.present) {
      const caller: CallerContext = {
        principal: {
          id: principalId,
          kind: 'oidc',
          handle: preferredHandle,
          issuer: issuerCfg.issuer,
          claims,
          member: false,
          owner: false,
          assurance: 'human_verified',
          expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null,
        },
        actor: {
          id: principalId,
          kind: 'person',
          handle: preferredHandle,
          name: nameClaim ?? email ?? preferredHandle,
          avatar: null,
          verified: true,
        },
        profile: null,
        ...(effectiveCan !== null ? { canHeader: effectiveCan } : {}),
      }
      return Object.freeze({
        caller,
        listener: 'https',
        authMethod: 'oidc',
        tokenId: null,
        tokenRecord: null,
      })
    }

    const rawProfile = prof.present && prof.value !== null ? prof.value : (issuerCfg.defaultProfile ?? 'oidc')
    if (!isValidProfile(rawProfile)) {
      throw badRequest('invalid OIDC agent profile', 'invalid_profile')
    }
    const caller: CallerContext = {
      principal: {
        id: principalId,
        kind: 'oidc',
        handle: preferredHandle,
        issuer: issuerCfg.issuer,
        claims,
        member: false,
        owner: false,
        assurance: 'agent_delegated',
        expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null,
      },
      actor: {
        id: `${principalId}+${rawProfile}`,
        kind: 'agent',
        handle: `${preferredHandle}/${rawProfile}`,
        name: rawProfile,
        avatar: null,
        via: { name: preferredHandle, environment: 'oidc' },
      },
      profile: rawProfile,
      ...(effectiveCan !== null ? { canHeader: effectiveCan } : {}),
    }
    return Object.freeze({
      caller,
      listener: 'https',
      authMethod: 'oidc',
      tokenId: null,
      tokenRecord: null,
    })
  }
}

/** Convenience factory for `Authenticator`. */
export function createAuthenticator(config: AuthenticatorConfig): Authenticator {
  return new Authenticator(config)
}
