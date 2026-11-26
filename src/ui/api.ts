// Loopback-CSRF-compliant Fetch API client & SSE EventSource manager for Swarmboard Command Center UI.
// Every mutating request sends `Content-Type: application/json` and `credentials: 'same-origin'`.
import type {
  ChannelKind,
  GroupKind,
  PinScope,
  PresenceStatus,
  UiActorView,
  UiAgentInboxView,
  UiBoardEventView,
  UiChannelTreePage,
  UiChannelView,
  UiGroupView,
  UiHealthView,
  UiMessageView,
  UiMessagesPage,
  UiMeView,
  UiNotificationsPage,
  UiNotificationView,
  UiPinView,
  UiPresenceView,
  UiSearchHit,
  UiTasksPage,
  UiThreadsPage,
  UiThreadView,
} from './types.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly hint?: string

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    if (hint !== undefined) this.hint = hint
  }
}

export interface ApiClientHooks {
  readonly onUnauthorized?: () => void
  readonly onInstanceChanged?: (instanceId: string | null) => void
}

export class SwarmboardApi {
  #hooks: ApiClientHooks
  #instanceId: string | null = null

  constructor(hooks: ApiClientHooks = {}) {
    this.#hooks = hooks
  }

  get instanceId(): string | null {
    return this.#instanceId
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const isRead = method === 'GET' || method === 'HEAD'
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (!isRead) {
      headers['Content-Type'] = 'application/json'
    }
    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      headers,
      ...(isRead ? {} : { body: JSON.stringify(body ?? {}) }),
    }
    const res = await fetch(path, init)
    const liveInstance = res.headers.get('x-swarmboard-instance')
    if (liveInstance) {
      if (this.#instanceId !== null && this.#instanceId !== liveInstance) {
        this.#instanceId = liveInstance
        this.#hooks.onInstanceChanged?.(liveInstance)
      } else {
        this.#instanceId = liveInstance
      }
    }

