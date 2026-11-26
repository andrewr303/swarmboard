// HOST-8: Hashed auth_tokens store, delegation narrowing, and auth_audit_log (Swarmboard v2 launch design §4.1).
//
// Token wire format: `sb_<12-char base32 id>_<43-char base64url secret>`.
// - Only `sha256(secret)` is persisted in `auth_tokens.secret_hash`; plaintext is returned ONCE at issuance.
// - Verification uses `crypto.timingSafeEqual` over 32-byte SHA-256 digests (including a dummy compare on misses).
// - Delegation enforces: live parent, `delegation_depth < 4`, `cap_child ⊆ cap_parent`,
//   `can_child = narrow(parent.can, req.can)` (disjoint intersection -> `*=`, never null),
//   `listenerScope` non-widening, `ttlS <= min(parentRemainingS, 43200)`, and `agent_cannot_impersonate_human`.
// - Audit rows record ONLY `token_id` (`sb_<12-char>`), never secrets or query strings.
//
// Pure over node:crypto, ../core/public.ts, and ./local.ts (no internal barrel imports, no core error
// normalizers, no stdio logging, no process-spawning or networking modules).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  badRequest,
  compileAccess,
  expandPermissions,
  forbidden,
  headerCan,
  notFound,
  PERMISSIONS,
  unauthorized,
  writtenCan,
  type AccessSummary,
  type Assurance,
  type CallerContext,
  type CanSpec,
  type Permission,
  type StorageBackend,
} from '../../core/public.ts'
import { DEFAULT_AGENT_CAP, isValidProfile } from './local.ts'

export const TOKEN_PREFIX = 'sb_'
export const MAX_DELEGATION_DEPTH = 4
export const DEFAULT_AGENT_TTL_S = 43_200
export const MAX_DELEGATED_TTL_S = 43_200

export type ListenerScope = 'local' | 'lan' | 'remote'
export type TokenListenerClass = 'uds' | 'pipe' | 'tcp-loopback' | 'tailscale' | 'https'

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const TOKEN_ID_BARE = /^[a-z2-7]{12}$/
const TOKEN_ID_FULL = /^sb_[a-z2-7]{12}$/
const TOKEN_WIRE = /^(sb_[a-z2-7]{12})_([A-Za-z0-9_-]{43})$/
const TOKEN_WIRE_GLOBAL = /(?<![A-Za-z0-9_-])(sb_[a-z2-7]{12})_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g
const HEX_SHA256 = /^[0-9a-f]{64}$/
const DUMMY_HASH_BUF = createHash('sha256').update('swarmboard-dummy-token-secret').digest()

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS)
const PERM_INDEX = new Map<Permission, number>(PERMISSIONS.map((p, i) => [p, i]))

const SCOPE_RANK: Readonly<Record<ListenerScope, number>> = Object.freeze({
  local: 0,
  lan: 1,
  remote: 2,
})

const VALID_SCOPES: ReadonlySet<string> = new Set(['local', 'lan', 'remote'])
const VALID_ASSURANCES: ReadonlySet<string> = new Set(['human_verified', 'agent_delegated', 'local_unverified'])

export interface TokenRecord {
  readonly id: string
  readonly principalId: string
  readonly profile: string | null
  readonly assurance: Assurance
  readonly cap: readonly Permission[]
  readonly canHeader: string | null
  readonly listenerScope: ListenerScope
  readonly delegationDepth: number
  readonly issuedBy: string
  readonly note: string | null
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly revokedAt: string | null
  readonly lastUsedAt: string | null
}

export interface IssuedToken {
  /** Plaintext bearer token (`sb_<12-char>_<43-char>`). Returned ONCE; never persisted or logged. */
  readonly token: string
  readonly record: TokenRecord
}

export type TokenIssuer =
  | { readonly kind: 'caller'; readonly caller: CallerContext }
  | { readonly kind: 'token'; readonly token: TokenRecord }
  | CallerContext

