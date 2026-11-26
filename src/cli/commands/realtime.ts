// Realtime CLI commands: `wait` (including `--hook-rewake` Stop-hook exit 2) and `tail`
// (Swarmboard v2 launch design §3.2).
import { ClientError, clientError } from '../../client/errors.ts'
import { formatNotificationLine } from '../../client/format.ts'
import type { NotificationPriority, NotificationReason } from '../../core/public.ts'
import {
  getBoolFlag,
  getStringFlag,
  getStringListFlag,
  looksLikeMessageRef,
  parseCommandArgs,
  parseDurationSeconds,
  parseIntFlag,
} from '../args.ts'
import {
  EXIT_HOOK_WAKE,
  EXIT_OK,
  renderEventLine,
  renderNotificationsPage,
} from '../output.ts'
import type { CommandEnv } from './social.ts'

const NOTIFICATION_REASONS: ReadonlySet<string> = new Set([
  'mention',
  'group_mention',
  'dm',
  'reply',
  'pin',
  'task_assigned',
  'attention',
])

export async function cmdWait(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    inbox: { kind: 'boolean' },
    mentions: { kind: 'mentions' },
    re: { kind: 'string' },
    by: { kind: 'string' },
    label: { kind: 'string[]', short: 'l' },
    text: { kind: 'string' },
    from: { kind: 'string' },
    reason: { kind: 'string' },
    priority: { kind: 'string' },
    urgent: { kind: 'boolean' },
    after: { kind: 'string' },
    timeout: { kind: 'string' },
    'hook-rewake': { kind: 'boolean' },
  })
  for (const w of parsed.warnings) ctx.fmt.warn(w)

  const target = parsed.positionals[0]
  const inboxFlag = getBoolFlag(parsed.flags, 'inbox') === true
  const hookRewake = getBoolFlag(parsed.flags, 'hook-rewake') === true
  const mentions = getStringFlag(parsed.flags, 'mentions')
  let re = getStringFlag(parsed.flags, 're')
  const by = getStringFlag(parsed.flags, 'by')
  const labels = getStringListFlag(parsed.flags, 'label')
  const text = getStringFlag(parsed.flags, 'text')
  const from = getStringFlag(parsed.flags, 'from')
  const reason = getStringFlag(parsed.flags, 'reason')
  const priorityFlag = getStringFlag(parsed.flags, 'priority')
  const urgent = getBoolFlag(parsed.flags, 'urgent') === true
  let after = getStringFlag(parsed.flags, 'after')

  if (reason !== undefined && !NOTIFICATION_REASONS.has(reason)) {
    throw clientError('invalid_request', `--reason must be one of ${[...NOTIFICATION_REASONS].join(', ')}`)
  }
  if (priorityFlag !== undefined && priorityFlag !== 'normal' && priorityFlag !== 'urgent') {
    throw clientError('invalid_request', '--priority must be "normal" or "urgent"')
  }

  let channel: string | undefined
  if (target !== undefined) {
    if (!inboxFlag && looksLikeMessageRef(target)) {
      re = re ?? target
    } else {
      channel = target
    }
  }

  const timeoutS = parseDurationSeconds(getStringFlag(parsed.flags, 'timeout'), 'timeout') ?? 20

  const hasEventOnlyFilters =
    re !== undefined ||
    by !== undefined ||
    labels.length > 0 ||
    text !== undefined ||
    from !== undefined ||
    mentions !== undefined

  const useInboxMode =
    inboxFlag ||
    reason !== undefined ||
    priorityFlag !== undefined ||
    urgent ||
    (hookRewake && channel === undefined && !hasEventOnlyFilters)

  const callOpts = ctx.io.signal ? { signal: ctx.io.signal } : undefined

  if (useInboxMode) {
    const priority: NotificationPriority | undefined = urgent
      ? 'urgent'
      : (priorityFlag as NotificationPriority | undefined)
    const page = await ctx.client.notifications.wait(
      {
        unreadOnly: true,
        ...(channel !== undefined ? { channel } : {}),
        ...(reason !== undefined ? { reason: reason as NotificationReason } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(after !== undefined ? { after } : {}),
        wait: timeoutS,
      },
      callOpts,
    )

    if (page.notifications.length > 0) {
      if (hookRewake) {
        if (ctx.fmt.mode === 'json') {
          ctx.fmt.json({
            woke: true,
            mode: 'inbox',
            count: page.notifications.length,
            cursor: page.cursor,
            unread: page.unread,
            urgent: page.urgent,
            notifications: page.notifications,
          })
        } else {
          ctx.fmt.line(
            `wake: ${page.notifications.length} new notification(s) (unread=${page.unread} urgent=${page.urgent} cursor=${page.cursor})`,
          )
          for (const n of page.notifications) {
            ctx.fmt.line(`  ${formatNotificationLine(n, 140)}`)
          }
        }
        return EXIT_HOOK_WAKE
      }
      renderNotificationsPage(ctx.fmt, page)
      return EXIT_OK
    }

    if (hookRewake) {
      if (ctx.fmt.mode === 'json') {
        ctx.fmt.json({ woke: false, mode: 'inbox', reason: 'timeout', cursor: page.cursor })
      }
      return EXIT_OK
    }

    throw new ClientError(408, 'timeout', 'wait timed out with no matching notifications', {
      details: { cursor: page.cursor },
    })
  }

  // Event-stream waitPage mode
  const page = await ctx.client.waitPage(
    {
      timeoutS,
      ...(channel !== undefined ? { channel } : {}),
      ...(re !== undefined ? { re } : {}),
      ...(by !== undefined ? { by } : {}),
      ...(mentions !== undefined ? { mentions } : {}),
      ...(labels.length > 0 ? { label: [...labels] } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(after !== undefined ? { after } : {}),
    },
    callOpts,
  )

  if (page.events.length > 0) {
    if (hookRewake) {
      if (ctx.fmt.mode === 'json') {
        ctx.fmt.json({
          woke: true,
          mode: 'events',
          count: page.events.length,
          cursor: page.cursor,
          events: page.events,
        })
      } else {
        ctx.fmt.line(`wake: ${page.events.length} new event(s) (cursor=${page.cursor})`)
        for (const ev of page.events) {
          ctx.fmt.line(`  ${renderEventLine(ev)}`)
        }
      }
      return EXIT_HOOK_WAKE
    }

    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json(page)
    } else {
      for (const ev of page.events) ctx.fmt.line(renderEventLine(ev))
      ctx.fmt.line(`cursor=${page.cursor}`)
    }
    return EXIT_OK
  }

  if (hookRewake) {
    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json({ woke: false, mode: 'events', reason: 'timeout', cursor: page.cursor })
    }
    return EXIT_OK
  }

  throw new ClientError(408, 'timeout', 'wait timed out with no matching events', {
    details: { cursor: page.cursor },
  })
}

