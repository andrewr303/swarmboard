// Tests for src/client/format.ts: pure/thin compact JSON projections and agent digest line formatters.
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AgentInboxView,
  BoardEventView,
  ChannelTreePage,
  ChannelView,
  GroupView,
  MessageView,
  NotificationsPage,
  NotificationView,
  PinView,
  PresenceView,
  TasksPage,
  ThreadsPage,
  ThreadSummaryView,
  ThreadView,
} from '../../src/core/public.ts'
import {
  compactAgentInbox,
  compactChannel,
  compactChannelTree,
  compactEvent,
  compactGroup,
  compactLatestReply,
  compactMessage,
  compactMessagesPage,
  compactNotification,
  compactNotificationsPage,
  compactPin,
  compactPresence,
  compactTasksPage,
  compactThread,
  compactThreadsPage,
  compactThreadSummary,
  DEFAULT_LIST_MAX_CHARS,
  excerptLine,
  formatChannelTreeLines,
  formatInboxDigest,
  formatMessageLine,
  formatNotificationLine,
  formatPresenceLine,
  formatTaskLine,
  formatThreadLine,
  stripEmpty,
  truncateText,
} from '../../src/client/format.ts'
import { asUrl, importGraph } from '../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')

function makeMessage(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: '12',
    channel: 'repos/agent-board/dev',
    text: 'Shipped W2-B client registry',
    re: null,
    replyTo: null,
    thread: 'thr_12',
    labels: {},
    reactions: {},
    by: { actor: 'local:user:alice+agy', principal: 'local:user:alice', profile: 'agy' },
    noSync: false,
    origin: null,
    from: null,
    createdAt: '2026-11-26T00:00:00.000Z',
    editedAt: null,
    deleted: false,
    undelivered: {},
    attachments: [],
    links: [],
    version: 1,
    revision: 1,
    author: {
      kind: 'agent',
      handle: 'alice/agy',
      name: 'AGY',
      avatar: null,
    },
    blocks: [],
    ...overrides,
  }
}

describe('src/client/format.ts boundary and primitives', () => {
  it('HS-55 format.ts has ZERO runtime imports (no core, no zod, no node built-ins)', async () => {
    const file = join(ROOT, 'src', 'client', 'format.ts')
    const edges = await importGraph([file])
    const ownEdges = edges.filter(([parent]) => parent === asUrl(file))
    expect(ownEdges).toEqual([])
  }, 60_000)

  it('truncateText handles exact limits, Unicode surrogate pairs, and edge values', () => {
    expect(truncateText('hello', 5)).toEqual({ text: 'hello', truncated: false })
    expect(truncateText('hello world', 5)).toEqual({ text: 'hell…', truncated: true })
    expect(truncateText('hello', 1)).toEqual({ text: '…', truncated: true })
    expect(truncateText('hello', 0)).toEqual({ text: '', truncated: true })
    expect(truncateText('', 0)).toEqual({ text: '', truncated: false })
    expect(truncateText('hello', Number.POSITIVE_INFINITY)).toEqual({ text: 'hello', truncated: false })

    // Emoji (surrogate pairs) must never produce lone surrogates
    const emojis = '🚀🔥✅🎉💡'
    const cut = truncateText(emojis, 3)
    expect(cut).toEqual({ text: '🚀🔥…', truncated: true })
    expect(cut.text.isWellFormed()).toBe(true)
  })

  it('excerptLine collapses multiline whitespace and truncates cleanly', () => {
    expect(excerptLine('  line 1\n\t line 2   line 3  ', 15)).toBe('line 1 line 2 …')
    expect(excerptLine('short')).toBe('short')
  })

  it('stripEmpty removes nulls, undefined, empty objects/arrays while preserving 0 and false', () => {
    const cleaned = stripEmpty({
      a: 0,
      b: false,
      c: '',
      d: null,
      e: undefined,
      f: [],
      g: {},
      nested: { x: null, y: {}, z: [null, {}] },
      keep: { count: 2, items: ['ok', null, {}] },
    })
    expect(cleaned).toEqual({
      a: 0,
      b: false,
      c: '',
      keep: { count: 2, items: ['ok'] },
    })
  })
})

