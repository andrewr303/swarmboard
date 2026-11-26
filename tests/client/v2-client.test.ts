// Comprehensive tests for Swarmboard v2 client surface (W2-B):
// All 22 new ops via BoardClient sugar + raw call(), V2-07..V2-10 client flows, flag, feedback, and thin barrel.
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  type NotificationsPage,
} from '../../src/core/public.ts'
import {
  createBoardClient,
  isBoardError,
  OP_NAMES,
  OPS,
  CLIENT_ERROR_STATUSES,
  compactAgentInbox,
  formatInboxDigest,
  type BoardClient,
  type BoardTransport,
  type CallOptions,
  type OpInput,
  type OpName,
  type OpOutput,
  type Selection,
} from '../../src/client/index.ts'
import { fixedIdentity, localIdentity } from '../../src/client/identity.ts'
import { InProcessTransport } from '../../src/client/transport-inproc.ts'

const BASE_SEL: Selection = { mode: 'in-process', reason: 'test', source: 'option:service' }

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    await fn()
  }
})

function setupMultiAgentBoard(now?: () => number) {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  const service = new BoardService(store, now ? { now } : undefined)

  const makeClient = (opts: {
    userId: string
    profile?: string | null
    owner?: boolean
    profiles?: readonly string[]
  }): BoardClient => {
    const identity = localIdentity({
      userId: opts.userId,
      handle: opts.userId,
      name: opts.userId,
      member: true,
      owner: opts.owner ?? false,
      profiles: opts.profiles ?? (opts.profile ? [opts.profile] : []),
      defaultProfile: opts.profile ?? null,
    })
    const transport = new InProcessTransport({ board: service, identity })
    const client = createBoardClient(transport, { selection: BASE_SEL })
    cleanups.push(() => client.close())
    return client
  }

  const agy = makeClient({ userId: 'alice', profile: 'agy', profiles: ['agy', 'codex', 'claude'] })
  const codex = makeClient({ userId: 'alice', profile: 'codex', profiles: ['codex'] })
  const claude = makeClient({ userId: 'alice', profile: 'claude', profiles: ['claude'] })
  const owner = makeClient({ userId: 'alice', profile: null, owner: true, profiles: ['agy', 'codex', 'claude'] })

  cleanups.push(() => store.close())
  return { store, service, agy, codex, claude, owner, makeClient }
}

async function expectError(fn: () => unknown, match: { status: number; code: string }) {
  try {
    await fn()
    expect.unreachable(`expected error ${match.status} ${match.code}`)
  } catch (e) {
    expect(isBoardError(e), String(e)).toBe(true)
    if (!isBoardError(e)) return
    expect(e.status).toBe(match.status)
    expect(e.code).toBe(match.code)
    return e
  }
}