export interface IssueTokenRequest {
  /** Target principal ID (defaults to issuer's principal; delegated tokens cannot change principal). */
  readonly principalId?: string
  /** Target agent profile (required non-null for agent tokens; `null` only for human/owner tokens). */
  readonly profile?: string | null
  /** Requested assurance level (agents cannot request `human_verified` or `local_unverified`). */
  readonly assurance?: Assurance
  /** Attempted owner flag (agents setting `owner: true` are rejected with `403 agent_cannot_impersonate_human`). */
  readonly owner?: boolean
  /** Permission cap (defaults to parent's cap for delegated tokens, or `DEFAULT_AGENT_CAP` for root agent tokens). */
  readonly cap?: readonly Permission[]
  /** Optional channel narrowing (`x-board-can` header string or `CanSpec` object). */
  readonly can?: CanSpec | string | null
  /** Listener reach (`'local' | 'lan' | 'remote'`; cannot widen parent's scope). */
  readonly listenerScope?: ListenerScope
  /** Lifetime in seconds (default 43200 = 12 h; delegated children bounded by `min(parentRemainingS, 43200)`). */
  readonly ttlS?: number | null
  /** Optional human-readable label/note (max 240 chars). */
  readonly note?: string | null
}

export interface VerifyTokenOptions {
  readonly listener?: TokenListenerClass
  readonly touchLastUsed?: boolean
}

export interface ListTokensFilter {
  readonly principalId?: string
  readonly includeRevoked?: boolean
  readonly includeExpired?: boolean
  readonly limit?: number
}

export interface AuthAuditInput {
  readonly listener: string
  readonly outcome: 'allow' | 'deny'
  readonly code?: string | null
  readonly principalId?: string | null
  readonly actorId?: string | null
  readonly assurance?: string | null
  readonly tokenId?: string | null
  readonly method: string
  readonly path: string
}

export interface AuthAuditEntry {
  readonly id: number
  readonly ts: string
  readonly listener: string
  readonly outcome: 'allow' | 'deny'
  readonly code: string | null
  readonly principalId: string | null
  readonly actorId: string | null
  readonly assurance: string | null
  readonly tokenId: string | null
  readonly method: string
  readonly path: string
}

export interface ListAuditFilter {
  readonly listener?: string
  readonly outcome?: 'allow' | 'deny'
  readonly tokenId?: string
  readonly principalId?: string
  readonly limit?: number
}

interface RawTokenRow {
  id: string
  secret_hash: string
  principal_id: string
  profile: string | null
  assurance: string
  cap_json: string
  can_header: string | null
  listener_scope: string
  delegation_depth: number
  issued_by: string
  note: string | null
  created_at: string
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
}

interface RawAuditRow {
  id: number
  ts: string
  listener: string
  outcome: string
  code: string | null
  principal_id: string | null
  actor_id: string | null
  assurance: string | null
  token_id: string | null
  method: string
  path: string
}

/** Parses `sb_<12-char base32>_<43-char base64url>` into `{ tokenId, secret }`, or `null` if malformed. */
export function parseToken(raw: string): { readonly tokenId: string; readonly secret: string } | null {
  if (typeof raw !== 'string') return null
  const match = TOKEN_WIRE.exec(raw)
  if (match === null) return null
  return Object.freeze({ tokenId: match[1]!, secret: match[2]! })
}

/** Normalizes either `sb_<12-char>` or bare `<12-char>` into `sb_<12-char>`, or `null` if invalid. */
export function normalizeTokenId(id: string): string | null {
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  if (TOKEN_ID_FULL.test(trimmed)) return trimmed
  if (TOKEN_ID_BARE.test(trimmed)) return `${TOKEN_PREFIX}${trimmed}`
  return null
}

/** Computes the 64-char lowercase SHA-256 hex digest stored in `auth_tokens.secret_hash`. */
export function hashTokenSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** Replaces any `sb_<id>_<secret>` occurrence in text with `sb_<id>_[redacted]`. */
export function redactTokens(text: string): string {
  return text.replace(TOKEN_WIRE_GLOBAL, '$1_[redacted]')
}

/** True when a token with `tokenScope` may be used on `listener`. */
export function isListenerScopeAllowed(tokenScope: ListenerScope, listener: TokenListenerClass): boolean {
  switch (listener) {
    case 'uds':
    case 'pipe':
    case 'tcp-loopback':
      return true
    case 'tailscale':
      return tokenScope === 'lan' || tokenScope === 'remote'
    case 'https':
      return tokenScope === 'remote'
  }
}

