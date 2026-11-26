// What a task waits for (M2_DESIGN 2.7.9): the refs a create or a change names, checked as the
// original's namedNeeds and needsAmong (server/tasks.ts:310-338), and the cycle walk a change takes
// behind the prerequisites it adds (acyclic, server/tasks.ts:358-379), one indexed read a level.
import type { DatabaseSync } from 'node:sqlite'
import type { Access } from '../board-service.ts'
import { badRequest, type BoardError } from '../errors.ts'
import { resolveMessageId } from '../social.ts'
import { NEEDS_WALK_MAX } from './bodies.ts'
import { loadRow } from './row.ts'

const invalidNeed = (value: string | number, why: string): BoardError => badRequest(`needs: #${value} ${why}`, 'invalid_needs')

/**
 * The messages `refs` name, each by the ref that named it, first appearance kept. One that names
 * none, or `self`, is refused, over the whole list before any is looked up (original namedNeeds).
 */
export function namedNeeds(db: DatabaseSync, refs: readonly string[] | undefined, self: number | null): Map<number, string> {
  const named = new Map<number, string>()
  for (const value of refs ?? []) {
    const id = resolveMessageId(db, value)
    if (id === 0) throw invalidNeed(value, "isn't a task")
    if (id === self) throw invalidNeed(value, "is the task itself: it can't wait for itself")
    named.set(id, value)
  }
  return named
}

/**
 * The tasks `named` names, and whether they've all completed. One that is no task, or that the
 * caller can't read, is refused alike, so `needs` says nothing of what's out of sight; one that was
 * canceled can never complete. A failed one may be reopened, so it's still something to wait for.
 */
export function needsAmong(db: DatabaseSync, access: Access, named: ReadonlyMap<number, string>): { ids: number[]; completed: boolean } {
  let completed = true
  for (const [id, value] of named) {
    const row = loadRow(db, id)
    if (!row || !access.readable(row.channel)) throw invalidNeed(value, "isn't a task")
    if (row.state === 'canceled') throw invalidNeed(value, 'was canceled: it can never complete')
    if (row.state !== 'completed') completed = false
  }
  return { ids: [...named.keys()], completed }
}

/** namedNeeds, then needsAmong: what a create, an adopt or a change of needs waits for. */
export function needsAt(
  db: DatabaseSync,
  access: Access,
  refs: readonly string[] | undefined,
  self: number | null,
): { ids: number[]; completed: boolean } {
  return needsAmong(db, access, namedNeeds(db, refs, self))
}

/** Whether every task in `needs` has completed, leaving out `but` (original tasks.ts:382-387 satisfied). */
export function satisfied(db: DatabaseSync, needs: readonly number[], but?: number): boolean {
  return needs.filter((id) => id !== but).every((id) => loadRow(db, id)?.state === 'completed')
}

/**
 * Refuses prerequisites that would make task `id` wait for itself (original acyclic). It walks what
 * the `added` ones need, a level a read, breadth first, and gives up past NEEDS_WALK_MAX tasks. It
 * follows no completed task's needs that `access` reads; one the caller can't read is followed
 * whatever its state, so where the walk stops says nothing the caller can't see.
 */
export function acyclic(db: DatabaseSync, access: Access, id: number, added: readonly number[]): void {
  /** Each task the walk reached, by the added prerequisite it reached it from. */
  const from = new Map<number, number>(added.map((need) => [need, need]))
  const rowsOf = db.prepare(
    'SELECT task_id, state, channel FROM board_tasks WHERE task_id IN (SELECT value FROM json_each(?))',
  )
  const edgesOf = db.prepare(
    'SELECT task_id, need_id FROM board_task_needs WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id, pos',
  )
  for (let level = [...added]; level.length > 0; ) {
    const json = JSON.stringify(level)
    const rows = new Map<number, { state: string; channel: string }>()
    for (const r of rowsOf.all(json) as Array<{ task_id: number; state: string; channel: string }>) {
      rows.set(Number(r.task_id), { state: r.state, channel: r.channel })
    }
    const edges = new Map<number, number[]>()
    for (const e of edgesOf.all(json) as Array<{ task_id: number; need_id: number }>) {
      const list = edges.get(Number(e.task_id)) ?? []
      list.push(Number(e.need_id))
      edges.set(Number(e.task_id), list)
    }
    const next: number[] = []
    for (const at of level) {
      const r = rows.get(at)
      if (!r || (r.state === 'completed' && access.readable(r.channel))) continue
      for (const need of edges.get(at) ?? []) {
        if (need === id) throw invalidNeed(from.get(at)!, `waits for #${id} already: they would wait for each other`)
        if (from.has(need)) continue
        from.set(need, from.get(at)!)
        next.push(need)
      }
    }
    if (from.size > NEEDS_WALK_MAX) {
      throw invalidNeed(
        added[0]!,
        `has more than ${NEEDS_WALK_MAX} tasks behind it and the others: too many to check that none waits for #${id}`,
      )
    }
    level = next
  }
}