describe('BoardClient v2 channels, tree, DMs & private ACLs', () => {
  it('createChannel metadata, updateChannel, channelTree hierarchy + unread counts + private ACL hiding', async () => {
    const { agy, codex, claude, owner } = setupMultiAgentBoard()

    // v1 byte-compatible creation (no metadata)
    const plain = await agy.createChannel('general')
    expect(plain.created).toBe(true)
    expect(plain.channel.path).toBe('general')
    expect(plain.channel.private).toBeUndefined()

    // Rich metadata + nested channels
    const dev = await agy.createChannel('repos/agent-board/dev', {
      kind: 'chat',
      category: 'repos/agent-board',
      parent: 'repos/agent-board',
      topic: 'Active implementation',
      repo: 'agent-board',
      sortOrder: 1,
    })
    expect(dev.created).toBe(true)
    expect(dev.channel).toMatchObject({
      path: 'repos/agent-board/dev',
      kind: 'chat',
      topic: 'Active implementation',
      repo: 'agent-board',
    })

    // Private channel visible to agy & codex, hidden from claude, auditable by owner
    const secret = await agy.createChannel('repos/agent-board/secret', {
      private: true,
      topic: 'Restricted',
      members: ['codex'],
    })
    expect(secret.channel.private).toBe(true)

    const updated = await agy.updateChannel('repos/agent-board/dev', {
      topic: 'Updated topic',
      sortOrder: 2,
    })
    expect(updated.channel.topic).toBe('Updated topic')
    expect(updated.channel.sortOrder).toBe(2)

    await agy.post('repos/agent-board/dev', 'hello dev')
    await agy.post('repos/agent-board/secret', 'secret note')

    const agyTree = await agy.channelTree()
    expect(agyTree.cursor).toBeTypeOf('string')
    const reposNode = agyTree.tree.find((n) => n.segment === 'repos')
    expect(reposNode?.virtual).toBe(true)
    const abNode = reposNode?.children.find((n) => n.segment === 'agent-board')
    expect(abNode?.children.map((c) => c.segment).sort()).toEqual(['dev', 'secret'])

    // claude does NOT see secret in channelTree
    const claudeTree = await claude.channelTree()
    const claudeAb = claudeTree.tree
      .find((n) => n.segment === 'repos')
      ?.children.find((n) => n.segment === 'agent-board')
    expect(claudeAb?.children.map((c) => c.segment)).toEqual(['dev'])

    // codex sees both dev and secret, and unread counts drop after markChannelRead
    const codexBefore = await codex.channelTree({ includeUnread: true })
    const codexDevBefore = codexBefore.tree
      .find((n) => n.segment === 'repos')
      ?.children.find((n) => n.segment === 'agent-board')
      ?.children.find((c) => c.segment === 'dev')
    expect(codexDevBefore?.unreadCount).toBeGreaterThanOrEqual(1)

    const readRes = await codex.markChannelRead('repos/agent-board/dev')
    expect(readRes.channel).toBe('repos/agent-board/dev')

    const codexAfter = await codex.channelTree({ includeUnread: true })
    const codexDevAfter = codexAfter.tree
      .find((n) => n.segment === 'repos')
      ?.children.find((n) => n.segment === 'agent-board')
      ?.children.find((c) => c.segment === 'dev')
    expect(codexDevAfter?.unreadCount).toBe(0)

    // owner can still see secret channel
    const ownerTree = await owner.channelTree()
    const ownerAb = ownerTree.tree
      .find((n) => n.segment === 'repos')
      ?.children.find((n) => n.segment === 'agent-board')
    expect(ownerAb?.children.map((c) => c.segment).sort()).toEqual(['dev', 'secret'])
  })

  it('dm() converges symmetrically, sends/reads messages, notifies peer, and hides from 3rd agent', async () => {
    const { agy, codex, claude, owner } = setupMultiAgentBoard()

    // Ensure actors exist
    await agy.post('general', 'agy online')
    await codex.post('general', 'codex online')

    // String shorthand posts to canonical DM
    const sent = await agy.dm('codex', 'Hey codex, ready for W2-B?')
    expect(sent.channel.path).toBe('dm/agy--codex')
    expect(sent.channel.kind).toBe('dm')
    expect(sent.channel.private).toBe(true)
    expect(sent.created).toBe(true)
    expect(sent.message.text).toBe('Hey codex, ready for W2-B?')

    // Options object post with quoteMessageId & topic
    const reply = await codex.dm('agy', {
      text: 'Yes, shipping now!',
      quoteMessageId: sent.message.id,
      topic: 'W2 coordination',
    })
    expect(reply.channel.path).toBe('dm/agy--codex')
    expect(reply.created).toBe(false)
    expect(reply.message.quote?.id).toBe(sent.message.id)

    // Read mode (no text)
    const history = await agy.dm('codex', { limit: 10 })
    expect(history.channel.path).toBe('dm/agy--codex')
    expect(history.messages).toHaveLength(2)
    expect(history.cursor).toBeTypeOf('string')

    // codex received a DM notification automatically
    const codexNotifs = await codex.notifications.list()
    expect(codexNotifs.notifications.some((n) => n.reason === 'dm' && n.channel === 'dm/agy--codex')).toBe(true)

    // claude (3rd agent) cannot read DM messages (404 hidden = missing)
    await expectError(() => claude.thread(sent.message.id), { status: 404, code: 'message_not_found' })
    expect(await claude.search({ query: 'shipping' })).toEqual([])

    // owner can inspect DM
    const ownerThread = await owner.thread(sent.message.id)
    expect(ownerThread.message.text).toBe('Hey codex, ready for W2-B?')
  })
})