function generateTokenPair(): { readonly id: string; readonly secret: string; readonly wire: string; readonly hash: string } {
  const idBytes = randomBytes(12)
  let bareId = ''
  for (let i = 0; i < 12; i += 1) {
    bareId += BASE32_ALPHABET[idBytes[i]! & 31]!
  }
  const id = `${TOKEN_PREFIX}${bareId}`
  const secret = randomBytes(32).toString('base64url')
  const wire = `${id}_${secret}`
  const hash = hashTokenSecret(secret)
  return { id, secret, wire, hash }
}

function serializeSummary(summary: AccessSummary): string {
  const entries = Object.entries(summary)
  if (entries.length === 0) {
    // Disjoint narrowing MUST fail closed to explicit empty wildcard rather than null (unrestricted).
    return '*='
  }
  const parts = entries.map(([pattern, perms]) => `${pattern}=${perms.join(',')}`)
  const out = parts.join(';')
  // Verify compiled header respects CAN_MAX and headerCan grammar.
  headerCan(out)
  return out
}

function parseReqCan(reqCan: CanSpec | string): CanSpec {
  if (reqCan === 'all') return 'all'
  if (typeof reqCan === 'string') {
    return headerCan(reqCan)
  }
  if (Array.isArray(reqCan)) {
    expandPermissions(reqCan)
    return reqCan
  }
  return writtenCan(reqCan)
}

/**
 * Intersects `parentCanHeader` and an optional requested `reqCan` (`CanSpec` or `x-board-can` string).
 * Never widens: if both are present and disjoint, returns `'*='` (zero access), never `null`.
 */
export function narrowCanHeader(
  parentCanHeader: string | null,
  reqCan?: CanSpec | string | null,
): string | null {
  const hasParent = parentCanHeader !== null && parentCanHeader !== ''
  const hasReq = reqCan !== undefined && reqCan !== null && reqCan !== ''
  if (!hasParent && !hasReq) return null
  if (hasParent && !hasReq) {
    const parentCompiled = compileAccess(headerCan(parentCanHeader))
    return serializeSummary(parentCompiled.summary())
  }
  const reqSpec = parseReqCan(reqCan!)
  if (!hasParent) {
    const reqCompiled = compileAccess(reqSpec)
    return serializeSummary(reqCompiled.summary())
  }
  const narrowed = compileAccess(headerCan(parentCanHeader)).narrow(compileAccess(reqSpec))
  return serializeSummary(narrowed.summary())
}

function validateCapList(raw: readonly Permission[]): readonly Permission[] {
  if (!Array.isArray(raw)) {
    throw badRequest('cap must be an array of permissions', 'invalid_request')
  }
  const out = new Set<Permission>()
  for (const p of raw) {
    if (typeof p !== 'string' || !PERMISSION_SET.has(p)) {
      throw badRequest(`unknown permission "${String(p)}" in cap`, 'invalid_can')
    }
    out.add(p as Permission)
  }
  return Object.freeze([...out].sort((a, b) => PERM_INDEX.get(a)! - PERM_INDEX.get(b)!))
}

function isCapSubset(child: readonly Permission[], parent: readonly Permission[]): boolean {
  const parentExpanded = expandPermissions(parent)
  const childExpanded = expandPermissions(child)
  for (const perm of childExpanded) {
    if (!parentExpanded.has(perm)) return false
  }
  return true
}

function parseStoredCap(capJson: string): readonly Permission[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(capJson)
  } catch {
    throw unauthorized('corrupted token capability record', 'unauthorized')
  }
  if (!Array.isArray(parsed)) {
    throw unauthorized('corrupted token capability record', 'unauthorized')
  }
  const out: Permission[] = []
  for (const item of parsed) {
    if (typeof item !== 'string' || !PERMISSION_SET.has(item)) {
      throw unauthorized('corrupted token capability record', 'unauthorized')
    }
    out.push(item as Permission)
  }
  return Object.freeze(out)
}

