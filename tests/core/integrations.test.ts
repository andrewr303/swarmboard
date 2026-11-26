import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BoardError,
  BoardService,
  checkSchemaValue,
  createLocalCaller,
  parseWatchTail,
  SqliteUnifiedStore,
  toErrorPayload,
  type CallerContext,
  type FtsSearchQuery,
  type StorageBackend,
} from '../../src/core/index.ts'

// Regression tests for the M1 gate fix batch B: attachments, sync, watchers and schedules. Each
// cites the original Vercel board source it matches (board/packages/board/src/...).

const stores: SqliteUnifiedStore[] = []

function setup(seedDefaultGrants = true): { board: BoardService; store: SqliteUnifiedStore } {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return { board: new BoardService(store, { seedDefaultGrants }), store }
}

afterEach(() => {
  vi.useRealTimers()
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
const user = (id: string, extra: { canHeader?: string; profile?: string } = {}): CallerContext =>
  createLocalCaller({ userId: id, handle: id, ...extra })
const grant = (board: BoardService, userId: string, can: Record<string, 'all' | string[]>): string =>
  board.createGrant(owner(), { principals: [{ kind: 'user', userId }], can }).id

const platformUser = (id: string, handle = 'malte') => ({ id, handle, name: 'Malte Ubl', avatar: null, isBot: false })
const file = (name = 'spec.txt', type = 'text/plain', data = 'hello') => ({ name, type, data: Buffer.from(data) })
const deleted = (channel: string, thread: string, message: string) => ({
  kind: 'deleted' as const,
  channel,
  thread,
  subthread: null,
  message,
})

describe('GAP-016 attachment reads and attaches are authorised (a2.ts:331-336, :373-380, :752-757)', () => {
  function attachSetup() {
    const { board } = setup(false)
    grant(board, 'alice', { priv: 'all', pub: 'all' })
    grant(board, 'bob', { pub: 'all' })
    const alice = user('alice')
    const bob = user('bob')
    const att = board.uploadAttachment(alice, file('secret.txt', 'text/plain', 'top secret'))
    return { board, alice, bob, att }
  }

  it("hides another user's upload until a message bob can read carries it", () => {
    const { board, alice, bob, att } = attachSetup()
    const e = caught(() => board.getAttachment(bob, att.id))
    expect(e.status).toBe(404)
    expect(e.code).toBe('attachment_not_found')

    board.postMessage(alice, { channel: 'priv', text: 'private', attachments: [att.id] })
    expect(caught(() => board.getAttachment(bob, att.id)).status).toBe(404)

    const { message } = board.postMessage(alice, { channel: 'pub', text: 'shared', attachments: [att.id] })
    expect(board.getAttachment(bob, att.id).data.toString('utf8')).toBe('top secret')

    // A deleted message drops its files, so it no longer counts.
    board.deleteMessage(alice, message.id)
    expect(caught(() => board.getAttachment(bob, att.id)).status).toBe(404)
  })

  it("refuses to post or schedule another user's upload, as if it did not exist", () => {
    const { board, bob, att } = attachSetup()
    const post = caught(() => board.postMessage(bob, { channel: 'pub', text: 'mine now', attachments: [att.id] }))
    expect(post.status).toBe(404)
    expect(post.code).toBe('attachment_not_found')
    const sched = caught(() => board.createSchedule(bob, { channel: 'pub', text: 'later', in: '1m', attachments: [att.id] }))
    expect(sched.status).toBe(404)
    expect(sched.code).toBe('attachment_not_found')
  })

  it('lets every profile of the uploading principal attach it (uploader is the principal)', () => {
    const { board } = setup(false)
    grant(board, 'alice', { dev: 'all' })
    const agent = user('alice', { profile: 'claude' })
    const att = board.uploadAttachment(agent, file())
    expect(board.getAttachment(user('alice'), att.id).data.toString('utf8')).toBe('hello')
  })
})

describe('GAP-017 upload rules (a2.ts:735-750, blob.ts:77-120, :153-198, file-names.ts, contract/files.ts:50-73)', () => {
  it('normalises names and types and refuses dotfiles, invisible characters and empty files', () => {
    const { board } = setup()
    const alice = user('alice')
    const att = board.uploadAttachment(alice, file('../etc/notes.txt', 'Text/HTML; charset=utf-8'))
    expect(att.name).toBe('notes.txt')
    expect(att.type).toBe('text/html')
    expect(board.uploadAttachment(alice, file('a.bin', 'not a type')).type).toBe('application/octet-stream')
    expect(board.uploadAttachment(alice, file('', 'text/plain')).name).toBe('file')

    const dot = caught(() => board.uploadAttachment(alice, file('.env')))
    expect(dot.status).toBe(400)
    expect(dot.code).toBe('invalid_attachment')
    const bidi = caught(() => board.uploadAttachment(alice, file(`invoice${String.fromCharCode(0x202e)}fdp.exe`)))
    expect(bidi.code).toBe('invalid_attachment')
    expect(caught(() => board.uploadAttachment(alice, file('x.txt', 'text/plain', ''))).status).toBe(400)
  })

  it('refuses uploads to a token that cannot post or sync anywhere', () => {
    const { board } = setup()
    const reader = user('reader', { canHeader: '*=read' })
    expect(caught(() => board.uploadAttachment(reader, file())).status).toBe(403)
    expect(caught(() => board.startDirectUpload(reader, { name: 'a.bin', size: 4 })).status).toBe(403)
  })

  it('caps a message at 10 files and carries each once', () => {
    const { board } = setup()
    const alice = user('alice')
    const ids = Array.from({ length: 11 }, (_, i) => board.uploadAttachment(alice, file(`f${i}.txt`)).id)
    expect(caught(() => board.postMessage(alice, { channel: 'dev', text: 'many', attachments: ids })).status).toBe(400)
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'twice', attachments: [ids[0]!, ids[0]!] })
    expect(message.attachments).toHaveLength(1)
  })

  it('finishes a direct upload only for its uploader, idempotently, and not after it expires', () => {
    const { board, store } = setup()
    const alice = user('alice')
    expect(caught(() => board.startDirectUpload(alice, { name: '.hidden', size: 4 })).code).toBe('invalid_attachment')
    const ticket = board.startDirectUpload(alice, { name: 'big.bin', type: 'Image/PNG', size: 4 })
    expect(ticket.headers['content-type']).toBe('image/png')
    const other = caught(() => board.finishDirectUpload(user('mallory'), ticket.id, Buffer.from([1, 2, 3, 4])))
    expect(other.status).toBe(404)
    expect(other.code).toBe('upload_not_found')
    const first = board.finishDirectUpload(alice, ticket.id, Buffer.from([1, 2, 3, 4]))
    const again = board.finishDirectUpload(alice, ticket.id, Buffer.from([1, 2, 3, 4]))
    expect(again).toEqual(first)

    const late = board.startDirectUpload(alice, { name: 'late.bin', size: 2 })
    store.db.prepare('UPDATE board_upload_tickets SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', late.id)
    const expired = caught(() => board.finishDirectUpload(alice, late.id, Buffer.from([1, 2])))
    expect(expired.status).toBe(404)
    expect(expired.code).toBe('upload_not_found')
  })
})

