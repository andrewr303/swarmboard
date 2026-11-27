// Right Contextual Drawer: Switchable between Pinned Posts, @Groups/Teams, Tasks, and Beta Feedback Triage.
import type { UiActions } from '../actions.ts'
import { avatarMonogram, el, excerptText, firstLineTitle, formatRelativeTime, svgIcon } from '../dom.ts'
import { buildActorLabelMap, canReopenTaskState, type UiState } from '../state.ts'
import type { DrawerTab, TaskState, UiGroupView, UiMessageView, UiPinView, UiThreadSummaryView } from '../types.ts'

export function renderRightDrawer(state: UiState, actions: UiActions): HTMLElement {
  const drawer = el('aside', {
    className: `cb-drawer${state.drawerOpen ? ' is-open' : ''}`,
    'aria-label': 'Contextual drawer',
  })
  if (!state.drawerOpen) {
    drawer.inert = true
    drawer.setAttribute('aria-hidden', 'true')
    return drawer
  }

  // Tab bar
  const tabs = el('div', { className: 'cb-drawer-tabs', role: 'tablist' })
  const addTab = (tab: DrawerTab, label: string): void => {
    const active = state.drawerTab === tab
    const b = el('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': active ? 'true' : 'false',
      className: `cb-drawer-tab${active ? ' is-active' : ''}`,
      textContent: label,
    })
    b.addEventListener('click', () => {
      if (!state.drawerOpen) actions.toggleDrawer(tab)
      else if (state.drawerTab !== tab) actions.toggleDrawer(tab)
    })
    tabs.appendChild(b)
  }

  addTab('room', 'People')
  addTab('pins', 'Pins')
  addTab('groups', 'Groups')
  addTab('tasks', 'Tasks')
  addTab('feedback', 'Feedback')

  const closeBtn = el(
    'button',
    { type: 'button', className: 'cb-icon-btn cb-drawer-close', title: 'Close drawer', 'aria-label': 'Close drawer' },
    svgIcon('close', 15),
  )
  closeBtn.addEventListener('click', () => actions.toggleDrawer())
  tabs.appendChild(closeBtn)
  drawer.appendChild(tabs)

  const body = el('div', { className: 'cb-drawer-body' })
  switch (state.drawerTab) {
    case 'room':
      body.appendChild(renderRoomPanel(state, actions))
      break
    case 'pins':
      body.appendChild(renderPinsDrawerTab(state, actions))
      break
    case 'groups':
      body.appendChild(renderGroupsDrawerTab(state, actions))
      break
    case 'tasks':
      body.appendChild(renderTasksDrawerTab(state, actions))
      break
    case 'feedback':
      body.appendChild(renderFeedbackDrawerTab(state, actions))
      break
  }
  drawer.appendChild(body)
  return drawer
}

