// Social, messaging, channel, group, pin, presence, feedback, and search CLI commands
// (Swarmboard v2 launch design §3.2).
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { BoardClient } from '../../client/client.ts'
import { clientError } from '../../client/errors.ts'
import { insightViews, isInsightView } from '../../client/insight-views.ts'
import type { Env } from '../../client/resolve.ts'
import type { ChannelKind, GroupKind, NotificationPriority, NotificationReason, PinScope, PresenceStatus } from '../../core/public.ts'
import {
  getBoolFlag,
  getStringFlag,
  getStringListFlag,
  looksLikeMessageRef,
  parseCommandArgs,
  parseDurationSeconds,
  parseIntFlag,
  parseKeyValuePair,
  parseLabelRecord,
  splitCsvValues,
} from '../args.ts'
import type { CliIo } from '../bridge.ts'
import {
  EXIT_OK,
  renderChannelsList,
  renderChannelTree,
  renderGroup,
  renderGroups,
  renderInbox,
  renderMessage,
  renderNotificationsPage,
  renderPins,
  renderPresence,
  renderSearchHits,
  renderTasksPage,
  renderThread,
  renderThreadsPage,
  type Formatter,
} from '../output.ts'

export interface CommandEnv {
  readonly client: BoardClient
  readonly fmt: Formatter
  readonly io: CliIo
  readonly env: Env
}

function guessMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.txt':
    case '.log':
      return 'text/plain'
    case '.md':
      return 'text/markdown'
    case '.json':
      return 'application/json'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.pdf':
      return 'application/pdf'
    case '.csv':
      return 'text/csv'
    default:
      return 'application/octet-stream'
  }
}

async function resolveMessageText(
  positionalText: string | undefined,
  filePath: string | undefined,
  io: CliIo,
  schema?: string,
): Promise<string> {
  let raw = ''
  if (filePath !== undefined) {
    if (positionalText !== undefined) {
      throw clientError('conflicting_options', 'pass either inline text or --file, not both')
    }
    raw = filePath === '-' ? await io.readStdin() : fs.readFileSync(filePath, 'utf8')
  } else if (positionalText === '-') {
    raw = await io.readStdin()
  } else if (positionalText !== undefined) {
    raw = positionalText
  }

  if (schema !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw clientError('invalid_request', `--schema ${schema} requires valid JSON input`)
    }
    const pretty = JSON.stringify(parsed, null, 2)
    let maxTicks = 2
    for (const m of pretty.matchAll(/`+/g)) {
      if (m[0].length > maxTicks) maxTicks = m[0].length
    }
    const fence = '`'.repeat(maxTicks + 1)
    return `${fence}json#${schema}\n${pretty}\n${fence}`
  }

  return raw
}

async function uploadAttachments(client: BoardClient, attachPaths: readonly string[]): Promise<string[]> {
  const ids: string[] = []
  for (const filePath of attachPaths) {
    let data: Uint8Array
    try {
      data = new Uint8Array(fs.readFileSync(filePath))
    } catch (err) {
      throw clientError('invalid_request', `cannot read attachment "${filePath}"`, { cause: err })
    }
    const uploaded = await client.upload({
      data,
      name: path.basename(filePath),
      type: guessMimeType(filePath),
    })
    ids.push(uploaded.id)
  }
  return ids
}

function emitWarnings(fmt: Formatter, warnings: readonly string[]): void {
  for (const w of warnings) fmt.warn(w)
}

export async function cmdMe(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  parseCommandArgs(args, {})
  const me = await ctx.client.me()
  const view = {
    ...me,
    mode: ctx.client.selection.mode,
    source: ctx.client.selection.source,
    reason: ctx.client.selection.reason,
    ...(ctx.client.selection.fallback !== undefined ? { fallback: ctx.client.selection.fallback } : {}),
    transport: ctx.client.caps.transport,
    boardId: ctx.client.caps.boardId,
    instanceId: ctx.client.caps.instanceId,
    schemaVersion: ctx.client.caps.schemaVersion,
    writable: ctx.client.caps.writable,
  }
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(view)
    return EXIT_OK
  }
  const assurance = me.assurance ? ` assurance=${me.assurance}` : ''
  const profile = me.profile ? ` profile=${me.profile}` : ''
  ctx.fmt.line(
    `actor=${me.actor} handle=@${me.handle} kind=${me.kind}${profile}${assurance} mode=${view.mode} boardId=${view.boardId ?? 'n/a'}`,
  )
  return EXIT_OK
}

export async function cmdPost(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    label: { kind: 'string[]', short: 'l' },
    quote: { kind: 'string' },
    id: { kind: 'string', aliases: ['idempotency-key'] },
    attach: { kind: 'string[]' },
    file: { kind: 'string' },
    schema: { kind: 'string' },
    'no-sync': { kind: 'boolean' },
    sync: { kind: 'string[]' },
  })
  const channel = parsed.positionals[0]
  if (!channel) throw clientError('invalid_request', 'usage: swarmboard post <channel> <text>')
  const inlineText = parsed.positionals.length > 1 ? parsed.positionals.slice(1).join(' ') : undefined
  const text = await resolveMessageText(inlineText, getStringFlag(parsed.flags, 'file'), ctx.io, getStringFlag(parsed.flags, 'schema'))
  const attachIds = await uploadAttachments(ctx.client, getStringListFlag(parsed.flags, 'attach'))
  if (text.trim() === '' && attachIds.length === 0) {
    throw clientError('invalid_request', 'post requires non-empty text or at least one --attach file')
  }
  const labels = parseLabelRecord(getStringListFlag(parsed.flags, 'label'))
  const quoteMessageId = getStringFlag(parsed.flags, 'quote')
  const id = getStringFlag(parsed.flags, 'id')
  const noSync = getBoolFlag(parsed.flags, 'no-sync')
  const syncTargets = getStringListFlag(parsed.flags, 'sync')

  const msg = await ctx.client.post(channel, {
    text,
    ...(labels ? { labels } : {}),
    ...(quoteMessageId !== undefined ? { quoteMessageId } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(attachIds.length > 0 ? { attachments: attachIds } : {}),
    ...(noSync ? { noSync: true } : {}),
    ...(syncTargets.length > 0 ? { sync: [...syncTargets] } : {}),
  })
  renderMessage(ctx.fmt, msg, false)
  return EXIT_OK
}