describe('GAP-018 sync inboxes are per registrant and for unnarrowed syncs only (a2.ts:1081-1160, :1248-1263)', () => {
  function inboxSetup() {
    const { board } = setup(false)
    grant(board, 'bot1', { dev: ['sync'] })
    grant(board, 'bot2', { dev: ['sync'] })
    const bot1 = user('bot1')
    const bot2 = user('bot2')
    board.inboxPush(bot1, 'slack', {
      events: [
        { id: 'e1', event: deleted('slack:C1', 'slack:C1:1', '1'), raw: { secret: 'payload-1' } },
        { id: 'e2', event: deleted('slack:C1', 'slack:C1:1', '2'), raw: { secret: 'payload-2' } },
        { id: 'e3', event: deleted('slack:C1', 'slack:C1:9', '9'), raw: { secret: 'payload-3' } },
      ],
    })
    return { board, bot1, bot2 }
  }

  it("never hands one registrant another's events, raw payloads or acks", () => {
    const { board, bot1, bot2 } = inboxSetup()
    expect(board.inboxNext(bot2, 'slack')).toEqual([])
    expect(board.listInbox(bot2, 'slack')).toEqual([])
    const items = board.inboxNext(bot1, 'slack')
    const e = caught(() => board.inboxAck(bot2, 'slack', items[0]!.id, { lease: items[0]!.lease }))
    expect(e.status).toBe(404)
    expect(e.code).toBe('no_item')
    expect(board.listInbox(bot1, 'slack')).toHaveLength(3)
    // The same event ID from another registrant is its own.
    expect(board.inboxPush(bot2, 'slack', { events: [{ id: 'e1', event: deleted('slack:C1', 'slack:C1:1', '1'), raw: null }] }).accepted).toBe(1)
  })

  it("hands out each platform thread's events in order, one at a time, with a five-minute lease", () => {
    const { board, bot1 } = inboxSetup()
    const first = board.inboxNext(bot1, 'slack')
    expect(first.map((item) => (item.event as { message?: string }).message)).toEqual(['1', '9'])
    expect(first[0]!.attempt).toBe(0)
    expect(board.inboxNext(bot1, 'slack')).toEqual([])
    board.inboxAck(bot1, 'slack', first[0]!.id, { lease: first[0]!.lease })
    expect(board.inboxNext(bot1, 'slack').map((item) => (item.event as { message?: string }).message)).toEqual(['2'])
  })

  it('refuses narrowed tokens, tokens without sync, and locations outside the key', () => {
    const { board } = inboxSetup()
    const narrowed = user('bot1', { canHeader: 'dev=sync' })
    expect(caught(() => board.inboxNext(narrowed, 'slack')).status).toBe(403)
    expect(caught(() => board.listInbox(narrowed, 'slack')).status).toBe(403)
    expect(caught(() => board.inboxPush(narrowed, 'slack', { events: [{ id: 'x', event: deleted('slack:C1', 'slack:C1:1', '1'), raw: null }] })).status).toBe(403)
    expect(caught(() => board.inboxNext(user('nobody'), 'slack')).status).toBe(403)
    const outside = caught(() =>
      board.inboxPush(user('bot1'), 'slack', { events: [{ id: 'x', event: deleted('teams:C1', 'teams:C1:1', '1'), raw: null }] }),
    )
    expect(outside.status).toBe(400)
  })
})