function renderRoomPanel(state: UiState, actions: UiActions): HTMLElement {
  const ws = state.workspace
  const channel = ws.kind === 'channel' || ws.kind === 'thread' ? ws.channel : null
  const peers = state.presence.filter(peer => peer.status !== 'offline' && (!channel || peer.channel === channel))
  const panel = el('div', { className: 'cb-room-panel' })
  panel.appendChild(el('h2', { textContent: channel ? 'In this channel' : 'Online now' }))
  if (!peers.length) panel.appendChild(el('p', { className: 'cb-muted-note', textContent: 'No one is showing as online.' }))
  for (const peer of peers) {
    const name = peer.profile ?? peer.handle
    const row = el('button', { type: 'button', className: 'cb-room-peer', title: `Message @${peer.handle}` },
      el('span', { className: 'cb-avatar cb-avatar-sm', 'aria-hidden': 'true', textContent: avatarMonogram(name) }),
      el('span', { textContent: name }), el('span', { className: 'cb-room-status', textContent: peer.status }))
    row.addEventListener('click', () => { void actions.openOrCreateDm(peer.agent) })
    panel.appendChild(row)
  }
  if (!channel) return panel
  const messages = ws.kind === 'thread' && state.activeThread
    ? [state.activeThread.message, ...state.activeThread.replies]
    : state.channelMessages.length ? state.channelMessages : state.channelThreads.map(thread => thread.last ?? thread.message)
  const recent = messages.filter(m => !m.deleted && m.channel === channel)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12)
  panel.appendChild(el('h2', { textContent: 'Recent activity' }))
  if (!recent.length) panel.appendChild(el('p', { className: 'cb-muted-note', textContent: 'No recent messages.' }))
  for (const msg of recent) {
    const row = el('button', { type: 'button', className: 'cb-room-event' },
      el('strong', { textContent: msg.author?.name ?? msg.by.profile ?? msg.by.actor }),
      el('time', { datetime: msg.createdAt, textContent: formatRelativeTime(msg.createdAt) }),
      el('span', { textContent: excerptText(msg.text, 120) || 'Attachment' }))
    row.addEventListener('click', () => actions.openThread(channel, msg.re ?? msg.id))
    panel.appendChild(row)
  }
  return panel
}

function renderPinsDrawerTab(state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-drawer-panel' })
  const ws = state.workspace
  const inChannel = ws.kind === 'channel' || ws.kind === 'thread'
  const pins: readonly UiPinView[] = inChannel && state.channelPins.length > 0 ? state.channelPins : state.allPins

  wrap.appendChild(
    el(
      'div',
      { className: 'cb-drawer-head' },
      el('h2', { textContent: inChannel ? `Pins (${pins.length})` : `All Board Pins (${pins.length})` }),
    ),
  )

  if (pins.length === 0) {
    wrap.appendChild(el('div', { className: 'cb-empty-sm', textContent: 'No pinned posts yet. Pin any thread or message from its toolbar.' }))
    return wrap
  }

  for (const pin of pins) {
    const card = el('div', { className: 'cb-drawer-card' })
    const top = el('div', { className: 'cb-card-top' })
    top.appendChild(
      el('span', {
        className: `cb-tag ${pin.scope === 'announcement' ? 'cb-tag-announce' : pin.scope === 'channel' ? 'cb-tag-sticky' : 'cb-tag-channel'}`,
        textContent: pin.scope.toUpperCase(),
      }),
    )
    top.appendChild(el('span', { className: 'cb-card-meta', textContent: `#${pin.channel}` }))
    card.appendChild(top)

    const preview = pin.message ? excerptText(pin.message.text, 130) : `Message #${pin.messageId}`
    card.appendChild(el('div', { className: 'cb-card-title', textContent: preview }))
    if (pin.note) {
      card.appendChild(el('div', { className: 'cb-card-sub', textContent: `Note: ${pin.note}` }))
    }

    const foot = el('div', { className: 'cb-card-foot' })
    foot.appendChild(el('span', { className: 'cb-card-meta', textContent: formatRelativeTime(pin.pinnedAt) }))
    const acts = el('div', { className: 'cb-card-acts' })
    const jump = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs', textContent: 'Open' })
    jump.addEventListener('click', () => actions.openThread(pin.channel, pin.rootId))
    const unpin = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs', textContent: 'Unpin' })
    unpin.addEventListener('click', () => {
      void actions.unpinMessage(pin.messageId, pin.scope)
    })
    acts.appendChild(jump)
    acts.appendChild(unpin)
    foot.appendChild(acts)
    card.appendChild(foot)
    wrap.appendChild(card)
  }

  return wrap
}

