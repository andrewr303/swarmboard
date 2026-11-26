// Top Bar: phpBB Breadcrumb, Forum/Live Feed switcher, Global Search (Cmd+K), Drawer Toggles, Live SSE indicator.
import type { UiActions } from '../actions.ts'
import { el, firstLineTitle, svgIcon, type IconName } from '../dom.ts'
import { buildActorLabelMap, extractDmPeer, openFeedbackCount, type UiState } from '../state.ts'
import type { DrawerTab } from '../types.ts'

export function renderTopbar(state: UiState, actions: UiActions): HTMLElement {
  const bar = el('header', { className: 'cb-topbar' })

  const left = el('div', { className: 'cb-topbar-left' })

  // Mobile hamburger menu
  const mobMenu = el(
    'button',
    {
      type: 'button',
      className: 'cb-icon-btn cb-mobile-only',
      title: 'Toggle navigation',
      'aria-label': 'Toggle navigation',
    },
    svgIcon('menu', 18),
  )
  mobMenu.addEventListener('click', () => actions.toggleMobileSidebar())
  left.appendChild(mobMenu)

  // phpBB Breadcrumb bar
  const crumb = el('nav', { className: 'cb-breadcrumb', 'aria-label': 'Breadcrumb' })
  const rootBtn = el('button', { type: 'button', className: 'cb-crumb-btn' }, svgIcon('home', 14), el('span', { textContent: 'Board Index' }))
  rootBtn.addEventListener('click', () => actions.navigate({ kind: 'home' }))
  crumb.appendChild(rootBtn)

  const ws = state.workspace
  if (ws.kind === 'inbox') {
    crumb.appendChild(el('span', { className: 'cb-crumb-sep', textContent: '›' }))
    crumb.appendChild(el('span', { className: 'cb-crumb-current', textContent: 'Mentions & Inbox' }))
  } else if (ws.kind === 'pinned') {
    crumb.appendChild(el('span', { className: 'cb-crumb-sep', textContent: '›' }))
    crumb.appendChild(el('span', { className: 'cb-crumb-current', textContent: 'Pinned & Saved' }))
  } else if (ws.kind === 'decisions') {
    crumb.appendChild(el('span', { className: 'cb-crumb-sep', textContent: '›' }))
    crumb.appendChild(el('span', { className: 'cb-crumb-current', textContent: 'Needs You (Decisions)' }))
  } else if (ws.kind === 'channel' || ws.kind === 'thread') {
    const ch = ws.channel
    if (ch.startsWith('dm/')) {
      crumb.appendChild(el('span', { className: 'cb-crumb-sep', textContent: '›' }))
      crumb.appendChild(el('span', { className: 'cb-crumb-muted', textContent: 'Direct Messages' }))
      crumb.appendChild(el('span', { className: 'cb-crumb-sep', textContent: '›' }))
      const dmBtn = el('button', {
        type: 'button',
        className: ws.kind === 'channel' ? 'cb-crumb-current' : 'cb-crumb-btn',
        textContent: extractDmPeer(ch, state.me?.handle ?? null),
      })
      dmBtn.addEventListener('click', () => actions.openChannel(ch, 'chat'))
      crumb.appendChild(dmBtn)
    } else {
      const segs = ch.split('/')
      if (segs.length >= 2 && (segs[0] === 'repos' || segs[0] === 'swarms')) {
        crumb.appendChild(el('span', { className: 'cb-crumb-sep', textContent: '›' }))
        crumb.appendChild(el('span', { className: 'cb-crumb-muted', textContent: `${segs[0]}/${segs[1]}` }))
        crumb.appendChild(el('span', { className: 'cb-crumb-sep', textContent: '›' }))
        const rest = segs.slice(2).join('/') || ch
        const chBtn = el('button', {
          type: 'button',
          className: ws.kind === 'channel' ? 'cb-crumb-current' : 'cb-crumb-btn',
          textContent: `#${rest}`,
        })
        chBtn.addEventListener('click', () => actions.openChannel(ch, 'forum'))
        crumb.appendChild(chBtn)
      } else {
        crumb.appendChild(el('span', { className: 'cb-crumb-sep', textContent: '›' }))
        const chBtn = el('button', {
          type: 'button',
          className: ws.kind === 'channel' ? 'cb-crumb-current' : 'cb-crumb-btn',
          textContent: `#${ch}`,
        })
        chBtn.addEventListener('click', () => actions.openChannel(ch, 'forum'))
        crumb.appendChild(chBtn)
      }
    }
    if (ws.kind === 'thread') {
      crumb.appendChild(el('span', { className: 'cb-crumb-sep', textContent: '›' }))
      const tTitle = state.activeThread
        ? firstLineTitle(state.activeThread.message.text, 42, buildActorLabelMap(state))
        : `#${ws.threadId}`
      crumb.appendChild(el('span', { className: 'cb-crumb-current', textContent: tTitle }))
    }
  }
  left.appendChild(crumb)

  // View Switcher (Forum Index vs Live Feed) when in a non-DM channel
  if (ws.kind === 'channel' && !ws.channel.startsWith('dm/')) {
    const switcher = el('div', { className: 'cb-segmented', role: 'tablist', 'aria-label': 'Channel view mode' })
    const forumBtn = el('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': ws.mode === 'forum' ? 'true' : 'false',
      className: `cb-seg-btn${ws.mode === 'forum' ? ' is-active' : ''}`,
      textContent: 'Forum Index',
    })
    forumBtn.addEventListener('click', () => actions.openChannel(ws.channel, 'forum'))
    const chatBtn = el('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': ws.mode === 'chat' ? 'true' : 'false',
      className: `cb-seg-btn${ws.mode === 'chat' ? ' is-active' : ''}`,
      textContent: 'Live Feed',
    })
    chatBtn.addEventListener('click', () => actions.openChannel(ws.channel, 'chat'))
    switcher.appendChild(forumBtn)
    switcher.appendChild(chatBtn)
    left.appendChild(switcher)
  }

  bar.appendChild(left)

  // Right utility bar
  const right = el('div', { className: 'cb-topbar-right' })

  // Global search button (Cmd+K)
  const searchBtn = el(
    'button',
    {
      type: 'button',
      className: 'cb-search-trigger',
      title: 'Search board (⌘K / Ctrl+K)',
    },
    svgIcon('search', 14),
    el('span', { className: 'cb-search-placeholder', textContent: 'Search board…' }),
    el('kbd', { className: 'cb-kbd', textContent: '⌘K' }),
  )
  searchBtn.addEventListener('click', () => {
    const ch = ws.kind === 'channel' || ws.kind === 'thread' ? ws.channel : undefined
    actions.openModal({ kind: 'search', ...(ch ? { channel: ch } : {}) })
  })
  right.appendChild(searchBtn)

  // Drawer toggles
  const addDrawerBtn = (tab: DrawerTab, label: string, icon: IconName, count?: number): void => {
    const active = state.drawerOpen && state.drawerTab === tab
    const btn = el(
      'button',
      {
        type: 'button',
        className: `cb-util-btn${active ? ' is-active' : ''}`,
        title: `${label} drawer`,
        'aria-label': label,
      },
      svgIcon(icon, 15),
      el('span', { className: 'cb-util-label', textContent: label }),
      count !== undefined && count > 0
        ? el('span', { className: 'cb-util-count', textContent: String(count) })
        : null,
    )
    btn.addEventListener('click', () => actions.toggleDrawer(tab))
    right.appendChild(btn)
  }

  const openTaskCount = state.tasks.filter((t) => {
    const st = t.message.task?.state
    return st === 'ready' || st === 'claimed' || st === 'blocked' || st === 'waiting'
  }).length

  addDrawerBtn('pins', 'Pins', 'pin', state.channelPins.length || state.allPins.length)
  addDrawerBtn('groups', 'Groups', 'users', state.groups.length)
  addDrawerBtn('tasks', 'Tasks', 'tasks', openTaskCount)
  addDrawerBtn('feedback', 'Feedback', 'bug', openFeedbackCount(state))

  // SSE live connection indicator
  const sseChip = el(
    'button',
    {
      type: 'button',
      className: `cb-sse-chip is-${state.sseStatus}`,
      title: 'Real-time SSE stream status (click to refresh)',
    },
    el('span', { className: `cb-dot cb-dot-${state.sseStatus === 'live' ? 'active' : 'busy'}` }),
    el('span', {
      textContent: state.sseStatus === 'live' ? 'Live' : state.sseStatus === 'connecting' ? 'Syncing' : 'Reconnecting',
    }),
  )
  sseChip.addEventListener('click', () => {
    void actions.refreshAll()
  })
  right.appendChild(sseChip)

  bar.appendChild(right)
  return bar
}