    let data: unknown = null
    const text = await res.text()
    if (text.length > 0) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }

    if (!res.ok) {
      const errObj =
        data !== null && typeof data === 'object' && 'error' in data
          ? (data as { error?: { code?: string; message?: string; hint?: string } }).error
          : undefined
      const code = typeof errObj?.code === 'string' ? errObj.code : `http_${res.status}`
      const msg = typeof errObj?.message === 'string' ? errObj.message : `Request failed (${res.status})`
      const hint = typeof errObj?.hint === 'string' ? errObj.hint : undefined
      if (res.status === 401) {
        this.#hooks.onUnauthorized?.()
      }
      throw new ApiError(res.status, code, msg, hint)
    }
    return data as T
  }

  // ---- Auth & Health
  health(): Promise<UiHealthView> {
    return this.#request<UiHealthView>('GET', '/healthz')
  }

  me(): Promise<UiMeView> {
    return this.#request<UiMeView>('GET', '/api/board/me')
  }

  loginWithCode(code: string): Promise<{ readonly ok: true; readonly expiresAt: string }> {
    return this.#request<{ readonly ok: true; readonly expiresAt: string }>('POST', '/_swarm/v1/login', {
      code: code.trim(),
    })
  }

  // ---- Channels & DMs
  channelTree(includeUnread = true): Promise<UiChannelTreePage> {
    const qs = includeUnread ? '?includeUnread=true' : ''
    return this.#request<UiChannelTreePage>('GET', `/api/v2/channels/tree${qs}`)
  }

  createChannel(input: {
    readonly path: string
    readonly kind?: ChannelKind
    readonly topic?: string
    readonly category?: string
    readonly repo?: string
    readonly private?: boolean
    readonly members?: readonly string[]
  }): Promise<{ readonly channel: UiChannelView }> {
    return this.#request('POST', '/api/board/channels', input)
  }

  markChannelRead(channel: string, cursor?: string): Promise<unknown> {
    return this.#request('POST', '/api/v2/channels/read', {
      channel,
      ...(cursor !== undefined ? { cursor } : {}),
    })
  }

  ensureDm(peer: string, topic?: string): Promise<{ readonly channel: UiChannelView; readonly created: boolean; readonly peer: string }> {
    return this.#request('POST', '/api/v2/dm', {
      peer,
      ...(topic ? { topic } : {}),
    })
  }

  // ---- Threads & Messages
  listThreads(opts: {
    readonly channel?: string
    readonly order?: 'forum' | 'chronological'
    readonly limit?: number
    readonly includeMeta?: boolean
    readonly before?: string
  }): Promise<UiThreadsPage> {
    const p = new URLSearchParams()
    if (opts.channel) p.set('channel', opts.channel)
    if (opts.order) p.set('order', opts.order)
    if (opts.limit !== undefined) p.set('limit', String(opts.limit))
    if (opts.includeMeta) p.set('includeMeta', 'true')
    if (opts.before) p.set('before', opts.before)
    const qs = p.toString()
    return this.#request<UiThreadsPage>('GET', `/api/board/threads${qs ? `?${qs}` : ''}`)
  }

  listChannelMessages(channel: string, limit = 100): Promise<UiMessagesPage> {
    const p = new URLSearchParams({ channel, limit: String(limit) })
    return this.#request<UiMessagesPage>('GET', `/api/board/messages?${p.toString()}`)
  }

  getThread(id: string, limit = 500): Promise<UiThreadView> {
    const p = new URLSearchParams({ limit: String(limit) })
    return this.#request<UiThreadView>('GET', `/api/board/messages/${encodeURIComponent(id)}?${p.toString()}`)
  }

  postMessage(input: {
    readonly channel?: string
    readonly re?: string
    readonly text: string
    readonly quoteMessageId?: string
    readonly labels?: Readonly<Record<string, string>>
  }): Promise<{ readonly message: UiMessageView }> {
    return this.#request('POST', '/api/board/messages', input)
  }

  editMessage(id: string, text: string, revision?: number): Promise<UiMessageView> {
    return this.#request('POST', `/api/board/messages/${encodeURIComponent(id)}/edit`, {
      text,
      ...(revision !== undefined ? { revision } : {}),
    })
  }

  deleteMessage(id: string, revision?: number): Promise<UiMessageView> {
    return this.#request('POST', `/api/board/messages/${encodeURIComponent(id)}/delete`, {
      ...(revision !== undefined ? { revision } : {}),
    })
  }

  reactMessage(id: string, emoji: string, remove = false): Promise<UiMessageView> {
    return this.#request('POST', `/api/board/messages/${encodeURIComponent(id)}/reactions`, {
      emoji,
      ...(remove ? { remove: true } : {}),
    })
  }

  labelMessage(
    id: string,
    body: { readonly set?: Readonly<Record<string, string>>; readonly unset?: readonly string[] },
  ): Promise<UiMessageView> {
    return this.#request('POST', `/api/board/messages/${encodeURIComponent(id)}/labels`, body)
  }

  // ---- Pins
  listPins(opts: { readonly channel?: string; readonly thread?: string; readonly includeGlobal?: boolean; readonly limit?: number } = {}): Promise<UiPinView[]> {
    const p = new URLSearchParams()
    if (opts.channel) p.set('channel', opts.channel)
    if (opts.thread) p.set('thread', opts.thread)
    if (opts.includeGlobal) p.set('includeGlobal', 'true')
    if (opts.limit !== undefined) p.set('limit', String(opts.limit))
    const qs = p.toString()
    return this.#request<UiPinView[]>('GET', `/api/v2/pins${qs ? `?${qs}` : ''}`)
  }

  pinMessage(id: string, scope: PinScope = 'channel', note?: string): Promise<{ readonly pin: UiPinView; readonly created: boolean }> {
    return this.#request('POST', `/api/v2/messages/${encodeURIComponent(id)}/pin`, {
      scope,
      ...(note ? { note } : {}),
    })
  }

  unpinMessage(id: string, scope?: PinScope): Promise<{ readonly unpinned: number }> {
    return this.#request('POST', `/api/v2/messages/${encodeURIComponent(id)}/unpin`, {
      ...(scope !== undefined ? { scope } : {}),
    })
  }

  // ---- Notifications & Inbox
  agentInbox(): Promise<UiAgentInboxView> {
    return this.#request<UiAgentInboxView>('GET', '/api/v2/inbox?notificationsLimit=60&tasksLimit=40&includeReadyPool=true')
  }

  listNotifications(unreadOnly = false, limit = 100): Promise<UiNotificationsPage> {
    const p = new URLSearchParams({ unreadOnly: unreadOnly ? 'true' : 'false', limit: String(limit) })
    return this.#request<UiNotificationsPage>('GET', `/api/v2/notifications?${p.toString()}`)
  }

  ackNotification(id: string): Promise<unknown> {
    return this.#request('POST', `/api/v2/notifications/${encodeURIComponent(id)}/ack`, {})
  }

  ackAllNotifications(channel?: string): Promise<unknown> {
    return this.#request('POST', '/api/v2/notifications/ack-all', {
      ...(channel ? { channel } : {}),
      markChannelRead: true,
    })
  }

  // ---- Groups
  listGroups(): Promise<UiGroupView[]> {
    return this.#request<UiGroupView[]>('GET', '/api/v2/groups?limit=200')
  }

  createGroup(input: {
    readonly handle: string
    readonly name: string
    readonly description?: string
    readonly kind?: GroupKind
    readonly channel?: string | null
    readonly members?: readonly string[]
  }): Promise<UiGroupView> {
    return this.#request<UiGroupView>('POST', '/api/v2/groups', input)
  }

  updateGroup(
    handle: string,
    patch: { readonly name?: string; readonly description?: string; readonly kind?: GroupKind },
  ): Promise<UiGroupView> {
    return this.#request<UiGroupView>('PATCH', `/api/v2/groups/${encodeURIComponent(handle)}`, patch)
  }

  deleteGroup(handle: string): Promise<{ readonly deleted: boolean }> {
    return this.#request('DELETE', `/api/v2/groups/${encodeURIComponent(handle)}`, {})
  }

  addGroupMembers(handle: string, members: readonly string[], role: 'member' | 'lead' = 'member'): Promise<UiGroupView> {
    return this.#request<UiGroupView>('POST', `/api/v2/groups/${encodeURIComponent(handle)}/members`, {
      members,
      role,
    })
  }

  removeGroupMembers(handle: string, members: readonly string[]): Promise<UiGroupView> {
    return this.#request<UiGroupView>('POST', `/api/v2/groups/${encodeURIComponent(handle)}/members/remove`, {
      members,
    })
  }

  // ---- Presence & Actors
  listPresence(includeOffline = false): Promise<UiPresenceView[]> {
    const qs = includeOffline ? '?includeOffline=true&limit=200' : '?limit=200'
    return this.#request<UiPresenceView[]>('GET', `/api/v2/presence${qs}`)
  }

  setPresence(input: {
    readonly status: PresenceStatus
    readonly channel?: string | null
    readonly note?: string | null
    readonly harness?: string
    readonly ttlS?: number
  }): Promise<UiPresenceView> {
    return this.#request<UiPresenceView>('PUT', '/api/v2/presence', input)
  }

  listActors(): Promise<(UiActorView & { readonly id: string })[]> {
    return this.#request<(UiActorView & { readonly id: string })[]>('GET', '/api/board/actors')
  }

  // ---- Tasks
  listTasks(opts: { readonly channel?: string; readonly state?: string; readonly limit?: number } = {}): Promise<UiTasksPage> {
    const p = new URLSearchParams()
    if (opts.channel) p.set('channel', opts.channel)
    if (opts.state) p.set('state', opts.state)
    p.set('limit', String(opts.limit ?? 200))
    return this.#request<UiTasksPage>('GET', `/api/board/tasks?${p.toString()}`)
  }

  createTask(input: {
    readonly channel?: string
    readonly re?: string
    readonly text?: string
    readonly for?: string | null
    readonly labels?: Readonly<Record<string, string>>
  }): Promise<{ readonly task: UiMessageView }> {
    return this.#request('POST', '/api/board/tasks', input)
  }

  claimTask(id: string): Promise<{ readonly task: UiMessageView; readonly claim: { readonly epoch: number; readonly token: string; readonly until: string } }> {
    return this.#request('POST', `/api/board/tasks/${encodeURIComponent(id)}/claim`, {})
  }

  completeTask(id: string, epoch: number, token: string, result?: string): Promise<{ readonly task: UiMessageView }> {
    return this.#request('POST', `/api/board/tasks/${encodeURIComponent(id)}/complete`, {
      epoch,
      token,
      ...(result ? { result } : {}),
    })
  }

  blockTask(id: string, reason: string, kind?: string): Promise<{ readonly task: UiMessageView }> {
    return this.#request('POST', `/api/board/tasks/${encodeURIComponent(id)}/block`, {
      reason,
      ...(kind ? { kind } : {}),
    })
  }

  unblockTask(id: string): Promise<{ readonly task: UiMessageView }> {
    return this.#request('POST', `/api/board/tasks/${encodeURIComponent(id)}/unblock`, {})
  }

  reopenTask(id: string): Promise<{ readonly task: UiMessageView }> {
    return this.#request('POST', `/api/board/tasks/${encodeURIComponent(id)}/reopen`, {})
  }

  assignTask(id: string, forActor: string | null): Promise<{ readonly task: UiMessageView }> {
    return this.#request('POST', `/api/board/tasks/${encodeURIComponent(id)}/assign`, { for: forActor })
  }

  // ---- Search & Feedback
  search(query: string, opts: { readonly channel?: string; readonly scope?: string; readonly limit?: number } = {}): Promise<UiSearchHit[]> {
    const p = new URLSearchParams({ query })
    if (opts.channel) p.set('channel', opts.channel)
    if (opts.scope && opts.scope !== 'all') p.set('scope', opts.scope)
    p.set('limit', String(opts.limit ?? 50))
    return this.#request<UiSearchHit[]>('GET', `/api/v2/search?${p.toString()}`)
  }

  submitFeedback(input: {
    readonly summary: string
    readonly kind: string
    readonly severity: string
    readonly repro?: string
    readonly suggestion?: string
    readonly harness?: string
  }): Promise<{ readonly message: UiMessageView }> {
    return this.#request('POST', '/api/v2/feedback', input)
  }
}

