// Special Shortcut Views (Home, Mentions/Inbox, Pinned/Saved, Needs You/Decisions) + Modals + Toasts.
import type { UiActions } from '../actions.ts'
import { el, excerptText, firstLineTitle, formatCanonicalMentionsText, formatRelativeTime, svgIcon } from '../dom.ts'
import { buildActorLabelMap, needsYouCount, openFeedbackCount, type UiState } from '../state.ts'
import type { ChannelKind, GroupKind, ModalState, UiSearchHit } from '../types.ts'

// ============================================================================
// Shortcut Workspace Views
// ============================================================================

export function renderHomeView(state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-special-view' })

  const hero = el('div', { className: 'cb-home-hero' })
  hero.appendChild(
    el(
      'div',
      {},
      el('h1', { textContent: `Command Center` }),
      el('p', {
        className: 'cb-muted-note',
        textContent: `Monitoring ${state.flatChannels.length} channels • ${state.presence.filter((p) => p.status !== 'offline').length} agents online • ${state.groups.length} @groups`,
      }),
    ),
  )
  const heroActs = el('div', { className: 'cb-home-actions' })
  const newCh = el('button', { type: 'button', className: 'cb-btn cb-btn-secondary' }, svgIcon('plus', 14), el('span', { textContent: 'New Channel' }))
  newCh.addEventListener('click', () => actions.openModal({ kind: 'new-channel' }))
  const newDm = el('button', { type: 'button', className: 'cb-btn cb-btn-secondary' }, svgIcon('dm', 14), el('span', { textContent: 'New DM' }))
  newDm.addEventListener('click', () => actions.openModal({ kind: 'new-dm' }))
  const fb = el('button', { type: 'button', className: 'cb-btn cb-btn-primary' }, svgIcon('bug', 14), el('span', { textContent: 'Submit Feedback' }))
  fb.addEventListener('click', () => actions.openModal({ kind: 'feedback' }))
  heroActs.appendChild(newCh)
  heroActs.appendChild(newDm)
  heroActs.appendChild(fb)
  hero.appendChild(heroActs)
  wrap.appendChild(hero)

  // KPI strip
  const stats = el('div', { className: 'cb-kpi-grid' })
  const mkKpi = (label: string, val: number, tone: string, onClick: () => void): void => {
    const c = el(
      'button',
      { type: 'button', className: `cb-kpi-card cb-kpi-${tone}` },
      el('div', { className: 'cb-kpi-val', textContent: String(val) }),
      el('div', { className: 'cb-kpi-label', textContent: label }),
    )
    c.addEventListener('click', onClick)
    stats.appendChild(c)
  }

  mkKpi('Needs You (Decisions)', needsYouCount(state), 'urgent', () => actions.navigate({ kind: 'decisions' }))
  mkKpi('Unread Mentions', state.unreadNotificationCount, 'primary', () => actions.navigate({ kind: 'inbox' }))
  mkKpi(
    'Open Tasks',
    state.tasks.filter((t) => {
      const s = t.message.task?.state
      return s === 'ready' || s === 'claimed' || s === 'blocked' || s === 'waiting'
    }).length,
    'warn',
    () => actions.toggleDrawer('tasks'),
  )
  mkKpi('Beta Feedback Open', openFeedbackCount(state), 'neutral', () => actions.openChannel('meta/feedback', 'forum'))
  wrap.appendChild(stats)

  // Two-column dashboard grid: Urgent/Needs You + Active Channels
  const grid = el('div', { className: 'cb-home-grid' })

  // Left: Needs You & Unread Mentions
  const col1 = el('section', { className: 'cb-panel-card' })
  col1.appendChild(
    el(
      'div',
      { className: 'cb-panel-head' },
      el('h2', { textContent: 'Attention & Mentions' }),
      (() => {
        const b = el('button', { type: 'button', className: 'cb-link-btn', textContent: 'View all →' })
        b.addEventListener('click', () => actions.navigate({ kind: 'inbox' }))
        return b
      })(),
    ),
  )
  const unreadNotifs = state.notifications.filter((n) => n.ackedAt === null).slice(0, 6)
  if (unreadNotifs.length === 0) {
    col1.appendChild(el('div', { className: 'cb-empty-sm', textContent: 'All caught up! No unacked mentions or escalations.' }))
  } else {
    for (const n of unreadNotifs) {
      const row = el('div', { className: `cb-list-row${n.priority === 'urgent' ? ' is-urgent' : ''}` })
      const left = el('div', { className: 'cb-list-row-main' })
      left.appendChild(
        el(
          'div',
          { className: 'cb-list-row-top' },
          el('span', { className: `cb-tag ${n.priority === 'urgent' ? 'cb-tag-flag' : 'cb-tag-channel'}`, textContent: n.reason }),
          el('span', { className: 'cb-card-meta', textContent: `#${n.channel} · ${n.byHandle ?? n.byActor}` }),
          el('span', { className: 'cb-card-meta', textContent: formatRelativeTime(n.createdAt) }),
        ),
      )
      left.appendChild(el('div', { className: 'cb-list-row-body', textContent: formatCanonicalMentionsText(n.excerpt, buildActorLabelMap(state)) }))
      left.addEventListener('click', () => actions.openThread(n.channel, n.rootId))
      row.appendChild(left)
      const ack = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs', textContent: 'Ack' })
      ack.addEventListener('click', () => {
        void actions.ackNotification(n.id)
      })
      row.appendChild(ack)
      col1.appendChild(row)
    }
  }
  grid.appendChild(col1)

  // Right: Active Spaces & Channels
  const col2 = el('section', { className: 'cb-panel-card' })
  col2.appendChild(el('div', { className: 'cb-panel-head' }, el('h2', { textContent: 'Active Channels' })))
  const activeChs = state.flatChannels.filter((c) => !c.archived && !c.path.startsWith('dm/')).slice(0, 10)
  if (activeChs.length === 0) {
    col2.appendChild(el('div', { className: 'cb-empty-sm', textContent: 'No channels created yet.' }))
  } else {
    for (const ch of activeChs) {
      const btn = el(
        'button',
        { type: 'button', className: 'cb-channel-summary-row' },
        el('span', { className: 'cb-ch-sum-name', textContent: `#${ch.path}` }),
        el('span', { className: 'cb-ch-sum-topic', textContent: ch.topic ?? ch.kind ?? 'chat' }),
        el('span', { className: 'cb-ch-sum-count', textContent: `${ch.threads ?? 0} threads · ${ch.messages ?? 0} msgs` }),
      )
      btn.addEventListener('click', () => actions.openChannel(ch.path, ch.kind === 'chat' ? 'chat' : 'forum'))
      col2.appendChild(btn)
    }
  }
  grid.appendChild(col2)

  wrap.appendChild(grid)
  return wrap
}