export async function cmdReply(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    after: { kind: 'string' },
    quote: { kind: 'string' },
    label: { kind: 'string[]', short: 'l' },
    id: { kind: 'string', aliases: ['idempotency-key'] },
    attach: { kind: 'string[]' },
    file: { kind: 'string' },
    schema: { kind: 'string' },
    'no-sync': { kind: 'boolean' },
  })
  const targetId = parsed.positionals[0]
  if (!targetId) throw clientError('invalid_request', 'usage: swarmboard reply <id> <text>')
  const inlineText = parsed.positionals.length > 1 ? parsed.positionals.slice(1).join(' ') : undefined
  const text = await resolveMessageText(inlineText, getStringFlag(parsed.flags, 'file'), ctx.io, getStringFlag(parsed.flags, 'schema'))
  const attachIds = await uploadAttachments(ctx.client, getStringListFlag(parsed.flags, 'attach'))
  if (text.trim() === '' && attachIds.length === 0) {
    throw clientError('invalid_request', 'reply requires non-empty text or at least one --attach file')
  }
  const labels = parseLabelRecord(getStringListFlag(parsed.flags, 'label'))
  const after = getStringFlag(parsed.flags, 'after')
  const quoteMessageId = getStringFlag(parsed.flags, 'quote')
  const id = getStringFlag(parsed.flags, 'id')
  const noSync = getBoolFlag(parsed.flags, 'no-sync')

  const msg = await ctx.client.reply(targetId, {
    text,
    ...(after !== undefined ? { after } : {}),
    ...(quoteMessageId !== undefined ? { quoteMessageId } : {}),
    ...(labels ? { labels } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(attachIds.length > 0 ? { attachments: attachIds } : {}),
    ...(noSync ? { noSync: true } : {}),
  })
  renderMessage(ctx.fmt, msg, false)
  return EXIT_OK
}

export async function cmdRead(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    limit: { kind: 'string', short: 'n' },
    after: { kind: 'string' },
    before: { kind: 'string' },
    flat: { kind: 'boolean' },
    by: { kind: 'string' },
    mentions: { kind: 'mentions' },
    label: { kind: 'string[]', short: 'l' },
    text: { kind: 'string' },
    from: { kind: 'string' },
    order: { kind: 'string' },
    'no-pinned': { kind: 'boolean' },
    'include-meta': { kind: 'boolean' },
  })
  emitWarnings(ctx.fmt, parsed.warnings)

  const target = parsed.positionals[0]
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 500 })
  const after = getStringFlag(parsed.flags, 'after')
  const before = getStringFlag(parsed.flags, 'before')
  const flat = getBoolFlag(parsed.flags, 'flat') === true

  if (target !== undefined && looksLikeMessageRef(target)) {
    const thread = await ctx.client.thread(target, {
      ...(limit !== undefined ? { limit } : {}),
      ...(after !== undefined ? { after } : {}),
    })
    renderThread(ctx.fmt, thread)
    return EXIT_OK
  }

  if (flat) {
    if (!target) throw clientError('invalid_request', '--flat requires a channel path (e.g. swarmboard read dev --flat)')
    const page = await ctx.client.channel(target).messages({
      ...(limit !== undefined ? { limit } : {}),
      ...(after !== undefined ? { after } : {}),
    })
    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json(page)
    } else if (page.messages.length === 0) {
      ctx.fmt.line(`(no messages) cursor=${page.cursor}`)
    } else {
      for (const m of page.messages) renderMessage(ctx.fmt, m, false)
      ctx.fmt.line(`cursor=${page.cursor}`)
    }
    return EXIT_OK
  }

  const orderFlag = getStringFlag(parsed.flags, 'order')
  if (orderFlag !== undefined && orderFlag !== 'forum' && orderFlag !== 'chronological') {
    throw clientError('invalid_request', '--order must be "forum" or "chronological"')
  }
  const noPinned = getBoolFlag(parsed.flags, 'no-pinned') === true
  const order: 'forum' | 'chronological' = noPinned ? 'chronological' : (orderFlag ?? 'forum')
  const by = getStringFlag(parsed.flags, 'by')
  const mentions = getStringFlag(parsed.flags, 'mentions')
  const labels = getStringListFlag(parsed.flags, 'label')
  const text = getStringFlag(parsed.flags, 'text')
  const from = getStringFlag(parsed.flags, 'from')
  const includeMeta = getBoolFlag(parsed.flags, 'include-meta')

  const page = await ctx.client.threads({
    ...(target !== undefined ? { channel: target } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(by !== undefined ? { by } : {}),
    ...(mentions !== undefined ? { mentions } : {}),
    ...(labels.length > 0 ? { label: [...labels] } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(from !== undefined ? { from } : {}),
    order,
    pinnedFirst: !noPinned && order === 'forum',
    ...(includeMeta !== undefined ? { includeMeta } : {}),
  })
  renderThreadsPage(ctx.fmt, page)
  return EXIT_OK
}

export async function cmdThreads(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    by: { kind: 'string' },
    mentions: { kind: 'mentions' },
    label: { kind: 'string[]', short: 'l' },
    text: { kind: 'string' },
    from: { kind: 'string' },
    limit: { kind: 'string', short: 'n' },
    after: { kind: 'string' },
    before: { kind: 'string' },
    order: { kind: 'string' },
    'no-pinned': { kind: 'boolean' },
    'include-meta': { kind: 'boolean' },
  })
  emitWarnings(ctx.fmt, parsed.warnings)

  const channel = parsed.positionals[0]
  const orderFlag = getStringFlag(parsed.flags, 'order')
  if (orderFlag !== undefined && orderFlag !== 'forum' && orderFlag !== 'chronological') {
    throw clientError('invalid_request', '--order must be "forum" or "chronological"')
  }
  const noPinned = getBoolFlag(parsed.flags, 'no-pinned') === true
  const order: 'forum' | 'chronological' = noPinned ? 'chronological' : (orderFlag ?? 'forum')
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 500 })
  const after = getStringFlag(parsed.flags, 'after')
  const before = getStringFlag(parsed.flags, 'before')
  const by = getStringFlag(parsed.flags, 'by')
  const mentions = getStringFlag(parsed.flags, 'mentions')
  const labels = getStringListFlag(parsed.flags, 'label')
  const text = getStringFlag(parsed.flags, 'text')
  const from = getStringFlag(parsed.flags, 'from')
  const includeMeta = getBoolFlag(parsed.flags, 'include-meta')

  const page = await ctx.client.threads({
    ...(channel !== undefined ? { channel } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(by !== undefined ? { by } : {}),
    ...(mentions !== undefined ? { mentions } : {}),
    ...(labels.length > 0 ? { label: [...labels] } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(from !== undefined ? { from } : {}),
    order,
    pinnedFirst: !noPinned && order === 'forum',
    ...(includeMeta !== undefined ? { includeMeta } : {}),
  })
  renderThreadsPage(ctx.fmt, page)
  return EXIT_OK
}

export async function cmdEdit(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    rev: { kind: 'string', aliases: ['revision', 'if-revision'] },
    file: { kind: 'string' },
    schema: { kind: 'string' },
  })
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard edit <id> <text> [--rev N]')
  const inlineText = parsed.positionals.length > 1 ? parsed.positionals.slice(1).join(' ') : undefined
  const text = await resolveMessageText(inlineText, getStringFlag(parsed.flags, 'file'), ctx.io, getStringFlag(parsed.flags, 'schema'))
  if (text.trim() === '') throw clientError('invalid_request', 'edit requires non-empty text')
  const revision = parseIntFlag(getStringFlag(parsed.flags, 'rev'), 'rev', { min: 1 })
  const res = await ctx.client.edit(id, text, revision !== undefined ? { revision } : undefined)
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else {
    ctx.fmt.line(`edited #${res.message.id} rev=${res.message.revision}`)
  }
  return EXIT_OK
}

