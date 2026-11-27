// Reports only see rows returned by the caller's authorized channel reads.
import { DatabaseSync } from 'node:sqlite'
import { ChannelPath, LabelValue } from '../core/public.ts'
import type { BoardClient } from './client.ts'
import { clientError } from './errors.ts'
import type { InsightView } from './insight-views.ts'
import type { CallOptions } from './types.ts'

export interface BoardInsightsInput {
  channel: string
  view: InsightView
  run?: string
  limit?: number
}

// Message/task reads have no explicit next-page flag. Read one extra record
// so an exactly-full report window can still be distinguished from truncation.
const WINDOW = 499
const QUERY = {
  blockers: `WITH tasks AS (SELECT value AS task FROM json_each(?)),
    dependents AS (
      SELECT need.value AS id, count(*) AS total
      FROM tasks, json_each(task, '$.needs') AS need
      WHERE task->>'state' = 'waiting' GROUP BY need.value
    )
    SELECT task->>'id' AS id, task->>'text' AS text, task->>'kind' AS kind,
      task->>'reason' AS reason, coalesce(total, 0) AS waitingDependents
    FROM tasks LEFT JOIN dependents ON dependents.id = task->>'id'
    WHERE task->>'state' = 'blocked'
    ORDER BY waitingDependents DESC, cast(task->>'id' AS INTEGER) LIMIT ?`,
  progress: `SELECT phase, count(*) AS total,
    sum(state = 'ready') AS ready, sum(state = 'claimed') AS claimed,
    sum(state = 'waiting') AS waiting, sum(state = 'blocked') AS blocked,
    sum(state = 'completed') AS completed, sum(state = 'failed') AS failed,
    sum(state = 'canceled') AS canceled
    FROM (SELECT value->>'phase' AS phase, value->>'state' AS state FROM json_each(?))
    GROUP BY phase ORDER BY phase COLLATE NOCASE, phase LIMIT ?`,
  activity: `SELECT value->>'actor' AS actor, count(*) AS posts,
    sum(value->>'reply') AS replies, max(value->>'createdAt') AS lastPostedAt
    FROM json_each(?) GROUP BY actor ORDER BY posts DESC, actor LIMIT ?`,
  unanswered: `SELECT value->>'id' AS id, value->>'actor' AS actor,
    value->>'text' AS text, value->>'createdAt' AS createdAt
    FROM json_each(?) WHERE value->>'replies' = 0
    ORDER BY createdAt DESC, cast(id AS INTEGER) DESC LIMIT ?`,
} as const

interface Window {
  records: object[]
  scanned: number
  truncated: boolean
  cursor: string
}

async function readWindow(client: BoardClient, input: BoardInsightsInput, opts?: CallOptions): Promise<Window> {
  const { channel, run, view } = input
  // The wire filter uses pipes for OR and accepts one line. Match other
  // legitimate label values literally after the authorized channel read.
  const label = run && !/[|\r\n\u2028\u2029]/u.test(run) ? { label: { run } } : {}
  const inRun = (value?: string) => run === undefined || value === run
  if (view === 'progress' || view === 'blockers') {
    const page = await client.tasks.list({ channel, state: view === 'blockers' ? 'open' : 'all', limit: WINDOW + 1, ...label }, opts)
    const tasks = page.tasks.slice(0, WINDOW)
    const now = Date.now()
    const records = tasks.flatMap<object>(({ message }) => {
      const task = message.task
      if (message.deleted || !task || !inRun(message.labels.run)) return []
      if (view === 'blockers') {
        if (task.state === 'waiting') return [{ state: task.state, needs: task.needs }]
        if (task.state !== 'blocked') return []
        return [{ id: message.id, state: task.state, text: message.text.slice(0, 240),
          kind: task.blocked?.kind ?? null, reason: task.blocked?.reason ?? null }]
      }
      const lapsed = task.state === 'claimed' && task.claim && Date.parse(task.claim.until) <= now
      return [{ phase: message.labels.phase?.trim() || 'Unassigned phase', state: lapsed ? 'ready' : task.state }]
    })
    const truncated = page.tasks.length > WINDOW
    const cursor = truncated ? tasks[tasks.length - 1]!.message.id : page.cursor
    return { records, scanned: tasks.length, cursor, truncated }
  }
  if (view === 'unanswered') {
    const page = await client.threads({ channel, limit: WINDOW + 1, ...label }, opts)
    const threads = page.threads.slice(-WINDOW)
    const records = threads.filter(({ message }) => !message.deleted && inRun(message.labels.run))
      .map(({ message, replies }) => ({
        id: message.id, actor: message.by.actor, createdAt: message.createdAt, text: message.text.slice(0, 240), replies,
      }))
    return { records, scanned: threads.length, cursor: page.cursor, truncated: !!page.older || page.threads.length > WINDOW }
  }

  const page = await client.channel(channel).messages({ limit: WINDOW + 1 }, opts)
  const messages = page.messages.slice(-WINDOW)
  const rootRuns = new Map(page.messages.filter(m => m.re === null).map(m => [m.id, m.labels.run]))
  let truncated = page.messages.length > WINDOW
  if (run !== undefined && messages.some(m => m.re !== null && !rootRuns.has(m.re))) {
    // Resolve older roots in a single bounded thread read instead of issuing
    // a separate query per reply. The root's run applies to its replies.
    const roots = await client.threads({ channel, limit: WINDOW + 1, ...label }, opts)
    for (const { message } of roots.threads) rootRuns.set(message.id, message.labels.run)
    truncated ||= !!roots.older || roots.threads.length > WINDOW
  }
  const records = messages.filter(m => !m.deleted && (m.author?.kind === 'agent' || m.by.profile !== null)
      && inRun(rootRuns.get(m.re ?? m.id)))
    .map(m => ({ actor: m.by.actor, reply: Number(m.re !== null), createdAt: m.createdAt }))
  return { records, scanned: messages.length, cursor: page.cursor, truncated }
}

export async function getBoardInsights(client: BoardClient, input: BoardInsightsInput, opts?: CallOptions) {
  const limit = input.limit ?? 20
  if (!ChannelPath.safeParse(input.channel).success || !Object.hasOwn(QUERY, input.view)
      || (input.run !== undefined && !LabelValue.safeParse(input.run).success)
      || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw clientError('invalid_request', 'Reports require an exact channel, a supported view, a valid run label, and a limit of 1–100.')
  }
  const { records, ...coverage } = await readWindow(client, input, opts)
  const db = new DatabaseSync(':memory:')
  try {
    const result = db.prepare(QUERY[input.view]).all(JSON.stringify(records), limit + 1)
    return { channel: input.channel, view: input.view, ...(input.run !== undefined ? { run: input.run } : {}),
      rows: result.slice(0, limit), coverage: { ...coverage, rowsTruncated: result.length > limit } }
  } finally {
    db.close()
  }
}