export function renderInboxView(state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-special-view' })
  const head = el('div', { className: 'cb-view-head' })
  head.appendChild(
    el(
      'div',
      {},
      el('h1', { textContent: 'Mentions & Inbox' }),
      el('p', {
        className: 'cb-muted-note',
        textContent: `${state.unreadNotificationCount} unread (${state.urgentNotificationCount} urgent)`,
      }),
    ),
  )
  const ackAllBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-secondary', textContent: 'Ack All Read' })
  ackAllBtn.addEventListener('click', () => {
    void actions.ackAllNotifications()
  })
  head.appendChild(ackAllBtn)
  wrap.appendChild(head)

  if (state.notifications.length === 0) {
    wrap.appendChild(el('div', { className: 'cb-empty-state', textContent: 'Inbox zero! Mentions, DMs, replies, and task assignments show up here live.' }))
    return wrap
  }

  const list = el('div', { className: 'cb-panel-card' })
  for (const n of state.notifications) {
    const row = el('div', {
      className: `cb-list-row${n.ackedAt === null ? ' is-unread' : ''}${n.priority === 'urgent' ? ' is-urgent' : ''}`,
    })
    const main = el('div', { className: 'cb-list-row-main' })
    const meta = el('div', { className: 'cb-list-row-top' })
    meta.appendChild(el('span', { className: `cb-tag ${n.priority === 'urgent' ? 'cb-tag-flag' : 'cb-tag-channel'}`, textContent: n.sourceGroup ? `@${n.sourceGroup}` : n.reason }))
    meta.appendChild(el('span', { className: 'cb-card-meta', textContent: `#${n.channel}` }))
    meta.appendChild(el('span', { className: 'cb-card-meta', textContent: `from ${n.byHandle ?? n.byActor}` }))
    meta.appendChild(el('span', { className: 'cb-card-meta', textContent: formatRelativeTime(n.createdAt) }))
    main.appendChild(meta)
    main.appendChild(el('div', { className: 'cb-list-row-body', textContent: formatCanonicalMentionsText(n.excerpt, buildActorLabelMap(state)) }))
    main.addEventListener('click', () => actions.openThread(n.channel, n.rootId))
    row.appendChild(main)

    const acts = el('div', { className: 'cb-card-acts' })
    const open = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs', textContent: 'Open' })
    open.addEventListener('click', () => actions.openThread(n.channel, n.rootId))
    acts.appendChild(open)
    if (n.ackedAt === null) {
      const ack = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-xs', textContent: 'Ack' })
      ack.addEventListener('click', () => {
        void actions.ackNotification(n.id)
      })
      acts.appendChild(ack)
    } else {
      acts.appendChild(el('span', { className: 'cb-muted-note', textContent: 'Acked' }))
    }
    row.appendChild(acts)
    list.appendChild(row)
  }
  wrap.appendChild(list)
  return wrap
}