describe('compactMessage and thread/task/page projections', () => {
  it('strips empty collections and nulls, significantly reducing payload size, and truncates long lists at 400 chars', () => {
    const longBody = 'a'.repeat(DEFAULT_LIST_MAX_CHARS + 50)
    const full = makeMessage({ text: longBody })
    const compact = compactMessage(full)

    expect(compact.text).toHaveLength(DEFAULT_LIST_MAX_CHARS)
    expect(compact.text.endsWith('…')).toBe(true)
    expect(compact.truncated).toBe(true)
    expect('reactions' in compact).toBe(false)
    expect('labels' in compact).toBe(false)
    expect('attachments' in compact).toBe(false)
    expect('links' in compact).toBe(false)
    expect('blocks' in compact).toBe(false)
    expect('undelivered' in compact).toBe(false)
    expect('re' in compact).toBe(false)
    expect('editedAt' in compact).toBe(false)
    expect('deleted' in compact).toBe(false)

    // Non-empty fields are preserved
    const rich = makeMessage({
      text: 'short body',
      labels: { priority: 'urgent' },
      reactions: { '+1': ['local:user:alice'] },
      attachments: [{ id: 'att_1', name: 'log.txt', type: 'text/plain', size: 42 }],
      blocks: [{ schema: 'board-feedback', version: 1, data: { summary: 'hi' } }],
      quote: {
        id: '7',
        channel: 'dev',
        by: 'local:user:bob',
        handle: 'bob',
        excerpt: 'earlier thought',
        createdAt: '2026-11-26T00:00:00.000Z',
      },
      revision: 3,
      task: {
        state: 'claimed',
        owner: 'local:user:alice',
        by: 'local:user:alice+agy',
        for: 'local:user:alice+codex',
        needs: [],
        epoch: 1,
        claim: { actor: 'local:user:alice+codex', until: '2026-11-26T01:00:00.000Z' },
        blocked: null,
        result: null,
        reason: null,
      },
    })
    const richCompact = compactMessage(rich)
    expect(richCompact.truncated).toBeUndefined()
    expect(richCompact.labels).toEqual({ priority: 'urgent' })
    expect(richCompact.reactions).toEqual({ '+1': ['local:user:alice'] })
    expect(richCompact.attachments).toHaveLength(1)
    expect(richCompact.blocks).toHaveLength(1)
    expect(richCompact.quote?.id).toBe('7')
    expect(richCompact.revision).toBe(3)
    expect(richCompact.task).toEqual({
      state: 'claimed',
      owner: 'local:user:alice',
      by: 'local:user:alice+agy',
      epoch: 1,
      for: 'local:user:alice+codex',
      claim: { actor: 'local:user:alice+codex', until: '2026-11-26T01:00:00.000Z' },
    })

    // Single-thread read defaults to full text (no truncation)
    const threadView: ThreadView = {
      message: full,
      replies: [makeMessage({ id: '13', re: '12', text: 'b'.repeat(600) })],
      cursor: '20',
    }
    const cThread = compactThread(threadView)
    expect(cThread.message.text).toBe(longBody)
    expect(cThread.message.truncated).toBeUndefined()
    expect(cThread.replies[0]!.text).toHaveLength(600)
    expect(cThread.replies[0]!.truncated).toBeUndefined()
  })

  it('compactLatestReply, compactThreadSummary, compactThreadsPage, compactTasksPage, compactMessagesPage', () => {
    const root = makeMessage({ id: '10', text: 'Task root' })
    const last = makeMessage({ id: '15', re: '10', text: 'Latest\nupdate from codex' })
    expect(compactLatestReply(null)).toBeNull()
    expect(compactLatestReply(last)).toEqual({
      id: '15',
      by: last.by.actor,
      handle: 'alice/agy',
      excerpt: 'Latest update from codex',
      createdAt: last.createdAt,
    })

    const summary: ThreadSummaryView = {
      message: root,
      replies: 2,
      last,
      pin: { scope: 'channel', note: null, pinnedBy: 'local:user:alice', pinnedAt: '2026-11-26T00:00:00.000Z' },
      participants: ['alice/agy'],
    }
    const cs = compactThreadSummary(summary)
    expect(cs.latestReply?.excerpt).toBe('Latest update from codex')
    expect(cs.pin).toEqual({
      scope: 'channel',
      pinnedBy: 'local:user:alice',
      pinnedAt: '2026-11-26T00:00:00.000Z',
    })
    expect(cs.participants).toEqual(['alice/agy'])

    const threadsPage: ThreadsPage = { threads: [summary], cursor: '15', older: null }
    expect(compactThreadsPage(threadsPage)).toEqual({ threads: [cs], cursor: '15' })

    const tasksPage: TasksPage = { tasks: [summary], cursor: '15' }
    expect(compactTasksPage(tasksPage)).toEqual({ tasks: [cs], cursor: '15' })

    const msgPage = compactMessagesPage({ messages: [root], cursor: '15' })
    expect(msgPage.messages).toHaveLength(1)
    expect(msgPage.cursor).toBe('15')
  })

  it('compactChannel, compactChannelTree, compactNotification, compactAgentInbox, compactPin, compactPresence, compactGroup, compactEvent', () => {
    const ch: ChannelView = {
      path: 'dev',
      lastIndex: 5,
      messages: 3,
      threads: 1,
      category: null,
      parent: null,
      topic: '',
      kind: 'chat',
      archived: false,
      sortOrder: 0,
      repo: null,
      sessionId: null,
      private: false,
      pinnedCount: 0,
      unreadCount: 2,
    }
    expect(compactChannel(ch)).toEqual({
      path: 'dev',
      kind: 'chat',
      lastIndex: 5,
      messages: 3,
      threads: 1,
      unreadCount: 2,
    })

    const treePage: ChannelTreePage = {
      cursor: '5',
      tree: [
        {
          path: 'repos',
          segment: 'repos',
          virtual: true,
          channel: null,
          unreadCount: 2,
          totalMessages: 3,
          children: [
            {
              path: 'repos/dev',
              segment: 'dev',
              virtual: false,
              channel: ch,
              unreadCount: 2,
              totalMessages: 3,
              children: [],
            },
          ],
        },
      ],
    }
    const cTree = compactChannelTree(treePage)
    expect(cTree.tree[0]!.virtual).toBe(true)
    expect(cTree.tree[0]!.children?.[0]!.virtual).toBeUndefined()
    expect(cTree.tree[0]!.children?.[0]!.children).toBeUndefined()

    const notif: NotificationView = {
      id: '1',
      logIndex: 9,
      recipient: 'local:user:alice+codex',
      reason: 'mention',
      priority: 'urgent',
      sourceGroup: null,
      channel: 'decisions',
      thread: 'thr_9',
      rootId: '9',
      messageId: '9',
      byActor: 'local:user:alice+agy',
      byHandle: 'alice/agy',
      excerpt: 'Approve launch @codex',
      createdAt: '2026-11-26T00:00:00.000Z',
      readAt: null,
      ackedAt: null,
    }
    const cn = compactNotification(notif)
    expect('sourceGroup' in cn).toBe(false)
    expect('readAt' in cn).toBe(false)
    expect(cn.byHandle).toBe('alice/agy')

    const nPage: NotificationsPage = { notifications: [notif], cursor: '9', unread: 1, urgent: 1 }
    expect(compactNotificationsPage(nPage).notifications).toHaveLength(1)

    const inbox: AgentInboxView = {
      actor: 'local:user:alice+codex',
      profile: 'codex',
      cursor: '9',
      unreadNotifications: 1,
      urgentCount: 1,
      notifications: [notif],
      tasks: { assigned: [], ready: [] },
      unreadChannels: [],
      unreadDms: [],
      onlinePeers: 2,
    }
    const cInbox = compactAgentInbox(inbox)
    expect('tasks' in cInbox).toBe(false)
    expect('unreadChannels' in cInbox).toBe(false)
    expect('unreadDms' in cInbox).toBe(false)
    expect(cInbox.notifications).toHaveLength(1)

    const pin: PinView = {
      id: '1',
      scope: 'announcement',
      channel: 'announcements',
      rootId: '1',
      thread: 'thr_1',
      messageId: '1',
      pinnedBy: 'local:user:alice',
      pinnedAt: '2026-11-26T00:00:00.000Z',
      note: null,
      sortOrder: 0,
    }
    expect('note' in compactPin(pin)).toBe(false)

    const pres: PresenceView = {
      agent: 'local:user:alice+agy',
      principal: 'local:user:alice',
      profile: 'agy',
      handle: 'alice/agy',
      harness: 'agy',
      model: null,
      status: 'active',
      channel: 'dev',
      taskId: null,
      note: null,
      updatedAt: '2026-11-26T00:00:00.000Z',
      expiresAt: '2026-11-26T00:02:00.000Z',
    }
    const cPres = compactPresence(pres)
    expect('model' in cPres).toBe(false)
    expect(cPres.harness).toBe('agy')

    const grp: GroupView = {
      handle: 'reviewers',
      name: 'Reviewers',
      description: '',
      kind: 'role',
      channel: null,
      members: [{ memberId: 'codex', role: 'lead', addedBy: 'agy', addedAt: '2026-11-26T00:00:00.000Z' }],
      byActor: 'local:user:alice+agy',
      createdAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-26T00:00:00.000Z',
    }
    const cGrp = compactGroup(grp)
    expect('description' in cGrp).toBe(false)
    expect(cGrp.members).toEqual([{ memberId: 'codex', role: 'lead' }])

    const ev: BoardEventView = {
      cursor: '12',
      type: 'message.posted',
      createdAt: '2026-11-26T00:00:00.000Z',
      payload: { empty: null, ok: true },
      message: makeMessage(),
    }
    const cEv = compactEvent(ev)
    expect(cEv['payload']).toEqual({ ok: true })
    expect(cEv['message']).toBeDefined()
  })
})

