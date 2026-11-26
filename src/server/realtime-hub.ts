// Shared RealtimeHub (HOST-9 / HOST-0b C9 fan-out, Swarmboard v2 launch design §4.2).
// Registers ONE store.onEvent listener per board, caches actors and per-subscriber Access
// (invalidated on actor.seen / grant.* / channel.*), and fans out projected events + notifications
// to all open SSE /api/v2/stream subscribers with 15 s keep-alive pings, 280 s graceful reconnect,
// and clean shutdown notification on daemon retire.
import {
  BoardError,
  forbidden,
  recipientKeysOf,
  type Access,
  type ActorView,
  type BoardEventView,
  type BoardService,
  type CallerContext,
  type NotificationView,
  type StoredEvent,
} from '../core/public.ts'
import { isBoardError } from '../client/errors.ts'

export const DEFAULT_SSE_KEEPALIVE_MS = 15_000
export const DEFAULT_SSE_MAX_DURATION_MS = 280_000

const RECORD_EVENT_TYPES: ReadonlySet<string> = new Set([
  'grant.created',
  'grant.updated',
  'grant.revoked',
  'grant.deleted',
  'schema.created',
  'schedule.created',
  'schedule.canceled',
  'schedule.sent',
  'schedule.failed',
])

const HIDDEN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'actor.seen',
  'message.synced',
  'message.files_synced',
  'task.renewed',
])

export type SseCategory = 'message' | 'notification' | 'presence' | 'pin' | 'task' | 'channel'

export interface StreamFilters {
  readonly after?: number
  readonly channel?: string
  readonly re?: string
  readonly by?: string
  readonly mentions?: string
  readonly all?: boolean
  readonly types?: readonly string[]
  readonly includeNotifications?: boolean
}

export interface RealtimeHubOptions {
  readonly keepAliveMs?: number
  readonly maxDurationMs?: number
  readonly now?: () => number
}

interface ActorInfo {
  readonly id: string
  readonly handle: string
  readonly name: string
  readonly kind: string
  readonly avatar: string | null
}

interface RawNotificationRow {
  id: number
  log_index: number
  recipient: string
  reason: string
  priority: string
  source_group: string | null
  channel: string
  thread: string
  root_id: number
  message_id: number
  by_actor: string
  excerpt: string
  created_at: string
  read_at: string | null
  acked_at: string | null
}

interface Subscriber {
  readonly id: number
  readonly caller: CallerContext
  readonly recipientKeys: ReadonlySet<string>
  readonly filters: StreamFilters
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  readonly signal: AbortSignal | undefined
  readonly onAbort: () => void
  readonly keepAliveTimer: ReturnType<typeof setInterval>
  readonly maxDurationTimer: ReturnType<typeof setTimeout>
  access: Access
  accessVersion: number
  lastIndex: number
  closed: boolean
}

const encoder = new TextEncoder()

function classifySseEvent(eventType: string): SseCategory {
  if (eventType === 'message.pinned' || eventType === 'message.unpinned') return 'pin'
  if (eventType === 'presence.updated') return 'presence'
  if (eventType.startsWith('channel.')) return 'channel'
  if (eventType.startsWith('task.')) return 'task'
  return 'message'
}

function channelMatches(filter: string | undefined, channel: string | null): boolean {
  if (filter === undefined) return true
  if (channel === null) return false
  if (filter.endsWith('/')) {
    const base = filter.slice(0, -1)
    return channel === base || channel.startsWith(filter)
  }
  return channel === filter
}

function mentionTerm(raw: string): string {
  return raw.startsWith('@') ? raw.slice(1).toLowerCase() : raw.toLowerCase()
}

const MENTION_TOKEN_RE = /(?:^|[^A-Za-z0-9._+-])@([A-Za-z0-9_][A-Za-z0-9_.:/+-]*)/g