export async function cmdDelete(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    rev: { kind: 'string', aliases: ['revision', 'if-revision'] },
  })
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard delete <id> [--rev N]')
  const revision = parseIntFlag(getStringFlag(parsed.flags, 'rev'), 'rev', { min: 1 })
  const res = await ctx.client.delete(id, revision !== undefined ? { revision } : undefined)
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else {
    ctx.fmt.line(`deleted #${res.message.id}`)
  }
  return EXIT_OK
}

export async function cmdReact(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    remove: { kind: 'boolean' },
  })
  const [id, emoji] = parsed.positionals
  if (!id || !emoji) throw clientError('invalid_request', 'usage: swarmboard react <id> <emoji> [--remove]')
  const remove = getBoolFlag(parsed.flags, 'remove') === true
  const res = await ctx.client.react(id, emoji, remove ? { remove: true } : undefined)
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else {
    ctx.fmt.line(`${remove ? 'unreacted' : 'reacted'} #${res.message.id} ${emoji}`)
  }
  return EXIT_OK
}

export async function cmdLabel(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    set: { kind: 'string[]', short: 'l' },
    unset: { kind: 'string[]' },
    if: { kind: 'string[]' },
    'if-unset': { kind: 'string[]' },
  })
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard label <id> [--set k=v]... [--unset k]...')

  const setPairs = [...getStringListFlag(parsed.flags, 'set'), ...parsed.positionals.slice(1)]
  const setRec = parseLabelRecord(setPairs, '--set')
  const unsetList = [...getStringListFlag(parsed.flags, 'unset')]
  const ifPairs = getStringListFlag(parsed.flags, 'if')
  const ifUnset = getStringListFlag(parsed.flags, 'if-unset')

  let ifRec: Record<string, string | null> | undefined
  if (ifPairs.length > 0 || ifUnset.length > 0) {
    ifRec = {}
    for (const item of ifPairs) {
      const [k, v] = parseKeyValuePair(item, '--if')
      ifRec[k] = v
    }
    for (const k of ifUnset) ifRec[k] = null
  }

  if (!setRec && unsetList.length === 0) {
    throw clientError('invalid_request', 'label requires at least one --set k=v (or k=v arg) or --unset k')
  }

  const res = await ctx.client.label(id, {
    ...(setRec ? { set: setRec } : {}),
    ...(unsetList.length > 0 ? { unset: unsetList } : {}),
    ...(ifRec ? { if: ifRec } : {}),
  })
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else {
    const labelStr = Object.entries(res.message.labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    ctx.fmt.line(`labeled #${res.message.id}${labelStr ? ` ${labelStr}` : ''}`)
  }
  return EXIT_OK
}

export async function cmdFlag(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    feedback: { kind: 'boolean', aliases: ['cross-post-feedback'] },
    resolve: { kind: 'boolean' },
  })
  const id = parsed.positionals[0]
  const reason = parsed.positionals.slice(1).join(' ').trim()
  if (!id || !reason) throw clientError('invalid_request', 'usage: swarmboard flag <id> <reason> [--feedback] [--resolve]')
  const feedback = getBoolFlag(parsed.flags, 'feedback') === true
  const resolve = getBoolFlag(parsed.flags, 'resolve') === true
  const res = await ctx.client.flag(id, reason, {
    ...(feedback ? { feedback: true } : {}),
    ...(resolve ? { resolve: true } : {}),
  })
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else {
    const fb = res.feedback ? ` feedback=#${res.feedback.id}` : ''
    ctx.fmt.line(`flagged #${res.message.id} status=${resolve ? 'resolved' : 'open'}${fb}`)
  }
  return EXIT_OK
}

export async function cmdInsights(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, { run: { kind: 'string' }, limit: { kind: 'string', short: 'n' } })
  const [view, channel] = parsed.positionals
  if (parsed.positionals.length !== 2 || !channel || !isInsightView(view)) {
    throw clientError('invalid_request', `usage: swarmboard insights <${insightViews.join('|')}> <channel> [--run ID] [--limit N]`)
  }
  const run = getStringFlag(parsed.flags, 'run')
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 100 })
  const { getBoardInsights } = await import('../../client/insights.ts')
  const report = await getBoardInsights(ctx.client, {
    channel, view, ...(run !== undefined ? { run } : {}), ...(limit !== undefined ? { limit } : {}),
  })
  ctx.fmt.json(report)
  return EXIT_OK
}

