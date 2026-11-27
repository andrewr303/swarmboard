// Far-left Discord Space Rail + Left Navigation Rail (Shortcuts, DMs, Collapsible Spaces/Channels, Who Is Online, User Status).
import type { UiActions } from '../actions.ts'
import { avatarMonogram, el, svgIcon, type IconName } from '../dom.ts'
import {
  deriveSpaces,
  extractDmPeer,
  groupChannelsByCategory,
  needsYouCount,
  openFeedbackCount,
  type UiState,
} from '../state.ts'
import type { ChannelKind, PresenceStatus, UiChannelView, UiPresenceView } from '../types.ts'

function sidebarChannelIcon(kind?: ChannelKind): IconName {
  switch (kind) {
    case 'announcements':
      return 'megaphone'
    case 'forum':
      return 'forum'
    case 'tasks':
      return 'tasks'
    case 'dm':
      return 'dm'
    default:
      return 'hash'
  }
}

function sidebarPresenceForPeer(peer: string, presence: readonly UiPresenceView[]): PresenceStatus {
  const slug = peer.toLowerCase()
  for (const p of presence) {
    const short = (p.profile ?? p.handle.replace(/^.*\//, '')).toLowerCase()
    if (short === slug || p.handle.toLowerCase() === slug) {
      return p.status
    }
  }
  return 'offline'
}

export function renderSpaceRail(state: UiState, actions: UiActions): HTMLElement {
  const rail = el('nav', { className: 'cb-space-rail', 'aria-label': 'Spaces' })

  const brandBtn = el(
    'button',
    {
      type: 'button',
      className: `cb-space-btn cb-space-brand${state.workspace.kind === 'home' ? ' is-active' : ''}`,
      title: 'Swarmboard Home',
      'aria-label': 'Swarmboard Home',
    },
    el('span', { textContent: 'S' }),
  )
  brandBtn.addEventListener('click', () => {
    actions.setSpace('global')
    actions.navigate({ kind: 'home' })
  })
  rail.appendChild(brandBtn)

  const spaces = deriveSpaces(state.flatChannels)
  const list = el('div', { className: 'cb-space-list' })
  for (const sp of spaces) {
    const active = state.activeSpace === sp.id
    const btn = el(
      'button',
      {
        type: 'button',
        className: `cb-space-btn${active ? ' is-active' : ''} cb-space-${sp.kind}`,
        title: sp.label,
        'aria-label': sp.label,
        'aria-pressed': String(active),
      },
      sp.kind === 'global'
        ? svgIcon('globe', 18)
        : sp.kind === 'swarm'
          ? svgIcon('swarm', 18)
          : el('span', { className: 'cb-space-mono', textContent: sp.monogram }),
    )
    if (sp.unread > 0) {
      btn.appendChild(
        el('span', {
          className: 'cb-space-badge',
          textContent: sp.unread > 99 ? '99+' : String(sp.unread),
        }),
      )
    }
    btn.addEventListener('click', () => actions.setSpace(sp.id))
    list.appendChild(btn)
  }
  rail.appendChild(list)

  const spacer = el('div', { className: 'cb-spacer' })
  rail.appendChild(spacer)

  const themeBtn = el(
    'button',
    {
      type: 'button',
      className: 'cb-space-btn cb-space-util',
      title: state.theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode',
      'aria-label': 'Toggle theme',
    },
    svgIcon(state.theme === 'dark' ? 'sun' : 'moon', 17),
  )
  themeBtn.addEventListener('click', () => actions.toggleTheme())
  rail.appendChild(themeBtn)

  return rail
}

export function renderSidebar(state: UiState, actions: UiActions): HTMLElement {
  const aside = el('aside', {
    className: `cb-sidebar${state.mobileSidebarOpen ? ' is-open' : ''}`,
    'aria-label': 'Workspace navigation',
  })

  // Header
  const header = el('div', { className: 'cb-sidebar-header' })
  const titleWrap = el('div', { className: 'cb-workspace-title' })
  const spaceName = state.activeSpace === 'global' ? 'Swarmboard' : state.activeSpace.replace(/^(repo|swarm):/, '')
  titleWrap.appendChild(el('span', { className: 'cb-workspace-name', textContent: spaceName, title: spaceName }))
  header.appendChild(titleWrap)

  const hdrActions = el('div', { className: 'cb-sidebar-hdr-actions' })
  const create = el('button', {
    type: 'button', className: 'cb-icon-btn', title: 'New channel', 'aria-label': 'New channel',
  }, svgIcon('plus', 16))
  create.addEventListener('click', () => actions.openModal({ kind: 'new-channel' }))
  hdrActions.appendChild(create)

  const closeMob = el(
    'button',
    {
      type: 'button',
      className: 'cb-icon-btn cb-mobile-only',
      title: 'Close menu',
      'aria-label': 'Close navigation',
    },
    svgIcon('close', 16),
  )
  closeMob.addEventListener('click', () => actions.toggleMobileSidebar(false))
  hdrActions.appendChild(closeMob)

  header.appendChild(hdrActions)
  aside.appendChild(header)

  const search = el('button', {
    type: 'button', className: 'cb-search-trigger', title: 'Search board (⌘K / Ctrl+K)',
  }, svgIcon('search', 15), el('span', { textContent: 'Search board' }))
  search.addEventListener('click', () => actions.openModal({ kind: 'search' }))
  aside.appendChild(search)

  const scroll = el('div', { className: 'cb-sidebar-scroll' })

  // 1. Shortcuts (Google Chat + Twist)
  const shortcuts = el('div', { className: 'cb-nav-section' })
  shortcuts.appendChild(el('div', { className: 'cb-nav-heading', textContent: 'Workspace' }))

  const addShortcut = (
    label: string,
    icon: IconName,
    active: boolean,
    badge: number,
    badgeTone: 'default' | 'urgent',
    onClick: () => void,
  ): void => {
    const item = el(
      'button',
      {
        type: 'button',
        className: `cb-nav-item${active ? ' is-active' : ''}`,
      },
      svgIcon(icon, 15),
      el('span', { className: 'cb-nav-label', textContent: label }),
      badge > 0
        ? el('span', {
            className: `cb-badge${badgeTone === 'urgent' ? ' cb-badge-urgent' : ''}`,
            textContent: badge > 99 ? '99+' : String(badge),
          })
        : null,
    )
    item.addEventListener('click', onClick)
    shortcuts.appendChild(item)
  }

  addShortcut('Home', 'home', state.workspace.kind === 'home', 0, 'default', () => actions.navigate({ kind: 'home' }))
  addShortcut(
    'Inbox',
    'at',
    state.workspace.kind === 'inbox',
    state.unreadNotificationCount,
    state.urgentNotificationCount > 0 ? 'urgent' : 'default',
    () => actions.navigate({ kind: 'inbox' }),
  )
  addShortcut('Saved posts', 'pin', state.workspace.kind === 'pinned', state.allPins.length, 'default', () =>
    actions.navigate({ kind: 'pinned' }),
  )
  const decisionsBadge = needsYouCount(state)
  addShortcut('Decisions', 'scale', state.workspace.kind === 'decisions', decisionsBadge, 'urgent', () =>
    actions.navigate({ kind: 'decisions' }),
  )
  addShortcut(
    'Feedback',
    'bug',
    state.workspace.kind === 'channel' && state.workspace.channel === 'meta/feedback',
    openFeedbackCount(state),
    'default',
    () => actions.openChannel('meta/feedback', 'forum'),
  )

  // 2. Direct Messages (Google Chat + Twist)
  const dmSection = el('div', { className: 'cb-nav-section' })
  const dmHead = el('div', { className: 'cb-nav-heading-row' })
  dmHead.appendChild(el('span', { className: 'cb-nav-heading', textContent: 'Direct Messages' }))
  const newDmBtn = el(
    'button',
    { type: 'button', className: 'cb-mini-add', title: 'New Direct Message', 'aria-label': 'New Direct Message' },
    svgIcon('plus', 13),
  )
  newDmBtn.addEventListener('click', () => actions.openModal({ kind: 'new-dm' }))
  dmHead.appendChild(newDmBtn)
  dmSection.appendChild(dmHead)

  const dmChannels = state.flatChannels.filter((c) => !c.archived && (c.kind === 'dm' || c.path.startsWith('dm/')))
  if (dmChannels.length === 0) {
    const emptyDm = el('button', {
      type: 'button',
      className: 'cb-nav-empty-btn',
      textContent: '+ Start a DM with an agent…',
    })
    emptyDm.addEventListener('click', () => actions.openModal({ kind: 'new-dm' }))
    dmSection.appendChild(emptyDm)
  } else {
    for (const dm of dmChannels) {
      const peer = extractDmPeer(dm.path, state.me?.handle ?? null)
      const status = sidebarPresenceForPeer(peer, state.presence)
      const isActive =
        (state.workspace.kind === 'channel' || state.workspace.kind === 'thread') &&
        state.workspace.channel === dm.path
      const item = el(
        'button',
        {
          type: 'button',
          className: `cb-nav-item${isActive ? ' is-active' : ''}`,
        },
        el('span', { className: `cb-dot cb-dot-${status}`, title: status }),
        el('span', { className: 'cb-nav-label', textContent: peer }),
        (dm.unreadCount ?? 0) > 0
          ? el('span', { className: 'cb-badge', textContent: String(dm.unreadCount) })
          : null,
      )
      item.addEventListener('click', () => actions.openChannel(dm.path, 'chat'))
      dmSection.appendChild(item)
    }
  }

  // 3. Collapsible Spaces / Categories & Sub-Channels Tree (Discord + Twist)
  const sections = groupChannelsByCategory(state.flatChannels, state.activeSpace)
  for (const sec of sections) {
    const collapsed = state.collapsedGroups[sec.key] === true
    const secWrap = el('div', { className: 'cb-nav-section' })
    const headRow = el('div', { className: 'cb-nav-heading-row' })

    const collapseBtn = el(
      'button',
      { type: 'button', className: 'cb-cat-toggle', 'aria-expanded': String(!collapsed) },
      svgIcon(collapsed ? 'chevron-right' : 'chevron-down', 13),
      el('span', { className: 'cb-nav-heading', textContent: sec.key === 'Global' ? 'Channels' : sec.title }),
      collapsed && sec.totalUnread > 0
        ? el('span', { className: 'cb-badge', textContent: String(sec.totalUnread) })
        : null,
    )
    collapseBtn.addEventListener('click', () => actions.toggleGroupCollapse(sec.key))
    headRow.appendChild(collapseBtn)

    const addChBtn = el(
      'button',
      {
        type: 'button',
        className: 'cb-mini-add',
        title: `New channel in ${sec.title}`,
        'aria-label': `New channel in ${sec.title}`,
      },
      svgIcon('plus', 13),
    )
    addChBtn.addEventListener('click', () => {
      const prefix = sec.key.startsWith('repos/') || sec.key.startsWith('swarms/') ? `${sec.key}/` : ''
      actions.openModal({ kind: 'new-channel', ...(prefix ? { prefix } : {}) })
    })
    headRow.appendChild(addChBtn)
    secWrap.appendChild(headRow)

    if (!collapsed) {
      for (const ch of sec.channels) {
        secWrap.appendChild(renderChannelItem(ch, sec.key, state, actions))
      }
    }
    if (scroll.childElementCount === 0) {
      scroll.append(secWrap, shortcuts, dmSection)
    } else {
      scroll.appendChild(secWrap)
    }
  }

  if (sections.length === 0) scroll.append(shortcuts, dmSection)

  // Presence roster
  const onlineSection = el('div', { className: 'cb-nav-section cb-online-roster' })
  const onlinePeers = state.presence.filter((p) => p.status !== 'offline')
  onlineSection.appendChild(
    el('div', {
      className: 'cb-nav-heading',
      textContent: `Online (${onlinePeers.length})`,
    }),
  )
  for (const peer of onlinePeers.slice(0, 10)) {
    const short = peer.profile ?? peer.handle.replace(/^.*\//, '')
    const meta = [peer.harness, peer.model].filter(Boolean).join(' · ')
    const row = el(
      'button',
      {
        type: 'button',
        className: 'cb-online-item',
        title: `DM ${short}${peer.channel ? ` (in #${peer.channel})` : ''}`,
      },
      el('span', { className: `cb-dot cb-dot-${peer.status}` }),
      el(
        'div',
        { className: 'cb-online-info' },
        el('div', { className: 'cb-online-name', textContent: short }),
        meta || peer.channel
          ? el('div', {
              className: 'cb-online-meta',
              textContent: peer.channel ? `#${peer.channel}${meta ? ` • ${meta}` : ''}` : meta,
            })
          : null,
      ),
    )
    row.addEventListener('click', () => {
      void actions.openOrCreateDm(short)
    })
    onlineSection.appendChild(row)
  }
  if (onlinePeers.length) scroll.appendChild(onlineSection)
  aside.appendChild(scroll)

  // Signed-in identity and personal presence
  const footer = el('div', { className: 'cb-user-card' })
  if (!state.me) return aside
  const myName = state.me.name || state.me.handle
  const av = el('div', { className: 'cb-avatar cb-avatar-sm', textContent: avatarMonogram(myName) })
  footer.appendChild(av)

  const info = el('div', { className: 'cb-user-card-info' })
  info.appendChild(el('div', { className: 'cb-user-card-name', textContent: myName, title: state.me.handle }))

  const select = el('select', { className: 'cb-status-select', 'aria-label': 'Your presence status' })
  for (const opt of [
    { val: 'active', label: '● Active' },
    { val: 'busy', label: '● Busy' },
    { val: 'idle', label: '● Idle' },
    { val: 'offline', label: '○ Offline' },
  ] as const) {
    const o = el('option', { value: opt.val, textContent: opt.label })
    if (state.myStatus === opt.val) o.selected = true
    select.appendChild(o)
  }
  select.addEventListener('change', () => {
    void actions.setMyStatus(select.value as PresenceStatus)
  })
  info.appendChild(select)
  footer.appendChild(info)
  const syncState = state.sseStatus === 'live' ? 'Connected' : state.sseStatus === 'connecting' ? 'Connecting' : 'Reconnecting'
  const refresh = el('button', {
    type: 'button', className: 'cb-icon-btn', title: syncState + ' · Refresh board', 'aria-label': syncState + ' · Refresh board',
  }, svgIcon('refresh', 14))
  refresh.addEventListener('click', () => { void actions.refreshAll() })
  footer.appendChild(refresh)
  aside.appendChild(footer)

  return aside
}

function renderChannelItem(
  ch: UiChannelView,
  sectionKey: string,
  state: UiState,
  actions: UiActions,
): HTMLElement {
  const isActive =
    (state.workspace.kind === 'channel' || state.workspace.kind === 'thread') &&
    state.workspace.channel === ch.path
  const display =
    sectionKey.startsWith('repos/') || sectionKey.startsWith('swarms/')
      ? ch.path.slice(sectionKey.length + 1) || ch.path
      : ch.path
  const btn = el(
    'button',
    {
      type: 'button',
      className: `cb-nav-item${isActive ? ' is-active' : ''}${(ch.unreadCount ?? 0) > 0 ? ' has-unread' : ''}`,
      'aria-current': isActive ? 'page' : undefined,
      title: ch.topic ? `${ch.path} — ${ch.topic}` : ch.path,
    },
    svgIcon(sidebarChannelIcon(ch.kind), 14),
    el('span', { className: 'cb-nav-label', textContent: display }),
    ch.private ? svgIcon('lock', 12, 'cb-icon cb-lock-icon') : null,
    (ch.unreadCount ?? 0) > 0
      ? el('span', {
          className: 'cb-badge',
          textContent: (ch.unreadCount ?? 0) > 99 ? '99+' : String(ch.unreadCount),
        })
      : null,
  )
  btn.addEventListener('click', () => {
    const defaultMode = ch.kind === 'chat' ? 'chat' : 'forum'
    actions.openChannel(ch.path, defaultMode)
  })
  return btn
}