function renderGroupsDrawerTab(state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-drawer-panel' })
  const head = el('div', { className: 'cb-drawer-head' })
  head.appendChild(el('h2', { textContent: `@Groups & Teams (${state.groups.length})` }))
  const newBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-xs', textContent: '+ Create' })
  newBtn.addEventListener('click', () => actions.openModal({ kind: 'new-group' }))
  head.appendChild(newBtn)
  wrap.appendChild(head)

  if (state.groups.length === 0) {
    wrap.appendChild(el('div', { className: 'cb-empty-sm', textContent: 'No @groups created yet. Create a team like @swarmteam3 or @reviewers.' }))
    return wrap
  }

  for (const g of state.groups) {
    wrap.appendChild(renderGroupCard(g, actions))
  }
  return wrap
}

function renderGroupCard(group: UiGroupView, actions: UiActions): HTMLElement {
  const card = el('div', { className: 'cb-drawer-card' })
  const top = el('div', { className: 'cb-card-top' })
  top.appendChild(el('span', { className: 'cb-pill cb-pill-group', textContent: `@${group.handle}` }))
  top.appendChild(el('span', { className: 'cb-kind-pill', textContent: group.kind }))
  card.appendChild(top)

  card.appendChild(el('div', { className: 'cb-card-title', textContent: group.name }))
  if (group.description) {
    card.appendChild(el('div', { className: 'cb-card-sub', textContent: group.description }))
  }

  // Member chips with quick remove
  const memWrap = el('div', { className: 'cb-member-chips' })
  if (group.members.length === 0) {
    memWrap.appendChild(el('span', { className: 'cb-muted-note', textContent: 'No members yet' }))
  } else {
    for (const m of group.members) {
      const chip = el('span', { className: 'cb-member-chip' })
      chip.appendChild(el('span', { textContent: m.memberId.replace(/^local:user:/, '') }))
      const rm = el('button', {
        type: 'button',
        className: 'cb-tag-remove',
        title: `Remove ${m.memberId}`,
        textContent: '×',
      })
      rm.addEventListener('click', () => {
        void actions.removeGroupMember(group.handle, m.memberId)
      })
      chip.appendChild(rm)
      memWrap.appendChild(chip)
    }
  }
  card.appendChild(memWrap)

  // Quick add member form
  const addRow = el('form', { className: 'cb-inline-form' })
  const inp = el('input', {
    type: 'text',
    className: 'cb-input cb-input-xs',
    placeholder: 'Add member (e.g. codex)…',
    'aria-label': `Add member to ${group.handle}`,
  })
  const addBtn = el('button', { type: 'submit', className: 'cb-btn cb-btn-secondary cb-btn-xs', textContent: 'Add' })
  addRow.appendChild(inp)
  addRow.appendChild(addBtn)
  addRow.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const val = inp.value.trim()
    if (!val) return
    inp.value = ''
    void actions.addGroupMember(group.handle, val)
  })
  card.appendChild(addRow)

  const foot = el('div', { className: 'cb-card-foot' })
  const tagBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs', textContent: 'Tag in composer' })
  tagBtn.addEventListener('click', () => actions.addComposerTag(`@${group.handle}`))
  foot.appendChild(tagBtn)
  const rightActs = el('div', { className: 'cb-card-acts' })
  const editBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs', textContent: 'Edit' })
  editBtn.addEventListener('click', () => actions.openModal({ kind: 'edit-group', group }))
  rightActs.appendChild(editBtn)
  if (group.kind !== 'system') {
    const delBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs cb-act-danger', textContent: 'Delete' })
    delBtn.addEventListener('click', () => {
      void actions.deleteGroup(group.handle)
    })
    rightActs.appendChild(delBtn)
  }
  foot.appendChild(rightActs)
  card.appendChild(foot)

  return card
}

function renderTasksDrawerTab(state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-drawer-panel' })
  const head = el('div', { className: 'cb-drawer-head' })
  head.appendChild(el('h2', { textContent: `Tasks (${state.tasks.length})` }))
  const newBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-xs', textContent: '+ Task' })
  newBtn.addEventListener('click', () => {
    const ch =
      state.workspace.kind === 'channel' || state.workspace.kind === 'thread'
        ? state.workspace.channel
        : state.flatChannels.find(channel => channel.kind === 'tasks' && !channel.archived)?.path ?? 'work/swarmboard'
    actions.openModal({ kind: 'new-task', channel: ch })
  })
  head.appendChild(newBtn)
  wrap.appendChild(head)

  wrap.appendChild(renderTaskProgress(state.tasks, state, actions, 'drawer'))
  return wrap
}