describe('GAP-020 sync write guards (a2.ts:913-1020, :1248-1306)', () => {
  function syncSetup(seed = true) {
    const { board } = setup(seed)
    const bot = user('syncbot')
    if (!seed) grant(board, 'syncbot', { dev: ['sync'] })
    board.registerWatchers(bot, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const importRoot = (thread: string, message: string, extra: Record<string, unknown> = {}) =>
      board.syncImport(bot, {
        op: 'post',
        author: platformUser('slack:U1'),
        from: 'slack',
        channel: 'dev',
        text: `from ${thread}`,
        origin: { channel: 'slack:C1', thread, subthread: null, message, context: null },
        ...extra,
      })
    return { board, bot, importRoot }
  }

  it('lets a sync-only integration import, without post or label', () => {
    const { board, bot } = syncSetup(false)
    const { message } = board.syncImport(bot, {
      op: 'post',
      author: platformUser('slack:U1'),
      from: 'slack',
      channel: 'dev',
      text: 'imported',
      labels: { pr: '12' },
    })
    expect(message.text).toBe('imported')
  })

  it('refuses an origin already synced elsewhere, one not synced with its thread, and a platform message twice', () => {
    const { board, bot, importRoot } = syncSetup()
    const { message: root } = importRoot('slack:C1:100', '100')
    const taken = caught(() => importRoot('slack:C1:100', '101'))
    expect(taken.status).toBe(409)
    expect(taken.code).toBe('already_synced')

    const { message: other } = board.postMessage(user('alice'), { channel: 'dev', text: 'unsynced' })
    const notSynced = caught(() =>
      board.syncImport(bot, {
        op: 'post',
        author: platformUser('slack:U1'),
        from: 'slack',
        re: other.id,
        text: 'reply',
        origin: { channel: 'slack:C1', thread: 'slack:C1:100', subthread: null, message: '102', context: null },
      }),
    )
    expect(notSynced.status).toBe(409)
    expect(notSynced.code).toBe('already_synced')

    const reply = (message: string) =>
      board.syncImport(bot, {
        op: 'post',
        author: platformUser('slack:U1'),
        from: 'slack',
        re: root.id,
        text: 'reply',
        origin: { channel: 'slack:C1', thread: 'slack:C1:100', subthread: null, message, context: null },
      })
    expect(reply('103').message.re).toBe(root.id)
    expect(caught(() => reply('103')).code).toBe('already_synced')

    const fresh = caught(() =>
      board.syncImport(bot, {
        op: 'post',
        author: platformUser('slack:U1'),
        from: 'slack',
        re: other.id,
        text: 'reply',
        origin: { channel: 'slack:C1', thread: 'slack:C1:555', subthread: null, message: '1', context: null },
      }),
    )
    expect(fresh.code).toBe('not_synced')
  })

  it('needs `from` with an origin, locations under its key, and a registered source', () => {
    const { board, bot, importRoot } = syncSetup()
    expect(caught(() => importRoot('slack:C1:200', '200', { from: null })).status).toBe(400)
    expect(caught(() => importRoot('teams:C1:200', '200')).status).toBe(400)
    const source = caught(() =>
      board.syncImport(bot, {
        op: 'post',
        author: platformUser('slack:U1'),
        from: 'slack',
        channel: 'dev',
        text: 'x',
        source: { key: 'teams', channel: 'teams:C1', thread: 'teams:C1:1' },
      }),
    )
    expect(source.status).toBe(403)
  })

  it('keeps import IDs under the importer, and refuses sync:… IDs from a request', () => {
    const { board, importRoot } = syncSetup()
    const { message } = importRoot('slack:C1:300', '300', { id: 'evt-1' })
    expect(message.thread.startsWith('sync:local:user:syncbot:')).toBe(true)
    const again = importRoot('slack:C1:300', '300', { id: 'evt-1' })
    expect(again.message.id).toBe(message.id)
    const e = caught(() => board.postMessage(user('alice'), { channel: 'dev', text: 'x', id: message.thread }))
    expect(e.status).toBe(400)
  })

  it('checks receipts: narrowed, unregistered key, target of none of its threads, and another message\'s copy', () => {
    const { board, bot } = syncSetup()
    const alice = user('alice')
    const { message: a } = board.postMessage(alice, { channel: 'dev', text: 'a', sync: ['slack:C1'] })
    const { message: b } = board.postMessage(alice, { channel: 'dev', text: 'b', sync: ['slack:C1'] })
    const receipt = (by: CallerContext, message: string, target: string, ts: string) =>
      board.syncReceipt(by, { kind: 'message', message, target, external: { thread: `slack:C1:${ts}`, message: ts } })
    expect(caught(() => receipt(user('syncbot', { canHeader: '*=sync' }), a.id, 'slack:C1', '1')).status).toBe(403)
    expect(caught(() => receipt(user('alice'), a.id, 'slack:C1', '1')).status).toBe(403)
    const notTarget = caught(() => receipt(bot, a.id, 'slack:C2', '1'))
    expect(notTarget.status).toBe(400)
    expect(notTarget.code).toBe('not_a_target')
    expect(receipt(bot, a.id, 'slack:C1', '1').ok).toBe(true)
    // A reply in a's thread can't land as a's platform message.
    const { message: reply } = board.postMessage(alice, { re: a.id, text: 'reply' })
    const stolen = caught(() => receipt(bot, reply.id, 'slack:C1', '1'))
    expect(stolen.status).toBe(409)
    expect(stolen.code).toBe('already_synced')
    expect(stolen.message).toContain('another board message')
    // Nor can b's thread land in the platform thread a's root started.
    const otherThread = caught(() => receipt(bot, b.id, 'slack:C1', '1'))
    expect(otherThread.code).toBe('already_synced')
  })
})

describe('GAP-021 syncFind and syncCopies only answer a sync, about its own records (a2.ts:1030-1079)', () => {
  it('refuses syncFind to a caller without sync, and finds an import only by its own sync', () => {
    const { board } = setup()
    const bot = user('syncbot')
    const other = user('otherbot')
    board.registerWatchers(bot, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const { message } = board.syncImport(bot, {
      op: 'post',
      author: platformUser('slack:U1'),
      from: 'slack',
      channel: 'dev',
      text: 'x',
      id: 'p1',
      origin: { channel: 'slack:C1', thread: 'slack:C1:1', subthread: null, message: '1', context: null },
    })
    const e = caught(() => board.syncFind(user('reader', { canHeader: '*=read' }), { thread: 'slack:C1:1' }))
    expect(e.status).toBe(403)
    expect(board.syncFind(bot, { post: 'p1' })).toEqual({ thread: null, message: message.id })
    expect(board.syncFind(other, { post: 'p1' }).message).toBeNull()
    expect(board.syncFind(other, { thread: 'slack:C1:1', message: '1' })).toEqual({ thread: message.thread, message: message.id })
  })

  it("shows a sync only its own copies, without `by`", () => {
    const { board } = setup()
    const bot1 = user('bot1')
    const bot2 = user('bot2')
    board.registerWatchers(bot1, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const { message } = board.postMessage(user('alice'), { channel: 'dev', text: 'a', sync: ['slack:C1'] })
    board.syncReceipt(bot1, { kind: 'message', message: message.id, target: 'slack:C1', external: { thread: 'slack:C1:1', message: '1' } })
    expect(board.syncCopies(bot1, { message: [message.id] }).copies[message.id]).toEqual({
      'slack:C1': { thread: 'slack:C1:1', message: '1' },
    })
    expect(board.syncCopies(bot2, { message: [message.id] }).copies[message.id]).toEqual({})
    expect(caught(() => board.syncCopies(user('reader', { canHeader: '*=read' }), { message: [message.id] })).status).toBe(403)
  })
})

describe('GAP-022 the watcher registry is scoped and guarded (a2.ts:758-815, :1236-1241)', () => {
  it("lists only the caller's own registration to anyone without manage everywhere", () => {
    const { board } = setup(false)
    grant(board, 'a', { dev: 'all' })
    grant(board, 'b', { dev: 'all' })
    // No url: this board wakes nothing, and refuses one (original server/a2.ts:766-767).
    board.registerWatchers(user('a'), { watch: { w: { tail: 'dev' } } })
    board.registerWatchers(user('b'), { watch: { w: { tail: 'dev' } } })
    expect(board.listWatchers(user('b')).map((r) => r.owner)).toEqual(['local:user:b'])
    expect(board.listWatchers(owner()).map((r) => r.owner)).toEqual(['local:user:a', 'local:user:b'])
  })

  it('refuses narrowed tokens, principals that read nothing, sync without sync, and pulls without a registration', () => {
    const { board } = setup(false)
    grant(board, 'reader', { dev: ['read'] })
    const narrowed = user('reader', { canHeader: 'dev=read' })
    expect(caught(() => board.registerWatchers(narrowed, { watch: { w: { tail: 'dev' } } })).status).toBe(403)
    expect(caught(() => board.pullWatcherMatches(narrowed)).status).toBe(403)
    expect(caught(() => board.ackWatcherMatch(narrowed, 'wm_1', { lease: 'x' })).status).toBe(403)
    expect(caught(() => board.registerWatchers(user('nobody'), { watch: { w: { tail: 'dev' } } })).status).toBe(403)
    const sync = caught(() =>
      board.registerWatchers(user('reader'), { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] }),
    )
    expect(sync.status).toBe(403)
    const none = caught(() => board.pullWatcherMatches(user('reader')))
    expect(none.status).toBe(404)
    expect(none.code).toBe('no_registration')
  })
})

describe('GAP-023 match delivery (registered.ts:14-18, :127-244, feed.ts:376-434)', () => {
  it('skips a match its registrant can no longer read', () => {
    const { board } = setup(false)
    grant(board, 'alice', { dev: 'all' })
    const bobGrant = grant(board, 'bob', { dev: ['read'] })
    board.registerWatchers(user('bob'), { watch: { w: { tail: 'dev' } } })
    board.postMessage(user('alice'), { channel: 'dev', text: 'queued' })
    board.revokeGrant(owner(), bobGrant)
    expect(board.pullWatcherMatches(user('bob'))).toEqual([])
  })

  it('shows link snapshots only of what the registrant reads at pull time', () => {
    const { board } = setup(false)
    grant(board, 'syncbot', { '*': 'all' })
    grant(board, 'bob', { dev: ['read'] })
    const secretGrant = grant(board, 'bob', { secret: ['read'] })
    const bot = user('syncbot')
    board.registerWatchers(bot, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const { message: secret } = board.postMessage(bot, { channel: 'secret', text: 'classified' })
    const { message: open } = board.postMessage(bot, { channel: 'dev', text: 'open' })
    board.registerWatchers(user('bob'), { watch: { w: { tail: 'dev' } } })
    board.syncImport(bot, {
      op: 'links',
      author: platformUser('slack:U1'),
      from: 'slack',
      message: open.id,
      links: [{ url: 'https://example.com/x', message: secret.id, snapshot: null, unavailable: null }],
    })
    board.revokeGrant(owner(), secretGrant)
    const [match] = board.pullWatcherMatches(user('bob'))
    expect(match?.event.type).toBe('message.linked')
    const links = match!.event.payload.links as { message: unknown; snapshot: unknown }[]
    expect(links[0]).toMatchObject({ message: null, snapshot: null })
    expect(match!.event.message?.links[0]).toMatchObject({ message: null, snapshot: null })
  })

  it("leases one match per thread for five minutes, counts tries from 0, and backs off after an error", () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-11-22T00:00:00.000Z'))
    const { board } = setup()
    const alice = user('alice')
    board.registerWatchers(alice, { watch: { w: { tail: 'dev' } } })
    const { message: root } = board.postMessage(alice, { channel: 'dev', text: 'root' })
    board.postMessage(alice, { re: root.id, text: 'reply' })

    const [first, ...rest] = board.pullWatcherMatches(alice)
    expect(rest).toEqual([])
    expect(first!.attempt).toBe(0)
    vi.setSystemTime(Date.now() + 61_000)
    expect(board.pullWatcherMatches(alice)).toEqual([])

    board.ackWatcherMatch(alice, first!.id, { lease: first!.lease, error: 'boom' })
    expect(board.pullWatcherMatches(alice)).toEqual([])
    vi.setSystemTime(Date.now() + 1_001)
    const retried = board.pullWatcherMatches(alice)
    expect(retried.map((m) => m.id)).toEqual([first!.id])
    expect(retried[0]!.attempt).toBe(1)
    board.ackWatcherMatch(alice, first!.id, { lease: retried[0]!.lease })
    expect(board.pullWatcherMatches(alice)[0]!.event.message?.text).toBe('reply')
  })

  it('gives a match up after five tries', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-11-22T00:00:00.000Z'))
    const { board } = setup()
    const alice = user('alice')
    board.registerWatchers(alice, { watch: { w: { tail: 'dev' } } })
    board.postMessage(alice, { channel: 'dev', text: 'flaky' })
    for (let i = 0; i < 5; i++) {
      const [match] = board.pullWatcherMatches(alice)
      expect(match?.attempt).toBe(i)
      board.ackWatcherMatch(alice, match!.id, { lease: match!.lease, error: 'boom' })
      vi.setSystemTime(Date.now() + 31_000)
    }
    expect(board.pullWatcherMatches(alice)).toEqual([])
  })

  it('delivers a change that takes a message out of a label view', () => {
    const { board } = setup()
    const alice = user('alice')
    board.registerWatchers(alice, { watch: { w: { tail: 'dev --label status=open' } } })
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'issue', labels: { status: 'open' } })
    const [posted] = board.pullWatcherMatches(alice)
    board.ackWatcherMatch(alice, posted!.id, { lease: posted!.lease })
    board.labelMessage(alice, message.id, { set: { status: 'closed' } })
    const [changed] = board.pullWatcherMatches(alice)
    expect(changed?.event.type).toBe('labels.changed')
  })
})

describe('GAP-030 schedule validation (schedules.ts:409-436, a2.ts:607-615, serve.ts:1029)', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z')

  it('refuses times in the past or beyond a year, and stops before the first send', () => {
    const { board } = setup()
    const alice = user('alice')
    const create = (body: Record<string, unknown>) =>
      caught(() => board.createSchedule(alice, { channel: 'dev', text: 'x', ...body }, now))
    expect(create({ at: '2001-01-01T00:00:00Z' }).status).toBe(400)
    expect(create({ every: '400d' }).status).toBe(400)
    expect(create({ in: '1h', every: '1h', until: '2026-11-22T12:30:00Z' }).status).toBe(400)
    expect(create({ every: '1d', for: '400d' }).status).toBe(400)
    expect(board.createSchedule(alice, { channel: 'dev', text: 'ok', at: '2026-11-22T11:59:30Z' }, now).state).toBe('pending')
  })

  it('applies the limits and permissions of a post: text, files, reserved labels, label permission, deleted thread', () => {
    const { board } = setup(false)
    grant(board, 'poster', { dev: ['read', 'post'] })
    const poster = user('poster')
    const text = caught(() => board.createSchedule(poster, { channel: 'dev', text: 'x'.repeat(10_001), in: '1m' }, now))
    expect(text.code).toBe('text_too_long')
    const reserved = caught(() =>
      board.createSchedule(owner(), { channel: 'dev', text: 'x', in: '1m', labels: { 'board.task': 'open' } }, now),
    )
    expect(reserved.code).toBe('reserved_label')
    expect(caught(() => board.createSchedule(poster, { channel: 'dev', text: 'x', in: '1m', labels: { a: 'b' } }, now)).status).toBe(403)
    const ids = Array.from({ length: 11 }, (_, i) => board.uploadAttachment(poster, file(`f${i}.txt`)).id)
    expect(caught(() => board.createSchedule(poster, { channel: 'dev', text: 'x', in: '1m', attachments: ids }, now)).status).toBe(400)
    const { message } = board.postMessage(poster, { channel: 'dev', text: 'root' })
    board.deleteMessage(poster, message.id)
    const gone = caught(() => board.createSchedule(poster, { re: message.id, text: 'x', in: '1m' }, now))
    expect(gone.status).toBe(404)
  })
})