function rowToRecord(row: RawTokenRow): TokenRecord {
  if (!VALID_ASSURANCES.has(row.assurance) || !VALID_SCOPES.has(row.listener_scope)) {
    throw unauthorized('corrupted token record', 'unauthorized')
  }
  return Object.freeze({
    id: row.id,
    principalId: row.principal_id,
    profile: row.profile,
    assurance: row.assurance as Assurance,
    cap: parseStoredCap(row.cap_json),
    canHeader: row.can_header,
    listenerScope: row.listener_scope as ListenerScope,
    delegationDepth: Number(row.delegation_depth),
    issuedBy: row.issued_by,
    note: row.note,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  })
}

function isCallerContext(issuer: TokenIssuer): issuer is CallerContext {
  return 'principal' in issuer && 'actor' in issuer
}

function sanitizeAuditPath(rawPath: string): string {
  const qIdx = rawPath.indexOf('?')
  const hIdx = rawPath.indexOf('#')
  let end = rawPath.length
  if (qIdx >= 0 && qIdx < end) end = qIdx
  if (hIdx >= 0 && hIdx < end) end = hIdx
  const clean = redactTokens(rawPath.slice(0, end)).replace(/[\u0000-\u001f\u007f]/g, '')
  return clean.slice(0, 512) || '/'
}

function sanitizeAuditTokenId(rawTokenId: string | null | undefined): string | null {
  if (rawTokenId == null) return null
  if (TOKEN_ID_FULL.test(rawTokenId)) return rawTokenId
  const parsed = parseToken(rawTokenId)
  return parsed !== null ? parsed.tokenId : null
}

/**
 * SQLite-backed store for HOST-8 hashed `auth_tokens` and `auth_audit_log`.
 */
export class TokenStore {
  readonly #store: StorageBackend
  readonly #now: () => number

  constructor(store: StorageBackend, opts: { readonly now?: () => number } = {}) {
    this.#store = store
    this.#now = opts.now ?? (() => Date.now())
  }