describe('BoardClient v2 groups, notifications, waitNotifications, agentInbox (V2-07)', () => {
  it('groups CRUD, member add/remove (array & object forms), reserved/duplicate errors, and @group fanout', async () => {
    const { agy, codex, claude } = setupMultiAgentBoard()

    await expectError(() => agy.groups.create({ handle: 'channel', name: 'Reserved' }), {
      status: 400,
      code: 'group_reserved',
    })

    const created = await agy.groups.create({
      handle: 'reviewers',
      name: 'Code Reviewers',
      description: 'Core review squad',
      kind: 'role',
      members: ['codex'],
    })
    expect(created.handle).toBe('reviewers')
    expect(created.members.map((m) => m.memberId)).toEqual(['codex'])

    await expectError(() => agy.groups.create({ handle: 'reviewers', name: 'Dup' }), {
      status: 409,
      code: 'group_exists',
    })

    // addMembers array form with role
    const withClaude = await agy.groups.addMembers('reviewers', ['claude'], { role: 'lead' })
    expect(withClaude.members.find((m) => m.memberId === 'claude')?.role).toBe('lead')

    // addMembers object form
    const withExtra = await agy.groups.addMembers('reviewers', { members: ['qa-bot'], role: 'member' })
    expect(withExtra.members.some((m) => m.memberId === 'qa-bot')).toBe(true)

    const updated = await agy.groups.update('reviewers', { description: 'Updated reviewers' })
    expect(updated.description).toBe('Updated reviewers')

    const listed = await agy.groups.list({ kind: 'role' })
    expect(listed.some((g) => g.handle === 'reviewers')).toBe(true)

    const fetched = await agy.groups.get('reviewers')
    expect(fetched.description).toBe('Updated reviewers')

    // Posting @reviewers notifies codex & claude (not caller agy)
    await agy.post('dev', 'Please review @reviewers')
    const codexNotifs = await codex.notifications.list()
    expect(codexNotifs.notifications.some((n) => n.reason === 'group_mention' && n.sourceGroup === 'reviewers')).toBe(
      true,
    )
    const claudeNotifs = await claude.notifications.list()
    expect(claudeNotifs.notifications.some((n) => n.reason === 'group_mention' && n.sourceGroup === 'reviewers')).toBe(
      true,
    )

    // removeMembers (array & object) + delete
    const afterRemove = await agy.groups.removeMembers('reviewers', ['qa-bot'])
    expect(afterRemove.members.some((m) => m.memberId === 'qa-bot')).toBe(false)
    await agy.groups.removeMembers('reviewers', { members: ['codex'] })
    expect(await agy.groups.delete('reviewers')).toEqual({ deleted: true })
    await expectError(() => agy.groups.get('reviewers'), { status: 404, code: 'group_not_found' })
  })

  it('notifications list/count/ack/ackAll/wait (wake, timeout, abort, bad wait, expectInstance) and V2-07 agentInbox', async () => {
    const { agy, codex } = setupMultiAgentBoard()

    // Seed assigned task with live reply + deleted tombstone, plus a ready task
    const assigned = await agy.tasks.create('work', {
      text: 'Implement v2 client',
      for: 'local:user:alice+codex',
      labels: { priority: 'urgent' },
    })
    await agy.reply(assigned.task.id, 'Keep client.ts thin')
    const dead = await agy.reply(assigned.task.id, 'typo to delete')
    await agy.delete(dead.id)

    await agy.tasks.create('work', { text: 'Open backlog item' })
    await agy.presence.set({ status: 'active', channel: 'dev', harness: 'agy', model: 'gemini' })
    await agy.post('decisions', 'Need sign-off @codex')

    // V2-07: 1-call agentInbox composite
    const inbox = await codex.agentInbox()
    expect(inbox.actor).toBe('local:user:alice+codex')
    expect(inbox.unreadNotifications).toBeGreaterThanOrEqual(2)
    expect(inbox.urgentCount).toBeGreaterThanOrEqual(1)
    expect(inbox.onlinePeers).toBe(1)
    expect(inbox.tasks.assigned).toHaveLength(1)
    expect(inbox.tasks.assigned[0]!.latestReply?.excerpt).toContain('Keep client.ts thin')
    expect(inbox.tasks.ready).toHaveLength(1)

    // Verify compact projection + digest text from thin barrel
    const compactInbox = compactAgentInbox(inbox)
    expect(compactInbox.unreadNotifications).toBe(inbox.unreadNotifications)
    const digest = formatInboxDigest(inbox)
    expect(digest).toContain('inbox @codex')
    expect(digest).toContain('tasks.assigned:')
    expect(digest).toContain('Keep client.ts thin')

    // count + ack (readOnly then full) + ackAll
    const counts = await codex.notifications.count()
    expect(counts.unread).toBe(inbox.unreadNotifications)

    const firstId = inbox.notifications[0]!.id
    const readOnlyAck = await codex.notifications.ack(firstId, { readOnly: true })
    expect(readOnlyAck.ok).toBe(true)
    expect(readOnlyAck.notification.readAt).not.toBeNull()
    expect(readOnlyAck.notification.ackedAt).toBeNull()

    const fullAck = await codex.notifications.ack(firstId)
    expect(fullAck.notification.ackedAt).not.toBeNull()

    const ackedAll = await codex.notifications.ackAll({ markChannelRead: true })
    expect(ackedAll.acked).toBeGreaterThanOrEqual(1)
    expect((await codex.notifications.count()).unread).toBe(0)

    // notifications.wait wakes promptly on peer mention
    const t0 = Date.now()
    setTimeout(() => {
      void agy.post('dev', 'wake up @codex!')
    }, 40)
    const woke = await codex.notifications.wait({ wait: 3 })
    expect(woke.notifications).toHaveLength(1)
    expect(woke.notifications[0]!.excerpt).toContain('wake up @codex!')
    expect(Date.now() - t0).toBeLessThan(400)

    // Ack and test quiet bounded timeout
    await codex.notifications.ackAll()
    const t1 = Date.now()
    const quiet = await codex.notifications.wait({}, { timeout: '150ms' })
    expect(quiet.notifications).toEqual([])
    expect(Date.now() - t1).toBeGreaterThanOrEqual(120)

    // Bad wait value rejects 400 invalid_request
    await expectError(() => codex.notifications.wait({ wait: -1 }), { status: 400, code: 'invalid_request' })
    await expectError(() => codex.notifications.wait({ wait: Number.NaN }), { status: 400, code: 'invalid_request' })

    // Abort ends wait immediately
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    const t2 = Date.now()
    const aborted = await codex.notifications.wait({ wait: 5 }, { signal: ac.signal })
    expect(aborted.notifications).toEqual([])
    expect(Date.now() - t2).toBeLessThan(250)
  })

  it('notifications.wait propagates expectInstance on round 2+', async () => {
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    const service = new BoardService(store)
    const transport = new InProcessTransport({ board: service, identity: fixedIdentity(createLocalCaller()) })
    cleanups.push(async () => {
      await transport.close()
      store.close()
    })
    const instanceId = transport.capabilities.instanceId!
    const seen: Array<string | undefined> = []
    let round = 0
    const mockTransport: BoardTransport = {
      get capabilities() {
        return transport.capabilities
      },
      get closed() {
        return transport.closed
      },
      async call<O extends OpName>(op: O, input: OpInput<O>, opts?: CallOptions): Promise<OpOutput<O>> {
        if (op === 'waitNotifications') {
          seen.push(opts?.expectInstance)
          round += 1
          if (round === 1) {
            return { notifications: [], cursor: '0', unread: 0, urgent: 0 } as NotificationsPage as OpOutput<O>
          }
          return {
            notifications: [
              {
                id: '1',
                logIndex: 1,
                recipient: 'local:user:local',
                reason: 'mention',
                priority: 'normal',
                sourceGroup: null,
                channel: 'dev',
                thread: 't1',
                rootId: '1',
                messageId: '1',
                byActor: 'local:user:bob',
                byHandle: 'bob',
                excerpt: 'ping',
                createdAt: new Date().toISOString(),
                readAt: null,
                ackedAt: null,
              },
            ],
            cursor: '1',
            unread: 1,
            urgent: 0,
          } as NotificationsPage as OpOutput<O>
        }
        return transport.call(op, input, opts)
      },
      events: (q, o) => transport.events(q, o),
      close: () => transport.close(),
    }
    const client = createBoardClient(mockTransport, { selection: BASE_SEL })
    const res = await client.notifications.wait({ wait: 2 })
    expect(res.notifications).toHaveLength(1)
    expect(seen).toEqual([undefined, instanceId])
  })
})