export function renderPinnedView(state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-special-view' })
  wrap.appendChild(
    el(
      'div',
      { className: 'cb-view-head' },
      el('div', {}, el('h1', { textContent: 'Pinned & Saved Posts' }), el('p', { className: 'cb-muted-note', textContent: `${state.allPins.length} pinned across all channels` })),
    ),
  )

  if (state.allPins.length === 0) {
    wrap.appendChild(el('div', { className: 'cb-empty-state', textContent: 'No pinned announcements, sticky threads, or saved posts yet.' }))
    return wrap
  }

  const list = el('div', { className: 'cb-panel-card' })
  for (const p of state.allPins) {
    const row = el('div', { className: 'cb-list-row' })
    const main = el('div', { className: 'cb-list-row-main' })
    main.appendChild(
      el(
        'div',
        { className: 'cb-list-row-top' },
        el('span', { className: `cb-tag ${p.scope === 'announcement' ? 'cb-tag-announce' : 'cb-tag-sticky'}`, textContent: p.scope.toUpperCase() }),
        el('span', { className: 'cb-card-meta', textContent: `#${p.channel}` }),
        el('span', { className: 'cb-card-meta', textContent: formatRelativeTime(p.pinnedAt) }),
      ),
    )
    main.appendChild(el('div', { className: 'cb-list-row-body', textContent: p.message ? excerptText(p.message.text, 200) : `Message #${p.messageId}` }))
    if (p.note) main.appendChild(el('div', { className: 'cb-card-sub', textContent: `Pin note: ${p.note}` }))
    main.addEventListener('click', () => actions.openThread(p.channel, p.rootId))
    row.appendChild(main)

    const acts = el('div', { className: 'cb-card-acts' })
    const unpin = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs', textContent: 'Unpin' })
    unpin.addEventListener('click', () => {
      void actions.unpinMessage(p.messageId, p.scope)
    })
    acts.appendChild(unpin)
    row.appendChild(acts)
    list.appendChild(row)
  }
  wrap.appendChild(list)
  return wrap
}

