// Token-efficient compact formatter & agent digest helpers (Swarmboard v2 launch design §1.5).
// Pure and thin: ZERO runtime imports (type-only imports from ../core/public.ts only).
// Shared by CLI (--compact) and MCP (default compact: true).
import type {
  AgentInboxView,
  Attachment,
  BlockView,
  BoardEventView,
  ChannelKind,
  ChannelTreeNode,
  ChannelTreePage,
  ChannelView,
  CompactTaskDigest,
  GroupView,
  LinkView,
  MessagesPage,
  MessageView,
  NotificationsPage,
  NotificationView,
  PinView,
  PresenceView,
  QuoteView,
  TaskView,
  ThreadPinBadge,
  ThreadsPage,
  ThreadSummaryView,
  ThreadView,
  TasksPage,
} from '../core/public.ts'

/** Default body truncation ceiling for list views (threads, channel messages, search, pins). */
export const DEFAULT_LIST_MAX_CHARS = 400
/** Default single-line excerpt ceiling for compact text lines and latestReply previews. */
export const DEFAULT_EXCERPT_CHARS = 160

export interface CompactOptions {
  /** Maximum Unicode code points to keep in message text. Pass `null` or `Infinity` to keep full text. */
  readonly maxChars?: number | null
}

export interface TruncatedText {
  readonly text: string
  readonly truncated: boolean
}

export interface CompactLatestReply {
  readonly id: string
  readonly by: string
  readonly handle: string | null
  readonly excerpt: string
  readonly createdAt: string
}

export interface CompactTaskView {
  readonly state: TaskView['state']
  readonly owner: string
  readonly by: string
  readonly epoch: number
  readonly for?: string
  readonly needs?: readonly string[]
  readonly claim?: { readonly actor: string; readonly until: string }
  readonly blocked?: { readonly kind?: string; readonly reason: string }
  readonly result?: string
  readonly reason?: string
}

export interface CompactQuoteView {
  readonly id: string
  readonly channel: string
  readonly by: string
  readonly handle?: string
  readonly excerpt: string
  readonly createdAt: string
}

export interface CompactMessage {
  readonly id: string
  readonly channel: string
  readonly thread: string
  readonly by: string
  readonly handle?: string
  readonly authorKind?: string
  readonly verified?: true
  readonly text: string
  readonly truncated?: true
  readonly createdAt: string
  readonly re?: string
  readonly replyTo?: string
  readonly editedAt?: string
  readonly deleted?: true
  readonly noSync?: true
  readonly blind?: true
  readonly revision?: number
  readonly labels?: Readonly<Record<string, string>>
  readonly reactions?: Readonly<Record<string, readonly string[]>>
  readonly attachments?: readonly Attachment[]
  readonly links?: readonly Record<string, unknown>[]
  readonly blocks?: readonly BlockView[]
  readonly undelivered?: Readonly<Record<string, string>>
  readonly quote?: CompactQuoteView
  readonly schedule?: { readonly id: string; readonly n: number }
  readonly task?: CompactTaskView
}

export interface CompactThreadSummary {
  readonly message: CompactMessage
  readonly replies: number
  readonly latestReply?: CompactLatestReply
  readonly pin?: {
    readonly scope: ThreadPinBadge['scope']
    readonly note?: string
    readonly pinnedBy: string
    readonly pinnedAt: string
  }
  readonly participants?: readonly string[]
}

export interface CompactThread {
  readonly message: CompactMessage
  readonly replies: readonly CompactMessage[]
  readonly cursor: string
  readonly schedules?: readonly Record<string, unknown>[]
}

export interface CompactThreadsPage {
  readonly threads: readonly CompactThreadSummary[]
  readonly cursor: string
  readonly older?: string
  readonly scanned?: number
}

export interface CompactTasksPage {
  readonly tasks: readonly CompactThreadSummary[]
  readonly cursor: string
}

export interface CompactMessagesPage {
  readonly messages: readonly CompactMessage[]
  readonly cursor: string
}

export interface CompactChannel {
  readonly path: string
  readonly kind?: ChannelKind
  readonly lastIndex?: number
  readonly messages?: number
  readonly threads?: number
  readonly category?: string
  readonly parent?: string
  readonly topic?: string
  readonly archived?: true
  readonly sortOrder?: number
  readonly repo?: string
  readonly sessionId?: string
  readonly private?: true
  readonly pinnedCount?: number
  readonly unreadCount?: number
}