describe('GAP-031 a failing send cancels its schedule and holds back no other (schedules.ts:23-26, :252-300)', () => {
  it('cancels a schedule the board refuses for good and still sends the rest', () => {
    const { board, store } = setup()
    const alice = user('alice')
    const now = Date.parse('2026-11-22T12:00:00.000Z')
    const bad = board.createSchedule(alice, { channel: 'dev', text: 'bad', in: '1m' }, now)
    const good = board.createSchedule(alice, { channel: 'dev', text: 'good', in: '2m' }, now)
    // A schedule stored before the text cap: its send fails 400 text_too_long on every tick.
    const row = store.db.prepare('SELECT data FROM board_schedules WHERE id = ?').get(bad.id) as { data: string }
    store.db
      .prepare('UPDATE board_schedules SET data = ? WHERE id = ?')
      .run(JSON.stringify({ ...JSON.parse(row.data), text: 'x'.repeat(20_000) }), bad.id)
    const fired = board.runDueSchedules(now + 120_000).sent
    expect(fired.map((m) => m.text)).toEqual(['good'])
    expect(fired[0]!.thread).toBe(`board-schedule:${good.id.slice(1)}:0`)
    const states = board.listSchedules(alice, { all: true }).map((s) => [s.id, s.state, s.canceled?.reason ?? null])
    expect(states).toEqual([
      [bad.id, 'canceled', 'dropped'],
      [good.id, 'done', null],
    ])
  })
})

describe('GAP-032 schedule visibility and cancel (a2.ts:616-632, schedules.ts:144-153, :465-483)', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z')

  it('shows a write-only creator its schedule, blinded, and lets it cancel it', () => {
    const { board } = setup(false)
    grant(board, 'carol', { ci: ['post'] })
    const carol = user('carol')
    const s = board.createSchedule(carol, { channel: 'ci', text: 'ping @[local:user:dave]', in: '1m' }, now)
    const listed = board.listSchedules(carol)
    expect(listed.map((x) => x.id)).toEqual([s.id])
    expect(listed[0]!.text).toBe('ping @…')
    const result = board.cancelSchedule(carol, s.id)
    expect(result.canceled).toBe(true)
    expect(result.schedule.state).toBe('canceled')
    expect(board.cancelSchedule(carol, s.id).canceled).toBe(false)
  })

  it('resolves `re` from any message of the thread, and takes by=me and handles in any case', () => {
    const { board } = setup()
    const alice = user('alice')
    const { message: root } = board.postMessage(alice, { channel: 'dev', text: 'root' })
    const { message: reply } = board.postMessage(alice, { re: root.id, text: 'reply' })
    const s = board.createSchedule(alice, { re: root.id, text: 'later', in: '1m' }, now)
    expect(board.listSchedules(alice, { re: reply.id }).map((x) => x.id)).toEqual([s.id])
    expect(board.listSchedules(alice, { by: 'me' }).map((x) => x.id)).toEqual([s.id])
    expect(board.listSchedules(alice, { by: 'ALICE' }).map((x) => x.id)).toEqual([s.id])
    expect(board.listSchedules(user('bob'), { by: 'me' })).toEqual([])
  })

  it('answers 403 to a reader that is neither creator nor manager, and 404 to one that cannot read', () => {
    const { board } = setup(false)
    grant(board, 'alice', { dev: 'all' })
    grant(board, 'bob', { dev: ['read'] })
    const s = board.createSchedule(user('alice'), { channel: 'dev', text: 'x', in: '1m' }, now)
    expect(caught(() => board.cancelSchedule(user('bob'), s.id)).status).toBe(403)
    expect(caught(() => board.cancelSchedule(user('eve'), s.id)).status).toBe(404)
  })
})

describe('GAP-037 a watcher tail takes --mentions as the CLI does (api/tail.ts:15-36)', () => {
  it('reads a bare --mentions as me, and a channel after it as the channel', () => {
    expect(parseWatchTail('dev --mentions').filters).toEqual({ channel: 'dev', mentions: 'me' })
    expect(parseWatchTail('--mentions dev').filters).toEqual({ channel: 'dev', mentions: 'me' })
    expect(parseWatchTail('dev --mentions @ada').filters).toEqual({ channel: 'dev', mentions: 'ada' })
    const { board } = setup()
    const e = caught(() => board.registerWatchers(user('alice'), { watch: { w: { tail: 'dev --mentions' } } }))
    expect(e.code).toBe('bad_watcher')
  })
})

describe('GAP-038 a post ID another write took (writes.ts:268-287, errors.ts duplicateId)', () => {
  it('answers the standard duplicate_id for an ID a non-message event holds', () => {
    const { board, store } = setup()
    const alice = user('alice')
    board.postMessage(alice, { channel: 'dev', text: 'first' })
    const seen = store.db.prepare("SELECT event_id FROM board_events WHERE type = 'actor.seen' LIMIT 1").get() as {
      event_id: string
    }
    const e = caught(() => board.postMessage(alice, { channel: 'dev', text: 'again', id: seen.event_id }))
    expect(e.status).toBe(409)
    expect(e.code).toBe('duplicate_id')
    expect(e.message).toBe('that id was already used for a different write')
  })
})

describe('R3c a change named by board ID is only its author\'s (a2.ts:975-990)', () => {
  it("refuses a sync's edit of another platform user's message by board ID", () => {
    const { board } = setup()
    const bot = user('syncbot')
    board.registerWatchers(bot, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const { message } = board.syncImport(bot, {
      op: 'post',
      author: platformUser('slack:U1'),
      from: 'slack',
      channel: 'dev',
      text: 'mine',
    })
    const e = caught(() =>
      board.syncImport(bot, { op: 'edit', author: platformUser('slack:U2', 'other'), from: 'slack', message: message.id, text: 'hijack' }),
    )
    expect(e.status).toBe(403)
  })
})

// ============================================================================
// M1 gate iteration 2: findings the verifiers and challengers confirmed in iteration 1.
// ============================================================================

/** What a failing call answers on the wire: status, code and message. */
function answered(fn: () => unknown): [number, string, string] {
  try {
    fn()
  } catch (error) {
    const { status, payload } = toErrorPayload(error)
    return [status, payload.error.code, payload.error.message]
  }
  throw new Error('expected a failure')
}

describe('ACL-1 an edit or delete gives a blind author back only what it wrote (a2.ts:582-594, writes.ts:293-315)', () => {
  it('shows no label, reaction or sync state another actor added since', () => {
    const { board } = setup(false)
    grant(board, 'bob', { dropbox: ['post'] })
    const bob = user('bob')
    const { message } = board.postMessage(bob, { channel: 'dropbox', text: 'tip' })
    board.labelMessage(owner(), message.id, { set: { triage: 'fraud_high' } })
    board.reactMessage(owner(), message.id, { emoji: 'eyes' })
    const edited = board.editMessage(bob, message.id, { text: 'tip, edited' })
    expect(edited.text).toBe('tip, edited')
    expect(edited.labels).toEqual({})
    expect(edited.reactions).toEqual({})
    expect(edited.undelivered).toEqual({})
    // The owner still sees what is there.
    const seen = board.getMessageThread(owner(), message.id).message
    expect(seen.labels).toEqual({ triage: 'fraud_high' })
    expect(Object.keys(seen.reactions)).toEqual(['eyes'])

    const gone = board.deleteMessage(bob, message.id)
    expect([gone.deleted, gone.labels, gone.reactions]).toEqual([true, {}, {}])
    const again = board.deleteMessage(bob, message.id)
    expect([again.labels, again.reactions, again.undelivered]).toEqual([{}, {}, {}])
  })
})

describe('ACL-2 / V5 only the board itself sends schedules, and a tick loses nothing (schedules.ts:23-26, :252-300)', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z')

  it('has no caller-facing way to fire schedules early', () => {
    const { board } = setup()
    expect('fireDueSchedules' in board).toBe(false)
    const hr = user('hr')
    board.createSchedule(hr, { channel: 'dev', text: 'Layoffs list', in: '30d' }, now)
    expect(board.runDueSchedules(now + 60_000).sent).toEqual([])
    expect(board.listSchedules(hr)[0]!.state).toBe('pending')
  })

  it('reports every send that went out and every schedule that failed, holding none back', () => {
    const { board, store } = setup()
    const alice = user('alice')
    const bad = board.createSchedule(alice, { channel: 'dev', text: 'bad', in: '1m' }, now)
    const good = board.createSchedule(alice, { channel: 'dev', text: 'good', in: '2m' }, now)
    // A creator record the board can't read: its send fails, and not as a refusal, so it stays pending.
    store.db.prepare('UPDATE board_meta SET value = ? WHERE key = ?').run('{', `schedule_principal:${bad.id}`)
    const run = board.runDueSchedules(now + 180_000)
    expect(run.sent.map((m) => m.text)).toEqual(['good'])
    expect(run.failed.map((f) => [f.schedule, f.error.status, f.error.code])).toEqual([[bad.id, 500, 'internal']])
    const stateOf = (id: string) => (store.db.prepare('SELECT state FROM board_schedules WHERE id = ?').get(id) as { state: string }).state
    expect([stateOf(bad.id), stateOf(good.id)]).toEqual(['pending', 'done'])
  })
})