  /**
   * Issues a new hashed bearer token, enforcing delegation depth, cap subset, channel narrowing,
   * TTL bounds, listener scope non-widening, and `agent_cannot_impersonate_human`.
   */
  issueToken(issuer: TokenIssuer, req: IssueTokenRequest = {}): IssuedToken {
    if (req.note !== undefined && req.note !== null) {
      if (typeof req.note !== 'string' || req.note.length > 240 || req.note.includes('\u0000')) {
        throw badRequest('note must be a string up to 240 characters', 'invalid_request')
      }
    }
    if (req.listenerScope !== undefined && !VALID_SCOPES.has(req.listenerScope)) {
      throw badRequest('listenerScope must be local, lan, or remote', 'invalid_request')
    }
    if (req.assurance !== undefined && !VALID_ASSURANCES.has(req.assurance)) {
      throw badRequest('invalid assurance level', 'invalid_request')
    }

    const normalizedIssuer:
      | { readonly kind: 'caller'; readonly caller: CallerContext }
      | { readonly kind: 'token'; readonly token: TokenRecord } = isCallerContext(issuer)
      ? { kind: 'caller', caller: issuer }
      : issuer

    return this.#store.transaction(() => {
      const nowMs = this.#now()
      const nowIso = new Date(nowMs).toISOString()

      let principalId: string
      let profile: string | null
      let assurance: Assurance
      let cap: readonly Permission[]
      let canHeader: string | null
      let listenerScope: ListenerScope
      let delegationDepth: number
      let issuedBy: string
      let expiresAt: string | null

      if (normalizedIssuer.kind === 'token') {
        // Re-read parent token under the transaction lock to prevent revoked/expired parents from delegating.
        const parentRow = this.#store.db
          .prepare('SELECT * FROM auth_tokens WHERE id = ?')
          .get(normalizedIssuer.token.id) as RawTokenRow | undefined
        if (parentRow === undefined) {
          throw unauthorized('parent token not found', 'unauthorized')
        }
        const parent = rowToRecord(parentRow)
        if (parent.revokedAt !== null) {
          throw unauthorized('parent token has been revoked', 'token_revoked')
        }
        if (parent.expiresAt !== null && Date.parse(parent.expiresAt) <= nowMs) {
          throw unauthorized('parent token has expired', 'token_expired')
        }

        const parentIsAgent = parent.assurance === 'agent_delegated' || parent.profile !== null
        if (parentIsAgent) {
          if (
            req.owner === true ||
            req.profile === null ||
            req.assurance === 'human_verified' ||
            req.assurance === 'local_unverified'
          ) {
            throw forbidden(
              'an agent token cannot mint a human, owner, or profile-less token',
              'agent_cannot_impersonate_human',
            )
          }
        } else if (req.assurance === 'human_verified' && parent.assurance !== 'human_verified') {
          throw forbidden(
            'cannot mint a human_verified token from a non-human_verified parent token',
            'human_verification_required',
          )
        }

        if (parent.delegationDepth >= MAX_DELEGATION_DEPTH) {
          throw badRequest(
            `maximum token delegation depth (${MAX_DELEGATION_DEPTH}) reached`,
            'max_delegation_depth',
          )
        }

        if (req.principalId !== undefined && req.principalId !== parent.principalId) {
          throw forbidden('delegated token cannot target a different principal')
        }
        principalId = parent.principalId

        if (parentIsAgent) {
          const targetProfile = req.profile === undefined ? parent.profile : req.profile
          if (targetProfile === null) {
            throw forbidden(
              'an agent token cannot mint a profile-less token',
              'agent_cannot_impersonate_human',
            )
          }
          if (!isValidProfile(targetProfile)) {
            throw badRequest('invalid profile name', 'invalid_profile')
          }
          profile = targetProfile
          assurance = 'agent_delegated'
        } else {
          if (req.profile !== undefined && req.profile !== null) {
            if (!isValidProfile(req.profile)) {
              throw badRequest('invalid profile name', 'invalid_profile')
            }
            profile = req.profile
            assurance = 'agent_delegated'
          } else {
            profile = null
            assurance = req.assurance ?? parent.assurance
          }
        }

        const requestedCap = req.cap !== undefined ? validateCapList(req.cap) : parent.cap
        if (!isCapSubset(requestedCap, parent.cap)) {
          throw forbidden('delegated token cap must be a subset of parent token cap')
        }
        cap = requestedCap

        canHeader = narrowCanHeader(parent.canHeader, req.can)

        const requestedScope = req.listenerScope ?? parent.listenerScope
        if (SCOPE_RANK[requestedScope] > SCOPE_RANK[parent.listenerScope]) {
          throw forbidden(
            `delegated token scope "${requestedScope}" cannot widen parent scope "${parent.listenerScope}"`,
          )
        }
        listenerScope = requestedScope

        const parentRemainingS =
          parent.expiresAt !== null
            ? Math.floor((Date.parse(parent.expiresAt) - nowMs) / 1000)
            : MAX_DELEGATED_TTL_S
        if (parentRemainingS <= 0) {
          throw unauthorized('parent token has expired', 'token_expired')
        }
        const maxChildTtlS = Math.min(parentRemainingS, MAX_DELEGATED_TTL_S)
        let ttlS: number
        if (req.ttlS === undefined) {
          ttlS = maxChildTtlS
        } else if (req.ttlS === null) {
          throw forbidden('delegated token must have a bounded TTL')
        } else if (typeof req.ttlS !== 'number' || !Number.isFinite(req.ttlS) || req.ttlS <= 0) {
          throw badRequest('ttlS must be a positive number of seconds', 'invalid_request')
        } else {
          if (req.ttlS > maxChildTtlS) {
            throw forbidden(
              `delegated token ttlS (${req.ttlS}s) exceeds allowed bound (${maxChildTtlS}s)`,
            )
          }
          ttlS = Math.floor(req.ttlS)
          if (ttlS <= 0) {
            throw badRequest('ttlS must be at least 1 second', 'invalid_request')
          }
        }
        expiresAt = new Date(nowMs + ttlS * 1000).toISOString()
        delegationDepth = parent.delegationDepth + 1
        issuedBy = parent.id
      } else {
        // Root issuance by a CallerContext (human / owner).
        const caller = normalizedIssuer.caller
        const callerIsAgent = caller.principal.assurance === 'agent_delegated' || caller.actor.kind === 'agent'
        if (callerIsAgent) {
          if (
            req.owner === true ||
            req.profile === null ||
            req.assurance === 'human_verified' ||
            req.assurance === 'local_unverified'
          ) {
            throw forbidden(
              'an agent caller cannot mint a human, owner, or profile-less token',
              'agent_cannot_impersonate_human',
            )
          }
          throw forbidden('only a board owner/human or an existing token may issue tokens')
        }
        if (caller.principal.owner !== true && caller.actor.kind !== 'person') {
          throw forbidden('only a board owner or human principal may issue root tokens')
        }
        if (caller.principal.owner !== true && req.owner === true) {
          throw forbidden('only a board owner may mint an owner-privileged token')
        }
        if (
          caller.principal.owner !== true &&
          req.principalId !== undefined &&
          req.principalId !== caller.principal.id
        ) {
          throw forbidden('only a board owner may issue tokens for another principal')
        }

        principalId = req.principalId ?? caller.principal.id
        if (typeof principalId !== 'string' || principalId.trim() === '') {
          throw badRequest('principalId must be a non-empty string', 'invalid_request')
        }

        if (req.profile !== undefined && req.profile !== null) {
          if (!isValidProfile(req.profile)) {
            throw badRequest('invalid profile name', 'invalid_profile')
          }
          if (req.owner === true || req.assurance === 'human_verified' || req.assurance === 'local_unverified') {
            throw forbidden(
              'an agent token cannot have owner privileges or human assurance',
              'agent_cannot_impersonate_human',
            )
          }
          profile = req.profile
          assurance = 'agent_delegated'
        } else {
          profile = null
          const targetAssurance = req.assurance ?? caller.principal.assurance ?? 'local_unverified'
          if (targetAssurance === 'agent_delegated') {
            throw forbidden(
              'an agent_delegated token requires a non-null profile',
              'agent_cannot_impersonate_human',
            )
          }
          if (targetAssurance === 'human_verified' && caller.principal.assurance !== 'human_verified') {
            throw forbidden(
              'cannot mint a human_verified token without human_verified assurance',
              'human_verification_required',
            )
          }
          assurance = targetAssurance
        }

        const defaultCap = profile !== null ? DEFAULT_AGENT_CAP : PERMISSIONS
        const requestedCap = req.cap !== undefined ? validateCapList(req.cap) : defaultCap
        if (caller.principal.cap !== undefined && !isCapSubset(requestedCap, caller.principal.cap)) {
          throw forbidden('issued token cap must be a subset of issuer cap')
        }
        cap = requestedCap

        canHeader = narrowCanHeader(caller.canHeader ?? null, req.can)
        listenerScope = req.listenerScope ?? 'local'

        if (req.ttlS === null) {
          if (profile !== null) {
            throw badRequest('agent tokens must have a bounded ttlS', 'invalid_request')
          }
          expiresAt = null
        } else {
          const ttl = req.ttlS === undefined ? DEFAULT_AGENT_TTL_S : req.ttlS
          if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 1) {
            throw badRequest('ttlS must be a positive number of seconds', 'invalid_request')
          }
          expiresAt = new Date(nowMs + Math.floor(ttl) * 1000).toISOString()
        }

        delegationDepth = 0
        issuedBy = caller.actor.id
      }

