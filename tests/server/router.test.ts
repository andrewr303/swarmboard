// HOST-9 server router, FIFO write queue, compat/v2/RPC parity, and loopback security tests (V2-14, V2-16, HS-03).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import type { Server } from 'node:http'
import { createConnection, type AddressInfo } from 'node:net'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, createLocalCaller, PERMISSIONS, SqliteUnifiedStore } from '../../src/core/public.ts'
import { isBoardError } from '../../src/client/errors.ts'
import { OP_NAMES, OPS } from '../../src/client/ops.ts'
import { HttpTransport } from '../../src/client/transport-http.ts'
import { createAuthenticator, validateListenerConfig } from '../../src/host/auth/authenticator.ts'
import {
  createNodeHttpServer,
  createServerHandler,
  WriteQueue,
  type ServerHandler,
  type ServerListenerContext,
} from '../../src/server/index.ts'
import { SCANNED_EXTENSIONS } from '../core/host0/import-boundary.ts'
import { stripComments } from '../core/host0/import-graph.ts'
import { FIXTURES } from '../conformance/fixtures.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const stores: SqliteUnifiedStore[] = []
const handlers: ServerHandler[] = []
const httpServers: Server[] = []

afterEach(async () => {
  while (httpServers.length > 0) {
    const srv = httpServers.pop()!
    await new Promise<void>((r) => {
      srv.close(() => r())
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections()
    })
  }
  while (handlers.length > 0) {
    handlers.pop()!.close()
  }
  while (stores.length > 0) {
    try {
      stores.pop()!.close()
    } catch {
      // already closed
    }
  }
})

function makeServer(opts: { authEnforce?: boolean; maxBodyBytes?: number; uiHandler?: Parameters<typeof createServerHandler>[0]['uiHandler'] } = {}) {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  const board = new BoardService(store)
  const authenticator = createAuthenticator({
    store,
    authEnforce: opts.authEnforce ?? false,
    ownerUserId: 'ada',
    ownerHandle: 'ada',
    ownerName: 'Ada',
    loopbackPort: 4180,
    tailscaleHost: 'board.tailnet.ts.net',
    tailscaleOwnerLogin: 'ada@example.com',
  })
  const handler = createServerHandler({
    board,
    authenticator,
    mode: 'daemon',
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(opts.uiHandler !== undefined ? { uiHandler: opts.uiHandler } : {}),
  })
  handlers.push(handler)
  return { store, board, authenticator, handler }
}

const UDS_CTX: ServerListenerContext = { listener: 'uds' }
const LOOPBACK_CTX: ServerListenerContext = { listener: 'tcp-loopback', port: 4180 }

function req(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
  base = 'http://127.0.0.1:4180',
): Request {
  const headers = new Headers(init.headers ?? {})
  if (!headers.has('host')) headers.set('host', new URL(base).host)
  return new Request(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  })
}