function taskMatchesFilter(status: TaskState, filter: UiState['taskFilter']): boolean {
  const closed = status === 'completed' || status === 'failed' || status === 'canceled'
  if (filter === 'done') return closed
  if (filter === 'open') return !closed
  return filter === 'all' || filter === status
}

// Matches the effective permission summary returned by /me: exact channel, closest subtree, then global.
export function canManageProgressTask(msg: UiMessageView, me: UiState['me']): boolean {
  if (!me || !msg.task) return false
  const channel = msg.channel
  const prefixes = Object.keys(me.can)
    .filter((key) => key.endsWith('/') && (channel.startsWith(key) || key === channel + '/'))
    .sort((a, b) => b.length - a.length)
  const permissions = me.can[channel] ?? me.can[prefixes[0] ?? '*'] ?? me.can['*']
  if (!Array.isArray(permissions)) return false
  const owner = msg.task.owner === me.principal && (me.actor === me.principal || msg.task.by === me.actor)
  return permissions.includes('manage') || (owner && (permissions.includes('post') || permissions.includes('label')))
}

export function renderTaskProgress(
  records: readonly UiThreadSummaryView[], state: UiState, actions: UiActions, scope: 'drawer' | 'channel',
): HTMLElement {
  const items = records.filter(item => item.message.task)
  const wrap = el('section', { className: `cb-task-progress cb-progress-${scope}`, 'aria-label': 'Task progress' })
  const runs = [...new Set(items.map(({ message }) => message.labels['run']).filter((run): run is string => !!run))].sort()
  const run = state.taskProgressRun && runs.includes(state.taskProgressRun) ? state.taskProgressRun : null
  const tasks = items.filter(({ message }) => !run || message.labels['run'] === run)
  const doneCount = (rows: readonly UiThreadSummaryView[]): number =>
    rows.filter(({ message }) => message.task?.state === 'completed').length
  const completed = doneCount(tasks)
  const head = el('header', { className: 'cb-progress-head' })
  head.appendChild(el('h3', { textContent: 'Task progress' }))
  if (runs.length) {
    const select = el('select', { 'aria-label': 'Filter progress by run', 'data-focus-key': `progress-run-${scope}`, className: 'cb-progress-select' })
    select.appendChild(el('option', { value: '', textContent: 'All runs' }))
    for (const name of runs) select.appendChild(el('option', { value: name, textContent: name }))
    select.value = run ?? ''
    select.addEventListener('change', () => actions.setTaskProgressRun(select.value || null))
    head.appendChild(select)
  }
  wrap.appendChild(head)
  if (!tasks.length) {
    wrap.appendChild(el('p', { className: 'cb-progress-meta', textContent: 'No tasks in this selection.' }))
    return wrap
  }

  const meter = el('progress', { max: tasks.length, value: completed, 'aria-label': 'Loaded tasks completed' })
  wrap.appendChild(el('div', { className: 'cb-progress-total' }, meter,
    el('span', { textContent: `${completed} of ${tasks.length} loaded tasks completed` })))
  if (scope === 'drawer') {
    const filters = el('div', { className: 'cb-filter-pills', 'aria-label': 'Visible task states' })
    for (const f of ['all', 'open', 'ready', 'claimed', 'blocked', 'done'] as const) {
      const button = el('button', {
        type: 'button', className: `cb-filter-pill${state.taskFilter === f ? ' is-active' : ''}`,
        'aria-pressed': String(state.taskFilter === f), textContent: f === 'done' ? 'Closed' : f[0]!.toUpperCase() + f.slice(1),
      })
      button.addEventListener('click', () => actions.setTaskFilter(f))
      filters.appendChild(button)
    }
    wrap.appendChild(filters)
  }

  const phases = new Map<string | null, UiThreadSummaryView[]>()
  for (const task of [...tasks].sort((a, b) => Number(a.message.id) - Number(b.message.id))) {
    const phase = task.message.labels['phase'] || null
    const group = phases.get(phase)
    if (group) group.push(task)
    else phases.set(phase, [task])
  }
  const list = el('div', { className: 'cb-progress-phases' })
  const actorLabels = buildActorLabelMap(state)
  for (const [phase, rows] of phases) {
    const visible = rows.filter(({ message }) => scope === 'channel' || taskMatchesFilter(message.task!.state, state.taskFilter))
    if (!visible.length) continue
    const key = JSON.stringify(['progress', scope, rows[0]!.message.channel, run, phase])
    const open = !state.collapsedGroups[key]
    const title = phase ?? 'Unphased'
    const group = el('section', { className: 'cb-progress-phase', 'aria-label': title })
    const toggle = el('button', {
      type: 'button', className: 'cb-progress-phase-head', 'aria-expanded': String(open),
    }, svgIcon(open ? 'chevron-down' : 'chevron-right', 13), el('strong', { textContent: title }),
      el('span', { textContent: `${doneCount(rows)}/${rows.length}`, title: 'Completed / loaded tasks in phase' }))
    toggle.addEventListener('click', () => actions.toggleGroupCollapse(key))
    group.appendChild(toggle)
    if (open) {
      for (const row of visible) group.appendChild(renderProgressRow(row, state, actions, actorLabels))
    }
    list.appendChild(group)
  }
  if (!list.childElementCount) list.appendChild(el('p', { className: 'cb-progress-meta', textContent: 'No tasks match this state filter.' }))
  wrap.appendChild(list)
  return wrap
}