export interface StreamHandlers {
  readonly onStatus: (status: 'connecting' | 'live' | 'reconnecting') => void
  readonly onBoardEvent: (category: string, event: UiBoardEventView) => void
  readonly onNotification: (notif: UiNotificationView) => void
  readonly onResyncNeeded: () => void
}

export class SwarmboardStream {
  #source: EventSource | null = null
  #handlers: StreamHandlers
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #backoffMs = 1000
  #stopped = false

  constructor(handlers: StreamHandlers) {
    this.#handlers = handlers
  }

  connect(): void {
    this.#stopped = false
    this.#open()
  }

  close(): void {
    this.#stopped = true
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    if (this.#source !== null) {
      this.#source.close()
      this.#source = null
    }
  }

  #open(): void {
    if (this.#stopped || typeof EventSource === 'undefined') return
    if (this.#source !== null) {
      this.#source.close()
      this.#source = null
    }
    this.#handlers.onStatus('connecting')
    const es = new EventSource('/api/v2/stream')
    this.#source = es

    es.onopen = () => {
      this.#backoffMs = 1000
      this.#handlers.onStatus('live')
    }

    const bindCategory = (cat: string): void => {
      es.addEventListener(cat, (ev: Event) => {
        const msg = ev as MessageEvent<string>
        try {
          const parsed = JSON.parse(msg.data) as UiBoardEventView
          this.#handlers.onBoardEvent(cat, parsed)
        } catch {
          // ignore malformed SSE frame
        }
      })
    }

    for (const cat of ['message', 'presence', 'pin', 'task', 'channel']) {
      bindCategory(cat)
    }

    es.addEventListener('notification', (ev: Event) => {
      const msg = ev as MessageEvent<string>
      try {
        const parsed = JSON.parse(msg.data) as UiNotificationView
        this.#handlers.onNotification(parsed)
      } catch {
        // ignore malformed notification
      }
    })

    es.addEventListener('reconnect', () => {
      this.#scheduleReconnect(true)
    })

    es.addEventListener('shutdown', () => {
      this.#scheduleReconnect(true)
    })

    es.onerror = () => {
      this.#scheduleReconnect(false)
    }
  }

  #scheduleReconnect(resync: boolean): void {
    if (this.#stopped) return
    if (this.#source !== null) {
      this.#source.close()
      this.#source = null
    }
    this.#handlers.onStatus('reconnecting')
    if (this.#reconnectTimer !== null) return
    const delay = this.#backoffMs
    this.#backoffMs = Math.min(15_000, Math.round(this.#backoffMs * 1.6))
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      if (resync) this.#handlers.onResyncNeeded()
      this.#open()
    }, delay)
  }
}
