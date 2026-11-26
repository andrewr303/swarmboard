// Shared TypeScript interfaces for Swarmboard Command Center Web UI (HOST-12).
// Pure type-only module (zero runtime imports or code).

export type ChannelKind = 'chat' | 'forum' | 'tasks' | 'dm' | 'announcements'
export type PresenceStatus = 'active' | 'busy' | 'idle' | 'offline'
export type PinScope = 'thread' | 'channel' | 'announcement'
export type TaskState = 'waiting' | 'ready' | 'claimed' | 'blocked' | 'completed' | 'failed' | 'canceled'
export type GroupKind = 'team' | 'swarm' | 'role' | 'harness' | 'system'
export type NotificationReason =
  | 'mention'
  | 'group_mention'
  | 'dm'
  | 'reply'
  | 'pin'
  | 'task_assigned'
  | 'attention'

export interface UiMeView {
  readonly actor: string
  readonly principal: string
  readonly kind: 'person' | 'agent' | 'deployment' | 'workflow' | 'external'
  readonly handle: string
  readonly name: string
  readonly avatar: string | null
  readonly profile: string | null
  readonly assurance?: 'human_verified' | 'agent_delegated' | 'local_unverified'
  readonly can: Readonly<Record<string, unknown>>
}

export interface UiHealthView {
  readonly ok: boolean
  readonly boardId: string | null
  readonly instanceId: string | null
  readonly schemaVersion: number
  readonly mode: string
  readonly uptimeMs: number
  readonly streams: number
  readonly queueDepth: number
}

export interface UiChannelView {
  readonly path: string
  readonly lastIndex?: number
  readonly messages?: number
  readonly threads?: number
  readonly category?: string | null
  readonly parent?: string | null
  readonly topic?: string | null
  readonly kind?: ChannelKind
  readonly archived?: boolean
  readonly sortOrder?: number
  readonly repo?: string | null
  readonly sessionId?: string | null
  readonly private?: boolean
  readonly pinnedCount?: number
  readonly unreadCount?: number
}

export interface UiChannelTreeNode {
  readonly path: string
  readonly segment: string
  readonly virtual: boolean
  readonly channel: UiChannelView | null
  readonly unreadCount: number
  readonly totalMessages: number
  readonly children: readonly UiChannelTreeNode[]
}

export interface UiChannelTreePage {
  readonly tree: readonly UiChannelTreeNode[]
  readonly cursor: string
}

export interface UiActorView {
  readonly id?: string
  readonly kind: 'person' | 'agent' | 'deployment' | 'workflow' | 'external'
  readonly handle: string
  readonly name: string
  readonly avatar: string | null
  readonly via?: { readonly name: string; readonly environment?: string | null }
  readonly verified?: true
}

export interface UiQuoteView {
  readonly id: string
  readonly channel: string
  readonly by: string
  readonly handle: string | null
  readonly excerpt: string
  readonly createdAt: string
}

export interface UiTaskView {
  readonly state: TaskState
  readonly owner: string
  readonly by: string
  readonly for: string | null
  readonly needs: readonly string[]
  readonly epoch: number
  readonly claim: { readonly actor: string; readonly until: string } | null
  readonly blocked: { readonly kind: string | null; readonly reason: string } | null
  readonly result: string | null
  readonly reason: string | null
}

export interface UiBlockView {
  readonly schema: string
  readonly version: number
  readonly data: Readonly<Record<string, unknown>>
}

export interface UiMessageView {
  readonly id: string
  readonly channel: string
  readonly text: string
  readonly re: string | null
  readonly replyTo: string | null
  readonly thread: string
  readonly labels: Readonly<Record<string, string>>
  readonly reactions: Readonly<Record<string, readonly string[]>>
  readonly by: { readonly actor: string; readonly principal: string; readonly profile: string | null }
  readonly createdAt: string
  readonly editedAt: string | null
  readonly deleted: boolean
  readonly quote?: UiQuoteView
  readonly task?: UiTaskView
  readonly revision: number
  readonly author: UiActorView | null
  readonly blocks: readonly UiBlockView[]
}

export interface UiThreadPinBadge {
  readonly scope: 'announcement' | 'channel'
  readonly note: string | null
  readonly pinnedBy: string
  readonly pinnedAt: string
}

export interface UiThreadSummaryView {
  readonly message: UiMessageView
  readonly replies: number
  readonly last: UiMessageView | null
  readonly pin?: UiThreadPinBadge
  readonly participants?: readonly string[]
}

export interface UiThreadsPage {
  readonly threads: readonly UiThreadSummaryView[]
  readonly cursor: string
  readonly older?: string | null
}

export interface UiMessagesPage {
  readonly messages: readonly UiMessageView[]
  readonly cursor: string
}

export interface UiThreadView {
  readonly message: UiMessageView
  readonly replies: readonly UiMessageView[]
  readonly cursor: string
}

export interface UiTasksPage {
  readonly tasks: readonly UiThreadSummaryView[]
  readonly cursor: string
}

