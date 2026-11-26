import { afterEach, describe, expect, it } from 'vitest'
import {
  compileAccess,
  createLocalCaller,
  headerCan,
  SqliteUnifiedStore,
} from '../../../src/core/public.ts'
import { isBoardError, type BoardErrorLike } from '../../../src/client/errors.ts'
import {
  DEFAULT_AGENT_TTL_S,
  hashTokenSecret,
  isListenerScopeAllowed,
  MAX_DELEGATION_DEPTH,
  narrowCanHeader,
  normalizeTokenId,
  parseToken,
  redactTokens,
  TokenStore,
} from '../../../src/host/auth/tokens.ts'

const stores: SqliteUnifiedStore[] = []

function makeStore(): SqliteUnifiedStore {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return store
}

function expectErr(fn: () => unknown, status: number, code: string): BoardErrorLike {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(isBoardError(caught), `expected BoardErrorLike ${status} ${code}, got ${String(caught)}`).toBe(true)
  const err = caught as BoardErrorLike
  expect(err.status).toBe(status)
  expect(err.code).toBe(code)
  return err
}

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close()
})

const ownerHuman = createLocalCaller({
  userId: 'alice',
  handle: 'alice',
  owner: true,
  member: true,
  assurance: 'local_unverified',
})

const verifiedHuman = createLocalCaller({
  userId: 'alice',
  handle: 'alice',
  owner: true,
  member: true,
  assurance: 'human_verified',
})

