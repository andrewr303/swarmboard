// phpBB + Twist Forum Index View:
// Channel Header -> ANNOUNCEMENTS band -> STICKY / PINNED topics -> ACTIVE THREADS table -> WHO IS ONLINE + PERMISSIONS footer.
import type { UiActions } from '../actions.ts'
import {
  avatarHue,
  avatarMonogram,
  el,
  excerptText,
  firstLineTitle,
  formatRelativeTime,
  svgIcon,
} from '../dom.ts'
import { buildActorLabelMap, partitionForumThreads, type UiState } from '../state.ts'
import { renderTaskProgress } from './drawer.ts'
import type { UiThreadSummaryView } from '../types.ts'

export function renderForumIndex(channelPath: string, state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-forum-view' })
  const chMeta = state.flatChannels.find((c) => c.path === channelPath) ?? null

  // Channel header strip (phpBB + Twist)
  const header = el('div', { className: 'cb-channel-banner' })
  const headRight = el('div', { className: 'cb-channel-toolbar' })
  const filterInput = el('input', {
    type: 'search',
    className: 'cb-input cb-input-sm',
    'data-focus-key': 'channel-filter',
    placeholder: 'Search this channel…',
    value: state.channelFilter,
    'aria-label': 'Filter threads in channel',
  })
  filterInput.addEventListener('input', () => actions.setChannelFilter(filterInput.value))
  headRight.appendChild(filterInput)

  const markReadBtn = el(
    'button',
    { type: 'button', className: 'cb-btn cb-btn-ghost', title: 'Mark all threads in this channel read' },
    svgIcon('check', 14),
    el('span', { textContent: 'Mark read' }),
  )
  markReadBtn.addEventListener('click', () => {
    void actions.markChannelRead(channelPath)
  })
  headRight.appendChild(markReadBtn)

  if (chMeta?.kind === 'tasks' || channelPath.includes('work')) {
    const newTaskBtn = el(
      'button',
      { type: 'button', className: 'cb-btn cb-btn-secondary' },
      svgIcon('tasks', 14),
      el('span', { textContent: '+ New Task' }),
    )
    newTaskBtn.addEventListener('click', () => actions.openModal({ kind: 'new-task', channel: channelPath }))
    headRight.appendChild(newTaskBtn)
  }

  const newThreadBtn = el(
    'button',
    { type: 'button', className: 'cb-btn cb-btn-primary' },
    svgIcon('plus', 14),
    el('span', { textContent: 'New Thread' }),
  )
  newThreadBtn.addEventListener('click', () => actions.openModal({ kind: 'new-thread', channel: channelPath }))
  headRight.appendChild(newThreadBtn)

  header.appendChild(headRight)
  wrap.appendChild(header)

  // Filter threads locally when user types in channel filter
  const q = state.channelFilter.trim().toLowerCase()
  const filtered = q
    ? state.channelThreads.filter((t) => {
        const author = t.message.author?.handle ?? t.message.by.actor
        return (
          t.message.text.toLowerCase().includes(q) ||
          author.toLowerCase().includes(q) ||
          (t.last?.text.toLowerCase().includes(q) ?? false) ||
          Object.entries(t.message.labels).some(([k, v]) => `${k}=${v}`.toLowerCase().includes(q))
        )
      })
    : state.channelThreads

  const taskChannel = chMeta?.kind === 'tasks'
  const { announcements, stickies, regular } = partitionForumThreads(
    taskChannel ? filtered.filter(t => !t.message.task || t.pin) : filtered,
  )

  // Include global announcements pinned across the board when viewing a non-announcement channel
  const channelAnnouncementIds = new Set(announcements.map((a) => a.message.id))
  const extraGlobalAnnouncements = state.allPins.filter(
    (p) => p.scope === 'announcement' && p.message !== undefined && !channelAnnouncementIds.has(p.messageId),
  )

  const body = el('div', { className: 'cb-forum-scroll' })
  if (taskChannel) {
    body.appendChild(renderTaskProgress(filtered, state, actions, 'channel'))
  }
  const actorLabels = buildActorLabelMap(state)

  // Band 1: ANNOUNCEMENTS (phpBB style)
  if (announcements.length > 0 || extraGlobalAnnouncements.length > 0) {
    const band = el('section', { className: 'cb-forum-band cb-band-announcements' })
    band.appendChild(renderForumBandHeader('Announcements', 'megaphone'))
    for (const t of announcements) {
      band.appendChild(renderThreadRow(t, 'announcement', actions, actorLabels))
    }
    for (const p of extraGlobalAnnouncements) {
      if (!p.message) continue
      const synthetic: UiThreadSummaryView = {
        message: p.message,
        replies: 0,
        last: null,
        pin: {
          scope: 'announcement',
          note: p.note,
          pinnedBy: p.pinnedBy,
          pinnedAt: p.pinnedAt,
        },
      }
      band.appendChild(renderThreadRow(synthetic, 'announcement', actions, actorLabels, p.channel !== channelPath ? p.channel : undefined))
    }
    body.appendChild(band)
  }

  // Band 2: STICKY / PINNED TOPICS
  if (stickies.length > 0) {
    const band = el('section', { className: 'cb-forum-band cb-band-sticky' })
    band.appendChild(renderForumBandHeader('Sticky / Pinned Topics', 'pin'))
    for (const t of stickies) {
      band.appendChild(renderThreadRow(t, 'sticky', actions, actorLabels))
    }
    body.appendChild(band)
  }

  // Band 3: ACTIVE THREADS
  const activeBand = el('section', { className: 'cb-forum-band cb-band-topics' })
  activeBand.appendChild(renderForumBandHeader(`Active Threads (${regular.length})`, 'forum'))
  if (regular.length === 0) {
    const empty = el('div', { className: 'cb-empty-state' })
    empty.appendChild(
      el('p', {
        textContent: q
          ? `No threads match "${state.channelFilter}".`
          : `No threads in #${channelPath} yet. Start a structured thread or switch to Live Feed.`,
      }),
    )
    const startBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-primary', textContent: '+ Start First Thread' })
    startBtn.addEventListener('click', () => actions.openModal({ kind: 'new-thread', channel: channelPath }))
    empty.appendChild(startBtn)
    activeBand.appendChild(empty)
  } else {
    for (const t of regular) {
      activeBand.appendChild(renderThreadRow(t, 'normal', actions, actorLabels))
    }
  }
  if (!taskChannel || regular.length > 0) body.appendChild(activeBand)

  // phpBB Footer Strip: WHO IS ONLINE + PERMISSIONS
  body.appendChild(renderForumFooter(channelPath, state, actions))
  wrap.appendChild(body)
  return wrap
}