function renderProgressRow(
  item: UiThreadSummaryView, state: UiState, actions: UiActions, labels: ReadonlyMap<string, string>,
): HTMLElement {
  const msg = item.message
  const task = msg.task!
  const row = el('div', { className: `cb-progress-row is-${task.state}` })
  const title = firstLineTitle(msg.text, 120, labels)
  const thread = el('button', {
    type: 'button', className: 'cb-progress-thread', title: `Open task #${msg.id} in ${msg.channel}`,
  }, el('span', { className: 'cb-progress-task-title', textContent: title }))
  const actor = task.claim?.actor ?? task.for ?? task.owner
  const who = labels.get(actor) ?? actor.replace(/^local:user:/, '')
  thread.appendChild(el('span', {
    className: 'cb-progress-meta', textContent: `${task.state} · ${who}`, title: `Task #${msg.id} in ${msg.channel}`,
  }))
  if (task.blocked?.reason || task.reason) {
    thread.appendChild(el('span', { className: 'cb-progress-reason', textContent: task.blocked?.reason || task.reason }))
  }
  thread.addEventListener('click', () => actions.openThread(msg.channel, msg.id))
  if (task.state === 'completed') row.appendChild(svgIcon('check', 13, 'cb-progress-check'))
  row.appendChild(thread)

  function action(label: string, perform: () => Promise<void>, hint?: string): void {
    const button = el('button', {
      type: 'button', className: 'cb-progress-action', textContent: label, title: hint ?? `${label} task #${msg.id}`,
    })
    button.addEventListener('click', async () => {
      button.disabled = true
      try { await perform() } finally { button.disabled = false }
    })
    row.appendChild(button)
  }
  if (canReopenTaskState(task.state) && canManageProgressTask(msg, state.me)) {
    action('Retry', () => actions.reopenTask(msg.id), 'Reopen failed task for claiming')
  } else if (task.state === 'blocked' && canManageProgressTask(msg, state.me)) {
    action('Unblock', () => actions.unblockTask(msg.id))
  } else if (task.state === 'ready') {
    action('Claim', () => actions.claimTask(msg.id))
    action('Complete', () => actions.completeTask(msg.id))
  } else if (task.state === 'claimed' && state.claimCache[msg.id]) {
    action('Complete', () => actions.completeTask(msg.id))
  }
  return row
}