describe('ACL-3 a sync change to a message the caller cannot sync is as good as missing (a2.ts:973-978)', () => {
  // Iteration 3 (W1): the original answers `{ message: null }` for both, not a 404
  // (server/a2.ts:978 `if (!found || !may(found.channel)) return { message: null }`).
  it('answers the same null message, naming no channel, for an unsyncable message and a missing one', () => {
    const { board } = setup(false)
    grant(board, 'alice', { 'pub/': ['read', 'post', 'sync'] })
    const alice = user('alice')
    board.registerWatchers(alice, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const { message: secret } = board.postMessage(owner(), { channel: 'secret/mergers', text: 'deal' })
    const change = (message: string, op: Record<string, unknown>) =>
      board.syncImport(alice, { author: platformUser('slack:U1'), from: 'slack', message, ...op })
    const ops = [
      { op: 'react', emoji: 'eyes' },
      { op: 'labels', set: { a: 'b' } },
      { op: 'edit', text: 'x' },
      { op: 'delete' },
      { op: 'links', links: [] },
    ]
    for (const op of ops) {
      const hidden = change(secret.id, op)
      const missing = change('999', op)
      expect(hidden).toEqual(missing)
      expect(hidden).toEqual({ message: null })
      expect(JSON.stringify(hidden)).not.toContain('secret')
    }
    // Nothing was changed on the message it can't sync.
    expect(board.getMessageThread(owner(), secret.id).message.text).toBe('deal')
  })
})

describe('ACL-4 a schedule sends with its creator standing as it does now (schedules.ts:259 accessNow)', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z')

  it("sends an owner's schedule where only ownership lets it post", () => {
    const { board } = setup(false)
    const s = board.createSchedule(owner(), { channel: 'secret/hr', text: 'owner note', in: '1m' }, now)
    expect(board.runDueSchedules(now + 120_000).sent.map((m) => m.text)).toEqual(['owner note'])
    expect(board.listSchedules(owner(), { all: true }).find((x) => x.id === s.id)!.state).toBe('done')
  })

  it("cancels it as revoked when the server's principalNow says the creator is gone or no longer an owner", () => {
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    stores.push(store)
    const board = new BoardService(store, {
      seedDefaultGrants: false,
      principalNow: (principal) => (principal.id === 'local:user:gone' ? null : { ...principal, owner: false }),
    })
    const demoted = board.createSchedule(owner(), { channel: 'secret/hr', text: 'x', in: '1m' }, now)
    const gone = board.createSchedule(
      createLocalCaller({ userId: 'gone', handle: 'gone', owner: true }),
      { channel: 'dev', text: 'y', in: '1m' },
      now,
    )
    expect(board.runDueSchedules(now + 120_000).sent).toEqual([])
    const states = board.listSchedules(owner(), { all: true }).map((s) => [s.id, s.state, s.canceled?.reason ?? null])
    expect(states).toEqual([
      [demoted.id, 'canceled', 'revoked'],
      [gone.id, 'canceled', 'revoked'],
    ])
  })
})

describe("ACL-5 a caller acts only as its principal or one of its profiles", () => {
  it("refuses a context whose actor is someone else's, and leaves that actor's record as it was", () => {
    const { board } = setup()
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', name: 'Admin', owner: true })
    const { message } = board.postMessage(admin, { channel: 'pub/news', text: 'real' })
    const alice = user('alice')
    const forged: CallerContext = { ...alice, actor: { ...admin.actor, name: 'Admin (hacked)' } }
    const refused = caught(() => board.postMessage(forged, { channel: 'pub/news', text: 'fake' }))
    expect(refused.status).toBe(403)
    const profileMismatch: CallerContext = { ...user('alice', { profile: 'bot' }), profile: 'other' }
    expect(caught(() => board.listChannels(profileMismatch)).status).toBe(403)
    expect(board.getMessageThread(admin, message.id).message.author?.name).toBe('Admin')
    expect(board.listActors(admin).find((a) => a.id === admin.actor.id)?.name).toBe('Admin')
  })
})

describe('F1 a post, reply or schedule refuses NUL and lone surrogates, as an edit does (contract/events.ts:48)', () => {
  it('answers 400 for each', () => {
    const { board } = setup()
    const alice = user('alice')
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'root' })
    const now = Date.parse('2026-11-22T12:00:00.000Z')
    for (const text of ['a\u0000b', 'a\ud800b']) {
      for (const write of [
        () => board.postMessage(alice, { channel: 'dev', text }),
        () => board.postMessage(alice, { re: message.id, text }),
        () => board.createSchedule(alice, { channel: 'dev', text, in: '1m' }, now),
        () => board.editMessage(alice, message.id, { text }),
      ]) {
        expect(answered(write)).toEqual([400, 'invalid_request', 'text: message text has a NUL character or a lone surrogate'])
      }
    }
  })
})

describe('F2 / F4 / N2 a thread read takes its replies and `after` as the original does (a2.ts:552-571)', () => {
  it('returns every reply with no limit, and the newest or the next `limit` with one', () => {
    const { board } = setup()
    const alice = user('alice')
    const { message: root } = board.postMessage(alice, { channel: 'dev', text: 'root' })
    const ids: string[] = []
    for (let i = 0; i < 600; i++) ids.push(board.postMessage(alice, { re: root.id, text: `r${i}` }).message.id)
    expect(board.getMessageThread(alice, root.id).replies).toHaveLength(600)
    expect(board.getMessageThread(alice, root.id, { limit: 2 }).replies.map((r) => r.text)).toEqual(['r598', 'r599'])
    expect(board.getMessageThread(alice, root.id, { after: ids[0]!, limit: 2 }).replies.map((r) => r.text)).toEqual(['r1', 'r2'])
    expect(board.getMessageThread(alice, root.id, { after: root.id })).toMatchObject({ replies: { length: 600 } })
  })

  it('answers 400 for an `after` of another thread, 404 for one naming no message, and always lists schedules', () => {
    const { board } = setup()
    const alice = user('alice')
    const { message: root } = board.postMessage(alice, { channel: 'dev', text: 'root' })
    board.postMessage(alice, { re: root.id, text: 'reply' })
    const { message: other } = board.postMessage(alice, { channel: 'dev', text: 'other' })
    const elsewhere = caught(() => board.getMessageThread(alice, root.id, { after: other.id }))
    expect([elsewhere.status, elsewhere.code, elsewhere.message]).toEqual([400, 'invalid_request', `after: ${other.id} isn't a message of this thread`])
    expect(caught(() => board.getMessageThread(alice, root.id, { after: '999' })).status).toBe(400)
    for (const after of ['zz', '0']) {
      const none = caught(() => board.getMessageThread(alice, root.id, { after }))
      expect([none.status, none.code, none.message]).toEqual([404, 'message_not_found', `message not found: #${after}`])
    }
    expect(board.getMessageThread(alice, root.id).schedules).toEqual([])
  })
})