      const generated = generateTokenPair()
      const capJson = JSON.stringify(cap)
      const note = req.note ?? null

      this.#store.db
        .prepare(
          `INSERT INTO auth_tokens (
            id, secret_hash, principal_id, profile, assurance, cap_json, can_header,
            listener_scope, delegation_depth, issued_by, note, created_at, expires_at, revoked_at, last_used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          generated.id,
          generated.hash,
          principalId,
          profile,
          assurance,
          capJson,
          canHeader,
          listenerScope,
          delegationDepth,
          issuedBy,
          note,
          nowIso,
          expiresAt,
        )

      const record: TokenRecord = Object.freeze({
        id: generated.id,
        principalId,
        profile,
        assurance,
        cap,
        canHeader,
        listenerScope,
        delegationDepth,
        issuedBy,
        note,
        createdAt: nowIso,
        expiresAt,
        revokedAt: null,
        lastUsedAt: null,
      })

      return Object.freeze({ token: generated.wire, record })
    })
  }

  /**
   * Verifies a plaintext bearer token against its SHA-256 hash using `crypto.timingSafeEqual`,
   * enforcing revocation, expiry, and optional listener scope.
   */
  verifyToken(rawToken: string, opts: VerifyTokenOptions = {}): TokenRecord {
    const parsed = parseToken(rawToken)
    if (parsed === null) {
      throw unauthorized('invalid bearer token format', 'unauthorized')
    }

    const candidateBuf = createHash('sha256').update(parsed.secret, 'utf8').digest()
    const row = this.#store.db
      .prepare('SELECT * FROM auth_tokens WHERE id = ?')
      .get(parsed.tokenId) as RawTokenRow | undefined

    if (row === undefined || !HEX_SHA256.test(row.secret_hash)) {
      timingSafeEqual(candidateBuf, DUMMY_HASH_BUF)
      throw unauthorized('invalid bearer token', 'unauthorized')
    }

    const storedBuf = Buffer.from(row.secret_hash, 'hex')
    const matched = storedBuf.length === candidateBuf.length && timingSafeEqual(candidateBuf, storedBuf)
    if (!matched) {
      throw unauthorized('invalid bearer token', 'unauthorized')
    }

    const record = rowToRecord(row)
    if (record.revokedAt !== null) {
      throw unauthorized('bearer token has been revoked', 'token_revoked')
    }

    const nowMs = this.#now()
    if (record.expiresAt !== null && Date.parse(record.expiresAt) <= nowMs) {
      throw unauthorized('bearer token has expired', 'token_expired')
    }

    if (opts.listener !== undefined && !isListenerScopeAllowed(record.listenerScope, opts.listener)) {
      throw forbidden(
        `token scope "${record.listenerScope}" is not permitted on listener "${opts.listener}"`,
        'forbidden',
        { details: { tokenScope: record.listenerScope, listener: opts.listener } },
      )
    }

    const shouldTouch = opts.touchLastUsed !== false && (this.#store.writeRefusal?.() ?? null) === null
    if (shouldTouch) {
      const nowIso = new Date(nowMs).toISOString()
      this.#store.db.prepare('UPDATE auth_tokens SET last_used_at = ? WHERE id = ?').run(nowIso, record.id)
      return Object.freeze({ ...record, lastUsedAt: nowIso })
    }

    return record
  }

  /** Fetches token metadata by id (`sb_<12-char>` or bare `<12-char>`). Never returns secret_hash. */
  getToken(id: string): TokenRecord | null {
    const normalized = normalizeTokenId(id)
    if (normalized === null) return null
    const row = this.#store.db.prepare('SELECT * FROM auth_tokens WHERE id = ?').get(normalized) as
      | RawTokenRow
      | undefined
    return row !== undefined ? rowToRecord(row) : null
  }

  /** Lists token metadata rows. Never returns secret_hash. */
  listTokens(filter: ListTokensFilter = {}): TokenRecord[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.principalId !== undefined) {
      where.push('principal_id = ?')
      params.push(filter.principalId)
    }
    if (filter.includeRevoked !== true) {
      where.push('revoked_at IS NULL')
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000))
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.#store.db
      .prepare(`SELECT * FROM auth_tokens ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as unknown as RawTokenRow[]

    const nowMs = this.#now()
    const out: TokenRecord[] = []
    for (const row of rows) {
      const rec = rowToRecord(row)
      if (filter.includeExpired !== true && rec.expiresAt !== null && Date.parse(rec.expiresAt) <= nowMs) {
        continue
      }
      out.push(rec)
    }
    return out
  }

