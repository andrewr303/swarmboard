// HS-93..HS-98, HS-55 (client.ts): BoardClient facade, sugar shapes, as() views, wait/waitPage/pages/events/poll,
// capability/gated 501 pre-call guards, tasks facade, expectInstance propagation, and thin import boundary.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  type BoardEventView,
  type EventsPage,
} from '../../src/core/public.ts'
import { createBoardClient, duration, type BoardClient } from '../../src/client/client.ts'
import { isBoardError } from '../../src/client/errors.ts'
import { localIdentity } from '../../src/client/identity.ts'
import { OPS, type OpInput, type OpName, type OpOutput } from '../../src/client/ops.ts'
import { InProcessTransport } from '../../src/client/transport-inproc.ts'
import type { BoardTransport, CallOptions, Capabilities, EventsFeedQuery, Selection } from '../../src/client/types.ts'
import { importGraph } from '../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const BASE_SEL: Selection = { mode: 'in-process', reason: 'test', source: 'option:service' }

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    await fn()
  }
})

function setupBoard(opts?: { member?: boolean; owner?: boolean; profiles?: readonly string[] | '*' }) {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  const service = new BoardService(store)
  const identity = localIdentity({
    userId: 'ada',
    handle: 'ada',
    name: 'Ada',
    member: opts?.member ?? true,
    owner: opts?.owner ?? true,
    profiles: opts?.profiles ?? ['w1', 'w2'],
    defaultProfile: 'w1',
  })
  const transport = new InProcessTransport({ board: service, identity })
  const client = createBoardClient(transport, { selection: BASE_SEL })
  cleanups.push(async () => {
    await client.close()
    store.close()
  })
  return { store, service, identity, transport, client }
}

interface SpyRecord {
  kind: 'call' | 'events'
  op: string
  input: unknown
  opts: CallOptions | undefined
}

function spyTransport(inner: BoardTransport): { spy: BoardTransport; calls: SpyRecord[] } {
  const calls: SpyRecord[] = []
  const spy: BoardTransport = {
    get capabilities() {
      return inner.capabilities
    },
    get closed() {
      return inner.closed
    },
    call<O extends OpName>(op: O, input: OpInput<O>, opts?: CallOptions): Promise<OpOutput<O>> {
      calls.push({ kind: 'call', op, input, opts })
      return inner.call(op, input, opts)
    },
    events(query: EventsFeedQuery, opts?: CallOptions): AsyncIterable<EventsPage> {
      calls.push({ kind: 'events', op: 'events', input: query, opts })
      return inner.events(query, opts)
    },
    close() {
      return inner.close()
    },
  }
  return { spy, calls }
}

async function expectError(fn: () => unknown, match: { status: number; code: string; message?: RegExp }) {
  try {
    await fn()
    expect.unreachable(`expected throw ${match.status} ${match.code}`)
  } catch (e) {
    expect(isBoardError(e), String(e)).toBe(true)
    if (!isBoardError(e)) return
    expect(e.status).toBe(match.status)
    expect(e.code).toBe(match.code)
    if (match.message) expect(e.message).toMatch(match.message)
    return e
  }
}