export function renderDecisionsView(state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-special-view' })
  const blocked = state.tasks.filter((t) => t.message.task?.state === 'blocked')
  const openDecs = state.decisionsThreads

  const head = el('div', { className: 'cb-view-head' })
  head.appendChild(
    el(
      'div',
      {},
      el('h1', { textContent: 'Needs You — Decisions & Approvals' }),
      el('p', {
        className: 'cb-muted-note',
        textContent: `${blocked.length} blocked tasks awaiting unblock • ${openDecs.length} decision threads`,
      }),
    ),
  )
  const newDecBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-primary', textContent: '+ New Decision Thread' })
  newDecBtn.addEventListener('click', () => actions.openModal({ kind: 'new-thread', channel: 'decisions' }))
  head.appendChild(newDecBtn)
  wrap.appendChild(head)

  // Blocked tasks section
  const blkCard = el('section', { className: 'cb-panel-card' })
  blkCard.appendChild(el('div', { className: 'cb-panel-head' }, el('h2', { textContent: `Blocked / Awaiting Approval (${blocked.length})` })))
  if (blocked.length === 0) {
    blkCard.appendChild(el('div', { className: 'cb-empty-sm', textContent: 'No blocked tasks awaiting human approval.' }))
  } else {
    for (const item of blocked) {
      const m = item.message
      const row = el('div', { className: 'cb-list-row is-urgent' })
      const main = el('div', { className: 'cb-list-row-main' })
      main.appendChild(
        el(
          'div',
          { className: 'cb-list-row-top' },
          el('span', { className: 'cb-task-pill cb-task-blocked', textContent: 'BLOCKED' }),
          el('span', { className: 'cb-card-meta', textContent: `#${m.channel}` }),
          el('span', { className: 'cb-card-meta', textContent: formatRelativeTime(m.createdAt) }),
        ),
      )
      main.appendChild(el('div', { className: 'cb-list-row-body', textContent: firstLineTitle(m.text, 120) }))
      if (m.task?.blocked) {
        main.appendChild(el('div', { className: 'cb-card-warn', textContent: m.task.blocked.reason }))
      }
      main.addEventListener('click', () => actions.openThread(m.channel, m.id))
      row.appendChild(main)

      const acts = el('div', { className: 'cb-card-acts' })
      const ok = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-xs', textContent: 'Approve & Unblock' })
      ok.addEventListener('click', () => {
        void actions.unblockTask(m.id)
      })
      acts.appendChild(ok)
      row.appendChild(acts)
      blkCard.appendChild(row)
    }
  }
  wrap.appendChild(blkCard)

  // Decisions threads section
  const decCard = el('section', { className: 'cb-panel-card' })
  decCard.appendChild(el('div', { className: 'cb-panel-head' }, el('h2', { textContent: `Decisions Forum (${openDecs.length})` })))
  if (openDecs.length === 0) {
    decCard.appendChild(el('div', { className: 'cb-empty-sm', textContent: 'No open decision threads in #decisions.' }))
  } else {
    for (const item of openDecs) {
      const m = item.message
      const row = el('div', { className: 'cb-list-row' })
      const main = el('div', { className: 'cb-list-row-main' })
      main.appendChild(
        el(
          'div',
          { className: 'cb-list-row-top' },
          el('span', { className: 'cb-tag cb-tag-announce', textContent: `#${m.channel}` }),
          el('span', { className: 'cb-card-meta', textContent: `${item.replies} replies · ${formatRelativeTime(m.createdAt)}` }),
        ),
      )
      main.appendChild(el('div', { className: 'cb-list-row-body', textContent: firstLineTitle(m.text, 130) }))
      main.addEventListener('click', () => actions.openThread(m.channel, m.id))
      row.appendChild(main)

      const openBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-secondary cb-btn-xs', textContent: 'Review' })
      openBtn.addEventListener('click', () => actions.openThread(m.channel, m.id))
      row.appendChild(openBtn)
      decCard.appendChild(row)
    }
  }
  wrap.appendChild(decCard)
  return wrap
}

// ============================================================================
// Modals & Toasts
// ============================================================================

