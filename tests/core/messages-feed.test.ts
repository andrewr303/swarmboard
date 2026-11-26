import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  MESSAGE_TEXT_MAX,
  SqliteUnifiedStore,
  type CallerContext,
} from '../../src/core/index.ts'

// M1 gate, fix batch C: channel messages, mentions, reactions, events, posts and refs, each checked
// against the original @vercel/board v0.54.0 source cited per test.

const stores: SqliteUnifiedStore[] = []

function setup(seedDefaultGrants = true): { board: BoardService; store: SqliteUnifiedStore } {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return { board: new BoardService(store, { seedDefaultGrants }), store }
}

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close()
})

function caught(fn: () => unknown): BoardError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(BoardError)
    return e as BoardError
  }
  throw new Error('expected a BoardError')
}

const owner = (): CallerContext => createLocalCaller({ userId: 'owner', handle: 'owner', owner: true })
const user = (id: string, handle = id): CallerContext => createLocalCaller({ userId: id, handle })
const grant = (board: BoardService, userId: string, can: Record<string, string[]>): void => {
  board.createGrant(owner(), { principals: [{ kind: 'user', userId }], can })
}
/** A write-only (post) caller in `dropbox`: blind there. */
function blindBob(board: BoardService): CallerContext {
  grant(board, 'bob', { dropbox: ['post'] })
  return user('bob')
}

describe('GAP-024 listChannelMessages pages as the original (a2.ts:521-534, store/types.ts:33)', () => {
  it('lists the newest 50 by default, oldest first, and a cut-short page after a cursor stops at its last message', () => {
    const { board } = setup()
    const alice = user('alice')
    const ids: string[] = []
    for (let i = 0; i < 60; i++) ids.push(board.postMessage(alice, { channel: 'dev', text: `m${i}` }).message.id)

    const page = board.listChannelMessages(alice, { channel: 'dev' })
    expect(page.messages.map((m) => m.id)).toEqual(ids.slice(-50))

    const cut = board.listChannelMessages(alice, { channel: 'dev', after: ids[4]!, limit: 10 })
    expect(cut.messages.map((m) => m.id)).toEqual(ids.slice(5, 15))
    expect(cut.cursor).toBe(ids[14])
    const next = board.listChannelMessages(alice, { channel: 'dev', after: cut.cursor, limit: 10 })
    expect(next.messages.map((m) => m.id)).toEqual(ids.slice(15, 25))
  })

  it('answers an empty page, not 403, for a channel the caller cannot read', () => {
    const { board } = setup(false)
    const bob = blindBob(board)
    board.postMessage(bob, { channel: 'dropbox', text: 'drop' })
    expect(board.listChannelMessages(bob, { channel: 'dropbox' }).messages).toEqual([])
  })
})