export async function cmdInbox(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    limit: { kind: 'string', short: 'n' },
    'tasks-limit': { kind: 'string' },
    urgent: { kind: 'boolean', aliases: ['urgent-only'] },
    channel: { kind: 'string' },
    'no-ready': { kind: 'boolean' },
  })
  const notificationsLimit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 100 })
  const tasksLimit = parseIntFlag(getStringFlag(parsed.flags, 'tasks-limit'), 'tasks-limit', { min: 1, max: 100 })
  const urgentOnly = getBoolFlag(parsed.flags, 'urgent')
  const channel = getStringFlag(parsed.flags, 'channel') ?? parsed.positionals[0]
  const noReady = getBoolFlag(parsed.flags, 'no-ready') === true

  const inbox = await ctx.client.agentInbox({
    ...(notificationsLimit !== undefined ? { notificationsLimit } : {}),
    ...(tasksLimit !== undefined ? { tasksLimit } : {}),
    ...(urgentOnly ? { urgentOnly: true } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(noReady ? { includeReadyPool: false } : {}),
  })
  renderInbox(ctx.fmt, inbox)
  return EXIT_OK
}

const NOTIFICATION_REASONS: ReadonlySet<string> = new Set([
  'mention',
  'group_mention',
  'dm',
  'reply',
  'pin',
  'task_assigned',
  'attention',
])

export async function cmdMentions(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    all: { kind: 'boolean' },
    urgent: { kind: 'boolean' },
    reason: { kind: 'string' },
    channel: { kind: 'string' },
    after: { kind: 'string' },
    limit: { kind: 'string', short: 'n' },
    count: { kind: 'boolean' },
  })
  const all = getBoolFlag(parsed.flags, 'all') === true
  const urgent = getBoolFlag(parsed.flags, 'urgent') === true
  const reason = getStringFlag(parsed.flags, 'reason')
  if (reason !== undefined && !NOTIFICATION_REASONS.has(reason)) {
    throw clientError('invalid_request', `--reason must be one of ${[...NOTIFICATION_REASONS].join(', ')}`)
  }
  const channel = getStringFlag(parsed.flags, 'channel') ?? parsed.positionals[0]
  const after = getStringFlag(parsed.flags, 'after')
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 200 })
  const countOnly = getBoolFlag(parsed.flags, 'count') === true

  const query = {
    unreadOnly: !all,
    ...(urgent ? { priority: 'urgent' as NotificationPriority } : {}),
    ...(reason !== undefined ? { reason: reason as NotificationReason } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }

  if (countOnly) {
    const counts = await ctx.client.notifications.count(query)
    if (ctx.fmt.mode === 'json') ctx.fmt.json(counts)
    else ctx.fmt.line(`unread=${counts.unread} urgent=${counts.urgent} total=${counts.total}`)
    return EXIT_OK
  }

  const page = await ctx.client.notifications.list(query)
  renderNotificationsPage(ctx.fmt, page)
  return EXIT_OK
}

export async function cmdAck(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    all: { kind: 'boolean' },
    channel: { kind: 'string' },
    before: { kind: 'string', aliases: ['before-cursor'] },
    reason: { kind: 'string' },
    'read-only': { kind: 'boolean' },
    'mark-channel-read': { kind: 'boolean', aliases: ['mark-read'] },
  })
  const id = parsed.positionals[0]
  const all = getBoolFlag(parsed.flags, 'all') === true
  const channel = getStringFlag(parsed.flags, 'channel')
  const beforeCursor = getStringFlag(parsed.flags, 'before')
  const reason = getStringFlag(parsed.flags, 'reason')
  if (reason !== undefined && !NOTIFICATION_REASONS.has(reason)) {
    throw clientError('invalid_request', `--reason must be one of ${[...NOTIFICATION_REASONS].join(', ')}`)
  }
  const readOnly = getBoolFlag(parsed.flags, 'read-only') === true
  const markChannelReadFlag = getBoolFlag(parsed.flags, 'mark-channel-read')

  if (all) {
    if (id !== undefined) throw clientError('conflicting_options', 'pass either <notif-id> or --all, not both')
    const markChannelRead = markChannelReadFlag ?? (channel !== undefined && !channel.endsWith('/'))
    const res = await ctx.client.notifications.ackAll({
      ...(channel !== undefined ? { channel } : {}),
      ...(beforeCursor !== undefined ? { beforeCursor } : {}),
      ...(reason !== undefined ? { reason: reason as NotificationReason } : {}),
      ...(markChannelRead ? { markChannelRead: true } : {}),
    })
    let channelRead: { channel: string; cursor: string } | undefined
    if (channel !== undefined && !channel.endsWith('/') && markChannelRead) {
      channelRead = await ctx.client.markChannelRead(channel, beforeCursor)
    }
    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json({ ...res, ...(channelRead ? { channelRead } : {}) })
    } else {
      ctx.fmt.line(`acked=${res.acked} cursor=${res.cursor}${channelRead ? ` channel=${channelRead.channel}` : ''}`)
    }
    return EXIT_OK
  }

  if (!id && channel !== undefined && !channel.endsWith('/')) {
    const res = await ctx.client.markChannelRead(channel, beforeCursor)
    if (ctx.fmt.mode === 'json') ctx.fmt.json(res)
    else ctx.fmt.line(`read #${res.channel} cursor=${res.cursor}`)
    return EXIT_OK
  }

  if (!id) throw clientError('invalid_request', 'usage: swarmboard ack <notif-id> | swarmboard ack --all [--channel <ch>]')
  const res = await ctx.client.notifications.ack(id, readOnly ? { readOnly: true } : undefined)
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else {
    ctx.fmt.line(`${readOnly ? 'read' : 'acked'} n#${res.notification.id} [${res.notification.channel}]`)
  }
  return EXIT_OK
}