describe("F3 a request may not post with an ID that's another's to post with (a2.ts:406-415 ownId, client/ids.ts:31-36)", () => {
  it("refuses a UUIDv8 and another principal's key: ID, and takes its own", () => {
    const { board } = setup()
    const own = user('own')
    const bob = user('bob')
    const ownKey = 'key:local:user:own:0123456789abcdef0123456789abcdef'
    const squat = caught(() => board.postMessage(bob, { channel: 'dev', text: 'x', id: ownKey }))
    expect([squat.status, squat.code]).toEqual([400, 'invalid_request'])
    expect(squat.message).toContain('key:local:user:bob:')
    expect(board.postMessage(own, { channel: 'dev', text: 'mine', id: ownKey }).message.text).toBe('mine')
    expect(caught(() => board.postMessage(own, { channel: 'dev', text: 'x', id: `${ownKey}0` })).status).toBe(400)
    expect(caught(() => board.postMessage(bob, { channel: 'dev', text: 'x', id: '00000000-0000-8000-8000-000000000000' })).status).toBe(400)
    expect(caught(() => board.postMessage(bob, { channel: 'dev', text: 'x', id: 'sync:x' })).status).toBe(400)
    expect(caught(() => board.postMessage(bob, { channel: 'dev', text: 'x', id: 'board-schedule:1:0' })).status).toBe(400)
    expect(board.postMessage(bob, { channel: 'dev', text: 'v4', id: '00000000-0000-4000-8000-000000000000' }).message.text).toBe('v4')
  })
})

describe('F5 a request uploads at most 4 MB, the deployment too; only the in-process import takes more (a2.ts:735-741)', () => {
  it('caps uploadAttachment for everyone and lets only the deployment import a bigger file', () => {
    const { board } = setup()
    const deployment: CallerContext = {
      principal: { id: 'board:deployment', kind: 'deployment', handle: 'board' },
      actor: { id: 'board:deployment', kind: 'deployment', handle: 'board', name: 'board', avatar: null },
      profile: null,
    }
    const big = { name: 'big.bin', type: 'application/octet-stream', data: Buffer.alloc(5 * 1024 * 1024, 1) }
    const capped = caught(() => board.uploadAttachment(deployment, big))
    expect([capped.status, capped.code]).toEqual([413, 'too_large'])
    expect(board.importAttachment(deployment, big).size).toBe(5 * 1024 * 1024)
    expect(caught(() => board.importAttachment(user('alice'), big)).status).toBe(403)
  })
})

describe('F6 an x-board-can the board cannot read is 400 invalid_scope (actors.ts:33-40, board.ts:318-325)', () => {
  it('answers invalid_scope for the header, and keeps invalid_can for a grant body', () => {
    const { board } = setup()
    const err = caught(() => board.listChannels(user('alice', { canHeader: 'garbage' })))
    expect([err.status, err.code]).toEqual([400, 'invalid_scope'])
    expect(caught(() => board.listChannels(user('alice', { canHeader: 'x'.repeat(5000) }))).code).toBe('invalid_scope')
  })
})

describe('F7 a schedule is named s12, 12 or ss12 (a2.ts:102-111 scheduleAt)', () => {
  it('cancels by each form, and answers 404 schedule_not_found for one that names none', () => {
    const { board } = setup()
    const alice = user('alice')
    const now = Date.parse('2026-11-22T12:00:00.000Z')
    const made = [1, 2, 3].map(() => board.createSchedule(alice, { channel: 'dev', text: 'x', in: '1m' }, now))
    expect(board.cancelSchedule(alice, '1').schedule.id).toBe(made[0]!.id)
    expect(board.cancelSchedule(alice, 'ss2').schedule.id).toBe(made[1]!.id)
    expect(board.cancelSchedule(alice, 's3').canceled).toBe(true)
    for (const id of ['s9', 'zz', 's0', 'sss1']) {
      expect(caught(() => board.cancelSchedule(alice, id)).code).toBe('schedule_not_found')
    }
  })
})