function renderForumBandHeader(title: string, icon: 'megaphone' | 'pin' | 'forum'): HTMLElement {
  return el(
    'div',
    { className: 'cb-band-header' },
    el('div', { className: 'cb-band-title' }, svgIcon(icon, 14), el('span', { textContent: title })),
    el('div', { className: 'cb-band-cols' }, el('span', { className: 'cb-col-replies', textContent: 'REPLIES' }), el('span', { className: 'cb-col-last', textContent: 'LAST POST' })),
  )
}

function renderThreadRow(
  t: UiThreadSummaryView,
  tier: 'announcement' | 'sticky' | 'normal',
  actions: UiActions,
  actorLabels: ReadonlyMap<string, string>,
  originChannelBadge?: string,
): HTMLElement {
  const msg = t.message
  const authorHandle = msg.author?.handle ?? msg.by.profile ?? msg.by.actor.replace(/^local:user:/, '')
  const isHuman = msg.author?.kind === 'person'
  const isFlagged = msg.labels['flag.status'] === 'open'

  const row = el('div', {
    className: `cb-thread-row cb-tier-${tier}${isFlagged ? ' is-flagged' : ''}`,
    role: 'button',
    tabindex: '0',
  })
  const open = (): void => actions.openThread(msg.channel, msg.id)
  row.addEventListener('click', open)
  row.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      open()
    }
  })

  // Leading tier icon
  const iconWrap = el(
    'div',
    { className: `cb-row-icon cb-row-icon-${tier}` },
    svgIcon(tier === 'announcement' ? 'megaphone' : tier === 'sticky' ? 'pin' : msg.task ? 'tasks' : 'forum', 15),
  )
  row.appendChild(iconWrap)

  // Main title, badges & snippet
  const main = el('div', { className: 'cb-row-main' })
  const titleLine = el('div', { className: 'cb-row-title-line' })
  if (tier === 'announcement') {
    titleLine.appendChild(el('span', { className: 'cb-tag cb-tag-announce', textContent: 'ANNOUNCEMENT' }))
  } else if (tier === 'sticky') {
    titleLine.appendChild(el('span', { className: 'cb-tag cb-tag-sticky', textContent: 'STICKY' }))
  }
  if (originChannelBadge) {
    titleLine.appendChild(el('span', { className: 'cb-tag cb-tag-channel', textContent: `#${originChannelBadge}` }))
  }
  if (msg.task) {
    titleLine.appendChild(
      el('span', { className: `cb-task-pill cb-task-${msg.task.state}`, textContent: msg.task.state.toUpperCase() }),
    )
  }
  if (isFlagged) {
    titleLine.appendChild(el('span', { className: 'cb-tag cb-tag-flag', textContent: 'REPORTED' }))
  }
  titleLine.appendChild(el('span', { className: 'cb-row-title', textContent: firstLineTitle(msg.text, 110, actorLabels) }))
  main.appendChild(titleLine)

  const subLine = el('div', { className: 'cb-row-meta' })
  subLine.appendChild(el('span', { textContent: 'by ' }))
  subLine.appendChild(
    el('span', {
      className: isHuman ? 'cb-author-human' : 'cb-author-agent',
      textContent: authorHandle,
    }),
  )
  subLine.appendChild(
    el('span', {
      className: `cb-role-chip ${isHuman ? 'cb-role-human' : 'cb-role-agent'}`,
      textContent: isHuman ? 'HUMAN' : 'AGENT',
    }),
  )
  subLine.appendChild(el('span', { className: 'cb-meta-dot', textContent: '·' }))
  subLine.appendChild(el('span', { textContent: formatRelativeTime(msg.createdAt) }))

  // Labels (non-internal)
  for (const [k, v] of Object.entries(msg.labels)) {
    if (k.startsWith('board.') || k.startsWith('flag.')) continue
    subLine.appendChild(el('span', { className: 'cb-label-chip', textContent: `${k}=${v}` }))
  }
  if (t.pin?.note) {
    subLine.appendChild(el('span', { className: 'cb-pin-note-chip', textContent: t.pin.note }))
  }
  main.appendChild(subLine)

  if (t.last) {
    const lastBy = t.last.author?.handle ?? t.last.by.profile ?? t.last.by.actor.replace(/^local:user:/, '')
    main.appendChild(
      el('div', {
        className: 'cb-row-snippet',
        textContent: `Latest (${lastBy}): ${excerptText(t.last.text, 120, actorLabels)}`,
      }),
    )
  }
  row.appendChild(main)

  // Replies + participants column
  const statsCol = el('div', { className: 'cb-col-replies cb-row-stats' })
  statsCol.appendChild(el('div', { className: 'cb-reply-count', textContent: String(t.replies) }))
  if (t.participants && t.participants.length > 0) {
    const avRow = el('div', { className: 'cb-mini-avatars' })
    for (const p of t.participants.slice(0, 3)) {
      const av = el('span', { className: 'cb-mini-av', textContent: avatarMonogram(p), title: p })
      av.style.setProperty('--av-hue', String(avatarHue(p)))
      avRow.appendChild(av)
    }
    statsCol.appendChild(avRow)
  }
  row.appendChild(statsCol)

  // Last post column
  const lastPost = t.last ?? msg
  const lastAuthor = lastPost.author?.handle ?? lastPost.by.profile ?? lastPost.by.actor.replace(/^local:user:/, '')
  const lastCol = el('div', { className: 'cb-col-last cb-row-last' })
  lastCol.appendChild(el('div', { className: 'cb-last-by', textContent: `by ${lastAuthor}` }))
  lastCol.appendChild(el('div', { className: 'cb-last-at', textContent: formatRelativeTime(lastPost.createdAt) }))
  row.appendChild(lastCol)

  return row
}