function extractLiveMentionTerms(rawPayload: Record<string, unknown>): string[] {
  const out = new Set<string>()
  const text = rawPayload.text
  if (typeof text === 'string' && text.includes('@')) {
    MENTION_TOKEN_RE.lastIndex = 0
    for (const m of text.matchAll(MENTION_TOKEN_RE)) {
      const cleaned = m[1]!.replace(/[.,!?;:)]+$/, '')
      if (cleaned !== '') out.add(cleaned.toLowerCase())
    }
  }
  const rawMentions = rawPayload.mentions
  if (Array.isArray(rawMentions)) {
    for (const item of rawMentions) {
      if (typeof item === 'string' && item !== '') {
        out.add(mentionTerm(item))
      } else if (item !== null && typeof item === 'object') {
        const rec = item as { actor?: unknown; handle?: unknown; raw?: unknown; name?: unknown }
        if (typeof rec.actor === 'string' && rec.actor !== '') out.add(rec.actor.toLowerCase())
        if (typeof rec.handle === 'string' && rec.handle !== '') out.add(mentionTerm(rec.handle))
        if (typeof rec.raw === 'string' && rec.raw !== '') out.add(mentionTerm(rec.raw))
        if (typeof rec.name === 'string' && rec.name !== '') out.add(mentionTerm(rec.name))
      }
    }
  }
  return [...out]
}

function matchesLiveMentions(
  terms: readonly string[],
  filter: string,
  caller: CallerContext,
  actors: Map<string, ActorInfo>,
  access: Access,
): boolean {
  if (terms.length === 0) return false
  if (filter === 'me') {
    const targets = new Set<string>([
      mentionTerm(caller.actor.handle),
      caller.actor.id.toLowerCase(),
      ...(caller.profile !== null ? [caller.profile.toLowerCase()] : []),
    ])
    return terms.some((t) => targets.has(t))
  }
  const under = (name: string): string =>
    name.includes(':') ? `${name.toLowerCase()}+` : `${mentionTerm(name)}/`
  const termSet = new Set<string>([mentionTerm(filter)])
  const prefixSet = new Set<string>([under(filter)])
  if (access.readsAll) {
    const filterLower = filter.toLowerCase()
    const named = actors.has(filter)
      ? [actors.get(filter)!]
      : [...actors.values()].filter((a) => {
          const hl = a.handle.toLowerCase()
          const slash = hl.lastIndexOf('/')
          return hl === filterLower || (slash !== -1 && hl.slice(slash + 1) === filterLower)
        })
    for (const a of named) {
      termSet.add(a.id.toLowerCase()).add(mentionTerm(a.handle))
      const hl = a.handle.toLowerCase()
      const slash = hl.lastIndexOf('/')
      if (slash !== -1) termSet.add(hl.slice(slash + 1))
      prefixSet.add(under(a.handle)).add(under(a.id))
    }
  }
  return terms.some((t) => termSet.has(t) || [...prefixSet].some((p) => t.startsWith(p)))
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'token' || k === 'mentions' || k === 'along' || k === 'beforeLabels') continue
    if ((k === 'id' || k === 're' || k === 'replyTo') && typeof v === 'number') {
      copy[k] = String(v)
    } else if (k === 'needs' && Array.isArray(v)) {
      copy[k] = v.map((n) => String(n))
    } else {
      copy[k] = v
    }
  }
  return copy
}

function formatSseFrame(opts: { readonly id?: string; readonly event?: string; readonly data: unknown }): Uint8Array {
  let out = ''
  if (opts.id !== undefined) out += `id: ${opts.id}\n`
  if (opts.event !== undefined) out += `event: ${opts.event}\n`
  const json = typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data)
  for (const line of json.split('\n')) {
    out += `data: ${line}\n`
  }
  out += '\n'
  return encoder.encode(out)
}

export class RealtimeHub {
  readonly #board: BoardService
  readonly #keepAliveMs: number
  readonly #maxDurationMs: number
  readonly #subscribers = new Set<Subscriber>()
  readonly #onStreamCountChange = new Set<(count: number) => void>()

  #unsubscribe: (() => void) | null = null
  #nextSubId = 1
  #accessVersion = 1
  #actorsCache: Map<string, ActorInfo> | null = null
  #hasV2NotifTable: boolean | null = null
  #closed = false
  #lastKnownInstanceId: string | null