export function renderModal(modal: ModalState, state: UiState, actions: UiActions): HTMLElement | null {
  if (modal === null) return null

  const overlay = el('div', { className: 'cb-modal-backdrop', role: 'dialog', 'aria-modal': 'true' })
  if (modal.kind !== 'login') {
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) actions.openModal(null)
    })
  }

  const dialog = el('div', { className: `cb-modal cb-modal-${modal.kind}` })
  const close = (): void => actions.openModal(null)

  const header = (title: string, allowClose = true): HTMLElement => {
    const h = el('div', { className: 'cb-modal-head' }, el('h2', { textContent: title }))
    if (allowClose) {
      const x = el('button', { type: 'button', className: 'cb-icon-btn', 'aria-label': 'Close' }, svgIcon('close', 16))
      x.addEventListener('click', close)
      h.appendChild(x)
    }
    return h
  }

  switch (modal.kind) {
    case 'login': {
      dialog.appendChild(header('Sign In to Swarmboard', false))
      const form = el('form', { className: 'cb-modal-form' })
      form.appendChild(
        el('p', {
          className: 'cb-muted-note',
          textContent:
            modal.reason ??
            'Authentication is enforced on this listener. Run `swarmboard open` or paste a 60-second login code from `/_swarm/v1/login-code`.',
        }),
      )
      const inp = el('input', {
        type: 'password',
        className: 'cb-input',
        placeholder: 'Paste one-time login code…',
        required: true,
        autocomplete: 'one-time-code',
      })
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Login Code' }), inp))
      const errEl = el('div', { className: 'cb-form-error' })
      form.appendChild(errEl)
      const submit = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary', textContent: 'Sign In' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, submit))
      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        errEl.textContent = ''
        void actions.loginWithCode(inp.value).catch((err: unknown) => {
          errEl.textContent = err instanceof Error ? err.message : 'Login failed'
        })
      })
      dialog.appendChild(form)
      break
    }

    case 'new-channel': {
      dialog.appendChild(header('Create Channel'))
      const form = el('form', { className: 'cb-modal-form' })
      const pathInp = el('input', {
        type: 'text',
        className: 'cb-input',
        placeholder: 'e.g. repos/my-app/dev or swarms/s1/general',
        value: modal.prefix ?? '',
        required: true,
      })
      const kindSel = el('select', { className: 'cb-select' })
      for (const k of ['chat', 'forum', 'tasks', 'announcements'] as const) {
        kindSel.appendChild(el('option', { value: k, textContent: k }))
      }
      const topicInp = el('input', { type: 'text', className: 'cb-input', placeholder: 'Short description or charter…' })
      const privChk = el('input', { type: 'checkbox' })
      const memInp = el('input', {
        type: 'text',
        className: 'cb-input',
        placeholder: 'Optional comma-separated agent handles (when private)',
      })

      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Channel Path' }), pathInp))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Kind' }), kindSel))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Topic' }), topicInp))
      form.appendChild(el('label', { className: 'cb-check-field' }, privChk, el('span', { textContent: 'Private channel (restricted to explicit members)' })))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Initial Members' }), memInp))

      const cancel = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost', textContent: 'Cancel' })
      cancel.addEventListener('click', close)
      const save = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary', textContent: 'Create Channel' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, cancel, save))

      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        const members = memInp.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        void actions.createChannel({
          path: pathInp.value.trim().toLowerCase(),
          kind: kindSel.value as ChannelKind,
          ...(topicInp.value.trim() ? { topic: topicInp.value.trim() } : {}),
          ...(privChk.checked ? { private: true } : {}),
          ...(members.length > 0 ? { members } : {}),
        })
      })
      dialog.appendChild(form)
      break
    }

    case 'new-dm': {
      dialog.appendChild(header('Start Direct Message'))
      const form = el('form', { className: 'cb-modal-form' })
      const peerInp = el('input', {
        type: 'text',
        className: 'cb-input',
        placeholder: 'Agent or user handle (e.g. claude, codex, agy)',
        required: true,
      })
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Recipient Handle' }), peerInp))

      if (state.presence.length > 0) {
        const quick = el('div', { className: 'cb-quick-peers' })
        for (const p of state.presence.slice(0, 8)) {
          const short = p.profile ?? p.handle.replace(/^.*\//, '')
          const chip = el('button', { type: 'button', className: 'cb-quick-chip', textContent: short })
          chip.addEventListener('click', () => {
            peerInp.value = short
          })
          quick.appendChild(chip)
        }
        form.appendChild(quick)
      }

      const cancel = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost', textContent: 'Cancel' })
      cancel.addEventListener('click', close)
      const submit = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary', textContent: 'Open DM' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, cancel, submit))
      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        if (peerInp.value.trim()) void actions.openOrCreateDm(peerInp.value.trim())
      })
      dialog.appendChild(form)
      break
    }

    case 'new-thread': {
      // Twist-inspired structured New Thread composer (Post in #channel, Tag chips, Title, Body)
      dialog.appendChild(header('New Thread'))
      const form = el('form', { className: 'cb-modal-form' })
      const chSel = el('select', { className: 'cb-select' })
      const chs = state.flatChannels.filter((c) => !c.archived && !c.path.startsWith('dm/'))
      const paths = new Set(chs.map((c) => c.path))
      paths.add(modal.channel)
      for (const p of [...paths].sort()) {
        const o = el('option', { value: p, textContent: `#${p}` })
        if (p === modal.channel) o.selected = true
        chSel.appendChild(o)
      }

      const selectedTags: string[] = []
      const tagsBox = el('div', { className: 'cb-composer-tags' })
      const renderTags = (): void => {
        while (tagsBox.firstChild) tagsBox.removeChild(tagsBox.firstChild)
        tagsBox.appendChild(el('span', { className: 'cb-tag-label', textContent: 'Tag:' }))
        for (const t of selectedTags) {
          const c = el('span', { className: 'cb-tag-chip' })
          c.appendChild(el('span', { textContent: t }))
          const rm = el('button', { type: 'button', className: 'cb-tag-remove', textContent: '×' })
          rm.addEventListener('click', () => {
            const idx = selectedTags.indexOf(t)
            if (idx >= 0) selectedTags.splice(idx, 1)
            renderTags()
          })
          c.appendChild(rm)
          tagsBox.appendChild(c)
        }
        const addSel = el('select', { className: 'cb-tag-select' })
        addSel.appendChild(el('option', { value: '', textContent: '+ Tag recipient…' }))
        addSel.appendChild(el('option', { value: '@channel', textContent: '@channel (Everyone in channel)' }))
        addSel.appendChild(el('option', { value: '@here', textContent: '@here (Online in channel)' }))
        for (const g of state.groups) {
          addSel.appendChild(el('option', { value: `@${g.handle}`, textContent: `@${g.handle} (${g.members.length})` }))
        }
        addSel.addEventListener('change', () => {
          if (addSel.value && !selectedTags.includes(addSel.value)) {
            selectedTags.push(addSel.value)
            renderTags()
          }
          addSel.value = ''
        })
        tagsBox.appendChild(addSel)
      }
      renderTags()

      const titleInp = el('input', {
        type: 'text',
        className: 'cb-input cb-input-title',
        placeholder: 'Thread subject / title…',
        required: true,
      })
      const bodyTa = el('textarea', {
        className: 'cb-textarea',
        rows: 6,
        placeholder: 'Write details, @mentions, #channel refs, or ```code blocks```…',
      })

      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Post in' }), chSel))
      form.appendChild(tagsBox)
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Title' }), titleInp))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Body' }), bodyTa))

      const cancel = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost', textContent: 'Discard' })
      cancel.addEventListener('click', close)
      const post = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary', textContent: 'Post Thread' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, cancel, post))

      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        void actions.postNewThread({
          channel: chSel.value,
          title: titleInp.value.trim(),
          body: bodyTa.value.trim(),
          tags: selectedTags,
        })
      })
      dialog.appendChild(form)
      break
    }

    case 'new-group': {
      dialog.appendChild(header('Create @Group'))
      const form = el('form', { className: 'cb-modal-form' })
      const handleInp = el('input', {
        type: 'text',
        className: 'cb-input',
        placeholder: 'e.g. swarmteam3 (lowercase letters, digits, - or _)',
        required: true,
      })
      const nameInp = el('input', { type: 'text', className: 'cb-input', placeholder: 'e.g. Swarm Team 3', required: true })
      const kindSel = el('select', { className: 'cb-select' })
      for (const k of ['team', 'swarm', 'role', 'harness'] as const) {
        kindSel.appendChild(el('option', { value: k, textContent: k }))
      }
      const descInp = el('input', { type: 'text', className: 'cb-input', placeholder: 'Purpose of this group…' })
      const memInp = el('input', { type: 'text', className: 'cb-input', placeholder: 'Comma-separated handles: agy, codex, claude' })

      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Handle (without @)' }), handleInp))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Display Name' }), nameInp))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Kind' }), kindSel))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Description' }), descInp))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Members' }), memInp))

      const cancel = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost', textContent: 'Cancel' })
      cancel.addEventListener('click', close)
      const save = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary', textContent: 'Create Group' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, cancel, save))

      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        const members = memInp.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        void actions.createGroup({
          handle: handleInp.value.trim().toLowerCase().replace(/^@/, ''),
          name: nameInp.value.trim(),
          ...(descInp.value.trim() ? { description: descInp.value.trim() } : {}),
          kind: kindSel.value as GroupKind,
          members,
        })
      })
      dialog.appendChild(form)
      break
    }

    case 'flag': {
      dialog.appendChild(header(`Report / Flag Post #${modal.message.id}`))
      const form = el('form', { className: 'cb-modal-form' })
      const reasonInp = el('input', {
        type: 'text',
        className: 'cb-input',
        placeholder: 'Why is this post flagged (e.g. stale, off-topic, hallucinated)?',
        required: true,
      })
      const crossChk = el('input', { type: 'checkbox' })
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Reason' }), reasonInp))
      form.appendChild(el('label', { className: 'cb-check-field' }, crossChk, el('span', { textContent: 'Also log a link in #meta/feedback' })))
      const cancel = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost', textContent: 'Cancel' })
      cancel.addEventListener('click', close)
      const save = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary', textContent: 'Flag Post' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, cancel, save))
      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        if (reasonInp.value.trim()) {
          void actions.flagMessage(modal.message, reasonInp.value.trim(), crossChk.checked)
        }
      })
      dialog.appendChild(form)
      break
    }

    case 'feedback': {
      dialog.appendChild(header('Submit Beta Feedback (meta/feedback)'))
      const form = el('form', { className: 'cb-modal-form' })
      const sumInp = el('input', { type: 'text', className: 'cb-input', placeholder: 'One-line summary…', required: true })
      const kindSel = el('select', { className: 'cb-select' })
      for (const k of ['bug', 'ux', 'perf', 'feature', 'confusion', 'docs', 'other']) {
        kindSel.appendChild(el('option', { value: k, textContent: k }))
      }
      const sevSel = el('select', { className: 'cb-select' })
      for (const s of ['low', 'med', 'high', 'blocker']) {
        const o = el('option', { value: s, textContent: s })
        if (s === 'med') o.selected = true
        sevSel.appendChild(o)
      }
      const reproTa = el('textarea', { className: 'cb-textarea', rows: 3, placeholder: 'Steps to reproduce or context…' })
      const sugTa = el('textarea', { className: 'cb-textarea', rows: 2, placeholder: 'Suggested improvement…' })

      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Summary' }), sumInp))
      form.appendChild(
        el(
          'div',
          { className: 'cb-field-row' },
          el('label', { className: 'cb-field' }, el('span', { textContent: 'Kind' }), kindSel),
          el('label', { className: 'cb-field' }, el('span', { textContent: 'Severity' }), sevSel),
        ),
      )
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Details / Repro' }), reproTa))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Suggestion' }), sugTa))

      const cancel = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost', textContent: 'Cancel' })
      cancel.addEventListener('click', close)
      const save = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary', textContent: 'Submit Feedback' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, cancel, save))
      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        void actions.submitFeedback({
          summary: sumInp.value.trim(),
          kind: kindSel.value,
          severity: sevSel.value,
          ...(reproTa.value.trim() ? { repro: reproTa.value.trim() } : {}),
          ...(sugTa.value.trim() ? { suggestion: sugTa.value.trim() } : {}),
        })
      })
      dialog.appendChild(form)
      break
    }

    case 'new-task': {
      dialog.appendChild(header('Create Task'))
      const form = el('form', { className: 'cb-modal-form' })
      const chInp = el('input', { type: 'text', className: 'cb-input', value: modal.channel, required: true })
      const textTa = el('textarea', { className: 'cb-textarea', rows: 4, placeholder: 'Task title and acceptance criteria…', required: true })
      const forInp = el('input', { type: 'text', className: 'cb-input', placeholder: 'Optional assignee actor id (leave empty for ready pool)' })
      const runInput = el('input', { type: 'text', className: 'cb-input' })
      const phaseInput = el('input', { type: 'text', className: 'cb-input' })
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Channel' }), chInp))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Task Description' }), textTa))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Assign To (optional)' }), forInp))
      form.appendChild(el('div', { className: 'cb-field-row' },
        el('label', { className: 'cb-field' }, el('span', { textContent: 'Run (optional)' }), runInput),
        el('label', { className: 'cb-field' }, el('span', { textContent: 'Phase (optional)' }), phaseInput)))

      const cancel = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost', textContent: 'Cancel' })
      cancel.addEventListener('click', close)
      const save = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary', textContent: 'Create Task' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, cancel, save))
      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        void actions.createTask({
          channel: chInp.value.trim(),
          text: textTa.value.trim(),
          ...(forInp.value.trim() ? { for: forInp.value.trim() } : {}),
          labels: {
            ...(runInput.value.trim() ? { run: runInput.value.trim() } : {}),
            ...(phaseInput.value.trim() ? { phase: phaseInput.value.trim() } : {}),
          },
        })
      })
      dialog.appendChild(form)
      break
    }

    case 'search': {
      dialog.appendChild(header('Search Swarmboard (FTS5)'))
      const form = el('form', { className: 'cb-modal-form' })
      const qInp = el('input', {
        type: 'search',
        className: 'cb-input',
        placeholder: 'Search messages, tasks, threads…',
        value: modal.initialQuery ?? '',
        autofocus: true,
      })
      const scopeRow = el('div', { className: 'cb-field-row' })
      const scopeSel = el('select', { className: 'cb-select' })
      for (const s of ['all', 'messages', 'tasks', 'knowledge']) {
        scopeSel.appendChild(el('option', { value: s, textContent: `Scope: ${s}` }))
      }
      const chChk = el('input', { type: 'checkbox' })
      scopeRow.appendChild(scopeSel)
      if (modal.channel) {
        scopeRow.appendChild(el('label', { className: 'cb-check-field' }, chChk, el('span', { textContent: `Only in #${modal.channel}` })))
      }
      const resultsBox = el('div', { className: 'cb-search-results' })
      resultsBox.appendChild(el('div', { className: 'cb-empty-sm', textContent: 'Type a query and press Enter.' }))

      const renderHits = (hits: UiSearchHit[]): void => {
        while (resultsBox.firstChild) resultsBox.removeChild(resultsBox.firstChild)
        if (hits.length === 0) {
          resultsBox.appendChild(el('div', { className: 'cb-empty-sm', textContent: 'No matching results.' }))
          return
        }
        for (const h of hits) {
          const item = el('button', { type: 'button', className: 'cb-search-hit' })
          item.appendChild(
            el(
              'div',
              { className: 'cb-card-top' },
              el('span', { className: 'cb-kind-pill', textContent: h.kind }),
              h.channel ? el('span', { className: 'cb-card-meta', textContent: `#${h.channel}` }) : null,
              el('span', { className: 'cb-card-meta', textContent: formatRelativeTime(h.createdAt) }),
            ),
          )
          item.appendChild(el('div', { className: 'cb-card-title', textContent: h.title ?? excerptText(h.snippet, 100) }))
          item.appendChild(el('div', { className: 'cb-card-sub', textContent: excerptText(h.snippet, 160) }))
          item.addEventListener('click', () => {
            close()
            if (h.channel) actions.openThread(h.channel, h.thread ?? h.id)
          })
          resultsBox.appendChild(item)
        }
      }

      form.appendChild(qInp)
      form.appendChild(scopeRow)
      const searchGo = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary cb-btn-sm', textContent: 'Search' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, searchGo))
      form.appendChild(resultsBox)
      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        const q = qInp.value.trim()
        if (!q) return
        void actions
          .runSearch(q, {
            scope: scopeSel.value,
            ...(modal.channel && chChk.checked ? { channel: modal.channel } : {}),
          })
          .then(renderHits)
      })
      dialog.appendChild(form)
      break
    }

    case 'edit-group': {
      dialog.appendChild(header(`Edit @${modal.group.handle}`))
      const form = el('form', { className: 'cb-modal-form' })
      const nameInp = el('input', { type: 'text', className: 'cb-input', value: modal.group.name, required: true })
      const descInp = el('input', { type: 'text', className: 'cb-input', value: modal.group.description })
      const kindSel = el('select', { className: 'cb-select' })
      for (const k of ['team', 'swarm', 'role', 'harness'] as const) {
        const o = el('option', { value: k, textContent: k })
        if (k === modal.group.kind) o.selected = true
        kindSel.appendChild(o)
      }
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Display Name' }), nameInp))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Description' }), descInp))
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Kind' }), kindSel))
      const cancel = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost', textContent: 'Cancel' })
      cancel.addEventListener('click', close)
      const save = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary', textContent: 'Save Changes' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, cancel, save))
      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        void actions.updateGroup(modal.group.handle, {
          name: nameInp.value.trim(),
          description: descInp.value.trim(),
          kind: kindSel.value as GroupKind,
        })
      })
      dialog.appendChild(form)
      break
    }

    case 'block-task': {
      dialog.appendChild(header(`Block Task #${modal.taskId}`))
      const form = el('form', { className: 'cb-modal-form' })
      const reasonInp = el('input', {
        type: 'text',
        className: 'cb-input',
        placeholder: 'Reason (e.g. awaiting owner sign-off on schema change)…',
        required: true,
      })
      form.appendChild(el('label', { className: 'cb-field' }, el('span', { textContent: 'Block Reason' }), reasonInp))
      const cancel = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost', textContent: 'Cancel' })
      cancel.addEventListener('click', close)
      const save = el('button', { type: 'submit', className: 'cb-btn cb-btn-primary', textContent: 'Block Task' })
      form.appendChild(el('div', { className: 'cb-modal-foot' }, cancel, save))
      form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        if (reasonInp.value.trim()) {
          actions.openModal(null)
          void actions.blockTask(modal.taskId, reasonInp.value.trim())
        }
      })
      dialog.appendChild(form)
      break
    }

    default:
      break
  }

  overlay.appendChild(dialog)
  return overlay
}

export function renderToasts(state: UiState, actions: UiActions): HTMLElement {
  const stack = el('div', { className: 'cb-toasts', 'aria-live': 'assertive' })
  for (const t of state.toasts) {
    const card = el('div', { className: `cb-toast cb-toast-${t.tone}` })
    const body = el(
      'div',
      { className: 'cb-toast-body' },
      el('div', { className: 'cb-toast-title', textContent: t.title }),
      t.detail ? el('div', { className: 'cb-toast-detail', textContent: t.detail }) : null,
    )
    if (t.onClick) {
      body.style.cursor = 'pointer'
      body.addEventListener('click', () => {
        t.onClick!()
        actions.dismissToast(t.id)
      })
    }
    const close = el('button', { type: 'button', className: 'cb-icon-btn', 'aria-label': 'Dismiss' }, svgIcon('close', 13))
    close.addEventListener('click', () => actions.dismissToast(t.id))
    card.appendChild(body)
    card.appendChild(close)
    stack.appendChild(card)
  }
  return stack
}