function renderForumFooter(channelPath: string, state: UiState, actions: UiActions): HTMLElement {
  const foot = el('footer', { className: 'cb-forum-footer' })

  const onlineBox = el('div', { className: 'cb-forum-foot-block' })
  const onlinePeers = state.presence.filter((p) => p.status !== 'offline')
  onlineBox.appendChild(
    el('div', { className: 'cb-foot-title', textContent: `WHO IS ONLINE (${onlinePeers.length})` }),
  )
  const peerLine = el('div', { className: 'cb-online-chips' })
  if (onlinePeers.length === 0) {
    peerLine.appendChild(el('span', { className: 'cb-muted-note', textContent: 'No active agents online' }))
  } else {
    for (const p of onlinePeers) {
      const short = p.profile ?? p.handle.replace(/^.*\//, '')
      const chip = el(
        'button',
        {
          type: 'button',
          className: `cb-online-pill${p.channel === channelPath ? ' is-here' : ''}`,
          title: [p.handle, p.harness, p.model, p.channel ? `#${p.channel}` : null].filter(Boolean).join(' · '),
        },
        el('span', { className: `cb-dot cb-dot-${p.status}` }),
        el('span', { textContent: short }),
        p.model ? el('span', { className: 'cb-online-model', textContent: p.model }) : null,
      )
      chip.addEventListener('click', () => {
        void actions.openOrCreateDm(short)
      })
      peerLine.appendChild(chip)
    }
  }
  onlineBox.appendChild(peerLine)
  foot.appendChild(onlineBox)

  // Permissions summary (phpBB homage)
  const permBox = el('div', { className: 'cb-forum-foot-block' })
  permBox.appendChild(el('div', { className: 'cb-foot-title', textContent: 'CHANNEL PERMISSIONS' }))
  const meHandle = state.me?.handle ?? 'local'
  const meKind = state.me?.kind === 'person' ? 'Human Owner' : 'Agent'
  const canKeys = state.me ? Object.keys(state.me.can) : []
  permBox.appendChild(
    el('div', {
      className: 'cb-foot-perms',
      textContent: `Signed in as ${meHandle} (${meKind}) • Grants: ${canKeys.length > 0 ? canKeys.join(', ') : 'full local access'} • Can post, reply, pin, react, flag & manage tasks.`,
    }),
  )
  foot.appendChild(permBox)

  return foot
}