  constructor(board: BoardService, opts: RealtimeHubOptions = {}) {
    this.#board = board
    this.#keepAliveMs = opts.keepAliveMs ?? DEFAULT_SSE_KEEPALIVE_MS
    this.#maxDurationMs = opts.maxDurationMs ?? DEFAULT_SSE_MAX_DURATION_MS
    this.#lastKnownInstanceId = board.boardInfo().instanceId
    // Register ONE store.onEvent listener per board (solves C9 N-listener fan-out).
    this.#unsubscribe = board.store.onEvent((ev) => {
      this.#onStoreEvent(ev)
    })
  }

  get activeStreams(): number {
    return this.#subscribers.size
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Subscribe to changes in the number of open SSE streams (used for daemon idle-exit veto). */
  onStreamCountChange(listener: (count: number) => void): () => void {
    this.#onStreamCountChange.add(listener)
    return () => {
      this.#onStreamCountChange.delete(listener)
    }
  }

  /** Invalidates cached actors/grants/access (e.g. after a board restore). */
  invalidateCaches(): void {
    this.#actorsCache = null
    this.#accessVersion += 1
  }

  /**
   * Opens a live SSE ReadableStream for `caller`.
   * Validates admission and cursor (`after > head` -> 410 `cursor_expired`) synchronously before
   * returning the stream so callers receive proper HTTP error responses on refusal.
   */
  async subscribe(
    caller: CallerContext,
    filters: StreamFilters = {},
    signal?: AbortSignal,
  ): Promise<{ readonly stream: ReadableStream<Uint8Array>; readonly cursor: string }> {
    if (this.#closed) {
      throw new BoardError(503, 'unavailable', 'realtime hub is closed')
    }

    const resolved = this.#board.resolveAccess(caller)
    if (!resolved.admits) {
      throw forbidden('caller is not admitted to this board')
    }

    const head = this.#board.store.getHeadIndex()
    if (filters.after !== undefined && filters.after > head) {
      throw new BoardError(
        410,
        'cursor_expired',
        'this cursor is past the end of the log: the board was rewound or restored',
        {
          hint: 'resync from the current head',
          details: { reason: 'log_rewound', head },
        },
      )
    }

    // Collect catch-up backlog before attaching the live subscriber so backlog + live fanout
    // never drops an event and never emits duplicates.
    let startCursor = filters.after !== undefined ? filters.after : head
    const backlogEvents: BoardEventView[] = []
    if (filters.after !== undefined && filters.after < head) {
      let cur = filters.after
      // Bound initial catch-up pages to avoid blocking event loop on huge history;
      // clients can resume from the last emitted id if more remains.
      for (let pageCount = 0; pageCount < 10 && cur < head; pageCount += 1) {
        const page = await this.#board.getEvents(caller, {
          after: String(cur),
          wait: 0,
          ...(filters.channel !== undefined ? { channel: filters.channel } : {}),
          ...(filters.re !== undefined ? { re: filters.re } : {}),
          ...(filters.by !== undefined ? { by: filters.by } : {}),
          ...(filters.mentions !== undefined ? { mentions: filters.mentions } : {}),
          ...(filters.all === true ? { all: true } : {}),
        })
        for (const ev of page.events) {
          if (filters.types !== undefined && filters.types.length > 0 && !filters.types.includes(ev.type)) {
            continue
          }
          backlogEvents.push(ev)
        }
        const nextCur = Number(page.cursor)
        if (!Number.isFinite(nextCur) || nextCur <= cur) break
        cur = nextCur
      }
      startCursor = cur
    }

    const recipientKeys = new Set(recipientKeysOf(caller))
    let subscriberRef: Subscriber | null = null

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const subId = this.#nextSubId++
        const removeSub = (): void => {
          if (subscriberRef === null || subscriberRef.closed) return
          subscriberRef.closed = true
          clearInterval(subscriberRef.keepAliveTimer)
          clearTimeout(subscriberRef.maxDurationTimer)
          if (subscriberRef.signal !== undefined) {
            subscriberRef.signal.removeEventListener('abort', subscriberRef.onAbort)
          }
          this.#subscribers.delete(subscriberRef)
          this.#notifyCount()
          try {
            controller.close()
          } catch {
            // Stream may already be closed/errored.
          }
        }

        const onAbort = (): void => {
          removeSub()
        }

        const keepAliveTimer = setInterval(() => {
          if (subscriberRef === null || subscriberRef.closed) return
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            removeSub()
          }
        }, this.#keepAliveMs)
        keepAliveTimer.unref()

        const maxDurationTimer = setTimeout(() => {
          if (subscriberRef === null || subscriberRef.closed) return
          try {
            controller.enqueue(
              formatSseFrame({
                event: 'reconnect',
                data: { reason: 'max_duration', cursor: String(subscriberRef.lastIndex) },
              }),
            )
          } catch {
            // ignore enqueue failure during close
          }
          removeSub()
        }, this.#maxDurationMs)
        maxDurationTimer.unref()

        const sub: Subscriber = {
          id: subId,
          caller,
          recipientKeys,
          filters,
          controller,
          signal,
          onAbort,
          keepAliveTimer,
          maxDurationTimer,
          access: resolved.caller,
          accessVersion: this.#accessVersion,
          lastIndex: startCursor,
          closed: false,
        }
        subscriberRef = sub
        this.#subscribers.add(sub)
        this.#notifyCount()

        if (signal !== undefined) {
          if (signal.aborted) {
            removeSub()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }

        // Initial comment establishes the stream immediately with current cursor.
        try {
          controller.enqueue(encoder.encode(`: connected cursor=${startCursor}\n\n`))
          for (const ev of backlogEvents) {
            const category = classifySseEvent(ev.type)
            const evIdx = Number(ev.cursor)
            controller.enqueue(
              formatSseFrame({
                id: ev.cursor,
                event: category,
                data: ev,
              }),
            )
            if (Number.isFinite(evIdx) && evIdx > sub.lastIndex) sub.lastIndex = evIdx
          }
        } catch {
          removeSub()
        }
      },
      cancel: () => {
        if (subscriberRef !== null && !subscriberRef.closed) {
          subscriberRef.closed = true
          clearInterval(subscriberRef.keepAliveTimer)
          clearTimeout(subscriberRef.maxDurationTimer)
          if (subscriberRef.signal !== undefined) {
            subscriberRef.signal.removeEventListener('abort', subscriberRef.onAbort)
          }
          this.#subscribers.delete(subscriberRef)
          this.#notifyCount()
        }
      },
    })

    return { stream, cursor: String(startCursor) }
  }

  /** Gracefully notifies every SSE subscriber with `event: shutdown` and closes all streams. */
  shutdown(reason = 'retiring'): void {
    for (const sub of [...this.#subscribers]) {
      if (sub.closed) continue
      try {
        sub.controller.enqueue(
          formatSseFrame({
            event: 'shutdown',
            data: { reason, cursor: String(sub.lastIndex) },
          }),
        )
      } catch {
        // ignore enqueue error on closing socket
      }
      this.#closeSubscriber(sub)
    }
  }

  /** Unsubscribes the single store listener and closes all active SSE streams. Idempotent. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#unsubscribe !== null) {
      try {
        this.#unsubscribe()
      } catch {
        // ignore store close race
      }
      this.#unsubscribe = null
    }
    this.shutdown('closed')
    this.#actorsCache = null
  }

  #closeSubscriber(sub: Subscriber): void {
    if (sub.closed) return
    sub.closed = true
    clearInterval(sub.keepAliveTimer)
    clearTimeout(sub.maxDurationTimer)
    if (sub.signal !== undefined) {
      sub.signal.removeEventListener('abort', sub.onAbort)
    }
    this.#subscribers.delete(sub)
    this.#notifyCount()
    try {
      sub.controller.close()
    } catch {
      // ignore
    }
  }

  #notifyCount(): void {
    const count = this.#subscribers.size
    for (const listener of [...this.#onStreamCountChange]) {
      try {
        listener(count)
      } catch {
        // listener errors never disrupt hub
      }
    }
  }

  #getActorsMap(): Map<string, ActorInfo> {
    if (this.#actorsCache !== null) return this.#actorsCache
    const map = new Map<string, ActorInfo>()
    try {
      const rows = this.#board.store.db
        .prepare('SELECT id, handle, name, kind, avatar FROM board_actors')
        .all() as Array<{ id: string; handle: string; name: string; kind: string; avatar: string | null }>
      for (const r of rows) {
        map.set(r.id, { id: r.id, handle: r.handle, name: r.name, kind: r.kind, avatar: r.avatar })
      }
    } catch {
      // ignore if store closed
    }
    this.#actorsCache = map
    return map
  }

  #hasNotificationsTable(): boolean {
    if (this.#hasV2NotifTable !== null) return this.#hasV2NotifTable
    try {
      const row = this.#board.store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'board_notifications'")
        .get() as { name?: string } | undefined
      this.#hasV2NotifTable = row?.name === 'board_notifications'
    } catch {
      this.#hasV2NotifTable = false
    }
    return this.#hasV2NotifTable
  }

  #loadNotificationsAt(logIndex: number, actors: Map<string, ActorInfo>): Array<{
    readonly recipient: string
    readonly channel: string
    readonly view: NotificationView
  }> {
    if (!this.#hasNotificationsTable()) return []
    try {
      const rows = this.#board.store.db
        .prepare('SELECT * FROM board_notifications WHERE log_index = ? ORDER BY id ASC')
        .all(logIndex) as unknown as RawNotificationRow[]
      if (rows.length === 0) return []
      return rows.map((r) => ({
        recipient: r.recipient,
        channel: r.channel,
        view: {
          id: String(r.id),
          logIndex: Number(r.log_index),
          recipient: r.recipient,
          reason: r.reason as NotificationView['reason'],
          priority: r.priority as NotificationView['priority'],
          sourceGroup: r.source_group,
          channel: r.channel,
          thread: r.thread,
          rootId: String(r.root_id),
          messageId: String(r.message_id),
          byActor: r.by_actor,
          byHandle: actors.get(r.by_actor)?.handle ?? null,
          excerpt: r.excerpt,
          createdAt: r.created_at,
          readAt: r.read_at,
          ackedAt: r.acked_at,
        },
      }))
    } catch {
      return []
    }
  }

  #refreshSubscriberAccess(sub: Subscriber): boolean {
    if (sub.accessVersion === this.#accessVersion) return true
    try {
      const resolved = this.#board.resolveAccess(sub.caller)
      if (!resolved.admits) return false
      sub.access = resolved.caller
      sub.accessVersion = this.#accessVersion
      return true
    } catch (err) {
      if (isBoardError(err) && (err.status === 401 || err.status === 403)) return false
      return true
    }
  }

  #onStoreEvent(ev: StoredEvent): void {
    if (this.#closed) return

    // Invalidate shared caches on relevant structural events.
    if (ev.type === 'actor.seen') {
      this.#actorsCache = null
    } else if (ev.type.startsWith('grant.') || ev.type.startsWith('channel.')) {
      this.#accessVersion += 1
    }

    // Check if instance changed (restore).
    const liveInstance = this.#board.boardInfo().instanceId
    if (this.#lastKnownInstanceId !== null && liveInstance !== this.#lastKnownInstanceId) {
      this.#lastKnownInstanceId = liveInstance
      this.invalidateCaches()
      for (const sub of [...this.#subscribers]) {
        if (sub.closed) continue
        try {
          sub.controller.enqueue(
            formatSseFrame({
              event: 'reconnect',
              data: { reason: 'instance_changed', instanceId: liveInstance },
            }),
          )
        } catch {
          // ignore
        }
        this.#closeSubscriber(sub)
      }
      return
    }

    if (this.#subscribers.size === 0) return

    // Never emit record events (grant/schema/schedule internals).
    if (RECORD_EVENT_TYPES.has(ev.type)) return
    if (ev.sessionId !== 'board') return

    const actors = this.#getActorsMap()
    const liveMentionTerms = extractLiveMentionTerms(ev.payload)
    const payload = sanitizePayload(ev.payload)
    const isHidden = HIDDEN_EVENT_TYPES.has(ev.type)
    const category = classifySseEvent(ev.type)
    const notifications = this.#loadNotificationsAt(ev.index, actors)

    const byActorId = (ev.payload.by as { actor?: string } | undefined)?.actor
    const actorInfo = byActorId ? actors.get(byActorId) : undefined

    const baseEventView: BoardEventView = {
      cursor: String(ev.index),
      type: ev.type,
      createdAt: ev.createdAt,
      payload: {
        ...payload,
        ...(ev.channel !== null && payload.channel === undefined ? { channel: ev.channel } : {}),
        ...(ev.thread !== null && payload.thread === undefined ? { thread: ev.thread } : {}),
      },
      ...(actorInfo !== undefined
        ? {
            actor: {
              id: actorInfo.id,
              kind: actorInfo.kind as ActorView['kind'],
              handle: actorInfo.handle,
              name: actorInfo.name,
              avatar: actorInfo.avatar,
            },
          }
        : {}),
    }

    // Optional thread root / author metadata for filtering
    const evRe =
      typeof payload.re === 'string' || typeof payload.re === 'number'
        ? String(payload.re)
        : ev.thread
    const evByObj = payload.by as { actor?: unknown } | undefined
    const evBy = typeof evByObj?.actor === 'string' ? evByObj.actor : typeof payload.by === 'string' ? payload.by : null

    for (const sub of [...this.#subscribers]) {
      if (sub.closed) continue
      if (ev.index <= sub.lastIndex) continue

      if (!this.#refreshSubscriberAccess(sub)) {
        this.#closeSubscriber(sub)
        continue
      }

      // 1. Fan out main board event if readable and matches subscriber filters.
      let eventReadable = true
      if (ev.channel !== null) {
        eventReadable = sub.access.readable(ev.channel)
      } else if (!sub.access.readsAll) {
        eventReadable = false
      }

      const typeAllowed =
        sub.filters.types === undefined ||
        sub.filters.types.length === 0 ||
        sub.filters.types.includes(ev.type) ||
        sub.filters.types.includes(category)

      const mentionsAllowed =
        sub.filters.mentions === undefined ||
        matchesLiveMentions(liveMentionTerms, sub.filters.mentions, sub.caller, actors, sub.access)

      const shouldEmitEvent =
        eventReadable &&
        (!isHidden || sub.filters.all === true) &&
        typeAllowed &&
        mentionsAllowed &&
        channelMatches(sub.filters.channel, ev.channel) &&
        (sub.filters.re === undefined || evRe === sub.filters.re || ev.thread === sub.filters.re) &&
        (sub.filters.by === undefined || evBy === sub.filters.by)

      if (shouldEmitEvent) {
        try {
          sub.controller.enqueue(
            formatSseFrame({
              id: String(ev.index),
              event: category,
              data: baseEventView,
            }),
          )
          sub.lastIndex = ev.index
        } catch {
          this.#closeSubscriber(sub)
          continue
        }
      }

      // 2. Fan out targeted notifications created at this log_index.
      if (sub.filters.includeNotifications !== false && notifications.length > 0) {
        for (const notif of notifications) {
          if (!sub.recipientKeys.has(notif.recipient)) continue
          if (!sub.access.readable(notif.channel)) continue
          if (!channelMatches(sub.filters.channel, notif.channel)) continue
          try {
            sub.controller.enqueue(
              formatSseFrame({
                id: String(ev.index),
                event: 'notification',
                data: notif.view,
              }),
            )
            if (ev.index > sub.lastIndex) sub.lastIndex = ev.index
          } catch {
            this.#closeSubscriber(sub)
            break
          }
        }
      }
    }
  }
}