export async function cmdDm(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    limit: { kind: 'string', short: 'n' },
    after: { kind: 'string' },
    topic: { kind: 'string' },
    quote: { kind: 'string' },
    label: { kind: 'string[]', short: 'l' },
    id: { kind: 'string', aliases: ['idempotency-key'] },
    attach: { kind: 'string[]' },
    file: { kind: 'string' },
  })
  const peer = parsed.positionals[0]
  if (!peer) throw clientError('invalid_request', 'usage: swarmboard dm <peer> [text] [--limit N]')
  const inlineText = parsed.positionals.length > 1 ? parsed.positionals.slice(1).join(' ') : undefined
  const filePath = getStringFlag(parsed.flags, 'file')
  const attachIds = await uploadAttachments(ctx.client, getStringListFlag(parsed.flags, 'attach'))
  const topic = getStringFlag(parsed.flags, 'topic')

  if (inlineText !== undefined || filePath !== undefined || attachIds.length > 0) {
    const text = await resolveMessageText(inlineText, filePath, ctx.io)
    const labels = parseLabelRecord(getStringListFlag(parsed.flags, 'label'))
    const quoteMessageId = getStringFlag(parsed.flags, 'quote')
    const id = getStringFlag(parsed.flags, 'id')
    const res = await ctx.client.dm(peer, {
      text,
      ...(topic !== undefined ? { topic } : {}),
      ...(labels ? { labels } : {}),
      ...(quoteMessageId !== undefined ? { quoteMessageId } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(attachIds.length > 0 ? { attachments: attachIds } : {}),
    })
    if (ctx.fmt.mode === 'json') ctx.fmt.json(res)
    else renderMessage(ctx.fmt, res.message, false)
    return EXIT_OK
  }

  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 500 })
  const after = getStringFlag(parsed.flags, 'after')
  const res = await ctx.client.dm(peer, {
    ...(topic !== undefined ? { topic } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(after !== undefined ? { after } : {}),
  })
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else if (res.messages.length === 0) {
    ctx.fmt.line(`${res.channel.path} (no messages) cursor=${res.cursor}`)
  } else {
    for (const m of res.messages) renderMessage(ctx.fmt, m, false)
    ctx.fmt.line(`channel=${res.channel.path} cursor=${res.cursor}`)
  }
  return EXIT_OK
}

const PIN_SCOPES: ReadonlySet<string> = new Set(['thread', 'channel', 'announcement'])

export async function cmdPin(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    scope: { kind: 'string' },
    note: { kind: 'string' },
    'sort-order': { kind: 'string' },
    notify: { kind: 'boolean' },
  })
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard pin <id> [--scope thread|channel|announcement] [--note <t>]')
  const scope = getStringFlag(parsed.flags, 'scope') ?? 'channel'
  if (!PIN_SCOPES.has(scope)) {
    throw clientError('invalid_request', '--scope must be thread, channel, or announcement')
  }
  const note = getStringFlag(parsed.flags, 'note')
  const sortOrder = parseIntFlag(getStringFlag(parsed.flags, 'sort-order'), 'sort-order', { min: -1000, max: 1000 })
  const notify = getBoolFlag(parsed.flags, 'notify')
  const res = await ctx.client.pins.pin(id, {
    scope: scope as PinScope,
    ...(note !== undefined ? { note } : {}),
    ...(sortOrder !== undefined ? { sortOrder } : {}),
    ...(notify !== undefined ? { notify } : {}),
  })
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else {
    ctx.fmt.line(`pinned #${res.pin.messageId} [${res.pin.scope}] in #${res.pin.channel}`)
  }
  return EXIT_OK
}

export async function cmdUnpin(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    scope: { kind: 'string' },
  })
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard unpin <id> [--scope thread|channel|announcement]')
  const scope = getStringFlag(parsed.flags, 'scope')
  if (scope !== undefined && !PIN_SCOPES.has(scope)) {
    throw clientError('invalid_request', '--scope must be thread, channel, or announcement')
  }
  const res = await ctx.client.pins.unpin(id, scope !== undefined ? { scope: scope as PinScope } : undefined)
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else {
    ctx.fmt.line(`unpinned=${res.unpinned} #${id}`)
  }
  return EXIT_OK
}

export async function cmdPins(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    channel: { kind: 'string' },
    thread: { kind: 'string' },
    scope: { kind: 'string' },
    global: { kind: 'boolean', aliases: ['include-global'] },
    limit: { kind: 'string', short: 'n' },
  })
  const channel = getStringFlag(parsed.flags, 'channel') ?? parsed.positionals[0]
  const thread = getStringFlag(parsed.flags, 'thread')
  const scope = getStringFlag(parsed.flags, 'scope')
  if (scope !== undefined && !PIN_SCOPES.has(scope)) {
    throw clientError('invalid_request', '--scope must be thread, channel, or announcement')
  }
  const includeGlobal = getBoolFlag(parsed.flags, 'global')
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 200 })

  const pins = await ctx.client.pins.list({
    ...(channel !== undefined ? { channel } : {}),
    ...(thread !== undefined ? { thread } : {}),
    ...(scope !== undefined ? { scope: scope as PinScope } : {}),
    ...(includeGlobal !== undefined ? { includeGlobal } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })
  renderPins(ctx.fmt, pins)
  return EXIT_OK
}

const GROUP_KINDS: ReadonlySet<string> = new Set(['team', 'swarm', 'role', 'harness', 'system'])