export interface CompactChannelTreeNode {
  readonly path: string
  readonly segment: string
  readonly virtual?: true
  readonly channel?: CompactChannel
  readonly unreadCount?: number
  readonly totalMessages?: number
  readonly children?: readonly CompactChannelTreeNode[]
}

export interface CompactNotification {
  readonly id: string
  readonly logIndex: number
  readonly reason: NotificationView['reason']
  readonly priority: NotificationView['priority']
  readonly sourceGroup?: string
  readonly channel: string
  readonly thread: string
  readonly rootId: string
  readonly messageId: string
  readonly byActor: string
  readonly byHandle?: string
  readonly excerpt: string
  readonly createdAt: string
  readonly readAt?: string
  readonly ackedAt?: string
}

export interface CompactPin {
  readonly id: string
  readonly scope: PinView['scope']
  readonly channel: string
  readonly rootId: string
  readonly thread: string
  readonly messageId: string
  readonly pinnedBy: string
  readonly pinnedAt: string
  readonly note?: string
  readonly sortOrder?: number
  readonly message?: CompactMessage
}

export interface CompactPresence {
  readonly agent: string
  readonly handle: string
  readonly status: PresenceView['status']
  readonly profile?: string
  readonly harness?: string
  readonly model?: string
  readonly channel?: string
  readonly taskId?: string
  readonly note?: string
  readonly updatedAt: string
  readonly expiresAt: string
}

export interface CompactGroup {
  readonly handle: string
  readonly name: string
  readonly kind: GroupView['kind']
  readonly description?: string
  readonly channel?: string
  readonly members?: readonly { readonly memberId: string; readonly role: 'member' | 'lead' }[]
  readonly byActor: string
  readonly updatedAt: string
}

export interface CompactAgentInbox {
  readonly actor: string
  readonly profile?: string
  readonly cursor: string
  readonly unreadNotifications: number
  readonly urgentCount: number
  readonly onlinePeers: number
  readonly notifications?: readonly CompactNotification[]
  readonly tasks?: {
    readonly assigned?: readonly Record<string, unknown>[]
    readonly ready?: readonly Record<string, unknown>[]
  }
  readonly unreadChannels?: AgentInboxView['unreadChannels']
  readonly unreadDms?: AgentInboxView['unreadDms']
}

// ---- Core primitives

const MAX_STRIP_DEPTH = 32

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Truncates `text` to at most `maxChars` Unicode code points without splitting surrogate pairs.
 * Appends `'…'` when truncated (when `maxChars >= 1`).
 */
export function truncateText(text: string, maxChars: number): TruncatedText {
  if (!Number.isFinite(maxChars)) return { text, truncated: false }
  const limit = Math.max(0, Math.floor(maxChars))
  const chars = Array.from(text)
  if (chars.length <= limit) return { text, truncated: false }
  if (limit === 0) return { text: '', truncated: true }
  if (limit === 1) return { text: '…', truncated: true }
  return { text: `${chars.slice(0, limit - 1).join('')}…`, truncated: true }
}

/** Collapses whitespace to single spaces and truncates to `maxChars` code points. */
export function excerptLine(text: string, maxChars = DEFAULT_EXCERPT_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return truncateText(collapsed, maxChars).text
}

/**
 * Recursively strips `null`, `undefined`, empty arrays `[]`, and empty plain objects `{}`
 * from a JSON-shaped value so agent payloads omit empty scaffolding.
 */
export function stripEmpty<T>(value: T, depth = 0): T {
  if (depth > MAX_STRIP_DEPTH || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      if (item === null || item === undefined) continue
      const cleaned = stripEmpty(item, depth + 1)
      if (cleaned === null || cleaned === undefined) continue
      if (Array.isArray(cleaned) && cleaned.length === 0) continue
      if (isPlainRecord(cleaned) && Object.keys(cleaned).length === 0) continue
      out.push(cleaned)
    }
    return out as unknown as T
  }
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue
    const cleaned = stripEmpty(v, depth + 1)
    if (cleaned === null || cleaned === undefined) continue
    if (Array.isArray(cleaned) && cleaned.length === 0) continue
    if (isPlainRecord(cleaned) && Object.keys(cleaned).length === 0) continue
    out[k] = cleaned
  }
  return out as T
}