  /** Revokes a token by ID. Throws `404 token_not_found` if absent. */
  revokeToken(id: string, opts?: { readonly actor?: CallerContext | TokenRecord }): TokenRecord {
    const normalized = normalizeTokenId(id)
    if (normalized === null) {
      throw notFound(`token not found: ${redactTokens(id)}`, 'token_not_found')
    }

    return this.#store.transaction(() => {
      const row = this.#store.db.prepare('SELECT * FROM auth_tokens WHERE id = ?').get(normalized) as
        | RawTokenRow
        | undefined
      if (row === undefined) {
        throw notFound(`token not found: ${normalized}`, 'token_not_found')
      }
      const existing = rowToRecord(row)

      if (opts?.actor !== undefined) {
        const actor = opts.actor
        if ('principal' in actor) {
          const allowed =
            actor.principal.owner === true ||
            existing.issuedBy === actor.actor.id ||
            (actor.actor.kind === 'person' && existing.principalId === actor.principal.id)
          if (!allowed) {
            throw forbidden('not permitted to revoke this token')
          }
        } else {
          const allowed = existing.id === actor.id || existing.issuedBy === actor.id
          if (!allowed) {
            throw forbidden('not permitted to revoke this token')
          }
        }
      }

      if (existing.revokedAt !== null) return existing
      const nowIso = new Date(this.#now()).toISOString()
      this.#store.db
        .prepare('UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(nowIso, normalized)
      return Object.freeze({ ...existing, revokedAt: nowIso })
    })
  }

