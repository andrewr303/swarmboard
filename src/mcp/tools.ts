// Exact 23-tool MCP surface for swarmboard-mcp (Swarmboard v2 launch design §3.3).
// Runtime operations use the client API. SQL reporting is loaded only when requested.
// Zero direct imports of core or host modules.
import type { BoardClient, TaskInBatch } from '../client/client.ts'
import { clientError, isBoardError } from '../client/errors.ts'
import {
  compactAgentInbox,
  compactChannel,
  compactChannelTree,
  compactEvent,
  compactGroup,
  compactMessage,
  compactMessagesPage,
  compactNotification,
  compactNotificationsPage,
  compactPin,
  compactPresence,
  compactTasksPage,
  compactThread,
  compactThreadsPage,
  stripEmpty,
} from '../client/format.ts'
import type { ClaimCache } from './claim-cache.ts'
import type { PresenceManager, PresenceStatus } from './presence.ts'

/** Hard upper bound (seconds) for MCP blocking waits (`board_wait`, `board_task_claim`). */
export const WAIT_CAP_S = 20

export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly annotations?: McpToolAnnotations
}

export interface ToolExecutionContext {
  readonly client: BoardClient
  readonly claimCache: ClaimCache
  readonly presence: PresenceManager
  readonly signal?: AbortSignal
  readonly waitCapS?: number
}

// ---- Exact 23-tool definitions (§3.3)

const VERBOSE_PROPS = {
  compact: { type: 'boolean', description: 'Return compact output (default true).' },
  verbose: { type: 'boolean', description: 'Return full uncompacted payload (default false).' },
} as const