export async function cmdGroup(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'list'
  const subArgs = args[0] && !args[0].startsWith('-') ? args.slice(1) : args

  switch (sub) {
    case 'list': {
      const parsed = parseCommandArgs(subArgs, {
        kind: { kind: 'string' },
        member: { kind: 'string' },
        channel: { kind: 'string' },
        limit: { kind: 'string', short: 'n' },
      })
      const kind = getStringFlag(parsed.flags, 'kind')
      if (kind !== undefined && !GROUP_KINDS.has(kind)) {
        throw clientError('invalid_request', `--kind must be one of ${[...GROUP_KINDS].join(', ')}`)
      }
      const member = getStringFlag(parsed.flags, 'member')
      const channel = getStringFlag(parsed.flags, 'channel')
      const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 200 })
      const groups = await ctx.client.groups.list({
        ...(kind !== undefined ? { kind: kind as GroupKind } : {}),
        ...(member !== undefined ? { member } : {}),
        ...(channel !== undefined ? { channel } : {}),
        ...(limit !== undefined ? { limit } : {}),
      })
      renderGroups(ctx.fmt, groups)
      return EXIT_OK
    }
    case 'show':
    case 'get': {
      const parsed = parseCommandArgs(subArgs, {})
      const handle = parsed.positionals[0]?.replace(/^@/, '')
      if (!handle) throw clientError('invalid_request', 'usage: swarmboard group show <handle>')
      const g = await ctx.client.groups.get(handle)
      renderGroup(ctx.fmt, g)
      return EXIT_OK
    }
    case 'create': {
      const parsed = parseCommandArgs(subArgs, {
        name: { kind: 'string' },
        description: { kind: 'string', aliases: ['desc'] },
        kind: { kind: 'string' },
        channel: { kind: 'string' },
        members: { kind: 'string[]', aliases: ['member'] },
      })
      const handle = parsed.positionals[0]?.replace(/^@/, '')
      if (!handle) throw clientError('invalid_request', 'usage: swarmboard group create <handle> [--name ...] [--members a,b]')
      const kind = getStringFlag(parsed.flags, 'kind')
      if (kind !== undefined && !GROUP_KINDS.has(kind)) {
        throw clientError('invalid_request', `--kind must be one of ${[...GROUP_KINDS].join(', ')}`)
      }
      const name = getStringFlag(parsed.flags, 'name') ?? handle
      const description = getStringFlag(parsed.flags, 'description')
      const channel = getStringFlag(parsed.flags, 'channel')
      const members = splitCsvValues(getStringListFlag(parsed.flags, 'members'))
      const g = await ctx.client.groups.create({
        handle,
        name,
        ...(description !== undefined ? { description } : {}),
        ...(kind !== undefined ? { kind: kind as GroupKind } : {}),
        ...(channel !== undefined ? { channel } : {}),
        ...(members.length > 0 ? { members } : {}),
      })
      renderGroup(ctx.fmt, g)
      return EXIT_OK
    }
    case 'update': {
      const parsed = parseCommandArgs(subArgs, {
        name: { kind: 'string' },
        description: { kind: 'string', aliases: ['desc'] },
        kind: { kind: 'string' },
        channel: { kind: 'string' },
      })
      const handle = parsed.positionals[0]?.replace(/^@/, '')
      if (!handle) throw clientError('invalid_request', 'usage: swarmboard group update <handle> [--name ...] [--description ...]')
      const kind = getStringFlag(parsed.flags, 'kind')
      if (kind !== undefined && !GROUP_KINDS.has(kind)) {
        throw clientError('invalid_request', `--kind must be one of ${[...GROUP_KINDS].join(', ')}`)
      }
      const name = getStringFlag(parsed.flags, 'name')
      const description = getStringFlag(parsed.flags, 'description')
      const channel = getStringFlag(parsed.flags, 'channel')
      const g = await ctx.client.groups.update(handle, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(kind !== undefined ? { kind: kind as GroupKind } : {}),
        ...(channel !== undefined ? { channel: channel === '' ? null : channel } : {}),
      })
      renderGroup(ctx.fmt, g)
      return EXIT_OK
    }
    case 'add': {
      const parsed = parseCommandArgs(subArgs, {
        role: { kind: 'string' },
      })
      const handle = parsed.positionals[0]?.replace(/^@/, '')
      const members = splitCsvValues(parsed.positionals.slice(1))
      if (!handle || members.length === 0) {
        throw clientError('invalid_request', 'usage: swarmboard group add <handle> <member...> [--role member|lead]')
      }
      const role = getStringFlag(parsed.flags, 'role')
      if (role !== undefined && role !== 'member' && role !== 'lead') {
        throw clientError('invalid_request', '--role must be "member" or "lead"')
      }
      const g = await ctx.client.groups.addMembers(handle, members, role ? { role } : undefined)
      renderGroup(ctx.fmt, g)
      return EXIT_OK
    }
    case 'remove': {
      const parsed = parseCommandArgs(subArgs, {})
      const handle = parsed.positionals[0]?.replace(/^@/, '')
      const members = splitCsvValues(parsed.positionals.slice(1))
      if (!handle || members.length === 0) {
        throw clientError('invalid_request', 'usage: swarmboard group remove <handle> <member...>')
      }
      const g = await ctx.client.groups.removeMembers(handle, members)
      renderGroup(ctx.fmt, g)
      return EXIT_OK
    }
    case 'delete': {
      const parsed = parseCommandArgs(subArgs, {})
      const handle = parsed.positionals[0]?.replace(/^@/, '')
      if (!handle) throw clientError('invalid_request', 'usage: swarmboard group delete <handle>')
      const res = await ctx.client.groups.delete(handle)
      if (ctx.fmt.mode === 'json') ctx.fmt.json(res)
      else ctx.fmt.line(`deleted @${handle}`)
      return EXIT_OK
    }
    default:
      throw clientError(
        'invalid_request',
        `unknown group subcommand "${sub}" (expected list, show, create, update, add, remove, or delete)`,
      )
  }
}

const CHANNEL_KINDS: ReadonlySet<string> = new Set(['chat', 'forum', 'tasks', 'dm', 'announcements'])