function nonEmptyRecord<V>(rec: Readonly<Record<string, V>> | undefined): Readonly<Record<string, V>> | undefined {
  if (!rec) return undefined
  return Object.keys(rec).length > 0 ? rec : undefined
}

function compactTaskView(task: TaskView): CompactTaskView {
  return {
    state: task.state,
    owner: task.owner,
    by: task.by,
    epoch: task.epoch,
    ...(task.for !== null ? { for: task.for } : {}),
    ...(task.needs.length > 0 ? { needs: task.needs } : {}),
    ...(task.claim !== null ? { claim: task.claim } : {}),
    ...(task.blocked !== null
      ? {
          blocked: {
            ...(task.blocked.kind !== null ? { kind: task.blocked.kind } : {}),
            reason: task.blocked.reason,
          },
        }
      : {}),
    ...(task.result !== null ? { result: task.result } : {}),
    ...(task.reason !== null ? { reason: task.reason } : {}),
  }
}

function compactQuoteView(quote: QuoteView): CompactQuoteView {
  return {
    id: quote.id,
    channel: quote.channel,
    by: quote.by,
    ...(quote.handle !== null ? { handle: quote.handle } : {}),
    excerpt: quote.excerpt,
    createdAt: quote.createdAt,
  }
}

function compactLink(link: LinkView): Record<string, unknown> {
  return stripEmpty({ ...link })
}

// ---- Structured compact projections

/**
 * Compacts a `MessageView` for token-efficient agent output.
 * Strips empty collections (`reactions: {}`, `labels: {}`, `attachments: []`, `links: []`, `blocks: []`,
 * `undelivered: {}`) and null fields; truncates `text` to `opts.maxChars` (default `DEFAULT_LIST_MAX_CHARS = 400`;
 * pass `maxChars: null` to keep full text) with `truncated: true`.
 */