describe('GAP-026 mention settling tie-break and length guard (serve.ts:470-529, feed.ts:182-201)', () => {
  it('prefers a board actor over a platform user with the same handle', () => {
    const { board } = setup()
    const bot = user('syncbot')
    board.registerWatchers(bot, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    // The imported platform user is recorded as `syncbot/malte`, kind external.
    board.syncImport(bot, {
      op: 'post',
      author: { id: 'slack:U1', handle: 'malte', name: 'Malte', avatar: null, isBot: false },
      from: 'slack',
      channel: 'dev',
      text: 'slack malte',
    })
    // A board agent profile with the very same handle.
    const agent = createLocalCaller({ userId: 'syncbot', handle: 'syncbot', profile: 'malte' })
    board.postMessage(agent, { channel: 'dev', text: 'board malte' })
    const handles = board.listActors(owner()).filter((a) => a.handle === 'syncbot/malte')
    expect(handles.map((a) => a.kind).sort()).toEqual(['agent', 'external'])

    const { message } = board.postMessage(owner(), { channel: 'dev', text: '@syncbot/malte ping' })
    expect(message.text).toBe(`@[${agent.actor.id}] ping`)
  })

  it('settles a shared handle to the single one of them who wrote in the thread, and no one in a new thread', () => {
    const { board } = setup()
    const dev1 = createLocalCaller({ userId: 'd1', handle: 'dev' })
    const dev2 = createLocalCaller({ userId: 'd2', handle: 'dev' })
    const { message: root1 } = board.postMessage(dev1, { channel: 'dev', text: 'thread one' })
    board.postMessage(dev2, { channel: 'dev', text: 'thread two' })

    const reply = board.postMessage(owner(), { re: root1.id, text: '@dev ping' })
    expect(reply.message.text).toBe(`@[${dev1.actor.id}] ping`)

    const fresh = board.postMessage(owner(), { channel: 'dev', text: '@dev ping' })
    expect(fresh.message.text).toBe('@dev ping')
    expect(fresh.mentions![0]!.candidates).toHaveLength(2)
  })

  it('keeps a text as typed where settling would take it past MESSAGE_TEXT_MAX', () => {
    const { board } = setup()
    const alice = user('alice')
    board.postMessage(alice, { channel: 'dev', text: 'hi' })
    const text = `@alice ${'x'.repeat(MESSAGE_TEXT_MAX - '@alice '.length)}`
    expect(text.length).toBe(MESSAGE_TEXT_MAX)
    const { message, mentions } = board.postMessage(owner(), { channel: 'dev', text })
    expect(message.text).toBe(text)
    expect(mentions).toEqual([{ written: '@alice', actor: null, candidates: [{ id: alice.actor.id, handle: 'alice', name: 'alice' }] }])
  })

  it("a --mentions filter by an actor's ID also matches what is under their handle", () => {
    const { board } = setup()
    const alice = user('alice')
    board.postMessage(alice, { channel: 'dev', text: 'hi' })
    board.postMessage(owner(), { channel: 'dev', text: 'ask @alice/claude' })
    const found = board.listThreads(owner(), { channel: 'dev', mentions: alice.actor.id })
    expect(found.threads.map((t) => t.message.text)).toEqual(['ask @alice/claude'])
  })
})

describe('GAP-027 reactions canonicalise through the Chat SDK table and always append (emoji.ts, writes.ts:810-828)', () => {
  it('groups platform names with their canonical reaction', () => {
    const { board } = setup()
    const alice = user('alice')
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'lol' })
    board.reactMessage(alice, message.id, { emoji: 'joy' })
    const after = board.reactMessage(alice, message.id, { emoji: 'laugh' })
    expect(after.reactions).toEqual({ laugh: [alice.actor.id] })
    expect(board.reactMessage(alice, message.id, { emoji: 'heart_eyes' }).reactions.love_eyes).toEqual([alice.actor.id])
    expect(board.reactMessage(alice, message.id, { emoji: 'exploding_head' }).reactions.mind_blown).toEqual([alice.actor.id])
  })

  it('appends a reaction event even when it changes nothing, without a new message version', () => {
    const { board, store } = setup()
    const alice = user('alice')
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'ok' })
    const first = board.reactMessage(alice, message.id, { emoji: 'eyes' })
    const head = store.getHeadIndex()
    const again = board.reactMessage(alice, message.id, { emoji: 'eyes' })
    expect(store.getHeadIndex()).toBe(head + 1)
    expect(again.version).toBe(first.version)
    board.reactMessage(alice, message.id, { emoji: 'rocket', remove: true })
    expect(store.getHeadIndex()).toBe(head + 2)
  })
})

describe('GAP-029 event pages (feed.ts:494-521 lastFeed, :564-598 pollFeed)', () => {
  it('examines one page of 200 events per read, with the cursor at the last one examined', async () => {
    const { board, store } = setup()
    const alice = user('alice')
    for (let i = 0; i < 230; i++) board.postMessage(alice, { channel: 'dev', text: `m${i}` })
    const start = store.getHeadIndex() - 230

    const page = await board.getEvents(alice, { after: String(start) })
    expect(page.events).toHaveLength(200)
    expect(page.cursor).toBe(String(start + 200))
    const rest = await board.getEvents(alice, { after: page.cursor })
    expect(rest.events).toHaveLength(30)
    expect(rest.cursor).toBe(String(store.getHeadIndex()))
  })

  it('answers a full page without waiting, even when nothing in it matches', async () => {
    const { board, store } = setup()
    const alice = user('alice')
    for (let i = 0; i < 230; i++) board.postMessage(alice, { channel: 'dev', text: `m${i}` })
    const start = store.getHeadIndex() - 230
    const began = Date.now()
    const page = await board.getEvents(alice, { after: String(start), channel: 'elsewhere', wait: 3 })
    expect(Date.now() - began).toBeLessThan(1000)
    expect(page.events).toEqual([])
    expect(page.cursor).toBe(String(start + 200))
  })

  it('reads `last` back a page at a time', async () => {
    const { board } = setup()
    const alice = user('alice')
    for (let i = 0; i < 450; i++) board.postMessage(alice, { channel: i % 2 ? 'dev' : 'ops', text: `m${i}` })
    const last = await board.getEvents(alice, { last: 5, channel: 'dev' })
    expect(last.events.map((e) => (e.payload as { text?: string }).text)).toEqual(['m441', 'm443', 'm445', 'm447', 'm449'])
  })
})

describe('GAP-033 posted lookup by client ID (a2.ts:572-578, writes.ts:293-314)', () => {
  it("recovers the caller's own post by its ID, and 404s for anyone else or an unknown ID", () => {
    const { board } = setup()
    const alice = user('alice')
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'hello', id: 'cli-1' })
    board.editMessage(alice, message.id, { text: 'hello again' })

    const { message: got } = board.getPosted(alice, 'cli-1')
    expect(got.id).toBe(message.id)
    expect(got.text).toBe('hello again')

    const other = caught(() => board.getPosted(user('carol'), 'cli-1'))
    expect([other.status, other.code]).toEqual([404, 'post_not_found'])
    const unknown = caught(() => board.getPosted(alice, 'nope'))
    expect([unknown.status, unknown.code]).toEqual([404, 'post_not_found'])
  })

  it('answers a blind author with what its own append made of the post, mentions masked', () => {
    const { board } = setup(false)
    const bob = blindBob(board)
    board.postMessage(bob, { channel: 'dropbox', text: 'ping @[slack:T:U1]', id: 'drop-1' })
    board.labelMessage(owner(), board.getPosted(bob, 'drop-1').message.id, { set: { triage: 'high' } })
    const { message } = board.getPosted(bob, 'drop-1')
    expect(message.text).toBe('ping @…')
    expect(message.labels).toEqual({})
    expect(message.blind).toBe(true)
  })
})

