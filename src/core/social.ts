import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CallerContext } from './board-service.ts'
import { forbidden, notImplemented } from './errors.ts'
import type { ChannelKind, ChannelTreeNode, ChannelView } from './schemas.ts'

// ============================================================================
// Swarmboard v2 A2A Social Helpers & C10 Assurance Gate
// Note: No raw wall-clock calls here (HT-99 clock invariant).
// ============================================================================

export const GROUP_FANOUT_MAX = 64
export const NOTIFICATIONS_PER_MESSAGE_MAX = 128

export const RESERVED_GROUP_HANDLES: ReadonlySet<string> = new Set([
  'channel',
  'here',
  'all',
  'everyone',
  'me',
  'system',
  'board',
])

/**
 * Canonical DM slug for any actor ID or handle:
 * 1. If it contains `+`, take the segment after the last `+` (else after last `/`; else whole string).
 * 2. Lowercase, replace runs of `[^a-z0-9_-]+` with `-`, trim leading/trailing `[-_]`.
 * 3. If empty or starts with `[-_]`, prefix `a-`.
 * 4. If length > 48, truncate to 41 chars + `-` + first 6 hex chars of sha256(lower).
 */
export function dmSlug(actorOrHandle: string): string {
  let raw = actorOrHandle
  const plus = raw.lastIndexOf('+')
  if (plus !== -1) {
    raw = raw.slice(plus + 1)
  } else {
    const slash = raw.lastIndexOf('/')
    if (slash !== -1) raw = raw.slice(slash + 1)
  }
  let slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  if (slug === '' || /^[-_]/.test(slug)) slug = `a-${slug}`
  if (slug.length > 48) {
    const hash = createHash('sha256').update(actorOrHandle.toLowerCase()).digest('hex').slice(0, 6)
    slug = `${slug.slice(0, 41)}-${hash}`
  }
  return slug
}

/** Canonical symmetric 1:1 DM channel path `dm/<a>--<b>` (always matches ChannelPath). */
export function canonicalDmChannel(a: string, b: string): string {
  const [x, y] = [dmSlug(a), dmSlug(b)].sort((u, v) => (u < v ? -1 : u > v ? 1 : 0))
  return `dm/${x}--${y}`
}

/** Parses `dm/<a>--<b>` into `[a, b]`, or null if `channel` is not a canonical DM path. */
export function parseDmPeers(channel: string): readonly [string, string] | null {
  if (!channel.startsWith('dm/')) return null
  const rest = channel.slice(3)
  if (rest.includes('/')) return null
  const sep = rest.indexOf('--')
  if (sep <= 0 || sep + 2 >= rest.length) return null
  return [rest.slice(0, sep), rest.slice(sep + 2)]
}

/** Infers the default channel kind from a channel path when no board_channel_meta row exists. */
export function inferChannelKind(path: string): ChannelKind {
  if (path.startsWith('dm/')) return 'dm'
  if (path === 'announcements' || path.endsWith('/announcements')) return 'announcements'
  if (
    path === 'decisions' ||
    path.endsWith('/decisions') ||
    path.endsWith('/notes') ||
    path === 'meta/feedback'
  ) {
    return 'forum'
  }
  if (
    path === 'work' ||
    path.startsWith('work/') ||
    path.endsWith('/work') ||
    path.includes('/work/')
  ) {
    return 'tasks'
  }
  return 'chat'
}

/**
 * All notification / private-channel-member recipient keys belonging to `caller`.
 * Matches notifications sent before `caller` ever posted (via `handle:<profile>` / `handle:<handle>`)
 * as well as notifications addressed directly to `caller.actor.id`.
 */
export function recipientKeysOf(caller: CallerContext): string[] {
  const keys = new Set<string>([
    caller.actor.id,
    `handle:${caller.actor.handle.toLowerCase()}`,
  ])
  if (caller.profile !== null) {
    keys.add(`handle:${caller.profile.toLowerCase()}`)
  } else {
    keys.add(`handle:${caller.principal.handle.toLowerCase()}`)
  }
  return [...keys]
}

