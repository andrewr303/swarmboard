// Output formatting, ANSI styling, secret redaction, and error formatting (Swarmboard v2 launch design §3.2).
// Thin boundary: uses only `../client/errors.ts` and `../client/format.ts` (NEVER core normalizers!).
import { errorPayload, isBoardError } from '../client/errors.ts'
import {
  compactAgentInbox,
  compactChannel,
  compactChannelTree,
  compactEvent,
  compactGroup,
  compactMessage,
  compactNotificationsPage,
  compactPin,
  compactPresence,
  compactTasksPage,
  compactThread,
  compactThreadsPage,
  excerptLine,
  formatChannelTreeLines,
  formatInboxDigest,
  formatMessageLine,
  formatNotificationLine,
  formatPresenceLine,
  formatTaskLine,
  formatThreadLine,
} from '../client/format.ts'
import type { Env } from '../client/resolve.ts'
import type {
  AgentInboxView,
  BoardEventView,
  ChannelTreePage,
  ChannelView,
  FtsSearchHit,
  GroupView,
  MessageView,
  NotificationsPage,
  PinView,
  PresenceView,
  TasksPage,
  ThreadsPage,
  ThreadView,
} from '../core/public.ts'
import type { CliGlobalFlags, CliIo, DoctorReport, TokenRecordView } from './bridge.ts'

export type OutputMode = 'json' | 'compact' | 'tty'

export interface Formatter {
  readonly mode: OutputMode
  readonly color: boolean
  readonly secrets: readonly string[]
  json(value: unknown): void
  line(text: string): void
  warn(text: string): void
  style: {
    bold(s: string): string
    dim(s: string): string
    cyan(s: string): string
    green(s: string): string
    yellow(s: string): string
    red(s: string): string
    magenta(s: string): string
  }
}

const TOKEN_WIRE_RE = /(?<![A-Za-z0-9_-])(sb_[a-z2-7]{12})_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})\b/gi

/** Collects known runtime secrets from env so they can never accidentally appear in diagnostic/error output. */
export function collectEnvSecrets(env: Env): string[] {
  const out: string[] = []
  for (const key of ['SWARMBOARD_TOKEN', 'BOARD_TOKEN']) {
    const val = env[key]?.trim()
    if (val && val.length >= 8) out.push(val)
  }
  return out
}

/** Redacts Swarmboard bearer tokens, generic Bearer credentials, and known env secrets from any string. */
export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let out = text.replace(TOKEN_WIRE_RE, '$1_[redacted]')
  out = out.replace(BEARER_RE, '$1[redacted]')
  for (const secret of extraSecrets) {
    if (secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join('[redacted]')
    }
  }
  return out
}

export function resolveOutputMode(globals: CliGlobalFlags, stdoutIsTTY: boolean): OutputMode {
  if (globals.json) return 'json'
  if (globals.compact) return 'compact'
  return stdoutIsTTY ? 'tty' : 'compact'
}

export function createFormatter(globals: CliGlobalFlags, env: Env, io: CliIo): Formatter {
  const mode = resolveOutputMode(globals, io.stdoutIsTTY)
  const color = mode === 'tty' && !globals.noColor && !env['NO_COLOR']
  const secrets = collectEnvSecrets(env)
  const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)

  return {
    mode,
    color,
    secrets,
    json(value: unknown): void {
      io.stdout(`${JSON.stringify(value, null, 2)}\n`)
    },
    line(text: string): void {
      io.stdout(`${text}\n`)
    },
    warn(text: string): void {
      io.stderr(`${redactSecrets(text, secrets)}\n`)
    },
    style: {
      bold: wrap('1'),
      dim: wrap('2'),
      cyan: wrap('36'),
      green: wrap('32'),
      yellow: wrap('33'),
      red: wrap('31'),
      magenta: wrap('35'),
    },
  }
}

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_HOOK_WAKE = 2
export const EXIT_PORT_TAKEN = 78