describe('HS-55 src/client/client.ts thin import boundary', () => {
  it('HS-55 resolves nothing under src/core and no zod, with <= 15 edges (only errors.ts and ops.ts)', async () => {
    const file = join(ROOT, 'src', 'client', 'client.ts')
    const asUrl = (p: string): string => new URL(`file://${p}`).href
    const edges = await importGraph([file])
    const ownEdges = edges.filter(([parent]) => parent === asUrl(file))
    expect(ownEdges.length).toBeLessThanOrEqual(15)
    for (const [, child] of ownEdges) {
      expect(child).not.toContain('/src/core/')
      expect(child).not.toMatch(/\/node_modules\/(\.pnpm\/[^/]*\/node_modules\/)?zod\//)
    }
    const targets = ownEdges.map(([, c]) => c.slice(c.lastIndexOf('/') + 1)).sort()
    expect(targets).toEqual(['errors.ts', 'ops.ts'])
  }, 60_000)
})

describe('HS-93 facade shapes vs the original handle', () => {
  it('HS-93 post, reply, edit, delete, react, label, posted, thread, threads, channels, actors', async () => {
    const { client, service } = setupBoard()

    // actors() returns an array
    const actorsList = await client.actors()
    expect(Array.isArray(actorsList)).toBe(true)

    // post without @handle has NO mentions key
    const p1 = await client.post('dev', { text: 'hello world', id: 'p-1', labels: { kind: 'note' } })
    expect(p1.id).toBeTypeOf('string')
    expect(p1.text).toBe('hello world')
    expect('mentions' in p1).toBe(false)

    // posted(id) returns MessageView directly
    const byId = await client.posted('p-1')
    expect(byId.id).toBe(p1.id)
    expect(byId.text).toBe('hello world')

    // post with @handle includes mentions at top level
    const bob = createLocalCaller({ userId: 'bob', handle: 'bob', name: 'Bob', profile: 'w1' })
    service.postMessage(bob, { channel: 'dev', text: 'hi from bob' })
    const p2 = await client.post('dev', 'hey @bob look')
    expect(p2.mentions).toBeDefined()
    expect(p2.mentions!.length).toBeGreaterThan(0)

    // reply sends re
    const r1 = await client.reply(p1.id, 'reply text')
    expect(r1.re).toBe(p1.id)
    expect(r1.text).toBe('reply text')

    // edit returns { ok: true, message, mentions? } with no mentions inside message
    const ed = await client.edit(p1.id, 'edited @bob')
    expect(ed.ok).toBe(true)
    expect(ed.message.text).toContain('edited')
    expect('mentions' in ed.message).toBe(false)
    expect(ed.mentions).toBeDefined()

    // react & label return { ok: true, message }
    const rx = await client.react(p1.id, '+1')
    expect(rx.ok).toBe(true)
    expect(Object.keys(rx.message.reactions).length).toBe(1)

    const lb = await client.label(p1.id, { set: { status: 'triaged' } })
    expect(lb.ok).toBe(true)
    expect(lb.message.labels.status).toBe('triaged')

    // thread & threads (with Record label filter) & channel(name).messages & channels
    const th = await client.thread(p1.id)
    expect(th.message.id).toBe(p1.id)
    expect(th.replies).toHaveLength(1)

    const ths = await client.threads({ channel: 'dev', label: { status: 'triaged' } })
    expect(ths.threads.map((t) => t.message.id)).toContain(p1.id)

    const chPage = await client.channel('dev').messages()
    expect(chPage.messages.length).toBeGreaterThanOrEqual(2)

    const chans = await client.channels()
    expect(chans.next === null || typeof chans.next === 'string').toBe(true)
    expect(chans.channels.some((c) => c.path === 'dev')).toBe(true)

    // delete returns { ok: true, message }
    const del = await client.delete(r1.id)
    expect(del.ok).toBe(true)
    expect(del.message.deleted).toBe(true)
  })

  it('HS-93 createChannel forwards metadata & private:true; createSchema strips created', async () => {
    const { transport } = setupBoard()
    const { spy, calls } = spyTransport(transport)
    const client = createBoardClient(spy, { selection: BASE_SEL })

    const priv = await client.createChannel('priv', {
      private: true,
      topic: 'restricted room',
      kind: 'chat',
      members: ['local:user:bob'],
      as: 'w2',
    })
    expect(priv).toMatchObject({
      channel: { path: 'priv', private: true, topic: 'restricted room', kind: 'chat' },
      created: true,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('createChannel')
    expect(calls[0]!.input).toEqual({
      path: 'priv',
      private: true,
      topic: 'restricted room',
      kind: 'chat',
      members: ['local:user:bob'],
    })
    expect(calls[0]!.opts).toEqual({ as: 'w2' })

    const made = await client.createChannel('pub')
    expect(made).toMatchObject({ channel: { path: 'pub' }, created: true })
    expect(calls[1]!.input).toEqual({ path: 'pub' })

    const sch = await client.createSchema({
      name: 'note',
      version: 1,
      schema: { type: 'object', properties: { title: { type: 'string' } } },
    })
    expect(sch.created).toBe(true)
    expect(sch.schema.id).toBe('note@1')
    expect('created' in sch.schema).toBe(false)

    const listed = await client.schemas()
    expect(listed.some((s) => s.id === 'note@1')).toBe(true)
    const single = await client.schema('note@1')
    expect(single.id).toBe('note@1')
  })

  it('HS-93 grants (wireCan, withEnvironments, explain), schedules, attachments, watchers, sync & inbox, search', async () => {
    const { client } = setupBoard()

    // createGrant / createGrants / updateGrant / explain / grants / revokeGrant
    const g1 = await client.createGrant({
      principals: [{ kind: 'project', project: 'prj_1' }],
      can: { 'secret/': 'none', 'dev/': ['read', 'post'] },
    })
    expect(g1.grant.id).toBeTypeOf('string')
    expect(g1.grant.can['secret/']).toEqual([])
    expect(g1.grant.principals[0]).toMatchObject({ kind: 'project', projectId: 'prj_1', environments: ['production'] })

    const gBatch = await client.createGrants([
      { principals: [{ kind: 'all-projects' }], can: { 'open/': ['read'] } },
    ])
    expect(gBatch.grants).toHaveLength(1)

    const gUp = await client.updateGrant(g1.grant.id, {
      add: [{ kind: 'user', userId: 'carl' }],
      can: { 'secret/': 'none', 'dev/': 'all' },
    })
    expect(gUp.grant.can['dev/']).toBe('all')

    const exp = await client.explain('dev', { oidc: 'https://issuer.example', claims: { sub: 'u1' } })
    expect(exp.channel).toBe('dev')

    const allGrants = await client.grants()
    expect(allGrants.some((g) => g.id === g1.grant.id)).toBe(true)

    const rev = await client.revokeGrant(g1.grant.id)
    expect(rev.revoked).toBe(true)

    // schedule, schedules, cancelSchedule (with Date conversion)
    const future = new Date(Date.now() + 60_000)
    const sc = await client.schedule('dev', { text: 'scheduled hi', at: future })
    expect(sc.id).toBeTypeOf('string')
    expect((await client.schedules()).some((s) => s.id === sc.id)).toBe(true)
    expect((await client.cancelSchedule(sc.id)).canceled).toBe(true)

    // upload & attachment & post with Attachment object
    const bytes = new Uint8Array([1, 2, 3, 4])
    const att = await client.upload({ data: bytes, name: 'data.bin', type: 'application/octet-stream' })
    expect(att.id).toBeTypeOf('string')
    const dl = await client.attachment(att.id)
    expect(dl.meta.id).toBe(att.id)
    expect(new Uint8Array(dl.data)).toEqual(bytes)
    const msgWithAtt = await client.post('dev', { text: 'file attached', attachments: [att] })
    expect(msgWithAtt.attachments).toHaveLength(1)

    // register, watchers, sync & inbox
    const reg = await client.register({
      watch: { w1: { tail: 'dev' } },
      sync: [{ key: 'slack', platform: 'slack' }],
    })
    expect(reg.owner).toBe('local:user:ada')
    expect((await client.watchers()).length).toBeGreaterThanOrEqual(1)

    await client.createGrant({ principals: [{ kind: 'user', userId: 'ada' }], can: { '*': ['sync'] } })
    const syncedRes = await client.sync(msgWithAtt.id, 'slack:#general')
    expect(syncedRes).toEqual({ target: 'slack:#general', attached: true })
    const syncedView = await client.sync(msgWithAtt.id)
    expect(syncedView.targets.some((t) => t.target === 'slack:#general')).toBe(true)

    const copies = await client.syncCopies([msgWithAtt.id])
    expect(copies[msgWithAtt.id]).toBeDefined()
    expect('copies' in copies).toBe(false)

    const pushed = await client.inboxPush('slack', [
      {
        id: 'ev_1',
        event: {
          kind: 'message',
          channel: 'slack:C1',
          thread: 'slack:C1:1',
          subthread: null,
          message: '1',
          isRoot: true,
          text: 'hello',
          context: null,
          author: { id: 'U1', handle: 'u1', name: 'U1', avatar: null, isBot: false },
        },
        raw: { ts: '1' },
      },
    ])
    expect(pushed).toEqual({ ok: true, accepted: 1 })
    const inboxEntries = await client.inbox('slack')
    expect(inboxEntries).toHaveLength(1)
    const pulled = await client.inboxNext('slack', { limit: 5 })
    expect(pulled).toHaveLength(1)
    const acked = await client.inboxAck('slack', pulled[0]!.id, { lease: pulled[0]!.lease })
    expect(acked).toEqual({ ok: true })

    const imp = await client.syncImport({
      op: 'post',
      author: { id: 'slack:U1', handle: 'u1', name: 'U1', avatar: null, isBot: false },
      from: 'slack',
      origin: { channel: 'slack:C1', thread: 'slack:C1:2', subthread: null, message: '2', context: null },
      channel: 'dev',
      text: 'imported msg',
    })
    expect(imp.message?.id).toBeTypeOf('string')

    const rcpt = await client.syncReceipt({
      kind: 'message',
      message: msgWithAtt.id,
      target: 'slack:#general',
      external: { thread: 'slack:C1:3', message: '3' },
    })
    expect(rcpt.ok).toBe(true)

    const sThread = await client.syncThread(msgWithAtt.thread)
    expect(sThread.root).toBe(msgWithAtt.id)
    const sFind = await client.syncFind({ thread: 'slack:C1:3', message: '3' })
    expect(sFind.message).toBe(msgWithAtt.id)

    await client.post('dev', 'trigger watcher')
    const ms = await client.matches({ limit: 5 })
    expect(ms.length).toBeGreaterThanOrEqual(1)
    expect(await client.ack(ms[0]!.id, { lease: ms[0]!.lease })).toEqual({ ok: true })

    const hits = await client.search({ query: 'imported' })
    expect(hits.length).toBeGreaterThanOrEqual(1)

    // createChannel with { private: false } works and strips private
    expect(await client.createChannel('pub2', { private: false })).toMatchObject({
      channel: { path: 'pub2' },
      created: true,
    })

    // schedule({ re }, { until: Date })
    const pForSched = await client.post('dev', 'thread root')
    const scReply = await client.schedule(
      { re: pForSched.id },
      { text: 'repeating reply', every: '1h', until: new Date(Date.now() + 7_200_000) },
    )
    expect(scReply.re).toBe(pForSched.id)
    await client.cancelSchedule(scReply.id)
  })

  it('HS-93 schedule() with invalid Date in at or until rejects as 400 invalid_request Promise (no sync throw, no raw RangeError)', async () => {
    const { transport } = setupBoard()
    const { spy, calls } = spyTransport(transport)
    const client = createBoardClient(spy, { selection: BASE_SEL })

    let badAtPromise: Promise<unknown> | undefined
    expect(() => {
      badAtPromise = client.schedule('dev', { text: 'bad at', at: new Date('not-a-date') })
    }).not.toThrow()
    expect(badAtPromise).toBeInstanceOf(Promise)
    const errAt = await badAtPromise!.catch((e: unknown) => e)
    expect(isBoardError(errAt)).toBe(true)
    expect(errAt).not.toBeInstanceOf(RangeError)
    expect(errAt).toMatchObject({ status: 400, code: 'invalid_request', origin: 'handle' })
    expect((errAt as Error).message).toMatch(/at/)

    let badUntilPromise: Promise<unknown> | undefined
    expect(() => {
      badUntilPromise = client.schedule('dev', { text: 'bad until', every: '1h', until: new Date(Number.NaN) })
    }).not.toThrow()
    expect(badUntilPromise).toBeInstanceOf(Promise)
    const errUntil = await badUntilPromise!.catch((e: unknown) => e)
    expect(isBoardError(errUntil)).toBe(true)
    expect(errUntil).not.toBeInstanceOf(RangeError)
    expect(errUntil).toMatchObject({ status: 400, code: 'invalid_request', origin: 'handle' })
    expect((errUntil as Error).message).toMatch(/until/)

    expect(calls).toHaveLength(0)
  })
})

describe('HS-94 as(profile) views and close()', () => {
  it('HS-94 as() switches profile, shares raw/caps/selection, validates name, and closes raw', async () => {
    const { client } = setupBoard()
    expect((await client.me()).actor).toBe('local:user:ada+w1')

    const w2 = client.as('w2')
    expect(w2.profile).toBe('w2')
    expect((await w2.me()).actor).toBe('local:user:ada+w2')
    // Original client view unchanged
    expect((await client.me()).actor).toBe('local:user:ada+w1')
    expect(w2.raw).toBe(client.raw)
    expect(w2.caps).toBe(client.caps)
    expect(w2.selection).toBe(client.selection)

    // as(null) acts as principal itself
    const rootView = client.as(null)
    const rootMe = await rootView.me()
    expect(rootMe.profile).toBeNull()
    expect(rootMe.actor).toBe('local:user:ada')

    // explicit opts.as overrides view profile
    expect((await w2.me({ as: 'w1' })).actor).toBe('local:user:ada+w1')
    expect((await w2.me({ as: null })).actor).toBe('local:user:ada')

    // invalid profile throws synchronously 400 invalid_profile
    expect(() => client.as('bad_name')).toThrow()
    try {
      client.as('bad_name')
    } catch (e) {
      expect(isBoardError(e)).toBe(true)
      if (isBoardError(e)) {
        expect(e.status).toBe(400)
        expect(e.code).toBe('invalid_profile')
      }
    }

    // closing any view closes raw
    await w2.close()
    expect(client.raw.closed).toBe(true)
    await expectError(() => client.me(), { status: 503, code: 'unavailable' })
  })
})

describe('HS-95 wait, waitPage, pages, events, poll', () => {
  it('HS-95 waitPage and wait timings, immediate after, abort, and TypeScript signatures', async () => {
    const { client, service } = setupBoard()
    const bob = createLocalCaller({ userId: 'bob', handle: 'bob', name: 'Bob', profile: 'w1' })

    // waitPage timeout on quiet board in [200, 450) ms
    const t0 = Date.now()
    const quietPage = await client.waitPage({ timeoutS: 0.2 })
    const dt0 = Date.now() - t0
    expect(quietPage.events).toEqual([])
    expect(quietPage.cursor).toBeTypeOf('string')
    expect(dt0).toBeGreaterThanOrEqual(180)
    expect(dt0).toBeLessThan(450)

    // waitPage wakes promptly when post arrives 50 ms in
    const t1 = Date.now()
    setTimeout(() => service.postMessage(bob, { channel: 'dev', text: 'wake page' }), 50)
    const wokePage = await client.waitPage({ timeoutS: 5 })
    const dt1 = Date.now() - t1
    expect(wokePage.events).toHaveLength(1)
    expect(wokePage.events[0]!.message?.text).toBe('wake page')
    expect(dt1).toBeLessThan(250)

    // wait timeout on quiet board -> null in [200, 450) ms
    const t2 = Date.now()
    const quietWait = await client.wait({}, { timeout: '200ms' })
    const dt2 = Date.now() - t2
    expect(quietWait).toBeNull()
    expect(dt2).toBeGreaterThanOrEqual(180)
    expect(dt2).toBeLessThan(450)

    // wait wakes promptly on post 50 ms in -> BoardEventView
    const beforeCursor = (await client.poll()).cursor
    setTimeout(() => service.postMessage(bob, { channel: 'dev', text: 'wake wait' }), 50)
    const wokeEv = await client.wait({}, { timeout: 5_000 })
    expect(wokeEv).not.toBeNull()
    expect(wokeEv!.message?.text).toBe('wake wait')

    // wait({ after }) with event already present returns at once
    const t3 = Date.now()
    const atOnce = await client.wait({ after: beforeCursor })
    expect(atOnce).not.toBeNull()
    expect(atOnce!.message?.text).toBe('wake wait')
    expect(Date.now() - t3).toBeLessThan(100)

    // Bad durations / timeoutS -> 400 invalid_request
    expect(() => duration('bogus')).toThrow()
    await expectError(() => client.wait({}, { timeout: 'bogus' }), { status: 400, code: 'invalid_request' })
    await expectError(() => client.wait({}, { timeout: -5 }), { status: 400, code: 'invalid_request' })
    await expectError(() => client.waitPage({ timeoutS: -1 }), { status: 400, code: 'invalid_request' })
    await expectError(() => client.waitPage({ timeoutS: Number.NaN }), { status: 400, code: 'invalid_request' })

    // TypeScript compile-time assertions for original handle signatures (HS-95)
    const _compileCheck = async (c: BoardClient, sig: AbortSignal): Promise<[BoardEventView | null, BoardEventView | null]> => {
      const a: BoardEventView | null = await c.wait({ channel: 'dev' }, { timeout: '5m' })
      const b: BoardEventView | null = await c.wait({}, { timeout: 30_000, signal: sig })
      return [a, b]
    }
    expect(_compileCheck).toBeTypeOf('function')
    const ac = new AbortController()
    ac.abort()
    expect(await client.wait({ channel: 'dev' }, { timeout: '5m', signal: ac.signal })).toBeNull()
    expect(await client.wait({}, { timeout: 30_000, signal: ac.signal })).toBeNull()
    const _sigCheck3: Promise<EventsPage> = client.waitPage({ timeoutS: 0.05 }, { signal: ac.signal })
    expect((await _sigCheck3).events).toEqual([])
  })

  it('HS-95 pages() and events() iterate and clean up on break', async () => {
    const { client } = setupBoard()
    await client.post('dev', 'm1')
    await client.post('dev', 'm2')

    const seen: BoardEventView[] = []
    for await (const ev of client.events({ last: 2 })) {
      seen.push(ev)
      if (seen.length === 2) break
    }
    expect(seen).toHaveLength(2)
  })
})

describe('HS-96 capability and gated-field 501 pre-call checks', () => {
  it('HS-96 gated input field and missing op in caps.ops reject 501 with 0 transport calls', async () => {
    const { transport } = setupBoard()
    const { spy, calls } = spyTransport(transport)

    const opsOverride = {
      ...OPS,
      claimReadyTask: {
        ...OPS.claimReadyTask,
        gated: { resume: 'resume' as const },
      },
    } as unknown as typeof OPS

    const client = createBoardClient(spy, { selection: BASE_SEL, opsOverride })
    const err = await expectError(
      () => client.call('claimReadyTask', { channel: 'q', resume: true } as unknown as OpInput<'claimReadyTask'>),
      { status: 501, code: 'not_supported', message: /resume/ },
    )
    expect(err?.message).toContain('resume')
    expect(calls).toHaveLength(0)

    // Stub transport omitting 'search' from caps.ops
    const filteredOps = transport.capabilities.ops.filter((o) => o !== 'search')
    const limitedCaps: Capabilities = Object.freeze({ ...transport.capabilities, ops: Object.freeze(filteredOps) })
    const limitedTransport: BoardTransport = {
      get capabilities() {
        return limitedCaps
      },
      get closed() {
        return spy.closed
      },
      call: spy.call,
      events: spy.events,
      close: spy.close,
    }
    const limitedClient = createBoardClient(limitedTransport, { selection: BASE_SEL })
    await expectError(() => limitedClient.search({ query: 'hi' }), { status: 501, code: 'not_supported' })
    await expectError(() => limitedClient.call('search', { query: 'hi' }), { status: 501, code: 'not_supported' })
    expect(calls).toHaveLength(0)
  })

  it('HS-96 501 refusals from call(), facade ops, and v2 ops return rejected Promises (never throw synchronously)', async () => {
    const { transport } = setupBoard()
    const { spy, calls } = spyTransport(transport)

    const opsOverride = {
      ...OPS,
      claimReadyTask: {
        ...OPS.claimReadyTask,
        gated: { resume: 'resume' as const },
      },
    } as unknown as typeof OPS

    const filteredOps = transport.capabilities.ops.filter((o) => o !== 'search' && o !== 'agentInbox')
    const limitedCaps: Capabilities = Object.freeze({ ...transport.capabilities, ops: Object.freeze(filteredOps) })
    const limitedTransport: BoardTransport = {
      get capabilities() {
        return limitedCaps
      },
      get closed() {
        return spy.closed
      },
      call: spy.call,
      events: spy.events,
      close: spy.close,
    }
    const client = createBoardClient(limitedTransport, { selection: BASE_SEL, opsOverride })

    // None of these may throw synchronously; each returns a rejected Promise compatible with .catch() and Promise.allSettled().
    const pMissingCall = client.call('search', { query: 'hi' })
    const pMissingFacade = client.search({ query: 'hi' })
    const pMissingV2 = client.agentInbox()
    const pUnknownCall = client.call('nonexistentOp' as OpName, {} as never)
    const pGated = client.call('claimReadyTask', { channel: 'q', resume: true } as unknown as OpInput<'claimReadyTask'>)

    for (const p of [pMissingCall, pMissingFacade, pMissingV2, pUnknownCall, pGated]) {
      expect(p).toBeInstanceOf(Promise)
    }

    const settled = await Promise.allSettled([pMissingCall, pMissingFacade, pMissingV2, pUnknownCall, pGated])
    for (const result of settled) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(isBoardError(result.reason)).toBe(true)
        expect(result.reason).toMatchObject({ status: 501, code: 'not_supported', origin: 'handle' })
      }
    }
    expect(calls).toHaveLength(0)
  })
})

describe('HS-97 tasks facade', () => {
  it('HS-97 claim(id), claim(query) timeout & abort, held(), create, createMany, batch, verbs', async () => {
    const { client, transport } = setupBoard()
    const { spy, calls } = spyTransport(transport)
    const spiedClient = createBoardClient(spy, { selection: BASE_SEL })

    // create + list + claim(id) + complete
    const created = await spiedClient.tasks.create('work', { text: 'do job', labels: { p: 'high' } })
    expect(created.task.task?.state).toBe('ready')
    expect(created.claim).toBeUndefined()

    const listed = await spiedClient.tasks.list({ channel: 'work', label: { p: 'high' } })
    expect(listed.tasks.map((t) => t.message.id)).toContain(created.task.id)

    const claimed = await spiedClient.tasks.claim(created.task.id)
    expect(claimed.task.id).toBe(created.task.id)
    expect(claimed.epoch).toBe(1)
    expect(claimed.token).toBeTypeOf('string')

    // renew
    const renewed = await claimed.renew(60)
    expect(renewed.epoch).toBe(1)
    expect(renewed.until).toBeTypeOf('string')

    // held with wrong token -> 409 claim_lost
    await expectError(() => spiedClient.tasks.held(created.task.id, { epoch: claimed.epoch, token: 'wrong' }).release(), {
      status: 409,
      code: 'claim_lost',
    })

    // complete('done') sends { id, epoch, token, result: 'done' }
    calls.length = 0
    const completed = await claimed.complete('done')
    expect(completed.task?.state).toBe('completed')
    expect(completed.task?.result).toBe('done')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('completeTask')
    expect(calls[0]!.input).toEqual({
      id: created.task.id,
      epoch: claimed.epoch,
      token: claimed.token,
      result: 'done',
    })

    // claim(query) on empty queue -> null in [300, 600) ms
    const t0 = Date.now()
    const emptyClaim = await spiedClient.tasks.claim({ channel: 'work', wait: 0.3 })
    const dt = Date.now() - t0
    expect(emptyClaim).toBeNull()
    expect(dt).toBeGreaterThanOrEqual(280)
    expect(dt).toBeLessThan(600)

    // createMany, batch, assign, block, unblock, needs, cancel, fail, reopen
    const batchId = 'batch-1'
    const many = await spiedClient.tasks.createMany(
      'work',
      [
        { key: 'a', text: 'task a' },
        { key: 'b', text: 'task b', needs: [{ key: 'a' }] },
      ],
      { id: batchId },
    )
    expect(many).toHaveLength(2)
    const fetchedBatch = await spiedClient.tasks.batch(batchId)
    expect(fetchedBatch.map((m) => m.id)).toEqual(many.map((m) => m.id))

    const aId = many[0]!.id
    const bId = many[1]!.id
    expect((await spiedClient.tasks.assign(aId, 'local:user:ada+w1')).task?.for).toBe('local:user:ada+w1')
    expect((await spiedClient.tasks.block(aId, 'waiting review', { kind: 'awaiting_approval' })).task?.state).toBe('blocked')
    expect((await spiedClient.tasks.unblock(aId)).task?.state).toBe('ready')
    expect((await spiedClient.tasks.needs(bId, [])).task?.needs).toEqual([])

    const c2 = await spiedClient.tasks.claim(aId)
    expect((await c2.fail('oops')).task?.state).toBe('failed')
    expect((await spiedClient.tasks.reopen(aId)).task?.state).toBe('ready')
    expect((await spiedClient.tasks.cancel(aId, 'no longer needed')).task?.state).toBe('canceled')

    // create on { re } + claim: true
    const post = await spiedClient.post('work', 'convert me')
    const conv = await spiedClient.tasks.create({ re: post.id }, { claim: true })
    expect(conv.claim).toBeDefined()
    expect((await conv.claim!.release()).task?.state).toBe('ready')
  })

  it('HS-97 claim(query) aborts cleanly during pause when transport returns early', async () => {
    const { transport } = setupBoard()
    const fastEmptyTransport: BoardTransport = {
      get capabilities() {
        return transport.capabilities
      },
      get closed() {
        return transport.closed
      },
      async call(op, input, opts) {
        if (op === 'claimReadyTask') return { task: null } as OpOutput<typeof op>
        return transport.call(op, input, opts)
      },
      events: (q, o) => transport.events(q, o),
      close: () => transport.close(),
    }
    const client = createBoardClient(fastEmptyTransport, { selection: BASE_SEL })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 40)
    const t0 = Date.now()
    const res = await client.tasks.claim({ channel: 'work', wait: 5 }, { signal: ac.signal })
    expect(res).toBeNull()
    expect(Date.now() - t0).toBeLessThan(300)
  })

  it('HS-97 claim(query) rejects NaN, Infinity, and negative wait with 400 invalid_request and 0 transport calls', async () => {
    const { transport } = setupBoard()
    const { spy, calls } = spyTransport(transport)
    const client = createBoardClient(spy, { selection: BASE_SEL })

    await expectError(() => client.tasks.claim({ channel: 'q', wait: Number.NaN }), {
      status: 400,
      code: 'invalid_request',
    })
    await expectError(() => client.tasks.claim({ channel: 'q', wait: -1 }), {
      status: 400,
      code: 'invalid_request',
    })
    await expectError(() => client.tasks.claim({ channel: 'q', wait: Number.POSITIVE_INFINITY }), {
      status: 400,
      code: 'invalid_request',
    })
    await expectError(
      () => client.tasks.claim({ channel: 'q', wait: '5' as unknown as number }),
      { status: 400, code: 'invalid_request' },
    )
    expect(calls).toHaveLength(0)
  })
})