/** Compact single-line excerpt capped at `maxLen` Unicode code points. */
export function excerptOf(text: string, maxLen = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(collapsed)
  if (chars.length <= maxLen) return collapsed
  return maxLen <= 1 ? chars.slice(0, maxLen).join('') : `${chars.slice(0, maxLen - 1).join('')}…`
}

/**
 * Resolves any accepted message/thread/task Ref to its positive numeric message ID, or 0 if invalid/missing:
 * - Positive integer or bare decimal string (`12`, `'12'`)
 * - Friendly prefixed numeric forms (`'#12'`, `'msg_12'`, `'thr_12'`)
 * - Thread key (`'thr_...'`) or UUID via two separate indexed O(log N) seeks (no OR table scan).
 * Rejects malformed forms (`'0x10'`, `'1e2'`, `' 12 '`, `'+5'`) -> 0.
 */
export function resolveMessageId(db: DatabaseSync, ref: string | number): number {
  if (typeof ref === 'number') return Number.isSafeInteger(ref) && ref > 0 ? ref : 0
  if (/^(0|[1-9]\d{0,15})$/.test(ref)) return Number(ref)
  const prefixed = /^(?:#|msg_|thr_)([1-9]\d{0,15})$/.exec(ref)
  if (prefixed) return Number(prefixed[1])
  if (/^(?:thr_[A-Za-z0-9_-]{1,120}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(ref)) {
    const byThread = db
      .prepare('SELECT id FROM board_messages WHERE re IS NULL AND thread = ? LIMIT 1')
      .get(ref) as { id?: number } | undefined
    if (byThread?.id) return Number(byThread.id)
    const byEvent = db
      .prepare('SELECT id FROM board_messages WHERE event_id = ? AND re IS NULL LIMIT 1')
      .get(ref) as { id?: number } | undefined
    return byEvent?.id ? Number(byEvent.id) : 0
  }
  return 0
}

/**
 * C10 human-verification gate helper (HOST-0b):
 * - `human_verified`: allowed.
 * - `agent_delegated`: 403 `human_verification_required`.
 * - `local_unverified` (or unset): 501 `not_supported` in Modes 0-1 (unless explicitly permitted for
 *   Modes 2-3 low-stakes confirmation via `opts.allowLocalUnverified` + `opts.mode`).
 */
export function requireHumanVerified(
  caller: CallerContext,
  opts?: { mode?: string; allowLocalUnverified?: boolean },
): void {
  const assurance = caller.principal.assurance
  if (assurance === 'human_verified') return
  if (assurance === 'agent_delegated') {
    throw forbidden(
      'this action requires a human-verified identity; an agent credential cannot satisfy it',
      'human_verification_required',
    )
  }
  if (
    opts?.allowLocalUnverified === true &&
    caller.actor.kind === 'person' &&
    (opts.mode === 'daemon' || opts.mode === 'service')
  ) {
    return
  }
  throw notImplemented(
    'human_verified requires Mode 2+ UI presence or Mode 4 SSO',
    'not_supported',
    { hint: 'human_verified requires Mode 2+ UI presence or Mode 4 SSO' },
  )
}

/**
 * Looks up a unique actor row by exact ID, exact lowercase handle, or unique `<principal>/<profile>` suffix.
 * @internal
 */
export function resolveActorRow(
  db: DatabaseSync,
  raw: string,
): { id: string; handle: string } | null {
  const trimmed = raw.startsWith('@') ? raw.slice(1) : raw
  if (trimmed === '') return null
  const byId = db
    .prepare('SELECT id, handle FROM board_actors WHERE id = ? LIMIT 1')
    .get(trimmed) as { id: string; handle: string } | undefined
  if (byId) return byId
  const lower = trimmed.toLowerCase()
  const byHandle = db
    .prepare('SELECT id, handle FROM board_actors WHERE handle_lower = ?')
    .all(lower) as Array<{ id: string; handle: string }>
  if (byHandle.length === 1) return byHandle[0]!
  if (!lower.includes('/')) {
    const bySuffix = db
      .prepare(
        "SELECT id, handle FROM board_actors WHERE instr(handle_lower, '/') > 0 AND substr(handle_lower, instr(handle_lower, '/') + 1) = ?",
      )
      .all(lower) as Array<{ id: string; handle: string }>
    if (bySuffix.length === 1) return bySuffix[0]!
  }
  return null
}

/**
 * Canonicalizes a notification or channel-member recipient target:
 * returns the unique `board_actors.id` if known, else `handle:<lowercase>`.
 * @internal
 */
export function resolveRecipient(db: DatabaseSync, raw: string): string {
  const trimmed = raw.startsWith('@') ? raw.slice(1) : raw
  if (trimmed.startsWith('handle:')) {
    const bare = trimmed.slice('handle:'.length)
    const actor = resolveActorRow(db, bare)
    return actor ? actor.id : `handle:${bare.toLowerCase()}`
  }
  const actor = resolveActorRow(db, trimmed)
  return actor ? actor.id : `handle:${trimmed.toLowerCase()}`
}

/**
 * Returns every recipient/member alias key corresponding to `raw` (actor ID + handle aliases),
 * used for notification deduplication across pre/post-first-post transitions and member removal.
 * @internal
 */
export function recipientAliases(db: DatabaseSync, raw: string): Set<string> {
  const trimmed = raw.startsWith('@') ? raw.slice(1) : raw
  const keys = new Set<string>([trimmed])
  if (trimmed.startsWith('handle:')) {
    keys.add(trimmed.toLowerCase())
    const bare = trimmed.slice('handle:'.length)
    const actor = resolveActorRow(db, bare)
    if (actor) {
      keys.add(actor.id)
      const hl = actor.handle.toLowerCase()
      keys.add(`handle:${hl}`)
      const slash = hl.lastIndexOf('/')
      if (slash !== -1) keys.add(`handle:${hl.slice(slash + 1)}`)
    }
  } else {
    keys.add(`handle:${trimmed.toLowerCase()}`)
    const actor = resolveActorRow(db, trimmed)
    if (actor) {
      keys.add(actor.id)
      const hl = actor.handle.toLowerCase()
      keys.add(`handle:${hl}`)
      const slash = hl.lastIndexOf('/')
      if (slash !== -1) keys.add(`handle:${hl.slice(slash + 1)}`)
    }
  }
  return keys
}

/** Builds a nested channel tree with virtual folder nodes and bottom-up unread/message totals. @internal */
export function buildChannelTree(channels: readonly ChannelView[]): ChannelTreeNode[] {
  type MutableNode = {
    path: string
    segment: string
    channel: ChannelView | null
    children: Map<string, MutableNode>
  }
  const roots = new Map<string, MutableNode>()

  for (const ch of channels) {
    const parts = ch.path.split('/')
    let map = roots
    let prefix = ''
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!
      prefix = i === 0 ? segment : `${prefix}/${segment}`
      let node = map.get(segment)
      if (!node) {
        node = { path: prefix, segment, channel: null, children: new Map() }
        map.set(segment, node)
      }
      if (i === parts.length - 1) node.channel = ch
      map = node.children
    }
  }

  const finalize = (node: MutableNode): ChannelTreeNode => {
    const children = [...node.children.values()]
      .map(finalize)
      .sort(
        (a, b) =>
          (a.channel?.sortOrder ?? 0) - (b.channel?.sortOrder ?? 0) ||
          a.segment.localeCompare(b.segment),
      )
    const ownUnread = node.channel?.unreadCount ?? 0
    const ownMessages = node.channel?.messages ?? 0
    const unreadCount = ownUnread + children.reduce((sum, c) => sum + c.unreadCount, 0)
    const totalMessages = ownMessages + children.reduce((sum, c) => sum + c.totalMessages, 0)
    return {
      path: node.path,
      segment: node.segment,
      virtual: node.channel === null,
      channel: node.channel,
      unreadCount,
      totalMessages,
      children,
    }
  }

  return [...roots.values()]
    .map(finalize)
    .sort(
      (a, b) =>
        (a.channel?.sortOrder ?? 0) - (b.channel?.sortOrder ?? 0) ||
        a.segment.localeCompare(b.segment),
    )
}
