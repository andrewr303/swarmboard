// GET /tasks (M2_DESIGN 2.7.13), ported from the original's server/tasks.ts:606-655 list: open tasks
// unless `state` says `all` or names one (a lapsed claim reads `ready`), oldest first, as thread
// summaries, over the channels the caller reads, a page at a time. One indexed query over board_tasks
// joined to the roots, in place of the original's scan of every root.
import type { SQLInputValue } from 'node:sqlite'
import type { CallerContext, StoredMessage } from '../board-service.ts'
import { badRequest } from '../errors.ts'
import type { TasksPage, ThreadSummaryView } from '../schemas.ts'
import { resolveMessageId } from '../social.ts'
import { TasksQuery } from './bodies.ts'
import { parseBody } from './common.ts'
import type { TaskHost } from './host.ts'

const OPEN = ['waiting', 'ready', 'claimed', 'blocked'] as const

/** The SQL that keeps a row's channel to `path`, or to it and its subtree, and stays indexable. */
export function channelTerm(column: string, path: string, subtree: boolean, params: SQLInputValue[]): string {
  if (!subtree) {
    params.push(path)
    return `${column} = ?`
  }
  // '0' is the byte after '/': everything under `path/` sorts in [path/, path0).
  params.push(path, `${path}/`, `${path}0`)
  return `(${column} = ? OR (${column} >= ? AND ${column} < ?))`
}

/** A message ref as a log index, or null (original feed.ts:115 indexOf). */
const indexOf = (value: string): number | null => (/^(0|[1-9]\d{0,15})$/.test(value) ? Number(value) : null)

const jsonList = (values: Iterable<string>): string => JSON.stringify([...values])