describe('HS-98 expectInstance propagation in wait, waitPage, pages vs poll', () => {
  it('HS-98 wait, waitPage, and pages send expectInstance on round 2+; poll sends none', async () => {
    const { transport, service } = setupBoard()
    const instanceId = transport.capabilities.instanceId!
    expect(instanceId).toBeTypeOf('string')

    // Wrap transport so round 1 of wait/waitPage returns an empty page quickly (causing round 2)
    let callIdx = 0
    const callLog: Array<{ op: string; expectInstance: string | undefined }> = []
    const eventLog: Array<{ expectInstance: string | undefined }> = []

    const multiRoundTransport: BoardTransport = {
      get capabilities() {
        return transport.capabilities
      },
      get closed() {
        return transport.closed
      },
      async call<O extends OpName>(op: O, input: OpInput<O>, opts?: CallOptions): Promise<OpOutput<O>> {
        if (op === 'events') {
          callLog.push({ op, expectInstance: opts?.expectInstance })
          callIdx += 1
          if (callIdx === 1 || callIdx === 3) {
            // Round 1 returns empty immediately (simulating a long-poll round finishing before deadline)
            return { events: [], cursor: '0' } as OpOutput<O>
          }
          if (callIdx === 2) {
            // Round 2 of waitPage returns an event
            return {
              events: [{ cursor: '1', type: 'message.posted', createdAt: new Date().toISOString(), payload: {} }],
              cursor: '1',
            } as OpOutput<O>
          }
          if (callIdx === 4) {
            // Round 2 of wait returns an event
            return {
              events: [{ cursor: '2', type: 'message.posted', createdAt: new Date().toISOString(), payload: {} }],
              cursor: '2',
            } as OpOutput<O>
          }
        }
        return transport.call(op, input, opts)
      },
      events(query: EventsFeedQuery, opts?: CallOptions): AsyncIterable<EventsPage> {
        eventLog.push({ expectInstance: opts?.expectInstance })
        return transport.events(query, opts)
      },
      close: () => transport.close(),
    }

    const client: BoardClient = createBoardClient(multiRoundTransport, { selection: BASE_SEL })

    // 1. waitPage multi-round: round 1 has undefined, round 2 has instanceId
    const pg = await client.waitPage({ timeoutS: 2 })
    expect(pg.events).toHaveLength(1)
    expect(callLog.slice(0, 2)).toEqual([
      { op: 'events', expectInstance: undefined },
      { op: 'events', expectInstance: instanceId },
    ])

    // 2. wait multi-round: round 1 (callIdx=3) has undefined, round 2 (callIdx=4) has instanceId
    const ev = await client.wait({}, { timeout: '2s' })
    expect(ev).not.toBeNull()
    expect(callLog.slice(2, 4)).toEqual([
      { op: 'events', expectInstance: undefined },
      { op: 'events', expectInstance: instanceId },
    ])

    // 3. poll passes NO expectInstance
    await client.poll({ wait: 0 })
    expect(callLog[4]).toEqual({ op: 'events', expectInstance: undefined })

    // 4. pages passes undefined on call 1, and instanceId on call 2
    const bob = createLocalCaller({ userId: 'bob', handle: 'bob', name: 'Bob', profile: 'w1' })
    service.postMessage(bob, { channel: 'dev', text: 'first' })
    const gotPages: EventsPage[] = []
    setTimeout(() => service.postMessage(bob, { channel: 'dev', text: 'second' }), 30)
    for await (const page of client.pages({ last: 1 })) {
      gotPages.push(page)
      if (gotPages.length === 2) break
    }
    expect(gotPages).toHaveLength(2)
    expect(eventLog).toEqual([{ expectInstance: undefined }, { expectInstance: instanceId }])
  })

  it('HS-98 pages() captures instanceId before yielding page 1 even if rotateInstanceId() + me() run before page 2', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hs-client-pages-')))
    const dbPath = join(dir, 'board.db')
    const store = new SqliteUnifiedStore({ path: dbPath })
    const service = new BoardService(store)
    const identity = localIdentity({
      userId: 'ada',
      handle: 'ada',
      name: 'Ada',
      member: true,
      owner: true,
      profiles: ['w1'],
      defaultProfile: 'w1',
    })
    const transport = new InProcessTransport({
      board: service,
      identity,
      owned: { store, close: () => store.close() },
    })
    const client = createBoardClient(transport, { selection: BASE_SEL })
    cleanups.push(async () => {
      await client.close()
      rmSync(dir, { recursive: true, force: true })
    })

    await client.post('dev', 'first')
    const instBefore = client.caps.instanceId
    expect(instBefore).toBeTypeOf('string')

    const ac = new AbortController()
    const safety = setTimeout(() => ac.abort(), 500)
    try {
      const it = client.pages({ last: 1 }, { signal: ac.signal })[Symbol.asyncIterator]()
      const first = await it.next()
      expect(first.done).toBe(false)
      expect(first.value?.events).toHaveLength(1)

      const other = new SqliteUnifiedStore({ path: dbPath })
      try {
        other.rotateInstanceId()
      } finally {
        other.close()
      }

      // Intervening call refreshes transport.capabilities.instanceId to the rotated id.
      await client.me()
      expect(client.caps.instanceId).not.toBe(instBefore)

      const err = await expectError(() => it.next(), { status: 410, code: 'cursor_expired' })
      expect(err?.details).toMatchObject({ reason: 'instance_changed' })
    } finally {
      clearTimeout(safety)
    }
  })
})