export function compactMessage(msg: MessageView, opts?: CompactOptions): CompactMessage {
  const maxChars = opts?.maxChars === undefined ? DEFAULT_LIST_MAX_CHARS : opts.maxChars
  const { text, truncated } = maxChars === null ? { text: msg.text, truncated: false } : truncateText(msg.text, maxChars)
  const labels = nonEmptyRecord(msg.labels)
  const reactions = nonEmptyRecord(msg.reactions)
  const undelivered = nonEmptyRecord(msg.undelivered)
  return {
    id: msg.id,
    channel: msg.channel,
    thread: msg.thread,
    by: msg.by.actor,
    ...(msg.author?.handle ? { handle: msg.author.handle } : {}),
    ...(msg.author?.kind ? { authorKind: msg.author.kind } : {}),
    ...(msg.author?.verified === true ? { verified: true as const } : {}),
    text,
    ...(truncated ? { truncated: true as const } : {}),
    createdAt: msg.createdAt,
    ...(msg.re !== null ? { re: msg.re } : {}),
    ...(msg.replyTo !== null ? { replyTo: msg.replyTo } : {}),
    ...(msg.editedAt !== null ? { editedAt: msg.editedAt } : {}),
    ...(msg.deleted ? { deleted: true as const } : {}),
    ...(msg.noSync ? { noSync: true as const } : {}),
    ...(msg.blind === true ? { blind: true as const } : {}),
    ...(msg.revision > 1 ? { revision: msg.revision } : {}),
    ...(labels ? { labels } : {}),
    ...(reactions ? { reactions } : {}),
    ...(msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
    ...(msg.links.length > 0 ? { links: msg.links.map(compactLink) } : {}),
    ...(msg.blocks.length > 0 ? { blocks: msg.blocks } : {}),
    ...(undelivered ? { undelivered } : {}),
    ...(msg.quote !== undefined ? { quote: compactQuoteView(msg.quote) } : {}),
    ...(msg.schedule !== undefined ? { schedule: msg.schedule } : {}),
    ...(msg.task !== undefined ? { task: compactTaskView(msg.task) } : {}),
  }
}

/** Projects a `MessageView | null` into the compact `latestReply` digest shape (§1.5). */
export function compactLatestReply(last: MessageView | null, maxChars = DEFAULT_EXCERPT_CHARS): CompactLatestReply | null {
  if (last === null) return null
  return {
    id: last.id,
    by: last.by.actor,
    handle: last.author?.handle ?? null,
    excerpt: excerptLine(last.text, maxChars),
    createdAt: last.createdAt,
  }
}

/** Compacts a `ThreadSummaryView` (list of threads or tasks), exposing `latestReply` when `last !== null`. */
export function compactThreadSummary(summary: ThreadSummaryView, opts?: CompactOptions): CompactThreadSummary {
  const maxChars = opts?.maxChars === undefined ? DEFAULT_LIST_MAX_CHARS : opts.maxChars
  const latestReply = compactLatestReply(summary.last)
  return {
    message: compactMessage(summary.message, { maxChars }),
    replies: summary.replies,
    ...(latestReply !== null ? { latestReply } : {}),
    ...(summary.pin !== undefined
      ? {
          pin: {
            scope: summary.pin.scope,
            ...(summary.pin.note !== null ? { note: summary.pin.note } : {}),
            pinnedBy: summary.pin.pinnedBy,
            pinnedAt: summary.pin.pinnedAt,
          },
        }
      : {}),
    ...(summary.participants && summary.participants.length > 0 ? { participants: summary.participants } : {}),
  }
}

/** Compacts a single-thread read: preserves full text by default (`maxChars: null`), strips empty fields. */
export function compactThread(thread: ThreadView, opts?: CompactOptions): CompactThread {
  const maxChars = opts?.maxChars === undefined ? null : opts.maxChars
  return {
    message: compactMessage(thread.message, { maxChars }),
    replies: thread.replies.map((r) => compactMessage(r, { maxChars })),
    cursor: thread.cursor,
    ...(thread.schedules && thread.schedules.length > 0
      ? { schedules: thread.schedules.map((s) => stripEmpty({ ...s })) }
      : {}),
  }
}

export function compactThreadsPage(page: ThreadsPage, opts?: CompactOptions): CompactThreadsPage {
  return {
    threads: page.threads.map((t) => compactThreadSummary(t, opts)),
    cursor: page.cursor,
    ...(page.older !== undefined && page.older !== null ? { older: page.older } : {}),
    ...(page.scanned !== undefined ? { scanned: page.scanned } : {}),
  }
}

export function compactTasksPage(page: TasksPage, opts?: CompactOptions): CompactTasksPage {
  return {
    tasks: page.tasks.map((t) => compactThreadSummary(t, opts)),
    cursor: page.cursor,
  }
}

export function compactMessagesPage(page: MessagesPage, opts?: CompactOptions): CompactMessagesPage {
  return {
    messages: page.messages.map((m) => compactMessage(m, opts)),
    cursor: page.cursor,
  }
}

export function compactChannel(ch: ChannelView): CompactChannel {
  return {
    path: ch.path,
    ...(ch.kind !== undefined ? { kind: ch.kind } : {}),
    ...(ch.lastIndex !== undefined && ch.lastIndex > 0 ? { lastIndex: ch.lastIndex } : {}),
    ...(ch.messages !== undefined && ch.messages > 0 ? { messages: ch.messages } : {}),
    ...(ch.threads !== undefined && ch.threads > 0 ? { threads: ch.threads } : {}),
    ...(ch.category !== undefined && ch.category !== null ? { category: ch.category } : {}),
    ...(ch.parent !== undefined && ch.parent !== null ? { parent: ch.parent } : {}),
    ...(ch.topic !== undefined && ch.topic !== null && ch.topic !== '' ? { topic: ch.topic } : {}),
    ...(ch.archived === true ? { archived: true as const } : {}),
    ...(ch.sortOrder !== undefined && ch.sortOrder !== 0 ? { sortOrder: ch.sortOrder } : {}),
    ...(ch.repo !== undefined && ch.repo !== null ? { repo: ch.repo } : {}),
    ...(ch.sessionId !== undefined && ch.sessionId !== null ? { sessionId: ch.sessionId } : {}),
    ...(ch.private === true ? { private: true as const } : {}),
    ...(ch.pinnedCount !== undefined && ch.pinnedCount > 0 ? { pinnedCount: ch.pinnedCount } : {}),
    ...(ch.unreadCount !== undefined && ch.unreadCount > 0 ? { unreadCount: ch.unreadCount } : {}),
  }
}

export function compactChannelTreeNode(node: ChannelTreeNode): CompactChannelTreeNode {
  return {
    path: node.path,
    segment: node.segment,
    ...(node.virtual ? { virtual: true as const } : {}),
    ...(node.channel !== null ? { channel: compactChannel(node.channel) } : {}),
    ...(node.unreadCount > 0 ? { unreadCount: node.unreadCount } : {}),
    ...(node.totalMessages > 0 ? { totalMessages: node.totalMessages } : {}),
    ...(node.children.length > 0 ? { children: node.children.map(compactChannelTreeNode) } : {}),
  }
}

export function compactChannelTree(page: ChannelTreePage): {
  readonly tree: readonly CompactChannelTreeNode[]
  readonly cursor: string
} {
  return {
    tree: page.tree.map(compactChannelTreeNode),
    cursor: page.cursor,
  }
}

export function compactNotification(n: NotificationView): CompactNotification {
  return {
    id: n.id,
    logIndex: n.logIndex,
    reason: n.reason,
    priority: n.priority,
    ...(n.sourceGroup !== null ? { sourceGroup: n.sourceGroup } : {}),
    channel: n.channel,
    thread: n.thread,
    rootId: n.rootId,
    messageId: n.messageId,
    byActor: n.byActor,
    ...(n.byHandle !== null ? { byHandle: n.byHandle } : {}),
    excerpt: n.excerpt,
    createdAt: n.createdAt,
    ...(n.readAt !== null ? { readAt: n.readAt } : {}),
    ...(n.ackedAt !== null ? { ackedAt: n.ackedAt } : {}),
  }
}

export function compactNotificationsPage(page: NotificationsPage): {
  readonly notifications: readonly CompactNotification[]
  readonly cursor: string
  readonly unread: number
  readonly urgent: number
} {
  return {
    notifications: page.notifications.map(compactNotification),
    cursor: page.cursor,
    unread: page.unread,
    urgent: page.urgent,
  }
}

export function compactAgentInbox(inbox: AgentInboxView): CompactAgentInbox {
  const assigned = inbox.tasks.assigned.map((t) => stripEmpty({ ...t }))
  const ready = inbox.tasks.ready.map((t) => stripEmpty({ ...t }))
  const hasTasks = assigned.length > 0 || ready.length > 0
  return {
    actor: inbox.actor,
    ...(inbox.profile !== null ? { profile: inbox.profile } : {}),
    cursor: inbox.cursor,
    unreadNotifications: inbox.unreadNotifications,
    urgentCount: inbox.urgentCount,
    onlinePeers: inbox.onlinePeers,
    ...(inbox.notifications.length > 0 ? { notifications: inbox.notifications.map(compactNotification) } : {}),
    ...(hasTasks
      ? {
          tasks: {
            ...(assigned.length > 0 ? { assigned } : {}),
            ...(ready.length > 0 ? { ready } : {}),
          },
        }
      : {}),
    ...(inbox.unreadChannels.length > 0 ? { unreadChannels: inbox.unreadChannels } : {}),
    ...(inbox.unreadDms.length > 0 ? { unreadDms: inbox.unreadDms } : {}),
  }
}

export function compactPin(pin: PinView, opts?: CompactOptions): CompactPin {
  return {
    id: pin.id,
    scope: pin.scope,
    channel: pin.channel,
    rootId: pin.rootId,
    thread: pin.thread,
    messageId: pin.messageId,
    pinnedBy: pin.pinnedBy,
    pinnedAt: pin.pinnedAt,
    ...(pin.note !== null ? { note: pin.note } : {}),
    ...(pin.sortOrder !== 0 ? { sortOrder: pin.sortOrder } : {}),
    ...(pin.message !== undefined ? { message: compactMessage(pin.message, opts) } : {}),
  }
}

export function compactPresence(p: PresenceView): CompactPresence {
  return {
    agent: p.agent,
    handle: p.handle,
    status: p.status,
    ...(p.profile !== null ? { profile: p.profile } : {}),
    ...(p.harness !== null ? { harness: p.harness } : {}),
    ...(p.model !== null ? { model: p.model } : {}),
    ...(p.channel !== null ? { channel: p.channel } : {}),
    ...(p.taskId !== null ? { taskId: p.taskId } : {}),
    ...(p.note !== null ? { note: p.note } : {}),
    updatedAt: p.updatedAt,
    expiresAt: p.expiresAt,
  }
}

export function compactGroup(g: GroupView): CompactGroup {
  return {
    handle: g.handle,
    name: g.name,
    kind: g.kind,
    ...(g.description !== '' ? { description: g.description } : {}),
    ...(g.channel !== null ? { channel: g.channel } : {}),
    ...(g.members.length > 0
      ? { members: g.members.map((m) => ({ memberId: m.memberId, role: m.role })) }
      : {}),
    byActor: g.byActor,
    updatedAt: g.updatedAt,
  }
}

export function compactEvent(ev: BoardEventView, opts?: CompactOptions): Record<string, unknown> {
  const payload = stripEmpty(ev.payload)
  return {
    cursor: ev.cursor,
    type: ev.type,
    createdAt: ev.createdAt,
    ...(Object.keys(payload).length > 0 ? { payload } : {}),
    ...(ev.message !== undefined ? { message: compactMessage(ev.message, opts) } : {}),
    ...(ev.actor !== undefined ? { actor: stripEmpty({ ...ev.actor }) } : {}),
  }
}

// ---- Ultra-terse single-line-per-item agent text formatters (CLI --compact & hook-rewake)

function actorTag(actorId: string, handle?: string | null): string {
  if (handle && handle.length > 0) return `@${handle}`
  const plus = actorId.lastIndexOf('+')
  if (plus !== -1 && plus + 1 < actorId.length) return `@${actorId.slice(plus + 1)}`
  const colon = actorId.lastIndexOf(':')
  if (colon !== -1 && colon + 1 < actorId.length) return `@${actorId.slice(colon + 1)}`
  return `@${actorId}`
}

/** Single-line summary for a message (e.g. `#12 [dev] @agy: Hello world`). */
export function formatMessageLine(msg: MessageView, maxChars = DEFAULT_EXCERPT_CHARS): string {
  const tags: string[] = []
  if (msg.task) tags.push(`task:${msg.task.state}`)
  if (msg.labels['flag.status']) tags.push(`flag:${msg.labels['flag.status']}`)
  if (msg.quote) tags.push(`quote:#${msg.quote.id}`)
  if (msg.deleted) tags.push('deleted')
  const tagStr = tags.length > 0 ? ` [${tags.join(' ')}]` : ''
  const who = actorTag(msg.by.actor, msg.author?.handle)
  const body = msg.deleted ? '(deleted)' : excerptLine(msg.text, maxChars)
  return `#${msg.id} [${msg.channel}] ${who}${tagStr}: ${body}`
}

/** Single-line summary for a thread list item (includes pin badge, reply count, and latestReply). */
export function formatThreadLine(summary: ThreadSummaryView, maxChars = DEFAULT_EXCERPT_CHARS): string {
  const prefix =
    summary.pin?.scope === 'announcement'
      ? '[ANN] '
      : summary.pin?.scope === 'channel'
        ? '[PIN] '
        : ''
  const base = formatMessageLine(summary.message, maxChars)
  if (summary.replies === 0) return `${prefix}${base}`
  const last = summary.last
  if (last) {
    const lastWho = actorTag(last.by.actor, last.author?.handle)
    const lastBody = excerptLine(last.text, 80)
    return `${prefix}${base} (${summary.replies}r; last ${lastWho}: ${lastBody})`
  }
  return `${prefix}${base} (${summary.replies}r)`
}

/** Single-line summary for a notification. */
export function formatNotificationLine(n: NotificationView, maxChars = DEFAULT_EXCERPT_CHARS): string {
  const urgent = n.priority === 'urgent' ? '[URGENT]' : ''
  const group = n.sourceGroup ? `@${n.sourceGroup}:` : ''
  const who = actorTag(n.byActor, n.byHandle)
  return `n#${n.id} ${urgent}[${n.reason}] ${group}[${n.channel}] #${n.messageId} ${who}: ${excerptLine(n.excerpt, maxChars)}`
}

/** Single-line summary for a task (`ThreadSummaryView` or `CompactTaskDigest`). */
export function formatTaskLine(task: ThreadSummaryView | CompactTaskDigest, maxChars = DEFAULT_EXCERPT_CHARS): string {
  if ('message' in task) {
    const state = task.message.task?.state ?? 'ready'
    const assignee = task.message.task?.for ? ` for=${actorTag(task.message.task.for)}` : ''
    const base = `[${state}] #${task.message.id} [${task.message.channel}]${assignee}: ${excerptLine(task.message.text, maxChars)}`
    if (task.replies > 0 && task.last) {
      const who = actorTag(task.last.by.actor, task.last.author?.handle)
      return `${base} (${task.replies}r; last ${who}: ${excerptLine(task.last.text, 80)})`
    }
    return task.replies > 0 ? `${base} (${task.replies}r)` : base
  }
  const assignee = task.for ? ` for=${actorTag(task.for)}` : ''
  const base = `[${task.state}] #${task.id} [${task.channel}]${assignee}: ${excerptLine(task.text, maxChars)}`
  if (task.replies > 0 && task.latestReply) {
    const who = actorTag(task.latestReply.by, task.latestReply.handle)
    return `${base} (${task.replies}r; last ${who}: ${excerptLine(task.latestReply.excerpt, 80)})`
  }
  return task.replies > 0 ? `${base} (${task.replies}r)` : base
}

/** Single-line summary for an online/presence entry. */
export function formatPresenceLine(p: PresenceView): string {
  const meta = [p.harness, p.model].filter(Boolean).join('/')
  const where = p.channel ? ` #${p.channel}` : ''
  const task = p.taskId ? ` task:#${p.taskId}` : ''
  const note = p.note ? ` — ${excerptLine(p.note, 80)}` : ''
  return `[${p.status}] @${p.handle}${meta ? ` (${meta})` : ''}${where}${task}${note}`
}

/** Renders a channel tree as compact indented lines. */
export function formatChannelTreeLines(tree: readonly ChannelTreeNode[], indent = 0): string[] {
  const lines: string[] = []
  const pad = '  '.repeat(indent)
  for (const node of tree) {
    const counts: string[] = []
    if (node.unreadCount > 0) counts.push(`${node.unreadCount} unread`)
    if (node.channel?.messages) counts.push(`${node.channel.messages} msgs`)
    else if (node.virtual && node.totalMessages > 0) counts.push(`${node.totalMessages} msgs`)
    const meta = counts.length > 0 ? ` (${counts.join(', ')})` : ''
    if (node.virtual) {
      lines.push(`${pad}${node.segment}/${meta}`)
    } else {
      const priv = node.channel?.private ? ' [private]' : ''
      const kind = node.channel?.kind ? ` [${node.channel.kind}]` : ''
      lines.push(`${pad}#${node.segment}${kind}${priv}${meta}`)
    }
    if (node.children.length > 0) {
      lines.push(...formatChannelTreeLines(node.children, indent + 1))
    }
  }
  return lines
}

/** Ultra-compact multi-line digest for `agentInbox` (ideal for start-of-turn CLI/hook output). */
export function formatInboxDigest(inbox: AgentInboxView): string {
  const lines: string[] = [
    `inbox ${actorTag(inbox.actor, inbox.profile)} cursor=${inbox.cursor} unread=${inbox.unreadNotifications} urgent=${inbox.urgentCount} online=${inbox.onlinePeers}`,
  ]
  if (inbox.notifications.length > 0) {
    lines.push('notifications:')
    for (const n of inbox.notifications) lines.push(`  ${formatNotificationLine(n, 120)}`)
  }
  if (inbox.tasks.assigned.length > 0) {
    lines.push('tasks.assigned:')
    for (const t of inbox.tasks.assigned) lines.push(`  ${formatTaskLine(t, 120)}`)
  }
  if (inbox.tasks.ready.length > 0) {
    lines.push('tasks.ready:')
    for (const t of inbox.tasks.ready) lines.push(`  ${formatTaskLine(t, 120)}`)
  }
  if (inbox.unreadDms.length > 0) {
    lines.push('unread.dms:')
    for (const dm of inbox.unreadDms) {
      lines.push(`  ${dm.channel} (@${dm.peer}, ${dm.unread} unread): ${excerptLine(dm.lastExcerpt, 100)}`)
    }
  }
  if (inbox.unreadChannels.length > 0) {
    lines.push('unread.channels:')
    for (const ch of inbox.unreadChannels) {
      lines.push(`  #${ch.channel} [${ch.kind}] (${ch.unread} unread)`)
    }
  }
  return lines.join('\n')
}
