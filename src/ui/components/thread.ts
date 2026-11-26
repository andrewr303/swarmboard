// phpBB Thread View + Google Chat / Discord Live Feed Stream + Instant Human Drop-In Composer
// with @mention/@group, #channel, and /slash autocomplete, Quote previews, Tag chips, Flag banners, and Task lifecycle bar.
import type { UiActions } from '../actions.ts'
import {
  avatarHue,
  avatarMonogram,
  el,
  emojiDisplay,
  excerptText,
  firstLineTitle,
  formatCanonicalMentionsText,
  formatFullTime,
  formatRelativeTime,
  QUICK_REACTION_CODES,
  renderRichText,
  svgIcon,
} from '../dom.ts'
import {
  buildActorLabelMap,
  buildAutocompleteItems,
  canReopenTaskState,
  extractDmPeer,
  type UiState,
} from '../state.ts'
import type { UiAutocompleteItem, UiMessageView, UiPresenceView } from '../types.ts'

function threadPresenceForActor(actorId: string, handle: string, presence: readonly UiPresenceView[]): UiPresenceView | null {
  const short = handle.replace(/^.*\//, '').toLowerCase()
  for (const p of presence) {
    if (p.agent === actorId) return p
    const pShort = (p.profile ?? p.handle.replace(/^.*\//, '')).toLowerCase()
    if (pShort === short) return p
  }
  return null
}

export function renderThreadView(state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-thread-view' })
  const tv = state.activeThread
  if (!tv) {
    wrap.appendChild(el('div', { className: 'cb-empty-state', textContent: 'Loading thread…' }))
    return wrap
  }
  const root = tv.message
  const knownGroups = new Set(state.groups.map((g) => g.handle.toLowerCase()))
  const actorLabels = buildActorLabelMap(state)

  // Header
  const header = el('div', { className: 'cb-thread-header' })
  const hLeft = el('div', { className: 'cb-thread-header-left' })
  const backBtn = el(
    'button',
    { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-sm' },
    el('span', { textContent: `← #${root.channel}` }),
  )
  backBtn.addEventListener('click', () => actions.openChannel(root.channel, root.channel.startsWith('dm/') ? 'chat' : 'forum'))
  hLeft.appendChild(backBtn)

  hLeft.appendChild(el('h1', { className: 'cb-thread-title', textContent: firstLineTitle(root.text, 100, actorLabels) }))
  hLeft.appendChild(
    el('span', {
      className: 'cb-muted-pill',
      textContent: `${tv.replies.length + 1} posts · #${root.id}`,
    }),
  )
  header.appendChild(hLeft)

  const hRight = el('div', { className: 'cb-thread-header-actions' })
  const filterInput = el('input', {
    type: 'search',
    className: 'cb-input cb-input-sm',
    'data-focus-key': 'thread-filter',
    placeholder: 'Search this topic…',
    value: state.threadFilter,
    'aria-label': 'Filter posts in this thread',
  })
  filterInput.addEventListener('input', () => actions.setThreadFilter(filterInput.value))
  hRight.appendChild(filterInput)

  const sortSel = el('select', { className: 'cb-select cb-select-sm', 'aria-label': 'Sort replies' })
  for (const [val, lbl] of [
    ['asc', 'Oldest first'],
    ['desc', 'Newest first'],
  ] as const) {
    const o = el('option', { value: val, textContent: lbl })
    if (state.threadSort === val) o.selected = true
    sortSel.appendChild(o)
  }
  sortSel.addEventListener('change', () => actions.setThreadSort(sortSel.value as 'asc' | 'desc'))
  hRight.appendChild(sortSel)

  const isAnnounced = state.channelPins.some((p) => p.rootId === root.id && p.scope === 'announcement')
  const isSticky = state.channelPins.some((p) => p.rootId === root.id && p.scope === 'channel')
  const pinThreadBtn = el(
    'button',
    { type: 'button', className: `cb-btn cb-btn-sm ${isSticky ? 'cb-btn-secondary' : 'cb-btn-ghost'}` },
    svgIcon('pin', 13),
    el('span', { textContent: isSticky ? 'Unpin Sticky' : 'Pin Sticky' }),
  )
  pinThreadBtn.addEventListener('click', () => {
    if (isSticky) void actions.unpinMessage(root.id, 'channel')
    else void actions.pinMessage(root, 'channel')
  })
  hRight.appendChild(pinThreadBtn)

  const announceBtn = el(
    'button',
    { type: 'button', className: `cb-btn cb-btn-sm ${isAnnounced ? 'cb-btn-secondary' : 'cb-btn-ghost'}` },
    svgIcon('megaphone', 13),
    el('span', { textContent: isAnnounced ? 'Unannounce' : 'Announce' }),
  )
  announceBtn.addEventListener('click', () => {
    if (isAnnounced) void actions.unpinMessage(root.id, 'announcement')
    else void actions.pinMessage(root, 'announcement')
  })
  hRight.appendChild(announceBtn)

  if (!root.task) {
    const promoteBtn = el(
      'button',
      { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-sm', title: 'Track this thread as a Task' },
      svgIcon('tasks', 13),
      el('span', { textContent: 'Make Task' }),
    )
    promoteBtn.addEventListener('click', () => {
      void actions.promoteToTask(root.id)
    })
    hRight.appendChild(promoteBtn)
  }
  header.appendChild(hRight)
  wrap.appendChild(header)

  // Task Lifecycle Bar (if thread is a task)
  if (root.task) {
    wrap.appendChild(renderTaskLifecycleBar(root, state, actions))
  }

  // Posts list
  const stream = el('div', { className: 'cb-posts-stream' })
  const allPosts = state.threadSort === 'asc' ? [root, ...tv.replies] : [...[...tv.replies].reverse(), root]
  const fq = state.threadFilter.trim().toLowerCase()
  const visible = fq
    ? allPosts.filter((m) => {
        const who = m.author?.handle ?? m.by.actor
        return m.text.toLowerCase().includes(fq) || who.toLowerCase().includes(fq)
      })
    : allPosts

  for (const msg of visible) {
    stream.appendChild(renderStructuredPostCard(msg, msg.id === root.id, state, actions, knownGroups))
  }
  wrap.appendChild(stream)

  // Quick reply chips (Google Chat style) + Composer
  wrap.appendChild(renderComposerPanel(`Reply to thread #${root.id}…`, state, actions, true))
  return wrap
}

export function renderLiveChatFeed(channelPath: string, state: UiState, actions: UiActions): HTMLElement {
  const wrap = el('div', { className: 'cb-thread-view' })
  const isDm = channelPath.startsWith('dm/')
  const chMeta = state.flatChannels.find((c) => c.path === channelPath) ?? null
  const knownGroups = new Set(state.groups.map((g) => g.handle.toLowerCase()))

  const header = el('div', { className: 'cb-thread-header' })
  const hLeft = el('div', { className: 'cb-thread-header-left' })
  const titleText = isDm ? `DM with ${extractDmPeer(channelPath, state.me?.handle ?? null)}` : `#${channelPath}`
  hLeft.appendChild(el('h1', { className: 'cb-thread-title', textContent: titleText }))
  if (chMeta?.topic) {
    hLeft.appendChild(el('span', { className: 'cb-muted-note', textContent: chMeta.topic }))
  }
  header.appendChild(hLeft)

  const hRight = el('div', { className: 'cb-thread-header-actions' })
  const markRead = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-sm' }, svgIcon('check', 13), el('span', { textContent: 'Mark read' }))
  markRead.addEventListener('click', () => {
    void actions.markChannelRead(channelPath)
  })
  hRight.appendChild(markRead)
  header.appendChild(hRight)
  wrap.appendChild(header)

  const stream = el('div', { className: 'cb-posts-stream' })
  if (state.channelMessages.length === 0) {
    stream.appendChild(
      el('div', {
        className: 'cb-empty-state',
        textContent: isDm
          ? `Start a direct conversation with ${extractDmPeer(channelPath, state.me?.handle ?? null)}.`
          : `No messages in #${channelPath} yet. Drop a message below!`,
      }),
    )
  } else {
    for (const msg of state.channelMessages) {
      stream.appendChild(renderStructuredPostCard(msg, msg.re === null, state, actions, knownGroups, true))
    }
  }
  wrap.appendChild(stream)

  const placeholder = isDm
    ? `Message ${extractDmPeer(channelPath, state.me?.handle ?? null)}…`
    : `Message #${channelPath} (type @, #, or /)`
  wrap.appendChild(renderComposerPanel(placeholder, state, actions, true))
  return wrap
}

function renderTaskLifecycleBar(root: UiMessageView, state: UiState, actions: UiActions): HTMLElement {
  const task = root.task!
  const bar = el('div', { className: `cb-task-bar cb-task-bar-${task.state}` })

  const left = el('div', { className: 'cb-task-bar-info' })
  left.appendChild(el('span', { className: `cb-task-pill cb-task-${task.state}`, textContent: task.state.toUpperCase() }))
  if (task.for) {
    left.appendChild(el('span', { className: 'cb-task-meta', textContent: `Assigned: ${task.for.replace(/^local:user:/, '')}` }))
  }
  if (task.claim) {
    left.appendChild(
      el('span', {
        className: 'cb-task-meta',
        textContent: `Claimed by ${task.claim.actor.replace(/^local:user:/, '')}`,
      }),
    )
  }
  if (task.blocked) {
    left.appendChild(
      el('span', {
        className: 'cb-task-blocked-reason',
        textContent: `Blocked${task.blocked.kind ? ` (${task.blocked.kind})` : ''}: ${task.blocked.reason}`,
      }),
    )
  }
  if (task.result) {
    left.appendChild(el('span', { className: 'cb-task-meta', textContent: `Result: ${task.result}` }))
  }
  bar.appendChild(left)

  const btns = el('div', { className: 'cb-task-bar-actions' })
  if (task.state === 'blocked') {
    const unblockBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-sm', textContent: 'Approve & Unblock' })
    unblockBtn.addEventListener('click', () => {
      void actions.unblockTask(root.id)
    })
    btns.appendChild(unblockBtn)
  }
  if (task.state === 'ready') {
    const claimBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-secondary cb-btn-sm', textContent: 'Claim' })
    claimBtn.addEventListener('click', () => {
      void actions.claimTask(root.id)
    })
    btns.appendChild(claimBtn)
  }
  if (task.state === 'ready' || (task.state === 'claimed' && state.claimCache[root.id] !== undefined)) {
    const compBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-sm', textContent: 'Complete' })
    compBtn.addEventListener('click', () => {
      void actions.completeTask(root.id)
    })
    btns.appendChild(compBtn)
  }
  if (task.state === 'ready' || task.state === 'waiting') {
    const blockBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-sm', textContent: 'Block' })
    blockBtn.addEventListener('click', () => {
      actions.openModal({ kind: 'block-task', taskId: root.id })
    })
    btns.appendChild(blockBtn)
  }
  if (canReopenTaskState(task.state)) {
    const reopenBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-secondary cb-btn-sm', textContent: 'Reopen' })
    reopenBtn.addEventListener('click', () => {
      void actions.reopenTask(root.id)
    })
    btns.appendChild(reopenBtn)
  }

  bar.appendChild(btns)
  return bar
}

function renderStructuredPostCard(
  msg: UiMessageView,
  isRoot: boolean,
  state: UiState,
  actions: UiActions,
  knownGroups: ReadonlySet<string>,
  showThreadLink = false,
): HTMLElement {
  const authorHandle = msg.author?.handle ?? msg.by.profile ?? msg.by.actor.replace(/^local:user:/, '')
  const authorName = msg.author?.name ?? authorHandle
  const shortHandle = authorHandle.replace(/^.*\//, '')
  const isHuman = msg.author?.kind === 'person'
  const isMe = state.me !== null && msg.by.actor === state.me.actor
  const pres = threadPresenceForActor(msg.by.actor, authorHandle, state.presence)
  const isOnline = pres !== null && pres.status !== 'offline'
  const isFlagged = msg.labels['flag.status'] === 'open'
  const isPinned = state.channelPins.some((p) => p.messageId === msg.id) || state.allPins.some((p) => p.messageId === msg.id)

  const card = el('article', {
    className: `cb-post-card${isRoot ? ' is-root' : ''}${isFlagged ? ' is-flagged' : ''}${msg.deleted ? ' is-deleted' : ''}`,
    id: `post-${msg.id}`,
  })

  // Left main column (phpBB Thread View structure)
  const main = el('div', { className: 'cb-post-main' })

  // Post header toolbar
  const top = el('div', { className: 'cb-post-top' })
  const meta = el('div', { className: 'cb-post-meta' })
  meta.appendChild(el('span', { className: 'cb-post-id', textContent: `#${msg.id}` }))
  meta.appendChild(el('span', { className: 'cb-post-time', title: formatFullTime(msg.createdAt), textContent: formatRelativeTime(msg.createdAt) }))
  if (msg.editedAt) {
    meta.appendChild(el('span', { className: 'cb-post-edited', textContent: '(edited)' }))
  }
  if (isPinned) {
    meta.appendChild(el('span', { className: 'cb-tag cb-tag-sticky', textContent: 'PINNED' }))
  }
  if (showThreadLink && msg.re === null) {
    const openThr = el('button', { type: 'button', className: 'cb-link-btn', textContent: 'Open thread →' })
    openThr.addEventListener('click', () => actions.openThread(msg.channel, msg.id))
    meta.appendChild(openThr)
  } else if (showThreadLink && msg.re !== null) {
    const openThr = el('button', { type: 'button', className: 'cb-link-btn', textContent: `in thread #${msg.re}` })
    openThr.addEventListener('click', () => actions.openThread(msg.channel, msg.re!))
    meta.appendChild(openThr)
  }
  top.appendChild(meta)

  // Per-post action buttons (Quote, Pin, React, Edit, Delete, Flag)
  if (!msg.deleted) {
    const toolbar = el('div', { className: 'cb-post-actions' })
    const mkAct = (label: string, icon: Parameters<typeof svgIcon>[0], onClick: () => void, cls = ''): HTMLButtonElement => {
      const b = el('button', { type: 'button', className: `cb-post-act ${cls}`.trim(), title: label }, svgIcon(icon, 13), el('span', { textContent: label }))
      b.addEventListener('click', onClick)
      return b
    }

    toolbar.appendChild(mkAct('Quote', 'quote', () => actions.setComposerQuote(msg)))
    toolbar.appendChild(
      mkAct(isPinned ? 'Unpin' : 'Pin', 'pin', () => {
        if (isPinned) void actions.unpinMessage(msg.id)
        else void actions.pinMessage(msg, isRoot ? 'channel' : 'thread')
      }),
    )
    toolbar.appendChild(
      mkAct('React', 'smile', () => {
        actions.toggleReactPicker(state.reactPickerMessageId === msg.id ? null : msg.id)
      }),
    )
    if (isMe) {
      toolbar.appendChild(mkAct('Edit', 'edit', () => actions.startEditMessage(msg)))
      toolbar.appendChild(mkAct('Delete', 'trash', () => { void actions.deleteMessage(msg) }, 'cb-act-danger'))
    }
    toolbar.appendChild(mkAct('Flag', 'flag', () => actions.openModal({ kind: 'flag', message: msg }), isFlagged ? 'is-active' : ''))
    top.appendChild(toolbar)
  }
  main.appendChild(top)

  // Reported / Flagged Banner (phpBB style)
  if (isFlagged) {
    const banner = el('div', { className: 'cb-flag-banner' })
    const reason = msg.labels['flag.reason'] ?? 'Flagged for review'
    const by = msg.labels['flag.by'] ?? 'user'
    banner.appendChild(
      el(
        'div',
        { className: 'cb-flag-text' },
        svgIcon('flag', 14),
        el('span', { textContent: `Reported: ${reason} (by ${by})` }),
      ),
    )
    const resolveBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-sm cb-btn-ghost', textContent: 'Resolve' })
    resolveBtn.addEventListener('click', () => {
      void actions.resolveFlag(msg)
    })
    banner.appendChild(resolveBtn)
    main.appendChild(banner)
  }

  const actorLabels = buildActorLabelMap(state)

  // Quoted-reply nested block (Google Chat + phpBB style)
  if (msg.quote) {
    const q = msg.quote
    const qBlock = el('div', { className: 'cb-quote-card' })
    qBlock.appendChild(
      el(
        'div',
        { className: 'cb-quote-head' },
        svgIcon('quote', 12),
        el('span', { textContent: `${q.handle ?? q.by} wrote (#${q.id}):` }),
      ),
    )
    qBlock.appendChild(el('div', { className: 'cb-quote-body', textContent: formatCanonicalMentionsText(q.excerpt, actorLabels) }))
    qBlock.addEventListener('click', () => {
      const target = document.getElementById(`post-${q.id}`)
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      else actions.openThread(q.channel, q.id)
    })
    main.appendChild(qBlock)
  }

  // Body or inline Edit box
  if (msg.deleted) {
    main.appendChild(el('div', { className: 'cb-deleted-note', textContent: '[message deleted]' }))
  } else if (state.editingMessageId === msg.id) {
    const editWrap = el('div', { className: 'cb-edit-box' })
    const ta = el('textarea', { className: 'cb-textarea', rows: 4 })
    ta.value = state.editingText
    ta.addEventListener('input', () => {
      state.editingText = ta.value
    })
    editWrap.appendChild(ta)
    const editActs = el('div', { className: 'cb-edit-actions' })
    const cancel = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-sm', textContent: 'Cancel' })
    cancel.addEventListener('click', () => actions.cancelEditMessage())
    const save = el('button', { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-sm', textContent: 'Save Edit' })
    save.addEventListener('click', () => {
      void actions.saveEditMessage(msg.id, ta.value, msg.revision)
    })
    editActs.appendChild(cancel)
    editActs.appendChild(save)
    editWrap.appendChild(editActs)
    main.appendChild(editWrap)
  } else {
    const bodyEl = el('div', { className: 'cb-post-body' })
    bodyEl.appendChild(
      renderRichText(msg.text, {
        knownGroups,
        actorLabels,
        onChannelClick: (ch) => actions.openChannel(ch, 'forum'),
        onMentionClick: (handle, isGroup) => {
          if (isGroup) actions.toggleDrawer('groups')
          else void actions.openOrCreateDm(handle)
        },
      }),
    )
    main.appendChild(bodyEl)
  }

  // Structured blocks (e.g., board-feedback@1)
  if (msg.blocks.length > 0 && !msg.deleted) {
    for (const blk of msg.blocks) {
      const bCard = el('div', { className: 'cb-struct-block' })
      bCard.appendChild(el('div', { className: 'cb-struct-head', textContent: `${blk.schema}@${blk.version}` }))
      const grid = el('dl', { className: 'cb-struct-dl' })
      for (const [k, v] of Object.entries(blk.data)) {
        if (v === undefined || v === null || v === '') continue
        grid.appendChild(el('dt', { textContent: k }))
        grid.appendChild(el('dd', { textContent: typeof v === 'string' ? v : JSON.stringify(v) }))
      }
      bCard.appendChild(grid)
      main.appendChild(bCard)
    }
  }

  // Labels & Reactions row
  const visibleLabels = Object.entries(msg.labels).filter(([k]) => !k.startsWith('board.') && !k.startsWith('flag.'))
  const reactionEntries = Object.entries(msg.reactions).filter(([, actors]) => actors.length > 0)
  if (visibleLabels.length > 0 || reactionEntries.length > 0 || state.reactPickerMessageId === msg.id) {
    const footRow = el('div', { className: 'cb-post-foot' })
    for (const [k, v] of visibleLabels) {
      footRow.appendChild(el('span', { className: 'cb-label-chip', textContent: `${k}=${v}` }))
    }
    for (const [emoji, actors] of reactionEntries) {
      const mine = state.me !== null && actors.includes(state.me.actor)
      const rBtn = el(
        'button',
        {
          type: 'button',
          className: `cb-react-chip${mine ? ' is-mine' : ''}`,
          title: `${emoji}: ${actors.join(', ')}`,
        },
        el('span', { textContent: emojiDisplay(emoji) }),
        el('span', { className: 'cb-react-count', textContent: String(actors.length) }),
      )
      rBtn.addEventListener('click', () => {
        void actions.toggleReaction(msg, emoji)
      })
      footRow.appendChild(rBtn)
    }

    if (state.reactPickerMessageId === msg.id) {
      const picker = el('div', { className: 'cb-react-picker' })
      for (const code of QUICK_REACTION_CODES) {
        const rb = el('button', {
          type: 'button',
          className: 'cb-react-opt',
          title: `:${code}:`,
          textContent: emojiDisplay(code),
        })
        rb.addEventListener('click', () => {
          actions.toggleReactPicker(null)
          void actions.toggleReaction(msg, code)
        })
        picker.appendChild(rb)
      }
      footRow.appendChild(picker)
    }
    main.appendChild(footRow)
  }

  card.appendChild(main)

  // Right author metadata strip (phpBB Thread View!)
  const authorAside = el('aside', { className: 'cb-post-author' })
  if (isOnline) {
    authorAside.appendChild(el('div', { className: `cb-online-ribbon is-${pres!.status}`, textContent: pres!.status.toUpperCase() }))
  }
  const av = el('div', { className: 'cb-avatar', textContent: avatarMonogram(authorName) })
  av.style.setProperty('--av-hue', String(avatarHue(authorHandle)))
  authorAside.appendChild(av)
  authorAside.appendChild(el('div', { className: 'cb-author-name', textContent: authorName }))
  authorAside.appendChild(el('div', { className: 'cb-author-handle', textContent: `@${shortHandle}` }))
  authorAside.appendChild(
    el('span', {
      className: `cb-role-chip ${isHuman ? 'cb-role-human' : 'cb-role-agent'}`,
      textContent: isHuman ? (msg.author?.verified ? 'HUMAN ✓' : 'HUMAN') : 'AGENT',
    }),
  )
  if (pres?.harness || pres?.model) {
    authorAside.appendChild(
      el('div', {
        className: 'cb-author-tech',
        textContent: [pres.harness, pres.model].filter(Boolean).join(' · '),
      }),
    )
  } else if (msg.author?.via?.name) {
    authorAside.appendChild(el('div', { className: 'cb-author-tech', textContent: `via ${msg.author.via.name}` }))
  }

  if (!isMe) {
    const dmBtn = el('button', { type: 'button', className: 'cb-btn cb-btn-ghost cb-btn-xs cb-dm-btn', textContent: 'DM' })
    dmBtn.addEventListener('click', () => {
      void actions.openOrCreateDm(shortHandle)
    })
    authorAside.appendChild(dmBtn)
  }

  card.appendChild(authorAside)
  return card
}

function renderComposerPanel(
  placeholder: string,
  state: UiState,
  actions: UiActions,
  showQuickChips: boolean,
): HTMLElement {
  const wrap = el('div', { className: 'cb-composer-wrap' })

  // Google Chat-style quick reply chips
  if (showQuickChips) {
    const chips = el('div', { className: 'cb-quick-chips' })
    for (const text of ['Ack', 'LGTM', 'Needs review', 'Approved — proceed']) {
      const chip = el('button', { type: 'button', className: 'cb-quick-chip', textContent: text })
      chip.addEventListener('click', () => {
        void actions.sendQuickReply(text)
      })
      chips.appendChild(chip)
    }
    wrap.appendChild(chips)
  }

  // Quote preview bar
  if (state.composerQuote) {
    const q = state.composerQuote
    const qBar = el('div', { className: 'cb-composer-quote' })
    qBar.appendChild(
      el('span', {
        textContent: `Quoting #${q.id} (${q.author?.handle ?? q.by.actor}): ${excerptText(q.text, 90)}`,
      }),
    )
    const clearQ = el('button', { type: 'button', className: 'cb-icon-btn', title: 'Remove quote' }, svgIcon('close', 13))
    clearQ.addEventListener('click', () => actions.setComposerQuote(null))
    qBar.appendChild(clearQ)
    wrap.appendChild(qBar)
  }

  // Twist-style Tag recipient chips row
  const tagRow = el('div', { className: 'cb-composer-tags' })
  tagRow.appendChild(el('span', { className: 'cb-tag-label', textContent: 'Tag:' }))
  for (const tag of state.composerTags) {
    const chip = el('span', { className: 'cb-tag-chip' })
    chip.appendChild(el('span', { textContent: tag.startsWith('@') ? tag : `@${tag}` }))
    const x = el('button', { type: 'button', className: 'cb-tag-remove', 'aria-label': `Remove ${tag}`, textContent: '×' })
    x.addEventListener('click', () => actions.removeComposerTag(tag))
    chip.appendChild(x)
    tagRow.appendChild(chip)
  }
  const tagSel = el('select', { className: 'cb-tag-select', 'aria-label': 'Add tag recipient' })
  tagSel.appendChild(el('option', { value: '', textContent: '+ Tag @group / @agent…' }))
  tagSel.appendChild(el('option', { value: '@channel', textContent: '@channel (Everyone in channel)' }))
  tagSel.appendChild(el('option', { value: '@here', textContent: '@here (Online in channel)' }))
  for (const g of state.groups) {
    tagSel.appendChild(el('option', { value: `@${g.handle}`, textContent: `@${g.handle} (${g.members.length})` }))
  }
  for (const p of state.presence) {
    const short = p.profile ?? p.handle.replace(/^.*\//, '')
    tagSel.appendChild(el('option', { value: `@${short}`, textContent: `@${short} (${p.status})` }))
  }
  tagSel.addEventListener('change', () => {
    if (tagSel.value) {
      actions.addComposerTag(tagSel.value)
      tagSel.value = ''
    }
  })
  tagRow.appendChild(tagSel)
  wrap.appendChild(tagRow)

  // Composer box + live @ / # / slash autocomplete popover
  const box = el('div', { className: 'cb-composer-box' })
  const popover = el('div', { className: 'cb-autocomplete', hidden: true, role: 'listbox' })
  box.appendChild(popover)

  const ta = el('textarea', {
    className: 'cb-composer-input',
    'data-focus-key': 'composer-input',
    rows: 2,
    placeholder,
    'aria-label': placeholder,
  })
  ta.value = state.composerText

  let activeItems: UiAutocompleteItem[] = []
  let activeIndex = 0
  let activeTriggerStart = -1

  const hidePopover = (): void => {
    popover.hidden = true
    activeItems = []
    activeTriggerStart = -1
  }

  const applyItem = (item: UiAutocompleteItem): void => {
    if (item.insertText === '/task') {
      ta.value = ''
      actions.setComposerText('')
      hidePopover()
      const ch = state.workspace.kind === 'channel' || state.workspace.kind === 'thread' ? state.workspace.channel : 'work/agent-board'
      actions.openModal({ kind: 'new-task', channel: ch })
      return
    }
    if (item.insertText === '/feedback') {
      ta.value = ''
      actions.setComposerText('')
      hidePopover()
      actions.openModal({ kind: 'feedback' })
      return
    }
    const cursor = ta.selectionStart ?? ta.value.length
    const before = ta.value.slice(0, activeTriggerStart >= 0 ? activeTriggerStart : cursor)
    const after = ta.value.slice(cursor)
    const nextVal = `${before}${item.insertText}${after}`
    ta.value = nextVal
    actions.setComposerText(nextVal)
    const nextPos = before.length + item.insertText.length
    ta.focus()
    ta.setSelectionRange(nextPos, nextPos)
    if (item.insertText === '@' || item.insertText === '#') {
      updateAutocomplete()
    } else {
      hidePopover()
    }
  }

  const renderPopover = (): void => {
    while (popover.firstChild) popover.removeChild(popover.firstChild)
    if (activeItems.length === 0) {
      popover.hidden = true
      return
    }
    popover.hidden = false
    activeItems.forEach((item, idx) => {
      const btn = el(
        'button',
        {
          type: 'button',
          role: 'option',
          className: `cb-ac-item${idx === activeIndex ? ' is-selected' : ''}`,
        },
        el('span', { className: 'cb-ac-label', textContent: item.label }),
        el('span', { className: 'cb-ac-sub', textContent: item.sublabel }),
        item.badge ? el('span', { className: 'cb-ac-badge', textContent: item.badge }) : null,
      )
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        applyItem(item)
      })
      popover.appendChild(btn)
    })
  }

  const updateAutocomplete = (): void => {
    const pos = ta.selectionStart ?? ta.value.length
    const upToCursor = ta.value.slice(0, pos)
    const match = /(?:^|\s)([@#/])([a-zA-Z0-9_/-]*)$/.exec(upToCursor)
    if (!match) {
      hidePopover()
      return
    }
    const trigger = match[1] as '@' | '#' | '/'
    const query = match[2] ?? ''
    activeTriggerStart = pos - query.length - 1
    activeItems = buildAutocompleteItems(trigger, query, state)
    activeIndex = 0
    renderPopover()
  }

  ta.addEventListener('input', () => {
    actions.setComposerText(ta.value)
    updateAutocomplete()
  })

  ta.addEventListener('keydown', (ev) => {
    if (!popover.hidden && activeItems.length > 0) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault()
        activeIndex = (activeIndex + 1) % activeItems.length
        renderPopover()
        return
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault()
        activeIndex = (activeIndex - 1 + activeItems.length) % activeItems.length
        renderPopover()
        return
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault()
        const picked = activeItems[activeIndex]
        if (picked) applyItem(picked)
        return
      }
      if (ev.key === 'Escape') {
        ev.preventDefault()
        hidePopover()
        return
      }
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault()
      void actions.sendComposerMessage()
    }
  })

  box.appendChild(ta)

  const foot = el('div', { className: 'cb-composer-foot' })
  const who = state.me?.handle ?? 'human'
  foot.appendChild(
    el('span', {
      className: 'cb-composer-hint',
      textContent: `Posting as ${who} (${state.me?.kind === 'person' ? 'Human' : 'Agent'}) • @ mention • # channel • / actions • ⌘Enter send`,
    }),
  )
  const sendBtn = el(
    'button',
    { type: 'button', className: 'cb-btn cb-btn-primary cb-btn-sm' },
    svgIcon('send', 13),
    el('span', { textContent: 'Send' }),
  )
  sendBtn.addEventListener('click', () => {
    void actions.sendComposerMessage()
  })
  foot.appendChild(sendBtn)
  box.appendChild(foot)

  wrap.appendChild(box)
  return wrap
}