describe('N1 / N2 the original wording, and a post shows mentions only when it typed some', () => {
  it('words block and value refusals, garbage refs and reserved label keys as the original does', () => {
    const { board } = setup()
    const alice = user('alice')
    const block = (body: string) => `\`\`\`json#git-commit@1\n${body}\n\`\`\``
    const bad = caught(() => board.postMessage(alice, { channel: 'dev', text: block('{"repo":"a/b"}') }))
    expect([bad.code, bad.message]).toEqual(['invalid_block', "the git-commit@1 block doesn't match its schema: sha is missing"])
    const unknown = caught(() => board.postMessage(alice, { channel: 'dev', text: '```json#nope@1\n{}\n```' }))
    expect([unknown.code, unknown.message]).toEqual(['schema_not_found', "the nope@1 block names a schema this board doesn't have"])
    expect(caught(() => board.postMessage(alice, { re: 'abc', text: 'x' })).message).toBe('message not found: #abc')
    const proto = answered(() => board.postMessage(alice, { channel: 'dev', text: 'x', labels: JSON.parse('{"__proto__":"x"}') }))
    expect(proto).toEqual([400, 'invalid_request', 'labels: label key is a reserved name'])
  })

  it('words a value that does not match as the original checkValue does', () => {
    expect(checkSchemaValue({ properties: { a: { type: 'string' } } }, { a: 1 })).toBe('a must be a string')
    expect(checkSchemaValue({ type: 'object' }, [])).toBe('it must be an object')
    expect(checkSchemaValue({ properties: { a: { type: 'null' } } }, { a: 1 })).toBe('a must be null')
    expect(checkSchemaValue({ const: 'x' }, 'y')).toBe('it must be "x"')
    expect(checkSchemaValue({ enum: ['a', 'b', 'c'] }, 'z')).toBe('it must be "a", "b", or "c"')
    expect(checkSchemaValue({ type: 'string', format: 'email' }, 'nope')).toBe('it must be an email')
    expect(checkSchemaValue({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, null)).toBe(
      'it matches none of the 2 it can be: it must be a string; it must be an integer',
    )
  })

  it('omits mentions from a post that typed no @handle', () => {
    const { board } = setup()
    const alice = user('alice')
    const plain = board.postMessage(alice, { channel: 'dev', text: 'no handles here' })
    expect('mentions' in plain).toBe(false)
    expect(board.postMessage(alice, { channel: 'dev', text: 'hi @alice' }).mentions).toHaveLength(1)
  })
})

describe('V5 a request cannot pass the board-internal write flags', () => {
  it('ignores a trustedSync or trustedId it is handed', () => {
    const { board } = setup(false)
    grant(board, 'bob', { pub: ['read', 'post'] })
    const bob = user('bob')
    const post = board.postMessage as unknown as (c: CallerContext, i: unknown, o: unknown) => unknown
    expect(caught(() => post.call(board, bob, { channel: 'secret', text: 'x' }, { trustedSync: true })).status).toBe(403)
    expect(caught(() => post.call(board, bob, { channel: 'pub', text: 'x', id: 'sync:x' }, { trustedId: true })).status).toBe(400)
  })
})

// ============================================================================
// M1 gate iteration 3: findings the verifiers and challengers confirmed in iteration 2.

/** What a refused call answers on the wire: a ZodError as much as a BoardError, normalized. */
function refusal(fn: () => unknown): { status: number; code: string; message: string } {
  try {
    fn()
  } catch (e) {
    const { status, payload } = toErrorPayload(e)
    return { status, code: payload.error.code, message: payload.error.message }
  }
  throw new Error('expected a refusal')
}

describe('W1 a sync change to a message that is gone answers a null message (a2.ts:973-978)', () => {
  it('answers { message: null } for a delete or edit by origin and a react by ID of a missing message', () => {
    const { board } = setup()
    const bot = user('syncbot')
    board.registerWatchers(bot, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const origin = { channel: 'slack:C1', thread: 'slack:C1:9', subthread: null, message: '9', context: null }
    const author = platformUser('slack:U1')
    expect(board.syncImport(bot, { op: 'delete', author, from: 'slack', origin })).toEqual({ message: null })
    expect(board.syncImport(bot, { op: 'edit', author, from: 'slack', origin, text: 'x' })).toEqual({ message: null })
    expect(board.syncImport(bot, { op: 'react', author, from: 'slack', message: '999', emoji: 'eyes' })).toEqual({
      message: null,
    })
    // A platform delete retried after it landed is no error either.
    const { message } = board.syncImport(bot, {
      op: 'post',
      author,
      from: 'slack',
      channel: 'dev',
      text: 'imported',
      origin: { ...origin, thread: 'slack:C1:10', message: '10' },
    })
    const del = { op: 'delete', author, from: 'slack', origin: { ...origin, thread: 'slack:C1:10', message: '10' } }
    expect(board.syncImport(bot, del).message?.id).toBe(message.id)
    expect(board.syncImport(bot, del).message?.deleted).toBe(true)
  })
})

describe('W2 an import meets the platform users its text mentions, and names them as its own (a2.ts:913-935)', () => {
  it("rewrites a mention of a user of its keys to its profile of them, and records them as actors", () => {
    const { board } = setup()
    const bot = user('syncbot')
    board.registerWatchers(bot, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const cc = platformUser('slack:user:cc', 'carla')
    const { message } = board.syncImport(bot, {
      op: 'post',
      author: platformUser('slack:user:a'),
      from: 'slack',
      channel: 'dev',
      text: 'cc @[slack:user:cc] and @[teams:user:x]',
      mentioned: [cc],
    })
    expect(message.text).toBe('cc @[local:user:syncbot+slack:user:cc] and @[teams:user:x]')
    const met = board.listActors(owner()).find((a) => a.id === 'local:user:syncbot+slack:user:cc')
    expect(met).toMatchObject({ kind: 'external', handle: 'syncbot/carla', name: 'Malte Ubl' })

    // An edit's mentions are met and named the same way.
    const dee = platformUser('slack:user:dee', 'dee')
    const edited = board.syncImport(bot, {
      op: 'edit',
      author: platformUser('slack:user:a'),
      from: 'slack',
      message: message.id,
      text: 'now @[slack:user:dee]',
      mentioned: [dee],
    })
    expect(edited.message?.text).toBe('now @[local:user:syncbot+slack:user:dee]')
    expect(board.listActors(owner()).some((a) => a.id === 'local:user:syncbot+slack:user:dee')).toBe(true)
  })

  it('refuses a mentioned user of a key it does not sync, and meets no one then', () => {
    const { board } = setup()
    const bot = user('syncbot')
    board.registerWatchers(bot, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const e = caught(() =>
      board.syncImport(bot, {
        op: 'post',
        author: platformUser('slack:user:a'),
        from: 'slack',
        channel: 'dev',
        text: 'x',
        mentioned: [platformUser('teams:user:x')],
      }),
    )
    expect(e.status).toBe(403)
    expect(board.listActors(owner()).some((a) => a.id.includes('teams:user:x'))).toBe(false)
  })
})

describe('W3 a sync is handed each message change as a match of its @sync watcher (watch.ts:206-221)', () => {
  it('queues posts, edits, label changes (with the message before) and new targets, where it may sync', () => {
    const { board } = setup()
    const alice = user('alice')
    const syncer = owner()
    board.registerWatchers(syncer, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'hello' })
    board.editMessage(alice, message.id, { text: 'hello again' })
    board.labelMessage(alice, message.id, { set: { state: 'open' } })
    board.attachSyncTarget(syncer, message.id, { target: 'slack:C1' })

    const seen: string[] = []
    for (let i = 0; i < 10; i++) {
      const [match] = board.pullWatcherMatches(syncer, { limit: 10 })
      if (!match) break
      expect(match.watcher).toBe('@sync')
      expect(match.event.message?.id).toBe(message.id)
      seen.push(match.event.type)
      if (match.event.type === 'labels.changed') {
        const before = (match.event as { before?: { labels: Record<string, string> } }).before
        expect(before?.labels).toEqual({})
        expect(match.event.message?.labels).toEqual({ state: 'open' })
      }
      board.ackWatcherMatch(syncer, match.id, { lease: match.lease })
    }
    expect(seen).toEqual(['message.posted', 'message.edited', 'labels.changed', 'thread.synced'])
  })

  it('hands nothing to a registration with no sync, or where its registrant may read but not sync', () => {
    const { board } = setup(false)
    grant(board, 'alice', { dev: 'all' })
    grant(board, 'reader', { dev: ['read'], other: ['read', 'sync'] })
    const alice = user('alice')
    board.registerWatchers(user('reader'), { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    board.registerWatchers(alice, { watch: {} })
    board.postMessage(alice, { channel: 'dev', text: 'not for a sync' })
    expect(board.pullWatcherMatches(user('reader'))).toEqual([])
    expect(board.pullWatcherMatches(alice)).toEqual([])
  })

  it('skips a queued match once its registrant may still read the channel but no longer sync there (registered.ts:126-131)', () => {
    const { board } = setup(false)
    grant(board, 'alice', { dev: 'all' })
    const syncing = grant(board, 'syncer', { dev: ['read', 'sync'], other: ['sync'] })
    board.registerWatchers(user('syncer'), { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    board.postMessage(user('alice'), { channel: 'dev', text: 'queued for the sync' })
    board.updateGrant(owner(), syncing, { can: { dev: ['read'], other: ['sync'] } })
    expect(board.pullWatcherMatches(user('syncer'))).toEqual([])
  })
})

describe('W4 this board wakes nothing, so a registration names no url or path (a2.ts:764-767)', () => {
  it('answers 501 no_wake_by_url and no_wake_by_path, and stores nothing', () => {
    const { board } = setup()
    const alice = user('alice')
    const byUrl = caught(() => board.registerWatchers(alice, { url: 'https://x.example.com', watch: {} }))
    expect([byUrl.status, byUrl.code]).toEqual([501, 'no_wake_by_url'])
    expect(byUrl.message).toBe('this board wakes nothing: register no url, and pull your matches')
    const byPath = caught(() => board.registerWatchers(alice, { path: '/wake', watch: {} }))
    expect([byPath.status, byPath.code]).toEqual([501, 'no_wake_by_path'])
    expect(board.listWatchers(owner())).toEqual([])
    expect(board.registerWatchers(alice, { url: null, watch: {} }).url).toBeNull()
  })
})

describe("W5 a registration's hash is the original's watchersHash (watchers-hash.ts:12-23)", () => {
  it('hashes the watchers by ID and the sync entries by key, whatever order they came in', () => {
    const { board } = setup()
    const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32)
    const one = board.registerWatchers(user('a'), {
      watch: { zeta: { tail: 'dev' }, alpha: { tail: 'ops/ --label p=0' } },
      sync: [{ key: 'teams', platform: 'teams' }, { key: 'slack', platform: 'slack' }],
    })
    expect(one.hash).toBe(
      sha('[["alpha","ops/ --label p=0"],["zeta","dev"],["sync",[["slack","slack"],["teams","teams"]]]]'),
    )
    const two = board.registerWatchers(user('b'), {
      watch: { alpha: { tail: 'ops/ --label p=0' }, zeta: { tail: 'dev' } },
      sync: [{ key: 'slack', platform: 'slack' }, { key: 'teams', platform: 'teams' }],
    })
    expect(two.hash).toBe(one.hash)
    // One with no sync hashes as older registrations did: its watchers only.
    expect(board.registerWatchers(user('c'), { watch: { w: { tail: 'dev' } } }).hash).toBe(sha('[["w","dev"]]'))
  })
})

describe('W6 / W7 schemas: the built-ins listed first, and a bad name or version is the request\'s (schemas.ts:50-65)', () => {
  it('lists the built-ins before a schema that sorts ahead of them', () => {
    const { board } = setup()
    board.createSchema(owner(), { name: 'aaa', version: 1, schema: { type: 'object' } })
    expect(board.listSchemas(owner()).map((s) => `${s.id}:${s.builtIn}`)).toEqual([
      'git-commit@1:true',
      'vercel-deployment@1:true',
      'aaa@1:false',
    ])
  })

  it('answers 400 invalid_request naming the field, and checks the body before the caller', () => {
    const { board } = setup(false)
    const long = caught(() => board.createSchema(owner(), { name: `a${'b'.repeat(80)}`, version: 1, schema: {} }))
    expect([long.status, long.code, long.message]).toEqual([
      400,
      'invalid_request',
      'name: a schema name is up to 80 lowercase letters, numbers, and ._-, starting with a letter',
    ])
    const big = caught(() => board.createSchema(owner(), { name: 'ok', version: 100_000, schema: {} }))
    expect([big.status, big.code, big.message]).toEqual([400, 'invalid_request', 'version: a schema version is at most 99,999'])
    grant(board, 'alice', { dev: 'all' })
    expect(refusal(() => board.createSchema(user('alice'), { name: 'Bad Name', version: 1, schema: {} })).status).toBe(400)
    expect(caught(() => board.createSchema(user('alice'), { name: 'fine', version: 1, schema: {} })).status).toBe(403)
    const reserved = caught(() => board.createSchema(owner(), { name: 'git-commit', version: 2, schema: {} }))
    expect(reserved.message).toBe('git-commit is a built-in schema: register yours under another name')
  })
})

describe('W8 an edit and a schedule say what became of the @handles they typed (serve.ts:543-550, :675, :1022)', () => {
  it('answers mentions with the settled text, and none when no @handle was typed', () => {
    const { board } = setup()
    const alice = user('alice')
    board.postMessage(user('bob'), { channel: 'dev', text: 'here' })
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'draft' })
    const edited = board.editMessage(alice, message.id, { text: 'hi @bob and @nobody' })
    expect(edited.text).toBe('hi @[local:user:bob] and @nobody')
    expect(edited.mentions?.map((m) => [m.written, m.actor?.id ?? null])).toEqual([
      ['@bob', 'local:user:bob'],
      ['@nobody', null],
    ])
    expect('mentions' in board.editMessage(alice, message.id, { text: 'plain' })).toBe(false)

    const scheduled = board.createSchedule(alice, { channel: 'dev', text: 'ping @bob', in: '5m' })
    expect(scheduled.text).toBe('ping @[local:user:bob]')
    expect(scheduled.mentions?.map((m) => m.actor?.id)).toEqual(['local:user:bob'])
    expect(board.listSchedules(alice).find((s) => s.id === scheduled.id)?.text).toBe('ping @[local:user:bob]')
    expect('mentions' in board.createSchedule(alice, { channel: 'dev', text: 'plain', in: '5m' })).toBe(false)
  })
})

describe('W9 me: who the caller is here and what it may do (a2.ts:471-486)', () => {
  it('answers its actor, principal, profile and access summary', () => {
    const { board } = setup(false)
    grant(board, 'alice', { dev: ['read', 'post'] })
    const me = board.me(user('alice'))
    expect(me).toMatchObject({ actor: 'local:user:alice', principal: 'local:user:alice', handle: 'alice', profile: null, expiresAt: null })
    expect(me.can.dev).toEqual(expect.arrayContaining(['read', 'post']))
    expect(board.me(user('alice', { canHeader: 'dev=read' })).can).toEqual({ dev: ['read'] })
  })
})

describe('W10 error bodies worded as the original words them', () => {
  it('words reserved labels, a bad flag and a delete at a stale revision as serve.ts:90, routes.ts:43 and writes.ts:776 do', () => {
    const { board } = setup()
    const alice = user('alice')
    const reserved = caught(() => board.postMessage(alice, { channel: 'dev', text: 'x', labels: { 'board.task': '1' } }))
    expect([reserved.code, reserved.message]).toEqual([
      'reserved_label',
      "board.task is the board's own label: only its task writes set labels under board.",
    ])
    const flag = refusal(() => board.listSchedules(alice, { all: 'maybe' }))
    expect([flag.status, flag.message]).toEqual([400, 'all: Invalid option: expected one of "0"|"1"|"true"|"false"'])
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'v1' })
    board.editMessage(alice, message.id, { text: 'v2' })
    const stale = caught(() => board.deleteMessage(alice, message.id, { revision: Number(message.revision) }))
    expect(stale.message).toMatch(new RegExp(`^#${message.id} was edited since revision ${message.revision}: it's at \\d+$`))
  })

  it('words a bad watcher ID and too many watchers as the original register does (a2.ts:776-780)', () => {
    const { board } = setup()
    const alice = user('alice')
    const badId = caught(() => board.registerWatchers(alice, { watch: { '1bad': { tail: 'dev' } } }))
    expect([badId.code, badId.message]).toEqual([
      'bad_watcher',
      'watch 1bad: ids start with a letter and use up to 32 letters, numbers, and hyphens',
    ])
    const watch = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`w${i}`, { tail: 'dev' }]))
    const many = caught(() => board.registerWatchers(alice, { watch }))
    expect([many.code, many.message]).toEqual(['too_many_watchers', 'a registration holds at most 64 watchers'])
  })
})

