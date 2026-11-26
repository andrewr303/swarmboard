// Centralized reactive state & pure data projection helpers for Swarmboard Command Center UI.
import type {
  ActiveWorkspace,
  DrawerTab,
  ModalState,
  PresenceStatus,
  TaskState,
  UiActorView,
  UiAgentInboxView,
  UiAutocompleteItem,
  UiBoardEventView,
  UiChannelTreeNode,
  UiChannelView,
  UiGroupView,
  UiHealthView,
  UiMessageView,
  UiMeView,
  UiNotificationView,
  UiPinView,
  UiPresenceView,
  UiSpaceItem,
  UiThreadSummaryView,
  UiThreadView,
  UiToast,
} from './types.ts'
import { avatarMonogram } from './dom.ts'

export interface ClaimProof {
  readonly epoch: number
  readonly token: string
  readonly until: string
}

export interface UiState {
  me: UiMeView | null
  health: UiHealthView | null
  theme: 'dark' | 'light'
  sseStatus: 'connecting' | 'live' | 'reconnecting'
  myStatus: PresenceStatus
  authenticated: boolean
  loading: boolean

  // Navigation & layout
  activeSpace: string
  workspace: ActiveWorkspace
  drawerOpen: boolean
  drawerTab: DrawerTab
  mobileSidebarOpen: boolean
  collapsedGroups: Record<string, boolean>
  modal: ModalState

  // Board data
  channelTree: readonly UiChannelTreeNode[]
  flatChannels: readonly UiChannelView[]
  inbox: UiAgentInboxView | null
  notifications: readonly UiNotificationView[]
  unreadNotificationCount: number
  urgentNotificationCount: number
  allPins: readonly UiPinView[]
  channelPins: readonly UiPinView[]
  groups: readonly UiGroupView[]
  presence: readonly UiPresenceView[]
  actors: readonly (UiActorView & { readonly id: string })[]
  tasks: readonly UiThreadSummaryView[]
  decisionsThreads: readonly UiThreadSummaryView[]
  feedbackThreads: readonly UiThreadSummaryView[]

  // Active channel / thread data
  channelThreads: readonly UiThreadSummaryView[]
  channelMessages: readonly UiMessageView[]
  channelFilter: string
  activeThread: UiThreadView | null
  threadSort: 'asc' | 'desc'
  threadFilter: string

  // Drawer filters
  taskFilter: 'all' | 'open' | 'ready' | 'claimed' | 'blocked' | 'done'
  feedbackFilter: 'all' | 'new' | 'triaged' | 'resolved'

  // Composer state
  composerText: string
  composerQuote: UiMessageView | null
  composerTags: string[]
  editingMessageId: string | null
  editingText: string
  reactPickerMessageId: string | null

  // Local claim cache for human 1-click Complete
  claimCache: Record<string, ClaimProof>

  // Toasts
  toasts: readonly UiToast[]
}

export function createInitialState(): UiState {
  let savedTheme: 'dark' | 'light' = 'dark'
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('sb-theme') === 'light') {
      savedTheme = 'light'
    }
  } catch {
    // ignore storage restriction
  }
  return {
    me: null,
    health: null,
    theme: savedTheme,
    sseStatus: 'connecting',
    myStatus: 'active',
    authenticated: true,
    loading: true,
    activeSpace: 'global',
    workspace: { kind: 'home' },
    drawerOpen: typeof window !== 'undefined' ? window.innerWidth >= 1180 : true,
    drawerTab: 'tasks',
    mobileSidebarOpen: false,
    collapsedGroups: {},
    modal: null,
    channelTree: [],
    flatChannels: [],
    inbox: null,
    notifications: [],
    unreadNotificationCount: 0,
    urgentNotificationCount: 0,
    allPins: [],
    channelPins: [],
    groups: [],
    presence: [],
    actors: [],
    tasks: [],
    decisionsThreads: [],
    feedbackThreads: [],
    channelThreads: [],
    channelMessages: [],
    channelFilter: '',
    activeThread: null,
    threadSort: 'asc',
    threadFilter: '',
    taskFilter: 'open',
    feedbackFilter: 'all',
    composerText: '',
    composerQuote: null,
    composerTags: [],
    editingMessageId: null,
    editingText: '',
    reactPickerMessageId: null,
    claimCache: {},
    toasts: [],
  }
}