describe('BoardClient v2 pins (V2-08), presence (V2-09), thr_/quotes (V2-10), flag & feedback', () => {
  it('V2-08 pins (announcement/channel/thread), unpin, and forum vs chronological thread ordering', async () => {
    const { agy } = setupMultiAgentBoard()

    const m1 = await agy.post('forum', 'Old normal thread')
    const m2 = await agy.post('forum', 'Sticky topic')
    const m3 = await agy.post('forum', 'Announcement post')
    const m4 = await agy.post('forum', 'Newest normal thread')
    const reply = await agy.reply(m2.id, 'Important reply to pin in thread')

    const pAnn = await agy.pins.pin(m3.id, { scope: 'announcement', note: 'Read first' })
    expect(pAnn.created).toBe(true)
    expect(pAnn.pin.scope).toBe('announcement')

    const pSticky = await agy.pins.pin(m2.id, { scope: 'channel', note: 'Pinned guide' })
    expect(pSticky.created).toBe(true)

    const pThread = await agy.pins.pin(reply.id, { scope: 'thread', note: 'Key answer' })
    expect(pThread.pin.messageId).toBe(reply.id)

    // Default chronological order stays oldest-activity-to-newest-activity (reply bumped m2's `at` past m4)
    const chrono = await agy.threads({ channel: 'forum' })
    expect(chrono.threads.map((t) => t.message.id)).toEqual([m1.id, m3.id, m4.id, m2.id])

    // Forum order: announcement -> channel sticky -> newest active first
    const forum = await agy.threads({ channel: 'forum', order: 'forum', includeMeta: true })
    expect(forum.threads.map((t) => t.message.id)).toEqual([m3.id, m2.id, m4.id, m1.id])
    expect(forum.threads[0]!.pin?.scope).toBe('announcement')
    expect(forum.threads[1]!.pin?.scope).toBe('channel')

    const threadPins = await agy.pins.list({ thread: m2.id, scope: 'thread' })
    expect(threadPins).toHaveLength(1)
    expect(threadPins[0]!.messageId).toBe(reply.id)

    const unpinned = await agy.pins.unpin(m2.id, { scope: 'channel' })
    expect(unpinned.unpinned).toBe(1)
  })

  it('V2-09 presence set/list, TTL expiry, and private channel masking', async () => {
    let clockMs = Date.parse('2026-11-26T00:00:00.000Z')
    const { agy, claude } = setupMultiAgentBoard(() => clockMs)

    await agy.createChannel('secret-room', { private: true })
    const p1 = await agy.presence.set({
      status: 'busy',
      channel: 'secret-room',
      note: 'editing',
      harness: 'agy',
      model: 'gemini-3.1-pro',
      ttlS: 30,
    })
    expect(p1.status).toBe('busy')
    expect(p1.channel).toBe('secret-room')

    // claude cannot see private channel name in presence list
    const seenByClaude = await claude.presence.list()
    expect(seenByClaude).toHaveLength(1)
    expect(seenByClaude[0]!.status).toBe('busy')
    expect(seenByClaude[0]!.channel).toBeNull()

    // Past TTL -> disappears from default online list, shows as offline with includeOffline
    clockMs += 31_000
    expect(await claude.presence.list()).toEqual([])
    const withOffline = await claude.presence.list({ includeOffline: true })
    expect(withOffline[0]!.status).toBe('offline')
  })

  it('V2-10 thr_/msg_/# refs and quoteMessageId via BoardClient', async () => {
    const { agy } = setupMultiAgentBoard()

    const root = await agy.post('dev', 'Root message')
    const quoted = await agy.reply(`#${root.id}`, {
      text: 'Quoting with numeric quoteMessageId',
      quoteMessageId: Number(root.id),
    })
    expect(quoted.re).toBe(root.id)
    expect(quoted.quote?.id).toBe(root.id)
    expect(quoted.quote?.excerpt).toBe('Root message')

    const byThreadUuid = await agy.thread(root.thread)
    expect(byThreadUuid.message.id).toBe(root.id)
    expect(byThreadUuid.replies).toHaveLength(1)

    const byPrefix = await agy.thread(`msg_${root.id}`)
    expect(byPrefix.message.id).toBe(root.id)
  })

  it('flag() applies structured labels and optionally cross-posts to meta/feedback', async () => {
    const { agy } = setupMultiAgentBoard()
    const msg = await agy.post('dev', 'Potentially broken behavior')

    const flagged = await agy.flag(msg.id, 'flaky timeout under load', { feedback: true })
    expect(flagged.ok).toBe(true)
    expect(flagged.message.labels).toMatchObject({
      'flag.status': 'open',
      'flag.reason': 'flaky timeout under load',
      'flag.by': 'local:user:alice+agy',
    })
    expect(flagged.feedback?.channel).toBe('meta/feedback')
    expect(flagged.feedback?.labels['flag.target']).toBe(msg.id)

    const resolved = await agy.flag(msg.id, 'fixed in W2-B', { resolve: true })
    expect(resolved.message.labels['flag.status']).toBe('resolved')
    expect(resolved.feedback).toBeUndefined()

    await expectError(() => agy.flag(msg.id, '   '), { status: 400, code: 'invalid_request' })
  })

  it('feedback() posts typed board-feedback@1 block when schema exists and falls back cleanly when unseeded', async () => {
    const { agy, owner } = setupMultiAgentBoard()

    // 1. Unseeded board (no board-feedback@1 schema): graceful fallback succeeds!
    const fallbackPost = await agy.feedback({
      summary: 'CLI wait output could be terser',
      kind: 'ux',
      severity: 'low',
      harness: 'agy',
      repro: 'run ```swarmboard wait``` in loop',
    })
    expect(fallbackPost.channel).toBe('meta/feedback')
    expect(fallbackPost.labels).toMatchObject({
      kind: 'ux',
      severity: 'low',
      status: 'new',
      harness: 'agy',
    })
    expect(fallbackPost.text).toContain('CLI wait output could be terser')

    // 2. Register board-feedback@1 schema (as swarmboard init --universal does) -> structured block!
    await owner.createSchema({
      name: 'board-feedback',
      version: 1,
      description: 'Forgiving Swarmboard beta-tester feedback report',
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['summary'],
        properties: {
          summary: { type: 'string', minLength: 1, maxLength: 500 },
          kind: { type: 'string', enum: ['bug', 'ux', 'perf', 'feature', 'confusion', 'docs', 'other'] },
          severity: { type: 'string', enum: ['low', 'med', 'high', 'blocker'] },
        },
      },
    })

    const typedPost = await agy.feedback({
      summary: 'waitNotifications should default to 0s in core',
      kind: 'bug',
      severity: 'high',
      harness: 'agy',
      model: 'gemini-3.1-pro',
      repro: 'Call waitNotifications with ```{}```',
    })
    expect(typedPost.blocks).toHaveLength(1)
    expect(typedPost.blocks[0]!.schema).toBe('board-feedback')
    expect(typedPost.blocks[0]!.version).toBe(1)
    expect(typedPost.blocks[0]!.data['summary']).toBe('waitNotifications should default to 0s in core')

    await expectError(() => agy.feedback({ summary: '  ' }), { status: 400, code: 'invalid_request' })
  })

  it('src/client/index.ts exports the thin surface accurately (84 ops, 22 client error codes)', () => {
    expect(OP_NAMES).toHaveLength(84)
    expect(Object.keys(OPS)).toHaveLength(84)
    expect(CLIENT_ERROR_STATUSES.agent_identity_required).toBe(401)
    expect(CLIENT_ERROR_STATUSES.daemon_unavailable).toBe(503)
  })
})