export async function cmdChannels(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const first = args[0]

  if (first === 'create') {
    const parsed = parseCommandArgs(args.slice(1), {
      kind: { kind: 'string' },
      topic: { kind: 'string' },
      category: { kind: 'string' },
      parent: { kind: 'string' },
      repo: { kind: 'string' },
      session: { kind: 'string', aliases: ['session-id'] },
      'sort-order': { kind: 'string' },
      private: { kind: 'boolean' },
      members: { kind: 'string[]', aliases: ['member'] },
    })
    const chPath = parsed.positionals[0]
    if (!chPath) throw clientError('invalid_request', 'usage: swarmboard channels create <path> [--kind ...] [--topic ...] [--private]')
    const kind = getStringFlag(parsed.flags, 'kind')
    if (kind !== undefined && !CHANNEL_KINDS.has(kind)) {
      throw clientError('invalid_request', `--kind must be one of ${[...CHANNEL_KINDS].join(', ')}`)
    }
    const topic = getStringFlag(parsed.flags, 'topic')
    const category = getStringFlag(parsed.flags, 'category')
    const parent = getStringFlag(parsed.flags, 'parent')
    const repo = getStringFlag(parsed.flags, 'repo')
    const sessionId = getStringFlag(parsed.flags, 'session')
    const sortOrder = parseIntFlag(getStringFlag(parsed.flags, 'sort-order'), 'sort-order', { min: -10000, max: 10000 })
    const isPrivate = getBoolFlag(parsed.flags, 'private')
    const members = splitCsvValues(getStringListFlag(parsed.flags, 'members'))

    const res = await ctx.client.createChannel(chPath, {
      ...(kind !== undefined ? { kind: kind as ChannelKind } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(parent !== undefined ? { parent } : {}),
      ...(repo !== undefined ? { repo } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      ...(isPrivate !== undefined ? { private: isPrivate } : {}),
      ...(members.length > 0 ? { members } : {}),
    })
    if (ctx.fmt.mode === 'json') ctx.fmt.json(res)
    else ctx.fmt.line(`${res.created ? 'created' : 'exists'} #${res.channel.path}`)
    return EXIT_OK
  }

  if (first === 'update') {
    const parsed = parseCommandArgs(args.slice(1), {
      kind: { kind: 'string' },
      topic: { kind: 'string' },
      category: { kind: 'string' },
      parent: { kind: 'string' },
      repo: { kind: 'string' },
      session: { kind: 'string', aliases: ['session-id'] },
      'sort-order': { kind: 'string' },
      archived: { kind: 'boolean' },
      private: { kind: 'boolean' },
      'add-members': { kind: 'string[]' },
      'remove-members': { kind: 'string[]' },
    })
    const chPath = parsed.positionals[0]
    if (!chPath) throw clientError('invalid_request', 'usage: swarmboard channels update <path> [--topic ...] [--archived]')
    const kind = getStringFlag(parsed.flags, 'kind')
    if (kind !== undefined && !CHANNEL_KINDS.has(kind)) {
      throw clientError('invalid_request', `--kind must be one of ${[...CHANNEL_KINDS].join(', ')}`)
    }
    const topic = getStringFlag(parsed.flags, 'topic')
    const category = getStringFlag(parsed.flags, 'category')
    const parent = getStringFlag(parsed.flags, 'parent')
    const repo = getStringFlag(parsed.flags, 'repo')
    const sessionId = getStringFlag(parsed.flags, 'session')
    const sortOrder = parseIntFlag(getStringFlag(parsed.flags, 'sort-order'), 'sort-order', { min: -10000, max: 10000 })
    const archived = getBoolFlag(parsed.flags, 'archived')
    const isPrivate = getBoolFlag(parsed.flags, 'private')
    const addMembers = splitCsvValues(getStringListFlag(parsed.flags, 'add-members'))
    const removeMembers = splitCsvValues(getStringListFlag(parsed.flags, 'remove-members'))

    const res = await ctx.client.updateChannel(chPath, {
      ...(kind !== undefined ? { kind: kind as ChannelKind } : {}),
      ...(topic !== undefined ? { topic: topic === '' ? null : topic } : {}),
      ...(category !== undefined ? { category: category === '' ? null : category } : {}),
      ...(parent !== undefined ? { parent: parent === '' ? null : parent } : {}),
      ...(repo !== undefined ? { repo: repo === '' ? null : repo } : {}),
      ...(sessionId !== undefined ? { sessionId: sessionId === '' ? null : sessionId } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      ...(archived !== undefined ? { archived } : {}),
      ...(isPrivate !== undefined ? { private: isPrivate } : {}),
      ...(addMembers.length > 0 ? { addMembers } : {}),
      ...(removeMembers.length > 0 ? { removeMembers } : {}),
    })
    if (ctx.fmt.mode === 'json') ctx.fmt.json(res)
    else ctx.fmt.line(`updated #${res.channel.path}`)
    return EXIT_OK
  }

  const parsed = parseCommandArgs(args, {
    tree: { kind: 'boolean' },
    kind: { kind: 'string' },
    archived: { kind: 'boolean' },
    'archived-filter': { kind: 'string' },
    repo: { kind: 'string' },
    session: { kind: 'string', aliases: ['session-id'] },
    limit: { kind: 'string', short: 'n' },
    after: { kind: 'string' },
    meta: { kind: 'boolean', aliases: ['include-meta'] },
  })
  const prefix = parsed.positionals[0]
  const tree = getBoolFlag(parsed.flags, 'tree') === true
  const kind = getStringFlag(parsed.flags, 'kind')
  if (kind !== undefined && !CHANNEL_KINDS.has(kind)) {
    throw clientError('invalid_request', `--kind must be one of ${[...CHANNEL_KINDS].join(', ')}`)
  }
  const archived = getBoolFlag(parsed.flags, 'archived')

  if (tree) {
    const page = await ctx.client.channelTree({
      ...(prefix !== undefined ? { prefix } : {}),
      ...(kind !== undefined ? { kind: kind as ChannelKind } : {}),
      ...(archived ? { archived: 'all' } : {}),
      includeUnread: true,
    })
    renderChannelTree(ctx.fmt, page)
    return EXIT_OK
  }

  const repo = getStringFlag(parsed.flags, 'repo')
  const sessionId = getStringFlag(parsed.flags, 'session')
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 500 })
  const after = getStringFlag(parsed.flags, 'after')
  const includeMeta = getBoolFlag(parsed.flags, 'meta')

  const page = await ctx.client.channels({
    ...(prefix !== undefined ? { prefix } : {}),
    ...(kind !== undefined ? { kind: kind as ChannelKind } : {}),
    ...(archived ? { archived: 'all' } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(includeMeta ? { includeMeta: true } : {}),
  })
  renderChannelsList(ctx.fmt, page.channels, page.next)
  return EXIT_OK
}

const PRESENCE_STATUSES: ReadonlySet<string> = new Set(['active', 'busy', 'idle', 'offline'])

export async function cmdWho(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    all: { kind: 'boolean' },
    status: { kind: 'string' },
    limit: { kind: 'string', short: 'n' },
  })
  const channel = parsed.positionals[0]
  const includeOffline = getBoolFlag(parsed.flags, 'all') === true
  const status = getStringFlag(parsed.flags, 'status')
  if (status !== undefined && !PRESENCE_STATUSES.has(status)) {
    throw clientError('invalid_request', '--status must be active, busy, idle, or offline')
  }
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 200 })
  const rows = await ctx.client.presence.list({
    ...(channel !== undefined ? { channel } : {}),
    ...(includeOffline ? { includeOffline: true } : {}),
    ...(status !== undefined ? { status: status as PresenceStatus } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })
  renderPresence(ctx.fmt, rows)
  return EXIT_OK
}