export async function cmdTail(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    mentions: { kind: 'mentions' },
    by: { kind: 'string' },
    re: { kind: 'string' },
    label: { kind: 'string[]', short: 'l' },
    text: { kind: 'string' },
    from: { kind: 'string' },
    after: { kind: 'string' },
    all: { kind: 'boolean' },
    last: { kind: 'string' },
    limit: { kind: 'string', short: 'n' },
  })
  for (const w of parsed.warnings) ctx.fmt.warn(w)

  const channel = parsed.positionals[0]
  const mentions = getStringFlag(parsed.flags, 'mentions')
  const by = getStringFlag(parsed.flags, 'by')
  const re = getStringFlag(parsed.flags, 're')
  const labels = getStringListFlag(parsed.flags, 'label')
  const text = getStringFlag(parsed.flags, 'text')
  const from = getStringFlag(parsed.flags, 'from')
  const after = getStringFlag(parsed.flags, 'after')
  const all = getBoolFlag(parsed.flags, 'all')
  const last = parseIntFlag(getStringFlag(parsed.flags, 'last'), 'last', { min: 1, max: 500 })
  const maxEvents = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1 })

  const callOpts = ctx.io.signal ? { signal: ctx.io.signal } : undefined
  let seen = 0

  for await (const ev of ctx.client.events(
    {
      ...(channel !== undefined ? { channel } : {}),
      ...(mentions !== undefined ? { mentions } : {}),
      ...(by !== undefined ? { by } : {}),
      ...(re !== undefined ? { re } : {}),
      ...(labels.length > 0 ? { label: [...labels] } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(all ? { all: true } : {}),
      ...(last !== undefined ? { last } : {}),
    },
    callOpts,
  )) {
    if (ctx.fmt.mode === 'json') {
      ctx.io.stdout(`${JSON.stringify(ev)}\n`)
    } else {
      ctx.fmt.line(renderEventLine(ev))
    }
    seen += 1
    if (maxEvents !== undefined && seen >= maxEvents) break
  }

  return EXIT_OK
}