  /** Revokes every active token belonging to `principalId`. Returns number of tokens revoked. */
  revokeByPrincipal(principalId: string): number {
    return this.#store.transaction(() => {
      const nowIso = new Date(this.#now()).toISOString()
      const result = this.#store.db
        .prepare('UPDATE auth_tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL')
        .run(nowIso, principalId)
      return Number(result.changes)
    })
  }

  /** Removes expired/revoked tokens older than `olderThanMs` (default 0 = anything currently expired). */
  pruneExpired(olderThanMs = 0): number {
    return this.#store.transaction(() => {
      const cutoffIso = new Date(this.#now() - Math.max(0, olderThanMs)).toISOString()
      const result = this.#store.db
        .prepare(
          `DELETE FROM auth_tokens
           WHERE (expires_at IS NOT NULL AND expires_at <= ?)
              OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
        )
        .run(cutoffIso, cutoffIso)
      return Number(result.changes)
    })
  }

  /** Appends a compact row to `auth_audit_log`, stripping secrets and query strings. */
  recordAudit(entry: AuthAuditInput): void {
    if ((this.#store.writeRefusal?.() ?? null) !== null) return
    const ts = new Date(this.#now()).toISOString()
    const code = entry.code != null ? redactTokens(entry.code).slice(0, 128) : null
    const tokenId = sanitizeAuditTokenId(entry.tokenId)
    const method = entry.method.toUpperCase().slice(0, 16)
    const path = sanitizeAuditPath(entry.path)
    this.#store.db
      .prepare(
        `INSERT INTO auth_audit_log (
          ts, listener, outcome, code, principal_id, actor_id, assurance, token_id, method, path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        entry.listener,
        entry.outcome,
        code,
        entry.principalId ?? null,
        entry.actorId ?? null,
        entry.assurance ?? null,
        tokenId,
        method,
        path,
      )
  }

  /** Lists recent entries from `auth_audit_log`, newest first. */
  listAudit(filter: ListAuditFilter = {}): AuthAuditEntry[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.listener !== undefined) {
      where.push('listener = ?')
      params.push(filter.listener)
    }
    if (filter.outcome !== undefined) {
      where.push('outcome = ?')
      params.push(filter.outcome)
    }
    if (filter.tokenId !== undefined) {
      const normalized = normalizeTokenId(filter.tokenId)
      if (normalized === null) return []
      where.push('token_id = ?')
      params.push(normalized)
    }
    if (filter.principalId !== undefined) {
      where.push('principal_id = ?')
      params.push(filter.principalId)
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000))
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.#store.db
      .prepare(`SELECT * FROM auth_audit_log ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as unknown as RawAuditRow[]
    return rows.map((r) =>
      Object.freeze({
        id: Number(r.id),
        ts: r.ts,
        listener: r.listener,
        outcome: r.outcome as 'allow' | 'deny',
        code: r.code,
        principalId: r.principal_id,
        actorId: r.actor_id,
        assurance: r.assurance,
        tokenId: r.token_id,
        method: r.method,
        path: r.path,
      }),
    )
  }
}
