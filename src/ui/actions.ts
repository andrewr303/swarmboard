// Typed UI controller callbacks shared across all Command Center pane components.
import type {
  ActiveWorkspace,
  ChannelKind,
  DrawerTab,
  GroupKind,
  ModalState,
  PinScope,
  PresenceStatus,
  UiMessageView,
} from './types.ts'

export interface UiActions {
  // Navigation & layout
  setSpace(spaceId: string): void
  navigate(ws: ActiveWorkspace): void
  openChannel(channel: string, mode?: 'forum' | 'chat'): void
  openThread(channel: string, threadId: string): void
  toggleTheme(): void
  toggleDrawer(tab?: DrawerTab): void
  toggleMobileSidebar(open?: boolean): void
  toggleGroupCollapse(key: string): void
  openModal(modal: ModalState): void
  dismissToast(id: number): void

  // Auth & presence
  loginWithCode(code: string): Promise<void>
  setMyStatus(status: PresenceStatus): Promise<void>
  refreshAll(): Promise<void>

  // Channels & DMs
  createChannel(input: {
    readonly path: string
    readonly kind: ChannelKind
    readonly topic?: string
    readonly private?: boolean
    readonly members?: readonly string[]
  }): Promise<void>
  markChannelRead(channel: string): Promise<void>
  openOrCreateDm(peer: string): Promise<void>

  // Threads & messages
  setChannelFilter(query: string): void
  setThreadFilter(query: string): void
  setThreadSort(sort: 'asc' | 'desc' | 'reactions'): void
  postNewThread(input: {
    readonly channel: string
    readonly title: string
    readonly body: string
    readonly tags: readonly string[]
    readonly labels?: Readonly<Record<string, string>>
  }): Promise<void>
  sendComposerMessage(): Promise<void>
  sendQuickReply(text: string): Promise<void>
  setComposerText(text: string): void
  setComposerQuote(msg: UiMessageView | null): void
  addComposerTag(tag: string): void
  removeComposerTag(tag: string): void
  startEditMessage(msg: UiMessageView): void
  cancelEditMessage(): void
  saveEditMessage(id: string, text: string, revision: number): Promise<void>
  deleteMessage(msg: UiMessageView): Promise<void>
  toggleReaction(msg: UiMessageView, emoji: string): Promise<void>
  toggleReactPicker(messageId: string | null): void
  pinMessage(msg: UiMessageView, scope: PinScope, note?: string): Promise<void>
  unpinMessage(messageId: string, scope?: PinScope): Promise<void>
  flagMessage(msg: UiMessageView, reason: string, crossPostFeedback: boolean): Promise<void>
  resolveFlag(msg: UiMessageView): Promise<void>

  // Notifications
  ackNotification(id: string): Promise<void>
  ackAllNotifications(channel?: string): Promise<void>

  // Groups
  createGroup(input: {
    readonly handle: string
    readonly name: string
    readonly description?: string
    readonly kind: GroupKind
    readonly members: readonly string[]
  }): Promise<void>
  updateGroup(
    handle: string,
    patch: { readonly name?: string; readonly description?: string; readonly kind?: GroupKind },
  ): Promise<void>
  addGroupMember(handle: string, member: string): Promise<void>
  removeGroupMember(handle: string, member: string): Promise<void>
  deleteGroup(handle: string): Promise<void>

  // Tasks
  setTaskFilter(filter: 'all' | 'open' | 'ready' | 'claimed' | 'blocked' | 'done'): void
  setTaskProgressRun(run: string | null): void
  createTask(input: { readonly channel: string; readonly text: string; readonly for?: string | null; readonly labels?: Readonly<Record<string, string>> }): Promise<void>
  promoteToTask(threadId: string): Promise<void>
  claimTask(id: string): Promise<void>
  completeTask(id: string, result?: string): Promise<void>
  unblockTask(id: string): Promise<void>
  blockTask(id: string, reason: string): Promise<void>
  reopenTask(id: string): Promise<void>
  assignTask(id: string, target: string | null): Promise<void>

  // Feedback
  setFeedbackFilter(filter: 'all' | 'new' | 'triaged' | 'resolved'): void
  submitFeedback(input: {
    readonly summary: string
    readonly kind: string
    readonly severity: string
    readonly repro?: string
    readonly suggestion?: string
  }): Promise<void>
  setFeedbackStatus(messageId: string, status: string): Promise<void>

  // Search
  runSearch(query: string, opts?: { readonly channel?: string; readonly scope?: string }): Promise<import('./types.ts').UiSearchHit[]>
}