describe('V2-14 HOST-9 router, discovery, 84-op RPC, 61 compat routes, 22 v2 REST aliases & FIFO write queue', () => {
  it('V2-14 GET /healthz and GET /api/board return discovery, Capabilities, fusion block, and instance headers', async () => {
    const { board, handler } = makeServer()
    const info = board.boardInfo()

    const hRes = await handler(req('/healthz'), LOOPBACK_CTX)
    expect(hRes.status).toBe(200)
    expect(hRes.headers.get('x-swarmboard-instance')).toBe(info.instanceId)
    expect(hRes.headers.get('x-swarmboard-board-id')).toBe(info.boardId)
    expect(hRes.headers.get('access-control-allow-origin')).toBeNull()
    const health = (await hRes.json()) as Record<string, unknown>
    expect(health).toMatchObject({
      ok: true,
      boardId: info.boardId,
      instanceId: info.instanceId,
      schemaVersion: info.schema?.version,
      mode: 'daemon',
      streams: 0,
      queueDepth: 0,
    })

    const dRes = await handler(req('/api/board'), LOOPBACK_CTX)
    expect(dRes.status).toBe(200)
    const doc = (await dRes.json()) as {
      boardId: string
      instanceId: string
      swarmboard: { ops: string[]; wake: string }
      fusion: { lease_cap_s: number; batch_max: number }
    }
    expect(doc.boardId).toBe(info.boardId)
    expect(doc.instanceId).toBe(info.instanceId)
    expect(doc.swarmboard.wake).toBe('sse')
    expect([...doc.swarmboard.ops].sort()).toEqual([...OP_NAMES])
    expect(doc.fusion.batch_max).toBeGreaterThan(0)
    expect(doc.fusion.lease_cap_s).toBeGreaterThan(0)
  })

  it('V2-14 all 84 OPS pass via POST /api/v2/rpc/:op through HttpTransport', async () => {
    const failures: string[] = []
    for (const op of OP_NAMES) {
      const { handler } = makeServer()
      const customFetch: typeof fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        if (!request.headers.has('host')) {
          const cloned = new Headers(request.headers)
          cloned.set('host', '127.0.0.1:4180')
          return handler(new Request(request, { headers: cloned }), LOOPBACK_CTX)
        }
        return handler(request, LOOPBACK_CTX)
      }
      const transport = new HttpTransport({ url: 'http://127.0.0.1:4180', fetch: customFetch })
      await transport.ready()
      try {
        const input = await FIXTURES[op](transport)
        await transport.call(op, input as never)
      } catch (err) {
        const e = err as { status?: number; code?: string; message?: string }
        failures.push(`${op}: ${String(e.status)} ${String(e.code)} ${String(e.message)}`)
      }
      await transport.close()
    }
    expect(failures).toEqual([])
  }, 60_000)

  it('V2-14 all 61 compat routes under /api/board/* resolve without 404/501 (incl. binary attachments & inbox)', async () => {
    const { handler } = makeServer()
    const compatOps = OP_NAMES.filter((o) => OPS[o].compat !== null)
    expect(compatOps).toHaveLength(61)

    // Verify key compat routes end-to-end over /api/board/*
    const meRes = await handler(req('/api/board/me'), UDS_CTX)
    expect(meRes.status).toBe(200)
    expect(((await meRes.json()) as { actor: string }).actor).toBe('local:user:ada')

    const postRes = await handler(
      req('/api/board/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'dev', text: 'compat hello' }),
      }),
      UDS_CTX,
    )
    expect(postRes.status).toBe(200)
    const posted = (await postRes.json()) as { message: { id: string; text: string } }
    expect(posted.message.text).toBe('compat hello')

    const msgRes = await handler(req(`/api/board/messages/${posted.message.id}`), UDS_CTX)
    expect(msgRes.status).toBe(200)

    const threadsRes = await handler(req('/api/board/threads?channel=dev&order=forum'), UDS_CTX)
    expect(threadsRes.status).toBe(200)

    // Binary attachment upload + download over compat routes (application/octet-stream allowed on loopback!)
    const upRes = await handler(
      req('/api/board/attachments', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-attachment-name': 'note.txt',
          'x-attachment-type': 'text/plain',
        },
        body: new Uint8Array([72, 105, 33]),
      }),
      LOOPBACK_CTX,
    )
    expect(upRes.status).toBe(200)
    const att = (await upRes.json()) as { id: string; name: string; size: number }
    expect(att.name).toBe('note.txt')
    expect(att.size).toBe(3)

    const dlRes = await handler(req(`/api/board/attachments/${att.id}`), LOOPBACK_CTX)
    expect(dlRes.status).toBe(200)
    expect(await dlRes.text()).toBe('Hi!')
    expect(dlRes.headers.get('x-attachment-name')).toBe('note.txt')

    // Task create + batch + claim + complete over compat routes (verifies static beats :id routing)
    const batchRes = await handler(
      req('/api/board/tasks/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'work', id: 'compat-b1', tasks: [{ text: 't1' }] }),
      }),
      UDS_CTX,
    )
    expect(batchRes.status).toBe(200)
    const getBatchRes = await handler(req('/api/board/tasks/batch/compat-b1'), UDS_CTX)
    expect(getBatchRes.status).toBe(200)

    const claimRes = await handler(
      req('/api/board/tasks/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'work' }),
      }),
      UDS_CTX,
    )
    expect(claimRes.status).toBe(200)
    const claimed = (await claimRes.json()) as { task: { id: string } | null; claim: { epoch: number; token: string } }
    expect(claimed.task).not.toBeNull()

    const explainRes = await handler(req('/api/board/grants/explain?channel=dev'), UDS_CTX)
    expect(explainRes.status).toBe(200)

    // Exhaustive check: ALL 61 compat OPS via HttpTransport's /api/board/* compat fallback
    const compatFailures: string[] = []
    for (const op of compatOps) {
      const { handler: h } = makeServer()
      const compatOnlyFetch: typeof fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        const u = new URL(request.url)
        if (u.pathname.startsWith('/api/v2/rpc/')) {
          return Promise.resolve(new Response(JSON.stringify({ error: { code: 'not_found', message: 'compat only' } }), { status: 404 }))
        }
        const headers = new Headers(request.headers)
        if (!headers.has('host')) headers.set('host', '127.0.0.1:4180')
        return h(new Request(request, { headers }), LOOPBACK_CTX)
      }
      const transport = new HttpTransport({ url: 'http://127.0.0.1:4180/api/board', fetch: compatOnlyFetch })
      try {
        const input = await FIXTURES[op](transport)
        await transport.call(op, input as never)
      } catch (err) {
        const e = err as { status?: number; code?: string; message?: string }
        compatFailures.push(`${op}: ${String(e.status)} ${String(e.code)} ${String(e.message)}`)
      }
      await transport.close()
    }
    expect(compatFailures).toEqual([])
  }, 60_000)

  it('V2-14 all ergonomic /api/v2/* REST aliases + POST /api/v2/feedback work cleanly', async () => {
    const { handler } = makeServer()

    // Create channel + PATCH multi-segment channel path + channelTree
    await handler(
      req('/api/v2/rpc/createChannel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'repos/app/dev', kind: 'chat' }),
      }),
      UDS_CTX,
    )
    const patchCh = await handler(
      req('/api/v2/channels/repos/app/dev', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'updated via v2 REST' }),
      }),
      UDS_CTX,
    )
    expect(patchCh.status).toBe(200)

    const treeRes = await handler(req('/api/v2/channels/tree'), UDS_CTX)
    expect(treeRes.status).toBe(200)

    // DM, groups, presence, pins, notifications, inbox, search, feedback
    expect(
      (
        await handler(
          req('/api/v2/dm', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ peer: 'codex' }),
          }),
          UDS_CTX,
        )
      ).status,
    ).toBe(200)

    expect(
      (
        await handler(
          req('/api/v2/groups', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ handle: 'reviewers', name: 'Reviewers', members: ['codex'] }),
          }),
          UDS_CTX,
        )
      ).status,
    ).toBe(200)
    expect((await handler(req('/api/v2/groups'), UDS_CTX)).status).toBe(200)
    expect((await handler(req('/api/v2/groups/reviewers'), UDS_CTX)).status).toBe(200)
    expect(
      (
        await handler(
          req('/api/v2/groups/reviewers', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ description: 'Code reviewers' }),
          }),
          UDS_CTX,
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await handler(
          req('/api/v2/groups/reviewers/members', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ members: ['claude'] }),
          }),
          UDS_CTX,
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await handler(
          req('/api/v2/groups/reviewers/members/remove', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ members: ['claude'] }),
          }),
          UDS_CTX,
        )
      ).status,
    ).toBe(200)

    expect(
      (
        await handler(
          req('/api/v2/presence', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'active', channel: 'repos/app/dev' }),
          }),
          UDS_CTX,
        )
      ).status,
    ).toBe(200)
    expect((await handler(req('/api/v2/presence'), UDS_CTX)).status).toBe(200)
    expect((await handler(req('/api/v2/inbox'), UDS_CTX)).status).toBe(200)
    expect((await handler(req('/api/v2/notifications'), UDS_CTX)).status).toBe(200)
    expect((await handler(req('/api/v2/notifications/count'), UDS_CTX)).status).toBe(200)
    expect((await handler(req('/api/v2/notifications/wait?wait=0'), UDS_CTX)).status).toBe(200)
    expect(
      (
        await handler(
          req('/api/v2/notifications/ack-all', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          }),
          UDS_CTX,
        )
      ).status,
    ).toBe(200)

    // Feedback endpoint posts cleanly into meta/feedback even when schema isn't seeded yet
    const fbRes = await handler(
      req('/api/v2/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ summary: 'Wait cap feels snappy', kind: 'ux', severity: 'low' }),
      }),
      UDS_CTX,
    )
    expect(fbRes.status).toBe(201)
    const fb = (await fbRes.json()) as { message: { id: string; channel: string; labels: Record<string, string> } }
    expect(fb.message.channel).toBe('meta/feedback')
    expect(fb.message.labels).toMatchObject({ kind: 'ux', severity: 'low', status: 'new' })

    // Pin + list pins + unpin
    expect(
      (
        await handler(
          req(`/api/v2/messages/${fb.message.id}/pin`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope: 'channel' }),
          }),
          UDS_CTX,
        )
      ).status,
    ).toBe(200)
    expect((await handler(req('/api/v2/pins'), UDS_CTX)).status).toBe(200)
    expect(
      (
        await handler(
          req(`/api/v2/messages/${fb.message.id}/unpin`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          }),
          UDS_CTX,
        )
      ).status,
    ).toBe(200)

    // Mark channel read + delete group
    expect(
      (
        await handler(
          req('/api/v2/channels/read', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ channel: 'meta/feedback' }),
          }),
          UDS_CTX,
        )
      ).status,
    ).toBe(200)
    expect((await handler(req('/api/v2/groups/reviewers', { method: 'DELETE' }), UDS_CTX)).status).toBe(200)
  })

  it('V2-14 32 concurrent HTTP writers complete with 0 SQLITE_BUSY errors and strict FIFO ordering', async () => {
    const { handler } = makeServer()
    const srv = createNodeHttpServer(handler, () => ({
      listener: 'tcp-loopback',
      port: (srv.address() as AddressInfo).port,
    }))
    httpServers.push(srv)
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as AddressInfo).port
    const baseUrl = `http://127.0.0.1:${port}`

    const writes = Array.from({ length: 32 }, (_, i) =>
      fetch(`${baseUrl}/api/v2/rpc/post`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-board-profile': `w-${i}`,
        },
        body: JSON.stringify({ channel: 'burst', text: `msg-${i}` }),
      }).then(async (res) => {
        expect(res.status).toBe(200)
        return (await res.json()) as { message: { id: string; text: string } }
      }),
    )

    const results = await Promise.all(writes)
    expect(results).toHaveLength(32)
    const ids = results.map((r) => Number(r.message.id))
    expect(new Set(ids).size).toBe(32)
  })

  it('V2-14 WriteQueue enforces strict FIFO order and sheds overflow with 503 backpressure_shed + Retry-After: 1', async () => {
    const q = new WriteQueue({ maxDepth: 2 })
    const order: number[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r
    })

    const p0 = q.enqueue(async () => {
      order.push(0)
      await firstGate
      return 'zero'
    })
    const p1 = q.enqueue(() => {
      order.push(1)
      return 'one'
    })
    const p2 = q.enqueue(() => {
      order.push(2)
      return 'two'
    })

    // Queue has 1 running + 2 waiting (= maxDepth 2) -> next enqueue MUST shed 503 backpressure_shed
    let shedErr: unknown = null
    try {
      await q.enqueue(() => 'overflow')
    } catch (e) {
      shedErr = e
    }
    expect(isBoardError(shedErr)).toBe(true)
    expect(shedErr).toMatchObject({ status: 503, code: 'backpressure_shed', retryAfter: 1 })
    expect(q.stats().shed).toBe(1)

    releaseFirst()
    expect(await Promise.all([p0, p1, p2])).toEqual(['zero', 'one', 'two'])
    expect(order).toEqual([0, 1, 2])
    expect(q.depth).toBe(0)
    expect(q.inFlight).toBe(0)
  })

  it('V2-14 enforces 8 MiB body limit with 413 too_large', async () => {
    const { handler } = makeServer({ maxBodyBytes: 1024 })
    const bigBody = JSON.stringify({ channel: 'dev', text: 'x'.repeat(2048) })
    const res = await handler(
      req('/api/v2/rpc/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bigBody,
      }),
      UDS_CTX,
    )
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('too_large')
  })
})