describe('GAP-041 a blind poster gets back exactly the text it sent (writes.ts:409, :536-540 shownTo)', () => {
  it('on the first response and on a retry', () => {
    const { board } = setup(false)
    const bob = blindBob(board)
    const { message } = board.postMessage(bob, { channel: 'dropbox', text: 'ping @[slack:T:U1]', id: 'drop-2' })
    expect(message.text).toBe('ping @[slack:T:U1]')
    expect(message.blind).toBe(true)
    const { message: retry } = board.postMessage(bob, { channel: 'dropbox', text: 'ping @[slack:T:U1]', id: 'drop-2' })
    expect(retry.id).toBe(message.id)
    expect(retry.text).toBe('ping @[slack:T:U1]')
  })
})

describe('GAP-034 message refs are decimal log indexes only (feed.ts:115, a2.ts:90-94)', () => {
  it("answers 404 message_not_found for '0x10', '1e1', ' 12 ' and '+5'", () => {
    const { board } = setup()
    const alice = user('alice')
    for (let i = 0; i < 20; i++) board.postMessage(alice, { channel: 'dev', text: `m${i}` })
    const refs = ['0x10', '1e1', ' 12 ', '+5']
    for (const ref of refs) {
      for (const call of [
        () => board.editMessage(alice, ref, { text: 'x' }),
        () => board.deleteMessage(alice, ref),
        () => board.reactMessage(alice, ref, { emoji: 'eyes' }),
        () => board.labelMessage(alice, ref, { set: { a: 'b' } }),
        () => board.getMessageThread(alice, ref),
      ]) {
        const error = caught(call)
        expect([ref, error.status, error.code]).toEqual([ref, 404, 'message_not_found'])
      }
    }
  })
})

describe('GAP-035 channel lastIndex moves only on a post (contract/reducers.ts:27-45)', () => {
  it('stays put through an edit and a delete, and messages never goes down', () => {
    const { board } = setup()
    const alice = user('alice')
    const { message } = board.postMessage(alice, { channel: 'quiet', text: 'one' })
    const channelOf = () => board.listChannels(alice).channels.find((c) => c.path === 'quiet')!
    const before = channelOf()
    expect(before.lastIndex).toBe(Number(message.id))
    board.editMessage(alice, message.id, { text: 'two' })
    board.deleteMessage(alice, message.id)
    expect(channelOf()).toEqual(before)
  })
})

describe('createSchedule proves label for labels, as authorizePost (a2.ts:612, writes.ts:161-181)', () => {
  it('refuses a post-only caller a schedule that carries labels', () => {
    const { board } = setup(false)
    const bob = blindBob(board)
    const error = caught(() => board.createSchedule(bob, { channel: 'dropbox', text: 'later', in: '1h', labels: { a: 'b' } }))
    expect(error.status).toBe(403)
    expect(board.createSchedule(bob, { channel: 'dropbox', text: 'later', in: '1h' }).channel).toBe('dropbox')
  })
})

// ============================================================================
// M1 gate iteration 4.

describe('N2 a waiting events poll ends on a store failure, and fails on any other (feed.ts:564-595 pollFeed)', () => {
  it('rejects with a fault in its own code rather than answering an empty page', async () => {
    const { board } = setup()
    const alice = user('alice')
    const head = String((await board.getEvents(alice, { last: 1 })).cursor)
    const waiting = board.getEvents(alice, { after: head, wait: 5 })
    const fault = new TypeError('a bug in the projection')
    vi.spyOn(board as unknown as { projectEvent: () => unknown }, 'projectEvent').mockImplementation(() => {
      throw fault
    })
    board.postMessage(alice, { channel: 'dev', text: 'wakes the wait' })
    await expect(waiting).rejects.toBe(fault)
    vi.restoreAllMocks()
  })

  it('answers what it has when the store fails under it', async () => {
    const { board } = setup()
    const alice = user('alice')
    const head = String((await board.getEvents(alice, { last: 1 })).cursor)
    const waiting = board.getEvents(alice, { after: head, wait: 5 })
    vi.spyOn(board as unknown as { projectEvent: () => unknown }, 'projectEvent').mockImplementation(() => {
      throw new BoardError(503, 'unavailable', 'storage is closed')
    })
    const began = Date.now()
    board.postMessage(alice, { channel: 'dev', text: 'wakes the wait' })
    await expect(waiting).resolves.toEqual({ events: [], cursor: head })
    expect(Date.now() - began).toBeLessThan(2000)
    vi.restoreAllMocks()
  })
})
