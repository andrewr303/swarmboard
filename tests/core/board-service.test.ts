import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
} from '../../src/core/index.ts'

const stores: SqliteUnifiedStore[] = []

function setup(): { store: SqliteUnifiedStore; board: BoardService } {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return { store, board: new BoardService(store) }
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()!.close()
  }
})

describe('BoardService (F1 Channels, F2 Threads/Blocks/Mentions, F3 Labels/Events, F5)', () => {
  it('handles channel creation, auto-create on post, and subtree queries without SQL LIKE underscore bugs', () => {
    const { board } = setup()
    const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })

    const c1 = board.createChannel(alice, { path: 'work/corp' })
    expect(c1.created).toBe(true)
    expect(c1.channel.path).toBe('work/corp')

    const c1Again = board.createChannel(alice, { path: 'work/corp' })
    expect(c1Again.created).toBe(false)

    // Auto-create channels containing underscores
    board.postMessage(alice, { channel: 'foo_bar', text: 'in foo_bar' })
    board.postMessage(alice, { channel: 'foo_baz', text: 'in foo_baz' })
    board.postMessage(alice, { channel: 'foo_b/sub', text: 'in foo_b/sub' })

    const sub = board.listThreads(alice, { channel: 'foo_b/' })
    expect(sub.threads).toHaveLength(1)
    expect(sub.threads[0]!.message.channel).toBe('foo_b/sub')

    const page = board.listChannels(alice, { prefix: 'foo_' })
    expect(page.channels.map((c) => c.path)).toEqual(['foo_b/sub', 'foo_bar', 'foo_baz'])
  })

  it('enforces 1-level thread flattening, after CAS, revision CAS, and idempotency replay', () => {
    const { board } = setup()
    const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })

    const { message: root } = board.postMessage(alice, {
      channel: 'dev',
      text: 'Root message',
      id: 'client-root-1',
    })
    // Idempotent replay succeeds with same place/author
    const replay = board.postMessage(alice, {
      channel: 'dev',
      text: 'Root message',
      id: 'client-root-1',
    })
    expect(replay.message.id).toBe(root.id)

    // Same id in different channel -> 409 duplicate_id
    expect(() =>
      board.postMessage(alice, { channel: 'general', text: 'Conflict', id: 'client-root-1' }),
    ).toThrowError(BoardError)
    try {
      board.postMessage(alice, { channel: 'general', text: 'Conflict', id: 'client-root-1' })
    } catch (e) {
      expect((e as BoardError).status).toBe(409)
      expect((e as BoardError).code).toBe('duplicate_id')
    }

    // First reply directly to root -> replyTo is null
    const { message: r1 } = board.postMessage(alice, { re: root.id, text: 'Reply 1' })
    expect(r1.re).toBe(root.id)
    expect(r1.replyTo).toBeNull()

    // Reply to r1 -> flattened: re = root.id, replyTo = r1.id
    const { message: r2 } = board.postMessage(alice, {
      re: r1.id,
      text: 'Reply 2',
      after: r1.id,
    })
    expect(r2.re).toBe(root.id)
    expect(r2.replyTo).toBe(r1.id)

    // Stale `after` -> 409 newer_message
    try {
      board.postMessage(alice, { re: root.id, text: 'Stale reply', after: r1.id })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(409)
      expect((e as BoardError).code).toBe('newer_message')
    }

    // Wrong thread `after` -> 400 invalid_after
    const { message: otherRoot } = board.postMessage(alice, { channel: 'dev', text: 'Other thread' })
    try {
      board.postMessage(alice, { re: root.id, text: 'Wrong thread', after: otherRoot.id })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(400)
      expect((e as BoardError).code).toBe('invalid_after')
    }

    // Revision CAS on edit & delete
    const edited = board.editMessage(alice, r1.id, { text: 'Reply 1 edited', revision: r1.revision })
    expect(edited.text).toBe('Reply 1 edited')
    expect(edited.revision).toBeGreaterThan(r1.revision)

    try {
      board.editMessage(alice, r1.id, { text: 'Stale edit', revision: r1.revision })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(409)
      expect((e as BoardError).code).toBe('revision_conflict')
    }

    const deleted = board.deleteMessage(alice, r2.id, { revision: r2.revision })
    expect(deleted.deleted).toBe(true)
    expect(deleted.text).toBe('')

    const thread = board.getMessageThread(alice, r1.id)
    expect(thread.message.id).toBe(root.id)
    expect(thread.replies.map((r) => r.id)).toEqual([r1.id, r2.id])
  })

  it('enforces atomic conditional labels, reserved board.* rejection, and root+reply label filtering', () => {
    const { board } = setup()
    const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })

    expect(() =>
      board.postMessage(alice, {
        channel: 'dev',
        text: 'bad label',
        labels: { 'board.task': 'ready' },
      }),
    ).toThrowError(BoardError)

    const { message: root } = board.postMessage(alice, {
      channel: 'dev',
      text: 'PR #12',
      labels: { status: 'open' },
    })
    board.postMessage(alice, { re: root.id, text: 'LGTM', labels: { review: 'approved' } })

    // CAS succeeds when matching
    const updated = board.labelMessage(alice, root.id, {
      set: { status: 'merged', env: 'prod' },
      if: { status: 'open', env: null },
    })
    expect(updated.labels).toEqual({ status: 'merged', env: 'prod' })

    // CAS fails on mismatch -> 409 label_conflict
    try {
      board.labelMessage(alice, root.id, {
        set: { status: 'closed' },
        if: { status: 'open' },
      })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(409)
      expect((e as BoardError).code).toBe('label_conflict')
    }

    // Root label matches thread even when filtering on reply's label
    const threads = board.listThreads(alice, { label: ['status=merged|closed', 'review'] })
    expect(threads.threads).toHaveLength(1)
    expect(threads.threads[0]!.message.id).toBe(root.id)
  })

  it('validates built-in & custom data schemas on json# blocks and settles @mentions outside code', () => {
    const { board } = setup()
    const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
    const bob = createLocalCaller({ userId: 'bob', handle: 'bob' })

    // Register bob in actors table via initial post
    board.postMessage(bob, { channel: 'dev', text: 'hi' })

    // Built-in git-commit@1 works
    const commitMsg = board.postMessage(alice, {
      channel: 'dev',
      text: `Hey @bob check \`@bob\`:\n\`\`\`json#git-commit@1\n${JSON.stringify({ sha: 'a'.repeat(40), title: 'feat: core' })}\n\`\`\``,
    })
    expect(commitMsg.message.blocks).toEqual([
      { schema: 'git-commit', version: 1, data: { sha: 'a'.repeat(40), title: 'feat: core' } },
    ])
    expect(commitMsg.message.text).toContain(`@[${bob.actor.id}]`)
    expect(commitMsg.message.text).toContain('`@bob`')

    // Invalid block data -> 400 invalid_block
    try {
      board.postMessage(alice, {
        channel: 'dev',
        text: '```json#git-commit@1\n{"sha":"short","title":"x"}\n```',
      })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(400)
      expect((e as BoardError).code).toBe('invalid_block')
    }

    // Unknown schema -> 400 schema_not_found
    try {
      board.postMessage(alice, {
        channel: 'dev',
        text: '```json#missing@1\n{"x":1}\n```',
      })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(400)
      expect((e as BoardError).code).toBe('schema_not_found')
    }

    // Reserved built-in schema -> 409 reserved_schema
    try {
      board.createSchema(alice, {
        name: 'git-commit',
        version: 2,
        schema: { type: 'object' },
      })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(409)
      expect((e as BoardError).code).toBe('reserved_schema')
    }

    // Custom schema immutable check -> 409 schema_immutable
    const s = board.createSchema(alice, {
      name: 'deploy-check',
      version: 1,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
    })
    expect(s.id).toBe('deploy-check@1')
    try {
      board.createSchema(alice, {
        name: 'deploy-check',
        version: 1,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'extra'],
          properties: { ok: { type: 'boolean' }, extra: { type: 'string' } },
        },
      })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(409)
      expect((e as BoardError).code).toBe('schema_immutable')
    }
  })

  it('scrubs carried reactions on getEvents(last), hides actor.seen unless all=true, and supports long-poll wait', async () => {
    const { board } = setup()
    const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })

    const { message: m1 } = board.postMessage(alice, { channel: 'dev', text: 'first' })
    board.reactMessage(alice, m1.id, { emoji: '+1' })
    board.reactMessage(alice, m1.id, { emoji: 'thumbs_up', remove: true })

    const pageDefault = await board.getEvents(alice, { last: 20 })
    expect(pageDefault.events.some((e) => e.type === 'actor.seen')).toBe(false)
    // Removed reaction must be scrubbed by carried()
    expect(pageDefault.events.some((e) => e.type === 'reaction.added')).toBe(false)

    const pageAll = await board.getEvents(alice, { last: 20, all: true })
    expect(pageAll.events.some((e) => e.type === 'actor.seen')).toBe(true)

    const waitPromise = board.getEvents(alice, { after: pageDefault.cursor, wait: 2 })
    setTimeout(() => {
      board.postMessage(alice, { channel: 'dev', text: 'woke up' })
    }, 20)
    const waited = await waitPromise
    expect(waited.events.some((e) => e.type === 'message.posted' && e.message?.text === 'woke up')).toBe(true)
  })

  it('supports schedules, watchers, attachments, and sync hooks', () => {
    const { board } = setup()
    const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })

    // Attachments & direct upload
    const att = board.uploadAttachment(alice, {
      name: 'spec.txt',
      type: 'text/plain',
      data: Buffer.from('hello swarmboard'),
    })
    expect(board.getAttachment(alice, att.id).data.toString('utf8')).toBe('hello swarmboard')

    const ticket = board.startDirectUpload(alice, { name: 'big.bin', type: 'application/octet-stream', size: 4 })
    const uploaded = board.finishDirectUpload(alice, ticket.id, Buffer.from([1, 2, 3, 4]))
    expect(uploaded.size).toBe(4)

    // Watchers
    // A delivery receipt is only for a sync key the caller's sync registered (original a2.ts:1294-1296 deliverable).
    const reg = board.registerWatchers(alice, {
      url: null,
      watch: { triage: { tail: 'ops/ --label severity=p0' } },
      sync: [{ key: 'slack', platform: 'slack' }],
    })
    expect(reg.owner).toBe(alice.principal.id)

    const { message: alert } = board.postMessage(alice, {
      channel: 'ops/db',
      text: 'DB disk full',
      labels: { severity: 'p0' },
      attachments: [att.id],
    })
    const matches = board.pullWatcherMatches(alice, { limit: 10 })
    // Its watcher's match, and its sync's: a registration with sync entries gets every message
    // change where it may sync, as its @sync watcher's match (original server/watch.ts:206-221).
    expect(matches.map((m) => m.watcher).sort()).toEqual(['@sync', 'triage'])
    const triage = matches.find((m) => m.watcher === 'triage')!
    expect(board.ackWatcherMatch(alice, triage.id, { lease: triage.lease }).ok).toBe(true)

    // Schedules
    const baseMs = Date.parse('2026-11-22T23:00:00.000Z')
    const sched = board.createSchedule(
      alice,
      { channel: 'ops/db', text: 'Periodic check', in: '60s', every: '60s', times: 2 },
      baseMs,
    )
    const fired = board.runDueSchedules(baseMs + 60_000).sent
    expect(fired).toHaveLength(1)
    expect(fired[0]!.schedule).toEqual({ id: sched.id, n: 0 })
    board.cancelSchedule(alice, sched.id)
    expect(board.listSchedules(alice, { all: true })[0]!.state).toBe('canceled')

    // Sync hooks
    expect(board.attachSyncTarget(alice, alert.id, { target: 'slack:C123:1700.1' }).attached).toBe(true)
    const bob = createLocalCaller({ userId: 'bob', handle: 'bob', owner: true })
    const { message: alert2 } = board.postMessage(bob, { channel: 'ops/db', text: 'Another thread' })
    try {
      board.attachSyncTarget(bob, alert2.id, { target: 'slack:C123:1700.1' })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(409)
      expect((e as BoardError).code).toBe('already_synced')
    }

    board.syncReceipt(alice, {
      kind: 'message',
      message: alert.id,
      target: 'slack:C123:1700.1',
      external: { thread: 'slack:C123:1700.1', message: '1700.1' },
    })
    expect(board.getSynced(alice, alert.id).targets[0]!.message).toBe('1700.1')
    expect(board.syncFind(alice, { thread: 'slack:C123:1700.1', message: '1700.1' }).message).toBe(alert.id)

    board.inboxPush(alice, 'slack', {
      events: [
        {
          id: 'ev-1',
          event: {
            kind: 'deleted',
            channel: 'slack:C123',
            thread: 'slack:C123:1700.1',
            subthread: null,
            message: '1700.1',
          },
          raw: { ts: '1700.1' },
        },
      ],
    })
    const inboxItems = board.inboxNext(alice, 'slack', { limit: 5 })
    expect(inboxItems).toHaveLength(1)
    expect(board.inboxAck(alice, 'slack', inboxItems[0]!.id, { lease: inboxItems[0]!.lease }).ok).toBe(true)
  })
})

// M1 gate iteration 2 (V6): nothing imported into the service goes unused.
describe('board-service imports', () => {
  it('uses every name it imports', () => {
    const source = readFileSync(join(import.meta.dirname, '../../src/core/board-service.ts'), 'utf8')
    const imports = [...source.matchAll(/^import (?:type )?\{([^}]*)\} from '[^']+'/gm)]
    const body = source.replace(/^import (?:type )?\{[^}]*\} from '[^']+'/gm, '')
    const names = imports.flatMap((m) => m[1]!.split(',').map((n) => n.trim().replace(/^type /, '')).filter(Boolean))
    expect(names.length).toBeGreaterThan(50)
    const unused = names.filter((name) => !new RegExp(`\\b${name}\\b`).test(body))
    expect(unused).toEqual([])
  })
})