/** Tasks the caller reads, oldest first, a page at a time (original tasks.ts:606-655). */
export function listTasks(host: TaskHost, caller: CallerContext, raw: unknown): TasksPage {
  const query = parseBody(TasksQuery, raw ?? {})
  const { identity, access } = host.admit(caller)
  const db = host.store.db
  const now = host.now()
  const wanted = query.state ?? 'open'
  const limit = query.limit ?? 50
  let after = 0
  if (query.after !== undefined) {
    const at = indexOf(query.after)
    if (at === null) throw badRequest(`${query.after} isn't a cursor or a message ID on this board`, 'invalid_cursor')
    after = at
  }
  const head = Number((db.prepare('SELECT COALESCE(MAX(log_index), 0) AS h FROM board_events').get() as { h: number }).h)

  // Roots that are tasks and not deleted: a tombstone wears no `board.task`, so no list shows it.
  const where: string[] = ['t.root_deleted = 0', 'm.deleted = 0', 'm.re IS NULL']
  const params: SQLInputValue[] = []
  const scope =
    query.channel === undefined
      ? undefined
      : query.channel.endsWith('/')
        ? { path: query.channel.slice(0, -1), subtree: true }
        : { path: query.channel, subtree: false }
  if (scope) where.push(channelTerm('t.channel', scope.path, scope.subtree, params))
  const readable = host.channelsWhere(access, 'read', scope)
  // A reader of no channel has nothing to look for.
  const none = readable !== 'all' && readable.length === 0
  if (readable !== 'all') {
    where.push('t.channel IN (SELECT value FROM json_each(?))')
    params.push(jsonList(readable))
  }

  // A claim whose lease ran out still says `claimed`: it is ready, and no longer claimed.
  if (wanted === 'open') where.push(`t.state IN (${OPEN.map((s) => `'${s}'`).join(', ')})`)
  else if (wanted === 'ready') {
    where.push("(t.state = 'ready' OR (t.state = 'claimed' AND t.claim_until_ms <= ?))")
    params.push(now)
  } else if (wanted === 'claimed') {
    where.push("t.state = 'claimed' AND t.claim_until_ms > ?")
    params.push(now)
  } else if (wanted !== 'all') {
    where.push('t.state = ?')
    params.push(wanted)
  }

  if (query.owner !== undefined) {
    where.push('t.owner IN (SELECT value FROM json_each(?))')
    params.push(jsonList(host.whoIs(query.owner)))
  }
  if (query.for !== undefined) {
    where.push('t.for_actor IN (SELECT value FROM json_each(?))')
    params.push(jsonList(host.whoIs(query.for)))
  }
  if (query.needs !== undefined) {
    // A ref that names nothing here is no task's prerequisite.
    where.push('EXISTS (SELECT 1 FROM board_task_needs n WHERE n.task_id = t.task_id AND n.need_id = ?)')
    const needId = resolveMessageId(db, query.needs)
    params.push(needId > 0 ? needId : -1)
  }
  if (query.by !== undefined) {
    // `me` is the caller's own actor; anyone else is who the value names, a person with their agents' posts (feed.ts:163-177).
    const actors = query.by === 'me' ? [identity.actor.id] : [...host.whoIs(query.by)]
    const persons =
      query.by === 'me'
        ? []
        : (
            db
              .prepare("SELECT id FROM board_actors WHERE kind = 'person' AND id IN (SELECT value FROM json_each(?))")
              .all(jsonList(actors)) as Array<{ id: string }>
          ).map((r) => r.id)
    where.push('(m.by_actor IN (SELECT value FROM json_each(?)) OR m.by_principal IN (SELECT value FROM json_each(?)))')
    params.push(jsonList(actors), jsonList(persons))
  }
  // Labels on the root, as the original's roots query reads them (store/sql.ts:165-167, :397).
  for (const [key, values] of query.label ?? []) {
    if (values === null) {
      where.push('EXISTS (SELECT 1 FROM board_terms l WHERE l.message_id = t.task_id AND l.term = ?)')
      params.push(key)
    } else {
      where.push(`EXISTS (SELECT 1 FROM board_terms l WHERE l.message_id = t.task_id AND l.term = ? AND l.value IN (${values.map(() => '?').join(', ')}))`)
      params.push(key, ...values)
    }
  }
  if (after > 0) {
    where.push('t.task_id > ?')
    params.push(after)
  }

  type Found = { task_id: number; data: string; replies: number; at: number | null }
  const sql = `SELECT t.task_id, m.data, m.replies, m.at FROM board_tasks t JOIN board_messages m ON m.id = t.task_id
    WHERE ${where.join(' AND ')} ORDER BY t.task_id ASC${query.latest ? '' : ' LIMIT ?'}`
  const found: Found[] = none ? [] : (db.prepare(sql).all(...params, ...(query.latest ? [] : [limit])) as Found[])

  const lastOf = (r: Found): StoredMessage | null => {
    const at = r.at === null ? null : Number(r.at)
    if (at === null || at === Number(r.task_id)) return null
    const loaded = host.loadMessage(at)
    if (loaded && !loaded.deleted) return loaded
    const liveRow = db
      .prepare('SELECT data FROM board_messages WHERE re = ? AND deleted = 0 ORDER BY id DESC LIMIT 1')
      .get(Number(r.task_id)) as { data: string } | undefined
    return liveRow ? (JSON.parse(liveRow.data) as StoredMessage) : null
  }
  let rows = found.map((r) => ({ root: JSON.parse(r.data) as StoredMessage, replies: Number(r.replies), last: lastOf(r) }))
  let last = after
  if (rows.length > 0) last = Math.max(last, Number(found.at(-1)!.task_id))
  if (query.latest) {
    // The last active: a stable sort keeps ties as they were made (original tasks.ts:645-647).
    const activeAt = (t: (typeof rows)[number]): string => (t.last ?? t.root).createdAt
    rows = [...rows].sort((a, b) => activeAt(a).localeCompare(activeAt(b))).slice(-limit)
  }
  // A page that filled picks up after its last task; once it has read them all, at the board's head.
  const cursor = !query.latest && found.length === limit ? last : Math.max(last, head)
  const tasks: ThreadSummaryView[] = rows.map((t) => ({
    message: host.view(t.root, identity, access),
    replies: t.replies,
    last: t.last ? host.view(t.last, identity, access) : null,
  }))
  return { tasks, cursor: String(cursor) }
}
