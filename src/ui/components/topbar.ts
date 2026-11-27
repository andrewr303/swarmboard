import type { UiActions } from '../actions.ts'
import { el, svgIcon, type IconName } from '../dom.ts'
import { extractDmPeer, type UiState } from '../state.ts'

export function renderTopbar(state: UiState, actions: UiActions): HTMLElement {
  const bar = el('header', { className: 'cb-topbar' })
  const left = el('div', { className: 'cb-topbar-left' })
  const right = el('div', { className: 'cb-topbar-right' })

  function control(label: string, icon: IconName, click: () => void, extraClass = ''): HTMLButtonElement {
    const button = el('button', {
      type: 'button',
      className: `cb-icon-btn ${extraClass}`,
      title: label,
      'aria-label': label,
    }, svgIcon(icon, 16))
    button.addEventListener('click', click)
    return button
  }

  const menu = control('Toggle navigation', 'menu', () => actions.toggleMobileSidebar(), 'cb-mobile-only')
  menu.setAttribute('aria-expanded', String(state.mobileSidebarOpen))
  left.appendChild(menu)

  const ws = state.workspace
  const context = el('div', { className: 'cb-header-context' })
  if (ws.kind === 'channel' || ws.kind === 'thread') {
    const channel = state.flatChannels.find((entry) => entry.path === ws.channel)
    const dm = ws.channel.startsWith('dm/')
    const name = dm ? extractDmPeer(ws.channel, state.me?.handle ?? null) : ws.channel.replace(/^(repos|swarms)\/[^/]+\//, '')
    const icon = svgIcon(dm ? 'dm' : 'hash', 16)
    if (ws.kind === 'thread') {
      const back = el('button', { type: 'button', className: 'cb-channel-name', title: `Back to ${ws.channel}` }, icon, name)
      back.addEventListener('click', () => actions.openChannel(ws.channel))
      context.appendChild(back)
    } else {
      context.appendChild(el('h1', { className: 'cb-channel-name', title: ws.channel }, icon, name))
    }
    const online = new Set(state.presence.filter((p) => p.channel === ws.channel && p.status !== 'offline').map((p) => p.agent))
    const detail = [channel?.topic, online.size > 0 ? `${online.size} online here` : ''].filter(Boolean).join(' · ')
    if (detail) context.appendChild(el('div', { className: 'cb-channel-topic', textContent: detail, title: detail }))

    if (ws.kind === 'channel' && !dm) {
      const forum = ws.mode === 'forum'
      const viewLabel = forum ? 'Live feed' : 'Threads'
      const switcher = control(`Show ${viewLabel.toLowerCase()}`, forum ? 'hash' : 'forum', () =>
        actions.openChannel(ws.channel, forum ? 'chat' : 'forum'))
      switcher.appendChild(el('span', { className: 'cb-view-label', textContent: viewLabel }))
      switcher.classList.add('cb-view-switch')
      right.appendChild(switcher)
    }
    if (ws.kind === 'channel' && ws.mode === 'chat') {
      right.appendChild(control('Mark channel read', 'check', () => { void actions.markChannelRead(ws.channel) }))
    }
  } else {
    const names = { home: 'Workspace', inbox: 'Inbox', pinned: 'Saved posts', decisions: 'Decisions' }
    context.appendChild(el('div', { className: 'cb-channel-name', textContent: names[ws.kind] }))
  }

  left.appendChild(context)
  const pins = control('Pinned posts', 'pin', () => actions.toggleDrawer('pins'))
  pins.setAttribute('aria-pressed', String(state.drawerOpen && state.drawerTab === 'pins'))
  right.appendChild(pins)
  const details = control('People and activity', 'users', () => actions.toggleDrawer('room'))
  details.setAttribute('aria-expanded', String(state.drawerOpen && state.drawerTab === 'room'))
  right.appendChild(details)
  bar.append(left, right)
  return bar
}
