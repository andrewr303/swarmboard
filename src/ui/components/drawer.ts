// Right Contextual Drawer: Switchable between Pinned Posts, @Groups/Teams, Tasks, and Beta Feedback Triage.
import type { UiActions } from '../actions.ts'
import { el, excerptText, firstLineTitle, formatRelativeTime, svgIcon } from '../dom.ts'
import type { UiState } from '../state.ts'
import type { DrawerTab, UiGroupView, UiPinView, UiThreadSummaryView } from '../types.ts'

export function renderRightDrawer(state: UiState, actions: UiActions): HTMLElement {
  const drawer = el('aside', {
    className: `cb-drawer${state.drawerOpen ? ' is-open' : ''}`,
    'aria-label': 'Contextual drawer',
  })

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
        : 'work/agent-board'
    actions.openModal({ kind: 'new-task', channel: ch })
  })
  head.appendChild(newBtn)
  wrap.appendChild(head)

  // Filter pills
  const filters = el('div', { className: 'cb-filter-pills' })
  for (const f of ['open', 'ready', 'claimed', 'blocked', 'done', 'all'] as const) {
    const b = el('button', {
      type: 'button',
      className: `cb-filter-pill${state.taskFilter === f ? ' is-active' : ''}`,
      textContent: f[0]!.toUpperCase() + f.slice(1),
    })
    b.addEventListener('click', () => actions.setTaskFilter(f))
    filters.appendChild(b)
  }
  wrap.appendChild(filters)

  const filtered = state.tasks.filter((t) => {
    const st = t.message.task?.state
    if (!st) return false
    switch (state.taskFilter) {
      case 'all':
        return true
      case 'open':
        return st === 'ready' || st === 'claimed' || st === 'blocked' || st === 'waiting'
      case 'done':
        return st === 'completed' || st === 'failed' || st === 'canceled'
      default:
        return st === state.taskFilter
    }
  })

  if (filtered.length === 0) {
    wrap.appendChild(el('div', { className: 'cb-empty-sm', textContent: `No ${state.taskFilter} tasks right now.` }))
    return wrap
  }

  for (const item of filtered) {
    wrap.appendChild(renderDrawerTaskCard(item, state, actions))
  }
  return wrap
}

function renderDrawerTaskCard(item: UiThreadSummaryView, state: UiState, actions: UiActions): HTMLElement {
  const msg = item.message
  const task = msg.task!
  const card = el('div', { className: `cb-drawer-card cb-drawer-task-${task.state}` })

  const top = el('div', { className: 'cb-card-top' })
  top.appendChild(el('span', { className: `cb-task-pill cb-task-${task.state}`, textContent: task.state.toUpperCase() }))
  top.appendChild(el('span', { className: 'cb-card-meta', textContent: `#${msg.channel}` }))
  card.appendChild(top)

  card.appendChild(el('div', { className: 'cb-card-title', textContent: firstLineTitle(msg.text, 90) }))
  if (task.for) {
    card.appendChild(el('div', { className: 'cb-card-sub', textContent: `For: ${task.for.replace(/^local:user:/, '')}` }))
  }
  if (task.blocked) {
    card.appendChild(el('div', { className: 'cb-card-warn', textContent: `Blocked: ${task.blocked.reason}` }))
  }
  if (item.last) {
    const by = item.last.author?.handle ?? item.last.by.actor.replace(/^local:user:/, '')
    card.appendChild(el('div', { className: 'cb-card-snippet', textContent: `${by}: ${excerptText(item.last.text, 95)}` }))
  }

  const foot = el('div', { className: 'cb-card-foot' })
  const openBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs', textContent: 'Thread' })
  openBtn.addEventListener('click', () => actions.openThread(msg.channel, msg.id))
  foot.appendChild(openBtn)

  const acts = el('div', { className: 'cb-card-acts' })
  if (task.state === 'blocked') {
    const ok = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-xs', textContent: 'Approve & Unblock' })
    ok.addEventListener('click', () => {
      void actions.unblockTask(msg.id)
    })
    acts.appendChild(ok)
  } else if (task.state === 'ready') {
    const cl = el('button', { type: 'button', className: 'cb-btn cb-btn-secondary cb-btn-xs', textContent: 'Claim' })
    cl.addEventListener('click', () => {
      void actions.claimTask(msg.id)
    })
    const done = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-xs', textContent: 'Complete' })
    done.addEventListener('click', () => {
      void actions.completeTask(msg.id)
    })
    acts.appendChild(cl)
    acts.appendChild(done)
  } else if (task.state === 'claimed' && state.claimCache[msg.id]) {
    const done = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-xs', textContent: 'Complete' })
    done.addEventListener('click', () => {
      void actions.completeTask(msg.id)
    })
    acts.appendChild(done)
  }
  foot.appendChild(acts)
  card.appendChild(foot)
  return card
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