export async function cmdPresence(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  if (args[0] === 'set') {
    const parsed = parseCommandArgs(args.slice(1), {
      channel: { kind: 'string' },
      task: { kind: 'string', aliases: ['task-id'] },
      note: { kind: 'string' },
      harness: { kind: 'string' },
      model: { kind: 'string' },
      ttl: { kind: 'string' },
    })
    const status = parsed.positionals[0] ?? 'active'
    if (!PRESENCE_STATUSES.has(status)) {
      throw clientError('invalid_request', 'presence status must be active, busy, idle, or offline')
    }
    const channel = getStringFlag(parsed.flags, 'channel')
    const taskId = getStringFlag(parsed.flags, 'task')
    const note = getStringFlag(parsed.flags, 'note')
    const harness = getStringFlag(parsed.flags, 'harness') ?? ctx.env['SWARMBOARD_HARNESS']?.trim()
    const model = getStringFlag(parsed.flags, 'model') ?? ctx.env['SWARMBOARD_MODEL']?.trim()
    const ttlS = parseDurationSeconds(getStringFlag(parsed.flags, 'ttl'), 'ttl')

    const view = await ctx.client.presence.set({
      status: status as PresenceStatus,
      ...(channel !== undefined ? { channel: channel === '' ? null : channel } : {}),
      ...(taskId !== undefined ? { taskId: taskId === '' ? null : taskId } : {}),
      ...(note !== undefined ? { note: note === '' ? null : note } : {}),
      ...(harness ? { harness } : {}),
      ...(model ? { model } : {}),
      ...(ttlS !== undefined ? { ttlS: Math.round(ttlS) } : {}),
    })
    if (ctx.fmt.mode === 'json') ctx.fmt.json(view)
    else renderPresence(ctx.fmt, [view])
    return EXIT_OK
  }

  const listArgs = args[0] === 'list' ? args.slice(1) : args
  return cmdWho(ctx, listArgs)
}

export async function cmdFeedback(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    kind: { kind: 'string' },
    severity: { kind: 'string' },
    repro: { kind: 'string' },
    details: { kind: 'string' },
    expected: { kind: 'string' },
    actual: { kind: 'string' },
    suggestion: { kind: 'string' },
    harness: { kind: 'string' },
    model: { kind: 'string' },
    tool: { kind: 'string' },
    channel: { kind: 'string' },
  })
  const summary = parsed.positionals.join(' ').trim()
  if (!summary) {
    throw clientError(
      'invalid_request',
      'usage: swarmboard feedback <summary> [--kind bug|ux|perf|feature|confusion] [--severity low|med|high|blocker]',
    )
  }
  const kind = getStringFlag(parsed.flags, 'kind')
  const severity = getStringFlag(parsed.flags, 'severity')
  const repro = getStringFlag(parsed.flags, 'repro')
  const details = getStringFlag(parsed.flags, 'details')
  const expected = getStringFlag(parsed.flags, 'expected')
  const actual = getStringFlag(parsed.flags, 'actual')
  const suggestion = getStringFlag(parsed.flags, 'suggestion')
  const harness = getStringFlag(parsed.flags, 'harness') ?? ctx.env['SWARMBOARD_HARNESS']?.trim()
  const model = getStringFlag(parsed.flags, 'model') ?? ctx.env['SWARMBOARD_MODEL']?.trim()
  const tool = getStringFlag(parsed.flags, 'tool')
  const channel = getStringFlag(parsed.flags, 'channel')

  const msg = await ctx.client.feedback({
    summary,
    ...(kind !== undefined ? { kind } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(repro !== undefined ? { repro } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...(tool !== undefined ? { tool } : {}),
    ...(channel !== undefined ? { channel } : {}),
  })
  renderMessage(ctx.fmt, msg, false)
  return EXIT_OK
}

const SEARCH_SCOPES: ReadonlySet<string> = new Set(['all', 'messages', 'tasks', 'knowledge'])

export async function cmdSearch(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    channel: { kind: 'string' },
    subtree: { kind: 'boolean' },
    scope: { kind: 'string' },
    label: { kind: 'string[]', short: 'l' },
    limit: { kind: 'string', short: 'n' },
  })
  const query = parsed.positionals.join(' ').trim()
  if (!query) throw clientError('invalid_request', 'usage: swarmboard search <query> [--channel <ch>] [--scope all|messages|tasks|knowledge]')
  const scope = getStringFlag(parsed.flags, 'scope')
  if (scope !== undefined && !SEARCH_SCOPES.has(scope)) {
    throw clientError('invalid_request', '--scope must be all, messages, tasks, or knowledge')
  }
  const channel = getStringFlag(parsed.flags, 'channel')
  const subtree = getBoolFlag(parsed.flags, 'subtree')
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 200 })
  const rawLabels = getStringListFlag(parsed.flags, 'label')
  const labels =
    rawLabels.length > 0
      ? rawLabels.map((entry) => {
          const eq = entry.indexOf('=')
          if (eq < 0) return { key: entry, values: null }
          return { key: entry.slice(0, eq), values: entry.slice(eq + 1).split('|') }
        })
      : undefined

  const hits = await ctx.client.search({
    query,
    ...(channel !== undefined ? { channel } : {}),
    ...(subtree !== undefined ? { subtree } : {}),
    ...(scope !== undefined ? { scope: scope as 'all' | 'messages' | 'tasks' | 'knowledge' } : {}),
    ...(labels ? { labels } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })
  renderSearchHits(ctx.fmt, hits)
  return EXIT_OK
}

// Re-export for convenient use in sibling modules if needed
export { renderTasksPage }