describe('HOST-8: Hashed auth_tokens, delegation & auth_audit_log (V2-12)', () => {
  it('issues sb_<12-char base32>_<43-char base64url> tokens, stores ONLY sha256(secret), and verifies via timingSafeEqual', () => {
    let clock = Date.parse('2026-11-26T00:00:00.000Z')
    const store = makeStore()
    const tokens = new TokenStore(store, { now: () => clock })

    const issued = tokens.issueToken(ownerHuman, {
      profile: 'codex',
      note: 'local codex agent',
    })

    // Exact wire format check
    expect(issued.token).toMatch(/^sb_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/)
    const parsed = parseToken(issued.token)
    expect(parsed).not.toBeNull()
    expect(parsed!.tokenId).toBe(issued.record.id)
    expect(parsed!.secret).toHaveLength(43)

    // Metadata invariants
    expect(issued.record.principalId).toBe('local:user:alice')
    expect(issued.record.profile).toBe('codex')
    expect(issued.record.assurance).toBe('agent_delegated')
    expect(issued.record.cap).toEqual(['read', 'post', 'react', 'label'])
    expect(issued.record.listenerScope).toBe('local')
    expect(issued.record.delegationDepth).toBe(0)
    expect(issued.record.issuedBy).toBe('local:user:alice')
    expect(issued.record.expiresAt).toBe(new Date(clock + DEFAULT_AGENT_TTL_S * 1000).toISOString())
    expect(issued.record.revokedAt).toBeNull()
    expect(issued.record.lastUsedAt).toBeNull()

    // Plaintext secret MUST NOT appear anywhere in auth_tokens
    const rawRow = store.db.prepare('SELECT * FROM auth_tokens WHERE id = ?').get(issued.record.id) as Record<string, unknown>
    expect(rawRow.secret_hash).toBe(hashTokenSecret(parsed!.secret))
    expect(JSON.stringify(rawRow)).not.toContain(parsed!.secret)
    expect(JSON.stringify(rawRow)).not.toContain(issued.token)
    expect('secretHash' in issued.record).toBe(false)
    expect('secret' in issued.record).toBe(false)

    // Verify succeeds and updates lastUsedAt
    clock += 5_000
    const verified = tokens.verifyToken(issued.token, { listener: 'uds' })
    expect(verified.id).toBe(issued.record.id)
    expect(verified.lastUsedAt).toBe(new Date(clock).toISOString())

    // Tampered secret / unknown id / malformed wire -> 401 unauthorized
    const flippedSecret =
      parsed!.secret.slice(0, -1) + (parsed!.secret.endsWith('a') ? 'b' : 'a')
    expectErr(() => tokens.verifyToken(`${parsed!.tokenId}_${flippedSecret}`), 401, 'unauthorized')
    expectErr(() => tokens.verifyToken(`sb_aaaaaaaaaaaa_${parsed!.secret}`), 401, 'unauthorized')
    expectErr(() => tokens.verifyToken('not-a-token'), 401, 'unauthorized')
    expectErr(() => tokens.verifyToken(`${parsed!.tokenId}_short`), 401, 'unauthorized')

    // Corrupted DB hash fails closed with 401 (never RangeError)
    store.db.prepare('UPDATE auth_tokens SET secret_hash = ? WHERE id = ?').run('not-hex', issued.record.id)
    expectErr(() => tokens.verifyToken(issued.token), 401, 'unauthorized')
  })

  it('enforces revocation, expiry, listing filters, and listener scope bounds', () => {
    let clock = Date.parse('2026-11-26T00:00:00.000Z')
    const store = makeStore()
    const tokens = new TokenStore(store, { now: () => clock })

    const localTok = tokens.issueToken(ownerHuman, { profile: 'a1', listenerScope: 'local', ttlS: 600 })
    const lanTok = tokens.issueToken(ownerHuman, { profile: 'a2', listenerScope: 'lan', ttlS: 600 })
    const remoteTok = tokens.issueToken(ownerHuman, { profile: 'a3', listenerScope: 'remote', ttlS: 600 })

    // Listener scope matrix
    expect(isListenerScopeAllowed('local', 'uds')).toBe(true)
    expect(isListenerScopeAllowed('local', 'pipe')).toBe(true)
    expect(isListenerScopeAllowed('local', 'tcp-loopback')).toBe(true)
    expect(isListenerScopeAllowed('local', 'tailscale')).toBe(false)
    expect(isListenerScopeAllowed('local', 'https')).toBe(false)
    expect(isListenerScopeAllowed('lan', 'tailscale')).toBe(true)
    expect(isListenerScopeAllowed('lan', 'https')).toBe(false)
    expect(isListenerScopeAllowed('remote', 'https')).toBe(true)

    expectErr(() => tokens.verifyToken(localTok.token, { listener: 'tailscale' }), 403, 'forbidden')
    expectErr(() => tokens.verifyToken(localTok.token, { listener: 'https' }), 403, 'forbidden')
    expect(tokens.verifyToken(lanTok.token, { listener: 'tailscale' }).id).toBe(lanTok.record.id)
    expectErr(() => tokens.verifyToken(lanTok.token, { listener: 'https' }), 403, 'forbidden')
    expect(tokens.verifyToken(remoteTok.token, { listener: 'https' }).id).toBe(remoteTok.record.id)

    // Revocation accepts both sb_<id> and bare <id>; missing -> 404 token_not_found
    const bareId = localTok.record.id.slice(3)
    expect(normalizeTokenId(bareId)).toBe(localTok.record.id)
    const revoked = tokens.revokeToken(bareId)
    expect(revoked.revokedAt).toBe(new Date(clock).toISOString())
    expectErr(() => tokens.verifyToken(localTok.token), 401, 'token_revoked')
    expectErr(() => tokens.revokeToken('sb_222222222222'), 404, 'token_not_found')

    // Non-owner agent cannot revoke another agent's token
    expectErr(() => tokens.revokeToken(remoteTok.record.id, { actor: lanTok.record }), 403, 'forbidden')
    // Agent can self-revoke
    expect(tokens.revokeToken(lanTok.record.id, { actor: lanTok.record }).revokedAt).not.toBeNull()

    // Expiry via deterministic clock advance -> 401 token_expired
    clock += 600_000
    expectErr(() => tokens.verifyToken(remoteTok.token), 401, 'token_expired')

    // listTokens filters out revoked & expired by default, includes them when asked
    expect(tokens.listTokens()).toEqual([])
    expect(tokens.listTokens({ includeRevoked: true, includeExpired: true })).toHaveLength(3)

    // pruneExpired removes expired/revoked rows
    expect(tokens.pruneExpired(0)).toBe(3)
    expect(tokens.listTokens({ includeRevoked: true, includeExpired: true })).toEqual([])
  })

  it('enforces delegation depth <= 4, cap subset, channel narrowing (including disjoint fail-closed), TTL bounds, and anti-impersonation', () => {
    let clock = Date.parse('2026-11-26T00:00:00.000Z')
    const store = makeStore()
    const tokens = new TokenStore(store, { now: () => clock })

    // Depth 0 -> 1 -> 2 -> 3 -> 4 succeeds; depth 4 -> 5 fails 400 max_delegation_depth
    const d0 = tokens.issueToken(ownerHuman, {
      profile: 'lead',
      cap: ['read', 'post', 'react', 'label'],
      can: { 'dev/': ['read', 'post', 'label'], 'work/': ['read', 'post'] },
      listenerScope: 'lan',
      ttlS: 3600,
    })
    expect(d0.record.delegationDepth).toBe(0)

    clock += 600_000 // 3000s left on d0
    const d1 = tokens.issueToken(
      { kind: 'token', token: d0.record },
      {
        profile: 'sub1',
        cap: ['read', 'post', 'label'],
        can: 'dev/api/=read,post,manage;ops/=all', // attempts to widen -> intersected strictly to dev/api/=read,post
        listenerScope: 'local',
      },
    )
    expect(d1.record.delegationDepth).toBe(1)
    expect(d1.record.issuedBy).toBe(d0.record.id)
    expect(d1.record.cap).toEqual(['read', 'post', 'label'])
    expect(d1.record.listenerScope).toBe('local')
    // Default child TTL clamps cleanly to parent remaining (3000s)
    expect(d1.record.expiresAt).toBe(d0.record.expiresAt)
    // Verify narrowed channel scope never widened into ops/ or gained manage
    const d1Access = compileAccess(headerCan(d1.record.canHeader!))
    expect(d1Access.can('read', 'dev/api')).toBe(true)
    expect(d1Access.can('post', 'dev/api')).toBe(true)
    expect(d1Access.can('manage', 'dev/api')).toBe(false)
    expect(d1Access.can('read', 'ops/secret')).toBe(false)
    expect(d1Access.can('read', 'work/sprint')).toBe(false)

    // Disjoint channel narrowing MUST produce '*=' (NO_ACCESS), NEVER null!
    const disjoint = tokens.issueToken(
      { kind: 'token', token: d1.record },
      { profile: 'sub2', can: { 'finance/': ['read'] } },
    )
    expect(disjoint.record.canHeader).toBe('*=')
    const disjointAccess = compileAccess(headerCan(disjoint.record.canHeader!))
    expect(disjointAccess.can('read', 'dev/api')).toBe(false)
    expect(disjointAccess.can('read', 'finance/q1')).toBe(false)

    // Walk all the way to MAX_DELEGATION_DEPTH = 4
    const d2 = tokens.issueToken({ kind: 'token', token: d1.record }, { profile: 'sub2', cap: ['read', 'post'] })
    const d3 = tokens.issueToken({ kind: 'token', token: d2.record }, { profile: 'sub3', cap: ['read'] })
    const d4 = tokens.issueToken({ kind: 'token', token: d3.record }, { profile: 'sub4', cap: ['read'] })
    expect(d4.record.delegationDepth).toBe(MAX_DELEGATION_DEPTH)
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d4.record }, { profile: 'sub5', cap: ['read'] }),
      400,
      'max_delegation_depth',
    )

    // Cap widening rejected (including implied permission: post-only parent cannot delegate react which implies read)
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d3.record }, { profile: 'x', cap: ['read', 'post'] }),
      403,
      'forbidden',
    )
    const postOnly = tokens.issueToken(ownerHuman, { profile: 'poster', cap: ['post'], ttlS: 600 })
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: postOnly.record }, { profile: 'child', cap: ['react'] }),
      403,
      'forbidden',
    )

    // Listener scope widening rejected
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d1.record }, { profile: 'x', listenerScope: 'lan' }),
      403,
      'forbidden',
    )

    // TTL exceeding parent remaining or null TTL rejected
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d1.record }, { profile: 'x', ttlS: 3001 }),
      403,
      'forbidden',
    )
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d1.record }, { profile: 'x', ttlS: null }),
      403,
      'forbidden',
    )

    // Principal switching rejected
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d1.record }, { profile: 'x', principalId: 'local:user:other' }),
      403,
      'forbidden',
    )

    // Agent token CANNOT mint human/owner/profile-less token -> 403 agent_cannot_impersonate_human
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d0.record }, { profile: null }),
      403,
      'agent_cannot_impersonate_human',
    )
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d0.record }, { profile: 'sub', owner: true }),
      403,
      'agent_cannot_impersonate_human',
    )
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d0.record }, { profile: 'sub', assurance: 'human_verified' }),
      403,
      'agent_cannot_impersonate_human',
    )
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d0.record }, { profile: 'sub', assurance: 'local_unverified' }),
      403,
      'agent_cannot_impersonate_human',
    )

    // local_unverified human cannot mint human_verified token; human_verified human CAN
    expectErr(
      () => tokens.issueToken(ownerHuman, { profile: null, assurance: 'human_verified' }),
      403,
      'human_verification_required',
    )
    const humanTok = tokens.issueToken(verifiedHuman, { profile: null, assurance: 'human_verified', ttlS: 3600 })
    expect(humanTok.record.assurance).toBe('human_verified')
    expect(humanTok.record.profile).toBeNull()

    // Revoked parent cannot mint child even when stale TokenRecord is supplied
    tokens.revokeToken(d0.record.id)
    expectErr(
      () => tokens.issueToken({ kind: 'token', token: d0.record }, { profile: 'after-revoke' }),
      401,
      'token_revoked',
    )

    // HA-F1 regression: non-owner person (e.g., Tailscale teammate or OIDC human) CANNOT mint tokens for another principal
    const nonOwnerPerson = createLocalCaller({
      userId: 'teammate',
      handle: 'teammate',
      owner: false,
      member: false,
      assurance: 'local_unverified',
    })
    expectErr(
      () =>
        tokens.issueToken(nonOwnerPerson, {
          principalId: 'local:user:alice',
          profile: null,
          listenerScope: 'lan',
        }),
      403,
      'forbidden',
    )
    expectErr(
      () =>
        tokens.issueToken(nonOwnerPerson, {
          profile: null,
          owner: true,
        }),
      403,
      'forbidden',
    )
    // Non-owner person CAN still mint an agent token scoped strictly to its own principal
    const selfAgent = tokens.issueToken(nonOwnerPerson, { profile: 'helper', ttlS: 600 })
    expect(selfAgent.record.principalId).toBe('local:user:teammate')
    expect(selfAgent.record.profile).toBe('helper')
  })

  it('writes auth_audit_log with token_id only, strips query strings, and redacts any secret including trailing hyphens', () => {
    const store = makeStore()
    const tokens = new TokenStore(store)

    // Synthetic token whose secret ends with '-' (edge case for regex word boundary)
    const fakeId = 'sb_abcdef234567'
    const secretEndingHyphen = `${'a'.repeat(42)}-`
    const wire = `${fakeId}_${secretEndingHyphen}`
    expect(parseToken(wire)).toEqual({ tokenId: fakeId, secret: secretEndingHyphen })
    expect(redactTokens(`bearer ${wire} done`)).toBe(`bearer ${fakeId}_[redacted] done`)

    tokens.recordAudit({
      listener: 'tcp-loopback',
      outcome: 'deny',
      code: `bad ${wire}`,
      principalId: null,
      actorId: null,
      assurance: null,
      tokenId: wire, // intentionally pass full wire token to verify sanitizer strips secret!
      method: 'post',
      path: `/_swarm/v1/login?code=SUPERSECRET&token=${wire}`,
    })

    const rows = tokens.listAudit({ listener: 'tcp-loopback' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenId).toBe(fakeId)
    expect(rows[0]!.path).toBe('/_swarm/v1/login')
    expect(rows[0]!.code).toBe(`bad ${fakeId}_[redacted]`)
    expect(JSON.stringify(rows[0])).not.toContain(secretEndingHyphen)
    expect(JSON.stringify(rows[0])).not.toContain('SUPERSECRET')
  })

  it('narrowCanHeader preserves exact subtractive exceptions and never widens', () => {
    expect(narrowCanHeader(null, null)).toBeNull()
    expect(narrowCanHeader('dev/=read,post', null)).toBe('dev/=read,post')
    expect(narrowCanHeader('*=read,post,label', '*=read,post;dev/=read')).toBe('*=read,post;dev/=read')
    const exc = narrowCanHeader('*=read,post', '*=read,post;dev/=')
    const acc = compileAccess(headerCan(exc!))
    expect(acc.can('read', 'general')).toBe(true)
    expect(acc.can('read', 'dev/secret')).toBe(false)
    expect(narrowCanHeader('dev/=read', 'ops/=read')).toBe('*=')
  })
})