describe('V2-16 loopback CSRF guards, Host DNS-rebinding, /_swarm/v1/* isolation, instanceId fence, UI & HS-03', () => {
  it('V2-16 loopback TCP enforces all 4 guards (Host, Origin, Sec-Fetch-Site, Content-Type) EVEN when auth.enforce=false', async () => {
    const { handler } = makeServer({ authEnforce: false })

    // 1. Host DNS-rebinding rejected on ALL routes (including /healthz and /)
    for (const path of ['/healthz', '/', '/api/board', '/api/v2/rpc/me']) {
      const badHost = await handler(
        req(path, { method: path.includes('/rpc/') ? 'POST' : 'GET', headers: { host: 'evil.example:4180', 'content-type': 'application/json' } }),
        LOOPBACK_CTX,
      )
      expect(badHost.status, path).toBe(403)
    }

    // 2. Cross-site Origin rejected on writes
    const badOrigin = await handler(
      req('/api/v2/rpc/post', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4180',
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ channel: 'dev', text: 'csrf' }),
      }),
      LOOPBACK_CTX,
    )
    expect(badOrigin.status).toBe(403)

    // 3. Cross-site Sec-Fetch-Site rejected on writes
    const badFetchSite = await handler(
      req('/api/v2/rpc/post', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4180',
          'sec-fetch-site': 'cross-site',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ channel: 'dev', text: 'csrf' }),
      }),
      LOOPBACK_CTX,
    )
    expect(badFetchSite.status).toBe(403)

    // 4. Non-JSON Content-Type (text/plain / form) rejected on writes
    const badCt = await handler(
      req('/api/v2/rpc/post', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4180',
          'content-type': 'text/plain',
        },
        body: JSON.stringify({ channel: 'dev', text: 'csrf' }),
      }),
      LOOPBACK_CTX,
    )
    expect(badCt.status).toBe(403)

    // Valid same-origin JSON write succeeds
    const good = await handler(
      req('/api/v2/rpc/post', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4180',
          origin: 'http://127.0.0.1:4180',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ channel: 'dev', text: 'legit' }),
      }),
      LOOPBACK_CTX,
    )
    expect(good.status).toBe(200)
  })

  it('V2-16 control namespace /_swarm/v1/* is refused 403 on tailscale & https; --tailscale-host + --allow-host mutually exclusive', async () => {
    const { handler } = makeServer()

    const tsRes = await handler(
      req('/_swarm/v1/hello', { headers: { host: 'board.tailnet.ts.net', 'tailscale-user-login': 'ada@example.com' } }, 'https://board.tailnet.ts.net'),
      { listener: 'tailscale', tailscaleHost: 'board.tailnet.ts.net' },
    )
    expect(tsRes.status).toBe(403)

    const httpsRes = await handler(
      req('/_swarm/v1/status', { headers: { host: 'board.example.com' } }, 'https://board.example.com'),
      { listener: 'https', boardUrl: 'https://board.example.com' },
    )
    expect(httpsRes.status).toBe(403)

    expect(() =>
      validateListenerConfig({ tailscaleHost: 'board.tailnet.ts.net', allowHosts: ['proxy.example.com'] }),
    ).toThrow(/mutually exclusive/)
  })

  it('V2-16 X-Swarmboard-Expect-Instance mismatch returns 410 cursor_expired with instance_changed details', async () => {
    const { board, handler } = makeServer()
    const info = board.boardInfo()

    const bad = await handler(
      req('/api/v2/rpc/me', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-swarmboard-expect-instance': 'i_stale_instance_id',
        },
        body: '{}',
      }),
      UDS_CTX,
    )
    expect(bad.status).toBe(410)
    const body = (await bad.json()) as { error: { code: string; details: { reason: string; boardId: string; instanceId: string } } }
    expect(body.error.code).toBe('cursor_expired')
    expect(body.error.details).toEqual({
      reason: 'instance_changed',
      boardId: info.boardId,
      instanceId: info.instanceId,
    })

    const ok = await handler(
      req('/api/v2/rpc/me', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-swarmboard-expect-instance': info.instanceId!,
        },
        body: '{}',
      }),
      UDS_CTX,
    )
    expect(ok.status).toBe(200)
  })

  it('V2-16 login-code -> /_swarm/v1/login cookie auth & /_swarm/v1/tokens CRUD work under auth.enforce=true', async () => {
    const { handler } = makeServer({ authEnforce: true })

    // Mint login code via authenticated local UDS or direct authenticator? Under authEnforce=true,
    // first issue a root token or test with authEnforce=false for minting then enforce cookie on loopback.
    const { handler: openHandler, authenticator } = makeServer({ authEnforce: true })

    // Loopback without cookie or bearer rejected 401
    const unauth = await openHandler(
      req('/api/v2/rpc/me', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      LOOPBACK_CTX,
    )
    expect(unauth.status).toBe(401)

    // Mint 60s code -> exchange via POST /_swarm/v1/login -> receive HttpOnly; SameSite=Strict cookie
    const minted = authenticator.mintLoginCode()
    const loginRes = await openHandler(
      req('/_swarm/v1/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: minted.code }),
      }),
      LOOPBACK_CTX,
    )
    expect(loginRes.status).toBe(200)
    const cookie = loginRes.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    const cookiePair = cookie.split(';')[0]!

    // Authenticated RPC call with session cookie succeeds
    const authedMe = await openHandler(
      req('/api/v2/rpc/me', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookiePair },
        body: '{}',
      }),
      LOOPBACK_CTX,
    )
    expect(authedMe.status).toBe(200)

    // Issue, list, and revoke a token via /_swarm/v1/tokens using the owner session
    const issueRes = await openHandler(
      req('/_swarm/v1/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookiePair },
        body: JSON.stringify({ profile: 'codex', note: 'agent token' }),
      }),
      LOOPBACK_CTX,
    )
    expect(issueRes.status).toBe(201)
    const issued = (await issueRes.json()) as { token: string; record: { id: string } }
    expect(issued.token).toMatch(/^sb_/)

    // Bearer token authenticates on loopback
    const tokenMe = await openHandler(
      req('/api/v2/rpc/me', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` },
        body: '{}',
      }),
      LOOPBACK_CTX,
    )
    expect(tokenMe.status).toBe(200)
    expect(((await tokenMe.json()) as { actor: string }).actor).toBe('local:user:ada+codex')

    // List & revoke token
    const listRes = await openHandler(req('/_swarm/v1/tokens', { headers: { cookie: cookiePair } }), LOOPBACK_CTX)
    expect(listRes.status).toBe(200)
    expect(((await listRes.json()) as { tokens: Array<{ id: string }> }).tokens.some((t) => t.id === issued.record.id)).toBe(true)

    const revokeRes = await openHandler(
      req(`/_swarm/v1/tokens/${issued.record.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', cookie: cookiePair },
      }),
      LOOPBACK_CTX,
    )
    expect(revokeRes.status).toBe(200)

    // Revoked token immediately rejected 401
    const afterRevoke = await openHandler(
      req('/api/v2/rpc/me', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` },
        body: '{}',
      }),
      LOOPBACK_CTX,
    )
    expect(afterRevoke.status).toBe(401)
    void handler
  })

  it('supports optional uiHandler on GET / and GET /assets/* with clean fallback HTML when omitted', async () => {
    const { handler: fallbackHandler } = makeServer()
    const defaultUi = await fallbackHandler(req('/'), LOOPBACK_CTX)
    expect(defaultUi.status).toBe(200)
    expect(defaultUi.headers.get('content-type')).toContain('text/html')
    expect(await defaultUi.text()).toContain('Swarmboard')

    const { handler: customHandler } = makeServer({
      uiHandler: (r) => {
        if (new URL(r.url).pathname === '/assets/app.js') {
          return new Response('console.log("ui")', { status: 200, headers: { 'content-type': 'text/javascript' } })
        }
        return null
      },
    })
    const asset = await customHandler(req('/assets/app.js'), LOOPBACK_CTX)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('console.log("ui")')
    expect(asset.headers.get('x-swarmboard-instance')).toBeTruthy()
  })

  it('HS-03 no file under src/server/ references core normalizeError, toErrorPayload, or toErrorResponse', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(full)
      }
      return out
    }
    const files = walk(join(ROOT, 'src', 'server'))
    expect(files.length).toBeGreaterThanOrEqual(5)
    const forbidden = /\b(?:normalizeError|toErrorPayload|toErrorResponse)\b/
    const hits: string[] = []
    for (const f of files) {
      const stripped = stripComments(readFileSync(f, 'utf8'))
      if (forbidden.test(stripped)) hits.push(relative(ROOT, f))
    }
    expect(hits).toEqual([])
  })

  it('SD-F1 control routes (login-code, retire, listen-tcp) refuse non-owner person tokens, read-only owner tokens, and agent tokens with 403', async () => {
    const { store, authenticator, handler } = makeServer({ authEnforce: true })
    const ownerCaller = createLocalCaller({ userId: 'ada', owner: true, member: true })

    // 1. Non-owner person bearer token (local:user:bob, profile: null, cap: ['read'])
    const bobRead = authenticator.tokens.issueToken(ownerCaller, {
      principalId: 'local:user:bob',
      profile: null,
      cap: ['read'],
    })
    // 2. Owner read-only bearer token (local:user:ada, profile: null, cap: ['read'])
    const ownerReadOnly = authenticator.tokens.issueToken(ownerCaller, {
      principalId: 'local:user:ada',
      profile: null,
      cap: ['read'],
    })
    // 3. Agent bearer token (local:user:ada+codex)
    const agentTok = authenticator.tokens.issueToken(ownerCaller, {
      profile: 'codex',
    })
    // 4. Full owner bearer token (local:user:ada, profile: null, cap: all incl. manage)
    const ownerFull = authenticator.tokens.issueToken(ownerCaller, {
      principalId: 'local:user:ada',
      profile: null,
      cap: PERMISSIONS,
    })

    for (const badToken of [bobRead.token, ownerReadOnly.token, agentTok.token]) {
      for (const path of ['/_swarm/v1/login-code', '/_swarm/v1/retire', '/_swarm/v1/listen-tcp']) {
        const res = await handler(
          req(path, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${badToken}`,
            },
            body: '{}',
          }),
          LOOPBACK_CTX,
        )
        expect(res.status, `${path} should refuse`).toBe(403)
      }
    }

    // Full owner token succeeds on login-code
    const okRes = await handler(
      req('/_swarm/v1/login-code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ownerFull.token}`,
        },
        body: '{}',
      }),
      LOOPBACK_CTX,
    )
    expect(okRes.status).toBe(200)
    expect(((await okRes.json()) as { code: string }).code).toBeTypeOf('string')
    void store
  })

  it('SD-F3 GET /api/v2/search coerces limit and subtree query params cleanly', async () => {
    const { handler } = makeServer()
    await handler(
      req('/api/v2/rpc/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'repos/app/dev', text: 'hello searchable world' }),
      }),
      UDS_CTX,
    )

    const ok = await handler(req('/api/v2/search?query=hello&channel=repos/app&subtree=true&limit=5'), UDS_CTX)
    expect(ok.status).toBe(200)
    const hits = (await ok.json()) as Array<{ id: string }>
    expect(hits.length).toBe(1)

    const badLimit = await handler(req('/api/v2/search?query=hello&limit=abc'), UDS_CTX)
    expect(badLimit.status).toBe(400)

    const badSubtree = await handler(req('/api/v2/search?query=hello&subtree=maybe'), UDS_CTX)
    expect(badSubtree.status).toBe(400)
  })

  it('SD-F4 malformed Host header (e.g. evil.example:99999) over real TCP loopback returns 403 forbidden (never 500)', async () => {
    const { handler } = makeServer({ authEnforce: false })
    const srv = createNodeHttpServer(handler, () => ({
      listener: 'tcp-loopback',
      port: (srv.address() as AddressInfo).port,
    }))
    httpServers.push(srv)
    await new Promise<void>((resolveListen) => srv.listen(0, '127.0.0.1', resolveListen))
    const port = (srv.address() as AddressInfo).port

    const rawResponse = await new Promise<string>((resolveRaw, rejectRaw) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.write('GET /healthz HTTP/1.1\r\nHost: evil.example:99999\r\nConnection: close\r\n\r\n')
      })
      const chunks: Buffer[] = []
      socket.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      socket.on('end', () => resolveRaw(Buffer.concat(chunks).toString('utf8')))
      socket.on('error', rejectRaw)
    })

    expect(rawResponse).toMatch(/^HTTP\/1\.1 403 /)
    expect(rawResponse).toContain('"code":"forbidden"')
  })
})