export interface FormattedError {
  readonly exitCode: number
  readonly code: string
  readonly stderr: string
}

/** Checks whether an error represents a port-already-in-use failure (`EADDRINUSE` / `port_in_use`). */
export function isPortInUseError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const rec = err as { code?: unknown; cause?: unknown; details?: unknown }
  if (rec.code === 'EADDRINUSE' || rec.code === 'port_in_use') return true
  if (rec.details && typeof rec.details === 'object' && (rec.details as { errno?: unknown }).errno === 'EADDRINUSE') {
    return true
  }
  if (rec.cause !== undefined && rec.cause !== err) return isPortInUseError(rec.cause)
  return false
}

/**
 * Formats any thrown value into CLI stderr + exit code using ONLY thin `src/client/errors.ts` helpers.
 * Secrets are unconditionally redacted.
 */
export function formatCliError(err: unknown, mode: OutputMode, secrets: readonly string[] = []): FormattedError {
  const exitCode = isPortInUseError(err) ? EXIT_PORT_TAKEN : EXIT_ERROR

  if (isBoardError(err)) {
    const { payload } = errorPayload(err)
    const cleanError = {
      code: payload.error.code,
      message: redactSecrets(payload.error.message, secrets),
      ...(payload.error.hint !== undefined ? { hint: redactSecrets(payload.error.hint, secrets) } : {}),
      ...(payload.error.details !== undefined ? { details: redactUnknown(payload.error.details, secrets) } : {}),
    }
    if (mode === 'json') {
      return {
        exitCode,
        code: cleanError.code,
        stderr: `${JSON.stringify({ error: cleanError })}\n`,
      }
    }
    const lines = [`error [${cleanError.code}]: ${cleanError.message}`]
    if (cleanError.hint) lines.push(`hint: ${cleanError.hint}`)
    return { exitCode, code: cleanError.code, stderr: `${lines.join('\n')}\n` }
  }

  const rawCode = isPortInUseError(err)
    ? 'port_in_use'
    : typeof (err as { code?: unknown } | null)?.code === 'string'
      ? String((err as { code: string }).code)
      : 'internal'
  const rawMessage = err instanceof Error ? err.message : String(err)
  const message = redactSecrets(rawMessage || 'unexpected error', secrets)

  if (mode === 'json') {
    return {
      exitCode,
      code: rawCode,
      stderr: `${JSON.stringify({ error: { code: rawCode, message } })}\n`,
    }
  }
  return { exitCode, code: rawCode, stderr: `error [${rawCode}]: ${message}\n` }
}

function redactUnknown(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 16 || value === null || value === undefined) return value
  if (typeof value === 'string') return redactSecrets(value, secrets)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactUnknown(v, secrets, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactUnknown(v, secrets, depth + 1)
  }
  return out
}

// ---- Rich TTY & Compact Renderers ----