export interface UiPinView {
  readonly id: string
  readonly scope: PinScope
  readonly channel: string
  readonly rootId: string
  readonly thread: string
  readonly messageId: string
  readonly pinnedBy: string
  readonly pinnedAt: string
  readonly note: string | null
  readonly sortOrder: number
  readonly message?: UiMessageView
}

export interface UiGroupMemberView {
  readonly memberId: string
  readonly role: 'member' | 'lead'
  readonly addedBy: string
  readonly addedAt: string
}

export interface UiGroupView {
  readonly handle: string
  readonly name: string
  readonly description: string
  readonly kind: GroupKind
  readonly channel: string | null
  readonly members: readonly UiGroupMemberView[]
  readonly byActor: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface UiPresenceView {
  readonly agent: string
  readonly principal: string
  readonly profile: string | null
  readonly handle: string
  readonly harness: string | null
  readonly model: string | null
  readonly status: PresenceStatus
  readonly channel: string | null
  readonly taskId: string | null
  readonly note: string | null
  readonly updatedAt: string
  readonly expiresAt: string
}

export interface UiNotificationView {
  readonly id: string
  readonly logIndex: number
  readonly recipient: string
  readonly reason: NotificationReason
  readonly priority: 'normal' | 'urgent'
  readonly sourceGroup: string | null
  readonly channel: string
  readonly thread: string
  readonly rootId: string
  readonly messageId: string
  readonly byActor: string
  readonly byHandle: string | null
  readonly excerpt: string
  readonly createdAt: string
  readonly readAt: string | null
  readonly ackedAt: string | null
}

export interface UiNotificationsPage {
  readonly notifications: readonly UiNotificationView[]
  readonly cursor: string
  readonly unread: number
  readonly urgent: number
}

export interface UiCompactTaskDigest {
  readonly id: string
  readonly channel: string
  readonly thread: string
  readonly state: TaskState
  readonly for: string | null
  readonly owner: string
  readonly text: string
  readonly replies: number
  readonly createdAt: string
  readonly latestReply: {
    readonly id: string
    readonly by: string
    readonly handle: string | null
    readonly excerpt: string
    readonly createdAt: string
  } | null
}

export interface UiAgentInboxView {
  readonly actor: string
  readonly profile: string | null
  readonly cursor: string
  readonly unreadNotifications: number
  readonly urgentCount: number
  readonly notifications: readonly UiNotificationView[]
  readonly tasks: {
    readonly assigned: readonly UiCompactTaskDigest[]
    readonly ready: readonly UiCompactTaskDigest[]
  }
  readonly unreadChannels: readonly {
    readonly channel: string
    readonly kind: ChannelKind
    readonly unread: number
    readonly lastIndex: number
  }[]
  readonly unreadDms: readonly {
    readonly channel: string
    readonly peer: string
    readonly unread: number
    readonly lastExcerpt: string
    readonly lastIndex: number
  }[]
  readonly onlinePeers: number
}

export interface UiSearchHit {
  readonly kind: 'message' | 'task' | 'knowledge'
  readonly id: string
  readonly channel: string | null
  readonly thread: string | null
  readonly title: string | null
  readonly snippet: string
  readonly score: number
  readonly createdAt: string
}

export interface UiBoardEventView {
  readonly cursor: string
  readonly type: string
  readonly createdAt: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly message?: UiMessageView
  readonly actor?: UiActorView & { readonly id: string }
}

export type ActiveWorkspace =
  | { readonly kind: 'home' }
  | { readonly kind: 'inbox' }
  | { readonly kind: 'pinned' }
  | { readonly kind: 'decisions' }
  | { readonly kind: 'channel'; readonly channel: string; readonly mode: 'forum' | 'chat' }
  | { readonly kind: 'thread'; readonly channel: string; readonly threadId: string }

export type DrawerTab = 'pins' | 'groups' | 'tasks' | 'feedback'

export type ModalState =
  | null
  | { readonly kind: 'login'; readonly reason?: string }
  | { readonly kind: 'new-channel'; readonly prefix?: string }
  | { readonly kind: 'new-dm' }
  | { readonly kind: 'new-thread'; readonly channel: string }
  | { readonly kind: 'new-group' }
  | { readonly kind: 'edit-group'; readonly group: UiGroupView }
  | { readonly kind: 'search'; readonly initialQuery?: string; readonly channel?: string }
  | { readonly kind: 'flag'; readonly message: UiMessageView }
  | { readonly kind: 'feedback' }
  | { readonly kind: 'new-task'; readonly channel: string }
  | { readonly kind: 'block-task'; readonly taskId: string }

export interface UiToast {
  readonly id: number
  readonly title: string
  readonly detail?: string
  readonly tone: 'info' | 'success' | 'warn' | 'urgent' | 'error'
  readonly onClick?: () => void
}

export interface UiAutocompleteItem {
  readonly kind: 'agent' | 'group' | 'channel' | 'action'
  readonly label: string
  readonly sublabel: string
  readonly insertText: string
  readonly badge?: string
}

export interface UiSpaceItem {
  readonly id: string
  readonly label: string
  readonly monogram: string
  readonly kind: 'global' | 'repo' | 'swarm'
  readonly prefix: string | null
  readonly unread: number
}