describe('W11 syncCopies answers every ID for a caller that syncs everywhere (a2.ts:1058-1076)', () => {
  it('answers an empty entry for an ID that names no message, only where it syncs everywhere', () => {
    const { board } = setup(false)
    grant(board, 'partial', { dev: ['read', 'sync'] })
    expect(board.syncCopies(owner(), { message: ['999', '999', 'x'] })).toEqual({ copies: { '999': {} } })
    expect(board.syncCopies(user('partial'), { message: ['999'] })).toEqual({ copies: {} })
  })
})

describe('Q3 / S4 the service takes any StorageBackend, and checks a search like any other input', () => {
  it('runs on a StorageBackend, and answers a malformed search with 400 invalid_request', () => {
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    stores.push(store)
    const backend: StorageBackend = store
    const board = new BoardService(backend)
    board.postMessage(owner(), { channel: 'dev', text: 'hello world' })
    expect(board.search(owner(), { query: 'hello' }).map((h) => h.kind)).toEqual(['message'])
    const bad = (q: unknown) => refusal(() => board.search(owner(), q as FtsSearchQuery))
    for (const q of [
      { query: 42 },
      {},
      { query: 'hello', labels: 'x' },
      { query: 'hello', scope: 'bogus' },
      { query: 'hello', limit: Number.NaN },
    ]) {
      expect([bad(q).status, bad(q).code], JSON.stringify(q)).toEqual([400, 'invalid_request'])
    }
  })
})

// ============================================================================
// M1 gate iteration 4: findings the verifiers and challengers confirmed in iteration 3.

describe("F1 a sync's labels.changed match shows the message before only as its registrant may read it (feed.ts:101-104, watch.ts:212-214)", () => {
  const LINKED = 'LAUNCH-CODE-0000'
  const masked = { url: 'https://example.com/m', message: null, snapshot: null, unavailable: 'not_readable' }

  function linkedFromPub(board: BoardService): string {
    const secret = board.postMessage(owner(), { channel: 'secret/x', text: LINKED }).message
    board.registerWatchers(owner(), { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    return board.syncImport(owner(), {
      op: 'post',
      author: platformUser('slack:U1', 'u1'),
      from: 'slack',
      channel: 'pub/a',
      text: 'see linked',
      links: [{ url: 'https://example.com/m', message: secret.id, snapshot: null, unavailable: null }],
    }).message.id
  }

  function labelChanges(board: BoardService, who: CallerContext) {
    return board.pullWatcherMatches(who, { limit: 50 }).filter((m) => m.event.type === 'labels.changed')
  }

  it('masks the links of `before` for a registrant that may sync the channel but not read the linked one', () => {
    const { board, store } = setup(false)
    grant(board, 'syncer', { 'pub/': ['sync'] })
    const syncer = user('syncer')
    const id = linkedFromPub(board)
    board.registerWatchers(syncer, { watch: {}, sync: [{ key: 'teams', platform: 'teams' }] })
    board.labelMessage(owner(), id, { set: { tri: 'x' } })

    const [match] = labelChanges(board, syncer)
    expect(match?.watcher).toBe('@sync')
    const event = match!.event as { message?: { links: unknown[] }; before?: { links: unknown[] } }
    expect(event.message?.links).toEqual([masked])
    expect(event.before?.links).toEqual([masked])
    expect(JSON.stringify(match)).not.toContain(LINKED)
    // Nor is it kept in the queue: `before` is built as the registrant may see it.
    const queued = store.db
      .prepare('SELECT event_json FROM board_watcher_matches WHERE owner = ?')
      .all(syncer.principal.id) as { event_json: string }[]
    expect(queued.length).toBeGreaterThan(0)
    expect(queued.map((r) => r.event_json).join('\n')).not.toContain(LINKED)
  })

  it('masks them at the pull for a registrant that could read the linked channel when it matched, and no longer can', () => {
    const { board } = setup(false)
    const reading = grant(board, 'syncer', { 'pub/': ['sync'], 'secret/': ['read'] })
    const syncer = user('syncer')
    const id = linkedFromPub(board)
    board.registerWatchers(syncer, { watch: {}, sync: [{ key: 'teams', platform: 'teams' }] })
    board.labelMessage(owner(), id, { set: { tri: 'x' } })
    board.updateGrant(owner(), reading, { can: { 'pub/': ['sync'] } })

    const [match] = labelChanges(board, syncer)
    const event = match!.event as { before?: { links: unknown[] } }
    expect(event.before?.links).toEqual([masked])
    expect(JSON.stringify(match)).not.toContain(LINKED)
  })
})