export function renderMessage(fmt: Formatter, msg: MessageView, fullText = true): void {
  if (fmt.mode === 'json') {
    fmt.json(msg)
    return
  }
  if (fmt.mode === 'compact') {
    fmt.line(formatMessageLine(msg, fullText ? Infinity : 160))
    return
  }
  const s = fmt.style
  const who = msg.author?.handle ? `@${msg.author.handle}` : msg.by.actor
  const labels = Object.entries(msg.labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  const header = `${s.cyan(`#${msg.id}`)} ${s.dim(`[${msg.channel}]`)} ${s.bold(who)} ${s.dim(msg.createdAt)}`
  fmt.line(labels ? `${header} ${s.yellow(labels)}` : header)
  if (msg.quote) {
    const qWho = msg.quote.handle ? `@${msg.quote.handle}` : msg.quote.by
    fmt.line(s.dim(`  > #${msg.quote.id} ${qWho}: ${msg.quote.excerpt}`))
  }
  fmt.line(msg.deleted ? s.dim('  (deleted)') : `  ${msg.text}`)
  if (msg.task) {
    const assignee = msg.task.for ? ` for=${msg.task.for}` : ''
    fmt.line(s.magenta(`  task:${msg.task.state}${assignee}`))
  }
}

export function renderThread(fmt: Formatter, thread: ThreadView): void {
  if (fmt.mode === 'json') {
    fmt.json(thread)
    return
  }
  if (fmt.mode === 'compact') {
    fmt.line(formatMessageLine(thread.message, Infinity))
    for (const r of thread.replies) {
      fmt.line(`  ${formatMessageLine(r, Infinity)}`)
    }
    fmt.line(`cursor=${thread.cursor}`)
    return
  }
  renderMessage(fmt, thread.message, true)
  for (const r of thread.replies) {
    const s = fmt.style
    const who = r.author?.handle ? `@${r.author.handle}` : r.by.actor
    fmt.line(`  ${s.cyan(`#${r.id}`)} ${s.bold(who)} ${s.dim(r.createdAt)}`)
    if (r.quote) {
      fmt.line(s.dim(`    > #${r.quote.id}: ${r.quote.excerpt}`))
    }
    fmt.line(`    ${r.deleted ? s.dim('(deleted)') : r.text}`)
  }
  fmt.line(fmt.style.dim(`cursor: ${thread.cursor}`))
}

export function renderThreadsPage(fmt: Formatter, page: ThreadsPage): void {
  if (fmt.mode === 'json') {
    fmt.json(page)
    return
  }
  if (fmt.mode === 'compact') {
    if (page.threads.length === 0) {
      fmt.line(`(no threads) cursor=${page.cursor}`)
      return
    }
    for (const t of page.threads) fmt.line(formatThreadLine(t))
    fmt.line(`cursor=${page.cursor}${page.older ? ` older=${page.older}` : ''}`)
    return
  }
  const s = fmt.style
  if (page.threads.length === 0) {
    fmt.line(s.dim(`No threads found. (cursor: ${page.cursor})`))
    return
  }
  for (const t of page.threads) {
    const badge =
      t.pin?.scope === 'announcement'
        ? `${s.yellow('[ANN]')} `
        : t.pin?.scope === 'channel'
          ? `${s.magenta('[PIN]')} `
          : ''
    const who = t.message.author?.handle ? `@${t.message.author.handle}` : t.message.by.actor
    const rep = t.replies > 0 ? s.dim(` (${t.replies} replies)`) : ''
    fmt.line(`${badge}${s.cyan(`#${t.message.id}`)} ${s.dim(`[${t.message.channel}]`)} ${s.bold(who)}: ${excerptLine(t.message.text, 160)}${rep}`)
    if (t.last) {
      const lWho = t.last.author?.handle ? `@${t.last.author.handle}` : t.last.by.actor
      fmt.line(s.dim(`  └─ last #${t.last.id} ${lWho}: ${excerptLine(t.last.text, 100)}`))
    }
  }
  fmt.line(s.dim(`cursor: ${page.cursor}${page.older ? ` | older: ${page.older}` : ''}`))
}

export function renderTasksPage(fmt: Formatter, page: TasksPage): void {
  if (fmt.mode === 'json') {
    fmt.json(page)
    return
  }
  if (fmt.mode === 'compact') {
    if (page.tasks.length === 0) {
      fmt.line(`(no tasks) cursor=${page.cursor}`)
      return
    }
    for (const t of page.tasks) fmt.line(formatTaskLine(t))
    fmt.line(`cursor=${page.cursor}`)
    return
  }
  const s = fmt.style
  if (page.tasks.length === 0) {
    fmt.line(s.dim(`No tasks found. (cursor: ${page.cursor})`))
    return
  }
  for (const t of page.tasks) {
    const state = t.message.task?.state ?? 'ready'
    const colorState =
      state === 'completed'
        ? s.green(state)
        : state === 'failed' || state === 'blocked'
          ? s.red(state)
          : state === 'claimed'
            ? s.yellow(state)
            : s.cyan(state)
    const assignee = t.message.task?.for ? s.dim(` for=${t.message.task.for}`) : ''
    fmt.line(`[${colorState}] ${s.cyan(`#${t.message.id}`)} ${s.dim(`[${t.message.channel}]`)}${assignee}: ${excerptLine(t.message.text, 160)}`)
    if (t.replies > 0 && t.last) {
      const lWho = t.last.author?.handle ? `@${t.last.author.handle}` : t.last.by.actor
      fmt.line(s.dim(`  └─ ${t.replies}r; last ${lWho}: ${excerptLine(t.last.text, 100)}`))
    }
  }
  fmt.line(s.dim(`cursor: ${page.cursor}`))
}

export function renderInbox(fmt: Formatter, inbox: AgentInboxView): void {
  if (fmt.mode === 'json') {
    fmt.json(inbox)
    return
  }
  if (fmt.mode === 'compact') {
    fmt.line(formatInboxDigest(inbox))
    return
  }
  const s = fmt.style
  const who = inbox.profile ? `@${inbox.profile}` : inbox.actor
  fmt.line(
    `${s.bold(`Inbox ${who}`)}  ${s.yellow(`unread=${inbox.unreadNotifications}`)} ${inbox.urgentCount > 0 ? s.red(`urgent=${inbox.urgentCount}`) : s.dim('urgent=0')} ${s.green(`online=${inbox.onlinePeers}`)} ${s.dim(`cursor=${inbox.cursor}`)}`,
  )
  if (inbox.notifications.length > 0) {
    fmt.line(s.bold('Notifications:'))
    for (const n of inbox.notifications) fmt.line(`  ${formatNotificationLine(n, 140)}`)
  }
  if (inbox.tasks.assigned.length > 0) {
    fmt.line(s.bold('Assigned tasks:'))
    for (const t of inbox.tasks.assigned) fmt.line(`  ${formatTaskLine(t, 140)}`)
  }
  if (inbox.tasks.ready.length > 0) {
    fmt.line(s.bold('Ready tasks:'))
    for (const t of inbox.tasks.ready) fmt.line(`  ${formatTaskLine(t, 140)}`)
  }
  if (inbox.unreadDms.length > 0) {
    fmt.line(s.bold('Unread DMs:'))
    for (const d of inbox.unreadDms) {
      fmt.line(`  ${s.cyan(d.channel)} (@${d.peer}, ${d.unread} unread): ${excerptLine(d.lastExcerpt, 100)}`)
    }
  }
  if (inbox.unreadChannels.length > 0) {
    fmt.line(s.bold('Unread channels:'))
    for (const c of inbox.unreadChannels) {
      fmt.line(`  #${c.channel} ${s.dim(`[${c.kind}]`)} (${c.unread} unread)`)
    }
  }
  if (
    inbox.notifications.length === 0 &&
    inbox.tasks.assigned.length === 0 &&
    inbox.tasks.ready.length === 0 &&
    inbox.unreadDms.length === 0 &&
    inbox.unreadChannels.length === 0
  ) {
    fmt.line(s.dim('All caught up.'))
  }
}

export function renderNotificationsPage(fmt: Formatter, page: NotificationsPage): void {
  if (fmt.mode === 'json') {
    fmt.json(page)
    return
  }
  if (page.notifications.length === 0) {
    fmt.line(`(no notifications) unread=${page.unread} urgent=${page.urgent} cursor=${page.cursor}`)
    return
  }
  for (const n of page.notifications) {
    fmt.line(formatNotificationLine(n, 160))
  }
  fmt.line(`unread=${page.unread} urgent=${page.urgent} cursor=${page.cursor}`)
}

export function renderChannelsList(fmt: Formatter, channels: readonly ChannelView[], next: string | null): void {
  if (fmt.mode === 'json') {
    fmt.json({ channels, next })
    return
  }
  if (channels.length === 0) {
    fmt.line('(no channels)')
    return
  }
  for (const ch of channels) {
    const kind = ch.kind ? ` [${ch.kind}]` : ''
    const priv = ch.private ? ' [private]' : ''
    const arch = ch.archived ? ' [archived]' : ''
    const msgs = ch.messages !== undefined ? ` msgs=${ch.messages}` : ''
    const unread = ch.unreadCount ? ` unread=${ch.unreadCount}` : ''
    const topic = ch.topic ? ` — ${excerptLine(ch.topic, 80)}` : ''
    fmt.line(`#${ch.path}${kind}${priv}${arch}${msgs}${unread}${topic}`)
  }
  if (next) fmt.line(`next=${next}`)
}

export function renderChannelTree(fmt: Formatter, page: ChannelTreePage): void {
  if (fmt.mode === 'json') {
    fmt.json(page)
    return
  }
  const lines = formatChannelTreeLines(page.tree)
  if (lines.length === 0) {
    fmt.line(`(no channels) cursor=${page.cursor}`)
    return
  }
  for (const line of lines) fmt.line(line)
  fmt.line(`cursor=${page.cursor}`)
}

export function renderPins(fmt: Formatter, pins: readonly PinView[]): void {
  if (fmt.mode === 'json') {
    fmt.json({ pins })
    return
  }
  if (pins.length === 0) {
    fmt.line('(no pins)')
    return
  }
  for (const p of pins) {
    const note = p.note ? ` note="${excerptLine(p.note, 80)}"` : ''
    const text = p.message ? ` — ${excerptLine(p.message.text, 100)}` : ''
    fmt.line(`[${p.scope}] #${p.messageId} [${p.channel}] by=${p.pinnedBy}${note}${text}`)
  }
}

export function renderGroup(fmt: Formatter, g: GroupView): void {
  if (fmt.mode === 'json') {
    fmt.json(g)
    return
  }
  const members = g.members.map((m) => (m.role === 'lead' ? `${m.memberId}(lead)` : m.memberId)).join(', ')
  const ch = g.channel ? ` channel=#${g.channel}` : ''
  const desc = g.description ? ` — ${excerptLine(g.description, 100)}` : ''
  fmt.line(`@${g.handle} [${g.kind}] "${g.name}"${ch} (${g.members.length} members: ${members || 'none'})${desc}`)
}

export function renderGroups(fmt: Formatter, groups: readonly GroupView[]): void {
  if (fmt.mode === 'json') {
    fmt.json({ groups })
    return
  }
  if (groups.length === 0) {
    fmt.line('(no groups)')
    return
  }
  for (const g of groups) renderGroup(fmt, g)
}

export function renderPresence(fmt: Formatter, rows: readonly PresenceView[]): void {
  if (fmt.mode === 'json') {
    fmt.json({ presence: rows })
    return
  }
  if (rows.length === 0) {
    fmt.line('(no agents online)')
    return
  }
  for (const p of rows) fmt.line(formatPresenceLine(p))
}

export function renderSearchHits(fmt: Formatter, hits: readonly FtsSearchHit[]): void {
  if (fmt.mode === 'json') {
    fmt.json({ hits })
    return
  }
  if (hits.length === 0) {
    fmt.line('(no matches)')
    return
  }
  for (const h of hits) {
    const ch = h.channel ? `[${h.channel}] ` : ''
    const title = h.title ? `${excerptLine(h.title, 60)} — ` : ''
    const snippet = excerptLine(h.snippet, 160)
    fmt.line(`#${h.id} ${ch}[${h.kind}] ${title}${snippet}`)
  }
}

export function renderEventLine(ev: BoardEventView): string {
  if (ev.message) {
    return `ev#${ev.cursor} [${ev.type}] ${formatMessageLine(ev.message, 140)}`
  }
  return `ev#${ev.cursor} [${ev.type}] ${ev.createdAt}`
}

export function renderTokenRecords(fmt: Formatter, records: readonly TokenRecordView[]): void {
  if (fmt.mode === 'json') {
    fmt.json({ tokens: records })
    return
  }
  if (records.length === 0) {
    fmt.line('(no tokens)')
    return
  }
  for (const r of records) {
    const status = r.revokedAt ? 'revoked' : r.expiresAt && Date.parse(r.expiresAt) <= Date.now() ? 'expired' : 'active'
    const profile = r.profile ? ` profile=${r.profile}` : ' (principal)'
    const exp = r.expiresAt ? ` exp=${r.expiresAt}` : ' exp=never'
    const note = r.note ? ` note="${excerptLine(r.note, 60)}"` : ''
    fmt.line(`${r.id} [${status}] ${r.principalId}${profile} scope=${r.listenerScope} cap=[${r.cap.join(',')}]${exp}${note}`)
  }
}

export function renderDoctor(fmt: Formatter, report: DoctorReport): void {
  if (fmt.mode === 'json') {
    fmt.json(report)
    return
  }
  const s = fmt.style
  const status = report.ok ? s.green('OK') : s.red('ISSUES FOUND')
  fmt.line(`swarmboard doctor: ${status} (v${report.version})`)
  const targetStr =
    report.target.kind === 'file'
      ? `file:${report.target.db}`
      : report.target.kind === 'url'
        ? `url:${report.target.url}`
        : 'memory::memory:'
  fmt.line(`target: ${targetStr} (${report.source})`)
  fmt.line(`mode: policy=${report.modePolicy} authEnforce=${report.authEnforce} fallbacks=${report.fallbacks}`)
  fmt.line(
    `identity: profile=${report.identity.profile ?? '(none)'} token=${report.identity.token}${report.identity.tokenSource ? ` (${report.identity.tokenSource})` : ''}`,
  )
  fmt.line(
    `board: exists=${report.board.exists} schema=${report.board.schemaVersion ?? 'n/a'}/${report.board.expectedSchemaVersion} writable=${report.board.writable ?? 'n/a'} boardId=${report.board.boardId ?? 'n/a'}`,
  )
  if (report.layout) {
    fmt.line(
      `layout: fs=${report.layout.fsKind} manifest=${report.layout.manifest} wal=${report.layout.walExists} shm=${report.layout.shmExists} wakeup=${report.layout.wakeupExists} jsonl=${report.layout.jsonlExists} strays=${report.layout.strays.length}`,
    )
    for (const r of report.layout.refusals) {
      fmt.line(s.red(`  refusal: ${r.reason} (${r.path})`))
    }
    for (const w of report.layout.warnings) {
      fmt.line(s.yellow(`  warning: ${w}`))
    }
  }
  fmt.line(
    `daemon: running=${report.daemon.running}${report.daemon.pid ? ` pid=${report.daemon.pid}` : ''}${report.daemon.tcpUrl ? ` tcp=${report.daemon.tcpUrl}` : ''}${report.daemon.socketPath ? ` sock=${report.daemon.socketPath}` : ''}`,
  )
  for (const p of report.ports) {
    fmt.line(`port ${p.host}:${p.port}: ${p.inUse ? 'in-use' : 'available'}${p.note ? ` (${p.note})` : ''}`)
  }
  for (const w of report.warnings) {
    fmt.line(s.yellow(`warning: ${w}`))
  }
  fmt.line(`trust: ${report.trustDisclosure}`)
}

// Re-export compact JSON projections so callers/tests have single-point access.
export {
  compactAgentInbox,
  compactChannel,
  compactChannelTree,
  compactEvent,
  compactGroup,
  compactMessage,
  compactNotificationsPage,
  compactPin,
  compactPresence,
  compactTasksPage,
  compactThread,
  compactThreadsPage,
}