describe('ultra-terse single-line text formatters', () => {
  it('formats messages, threads, notifications, tasks, presence, channel trees, and inbox digests', () => {
    const msg = makeMessage({
      labels: { 'flag.status': 'open' },
      quote: {
        id: '5',
        channel: 'dev',
        by: 'local:user:bob',
        handle: 'bob',
        excerpt: 'old',
        createdAt: '2026-11-26T00:00:00.000Z',
      },
    })
    expect(formatMessageLine(msg)).toContain('#12 [repos/agent-board/dev] @alice/agy [flag:open quote:#5]: Shipped W2-B client registry')

    const threadLine = formatThreadLine({
      message: msg,
      replies: 3,
      last: makeMessage({ id: '15', re: '12', text: 'Looks great!' }),
      pin: { scope: 'announcement', note: null, pinnedBy: 'alice', pinnedAt: '2026-11-26T00:00:00.000Z' },
    })
    expect(threadLine).toContain('[ANN] #12')
    expect(threadLine).toContain('(3r; last @alice/agy: Looks great!)')

    const notifLine = formatNotificationLine({
      id: '7',
      logIndex: 10,
      recipient: 'local:user:alice+codex',
      reason: 'group_mention',
      priority: 'urgent',
      sourceGroup: 'reviewers',
      channel: 'decisions',
      thread: 'thr_10',
      rootId: '10',
      messageId: '10',
      byActor: 'local:user:alice+agy',
      byHandle: 'alice/agy',
      excerpt: 'Sign off please',
      createdAt: '2026-11-26T00:00:00.000Z',
      readAt: null,
      ackedAt: null,
    })
    expect(notifLine).toBe('n#7 [URGENT][group_mention] @reviewers:[decisions] #10 @alice/agy: Sign off please')

    const taskLine = formatTaskLine({
      id: '42',
      channel: 'work',
      thread: 'thr_42',
      state: 'ready',
      for: 'local:user:alice+codex',
      owner: 'local:user:alice',
      text: 'Finish W2-B',
      replies: 1,
      createdAt: '2026-11-26T00:00:00.000Z',
      latestReply: {
        id: '43',
        by: 'local:user:alice+agy',
        handle: 'alice/agy',
        excerpt: 'Almost there',
        createdAt: '2026-11-26T00:01:00.000Z',
      },
    })
    expect(taskLine).toBe('[ready] #42 [work] for=@codex: Finish W2-B (1r; last @alice/agy: Almost there)')

    const presLine = formatPresenceLine({
      agent: 'local:user:alice+agy',
      principal: 'local:user:alice',
      profile: 'agy',
      handle: 'alice/agy',
      harness: 'agy',
      model: 'gemini',
      status: 'active',
      channel: 'dev',
      taskId: '42',
      note: 'coding',
      updatedAt: '2026-11-26T00:00:00.000Z',
      expiresAt: '2026-11-26T00:02:00.000Z',
    })
    expect(presLine).toBe('[active] @alice/agy (agy/gemini) #dev task:#42 — coding')

    const treeLines = formatChannelTreeLines([
      {
        path: 'repos',
        segment: 'repos',
        virtual: true,
        channel: null,
        unreadCount: 4,
        totalMessages: 10,
        children: [
          {
            path: 'repos/secret',
            segment: 'secret',
            virtual: false,
            channel: { path: 'repos/secret', kind: 'chat', private: true, messages: 10, unreadCount: 4 },
            unreadCount: 4,
            totalMessages: 10,
            children: [],
          },
        ],
      },
    ])
    expect(treeLines).toEqual([
      'repos/ (4 unread, 10 msgs)',
      '  #secret [chat] [private] (4 unread, 10 msgs)',
    ])

    const digest = formatInboxDigest({
      actor: 'local:user:alice+codex',
      profile: 'codex',
      cursor: '50',
      unreadNotifications: 1,
      urgentCount: 0,
      notifications: [
        {
          id: '1',
          logIndex: 50,
          recipient: 'local:user:alice+codex',
          reason: 'dm',
          priority: 'normal',
          sourceGroup: null,
          channel: 'dm/agy--codex',
          thread: 'thr_50',
          rootId: '50',
          messageId: '50',
          byActor: 'local:user:alice+agy',
          byHandle: 'alice/agy',
          excerpt: 'Ping',
          createdAt: '2026-11-26T00:00:00.000Z',
          readAt: null,
          ackedAt: null,
        },
      ],
      tasks: { assigned: [], ready: [] },
      unreadChannels: [{ channel: 'dev', kind: 'chat', unread: 2, lastIndex: 50 }],
      unreadDms: [{ channel: 'dm/agy--codex', peer: 'agy', unread: 1, lastExcerpt: 'Ping', lastIndex: 50 }],
      onlinePeers: 1,
    })
    expect(digest).toContain('inbox @codex cursor=50 unread=1 urgent=0 online=1')
    expect(digest).toContain('unread.dms:')
    expect(digest).toContain('unread.channels:')
  })
})