export function flattenChannelTree(nodes: readonly UiChannelTreeNode[]): UiChannelView[] {
  const out: UiChannelView[] = []
  const walk = (list: readonly UiChannelTreeNode[]): void => {
    for (const node of list) {
      if (node.channel !== null) {
        out.push({
          ...node.channel,
          unreadCount: node.channel.unreadCount ?? node.unreadCount,
        })
      }
      if (node.children.length > 0) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

export function deriveSpaces(channels: readonly UiChannelView[]): UiSpaceItem[] {
  let globalUnread = 0
  const repos = new Map<string, number>()
  const swarms = new Map<string, number>()

  for (const ch of channels) {
    if (ch.archived || ch.path.startsWith('dm/')) continue
    const unread = ch.unreadCount ?? 0
    if (ch.path.startsWith('repos/')) {
      const seg = ch.path.split('/')[1]
      if (seg) repos.set(seg, (repos.get(seg) ?? 0) + unread)
    } else if (ch.path.startsWith('swarms/')) {
      const seg = ch.path.split('/')[1]
      if (seg) swarms.set(seg, (swarms.get(seg) ?? 0) + unread)
    } else {
      globalUnread += unread
    }
  }

  const out: UiSpaceItem[] = [
    {
      id: 'global',
      label: 'All Spaces & Global',
      monogram: 'SB',
      kind: 'global',
      prefix: null,
      unread: globalUnread,
    },
  ]

  for (const [repo, unread] of [...repos.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({
      id: `repo:${repo}`,
      label: `repos/${repo}`,
      monogram: avatarMonogram(repo),
      kind: 'repo',
      prefix: `repos/${repo}/`,
      unread,
    })
  }

  for (const [swarm, unread] of [...swarms.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({
      id: `swarm:${swarm}`,
      label: `swarms/${swarm}`,
      monogram: avatarMonogram(swarm),
      kind: 'swarm',
      prefix: `swarms/${swarm}/`,
      unread,
    })
  }

  return out
}

export interface ChannelSectionGroup {
  readonly key: string
  readonly title: string
  readonly channels: readonly UiChannelView[]
  readonly totalUnread: number
}

export function groupChannelsByCategory(
  channels: readonly UiChannelView[],
  activeSpace: string,
): ChannelSectionGroup[] {
  const map = new Map<string, UiChannelView[]>()
  for (const ch of channels) {
    if (ch.archived || ch.path.startsWith('dm/') || ch.kind === 'dm') continue
    if (activeSpace.startsWith('repo:')) {
      const target = `repos/${activeSpace.slice(5)}/`
      if (!ch.path.startsWith(target)) continue
    } else if (activeSpace.startsWith('swarm:')) {
      const target = `swarms/${activeSpace.slice(6)}/`
      if (!ch.path.startsWith(target)) continue
    }

    let section: string
    if (ch.path.startsWith('repos/')) {
      const parts = ch.path.split('/')
      section = parts.length >= 2 ? `repos/${parts[1]}` : 'repos'
    } else if (ch.path.startsWith('swarms/')) {
      const parts = ch.path.split('/')
      section = parts.length >= 2 ? `swarms/${parts[1]}` : 'swarms'
    } else if (ch.path.startsWith('work/') || ch.path === 'work') {
      section = 'Work'
    } else if (ch.path.startsWith('meta/') || ch.path.startsWith('ops/')) {
      section = 'Operations & Meta'
    } else {
      section = 'Global'
    }

    const list = map.get(section)
    if (list) list.push(ch)
    else map.set(section, [ch])
  }

  const orderWeight = (key: string): number => {
    if (key === 'Global') return 0
    if (key === 'Work') return 1
    if (key.startsWith('repos/')) return 2
    if (key.startsWith('swarms/')) return 3
    return 4
  }

  return [...map.entries()]
    .sort((a, b) => orderWeight(a[0]) - orderWeight(b[0]) || a[0].localeCompare(b[0]))
    .map(([key, list]) => {
      const sorted = [...list].sort(
        (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.path.localeCompare(b.path),
      )
      return {
        key,
        title: key,
        channels: sorted,
        totalUnread: sorted.reduce((acc, c) => acc + (c.unreadCount ?? 0), 0),
      }
    })
}

export function extractDmPeer(channelPath: string, myHandle: string | null): string {
  const rest = channelPath.startsWith('dm/') ? channelPath.slice(3) : channelPath
  const parts = rest.split('--')
  if (parts.length !== 2) return rest
  const self = (myHandle ?? '').toLowerCase().replace(/^.*[/+]/, '')
  if (parts[0]!.toLowerCase() === self && parts[1]!.toLowerCase() !== self) return parts[1]!
  if (parts[1]!.toLowerCase() === self && parts[0]!.toLowerCase() !== self) return parts[0]!
  return parts[0] === parts[1] ? `${parts[0]} (self)` : `${parts[0]} ↔ ${parts[1]}`
}

export function needsYouCount(state: UiState): number {
  const blockedTasks = state.tasks.filter((t) => t.message.task?.state === 'blocked').length
  const openDecisions = state.decisionsThreads.filter((t) => {
    const st = t.message.labels['status'] ?? t.message.labels['decision.status']
    return st !== 'resolved' && st !== 'approved' && st !== 'closed'
  }).length
  return blockedTasks + openDecisions
}

export function openFeedbackCount(state: UiState): number {
  return state.feedbackThreads.filter((t) => {
    const st = (t.message.labels['status'] ?? 'new').toLowerCase()
    return st !== 'resolved' && st !== 'wontfix' && st !== 'closed'
  }).length
}

export function partitionForumThreads(threads: readonly UiThreadSummaryView[]): {
  readonly announcements: readonly UiThreadSummaryView[]
  readonly stickies: readonly UiThreadSummaryView[]
  readonly regular: readonly UiThreadSummaryView[]
} {
  const announcements: UiThreadSummaryView[] = []
  const stickies: UiThreadSummaryView[] = []
  const regular: UiThreadSummaryView[] = []
  for (const t of threads) {
    if (t.pin?.scope === 'announcement') announcements.push(t)
    else if (t.pin?.scope === 'channel') stickies.push(t)
    else regular.push(t)
  }
  return { announcements, stickies, regular }
}

export function buildAutocompleteItems(
  trigger: '@' | '#' | '/',
  query: string,
  state: UiState,
): UiAutocompleteItem[] {
  const q = query.trim().toLowerCase()
  const items: UiAutocompleteItem[] = []

  if (trigger === '@') {
    const specials: UiAutocompleteItem[] = [
      { kind: 'group', label: '@channel', sublabel: 'Notify recent participants & active agents in channel', insertText: '@channel ', badge: 'broadcast' },
      { kind: 'group', label: '@here', sublabel: 'Notify online active agents in channel', insertText: '@here ', badge: 'online' },
      { kind: 'group', label: '@all-agents', sublabel: 'Notify all online agents', insertText: '@all-agents ', badge: 'system' },
    ]
    for (const s of specials) {
      if (!q || s.label.toLowerCase().includes(q)) items.push(s)
    }
    for (const g of state.groups) {
      if (g.handle === 'all-agents') continue
      if (!q || g.handle.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)) {
        items.push({
          kind: 'group',
          label: `@${g.handle}`,
          sublabel: `${g.name} (${g.members.length} members)`,
          insertText: `@${g.handle} `,
          badge: g.kind,
        })
      }
    }
    const seenHandles = new Set<string>()
    for (const p of state.presence) {
      const short = p.profile ?? p.handle.replace(/^.*\//, '')
      const key = short.toLowerCase()
      if (seenHandles.has(key)) continue
      seenHandles.add(key)
      if (!q || key.includes(q) || p.handle.toLowerCase().includes(q)) {
        items.push({
          kind: 'agent',
          label: `@${short}`,
          sublabel: [p.status, p.harness, p.model].filter(Boolean).join(' • '),
          insertText: `@${short} `,
          badge: p.status,
        })
      }
    }
    for (const a of state.actors) {
      const short = a.handle.replace(/^.*\//, '')
      const key = short.toLowerCase()
      if (seenHandles.has(key)) continue
      seenHandles.add(key)
      if (!q || key.includes(q) || a.name.toLowerCase().includes(q)) {
        items.push({
          kind: 'agent',
          label: `@${short}`,
          sublabel: `${a.name} (${a.kind})`,
          insertText: `@${short} `,
          badge: a.kind,
        })
      }
    }
    return items.slice(0, 12)
  }

  if (trigger === '#') {
    for (const ch of state.flatChannels) {
      if (ch.archived || ch.path.startsWith('dm/')) continue
      if (!q || ch.path.toLowerCase().includes(q) || (ch.topic ?? '').toLowerCase().includes(q)) {
        items.push({
          kind: 'channel',
          label: `#${ch.path}`,
          sublabel: ch.topic ?? ch.kind ?? 'channel',
          insertText: `#${ch.path} `,
          badge: ch.kind ?? 'chat',
        })
      }
    }
    return items.slice(0, 12)
  }

  // Twist-style slash action palette
  const actions: UiAutocompleteItem[] = [
    { kind: 'action', label: '/mention', sublabel: 'Mention an agent or @group', insertText: '@', badge: '@' },
    { kind: 'action', label: '/channel', sublabel: 'Reference a #channel pill', insertText: '#', badge: '#' },
    { kind: 'action', label: '/quote', sublabel: 'Insert a Markdown blockquote', insertText: '> ', badge: '>' },
    { kind: 'action', label: '/code', sublabel: 'Insert a fenced code block', insertText: '```\n\n```', badge: '```' },
    { kind: 'action', label: '/task', sublabel: 'Open Create Task modal', insertText: '/task', badge: 'modal' },
    { kind: 'action', label: '/feedback', sublabel: 'Open Beta Feedback modal', insertText: '/feedback', badge: 'modal' },
  ]
  return actions.filter((a) => !q || a.label.toLowerCase().includes(q) || a.sublabel.toLowerCase().includes(q))
}

/** Builds an actorId -> display handle lookup map from known board actors, presence, and current user. */
export function buildActorLabelMap(state: UiState): Map<string, string> {
  const map = new Map<string, string>()
  for (const a of state.actors) {
    if (a.id && a.handle) map.set(a.id, a.handle)
  }
  for (const p of state.presence) {
    if (p.agent && p.handle && !map.has(p.agent)) map.set(p.agent, p.handle)
  }
  if (state.me?.actor && state.me.handle) {
    map.set(state.me.actor, state.me.handle)
  }
  return map
}

/** Only failed tasks can be reopened via `POST /api/board/tasks/:id/reopen` (`completed`/`canceled` return 409 `task_finished`). */
export function canReopenTaskState(taskState: TaskState): boolean {
  return taskState === 'failed'
}

/** Resolves a thread root reference (`re`, `rootId`, `thread`, `id`, or `cursor`) from an SSE board event. */
export function resolveEventRootId(ev: UiBoardEventView): string {
  const p = ev.payload
  if (typeof p.re === 'string' && p.re !== '') return p.re
  if (typeof p.re === 'number' && Number.isFinite(p.re)) return String(p.re)
  if (typeof p.rootId === 'string' && p.rootId !== '') return p.rootId
  if (typeof p.rootId === 'number' && Number.isFinite(p.rootId)) return String(p.rootId)
  if (typeof p.thread === 'string' && p.thread !== '') return p.thread
  if (typeof p.id === 'string' && p.id !== '') return p.id
  if (typeof p.id === 'number' && Number.isFinite(p.id)) return String(p.id)
  if (typeof ev.cursor === 'string' && ev.cursor !== '') return ev.cursor
  return ''
}
