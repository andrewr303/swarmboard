import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardError,
  BoardService,
  canonicalDmChannel,
  createLocalCaller,
  dmSlug,
  GROUP_FANOUT_MAX,
  inferChannelKind,
  recipientKeysOf,
  resolveMessageId,
  SCHEMA_VERSION,
  SqliteUnifiedStore,
  type SqliteStoreOptions,
} from '../../src/core/index.ts'
import { V2_LAUNCH_SCHEMA_SQL } from '../../src/core/internal.ts'

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function freshPath(name = 'board.db'): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-v2-social-'))
  dirs.push(dir)
  return join(dir, name)
}

function openStore(path: string, extra: Partial<SqliteStoreOptions> = {}): SqliteUnifiedStore {
  const store = new SqliteUnifiedStore({ path, ...extra })
  stores.push(store)
  return store
}

afterEach(() => {
  while (stores.length > 0) {
    try {
      stores.pop()!.close()
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

function expectBoardError(fn: () => unknown, status: number, code: string): BoardError {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught, `expected BoardError ${status} ${code}`).toBeInstanceOf(BoardError)
  const err = caught as BoardError
  expect(err.status).toBe(status)
  expect(err.code).toBe(code)
  return err
}

const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const agy = createLocalCaller({ userId: 'alice', handle: 'alice', profile: 'agy' })
const codex = createLocalCaller({ userId: 'alice', handle: 'alice', profile: 'codex' })
const claude = createLocalCaller({ userId: 'alice', handle: 'alice', profile: 'claude' })
const narrowedAgy = createLocalCaller({
  userId: 'alice',
  handle: 'alice',
  profile: 'agy',
  cap: ['read', 'post', 'react', 'label'],
  assurance: 'agent_delegated',
})
const narrowedCodex = createLocalCaller({
  userId: 'alice',
  handle: 'alice',
  profile: 'codex',
  cap: ['read', 'post', 'react', 'label'],
  assurance: 'agent_delegated',
})
const narrowedClaude = createLocalCaller({
  userId: 'alice',
  handle: 'alice',
  profile: 'claude',
  cap: ['read', 'post', 'react', 'label'],
  assurance: 'agent_delegated',
})

describe('V2-01: Step 5 migration upgrade safety (v3 & v4 -> v5)', () => {
  it('upgrades both frozen v3 and v4 DBs atomically to Step 5 preserving data and boardId', () => {
    for (const fromVersion of [3, 4] as const) {
      const dbPath = freshPath(`from-v${fromVersion}.db`)
      const init = new SqliteUnifiedStore({ path: dbPath })
      const initBoard = new BoardService(init)
      const boardId = init.identity()!.boardId
      const root = initBoard.postMessage(alice, { channel: 'dev', text: `preserved from v${fromVersion}` }).message
      const task = initBoard.tasks.createTask(alice, { channel: 'work', text: 'preserved task' }).task
      init.close()

      // Downgrade DB file to look like a real v3 or v4 board (drop Step 5 objects, set meta version/write_min)
      const v5Names = [
        ...V2_LAUNCH_SCHEMA_SQL.matchAll(/CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/g),
      ].map((m) => m[1]!)
      const raw = new DatabaseSync(dbPath)
      try {
        raw.exec('BEGIN IMMEDIATE')
        for (const name of v5Names) {
          const obj = raw
            .prepare('SELECT type FROM sqlite_master WHERE name = ?')
            .get(name) as { type: string } | undefined
          if (obj?.type === 'index') raw.exec(`DROP INDEX IF EXISTS ${name}`)
        }
        for (const name of v5Names) {
          const obj = raw
            .prepare('SELECT type FROM sqlite_master WHERE name = ?')
            .get(name) as { type: string } | undefined
          if (obj?.type === 'table') raw.exec(`DROP TABLE IF EXISTS ${name}`)
        }
        raw.prepare("UPDATE board_meta SET value = ? WHERE key = 'core.schema_version'").run(String(fromVersion))
        raw
          .prepare("UPDATE board_meta SET value = ? WHERE key = 'core.schema_write_min'")
          .run(fromVersion === 3 ? '2' : '4')
        raw.exec('COMMIT')
      } finally {
        raw.close()
      }

      const steps: number[] = []
      const upgraded = openStore(dbPath, { testHooks: { onSchemaStep: (v) => void steps.push(v) } })
      expect(steps).toEqual(fromVersion === 3 ? [4, 5] : [5])
      expect(upgraded.schemaInfo()).toEqual({ version: 5, writeMin: 5, readMin: 1, build: SCHEMA_VERSION, refused: null })
      expect(upgraded.identity()!.boardId).toBe(boardId)

      const objects = new Set(
        (upgraded.db.prepare('SELECT name FROM sqlite_master').all() as Array<{ name: string }>).map((r) => r.name),
      )
      for (const name of v5Names) expect(objects.has(name), `missing ${name}`).toBe(true)

      const board = new BoardService(upgraded)
      expect(board.getMessageThread(alice, root.id).message.text).toBe(`preserved from v${fromVersion}`)
      expect(board.tasks.listTasks(alice, { channel: 'work' }).tasks.map((t) => t.message.id)).toEqual([task.id])
      upgraded.close()

      // Subsequent reopen is read-only (0 steps, 0 BEGIN IMMEDIATE)
      let begins = 0
      const steps2: number[] = []
      const reopened = openStore(dbPath, {
        testHooks: {
          onSchemaStep: (v) => void steps2.push(v),
          onBeginImmediate: () => void (begins += 1),
        },
      })
      expect(steps2).toEqual([])
      expect(begins).toBe(0)
      expect(reopened.schemaInfo().version).toBe(5)
    }
  })
})

describe('V2-02: Hierarchical channel metadata, archiving & channelTree', () => {
  it('keeps v1 createChannel shape byte-exact without metadata and supports rich metadata + tree + unread counts', () => {
    const store = openStore(':memory:')
    const board = new BoardService(store)

    // v1 untouched channel: byte-exact { path, lastIndex, messages, threads }
    const v1 = board.createChannel(alice, { path: 'general' })
    expect(v1).toEqual({
      channel: { path: 'general', lastIndex: 0, messages: 0, threads: 0 },
      created: true,
    })
    expect(Object.keys(v1.channel).sort()).toEqual(['lastIndex', 'messages', 'path', 'threads'])

    // Rich metadata channels
    const dev = board.createChannel(alice, {
      path: 'repos/agent-board/dev',
      kind: 'chat',
      category: 'repos/agent-board',
      parent: 'repos/agent-board',
      topic: 'Active implementation updates',
      repo: 'agent-board',
      sortOrder: 10,
    })
    expect(dev.created).toBe(true)
    expect(dev.channel).toMatchObject({
      path: 'repos/agent-board/dev',
      kind: 'chat',
      category: 'repos/agent-board',
      parent: 'repos/agent-board',
      topic: 'Active implementation updates',
      repo: 'agent-board',
      archived: false,
      sortOrder: 10,
      private: false,
    })

    board.createChannel(alice, {
      path: 'repos/agent-board/work',
      kind: 'tasks',
      repo: 'agent-board',
      sortOrder: 5,
    })
    board.createChannel(alice, {
      path: 'repos/agent-board/old',
      topic: 'Legacy',
      archived: true,
    })

    // inferChannelKind helper
    expect(inferChannelKind('dm/a--b')).toBe('dm')
    expect(inferChannelKind('announcements')).toBe('announcements')
    expect(inferChannelKind('repos/foo/decisions')).toBe('forum')
    expect(inferChannelKind('meta/feedback')).toBe('forum')
    expect(inferChannelKind('repos/foo/work/run1')).toBe('tasks')
    expect(inferChannelKind('general')).toBe('chat')

    // listChannels hides archived by default, filters by archived/kind/repo
    expect(board.listChannels(alice).channels.map((c) => c.path)).toEqual([
      'general',
      'repos/agent-board/dev',
      'repos/agent-board/work',
    ])
    expect(board.listChannels(alice, { archived: true }).channels.map((c) => c.path)).toEqual([
      'repos/agent-board/old',
    ])
    expect(board.listChannels(alice, { archived: 'all' }).channels).toHaveLength(4)
    expect(board.listChannels(alice, { kind: 'tasks', repo: 'agent-board' }).channels.map((c) => c.path)).toEqual([
      'repos/agent-board/work',
    ])

    // updateChannel re-sorts, updates topic, and archives/unarchives
    const updated = board.updateChannel(narrowedAgy, {
      path: 'repos/agent-board/dev',
      topic: 'Updated topic',
      sortOrder: 1,
    })
    expect(updated.channel.topic).toBe('Updated topic')
    expect(updated.channel.sortOrder).toBe(1)

    // Non-owner narrowed agent cannot flip privacy or edit members on an existing channel
    expectBoardError(
      () => board.updateChannel(narrowedAgy, { path: 'repos/agent-board/dev', private: true }),
      403,
      'forbidden',
    )

    // Posts & unread counts in channelTree
    board.postMessage(agy, { channel: 'repos/agent-board/dev', text: 'first update' })
    board.postMessage(agy, { channel: 'repos/agent-board/dev', text: 'second update' })
    board.postMessage(agy, { channel: 'repos/agent-board/work', text: 'work item' })

    const treeBefore = board.getChannelTree(codex, { prefix: 'repos/' })
    expect(treeBefore.tree).toHaveLength(1)
    const reposNode = treeBefore.tree[0]!
    expect(reposNode.path).toBe('repos')
    expect(reposNode.virtual).toBe(true)
    expect(reposNode.unreadCount).toBe(3)
    expect(reposNode.totalMessages).toBe(3)
    const abNode = reposNode.children[0]!
    expect(abNode.path).toBe('repos/agent-board')
    expect(abNode.virtual).toBe(true)
    // sortOrder: dev=1 comes before work=5
    expect(abNode.children.map((c) => c.segment)).toEqual(['dev', 'work'])
    expect(abNode.children[0]!.unreadCount).toBe(2)

    // markChannelRead zeros unreadCount on dev for codex
    board.markChannelRead(codex, { channel: 'repos/agent-board/dev' })
    const treeAfter = board.getChannelTree(codex, { prefix: 'repos/' })
    expect(treeAfter.tree[0]!.unreadCount).toBe(1)
    expect(treeAfter.tree[0]!.children[0]!.children[0]!.unreadCount).toBe(0)
  })
})

describe('V2-03: Canonical DMs & Private Channel Member ACLs (even under local g1)', () => {
  it('converges canonical DMs, notifies DM peer, hides from non-member agents, and allows human owner audit', async () => {
    const store = openStore(':memory:')
    const board = new BoardService(store)

    expect(dmSlug('local:user:alice+agy')).toBe('agy')
    expect(dmSlug('alice/codex')).toBe('codex')
    expect(canonicalDmChannel('agy', 'codex')).toBe('dm/agy--codex')
    expect(canonicalDmChannel('codex', 'agy')).toBe('dm/agy--codex')
    const longSlug = dmSlug('a'.repeat(80))
    expect(longSlug.length).toBeLessThanOrEqual(48)
    expect(longSlug).toMatch(/^[a-z0-9][a-z0-9_-]*$/)

    // ensureDm converges symmetrically
    const dm1 = board.ensureDm(agy, { peer: 'codex' })
    expect(dm1.created).toBe(true)
    expect(dm1.channel.path).toBe('dm/agy--codex')
    expect(dm1.channel.kind).toBe('dm')
    expect(dm1.channel.private).toBe(true)

    const dm2 = board.ensureDm(codex, { peer: 'agy' })
    expect(dm2.created).toBe(false)
    expect(dm2.channel.path).toBe('dm/agy--codex')

    // Posting in DM notifies peer with reason='dm' even without @mention
    const dmMsg = board.postMessage(agy, { channel: 'dm/agy--codex', text: 'secret handoff coordinates' }).message
    const codexNotifs = board.listNotifications(codex)
    expect(codexNotifs.notifications).toHaveLength(1)
    expect(codexNotifs.notifications[0]).toMatchObject({
      reason: 'dm',
      channel: 'dm/agy--codex',
      messageId: dmMsg.id,
    })

    // Self-DM creates zero notifications
    const selfDm = board.ensureDm(agy, { peer: 'agy' })
    expect(selfDm.channel.path).toBe('dm/agy--agy')
    board.postMessage(agy, { channel: 'dm/agy--agy', text: 'note to self' })
    expect(board.listNotifications(agy).notifications).toHaveLength(0)

    // Non-member agent `claude` (BOTH default g1 and narrowed!) is completely blocked & blind to dm/agy--codex
    for (const outsider of [claude, narrowedClaude]) {
      expectBoardError(() => board.getMessageThread(outsider, dmMsg.id), 404, 'message_not_found')
      expectBoardError(() => board.postMessage(outsider, { re: dmMsg.id, text: 'peek' }), 404, 'message_not_found')
      expectBoardError(
        () => board.postMessage(outsider, { channel: 'dm/agy--codex', text: 'intrude' }),
        403,
        'forbidden',
      )
      expectBoardError(
        () => board.updateChannel(outsider, { path: 'dm/agy--codex', topic: 'hacked' }),
        403,
        'forbidden',
      )
      expect(board.listChannels(outsider).channels.map((c) => c.path)).not.toContain('dm/agy--codex')
      expect(board.getChannelTree(outsider).tree.map((n) => n.path)).not.toContain('dm')
      expect(board.listChannelMessages(outsider, { channel: 'dm/agy--codex' }).messages).toEqual([])
      expect(board.listThreads(outsider, { channel: 'dm/agy--codex' }).threads).toEqual([])
      expect(board.search(outsider, { query: 'coordinates' })).toEqual([])
      const evPage = await board.getEvents(outsider, { after: '0', all: true })
      expect(evPage.events.some((e) => e.message?.channel === 'dm/agy--codex')).toBe(false)
    }

    // Human owner `alice` CAN audit/read any DM
    expect(board.getMessageThread(alice, dmMsg.id).message.text).toBe('secret handoff coordinates')
    expect(board.search(alice, { query: 'coordinates' }).map((h) => h.id)).toEqual([dmMsg.id])

    // Explicit private channel with members & member add/remove
    board.createChannel(narrowedAgy, { path: 'swarms/secret', private: true, members: ['codex'] })
    const secretPost = board.postMessage(narrowedAgy, { channel: 'swarms/secret', text: 'private swarm plan' }).message
    expect(board.getMessageThread(narrowedCodex, secretPost.id).message.text).toBe('private swarm plan')
    expectBoardError(() => board.getMessageThread(narrowedClaude, secretPost.id), 404, 'message_not_found')

    // Creator (`role: 'owner'`) can add claude, then remove claude
    board.updateChannel(narrowedAgy, { path: 'swarms/secret', addMembers: ['claude'] })
    expect(board.getMessageThread(narrowedClaude, secretPost.id).message.text).toBe('private swarm plan')
    board.updateChannel(narrowedAgy, { path: 'swarms/secret', removeMembers: ['claude'] })
    expectBoardError(() => board.getMessageThread(narrowedClaude, secretPost.id), 404, 'message_not_found')
  })
})

describe('V2-04 & V2-05: @groups, @channel/@here fanout cap, unseen mentions & edit dedup', () => {
  it('enforces reserved handles, group CRUD, @group/@here/@channel expansion, and 64-member fanout cap', () => {
    let clock = Date.UTC(2030, 0, 1)
    const store = openStore(':memory:')
    const board = new BoardService(store, { now: () => clock })

    // Reserved handles -> 400 group_reserved; invalid trailing _/- -> 400 invalid_request
    for (const reserved of ['channel', 'here', 'all', 'everyone', 'me', 'system', 'board']) {
      expectBoardError(
        () => board.createGroup(alice, { handle: reserved, name: 'Bad' }),
        400,
        'group_reserved',
      )
    }
    expect(() => board.createGroup(alice, { handle: 'bad_', name: 'Bad' })).toThrow()
    expect(() => board.createGroup(alice, { handle: 'bad-', name: 'Bad' })).toThrow()

    // Create @reviewers group (duplicate -> 409 group_exists)
    const rev = board.createGroup(narrowedAgy, {
      handle: 'reviewers',
      name: 'Code Reviewers',
      description: 'Core review squad',
      kind: 'role',
      members: ['agy', 'codex', 'claude'],
    })
    expect(rev.handle).toBe('reviewers')
    expect(rev.members).toHaveLength(3)
    expectBoardError(
      () => board.createGroup(narrowedAgy, { handle: 'reviewers', name: 'Dup' }),
      409,
      'group_exists',
    )

    // Non-lead non-owner cannot mutate group; adding as lead allows mutation
    expectBoardError(
      () => board.updateGroup(narrowedCodex, 'reviewers', { description: 'hijack' }),
      403,
      'forbidden',
    )
    board.addGroupMembers(narrowedAgy, 'reviewers', { members: ['codex'], role: 'lead' })
    const updatedRev = board.updateGroup(narrowedCodex, 'reviewers', { description: 'Updated by lead' })
    expect(updatedRev.description).toBe('Updated by lead')

    // Posting @reviewers notifies codex & claude, NOT caller agy
    board.postMessage(narrowedAgy, { channel: 'dev', text: 'Ready for @reviewers signoff' })
    expect(board.listNotifications(narrowedAgy).notifications).toHaveLength(0)
    expect(board.listNotifications(narrowedCodex).notifications[0]).toMatchObject({
      reason: 'group_mention',
      sourceGroup: 'reviewers',
    })
    expect(board.listNotifications(narrowedClaude).notifications[0]).toMatchObject({
      reason: 'group_mention',
      sourceGroup: 'reviewers',
    })

    // @here notifies ONLY online/active agents in channel
    board.setPresence(narrowedCodex, { status: 'active', channel: 'ops', ttlS: 120 })
    board.setPresence(narrowedClaude, { status: 'idle', channel: 'ops', ttlS: 120 })
    board.ackAllNotifications(narrowedCodex)
    board.ackAllNotifications(narrowedClaude)
    board.postMessage(narrowedAgy, { channel: 'ops', text: 'Ping @here deploy check' })
    expect(board.listNotifications(narrowedCodex).notifications).toHaveLength(1)
    expect(board.listNotifications(narrowedCodex).notifications[0]!.sourceGroup).toBe('here')
    expect(board.listNotifications(narrowedClaude).notifications).toHaveLength(0)

    // Fanout cap at GROUP_FANOUT_MAX (64) records fanoutTruncated: true without failing post
    const first50 = Array.from({ length: 50 }, (_, i) => `worker-${String(i).padStart(2, '0')}`)
    const next20 = Array.from({ length: 20 }, (_, i) => `worker-${String(50 + i).padStart(2, '0')}`)
    board.createGroup(alice, { handle: 'bigswarm', name: 'Big Swarm', members: first50 })
    board.addGroupMembers(alice, 'bigswarm', { members: next20 })
    const bigPost = board.postMessage(alice, { channel: 'dev', text: 'Attention @bigswarm!' }).message
    const notifCount = store.db
      .prepare('SELECT COUNT(*) AS c FROM board_notifications WHERE message_id = ?')
      .get(Number(bigPost.id)) as { c: number }
    expect(notifCount.c).toBe(GROUP_FANOUT_MAX)
    const evRow = store.db
      .prepare('SELECT payload_json FROM board_events WHERE log_index = ?')
      .get(Number(bigPost.id)) as { payload_json: string }
    expect((JSON.parse(evRow.payload_json) as { fanoutTruncated?: boolean }).fanoutTruncated).toBe(true)

    // Delete group
    expect(board.deleteGroup(narrowedAgy, 'reviewers')).toEqual({ deleted: true })
    expectBoardError(() => board.getGroup(alice, 'reviewers'), 404, 'group_not_found')
    clock += 1000
  })

  it('delivers mentions to unseen agents and deduplicates on edits even after actor registration', () => {
    const store = openStore(':memory:')
    const board = new BoardService(store)

    const freshAgent = createLocalCaller({ userId: 'alice', handle: 'alice', profile: 'fresh-agent' })
    const secondAgent = createLocalCaller({ userId: 'alice', handle: 'alice', profile: 'second-agent' })

    // Tag @fresh-agent BEFORE fresh-agent has ever posted
    const post = board.postMessage(agy, { channel: 'dev', text: 'Welcome @fresh-agent!' }).message
    const inbox1 = board.getAgentInbox(freshAgent)
    expect(inbox1.unreadNotifications).toBe(1)
    expect(inbox1.notifications[0]).toMatchObject({
      recipient: 'handle:fresh-agent',
      reason: 'mention',
      messageId: post.id,
    })

    // Now fresh-agent posts (entering board_actors), and agy edits original post to add @second-agent
    board.postMessage(freshAgent, { channel: 'dev', text: 'I am here now' })
    board.editMessage(agy, post.id, { text: 'Welcome @fresh-agent and @second-agent!' })

    // fresh-agent still has EXACTLY 1 notification for post.id (no double notify!)
    expect(board.listNotifications(freshAgent).notifications.filter((n) => n.messageId === post.id)).toHaveLength(1)
    // second-agent receives its notification immediately
    const secondNotifs = board.listNotifications(secondAgent)
    expect(secondNotifs.notifications).toHaveLength(1)
    expect(secondNotifs.notifications[0]!.messageId).toBe(post.id)

    // Decisions root post by agent -> urgent attention notification to principal person
    board.postMessage(agy, { channel: 'decisions', text: 'Should we ship v2 today?' })
    const aliceNotifs = board.listNotifications(alice, { reason: 'attention' })
    expect(aliceNotifs.notifications).toHaveLength(1)
    expect(aliceNotifs.notifications[0]!.priority).toBe('urgent')

    // Ack readOnly vs full ack, and cross-actor ack refusal
    const nId = secondNotifs.notifications[0]!.id
    expectBoardError(() => board.ackNotification(freshAgent, nId), 404, 'notification_not_found')
    const readOnly = board.ackNotification(secondAgent, nId, { readOnly: true })
    expect(readOnly.notification.readAt).not.toBeNull()
    expect(readOnly.notification.ackedAt).toBeNull()
    const fullAck = board.ackNotification(secondAgent, nId)
    expect(fullAck.notification.ackedAt).not.toBeNull()
    expect(board.countNotifications(secondAgent).unread).toBe(0)
  })
})

describe('V2-06: Real-time waitNotifications (in-process + cross-connection external pump)', () => {
  it('wakes waitNotifications immediately on in-process post and cross-connection commit, and respects abort', async () => {
    const dbPath = freshPath('wait-notif.db')
    const storeA = openStore(dbPath)
    const storeB = openStore(dbPath)
    const boardA = new BoardService(storeA)
    const boardB = new BoardService(storeB, { eventsWaitPollMs: 25 })
    storeB.armExternalDispatch()

    // 1. Cross-connection wake via external dispatch pump (simulating WakeBridge)
    const waiter = boardB.waitNotifications(codex, { wait: 5 })
    await new Promise((r) => setTimeout(r, 20))
    const t0 = performance.now()
    boardA.postMessage(agy, { channel: 'dev', text: 'Wake up @codex!' })
    storeB.pumpExternal()
    const woke = await waiter
    const latencyMs = performance.now() - t0
    expect(woke.notifications).toHaveLength(1)
    expect(woke.notifications[0]!.excerpt).toContain('Wake up')
    expect(latencyMs).toBeLessThan(200)

    // 2. Abort signal ends waitNotifications cleanly
    boardB.ackAllNotifications(codex)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 40)
    const aborted = await boardB.waitNotifications(codex, { wait: 10 }, ac.signal)
    expect(aborted.notifications).toEqual([])
  })
})

describe('V2-07: agentInbox composite digest (notifications, tasks, unread channels/DMs, presence, ACL)', () => {
  it('delivers task discussion to a live claimant once and stops when the lease expires', () => {
    let now = Date.UTC(2026, 0, 1)
    const board = new BoardService(openStore(':memory:'), { now: () => now })
    const task = board.tasks.createTask(agy, { channel: 'work', text: 'Publish the contract' }).task
    board.tasks.claimTask(codex, task.id, { lease: 30 })
    const question = board.postMessage(claude, { re: task.id, text: 'Which field names should I use?' }).message
    const tagged = board.postMessage(claude, { re: question.id, text: '@codex I have the fixture.' }).message
    board.postMessage(codex, { re: question.id, text: 'I will post the contract.' })
    now += 30_000
    board.postMessage(claude, { re: task.id, text: 'Anyone available?' })
    expect(board.listNotifications(codex).notifications.map(n => [n.messageId, n.reason])).toEqual([
      [tagged.id, 'mention'], [question.id, 'reply'],
    ])
  })

  it('returns compact 1-call digest with task latestReply and strict private ACL filtering', () => {
    const store = openStore(':memory:')
    const board = new BoardService(store)

    // Assigned task with a reply + deleted tombstone
    const assigned = board.tasks.createTask(agy, {
      channel: 'work',
      text: 'Ship social core',
      for: codex.actor.id,
      labels: { priority: 'urgent' },
    }).task
    const liveReply = board.postMessage(agy, { re: assigned.id, text: 'Remember HT-99 clock check' }).message
    const deadReply = board.postMessage(agy, { re: assigned.id, text: 'typo to delete' }).message
    board.deleteMessage(agy, deadReply.id)

    // Unassigned ready task in shared pool
    const readyTask = board.tasks.createTask(agy, { channel: 'work', text: 'Write benchmarks' }).task

    // Unread DM for codex + hidden private channel for agy+claude only
    board.ensureDm(agy, { peer: 'codex' })
    board.postMessage(agy, { channel: 'dm/agy--codex', text: 'DM ping from agy' })
    board.createChannel(agy, { path: 'secret/room', private: true, members: ['claude'] })
    board.postMessage(agy, { channel: 'secret/room', text: 'classified @codex' })

    // Online presence for agy
    board.setPresence(agy, { status: 'active', channel: 'dev', ttlS: 120 })

    const inbox = board.getAgentInbox(codex)
    expect(inbox.actor).toBe(codex.actor.id)
    expect(inbox.profile).toBe('codex')
    // Must include task_assigned (urgent) + dm, NEVER secret/room!
    expect(inbox.notifications.some((n) => n.channel === 'secret/room')).toBe(false)
    expect(inbox.notifications.some((n) => n.reason === 'task_assigned' && n.priority === 'urgent')).toBe(true)
    expect(inbox.notifications.some((n) => n.reason === 'dm')).toBe(true)
    expect(inbox.urgentCount).toBeGreaterThanOrEqual(1)

    // Tasks digest includes latestReply skipping deleted tombstone
    expect(inbox.tasks.assigned.map((t) => t.id)).toEqual([assigned.id])
    expect(inbox.tasks.assigned[0]!.latestReply?.id).toBe(liveReply.id)
    expect(inbox.notifications.some(n => n.messageId === liveReply.id && n.reason === 'reply')).toBe(true)
    expect(inbox.tasks.assigned[0]!.latestReply?.excerpt).toContain('HT-99')
    expect(inbox.tasks.ready.map((t) => t.id)).toEqual([readyTask.id])

    // Unread channels & DMs exclude secret/room
    expect(inbox.unreadChannels.some((c) => c.channel === 'secret/room')).toBe(false)
    expect(inbox.unreadDms).toHaveLength(1)
    expect(inbox.unreadDms[0]).toMatchObject({ channel: 'dm/agy--codex', peer: 'agy', unread: 1 })
    expect(inbox.onlinePeers).toBe(1)
    expect(inbox.peers).toEqual([{ handle: agy.actor.handle, status: 'active' }])
  })
})

describe('V2-08: Pins, sticky threads, announcements & listThreads chronological vs forum ordering', () => {
  it('preserves v1 chronological default and orders forum pages Announcements -> Sticky -> Active with clean pagination', () => {
    const store = openStore(':memory:')
    const board = new BoardService(store)

    const t1 = board.postMessage(alice, { channel: 'dev', text: 'T1 oldest' }).message
    const t2 = board.postMessage(agy, { channel: 'dev', text: 'T2 second' }).message
    const t3 = board.postMessage(codex, { channel: 'dev', text: 'T3 third' }).message
    const t4 = board.postMessage(claude, { channel: 'dev', text: 'T4 fourth' }).message
    const t5 = board.postMessage(alice, { channel: 'dev', text: 'T5 newest' }).message
    const t2Reply = board.postMessage(codex, { re: t2.id, text: 'Reply on T2' }).message

    // Pin T1 as announcement (notifies author if not caller), T3 as channel sticky, t2Reply as thread pin
    const p1 = board.pinMessage(narrowedAgy, t1.id, { scope: 'announcement', note: 'Read first', sortOrder: 1 })
    expect(p1.created).toBe(true)
    expect(board.listNotifications(alice, { reason: 'pin' }).notifications).toHaveLength(1)

    // Pinning a reply with scope:'channel' pins its thread root
    const p3 = board.pinMessage(narrowedAgy, t3.id, { scope: 'channel', note: 'Sticky topic', sortOrder: 2 })
    expect(p3.pin.messageId).toBe(t3.id)

    const pReply = board.pinMessage(narrowedAgy, t2Reply.id, { scope: 'thread', note: 'Key answer' })
    expect(pReply.pin.messageId).toBe(t2Reply.id)
    expect(board.listPins(alice, { thread: t2.id, scope: 'thread' }).map((p) => p.messageId)).toEqual([t2Reply.id])

    // Default chronological order: oldest-to-newest (T2 has newest activity from reply!)
    const chrono = board.listThreads(alice, { channel: 'dev' })
    expect(chrono.threads.map((t) => t.message.id)).toEqual([t1.id, t3.id, t4.id, t5.id, t2.id])

    // Forum order page 1 (limit 3): Tier 0 [T1] -> Tier 1 [T3] -> Tier 2 newest-first [T2]
    const page1 = board.listThreads(alice, { channel: 'dev', order: 'forum', limit: 3, includeMeta: true })
    expect(page1.threads.map((t) => t.message.id)).toEqual([t1.id, t3.id, t2.id])
    expect(page1.threads[0]!.pin?.scope).toBe('announcement')
    expect(page1.threads[1]!.pin?.scope).toBe('channel')
    expect(page1.threads[2]!.pin).toBeUndefined()
    expect(page1.threads[2]!.participants).toEqual(['alice/agy', 'alice/codex'])
    expect(page1.older).not.toBeNull()

    // Forum order page 2: skips Tier 0 & 1, returns remaining unpinned newest-first [T5, T4]
    const page2 = board.listThreads(alice, { channel: 'dev', order: 'forum', limit: 3, before: page1.older! })
    expect(page2.threads.map((t) => t.message.id)).toEqual([t5.id, t4.id])
    expect(page2.older).toBeNull()

    // Forum order when pins fill entire page 1 (limit: 2) still paginates cleanly into Tier 2
    const tight1 = board.listThreads(alice, { channel: 'dev', order: 'forum', limit: 2 })
    expect(tight1.threads.map((t) => t.message.id)).toEqual([t1.id, t3.id])
    expect(tight1.older).not.toBeNull()
    const tight2 = board.listThreads(alice, { channel: 'dev', order: 'forum', limit: 2, before: tight1.older! })
    expect(tight2.threads.map((t) => t.message.id)).toEqual([t2.id, t5.id])

    // Unpin restores active ordering
    expect(board.unpinMessage(narrowedAgy, t1.id, { scope: 'announcement' })).toEqual({ unpinned: 1 })
    const afterUnpin = board.listThreads(alice, { channel: 'dev', order: 'forum' })
    expect(afterUnpin.threads.map((t) => t.message.id)).toEqual([t3.id, t2.id, t5.id, t4.id, t1.id])
  })
})

describe('V2-09: Agent presence TTL, event throttling & private channel privacy', () => {
  it('expires past TTL on injected clock, throttles pure heartbeats, and hides private channels', () => {
    let clock = Date.UTC(2030, 5, 1)
    const store = openStore(':memory:')
    const board = new BoardService(store, { now: () => clock })

    board.createChannel(agy, { path: 'secret/ops', private: true })
    const p1 = board.setPresence(agy, { status: 'active', channel: 'secret/ops', note: 'working', ttlS: 15 })
    expect(p1.status).toBe('active')
    expect(p1.channel).toBe('secret/ops')

    // Pure TTL heartbeat refresh appends 0 new board_events
    const headBefore = store.getHeadIndex()
    clock += 5_000
    board.setPresence(agy, { status: 'active', channel: 'secret/ops', note: 'working', ttlS: 15 })
    expect(store.getHeadIndex()).toBe(headBefore)

    // Non-member agent sees agy online, but channel is nulled; querying private channel returns []
    const claudeList = board.listPresence(claude)
    expect(claudeList).toHaveLength(1)
    expect(claudeList[0]!.channel).toBeNull()
    expect(board.listPresence(claude, { channel: 'secret/ops' })).toEqual([])
    expectBoardError(() => board.setPresence(claude, { status: 'active', channel: 'secret/ops' }), 403, 'forbidden')

    // Past TTL -> reads offline (hidden by default, visible with includeOffline: true)
    clock += 16_000
    expect(board.listPresence(alice)).toEqual([])
    const withOffline = board.listPresence(alice, { includeOffline: true })
    expect(withOffline).toHaveLength(1)
    expect(withOffline[0]!.status).toBe('offline')
    expect(withOffline[0]!.channel).toBe('secret/ops')
  })
})

describe('V2-10: Universal thr_/#/msg_/UUID refs, tasks.list latestReply fix & quoteMessageId', () => {
  it('accepts friendly/UUID refs across board and tasks, uses idx_messages_thread_root, and enforces quote ACL', () => {
    const store = openStore(':memory:')
    const board = new BoardService(store)

    // EXPLAIN QUERY PLAN verifies indexed thread-root lookup
    const plan = store.db
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM board_messages WHERE re IS NULL AND thread = ? LIMIT 1')
      .all('thr_probe') as Array<{ detail: string }>
    expect(plan.some((r) => r.detail.includes('idx_messages_thread_root'))).toBe(true)

    const root = board.postMessage(alice, { channel: 'dev', text: 'UUID thread root' }).message
    const customRoot = board.postMessage(alice, {
      channel: 'dev',
      id: 'thr_custom-alpha',
      text: 'Custom thr_ root',
    }).message

    // resolveMessageId handles all valid formats and rejects malformed ones
    expect(resolveMessageId(store.db, Number(root.id))).toBe(Number(root.id))
    expect(resolveMessageId(store.db, `#${root.id}`)).toBe(Number(root.id))
    expect(resolveMessageId(store.db, `msg_${root.id}`)).toBe(Number(root.id))
    expect(resolveMessageId(store.db, `thr_${root.id}`)).toBe(Number(root.id))
    expect(resolveMessageId(store.db, root.thread)).toBe(Number(root.id))
    expect(resolveMessageId(store.db, 'thr_custom-alpha')).toBe(Number(customRoot.id))
    for (const bad of ['0x10', '1e2', ' 12 ', '+5', '0', '#0']) {
      expect(resolveMessageId(store.db, bad)).toBe(0)
    }

    // Board verbs accept friendly & UUID refs
    expect(board.getMessageThread(alice, `#${root.id}`).message.id).toBe(root.id)
    expect(board.getMessageThread(alice, `msg_${root.id}`).message.id).toBe(root.id)
    expect(board.getMessageThread(alice, `thr_${root.id}`).message.id).toBe(root.id)
    expect(board.getMessageThread(alice, root.thread).message.id).toBe(root.id)
    expect(board.getMessageThread(alice, 'thr_custom-alpha').message.id).toBe(customRoot.id)

    const reply = board.postMessage(agy, { re: root.thread, text: 'reply via UUID' }).message
    expect(reply.re).toBe(root.id)
    expect(board.pinMessage(alice, `thr_${root.id}`, { scope: 'channel' }).pin.messageId).toBe(root.id)

    // Task verbs accept thr_ / # / msg_ / UUID refs (claim, complete, needs, batch)
    const tA = board.tasks.createTask(alice, { channel: 'work', text: 'Task A' }).task
    const tB = board.tasks.createTask(alice, { channel: 'work', text: 'Task B', needs: [`thr_${tA.id}`] }).task
    const batch = board.tasks.createTasks(alice, {
      channel: 'work',
      tasks: [{ text: 'Batch C', needs: [tA.thread] }],
    }).tasks
    expect(batch[0]!.task?.needs).toEqual([tA.id])
    expect(board.tasks.listTasks(alice, { needs: `#${tA.id}` }).tasks.map((t) => t.message.id)).toEqual([
      tB.id,
      batch[0]!.id,
    ])
    const claimed = board.tasks.claimTask(alice, tA.thread, {})
    const done = board.tasks.completeTask(alice, `msg_${tA.id}`, {
      epoch: claimed.claim.epoch,
      token: claimed.claim.token,
      result: 'ok',
    })
    expect(done.task.task?.state).toBe('completed')

    // tasks.list() skips deleted latest reply tombstone
    const liveRep = board.postMessage(alice, { re: tB.id, text: 'live note' }).message
    const deadRep = board.postMessage(alice, { re: tB.id, text: 'deleted note' }).message
    board.deleteMessage(alice, deadRep.id)
    const listedB = board.tasks.listTasks(alice, { channel: 'work' }).tasks.find((t) => t.message.id === tB.id)
    expect(listedB?.last?.id).toBe(liveRep.id)
    expect(listedB?.last?.deleted).toBe(false)

    // quoteMessageId snapshots quoted post, notifies quoted author, and enforces ACL
    const quotedPost = board.postMessage(codex, {
      channel: 'dev',
      text: 'Quoting the root',
      quoteMessageId: root.thread,
    }).message
    expect(quotedPost.quote).toEqual({
      id: root.id,
      channel: 'dev',
      by: alice.actor.id,
      handle: 'alice',
      excerpt: 'UUID thread root',
      createdAt: root.createdAt,
    })
    expect(board.listNotifications(alice, { reason: 'reply' }).notifications.some((n) => n.messageId === quotedPost.id)).toBe(true)

    // Cannot quote a private/unreadable message -> 404 message_not_found
    board.createChannel(agy, { path: 'secret/q', private: true })
    const secret = board.postMessage(agy, { channel: 'secret/q', text: 'hidden quote target' }).message
    expectBoardError(
      () => board.postMessage(claude, { channel: 'dev', text: 'leak attempt', quoteMessageId: secret.id }),
      404,
      'message_not_found',
    )
    // Owner can quote secret into dev, but non-member claude reading dev does not see the private quote snapshot
    const ownerCrossQuote = board.postMessage(alice, {
      channel: 'dev',
      text: 'summary',
      quoteMessageId: secret.id,
    }).message
    expect(ownerCrossQuote.quote?.id).toBe(secret.id)
    const claudeView = board.getMessageThread(claude, ownerCrossQuote.id).message
    expect(claudeView.quote).toBeUndefined()

    // recipientKeysOf sanity check
    expect(recipientKeysOf(codex)).toEqual(
      expect.arrayContaining([codex.actor.id, 'handle:alice/codex', 'handle:codex']),
    )
  })
})