function renderFeedbackDrawerTab(state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-drawer-panel' })
  const head = el('div', { className: 'cb-drawer-head' })
  head.appendChild(el('h2', { textContent: `Beta Feedback (${state.feedbackThreads.length})` }))
  const newBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-xs', textContent: '+ Report' })
  newBtn.addEventListener('click', () => actions.openModal({ kind: 'feedback' }))
  head.appendChild(newBtn)
  wrap.appendChild(head)

  const filters = el('div', { className: 'cb-filter-pills' })
  for (const f of ['all', 'new', 'triaged', 'resolved'] as const) {
    const b = el('button', {
      type: 'button',
      className: `cb-filter-pill${state.feedbackFilter === f ? ' is-active' : ''}`,
      textContent: f[0]!.toUpperCase() + f.slice(1),
    })
    b.addEventListener('click', () => actions.setFeedbackFilter(f))
    filters.appendChild(b)
  }
  wrap.appendChild(filters)

  const list = state.feedbackThreads.filter((t) => {
    const st = (t.message.labels['status'] ?? 'new').toLowerCase()
    return state.feedbackFilter === 'all' || st === state.feedbackFilter
  })

  if (list.length === 0) {
    wrap.appendChild(el('div', { className: 'cb-empty-sm', textContent: 'No feedback items in meta/feedback yet.' }))
    return wrap
  }

  for (const t of list) {
    const msg = t.message
    const status = msg.labels['status'] ?? 'new'
    const kind = msg.labels['kind'] ?? 'other'
    const severity = msg.labels['severity'] ?? 'med'
    const card = el('div', { className: 'cb-drawer-card' })
    const top = el('div', { className: 'cb-card-top' })
    top.appendChild(el('span', { className: `cb-sev-pill cb-sev-${severity}`, textContent: severity.toUpperCase() }))
    top.appendChild(el('span', { className: 'cb-kind-pill', textContent: kind }))
    top.appendChild(el('span', { className: 'cb-card-meta', textContent: status }))
    card.appendChild(top)

    card.appendChild(el('div', { className: 'cb-card-title', textContent: firstLineTitle(msg.text, 100) }))
    const by = msg.author?.handle ?? msg.by.actor.replace(/^local:user:/, '')
    card.appendChild(el('div', { className: 'cb-card-sub', textContent: `by ${by} · ${formatRelativeTime(msg.createdAt)}` }))

    const foot = el('div', { className: 'cb-card-foot' })
    const open = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs', textContent: 'Open' })
    open.addEventListener('click', () => actions.openThread(msg.channel, msg.id))
    foot.appendChild(open)

    const acts = el('div', { className: 'cb-card-acts' })
    if (status === 'new') {
      const tri = el('button', { type: 'button', className: 'cb-btn cb-btn-secondary cb-btn-xs', textContent: 'Triage' })
      tri.addEventListener('click', () => {
        void actions.setFeedbackStatus(msg.id, 'triaged')
      })
      acts.appendChild(tri)
    }
    if (status !== 'resolved') {
      const res = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs', textContent: 'Resolve' })
      res.addEventListener('click', () => {
        void actions.setFeedbackStatus(msg.id, 'resolved')
      })
      acts.appendChild(res)
    }
    if (!msg.task) {
      const prom = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-xs', textContent: '→ Task' })
      prom.addEventListener('click', () => {
        void actions.promoteToTask(msg.id)
      })
      acts.appendChild(prom)
    }
    foot.appendChild(acts)
    card.appendChild(foot)
    wrap.appendChild(card)
  }

  return wrap
}
