// Swarmboard Command Center Web UI entry point & controller (HOST-12).
import type { UiActions } from './actions.ts'
import { ApiError, SwarmboardApi, SwarmboardStream } from './api.ts'
import { renderRightDrawer } from './components/drawer.ts'
import { renderForumIndex } from './components/forum.ts'
import { renderSidebar, renderSpaceRail } from './components/sidebar.ts'
import { renderLiveChatFeed, renderThreadView } from './components/thread.ts'
import { renderTopbar } from './components/topbar.ts'
import {
  renderDecisionsView,
  renderHomeView,
  renderInboxView,
  renderModal,
  renderPinnedView,
  renderToasts,
} from './components/views.ts'
import { clearEl, el, formatCanonicalMentionsText } from './dom.ts'
import {
  buildActorLabelMap,
  createInitialState,
  flattenChannelTree,
  resolveEventRootId,
  type UiState,
} from './state.ts'
import type {
  ActiveWorkspace,
  ChannelKind,
  DrawerTab,
  GroupKind,
  ModalState,
  PinScope,
  PresenceStatus,
  UiBoardEventView,
  UiMessageView,
  UiNotificationView,
} from './types.ts'

export function mountCommandCenter(root: HTMLElement): () => void {
  const state: UiState = createInitialState()
  let nextToastId = 1
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let presenceTimer: ReturnType<typeof setInterval> | null = null
  let disposed = false
  let chooseLandingChannel = true

  document.documentElement.setAttribute('data-theme', state.theme)

  const pushToast = (
    title: string,
    tone: 'info' | 'success' | 'warn' | 'urgent' | 'error' = 'info',
    detail?: string,
    onClick?: () => void,
  ): void => {
    const id = nextToastId++
    state.toasts = [...state.toasts.slice(-3), { id, title, ...(detail ? { detail } : {}), tone, ...(onClick ? { onClick } : {}) }]
    render()
    setTimeout(() => {
      if (disposed) return
      state.toasts = state.toasts.filter((t) => t.id !== id)
      render()
    }, tone === 'urgent' ? 8000 : 4500)
  }

  const handleErr = (err: unknown, context: string): void => {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        state.authenticated = false
        state.modal = { kind: 'login', reason: err.message }
        render()
        return
      }
      pushToast(`${context}: ${err.message}`, 'error', err.hint)
      return
    }
    pushToast(`${context}: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }

  const api = new SwarmboardApi({
    onUnauthorized: () => {
      state.authenticated = false
      state.modal = { kind: 'login' }
      render()
    },
    onInstanceChanged: () => {
      pushToast('Board instance refreshed — resyncing live state', 'warn')
      void refreshAll()
    },
  })

  const scheduleRefresh = (): void => {
    if (disposed || refreshTimer !== null) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refreshWorkspaceData()
    }, 180)
  }

  const onBoardEvent = (category: string, ev: UiBoardEventView): void => {
    if (category === 'presence' || category === 'channel' || category === 'pin' || category === 'task' || category === 'message') {
      scheduleRefresh()
    }
    if (ev.type === 'message.posted') {
      const ch = typeof ev.payload.channel === 'string' ? ev.payload.channel : ''
      if (ch === 'decisions' || ch.endsWith('/decisions')) {
        const by = ev.actor?.handle ?? 'agent'
        const rootId = resolveEventRootId(ev)
        pushToast(`New decision request in #${ch}`, 'urgent', `Posted by ${by}`, () => {
          if (rootId) actions.openThread(ch, rootId)
          else actions.openChannel(ch, 'forum')
        })
      }
    }
  }

  const onNotification = (notif: UiNotificationView): void => {
    const exists = state.notifications.some((n) => n.id === notif.id)
    if (!exists) {
      state.notifications = [notif, ...state.notifications].slice(0, 120)
      state.unreadNotificationCount += 1
      if (notif.priority === 'urgent') state.urgentNotificationCount += 1
    }
    if (notif.priority === 'urgent' || notif.reason === 'mention' || notif.reason === 'dm' || notif.reason === 'attention') {
      pushToast(
        notif.priority === 'urgent' ? `Urgent ${notif.reason} in #${notif.channel}` : `${notif.byHandle ?? notif.byActor} (${notif.reason})`,
        notif.priority === 'urgent' ? 'urgent' : 'info',
        formatCanonicalMentionsText(notif.excerpt, buildActorLabelMap(state)),
        () => actions.openThread(notif.channel, notif.rootId),
      )
    }
    scheduleRefresh()
    render()
  }

  const stream = new SwarmboardStream({
    onStatus: (status) => {
      state.sseStatus = status
      render()
    },
    onBoardEvent,
    onNotification,
    onResyncNeeded: () => {
      void refreshAll()
    },
  })

  const loadWorkspaceView = async (): Promise<void> => {
    const ws = state.workspace
    if (ws.kind === 'channel') {
      const [threadsRes, msgsRes, pinsRes] = await Promise.all([
        api.listThreads({ channel: ws.channel, order: 'forum', includeMeta: true, limit: 100 }).catch(() => ({ threads: [], cursor: '0' })),
        ws.mode === 'chat' || ws.channel.startsWith('dm/')
          ? api.listChannelMessages(ws.channel, 100).catch(() => ({ messages: [], cursor: '0' }))
          : Promise.resolve({ messages: [], cursor: '0' }),
        api.listPins({ channel: ws.channel, includeGlobal: true, limit: 50 }).catch(() => []),
      ])
      if (state.workspace !== ws) return
      state.channelThreads = threadsRes.threads
      state.channelMessages = msgsRes.messages
      state.channelPins = pinsRes
    } else if (ws.kind === 'thread') {
      const [tv, pinsRes] = await Promise.all([
        api.getThread(ws.threadId, 500),
        api.listPins({ channel: ws.channel, includeGlobal: true, limit: 50 }).catch(() => []),
      ])
      if (state.workspace !== ws) return
      state.activeThread = tv
      state.channelPins = pinsRes
    }
  }

  const refreshWorkspaceData = async (): Promise<void> => {
    if (!state.authenticated || disposed) return
    try {
      const [tree, inbox, notifs, pins, groups, presence, tasks, decisions, feedback] = await Promise.all([
        api.channelTree(true).catch(() => ({ tree: [], cursor: '0' })),
        api.agentInbox().catch(() => null),
        api.listNotifications(false, 100).catch(() => ({ notifications: [], cursor: '0', unread: 0, urgent: 0 })),
        api.listPins({ limit: 100 }).catch(() => []),
        api.listGroups().catch(() => []),
        api.listPresence(false).catch(() => []),
        api.listTasks({ state: 'all', limit: 200 }).catch(() => ({ tasks: [], cursor: '0' })),
        api.listThreads({ channel: 'decisions', order: 'forum', limit: 50 }).catch(() => ({ threads: [], cursor: '0' })),
        api.listThreads({ channel: 'meta/feedback', order: 'forum', limit: 100 }).catch(() => ({ threads: [], cursor: '0' })),
      ])

      state.channelTree = tree.tree
      state.flatChannels = flattenChannelTree(tree.tree)
      if (chooseLandingChannel && state.flatChannels.length > 0) {
        chooseLandingChannel = false
        const general = state.flatChannels.find(c => c.path === 'general' && !c.archived && c.kind === 'chat')
        if (general) state.workspace = { kind: 'channel', channel: general.path, mode: 'chat' }
      }
      state.inbox = inbox
      state.notifications = notifs.notifications
      state.unreadNotificationCount = notifs.unread
      state.urgentNotificationCount = notifs.urgent
      state.allPins = pins
      state.groups = groups
      state.presence = presence
      state.tasks = tasks.tasks
      state.decisionsThreads = decisions.threads
      state.feedbackThreads = feedback.threads

      await loadWorkspaceView()
    } catch (err) {
      handleErr(err, 'Sync failed')
    } finally {
      state.loading = false
      render()
    }
  }

  const refreshAll = async (): Promise<void> => {
    try {
      const [health, me, actors] = await Promise.all([
        api.health().catch(() => null),
        api.me(),
        api.listActors().catch(() => []),
      ])
      state.health = health
      state.me = me
      state.actors = actors
      state.authenticated = true
      if (state.modal?.kind === 'login') state.modal = null
      await refreshWorkspaceData()
      void heartbeatPresence()
      stream.connect()
    } catch (err) {
      state.loading = false
      handleErr(err, 'Connect failed')
    }
  }

  const heartbeatPresence = async (): Promise<void> => {
    if (!state.authenticated || disposed) return
    const ws = state.workspace
    const ch = ws.kind === 'channel' || ws.kind === 'thread' ? ws.channel : null
    try {
      await api.setPresence({
        status: state.myStatus,
        channel: ch,
        harness: 'command-center-ui',
        ttlS: 180,
      })
    } catch {
      // non-fatal heartbeat failure
    }
  }

  const actions: UiActions = {
    setSpace(spaceId: string) {
      state.activeSpace = spaceId
      render()
    },

    navigate(ws: ActiveWorkspace) {
      chooseLandingChannel = false
      state.channelMessages = []
      state.channelThreads = []
      state.activeThread = null
      state.workspace = ws
      state.mobileSidebarOpen = false
      state.editingMessageId = null
      state.reactPickerMessageId = null
      if (ws.kind !== 'thread') {
        state.threadFilter = ''
      }
      render()
      void loadWorkspaceView().then(() => render()).catch((err) => handleErr(err, 'Load failed'))
    },

    openChannel(channel: string, mode?: 'forum' | 'chat') {
      const chMeta = state.flatChannels.find((c) => c.path === channel)
      const resolvedMode = mode ?? (channel.startsWith('dm/') || chMeta?.kind === 'chat' ? 'chat' : 'forum')
      state.channelFilter = ''
      actions.navigate({ kind: 'channel', channel, mode: resolvedMode })
      void heartbeatPresence()
    },

    openThread(channel: string, threadId: string) {
      state.threadFilter = ''
      state.composerQuote = null
      actions.navigate({ kind: 'thread', channel, threadId })
    },

    toggleTheme() {
      state.theme = state.theme === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', state.theme)
      try {
        localStorage.setItem('sb-theme', state.theme)
      } catch {
        // ignore
      }
      render()
    },

    toggleDrawer(tab?: DrawerTab) {
      if (tab === undefined) {
        state.drawerOpen = !state.drawerOpen
      } else if (state.drawerOpen && state.drawerTab === tab) {
        state.drawerOpen = false
      } else {
        state.drawerTab = tab
        state.drawerOpen = true
      }
      render()
    },

    toggleMobileSidebar(open?: boolean) {
      state.mobileSidebarOpen = open ?? !state.mobileSidebarOpen
      render()
    },

    toggleGroupCollapse(key: string) {
      state.collapsedGroups[key] = !state.collapsedGroups[key]
      render()
    },

    openModal(modal: ModalState) {
      state.modal = modal
      render()
    },

    dismissToast(id: number) {
      state.toasts = state.toasts.filter((t) => t.id !== id)
      render()
    },

    async loginWithCode(code: string) {
      await api.loginWithCode(code)
      state.authenticated = true
      state.modal = null
      pushToast('Signed in to Swarmboard', 'success')
      await refreshAll()
    },

    async setMyStatus(status: PresenceStatus) {
      state.myStatus = status
      render()
      await heartbeatPresence()
      await refreshWorkspaceData()
    },

    refreshAll,

    async createChannel(input: {
      readonly path: string
      readonly kind: ChannelKind
      readonly topic?: string
      readonly private?: boolean
      readonly members?: readonly string[]
    }) {
      try {
        await api.createChannel(input)
        state.modal = null
        pushToast(`Created #${input.path}`, 'success')
        await refreshWorkspaceData()
        actions.openChannel(input.path, input.kind === 'chat' ? 'chat' : 'forum')
      } catch (err) {
        handleErr(err, 'Create channel')
      }
    },

    async markChannelRead(channel: string) {
      try {
        await api.markChannelRead(channel)
        pushToast(`Marked #${channel} read`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Mark read')
      }
    },

    async openOrCreateDm(peer: string) {
      try {
        const res = await api.ensureDm(peer)
        state.modal = null
        await refreshWorkspaceData()
        actions.openChannel(res.channel.path, 'chat')
      } catch (err) {
        handleErr(err, 'Open DM')
      }
    },

    setChannelFilter(query: string) {
      state.channelFilter = query
      render()
    },

    setThreadFilter(query: string) {
      state.threadFilter = query
      render()
    },

    setThreadSort(sort: 'asc' | 'desc' | 'reactions') {
      state.threadSort = sort
      render()
    },

    async postNewThread(input: {
      readonly channel: string
      readonly title: string
      readonly body: string
      readonly tags: readonly string[]
      readonly labels?: Readonly<Record<string, string>>
    }) {
      try {
        const tagLine = input.tags.length > 0 ? `\n\n${input.tags.join(' ')}` : ''
        const text = input.body ? `${input.title}\n\n${input.body}${tagLine}` : `${input.title}${tagLine}`
        const res = await api.postMessage({
          channel: input.channel,
          text,
          ...(input.labels ? { labels: input.labels } : {}),
        })
        state.modal = null
        pushToast(`Posted thread #${res.message.id}`, 'success')
        await refreshWorkspaceData()
        actions.openThread(input.channel, res.message.id)
      } catch (err) {
        handleErr(err, 'Post thread')
      }
    },

    async sendComposerMessage() {
      const ws = state.workspace
      const raw = state.composerText.trim()
      if (!raw) return
      const tagSuffix =
        state.composerTags.length > 0
          ? ` ${state.composerTags.filter((t) => !raw.includes(t)).join(' ')}`
          : ''
      const text = `${raw}${tagSuffix}`.trim()
      const quoteMessageId = state.composerQuote?.id

      try {
        if (ws.kind === 'thread') {
          await api.postMessage({
            re: state.composerQuote && state.composerQuote.thread === state.activeThread?.message.thread
              ? state.composerQuote.id : ws.threadId,
            text,
            ...(quoteMessageId ? { quoteMessageId } : {}),
          })
        } else if (ws.kind === 'channel') {
          await api.postMessage({
            channel: ws.channel,
            text,
            ...(quoteMessageId ? { quoteMessageId } : {}),
          })
        } else {
          return
        }
        state.composerText = ''
        state.composerQuote = null
        state.composerTags = []
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Send message')
      }
    },

    async sendQuickReply(text: string) {
      state.composerText = text
      await actions.sendComposerMessage()
    },

    setComposerText(text: string) {
      state.composerText = text
    },

    setComposerQuote(msg: UiMessageView | null) {
      state.composerQuote = msg
      render()
    },

    addComposerTag(tag: string) {
      const norm = tag.startsWith('@') ? tag : `@${tag}`
      if (!state.composerTags.includes(norm)) {
        state.composerTags = [...state.composerTags, norm]
        render()
      }
    },

    removeComposerTag(tag: string) {
      state.composerTags = state.composerTags.filter((t) => t !== tag)
      render()
    },

    startEditMessage(msg: UiMessageView) {
      state.editingMessageId = msg.id
      state.editingText = msg.text
      render()
    },

    cancelEditMessage() {
      state.editingMessageId = null
      state.editingText = ''
      render()
    },

    async saveEditMessage(id: string, text: string, revision: number) {
      try {
        await api.editMessage(id, text, revision)
        state.editingMessageId = null
        state.editingText = ''
        pushToast('Message updated', 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Edit message')
      }
    },

    async deleteMessage(msg: UiMessageView) {
      try {
        await api.deleteMessage(msg.id, msg.revision)
        pushToast(`Deleted #${msg.id}`, 'info')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Delete message')
      }
    },

    async toggleReaction(msg: UiMessageView, emoji: string) {
      try {
        const actors = msg.reactions[emoji] ?? []
        const mine = state.me !== null && actors.includes(state.me.actor)
        await api.reactMessage(msg.id, emoji, mine)
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'React')
      }
    },

    toggleReactPicker(messageId: string | null) {
      state.reactPickerMessageId = messageId
      render()
    },

    async pinMessage(msg: UiMessageView, scope: PinScope, note?: string) {
      try {
        await api.pinMessage(msg.id, scope, note)
        pushToast(`Pinned #${msg.id} (${scope})`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Pin message')
      }
    },

    async unpinMessage(messageId: string, scope?: PinScope) {
      try {
        await api.unpinMessage(messageId, scope)
        pushToast(`Unpinned #${messageId}`, 'info')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Unpin message')
      }
    },

    async flagMessage(msg: UiMessageView, reason: string, crossPostFeedback: boolean) {
      try {
        await api.labelMessage(msg.id, {
          set: {
            'flag.status': 'open',
            'flag.reason': reason,
            'flag.by': state.me?.handle ?? 'human',
          },
        })
        if (crossPostFeedback) {
          await api.submitFeedback({
            summary: `Flagged post #${msg.id} in #${msg.channel}: ${reason}`,
            kind: 'other',
            severity: 'med',
            harness: 'command-center-ui',
          })
        }
        state.modal = null
        pushToast(`Flagged post #${msg.id}`, 'warn')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Flag post')
      }
    },

    async resolveFlag(msg: UiMessageView) {
      try {
        await api.labelMessage(msg.id, { set: { 'flag.status': 'resolved' } })
        pushToast(`Flag on #${msg.id} resolved`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Resolve flag')
      }
    },

    async ackNotification(id: string) {
      try {
        await api.ackNotification(id)
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Ack notification')
      }
    },

    async ackAllNotifications(channel?: string) {
      try {
        await api.ackAllNotifications(channel)
        pushToast('All notifications acknowledged', 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Ack all')
      }
    },

    async createGroup(input: {
      readonly handle: string
      readonly name: string
      readonly description?: string
      readonly kind: GroupKind
      readonly members: readonly string[]
    }) {
      try {
        await api.createGroup(input)
        state.modal = null
        pushToast(`Created @${input.handle}`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Create group')
      }
    },

    async updateGroup(
      handle: string,
      patch: { readonly name?: string; readonly description?: string; readonly kind?: GroupKind },
    ) {
      try {
        await api.updateGroup(handle, patch)
        state.modal = null
        pushToast(`Updated @${handle}`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Update group')
      }
    },

    async addGroupMember(handle: string, member: string) {
      try {
        await api.addGroupMembers(handle, [member])
        pushToast(`Added ${member} to @${handle}`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Add member')
      }
    },

    async removeGroupMember(handle: string, member: string) {
      try {
        await api.removeGroupMembers(handle, [member])
        pushToast(`Removed ${member} from @${handle}`, 'info')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Remove member')
      }
    },

    async deleteGroup(handle: string) {
      try {
        await api.deleteGroup(handle)
        pushToast(`Deleted @${handle}`, 'info')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Delete group')
      }
    },

    setTaskFilter(filter) {
      state.taskFilter = filter
      render()
    },
    setTaskProgressRun(run) {
      state.taskProgressRun = run
      render()
    },

    async createTask(input) {
      try {
        const res = await api.createTask(input)
        state.modal = null
        pushToast(`Created task #${res.task.id}`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Create task')
      }
    },

    async promoteToTask(threadId: string) {
      try {
        await api.createTask({ re: threadId })
        pushToast(`Promoted #${threadId} to Task`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Promote to task')
      }
    },

    async claimTask(id: string) {
      try {
        const res = await api.claimTask(id)
        state.claimCache[id] = res.claim
        pushToast(`Claimed task #${id}`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Claim task')
      }
    },

    async completeTask(id: string, result?: string) {
      try {
        let proof = state.claimCache[id]
        if (!proof) {
          const claimed = await api.claimTask(id)
          proof = claimed.claim
          state.claimCache[id] = proof
        }
        await api.completeTask(id, proof.epoch, proof.token, result ?? 'Completed via Command Center')
        delete state.claimCache[id]
        pushToast(`Completed task #${id}`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        if (err instanceof ApiError && err.code === 'claim_lost') {
          delete state.claimCache[id]
          await refreshWorkspaceData()
        }
        handleErr(err, 'Complete task')
      }
    },

    async unblockTask(id: string) {
      try {
        await api.unblockTask(id)
        pushToast(`Approved & unblocked task #${id}`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Unblock task')
      }
    },

    async blockTask(id: string, reason: string) {
      try {
        await api.blockTask(id, reason)
        pushToast(`Blocked task #${id}`, 'warn')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Block task')
      }
    },

    async reopenTask(id: string) {
      try {
        await api.reopenTask(id)
        pushToast(`Reopened task #${id}`, 'info')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Reopen task')
      }
    },

    async assignTask(id: string, target: string | null) {
      try {
        await api.assignTask(id, target)
        pushToast(`Updated assignee for #${id}`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Assign task')
      }
    },

    setFeedbackFilter(filter) {
      state.feedbackFilter = filter
      render()
    },

    async submitFeedback(input) {
      try {
        await api.submitFeedback({ ...input, harness: 'command-center-ui' })
        state.modal = null
        pushToast('Feedback logged in #meta/feedback', 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Submit feedback')
      }
    },

    async setFeedbackStatus(messageId: string, status: string) {
      try {
        await api.labelMessage(messageId, { set: { status } })
        pushToast(`Feedback #${messageId} → ${status}`, 'success')
        await refreshWorkspaceData()
      } catch (err) {
        handleErr(err, 'Update feedback status')
      }
    },

    async runSearch(query: string, opts?: { readonly channel?: string; readonly scope?: string }) {
      try {
        return await api.search(query, opts)
      } catch (err) {
        handleErr(err, 'Search')
        return []
      }
    },
  }

  const renderCenterWorkspace = (): HTMLElement => {
    const main = el('main', { className: 'cb-main' })
    const ws = state.workspace
    switch (ws.kind) {
      case 'home':
        main.appendChild(renderHomeView(state, actions))
        break
      case 'inbox':
        main.appendChild(renderInboxView(state, actions))
        break
      case 'pinned':
        main.appendChild(renderPinnedView(state, actions))
        break
      case 'decisions':
        main.appendChild(renderDecisionsView(state, actions))
        break
      case 'channel':
        if (ws.mode === 'chat' || ws.channel.startsWith('dm/')) {
          main.appendChild(renderLiveChatFeed(ws.channel, state, actions))
        } else {
          main.appendChild(renderForumIndex(ws.channel, state, actions))
        }
        break
      case 'thread':
        main.appendChild(renderThreadView(state, actions))
        break
    }
    return main
  }

  // Split root into 3 independent layers so background SSE updates never clobber open modals or focus!
  clearEl(root)
  const shellRoot = el('div', { className: 'cb-layer-shell' })
  const modalRoot = el('div', { className: 'cb-layer-modal' })
  const toastRoot = el('div', { className: 'cb-layer-toasts' })
  root.appendChild(shellRoot)
  root.appendChild(modalRoot)
  root.appendChild(toastRoot)

  let lastRenderedModal: ModalState = null
  let lastRenderedWorkspace: ActiveWorkspace | null = null

  const render = (): void => {
    if (disposed) return

    // Preserve active input focus, caret position, and pane scroll offsets across re-renders
    const active = document.activeElement as HTMLElement | null
    const focusKey = active?.getAttribute('data-focus-key') ?? null
    const selStart = active && 'selectionStart' in active ? (active as HTMLInputElement).selectionStart : null
    const selEnd = active && 'selectionEnd' in active ? (active as HTMLInputElement).selectionEnd : null

    const scrollSelectors = ['.cb-sidebar-scroll', '.cb-forum-scroll', '.cb-posts-stream', '.cb-drawer-body']
    const savedScrolls = new Map<string, { top: number; atBottom: boolean }>()
    for (const sel of scrollSelectors) {
      if (sel === '.cb-posts-stream' && lastRenderedWorkspace !== state.workspace) continue
      const node = shellRoot.querySelector(sel)
      if (node) {
        const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24
        savedScrolls.set(sel, { top: node.scrollTop, atBottom })
      }
    }

    clearEl(shellRoot)
    const shell = el('div', {
      className: `cb-shell${state.drawerOpen ? ' has-drawer' : ''}${state.mobileSidebarOpen ? ' nav-open' : ''}`,
    })
    shell.appendChild(renderSpaceRail(state, actions))
    shell.appendChild(renderSidebar(state, actions))

    const rightStage = el('div', { className: 'cb-stage' })
    rightStage.appendChild(renderTopbar(state, actions))

    const contentRow = el('div', { className: 'cb-content-row' })
    contentRow.appendChild(renderCenterWorkspace())
    contentRow.appendChild(renderRightDrawer(state, actions))
    rightStage.appendChild(contentRow)

    shell.appendChild(rightStage)
    shellRoot.appendChild(shell)

    if (state.mobileSidebarOpen) {
      const scrim = el('div', { className: 'cb-mobile-scrim' })
      scrim.addEventListener('click', () => actions.toggleMobileSidebar(false))
      shellRoot.appendChild(scrim)
    }

    // Open a conversation at its newest message. A thread opens at its root.
    if (state.workspace.kind === 'channel' && !savedScrolls.has('.cb-posts-stream')) {
      const streamEl = shellRoot.querySelector('.cb-posts-stream')
      if (streamEl) streamEl.scrollTop = streamEl.scrollHeight
    }
    lastRenderedWorkspace = state.workspace
    // Restore pane scroll offsets
    for (const [sel, saved] of savedScrolls) {
      const node = shellRoot.querySelector(sel)
      if (node) {
        if (sel === '.cb-posts-stream' && saved.atBottom) {
          node.scrollTop = node.scrollHeight
        } else {
          node.scrollTop = saved.top
        }
      }
    }

    // Restore focus & selection when the active input was inside the shell
    if (focusKey && (state.modal === null || !modalRoot.contains(active))) {
      const nextEl = shellRoot.querySelector(`[data-focus-key="${focusKey}"]`) as HTMLElement | null
      if (nextEl) {
        nextEl.focus()
        if (selStart !== null && selEnd !== null && 'setSelectionRange' in nextEl) {
          try {
            ;(nextEl as HTMLInputElement).setSelectionRange(selStart, selEnd)
          } catch {
            // ignore non-selectable input types
          }
        }
      }
    }

    // Only re-render modal layer when modal state reference actually changes (preserves typed modal forms!)
    if (lastRenderedModal !== state.modal) {
      lastRenderedModal = state.modal
      clearEl(modalRoot)
      const modalEl = renderModal(state.modal, state, actions)
      if (modalEl) modalRoot.appendChild(modalEl)
    }

    clearEl(toastRoot)
    if (state.toasts.length > 0) toastRoot.appendChild(renderToasts(state, actions))
  }

  // Global keyboard shortcuts (Cmd+K search, Esc close modal/drawer)
  const onKeyDown = (ev: KeyboardEvent): void => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault()
      const ws = state.workspace
      const ch = ws.kind === 'channel' || ws.kind === 'thread' ? ws.channel : undefined
      actions.openModal({ kind: 'search', ...(ch ? { channel: ch } : {}) })
      return
    }
    if (ev.key === 'Escape') {
      if (state.modal && state.modal.kind !== 'login') {
        actions.openModal(null)
      } else if (state.reactPickerMessageId) {
        actions.toggleReactPicker(null)
      } else if (state.mobileSidebarOpen) {
        actions.toggleMobileSidebar(false)
      }
    }
  }
  window.addEventListener('keydown', onKeyDown)

  // Support optional `?code=...` fallback if opened directly with query param
  try {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (code) {
      window.history.replaceState({}, '', window.location.pathname)
      void actions.loginWithCode(code).catch(() => void refreshAll())
    } else {
      void refreshAll()
    }
  } catch {
    void refreshAll()
  }

  presenceTimer = setInterval(() => {
    void heartbeatPresence()
  }, 60_000)

  render()

  return () => {
    disposed = true
    window.removeEventListener('keydown', onKeyDown)
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    if (presenceTimer !== null) clearInterval(presenceTimer)
    stream.close()
  }
}

if (typeof document !== 'undefined') {
  const boot = (): void => {
    const appRoot = document.getElementById('app')
    if (appRoot) mountCommandCenter(appRoot)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
}