export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: 'board_inbox',
    description:
      'Check at start, dependency changes, and handoff for unread notifications, assigned & ready tasks, unread DMs/channels, reachable peer handles, and head cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        notificationsLimit: { type: 'integer', minimum: 1, maximum: 100 },
        tasksLimit: { type: 'integer', minimum: 1, maximum: 100 },
        channel: { type: 'string', description: 'Optional channel or prefix filter.' },
        includeReadyPool: { type: 'boolean' },
        urgentOnly: { type: 'boolean' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'board_me',
    description: 'Return current identity, profile, assurance level, permissions, connection mode, and board metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'board_channels',
    description: 'List readable channels or a nested hierarchical channel tree with unread counts.',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: { type: 'string' },
        tree: { type: 'boolean', description: 'Return nested channel tree instead of flat list.' },
        kind: { type: 'string', enum: ['chat', 'forum', 'tasks', 'dm', 'announcements'] },
        archived: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['true', 'false', 'all'] }] },
        repo: { type: 'string' },
        sessionId: { type: 'string' },
        includeMeta: { type: 'boolean' },
        includeUnread: { type: 'boolean' },
        after: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'board_channel_manage',
    description: 'Create a channel or update channel metadata (kind, topic, category, parent, repo, archive, privacy/members).',
    inputSchema: {
      type: 'object',
      required: ['action', 'path'],
      properties: {
        action: { type: 'string', enum: ['create', 'update'] },
        path: { type: 'string', description: 'Channel path (e.g. repos/app/dev).' },
        kind: { type: 'string', enum: ['chat', 'forum', 'tasks', 'dm', 'announcements'] },
        topic: { type: ['string', 'null'] },
        category: { type: ['string', 'null'] },
        parent: { type: ['string', 'null'] },
        repo: { type: ['string', 'null'] },
        sessionId: { type: ['string', 'null'] },
        archived: { type: 'boolean' },
        sortOrder: { type: 'integer' },
        private: { type: 'boolean' },
        members: { type: 'array', items: { type: 'string' }, description: 'Initial members (create).' },
        addMembers: { type: 'array', items: { type: 'string' }, description: 'Members to add (update).' },
        removeMembers: { type: 'array', items: { type: 'string' }, description: 'Members to remove (update).' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
  },
  {
    name: 'board_read',
    description:
      'Read a channel (forum-ordered threads or flat messages) OR read a full thread/task by ID (12, #12, msg_12, thr_...).',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'Channel path (e.g. general) OR message/thread ID (e.g. 12, #12, thr_...).',
        },
        kind: { type: 'string', enum: ['auto', 'channel', 'thread'], description: 'Disambiguate target (default auto).' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        after: { type: 'string' },
        before: { type: 'string' },
        flat: { type: 'boolean', description: 'When reading a channel, return flat messages instead of threads.' },
        order: { type: 'string', enum: ['forum', 'chronological'], description: 'Thread ordering (default forum).' },
        pinnedFirst: { type: 'boolean' },
        includeMeta: { type: 'boolean' },
        by: { type: 'string' },
        mentions: { type: 'string' },
        label: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
            { type: 'object', additionalProperties: { type: 'string' } },
          ],
        },
        maxChars: { type: ['integer', 'null'], description: 'Override compact text truncation limit (null = full text).' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'board_post',
    description: 'Post a new thread in a channel OR reply to an existing thread/message (re accepts 12, #12, thr_...).',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        channel: { type: 'string', description: 'Channel path for a new root thread.' },
        re: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Parent message/thread ID for a reply.' },
        text: { type: 'string', description: 'Message text (supports @agent and @group mentions).' },
        quoteMessageId: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        labels: { type: 'object', additionalProperties: { type: 'string' } },
        after: { type: 'string', description: 'Optimistic concurrency cursor for replies.' },
        idempotencyKey: { type: 'string', description: 'Optional idempotency key for safe retries.' },
        noSync: { type: 'boolean' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_edit',
    description: 'Edit your own message text (supports optimistic concurrency via revision).',
    inputSchema: {
      type: 'object',
      required: ['id', 'text'],
      properties: {
        id: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        text: { type: 'string' },
        revision: { type: 'integer', minimum: 1 },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_react',
    description: 'Add or remove an emoji reaction on a message.',
    inputSchema: {
      type: 'object',
      required: ['id', 'emoji'],
      properties: {
        id: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        emoji: { type: 'string' },
        remove: { type: 'boolean' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
  },
  {
    name: 'board_label',
    description: 'Set, unset, or compare-and-swap (if) labels on a message.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        set: { type: 'object', additionalProperties: { type: 'string' } },
        unset: { type: 'array', items: { type: 'string' } },
        if: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
  },
  {
    name: 'board_dm',
    description: 'Canonical 1:1 private DM with a peer: sends a message when text is given, otherwise reads recent DM messages.',
    inputSchema: {
      type: 'object',
      required: ['peer'],
      properties: {
        peer: { type: 'string', description: 'Peer actor ID or profile/handle.' },
        text: { type: 'string', description: 'Message to send; omit to read recent DM messages.' },
        topic: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        after: { type: 'string' },
        quoteMessageId: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        labels: { type: 'object', additionalProperties: { type: 'string' } },
        idempotencyKey: { type: 'string' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_mentions',
    description: 'List unread or historical notifications (@mentions, @groups, DMs, replies, pins, task assignments, urgent decisions).',
    inputSchema: {
      type: 'object',
      properties: {
        unreadOnly: { type: 'boolean', description: 'Only return unacked notifications (default true).' },
        priority: { type: 'string', enum: ['normal', 'urgent'] },
        reason: {
          type: 'string',
          enum: ['mention', 'group_mention', 'dm', 'reply', 'pin', 'task_assigned', 'attention'],
        },
        channel: { type: 'string' },
        after: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'board_ack',
    description: 'Acknowledge a single notification by id, acknowledge all matching notifications, and/or mark a channel read.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Notification ID to ack.' },
        all: { type: 'boolean', description: 'Acknowledge all matching unread notifications.' },
        readOnly: { type: 'boolean', description: 'Mark read_at without acking (single id).' },
        channel: { type: 'string', description: 'Channel or prefix filter (or channel to mark read).' },
        beforeCursor: { type: 'string' },
        cursor: { type: 'string' },
        reason: {
          type: 'string',
          enum: ['mention', 'group_mention', 'dm', 'reply', 'pin', 'task_assigned', 'attention'],
        },
        markChannelRead: { type: 'boolean' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
  },
  {
    name: 'board_pin',
    description: 'Pin a message/thread (thread, channel sticky, or announcement), unpin it, or list active pins.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['pin', 'unpin', 'list'] },
        id: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Message/thread ID (required for pin/unpin).' },
        channel: { type: 'string' },
        thread: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        scope: { type: 'string', enum: ['thread', 'channel', 'announcement'] },
        note: { type: ['string', 'null'] },
        sortOrder: { type: 'integer' },
        notify: { type: 'boolean' },
        includeGlobal: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
  },
  {
    name: 'board_group',
    description: 'Manage @groups: list, get, create, update, delete, add members, or remove members.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'add', 'remove'] },
        handle: { type: 'string', description: 'Group handle without @ (e.g. reviewers).' },
        name: { type: 'string' },
        description: { type: 'string' },
        kind: { type: 'string', enum: ['team', 'swarm', 'role', 'harness', 'system'] },
        channel: { type: ['string', 'null'] },
        members: { type: 'array', items: { type: 'string' } },
        member: { type: 'string', description: 'Member filter for action=list.' },
        role: { type: 'string', enum: ['member', 'lead'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_presence',
    description: 'Set your own online presence status (active, busy, idle, offline) or list online peers.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['set', 'list'] },
        status: { type: 'string', enum: ['active', 'busy', 'idle', 'offline'] },
        channel: { type: ['string', 'null'] },
        taskId: { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] },
        note: { type: ['string', 'null'] },
        harness: { type: 'string' },
        model: { type: 'string' },
        ttlS: { type: 'integer', minimum: 15, maximum: 3600 },
        includeOffline: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_wait',
    description:
      'Bounded real-time wait (hard-capped at 20 s) on incoming inbox notifications (mode=inbox) or board events (mode=events). Returns { woke: false, reason: "timeout", cursor } on quiet timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['inbox', 'events'], description: 'Wait on personal notifications (inbox, default) or raw events.' },
        channel: { type: 'string' },
        re: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        mentions: { type: 'string' },
        by: { type: 'string' },
        label: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
            { type: 'object', additionalProperties: { type: 'string' } },
          ],
        },
        reason: {
          type: 'string',
          enum: ['mention', 'group_mention', 'dm', 'reply', 'pin', 'task_assigned', 'attention'],
        },
        priority: { type: 'string', enum: ['normal', 'urgent'] },
        unreadOnly: { type: 'boolean' },
        after: { type: 'string' },
        timeoutS: { type: 'number', minimum: 0, description: 'Wait duration in seconds (clamped to <= 20 s).' },
        wait: { type: 'number', minimum: 0, description: 'Alias for timeoutS (clamped to <= 20 s).' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'board_search',
    description: 'Full-text FTS5 search across readable messages, tasks, and knowledge.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        channel: { type: 'string' },
        scope: { type: 'string', enum: ['all', 'messages', 'tasks', 'knowledge'] },
        subtree: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'board_tasks_list',
    description: 'List tasks with state, assignee, dependencies, claim info, and latestReply preview.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        state: {
          type: 'string',
          enum: ['open', 'all', 'waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled'],
        },
        for: { type: 'string' },
        owner: { type: 'string' },
        by: { type: 'string' },
        needs: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        label: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
            { type: 'object', additionalProperties: { type: 'string' } },
          ],
        },
        after: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'board_task_create',
    description:
      'Create a single task in a channel (or promote a message via re), OR create an atomic batch (tasks: [...]). Caches claim proof automatically if claim=true.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Task channel (e.g. repos/app/work).' },
        re: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Existing message ID to promote to a task.' },
        text: { type: 'string', description: 'Task description for single task creation.' },
        tasks: {
          type: 'array',
          description: 'Atomic batch of tasks to create in channel.',
          items: {
            type: 'object',
            required: ['text'],
            properties: {
              text: { type: 'string' },
              key: { type: 'string' },
              needs: {
                type: 'array',
                items: {
                  oneOf: [{ type: 'string' }, { type: 'object', required: ['key'], properties: { key: { type: 'string' } } }],
                },
              },
              for: { type: ['string', 'null'] },
              labels: { type: 'object', additionalProperties: { type: 'string' } },
              noSync: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        for: { type: ['string', 'null'] },
        needs: { type: 'array', items: { type: 'string' } },
        claim: { type: 'boolean' },
        lease: { type: 'integer' },
        token: { type: 'string' },
        labels: { type: 'object', additionalProperties: { type: 'string' } },
        idempotencyKey: { type: 'string' },
        noSync: { type: 'boolean' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_task_claim',
    description:
      'Claim a specific task by id OR claim the next ready task in channel (wait hard-capped at 20 s). Caches claim proof ({ epoch, token }) locally for subsequent board_task_update calls.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Specific task ID to claim.' },
        channel: { type: 'string', description: 'Channel to claim the next ready task from.' },
        lease: { type: 'integer', description: 'Lease duration in seconds.' },
        wait: { type: 'number', minimum: 0, description: 'Max seconds to wait for a ready task (clamped to <= 20 s).' },
        timeoutS: { type: 'number', minimum: 0, description: 'Alias for wait (clamped to <= 20 s).' },
        label: { type: 'object', additionalProperties: { type: 'string' } },
        from: { type: 'array', items: { type: 'string' } },
        token: { type: 'string' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_task_update',
    description:
      'Consolidated task lifecycle verb: renew, release, complete, fail, block, unblock, reopen, assign, needs, or cancel. Auto-loads cached { epoch, token } from the local claim cache when omitted.',
    inputSchema: {
      type: 'object',
      required: ['action', 'id'],
      properties: {
        action: {
          type: 'string',
          enum: ['renew', 'release', 'complete', 'fail', 'block', 'unblock', 'reopen', 'assign', 'needs', 'cancel'],
        },
        id: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        result: { type: 'string', description: 'Result note for action=complete.' },
        reason: { type: 'string', description: 'Reason for action=fail, block, or cancel.' },
        kind: { type: 'string', description: 'Optional hold kind for action=block.' },
        for: { type: ['string', 'null'], description: 'Assignee actor ID (or null to unassign) for action=assign.' },
        needs: { type: 'array', items: { type: 'string' }, description: 'Dependency task IDs for action=needs.' },
        lease: { type: 'integer', description: 'New lease seconds for action=renew.' },
        epoch: { type: 'integer', minimum: 1, description: 'Optional claim epoch (auto-filled from local claim cache).' },
        token: { type: 'string', description: 'Optional claim token (auto-filled from local claim cache).' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_feedback',
    description:
      'One-call beta-tester feedback reporter posting a forgiving board-feedback@1 report + triage labels into meta/feedback.',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 500 },
        kind: { type: 'string', enum: ['bug', 'ux', 'perf', 'feature', 'confusion', 'docs', 'other'] },
        severity: { type: 'string', enum: ['low', 'med', 'high', 'blocker'] },
        harness: { type: 'string' },
        model: { type: 'string' },
        tool: { type: 'string' },
        repro: { type: 'string' },
        expected: { type: 'string' },
        actual: { type: 'string' },
        suggestion: { type: 'string' },
        details: { type: 'string' },
        channel: { type: 'string', description: 'Target channel (defaults to meta/feedback).' },
        ...VERBOSE_PROPS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_insights',
    description: 'Read a channel report of task progress by phase, posting activity by actor, or threads awaiting replies. Check coverage for partial results.',
    inputSchema: {
      type: 'object',
      required: ['view', 'channel'],
      properties: {
        view: { type: 'string', enum: ['progress', 'activity', 'unanswered'] },
        channel: { type: 'string', minLength: 1 },
        run: { type: 'string', description: 'Filter by the run label of the root task or thread.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
])

export const MCP_TOOL_NAMES: ReadonlySet<string> = new Set(MCP_TOOLS.map((t) => t.name))

// ---- Argument parsing & helper utilities

type Args = Record<string, unknown>

const MESSAGE_REF_PATTERN =
  /^(?:[1-9]\d{0,15}|#[1-9]\d{0,15}|msg_[1-9]\d{0,15}|thr_[A-Za-z0-9_-]{1,120}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export function isMessageRef(target: string | number): boolean {
  if (typeof target === 'number') return Number.isSafeInteger(target) && target > 0
  return MESSAGE_REF_PATTERN.test(target.trim())
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isCompact(args: Args): boolean {
  if (args['verbose'] === true) return false
  if (args['compact'] === false) return false
  return true
}

function reqString(args: Args, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw clientError('invalid_request', `${key}: must be a non-empty string`)
  }
  return v
}

function optString(args: Args, key: string): string | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw clientError('invalid_request', `${key}: must be a string`)
  return v
}

function optNullableString(args: Args, key: string): string | null | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (v !== null && typeof v !== 'string') throw clientError('invalid_request', `${key}: must be a string or null`)
  return v
}

function optBool(args: Args, key: string): boolean | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw clientError('invalid_request', `${key}: must be a boolean`)
  return v
}

function optNumber(args: Args, key: string): number | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw clientError('invalid_request', `${key}: must be a finite number`)
  }
  return v
}

function optInt(args: Args, key: string): number | undefined {
  const v = optNumber(args, key)
  if (v === undefined) return undefined
  if (!Number.isInteger(v)) throw clientError('invalid_request', `${key}: must be an integer`)
  return v
}

function reqRef(args: Args, key: string): string | number {
  const v = args[key]
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v
  if (typeof v === 'string' && v.trim().length > 0) return v
  throw clientError('invalid_request', `${key}: must be a message/thread ID`)
}

function optRef(args: Args, key: string): string | number | undefined {
  if (args[key] === undefined) return undefined
  return reqRef(args, key)
}

function optStringArray(args: Args, key: string): string[] | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.every((item) => typeof item === 'string')) {
    throw clientError('invalid_request', `${key}: must be an array of strings`)
  }
  return [...v]
}

function optStringRecord(args: Args, key: string): Record<string, string> | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (!isPlainRecord(v)) throw clientError('invalid_request', `${key}: must be an object of string values`)
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') throw clientError('invalid_request', `${key}.${k}: must be a string`)
    out[k] = val
  }
  return out
}

function optNullableStringRecord(args: Args, key: string): Record<string, string | null> | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (!isPlainRecord(v)) throw clientError('invalid_request', `${key}: must be an object of string|null values`)
  const out: Record<string, string | null> = {}
  for (const [k, val] of Object.entries(v)) {
    if (val !== null && typeof val !== 'string') {
      throw clientError('invalid_request', `${key}.${k}: must be a string or null`)
    }
    out[k] = val
  }
  return out
}

function optLabelFilter(args: Args, key: string): Record<string, string> | string | string[] | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.every((i) => typeof i === 'string')) return [...v]
  if (isPlainRecord(v)) return optStringRecord(args, key)
  throw clientError('invalid_request', `${key}: must be a string, string[], or Record<string,string>`)
}

function clampWaitS(
  requested: number | undefined,
  defaultS: number,
  capS: number,
): { readonly waitS: number; readonly clamped: boolean } {
  if (requested === undefined) return { waitS: Math.min(defaultS, capS), clamped: false }
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) {
    throw clientError('invalid_request', 'wait/timeoutS must be a non-negative finite number of seconds')
  }
  if (requested > capS) return { waitS: capS, clamped: true }
  return { waitS: requested, clamped: false }
}

function formatClaimInfo(
  claim: { readonly epoch: number; readonly token: string; readonly until: string },
  compact: boolean,
): Record<string, unknown> {
  return {
    epoch: claim.epoch,
    until: claim.until,
    cached: true,
    ...(!compact ? { token: claim.token } : {}),
  }
}

// ---- Dispatcher for all 23 tools

export async function callMcpTool(name: string, rawArgs: unknown, ctx: ToolExecutionContext): Promise<unknown> {
  const args: Args = rawArgs === undefined || rawArgs === null ? {} : isPlainRecord(rawArgs) ? rawArgs : (() => {
    throw clientError('invalid_request', 'tool arguments must be a JSON object')
  })()

  const { client, claimCache, presence, signal } = ctx
  const compact = isCompact(args)
  const capS = Math.min(ctx.waitCapS ?? WAIT_CAP_S, WAIT_CAP_S)
  const callOpts = signal !== undefined ? { signal } : undefined

  switch (name) {
    case 'board_insights': {
      const channel = reqString(args, 'channel')
      const view = reqString(args, 'view')
      if (view !== 'progress' && view !== 'activity' && view !== 'unanswered') {
        throw clientError('invalid_request', 'view must be progress, activity or unanswered')
      }
      const run = optString(args, 'run')
      const limit = optInt(args, 'limit')
      const { getBoardInsights } = await import('../client/insights.ts')
      return getBoardInsights(client, {
        channel, view, ...(run !== undefined ? { run } : {}), ...(limit !== undefined ? { limit } : {}),
      }, callOpts)
    }
    case 'board_inbox': {
      const notificationsLimit = optInt(args, 'notificationsLimit')
      const tasksLimit = optInt(args, 'tasksLimit')
      const channel = optString(args, 'channel')
      const includeReadyPool = optBool(args, 'includeReadyPool')
      const urgentOnly = optBool(args, 'urgentOnly')
      const inbox = await client.agentInbox(
        {
          ...(notificationsLimit !== undefined ? { notificationsLimit } : {}),
          ...(tasksLimit !== undefined ? { tasksLimit } : {}),
          ...(channel !== undefined ? { channel } : {}),
          ...(includeReadyPool !== undefined ? { includeReadyPool } : {}),
          ...(urgentOnly !== undefined ? { urgentOnly } : {}),
        },
        callOpts,
      )
      return compact ? compactAgentInbox(inbox) : inbox
    }

    case 'board_me': {
      const me = await client.me(callOpts)
      if (!compact) {
        return {
          me,
          selection: client.selection,
          capabilities: client.caps,
          warnings: client.warnings,
        }
      }
      return stripEmpty({
        ...me,
        mode: client.selection.mode,
        transport: client.caps.transport,
        boardId: client.caps.boardId,
        instanceId: client.caps.instanceId,
        schemaVersion: client.caps.schemaVersion,
        writable: client.caps.writable,
        maxWaitS: Math.min(client.caps.maxWaitS, capS),
        ...(presence.harness ? { harness: presence.harness } : {}),
        ...(presence.model ? { model: presence.model } : {}),
      })
    }

    case 'board_channels': {
      const prefix = optString(args, 'prefix')
      const tree = optBool(args, 'tree')
      const kind = optString(args, 'kind') as 'chat' | 'forum' | 'tasks' | 'dm' | 'announcements' | undefined
      const archivedRaw = args['archived']
      if (
        archivedRaw !== undefined &&
        typeof archivedRaw !== 'boolean' &&
        archivedRaw !== 'true' &&
        archivedRaw !== 'false' &&
        archivedRaw !== 'all'
      ) {
        throw clientError('invalid_request', 'archived: must be boolean or "true" | "false" | "all"')
      }
      const archived = archivedRaw as boolean | 'true' | 'false' | 'all' | undefined

      if (tree === true) {
        const includeUnread = optBool(args, 'includeUnread')
        const page = await client.channelTree(
          {
            ...(prefix !== undefined ? { prefix } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(archived !== undefined ? { archived } : {}),
            ...(includeUnread !== undefined ? { includeUnread } : {}),
          },
          callOpts,
        )
        return compact ? compactChannelTree(page) : page
      }

      const after = optString(args, 'after')
      const limit = optInt(args, 'limit')
      const repo = optString(args, 'repo')
      const sessionId = optString(args, 'sessionId')
      const includeMeta = optBool(args, 'includeMeta')
      const page = await client.channels(
        {
          ...(prefix !== undefined ? { prefix } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(archived !== undefined ? { archived } : {}),
          ...(repo !== undefined ? { repo } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(includeMeta !== undefined ? { includeMeta } : {}),
        },
        callOpts,
      )
      if (!compact) return page
      return {
        channels: page.channels.map(compactChannel),
        ...(page.next !== null && page.next !== undefined ? { next: page.next } : {}),
      }
    }

    case 'board_channel_manage': {
      const action = reqString(args, 'action')
      const path = reqString(args, 'path')
      const kind = optString(args, 'kind') as 'chat' | 'forum' | 'tasks' | 'dm' | 'announcements' | undefined
      const topic = optNullableString(args, 'topic')
      const category = optNullableString(args, 'category')
      const parent = optNullableString(args, 'parent')
      const repo = optNullableString(args, 'repo')
      const sessionId = optNullableString(args, 'sessionId')
      const archived = optBool(args, 'archived')
      const sortOrder = optInt(args, 'sortOrder')
      const isPrivate = optBool(args, 'private')

      const meta = {
        ...(kind !== undefined ? { kind } : {}),
        ...(topic !== undefined ? { topic } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(parent !== undefined ? { parent } : {}),
        ...(repo !== undefined ? { repo } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(archived !== undefined ? { archived } : {}),
        ...(sortOrder !== undefined ? { sortOrder } : {}),
        ...(isPrivate !== undefined ? { private: isPrivate } : {}),
      }

      if (action === 'create') {
        const members = optStringArray(args, 'members')
        const res = await client.createChannel(path, {
          ...meta,
          ...(members !== undefined ? { members } : {}),
          ...(signal !== undefined ? { signal } : {}),
        })
        return compact ? { channel: compactChannel(res.channel), created: res.created } : res
      }
      if (action === 'update') {
        const addMembers = optStringArray(args, 'addMembers')
        const removeMembers = optStringArray(args, 'removeMembers')
        const res = await client.updateChannel(
          path,
          {
            ...meta,
            ...(addMembers !== undefined ? { addMembers } : {}),
            ...(removeMembers !== undefined ? { removeMembers } : {}),
          },
          callOpts,
        )
        return compact ? { channel: compactChannel(res.channel) } : res
      }
      throw clientError('invalid_request', `board_channel_manage: unsupported action "${action}" (expected create or update)`)
    }

    case 'board_read': {
      const rawTarget = args['target']
      if (typeof rawTarget !== 'string' && typeof rawTarget !== 'number') {
        throw clientError('invalid_request', 'target: must be a channel path or message/thread ID')
      }
      const target = typeof rawTarget === 'string' ? rawTarget.trim() : rawTarget
      if (typeof target === 'string' && target.length === 0) {
        throw clientError('invalid_request', 'target: must not be empty')
      }
      const targetKind = optString(args, 'kind') ?? 'auto'
      if (targetKind !== 'auto' && targetKind !== 'channel' && targetKind !== 'thread') {
        throw clientError('invalid_request', 'kind: must be auto, channel, or thread')
      }
      const limit = optInt(args, 'limit')
      const after = optString(args, 'after')
      const before = optString(args, 'before')
      const flat = optBool(args, 'flat')
      const maxCharsRaw = args['maxChars']
      if (maxCharsRaw !== undefined && maxCharsRaw !== null && (typeof maxCharsRaw !== 'number' || !Number.isInteger(maxCharsRaw))) {
        throw clientError('invalid_request', 'maxChars: must be an integer or null')
      }
      const maxCharsOpts = maxCharsRaw !== undefined ? { maxChars: maxCharsRaw as number | null } : undefined

      const readAsThread = targetKind === 'thread' || (targetKind === 'auto' && isMessageRef(target))
      if (readAsThread) {
        const thread = await client.thread(
          target,
          {
            ...(after !== undefined ? { after } : {}),
            ...(limit !== undefined ? { limit } : {}),
          },
          callOpts,
        )
        return compact ? compactThread(thread, maxCharsOpts) : thread
      }

      const channelPath = String(target)
      if (flat === true) {
        const page = await client.channel(channelPath).messages(
          {
            ...(after !== undefined ? { after } : {}),
            ...(limit !== undefined ? { limit } : {}),
          },
          callOpts,
        )
        return compact ? compactMessagesPage(page, maxCharsOpts) : page
      }

      const order = (optString(args, 'order') ?? 'forum') as 'forum' | 'chronological'
      const pinnedFirst = optBool(args, 'pinnedFirst')
      const includeMeta = optBool(args, 'includeMeta')
      const by = optString(args, 'by')
      const mentions = optString(args, 'mentions')
      const label = optLabelFilter(args, 'label')
      const page = await client.threads(
        {
          channel: channelPath,
          order,
          ...(pinnedFirst !== undefined ? { pinnedFirst } : {}),
          ...(includeMeta !== undefined ? { includeMeta } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(before !== undefined ? { before } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(by !== undefined ? { by } : {}),
          ...(mentions !== undefined ? { mentions } : {}),
          ...(label !== undefined ? { label } : {}),
        },
        callOpts,
      )
      return compact ? compactThreadsPage(page, maxCharsOpts) : page
    }

    case 'board_post': {
      const channel = optString(args, 'channel')
      const re = optRef(args, 're')
      const text = reqString(args, 'text')
      const quoteMessageId = optRef(args, 'quoteMessageId')
      const labels = optStringRecord(args, 'labels')
      const after = optString(args, 'after')
      const idempotencyKey = optString(args, 'idempotencyKey')
      const noSync = optBool(args, 'noSync')

      if (channel !== undefined && re !== undefined) {
        throw clientError('invalid_request', 'board_post: provide either channel (new thread) or re (reply), not both')
      }
      if (channel === undefined && re === undefined) {
        throw clientError('invalid_request', 'board_post: provide channel (new thread) or re (reply)')
      }

      const postOpts = {
        ...(signal !== undefined ? { signal } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      }

      const written =
        re !== undefined
          ? await client.reply(
              String(re),
              {
                text,
                ...(quoteMessageId !== undefined ? { quoteMessageId } : {}),
                ...(labels !== undefined ? { labels } : {}),
                ...(after !== undefined ? { after } : {}),
                ...(noSync !== undefined ? { noSync } : {}),
              },
              postOpts,
            )
          : await client.post(
              channel!,
              {
                text,
                ...(quoteMessageId !== undefined ? { quoteMessageId } : {}),
                ...(labels !== undefined ? { labels } : {}),
                ...(noSync !== undefined ? { noSync } : {}),
              },
              postOpts,
            )

      if (!compact) return written
      return {
        message: compactMessage(written, { maxChars: null }),
        ...(written.mentions && written.mentions.length > 0 ? { mentions: written.mentions } : {}),
      }
    }

    case 'board_edit': {
      const id = reqRef(args, 'id')
      const text = reqString(args, 'text')
      const revision = optInt(args, 'revision')
      const res = await client.edit(id, text, {
        ...(revision !== undefined ? { revision } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (!compact) return res
      return {
        ok: true,
        message: compactMessage(res.message, { maxChars: null }),
        ...(res.mentions && res.mentions.length > 0 ? { mentions: res.mentions } : {}),
      }
    }

    case 'board_react': {
      const id = reqRef(args, 'id')
      const emoji = reqString(args, 'emoji')
      const remove = optBool(args, 'remove')
      const res = await client.react(id, emoji, {
        ...(remove !== undefined ? { remove } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (!compact) return res
      return { ok: true, message: compactMessage(res.message) }
    }

    case 'board_label': {
      const id = reqRef(args, 'id')
      const set = optStringRecord(args, 'set')
      const unset = optStringArray(args, 'unset')
      const cond = optNullableStringRecord(args, 'if')
      const res = await client.label(
        id,
        {
          ...(set !== undefined ? { set } : {}),
          ...(unset !== undefined ? { unset } : {}),
          ...(cond !== undefined ? { if: cond } : {}),
        },
        callOpts,
      )
      if (!compact) return res
      return { ok: true, message: compactMessage(res.message) }
    }

    case 'board_dm': {
      const peer = reqString(args, 'peer')
      const text = optString(args, 'text')
      const topic = optString(args, 'topic')
      const idempotencyKey = optString(args, 'idempotencyKey')

      if (text !== undefined) {
        const quoteMessageId = optRef(args, 'quoteMessageId')
        const labels = optStringRecord(args, 'labels')
        const res = await client.dm(
          peer,
          {
            text,
            ...(topic !== undefined ? { topic } : {}),
            ...(quoteMessageId !== undefined ? { quoteMessageId } : {}),
            ...(labels !== undefined ? { labels } : {}),
          },
          {
            ...(signal !== undefined ? { signal } : {}),
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          },
        )
        if (!compact) return res
        return {
          channel: compactChannel(res.channel),
          created: res.created,
          peer: res.peer,
          message: compactMessage(res.message, { maxChars: null }),
          ...(res.message.mentions && res.message.mentions.length > 0 ? { mentions: res.message.mentions } : {}),
        }
      }

      const limit = optInt(args, 'limit')
      const after = optString(args, 'after')
      const res = await client.dm(
        peer,
        {
          ...(topic !== undefined ? { topic } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(after !== undefined ? { after } : {}),
        },
        callOpts,
      )
      if (!compact) return res
      return {
        channel: compactChannel(res.channel),
        created: res.created,
        peer: res.peer,
        messages: res.messages.map((m) => compactMessage(m)),
        cursor: res.cursor,
      }
    }

    case 'board_mentions': {
      const unreadOnly = optBool(args, 'unreadOnly')
      const priority = optString(args, 'priority') as 'normal' | 'urgent' | undefined
      const reason = optString(args, 'reason') as
        | 'mention'
        | 'group_mention'
        | 'dm'
        | 'reply'
        | 'pin'
        | 'task_assigned'
        | 'attention'
        | undefined
      const channel = optString(args, 'channel')
      const after = optString(args, 'after')
      const limit = optInt(args, 'limit')
      const page = await client.notifications.list(
        {
          ...(unreadOnly !== undefined ? { unreadOnly } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(reason !== undefined ? { reason } : {}),
          ...(channel !== undefined ? { channel } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        callOpts,
      )
      return compact ? compactNotificationsPage(page) : page
    }

    case 'board_ack': {
      const id = optRef(args, 'id')
      const all = optBool(args, 'all')
      const readOnly = optBool(args, 'readOnly')
      const channel = optString(args, 'channel')
      const beforeCursor = optString(args, 'beforeCursor')
      const cursor = optString(args, 'cursor')
      const reason = optString(args, 'reason') as
        | 'mention'
        | 'group_mention'
        | 'dm'
        | 'reply'
        | 'pin'
        | 'task_assigned'
        | 'attention'
        | undefined
      const markChannelRead = optBool(args, 'markChannelRead')

      if (id !== undefined) {
        const res = await client.notifications.ack(
          id,
          {
            ...(readOnly !== undefined ? { readOnly } : {}),
          },
          callOpts,
        )
        return compact ? { ok: res.ok, notification: compactNotification(res.notification) } : res
      }

      if (all === true) {
        return client.notifications.ackAll(
          {
            ...(channel !== undefined ? { channel } : {}),
            ...(beforeCursor !== undefined ? { beforeCursor } : {}),
            ...(reason !== undefined ? { reason } : {}),
            ...(markChannelRead !== undefined ? { markChannelRead } : {}),
          },
          callOpts,
        )
      }

      if (channel !== undefined) {
        return client.markChannelRead(channel, cursor ?? beforeCursor, callOpts)
      }

      throw clientError('invalid_request', 'board_ack: provide id, all: true, or channel')
    }

    case 'board_pin': {
      const action = reqString(args, 'action')
      const scope = optString(args, 'scope') as 'thread' | 'channel' | 'announcement' | undefined

      if (action === 'pin') {
        const id = reqRef(args, 'id')
        const note = optNullableString(args, 'note')
        const sortOrder = optInt(args, 'sortOrder')
        const notify = optBool(args, 'notify')
        const res = await client.pins.pin(
          id,
          {
            ...(scope !== undefined ? { scope } : {}),
            ...(note !== undefined ? { note } : {}),
            ...(sortOrder !== undefined ? { sortOrder } : {}),
            ...(notify !== undefined ? { notify } : {}),
          },
          callOpts,
        )
        return compact ? { pin: compactPin(res.pin), created: res.created } : res
      }

      if (action === 'unpin') {
        const id = reqRef(args, 'id')
        return client.pins.unpin(id, { ...(scope !== undefined ? { scope } : {}) }, callOpts)
      }

      if (action === 'list') {
        const channel = optString(args, 'channel')
        const thread = optRef(args, 'thread')
        const includeGlobal = optBool(args, 'includeGlobal')
        const limit = optInt(args, 'limit')
        const pins = await client.pins.list(
          {
            ...(channel !== undefined ? { channel } : {}),
            ...(thread !== undefined ? { thread: String(thread) } : {}),
            ...(scope !== undefined ? { scope } : {}),
            ...(includeGlobal !== undefined ? { includeGlobal } : {}),
            ...(limit !== undefined ? { limit } : {}),
          },
          callOpts,
        )
        return compact ? { pins: pins.map((p) => compactPin(p)) } : { pins }
      }

      throw clientError('invalid_request', `board_pin: unsupported action "${action}" (expected pin, unpin, or list)`)
    }

    case 'board_group': {
      const action = reqString(args, 'action')
      const kind = optString(args, 'kind') as 'team' | 'swarm' | 'role' | 'harness' | 'system' | undefined

      if (action === 'list') {
        const member = optString(args, 'member')
        const channel = optString(args, 'channel')
        const limit = optInt(args, 'limit')
        const list = await client.groups.list(
          {
            ...(kind !== undefined ? { kind } : {}),
            ...(member !== undefined ? { member } : {}),
            ...(channel !== undefined ? { channel } : {}),
            ...(limit !== undefined ? { limit } : {}),
          },
          callOpts,
        )
        return compact ? { groups: list.map(compactGroup) } : { groups: list }
      }

      const handle = reqString(args, 'handle')

      if (action === 'get') {
        const g = await client.groups.get(handle, callOpts)
        return compact ? compactGroup(g) : g
      }

      if (action === 'create') {
        const groupName = reqString(args, 'name')
        const description = optString(args, 'description')
        const channel = optNullableString(args, 'channel')
        const members = optStringArray(args, 'members')
        const g = await client.groups.create(
          {
            handle,
            name: groupName,
            ...(description !== undefined ? { description } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(channel !== undefined ? { channel } : {}),
            ...(members !== undefined ? { members } : {}),
          },
          callOpts,
        )
        return compact ? compactGroup(g) : g
      }

      if (action === 'update') {
        const groupName = optString(args, 'name')
        const description = optString(args, 'description')
        const channel = optNullableString(args, 'channel')
        const g = await client.groups.update(
          handle,
          {
            ...(groupName !== undefined ? { name: groupName } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(channel !== undefined ? { channel } : {}),
          },
          callOpts,
        )
        return compact ? compactGroup(g) : g
      }

      if (action === 'delete') {
        return client.groups.delete(handle, callOpts)
      }

      if (action === 'add') {
        const members = optStringArray(args, 'members')
        if (!members || members.length === 0) {
          throw clientError('invalid_request', 'board_group add: members must be a non-empty array of strings')
        }
        const role = optString(args, 'role') as 'member' | 'lead' | undefined
        const g = await client.groups.addMembers(
          handle,
          members,
          { ...(role !== undefined ? { role } : {}) },
          callOpts,
        )
        return compact ? compactGroup(g) : g
      }

      if (action === 'remove') {
        const members = optStringArray(args, 'members')
        if (!members || members.length === 0) {
          throw clientError('invalid_request', 'board_group remove: members must be a non-empty array of strings')
        }
        const g = await client.groups.removeMembers(handle, members, callOpts)
        return compact ? compactGroup(g) : g
      }

      throw clientError(
        'invalid_request',
        `board_group: unsupported action "${action}" (expected list, get, create, update, delete, add, or remove)`,
      )
    }

    case 'board_presence': {
      const action = reqString(args, 'action')
      const status = optString(args, 'status') as PresenceStatus | undefined

      if (action === 'set') {
        const channel = optNullableString(args, 'channel')
        const rawTaskId = args['taskId']
        let taskId: string | number | null | undefined
        if (rawTaskId === null) taskId = null
        else if (rawTaskId !== undefined) taskId = reqRef(args, 'taskId')
        const note = optNullableString(args, 'note')
        const harness = optString(args, 'harness')
        const model = optString(args, 'model')
        const ttlS = optInt(args, 'ttlS')
        const view = await presence.set(client, {
          ...(status !== undefined ? { status } : {}),
          ...(channel !== undefined ? { channel } : {}),
          ...(taskId !== undefined ? { taskId } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(harness !== undefined ? { harness } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(ttlS !== undefined ? { ttlS } : {}),
        })
        return compact ? compactPresence(view) : view
      }

      if (action === 'list') {
        const channel = optString(args, 'channel')
        const includeOffline = optBool(args, 'includeOffline')
        const limit = optInt(args, 'limit')
        const list = await client.presence.list(
          {
            ...(channel !== undefined ? { channel } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(includeOffline !== undefined ? { includeOffline } : {}),
            ...(limit !== undefined ? { limit } : {}),
          },
          callOpts,
        )
        return compact ? { presence: list.map(compactPresence) } : { presence: list }
      }

      throw clientError('invalid_request', `board_presence: unsupported action "${action}" (expected set or list)`)
    }

    case 'board_wait': {
      const mode = optString(args, 'mode') ?? 'inbox'
      if (mode !== 'inbox' && mode !== 'events') {
        throw clientError('invalid_request', `board_wait: mode must be "inbox" or "events"`)
      }
      const requested = optNumber(args, 'timeoutS') ?? optNumber(args, 'wait')
      const { waitS, clamped } = clampWaitS(requested, capS, capS)
      const channel = optString(args, 'channel')
      const after = optString(args, 'after')

      if (mode === 'inbox') {
        const unreadOnly = optBool(args, 'unreadOnly')
        const reason = optString(args, 'reason') as
          | 'mention'
          | 'group_mention'
          | 'dm'
          | 'reply'
          | 'pin'
          | 'task_assigned'
          | 'attention'
          | undefined
        const priority = optString(args, 'priority') as 'normal' | 'urgent' | undefined
        const limit = optInt(args, 'limit')
        const page = await client.notifications.wait(
          {
            ...(unreadOnly !== undefined ? { unreadOnly } : {}),
            ...(reason !== undefined ? { reason } : {}),
            ...(priority !== undefined ? { priority } : {}),
            ...(channel !== undefined ? { channel } : {}),
            ...(after !== undefined ? { after } : {}),
            ...(limit !== undefined ? { limit } : {}),
            wait: waitS,
          },
          callOpts,
        )
        const woke = page.notifications.length > 0
        return {
          woke,
          ...(!woke ? { reason: 'timeout' as const } : {}),
          mode: 'inbox' as const,
          cursor: page.cursor,
          unread: page.unread,
          urgent: page.urgent,
          notifications: compact ? page.notifications.map(compactNotification) : page.notifications,
          ...(clamped ? { cappedToS: capS } : {}),
        }
      }

      const re = optRef(args, 're')
      const mentions = optString(args, 'mentions')
      const by = optString(args, 'by')
      const label = optLabelFilter(args, 'label')
      const page = await client.waitPage(
        {
          timeoutS: waitS,
          ...(channel !== undefined ? { channel } : {}),
          ...(re !== undefined ? { re: String(re) } : {}),
          ...(mentions !== undefined ? { mentions } : {}),
          ...(by !== undefined ? { by } : {}),
          ...(label !== undefined ? { label } : {}),
          ...(after !== undefined ? { after } : {}),
        },
        callOpts,
      )
      const woke = page.events.length > 0
      return {
        woke,
        ...(!woke ? { reason: 'timeout' as const } : {}),
        mode: 'events' as const,
        cursor: page.cursor,
        events: compact ? page.events.map((ev) => compactEvent(ev)) : page.events,
        ...(clamped ? { cappedToS: capS } : {}),
      }
    }

    case 'board_search': {
      const query = reqString(args, 'query')
      const channel = optString(args, 'channel')
      const scope = optString(args, 'scope') as 'all' | 'messages' | 'tasks' | 'knowledge' | undefined
      const subtree = optBool(args, 'subtree')
      const limit = optInt(args, 'limit')
      const hits = await client.search(
        {
          query,
          ...(channel !== undefined ? { channel } : {}),
          ...(scope !== undefined ? { scope } : {}),
          ...(subtree !== undefined ? { subtree } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        callOpts,
      )
      return {
        hits: compact ? hits.map((h) => stripEmpty({ ...h })) : hits,
      }
    }

    case 'board_tasks_list': {
      const channel = optString(args, 'channel')
      const state = optString(args, 'state') as
        | 'open'
        | 'all'
        | 'waiting'
        | 'ready'
        | 'claimed'
        | 'blocked'
        | 'completed'
        | 'failed'
        | 'canceled'
        | undefined
      const assignee = optString(args, 'for')
      const owner = optString(args, 'owner')
      const by = optString(args, 'by')
      const needs = optRef(args, 'needs')
      const label = optLabelFilter(args, 'label')
      const after = optString(args, 'after')
      const limit = optInt(args, 'limit')
      const page = await client.tasks.list(
        {
          ...(channel !== undefined ? { channel } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(assignee !== undefined ? { for: assignee } : {}),
          ...(owner !== undefined ? { owner } : {}),
          ...(by !== undefined ? { by } : {}),
          ...(needs !== undefined ? { needs: String(needs) } : {}),
          ...(label !== undefined ? { label } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        callOpts,
      )
      return compact ? compactTasksPage(page) : page
    }

    case 'board_task_create': {
      const channel = optString(args, 'channel')
      const re = optRef(args, 're')
      const tasksArg = args['tasks']
      const idempotencyKey = optString(args, 'idempotencyKey')
      const createCallOpts = {
        ...(signal !== undefined ? { signal } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      }

      if (tasksArg !== undefined) {
        if (!channel) {
          throw clientError('invalid_request', 'board_task_create: channel is required when creating a task batch')
        }
        if (!Array.isArray(tasksArg) || tasksArg.length === 0) {
          throw clientError('invalid_request', 'board_task_create: tasks must be a non-empty array')
        }
        const created = await client.tasks.createMany(channel, tasksArg as TaskInBatch[], createCallOpts)
        return {
          tasks: compact ? created.map((t) => compactMessage(t)) : created,
        }
      }

      const assignee = optNullableString(args, 'for')
      const needs = optStringArray(args, 'needs')
      const claim = optBool(args, 'claim')
      const lease = optInt(args, 'lease')
      const token = optString(args, 'token')

      if (re !== undefined) {
        const res = await client.tasks.create(
          { re: String(re) },
          {
            ...(assignee !== undefined ? { for: assignee } : {}),
            ...(needs !== undefined ? { needs } : {}),
            ...(claim !== undefined ? { claim } : {}),
            ...(lease !== undefined ? { lease } : {}),
            ...(token !== undefined ? { token } : {}),
          },
          createCallOpts,
        )
        if (res.claim) {
          claimCache.set(res.task.id, {
            epoch: res.claim.epoch,
            token: res.claim.token,
            until: res.claim.until,
            thread: res.task.thread,
          })
        }
        return {
          task: compact ? compactMessage(res.task, { maxChars: null }) : res.task,
          ...(res.claim ? { claim: formatClaimInfo(res.claim, compact) } : {}),
          ...(res.mentions && res.mentions.length > 0 ? { mentions: res.mentions } : {}),
        }
      }

      if (!channel) {
        throw clientError('invalid_request', 'board_task_create: provide channel (or re to promote a message)')
      }
      const text = reqString(args, 'text')
      const labels = optStringRecord(args, 'labels')
      const noSync = optBool(args, 'noSync')
      const res = await client.tasks.create(
        channel,
        {
          text,
          ...(assignee !== undefined ? { for: assignee } : {}),
          ...(needs !== undefined ? { needs } : {}),
          ...(claim !== undefined ? { claim } : {}),
          ...(lease !== undefined ? { lease } : {}),
          ...(token !== undefined ? { token } : {}),
          ...(labels !== undefined ? { labels } : {}),
          ...(noSync !== undefined ? { noSync } : {}),
        },
        createCallOpts,
      )
      if (res.claim) {
        claimCache.set(res.task.id, {
          epoch: res.claim.epoch,
          token: res.claim.token,
          until: res.claim.until,
          thread: res.task.thread,
        })
      }
      return {
        task: compact ? compactMessage(res.task, { maxChars: null }) : res.task,
        ...(res.claim ? { claim: formatClaimInfo(res.claim, compact) } : {}),
        ...(res.mentions && res.mentions.length > 0 ? { mentions: res.mentions } : {}),
      }
    }

    case 'board_task_claim': {
      const id = optRef(args, 'id')
      const channel = optString(args, 'channel')
      const lease = optInt(args, 'lease')
      const token = optString(args, 'token')

      if (id !== undefined && channel !== undefined) {
        throw clientError('invalid_request', 'board_task_claim: provide either id or channel, not both')
      }
      if (id === undefined && channel === undefined) {
        throw clientError('invalid_request', 'board_task_claim: provide id (specific task) or channel (next ready task)')
      }

      if (id !== undefined) {
        const claimed = await client.tasks.claim(String(id), {
          ...(lease !== undefined ? { lease } : {}),
          ...(token !== undefined ? { token } : {}),
          ...(signal !== undefined ? { signal } : {}),
        })
        claimCache.set(claimed.task.id, {
          epoch: claimed.epoch,
          token: claimed.token,
          until: claimed.until,
          thread: claimed.task.thread,
        })
        return {
          claimed: true,
          task: compact ? compactMessage(claimed.task, { maxChars: null }) : claimed.task,
          claim: formatClaimInfo(claimed, compact),
        }
      }

      const requestedWait = optNumber(args, 'wait') ?? optNumber(args, 'timeoutS')
      const { waitS, clamped } = clampWaitS(requestedWait, 0, capS)
      const label = optStringRecord(args, 'label')
      const from = optStringArray(args, 'from')
      const claimed = await client.tasks.claim(
        {
          channel: channel!,
          ...(label !== undefined ? { label } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(waitS > 0 ? { wait: waitS } : {}),
          ...(lease !== undefined ? { lease } : {}),
          ...(token !== undefined ? { token } : {}),
        },
        callOpts,
      )
      if (claimed === null) {
        let cursor = '0'
        try {
          const snapshot = await client.tasks.list({ channel: channel!, limit: 1 }, callOpts)
          cursor = snapshot.cursor
        } catch {
          // Best-effort cursor lookup on quiet timeout.
        }
        return {
          claimed: false,
          woke: false,
          reason: 'timeout' as const,
          cursor,
          task: null,
          ...(clamped ? { cappedToS: capS } : {}),
        }
      }
      claimCache.set(claimed.task.id, {
        epoch: claimed.epoch,
        token: claimed.token,
        until: claimed.until,
        thread: claimed.task.thread,
      })
      return {
        claimed: true,
        woke: true,
        task: compact ? compactMessage(claimed.task, { maxChars: null }) : claimed.task,
        claim: formatClaimInfo(claimed, compact),
        ...(clamped ? { cappedToS: capS } : {}),
      }
    }

    case 'board_task_update': {
      const action = reqString(args, 'action')
      const id = reqRef(args, 'id')
      const explicitEpoch = optInt(args, 'epoch')
      const explicitToken = optString(args, 'token')
      const cached = claimCache.get(id)
      const epoch = explicitEpoch ?? cached?.epoch
      const token = explicitToken ?? cached?.token

      const requireProof = (): { readonly epoch: number; readonly token: string } => {
        if (epoch === undefined || token === undefined) {
          throw clientError(
            'invalid_request',
            `board_task_update ${action}: missing claim proof (epoch/token) for task ${String(id)}`,
            { hint: 'claim the task first via board_task_claim or supply explicit epoch and token' },
          )
        }
        return { epoch, token }
      }

      const evictOnClaimLost = (err: unknown): never => {
        if (isBoardError(err) && err.code === 'claim_lost') {
          claimCache.delete(id)
        }
        throw err
      }

      switch (action) {
        case 'renew': {
          const proof = requireProof()
          const lease = optInt(args, 'lease')
          try {
            const renewed = await client.tasks.held(String(id), proof).renew(lease, callOpts)
            claimCache.set(renewed.task.id, {
              epoch: renewed.epoch,
              token: renewed.token,
              until: renewed.until,
              thread: renewed.task.thread,
            })
            return {
              ok: true,
              task: compact ? compactMessage(renewed.task, { maxChars: null }) : renewed.task,
              claim: formatClaimInfo(renewed, compact),
            }
          } catch (err) {
            return evictOnClaimLost(err)
          }
        }
        case 'release': {
          const proof = requireProof()
          try {
            const task = await client.tasks.held(String(id), proof).release(callOpts)
            claimCache.delete(id)
            claimCache.delete(task.id)
            return { ok: true, task: compact ? compactMessage(task, { maxChars: null }) : task }
          } catch (err) {
            return evictOnClaimLost(err)
          }
        }
        case 'complete': {
          const proof = requireProof()
          const result = optString(args, 'result')
          try {
            const task = await client.tasks.held(String(id), proof).complete(result, callOpts)
            claimCache.delete(id)
            claimCache.delete(task.id)
            return { ok: true, task: compact ? compactMessage(task, { maxChars: null }) : task }
          } catch (err) {
            return evictOnClaimLost(err)
          }
        }
        case 'fail': {
          const proof = requireProof()
          const reason = reqString(args, 'reason')
          try {
            const task = await client.tasks.held(String(id), proof).fail(reason, callOpts)
            claimCache.delete(id)
            claimCache.delete(task.id)
            return { ok: true, task: compact ? compactMessage(task, { maxChars: null }) : task }
          } catch (err) {
            return evictOnClaimLost(err)
          }
        }
        case 'block': {
          const reason = reqString(args, 'reason')
          const kind = optString(args, 'kind')
          const blockOpts = {
            ...(kind !== undefined ? { kind } : {}),
            ...(signal !== undefined ? { signal } : {}),
          }
          if (epoch !== undefined && token !== undefined) {
            try {
              const task = await client.tasks.held(String(id), { epoch, token }).block(reason, blockOpts)
              claimCache.delete(id)
              claimCache.delete(task.id)
              return { ok: true, task: compact ? compactMessage(task, { maxChars: null }) : task }
            } catch (err) {
              return evictOnClaimLost(err)
            }
          }
          const task = await client.tasks.block(id, reason, blockOpts)
          return { ok: true, task: compact ? compactMessage(task, { maxChars: null }) : task }
        }
        case 'unblock': {
          const task = await client.tasks.unblock(id, callOpts)
          return { ok: true, task: compact ? compactMessage(task, { maxChars: null }) : task }
        }
        case 'reopen': {
          const task = await client.tasks.reopen(id, callOpts)
          return { ok: true, task: compact ? compactMessage(task, { maxChars: null }) : task }
        }
        case 'assign': {
          if (!Object.hasOwn(args, 'for')) {
            throw clientError('invalid_request', 'board_task_update assign: provide "for" (actor ID or null to unassign)')
          }
          const assignee = optNullableString(args, 'for') ?? null
          const task = await client.tasks.assign(id, assignee, callOpts)
          return { ok: true, task: compact ? compactMessage(task, { maxChars: null }) : task }
        }
        case 'needs': {
          const needs = optStringArray(args, 'needs')
          if (needs === undefined) {
            throw clientError('invalid_request', 'board_task_update needs: provide "needs" array of task IDs')
          }
          const task = await client.tasks.needs(id, needs, callOpts)
          return { ok: true, task: compact ? compactMessage(task, { maxChars: null }) : task }
        }
        case 'cancel': {
          const reason = reqString(args, 'reason')
          const task = await client.tasks.cancel(id, reason, callOpts)
          claimCache.delete(id)
          claimCache.delete(task.id)
          return { ok: true, task: compact ? compactMessage(task, { maxChars: null }) : task }
        }
        default:
          throw clientError(
            'invalid_request',
            `board_task_update: unsupported action "${action}" (expected renew, release, complete, fail, block, unblock, reopen, assign, needs, or cancel)`,
          )
      }
    }

    case 'board_feedback': {
      const summary = reqString(args, 'summary')
      const kind = optString(args, 'kind')
      const severity = optString(args, 'severity')
      const harness = optString(args, 'harness') ?? presence.harness
      const model = optString(args, 'model') ?? presence.model
      const tool = optString(args, 'tool')
      const repro = optString(args, 'repro')
      const expected = optString(args, 'expected')
      const actual = optString(args, 'actual')
      const suggestion = optString(args, 'suggestion')
      const details = optString(args, 'details')
      const channel = optString(args, 'channel')

      const written = await client.feedback(
        {
          summary,
          ...(kind !== undefined ? { kind } : {}),
          ...(severity !== undefined ? { severity } : {}),
          ...(harness !== undefined ? { harness } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(tool !== undefined ? { tool } : {}),
          ...(repro !== undefined ? { repro } : {}),
          ...(expected !== undefined ? { expected } : {}),
          ...(actual !== undefined ? { actual } : {}),
          ...(suggestion !== undefined ? { suggestion } : {}),
          ...(details !== undefined ? { details } : {}),
          ...(channel !== undefined ? { channel } : {}),
        },
        callOpts,
      )
      if (!compact) return written
      return {
        ok: true,
        message: compactMessage(written, { maxChars: null }),
      }
    }

    default:
      throw clientError('invalid_request', `unknown MCP tool "${name}"`)
  }
}
