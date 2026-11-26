import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardService,
  createLocalCaller,
  requireHumanVerified,
  SqliteUnifiedStore,
} from '../../../src/core/public.ts'
import { isBoardError, type BoardErrorLike } from '../../../src/client/errors.ts'
import {
  checkExpectedInstance,
  checkLoopbackGuards,
  createAuthenticator,
  SESSION_COOKIE_NAME,
  validateListenerConfig,
} from '../../../src/host/auth/authenticator.ts'
import { writeAgentCard } from '../../../src/host/auth/local.ts'
import { TokenStore } from '../../../src/host/auth/tokens.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const stores: SqliteUnifiedStore[] = []
const tmpDirs: string[] = []

function makeStore(): SqliteUnifiedStore {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return store
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-host8-'))
  tmpDirs.push(dir)
  return dir
}

async function expectReject(p: Promise<unknown>, status: number, code: string): Promise<BoardErrorLike> {
  let caught: unknown
  try {
    await p
  } catch (err) {
    caught = err
  }
  expect(isBoardError(caught), `expected BoardErrorLike ${status} ${code}, got ${String(caught)}`).toBe(true)
  const err = caught as BoardErrorLike
  expect(err.status).toBe(status)
  expect(err.code).toBe(code)
  return err
}

function expectSyncErr(fn: () => unknown, status: number, code: string): BoardErrorLike {
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
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

const ownerHuman = createLocalCaller({
  userId: 'alice',
  handle: 'alice',
  owner: true,
  member: true,
  assurance: 'local_unverified',
})

describe('HOST-8: Authenticator, 4 loopback CSRF guards, login cookies, and Tailscale/OIDC hooks (V2-12, V2-16)', () => {
  it('enforces all 4 loopback CSRF/DNS-rebinding guards even when auth.enforce=false', async () => {
    const store = makeStore()
    const auth = createAuthenticator({
      store,
      authEnforce: false,
      ownerUserId: 'alice',
      loopbackPort: 4180,
    })

    // --- Guard 1: Host (ALL requests, including GET/HEAD) ---
    for (const okHost of ['127.0.0.1:4180', 'localhost:4180', '[::1]:4180', 'LOCALHOST:4180']) {
      const req = new Request('http://127.0.0.1:4180/api/board/channels', {
        method: 'GET',
        headers: { host: okHost },
      })
      const res = await auth.authenticate(req, { listener: 'tcp-loopback', port: 4180 })
      expect(res.authMethod).toBe('loopback-ui')
      expect(res.caller.actor.kind).toBe('person')
    }

    for (const badHost of [
      null,
      'evil.example',
      'evil.example:4180',
      '127.0.0.1.evil.com:4180',
      'localhost:9999',
      '127.0.0.1',
      'user@127.0.0.1:4180',
    ]) {
      const headers = new Headers()
      if (badHost !== null) headers.set('host', badHost)
      const req = new Request('http://127.0.0.1:4180/api/board/channels', { method: 'GET', headers })
      await expectReject(auth.authenticate(req, { listener: 'tcp-loopback', port: 4180 }), 403, 'forbidden')
    }

    // --- Guard 2: Origin on non-GET/HEAD ---
    for (const okOrigin of [null, 'http://127.0.0.1:4180', 'http://localhost:4180', 'http://[::1]:4180']) {
      const headers = new Headers({
        host: '127.0.0.1:4180',
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      })
      if (okOrigin !== null) headers.set('origin', okOrigin)
      const req = new Request('http://127.0.0.1:4180/api/v2/rpc/post', { method: 'POST', headers })
      const res = await auth.authenticate(req, { listener: 'tcp-loopback', port: 4180 })
      expect(res.caller.principal.id).toBe('local:user:alice')
    }

    for (const badOrigin of [
      'http://evil.example',
      'http://evil.example:4180',
      'https://127.0.0.1:4180',
      'http://127.0.0.1:9999',
      'http://127.0.0.1:4180/extra',
      'null',
    ]) {
      const req = new Request('http://127.0.0.1:4180/api/v2/rpc/post', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4180',
          origin: badOrigin,
          'content-type': 'application/json',
        },
      })
      await expectReject(auth.authenticate(req, { listener: 'tcp-loopback', port: 4180 }), 403, 'forbidden')
    }

    // --- Guard 3: Sec-Fetch-Site on non-GET/HEAD ---
    for (const okSite of ['same-origin', 'none', 'SAME-ORIGIN']) {
      const req = new Request('http://127.0.0.1:4180/api/v2/rpc/post', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4180',
          'sec-fetch-site': okSite,
          'content-type': 'application/json',
        },
      })
      await expect(auth.authenticate(req, { listener: 'tcp-loopback', port: 4180 })).resolves.toBeTruthy()
    }
    for (const badSite of ['cross-site', 'same-site', 'untrusted']) {
      const req = new Request('http://127.0.0.1:4180/api/v2/rpc/post', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4180',
          'sec-fetch-site': badSite,
          'content-type': 'application/json',
        },
      })
      await expectReject(auth.authenticate(req, { listener: 'tcp-loopback', port: 4180 }), 403, 'forbidden')
    }

    // --- Guard 4: Content-Type on non-GET/HEAD (blocks form / text/plain CSRF) ---
    for (const badCt of [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/octet-stream']) {
      const headers = new Headers({ host: '127.0.0.1:4180' })
      if (badCt !== null) headers.set('content-type', badCt)
      const req = new Request('http://127.0.0.1:4180/api/v2/rpc/post', { method: 'POST', headers })
      await expectReject(auth.authenticate(req, { listener: 'tcp-loopback', port: 4180 }), 403, 'forbidden')
    }

    // application/json; charset=utf-8 passes on any write route
    const jsonCharsetReq = new Request('http://127.0.0.1:4180/api/v2/rpc/post', {
      method: 'DELETE',
      headers: { host: '127.0.0.1:4180', 'content-type': 'application/json; charset=utf-8' },
    })
    await expect(auth.authenticate(jsonCharsetReq, { listener: 'tcp-loopback', port: 4180 })).resolves.toBeTruthy()

    // application/octet-stream allowed ONLY on /attachments upload routes
    for (const uploadPath of ['/api/board/attachments', '/api/v2/attachments', '/api/board/attachments/uploads']) {
      const req = new Request(`http://127.0.0.1:4180${uploadPath}`, {
        method: 'POST',
        headers: { host: '127.0.0.1:4180', 'content-type': 'application/octet-stream' },
      })
      await expect(auth.authenticate(req, { listener: 'tcp-loopback', port: 4180 })).resolves.toBeTruthy()
    }

    // Direct helper check on missing Host
    expectSyncErr(
      () => checkLoopbackGuards(new Request('http://127.0.0.1:4180/healthz', { method: 'GET' }), { port: 4180 }),
      403,
      'forbidden',
    )
  })

  it('enforces UDS, named pipe, and strict tcp-loopback cookie + bearer policies, plus card & x-board-can narrowing', async () => {
    let clock = Date.parse('2026-11-26T00:00:00.000Z')
    const store = makeStore()
    const board = new BoardService(store)
    const dir = makeTmpDir()
    writeAgentCard(dir, {
      version: 1,
      profile: 'codex',
      cap: ['read', 'post'],
      can: { 'dev/': ['read', 'post'] },
      impersonatePerson: false,
    })

    // 1. Default local dev (authEnforce: false)
    const devAuth = createAuthenticator({
      store,
      authEnforce: false,
      ownerUserId: 'alice',
      boardDir: dir,
      loopbackPort: 4180,
      now: () => clock,
    })

    // UDS without token -> OS-user trust (person when no profile, capped carded agent when X-Board-Profile set)
    const udsOwner = await devAuth.authenticate(new Request('http://localhost/api/v2/rpc/me'), { listener: 'uds' })
    expect(udsOwner.authMethod).toBe('os-user')
    expect(udsOwner.caller.actor.kind).toBe('person')
    expect(udsOwner.caller.principal.owner).toBe(true)

    const udsAgent = await devAuth.authenticate(
      new Request('http://localhost/api/v2/rpc/post', {
        method: 'POST',
        headers: { 'x-board-profile': 'codex', 'x-board-can': 'dev/sub/=read,post' },
      }),
      { listener: 'uds' },
    )
    expect(udsAgent.caller.actor.id).toBe('local:user:alice+codex')
    expect(udsAgent.caller.principal.cap).toEqual(['read', 'post'])
    expect(udsAgent.caller.canHeader).toBe('dev/sub/=read,post')
    expect(board.postMessage(udsAgent.caller, { channel: 'dev/sub', text: 'ok' }).message.channel).toBe('dev/sub')
    expectSyncErr(() => board.postMessage(udsAgent.caller, { channel: 'dev/other', text: 'blocked' }), 403, 'forbidden')

    // Empty X-Board-Profile rejected 400 invalid_profile
    await expectReject(
      devAuth.authenticate(new Request('http://localhost/api/v2/rpc/me', { headers: { 'x-board-profile': '   ' } }), {
        listener: 'uds',
      }),
      400,
      'invalid_profile',
    )

    // Named pipe ALWAYS requires Bearer token even when authEnforce=false!
    await expectReject(
      devAuth.authenticate(new Request('http://localhost/api/v2/rpc/me'), { listener: 'pipe' }),
      401,
      'unauthorized',
    )

    const issued = devAuth.tokens.issueToken(ownerHuman, {
      profile: 'agy',
      cap: ['read', 'post', 'react', 'label'],
      can: { 'dev/': ['read', 'post'] },
      ttlS: 3600,
    })

    const pipeAuth = await devAuth.authenticate(
      new Request('http://localhost/api/v2/rpc/me', {
        headers: { authorization: `Bearer ${issued.token}`, 'x-board-profile': 'agy' },
      }),
      { listener: 'pipe' },
    )
    expect(pipeAuth.authMethod).toBe('bearer-token')
    expect(pipeAuth.tokenId).toBe(issued.record.id)
    expect(pipeAuth.caller.actor.id).toBe('local:user:alice+agy')

    // Token profile binding: mismatch -> 403 profile_mismatch; empty -> 403 agent_cannot_impersonate_human
    await expectReject(
      devAuth.authenticate(
        new Request('http://localhost/api/v2/rpc/me', {
          headers: { authorization: `Bearer ${issued.token}`, 'x-board-profile': 'codex' },
        }),
        { listener: 'uds' },
      ),
      403,
      'profile_mismatch',
    )
    await expectReject(
      devAuth.authenticate(
        new Request('http://localhost/api/v2/rpc/me', {
          headers: { authorization: `Bearer ${issued.token}`, 'x-board-profile': '' },
        }),
        { listener: 'uds' },
      ),
      403,
      'agent_cannot_impersonate_human',
    )

    // 2. Strict mode (authEnforce: true)
    const strictAuth = createAuthenticator({
      store,
      tokens: devAuth.tokens,
      authEnforce: true,
      ownerUserId: 'alice',
      loopbackPort: 4180,
      now: () => clock,
    })

    // UDS & loopback refuse unauthenticated callers with 401
    await expectReject(
      strictAuth.authenticate(new Request('http://localhost/api/v2/rpc/me'), { listener: 'uds' }),
      401,
      'unauthorized',
    )
    await expectReject(
      strictAuth.authenticate(
        new Request('http://127.0.0.1:4180/api/v2/rpc/me', { headers: { host: '127.0.0.1:4180' } }),
        { listener: 'tcp-loopback', port: 4180 },
      ),
      401,
      'unauthorized',
    )

    // One-time login code -> HttpOnly; SameSite=Strict session cookie
    const login = strictAuth.mintLoginCode({ ttlMs: 60_000 })
    const session = strictAuth.exchangeLoginCode(login.code)
    expect(session.cookieHeader).toContain(`${SESSION_COOKIE_NAME}=${session.sessionId}`)
    expect(session.cookieHeader).toContain('HttpOnly')
    expect(session.cookieHeader).toContain('SameSite=Strict')

    // Single-use: replay fails 401
    expectSyncErr(() => strictAuth.exchangeLoginCode(login.code), 401, 'unauthorized')

    // Expired login code fails 401
    const expiringCode = strictAuth.mintLoginCode({ ttlMs: 5_000 })
    clock += 6_000
    expectSyncErr(() => strictAuth.exchangeLoginCode(expiringCode.code), 401, 'unauthorized')

    // Valid session cookie authenticates loopback owner even under authEnforce=true
    const cookieReq = new Request('http://127.0.0.1:4180/api/v2/rpc/me', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4180',
        origin: 'http://127.0.0.1:4180',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}`,
      },
    })
    const cookieRes = await strictAuth.authenticate(cookieReq, { listener: 'tcp-loopback', port: 4180 })
    expect(cookieRes.authMethod).toBe('session-cookie')
    expect(cookieRes.caller.actor.kind).toBe('person')
    // HA-F3: default login code has local_unverified assurance -> actor.verified MUST NOT be set
    expect(cookieRes.caller.principal.assurance).toBe('local_unverified')
    expect(cookieRes.caller.actor.verified).toBeUndefined()
    expect(cookieRes.caller.principal.owner).toBe(true)

    // HA-F3: explicit human_verified login code sets actor.verified = true and satisfies requireHumanVerified
    const hvCode = strictAuth.mintLoginCode({ ttlMs: 60_000, assurance: 'human_verified' })
    const hvSession = strictAuth.exchangeLoginCode(hvCode.code)
    const hvReq = new Request('http://127.0.0.1:4180/api/v2/rpc/me', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4180',
        origin: 'http://127.0.0.1:4180',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE_NAME}=${hvSession.sessionId}`,
      },
    })
    const hvRes = await strictAuth.authenticate(hvReq, { listener: 'tcp-loopback', port: 4180 })
    expect(hvRes.caller.principal.assurance).toBe('human_verified')
    expect(hvRes.caller.actor.verified).toBe(true)
    expect(() => requireHumanVerified(hvRes.caller)).not.toThrow()

    // Cross-site GET carrying cookie is refused 403
    const crossSiteCookieGet = new Request('http://127.0.0.1:4180/api/v2/inbox', {
      method: 'GET',
      headers: {
        host: '127.0.0.1:4180',
        'sec-fetch-site': 'cross-site',
        cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}`,
      },
    })
    await expectReject(
      strictAuth.authenticate(crossSiteCookieGet, { listener: 'tcp-loopback', port: 4180 }),
      403,
      'forbidden',
    )

    // Revoking session invalidates cookie
    expect(strictAuth.revokeSession(session.sessionId)).toBe(true)
    await expectReject(
      strictAuth.authenticate(cookieReq, { listener: 'tcp-loopback', port: 4180 }),
      401,
      'unauthorized',
    )

    // Audit log captured allows & denies with zero plaintext secrets or login codes
    const audit = strictAuth.tokens.listAudit({ limit: 100 })
    expect(audit.some((a) => a.outcome === 'allow' && a.tokenId === issued.record.id)).toBe(true)
    expect(audit.some((a) => a.outcome === 'deny' && a.code === 'profile_mismatch' && a.tokenId === issued.record.id)).toBe(true)
    expect(JSON.stringify(audit)).not.toContain(issued.token)
    expect(JSON.stringify(audit)).not.toContain(login.code)
    expect(JSON.stringify(audit)).not.toContain(session.sessionId)

    // HA-F4 regression: audit persistence failure on a closed store MUST NOT mask 401/403 auth denials
    const closedStore = new SqliteUnifiedStore({ path: ':memory:' })
    const closedAuth = createAuthenticator({ store: closedStore, authEnforce: true, loopbackPort: 4180 })
    closedStore.close()
    await expectReject(
      closedAuth.authenticate(new Request('http://127.0.0.1:4180/api/v2/inbox', { headers: { host: 'evil.example' } }), {
        listener: 'tcp-loopback',
        port: 4180,
      }),
      403,
      'forbidden',
    )
    await expectReject(
      closedAuth.authenticate(new Request('http://localhost/api/v2/inbox'), { listener: 'pipe' }),
      401,
      'unauthorized',
    )
  })

  it('enforces Tailscale mutual-exclusion, Funnel/tagged rejection, owner human_verified, and non-local /_swarm refusal', async () => {
    const store = makeStore()
    const tokens = new TokenStore(store)

    // --tailscale-host and --allow-host are mutually exclusive (400 conflicting_options)
    expectSyncErr(
      () => validateListenerConfig({ tailscaleHost: 'box.tail.ts.net', allowHosts: ['box.local'] }),
      400,
      'conflicting_options',
    )
    expectSyncErr(
      () =>
        createAuthenticator({
          store,
          tailscaleHost: 'box.tail.ts.net',
          allowHosts: ['box.local'],
        }),
      400,
      'conflicting_options',
    )

    const auth = createAuthenticator({
      store,
      tokens,
      tailscaleHost: 'box.tail.ts.net',
      tailscaleOwnerLogin: 'alice@example.com',
    })

    // Wrong Host -> 403
    await expectReject(
      auth.authenticate(
        new Request('https://evil.example/api/v2/inbox', {
          headers: { host: 'evil.example', 'tailscale-user-login': 'alice@example.com' },
        }),
        { listener: 'tailscale' },
      ),
      403,
      'forbidden',
    )

    // Control namespace /_swarm/v1/* refused 403 on tailscale
    await expectReject(
      auth.authenticate(
        new Request('https://box.tail.ts.net/_swarm/v1/tokens', {
          headers: { host: 'box.tail.ts.net', 'tailscale-user-login': 'alice@example.com' },
        }),
        { listener: 'tailscale' },
      ),
      403,
      'forbidden',
    )

    // Funnel rejected 401
    await expectReject(
      auth.authenticate(
        new Request('https://box.tail.ts.net/api/v2/inbox', {
          headers: {
            host: 'box.tail.ts.net',
            'tailscale-user-login': 'alice@example.com',
            'tailscale-funnel-request': '?1',
          },
        }),
        { listener: 'tailscale' },
      ),
      401,
      'unauthorized',
    )

    // Tagged devices rejected 401
    for (const tagged of ['tagged-devices', 'tag:ci-runner', '   ']) {
      await expectReject(
        auth.authenticate(
          new Request('https://box.tail.ts.net/api/v2/inbox', {
            headers: { host: 'box.tail.ts.net', 'tailscale-user-login': tagged },
          }),
          { listener: 'tailscale' },
        ),
        401,
        'unauthorized',
      )
    }

    // Owner login -> human_verified + owner
    const ownerRes = await auth.authenticate(
      new Request('https://box.tail.ts.net/api/v2/inbox', {
        headers: {
          host: 'box.tail.ts.net',
          'tailscale-user-login': 'Alice@Example.com',
          'tailscale-user-name': 'Alice',
        },
      }),
      { listener: 'tailscale' },
    )
    expect(ownerRes.caller.principal.id).toBe('tailscale:user:alice@example.com')
    expect(ownerRes.caller.principal.owner).toBe(true)
    expect(ownerRes.caller.principal.assurance).toBe('human_verified')
    expect(ownerRes.caller.actor.verified).toBe(true)
    expect(() => requireHumanVerified(ownerRes.caller)).not.toThrow()

    // Non-owner tailnet peer -> local_unverified, owner: false, member: false
    const peerRes = await auth.authenticate(
      new Request('https://box.tail.ts.net/api/v2/inbox', {
        headers: { host: 'box.tail.ts.net', 'tailscale-user-login': 'teammate@example.com' },
      }),
      { listener: 'tailscale' },
    )
    expect(peerRes.caller.principal.id).toBe('tailscale:user:teammate@example.com')
    expect(peerRes.caller.principal.owner).toBe(false)
    expect(peerRes.caller.principal.member).toBe(false)
    expect(peerRes.caller.principal.assurance).toBe('local_unverified')

    // Bearer tokens on tailscale: lan & remote allowed, local refused 403
    const localTok = tokens.issueToken(ownerHuman, { profile: 'a1', listenerScope: 'local' })
    const lanTok = tokens.issueToken(ownerHuman, { profile: 'a2', listenerScope: 'lan' })
    await expectReject(
      auth.authenticate(
        new Request('https://box.tail.ts.net/api/v2/inbox', {
          headers: { host: 'box.tail.ts.net', authorization: `Bearer ${localTok.token}` },
        }),
        { listener: 'tailscale' },
      ),
      403,
      'forbidden',
    )
    const lanRes = await auth.authenticate(
      new Request('https://box.tail.ts.net/api/v2/inbox', {
        headers: { host: 'box.tail.ts.net', authorization: `Bearer ${lanTok.token}` },
      }),
      { listener: 'tailscale' },
    )
    expect(lanRes.caller.actor.id).toBe('local:user:alice+a2')
  })

  it('verifies Mode 4 https remote tokens and OIDC JWTs via jose (aud === boardUrl, board_grants ACL)', async () => {
    const nowMs = Date.parse('2026-11-26T00:00:00.000Z')
    const store = makeStore()
    const board = new BoardService(store)
    const tokens = new TokenStore(store, { now: () => nowMs })
    const boardUrl = 'https://board.example.internal/api/board'

    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const pubJwk = await exportJWK(publicKey)
    pubJwk.kid = 'k1'
    pubJwk.alg = 'ES256'
    const otherPair = await generateKeyPair('ES256')

    const auth = createAuthenticator({
      store,
      tokens,
      boardUrl,
      now: () => nowMs,
      oidc: {
        audience: boardUrl,
        issuers: [
          {
            issuer: 'https://idp.example.com',
            jwks: { keys: [pubJwk] },
            kind: 'workload',
            defaultProfile: 'ci',
          },
          {
            issuer: 'https://sso.example.com',
            key: publicKey,
            kind: 'human',
          },
        ],
      },
    })

    // Seed explicit OIDC grant on board (no g1 for kind:'oidc')
    board.createGrant(ownerHuman, {
      principals: [
        {
          kind: 'oidc',
          issuer: 'https://idp.example.com',
          claims: { sub: 'repo:acme/swarmboard:*' },
        },
      ],
      can: { 'ci/': ['read', 'post'] },
    })

    const signJwt = async (
      claims: Record<string, unknown>,
      key = privateKey,
      opts: { iss?: string; aud?: string; expOffsetS?: number } = {},
    ): Promise<string> => {
      const iat = Math.floor(nowMs / 1000)
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setIssuer(opts.iss ?? 'https://idp.example.com')
        .setAudience(opts.aud ?? boardUrl)
        .setIssuedAt(iat)
        .setExpirationTime(iat + (opts.expOffsetS ?? 300))
        .sign(key)
    }

    // 1. Valid workload OIDC JWT -> matches explicit OIDC board_grant
    const ciJwt = await signJwt({ sub: 'repo:acme/swarmboard:ref:refs/heads/main' })
    const ciRes = await auth.authenticate(
      new Request('https://board.example.internal/api/v2/rpc/post', {
        method: 'POST',
        headers: { host: 'board.example.internal', authorization: `Bearer ${ciJwt}` },
      }),
      { listener: 'https' },
    )
    expect(ciRes.authMethod).toBe('oidc')
    expect(ciRes.caller.principal.kind).toBe('oidc')
    expect(ciRes.caller.principal.member).toBe(false)
    expect(ciRes.caller.principal.owner).toBe(false)
    expect(ciRes.caller.principal.assurance).toBe('agent_delegated')
    expect(ciRes.caller.actor.kind).toBe('agent')
    expect(ciRes.caller.profile).toBe('ci')
    expect(board.postMessage(ciRes.caller, { channel: 'ci/builds', text: 'green' }).message.channel).toBe('ci/builds')
    expectSyncErr(() => board.postMessage(ciRes.caller, { channel: 'dev', text: 'nope' }), 403, 'forbidden')

    // 2. Valid human SSO OIDC JWT -> human_verified person
    const ssoJwt = await signJwt(
      { sub: 'user-42', email: 'alice@example.com', name: 'Alice' },
      privateKey,
      { iss: 'https://sso.example.com' },
    )
    const ssoRes = await auth.authenticate(
      new Request('https://board.example.internal/api/v2/inbox', {
        headers: { host: 'board.example.internal', authorization: `Bearer ${ssoJwt}` },
      }),
      { listener: 'https' },
    )
    expect(ssoRes.caller.principal.assurance).toBe('human_verified')
    expect(ssoRes.caller.actor.kind).toBe('person')
    expect(ssoRes.caller.actor.verified).toBe(true)
    expect(() => requireHumanVerified(ssoRes.caller)).not.toThrow()

    // 3. Adversarial JWTs: wrong aud, untrusted iss, bad signature, expired, missing sub -> all 401
    const wrongAud = await signJwt({ sub: 'repo:acme/swarmboard:main' }, privateKey, { aud: 'https://other.example' })
    const wrongIss = await signJwt({ sub: 'u1' }, privateKey, { iss: 'https://evil-idp.example' })
    const wrongSig = await signJwt({ sub: 'repo:acme/swarmboard:main' }, otherPair.privateKey)
    const expiredJwt = await signJwt({ sub: 'repo:acme/swarmboard:main' }, privateKey, { expOffsetS: -60 })
    const noSubJwt = await signJwt({}, privateKey)

    for (const badJwt of [wrongAud, wrongIss, wrongSig, expiredJwt, noSubJwt, 'not.a.jwt']) {
      await expectReject(
        auth.authenticate(
          new Request('https://board.example.internal/api/v2/inbox', {
            headers: { host: 'board.example.internal', authorization: `Bearer ${badJwt}` },
          }),
          { listener: 'https' },
        ),
        401,
        'unauthorized',
      )
    }

    // 4. Remote scope bearer token passes on https; lan/local tokens refused 403; /_swarm/v1/* refused 403
    const remoteTok = tokens.issueToken(ownerHuman, { profile: 'rem', listenerScope: 'remote' })
    const lanTok = tokens.issueToken(ownerHuman, { profile: 'lan1', listenerScope: 'lan' })
    const remRes = await auth.authenticate(
      new Request('https://board.example.internal/api/v2/inbox', {
        headers: { host: 'board.example.internal', authorization: `Bearer ${remoteTok.token}` },
      }),
      { listener: 'https' },
    )
    expect(remRes.tokenId).toBe(remoteTok.record.id)
    expect(remRes.caller.principal.member).toBe(false)

    await expectReject(
      auth.authenticate(
        new Request('https://board.example.internal/api/v2/inbox', {
          headers: { host: 'board.example.internal', authorization: `Bearer ${lanTok.token}` },
        }),
        { listener: 'https' },
      ),
      403,
      'forbidden',
    )
    await expectReject(
      auth.authenticate(
        new Request('https://board.example.internal/_swarm/v1/retire', {
          method: 'POST',
          headers: { host: 'board.example.internal', authorization: `Bearer ${remoteTok.token}` },
        }),
        { listener: 'https' },
      ),
      403,
      'forbidden',
    )
  })

  it('enforces X-Swarmboard-Expect-Instance (410 cursor_expired on restore/incarnation drift)', () => {
    const live = { boardId: 'b_0123456789abcdef0123456789abcdef', instanceId: 'i_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }

    // Absent or matching passes
    expect(() =>
      checkExpectedInstance(new Request('http://127.0.0.1:4180/api/v2/inbox'), live),
    ).not.toThrow()
    expect(() =>
      checkExpectedInstance(
        new Request('http://127.0.0.1:4180/api/v2/inbox', {
          headers: { 'x-swarmboard-expect-instance': live.instanceId },
        }),
        live,
      ),
    ).not.toThrow()

    // Mismatch throws 410 cursor_expired with instance_changed details
    const err = expectSyncErr(
      () =>
        checkExpectedInstance(
          new Request('http://127.0.0.1:4180/api/v2/inbox', {
            headers: { 'x-swarmboard-expect-instance': 'i_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
          }),
          live,
        ),
      410,
      'cursor_expired',
    )
    expect(err.details).toEqual({
      reason: 'instance_changed',
      boardId: live.boardId,
      instanceId: live.instanceId,
    })
  })

  it('satisfies import, normalizer, console, and pure-module boundaries across all src/host/auth/** files', () => {
    const authFiles = ['src/host/auth/local.ts', 'src/host/auth/tokens.ts', 'src/host/auth/authenticator.ts']
    const forbiddenImports = /(?:from|import|require)\s*\(?\s*['"](?:node:)?(?:child_process|net|http|https|worker_threads)['"]/
    const forbiddenInternal = /core\/internal/
    const forbiddenNormalizers = /\b(?:normalizeError|toErrorPayload|toErrorResponse)\b/
    const forbiddenConsole = /\bconsole\./

    for (const rel of authFiles) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      expect(forbiddenImports.test(text), `${rel} must not import process/net/http modules`).toBe(false)
      expect(forbiddenInternal.test(text), `${rel} must not import src/core/internal.ts`).toBe(false)
      expect(forbiddenNormalizers.test(text), `${rel} must not call core error normalizers`).toBe(false)
      expect(forbiddenConsole.test(text), `${rel} must not use console.*`).toBe(false)
    }
  })
})
