// The phased hook registry (M2_DESIGN 2.5.3) and the reserved hold kinds (2.4.3). Empty in slice A:
// the org layer (slice C) registers its hooks and reserves `org.`. Every task write runs through it:
// `plan` after a verb's 4xx gates and before any append, `applied` after the writer in the same
// transaction, `committed` after COMMIT, `candidates` on the claim-next probes, `lapse` in the sweep.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { badRequest, BoardError } from '../errors.ts'
import type { Author } from '../schemas.ts'
import type { StoredEvent } from '../storage.ts'
import type { Identity, PlannedTaskEvent, TaskHost } from './host.ts'
import { cloneRow, isoOf, loadRow, type TaskRow } from './row.ts'
import { commitTaskEventsInTx } from './tx.ts'

export type TaskOp =
  | 'create'
  | 'adopt'
  | 'batch'
  | 'claim'
  | 'claimReady'
  | 'renew'
  | 'release'
  | 'complete'
  | 'fail'
  | 'block'
  | 'unblock'
  | 'cancel'
  | 'reopen'
  | 'assign'
  | 'needs'
  | 'expire'
  | 'edit'
  | 'delete'

export interface TaskPlan {
  readonly op: TaskOp
  readonly caller: Identity | 'system'
  /** The task the verb acts on; a root's ID for create and batch once it is posted. */
  readonly taskId: number | null
  readonly before: Readonly<TaskRow> | null
  /** A hook may replace these; the fold-equivalence check runs on what remains. */
  events: PlannedTaskEvent[]
  /** Extra response fields, for v2 routes only. */
  answer?: Record<string, unknown>
}

export interface TaskApplied {
  op: TaskOp
  caller: Identity | 'system'
  events: StoredEvent[]
  /** Each task the events touched, as the writer left it. */
  rows: ReadonlyMap<number, TaskRow>
}

/** A bound-parameter SQL term the claim probes AND in, over board_tasks' own columns. */
export type CandidateTerm = { sql: string; params: readonly SQLInputValue[] }

/** What a claim-next probe looks for (2.7.10). A `candidates` hook adds `where` terms only. */
export interface CandidateQuery {
  /** The actor and principal the probe takes assigned tasks for. */
  readonly actor: string
  readonly principal: string
  /** The channels a claim may take from: a list (where `label` reaches), or a channel or subtree. */
  readonly scope: { readonly channels: readonly string[] } | { readonly path: string; readonly subtree: boolean }
  /** Labels the root must wear, root only (original store/sql.ts:397, :165-167). */
  readonly labels: readonly (readonly [string, string])[]
  /** The owners whose unassigned tasks it takes. */
  readonly owners: readonly string[]
  readonly where: readonly CandidateTerm[]
}

export type LapseAnswer =
  | { action: 'expire' }
  | { action: 'fail'; reason: string }
  | { action: 'hold'; kind: `org.${string}`; reason: string }

export interface TaskTx {
  now(): number
  row(id: number): TaskRow | null
  /** Cross-task cascades. Runs through the single writer, so FEI holds. */
  transition(taskId: number, events: PlannedTaskEvent[]): StoredEvent[]
  /** Org-only facts: board_events.session_id = 'org', hidden from the default feed. */
  appendOrgEvent(type: `org.${string}`, payload: Record<string, unknown>, channel: string | null): StoredEvent
  systemAuthor(): Author
  db: DatabaseSync
}

export interface TaskHook {
  readonly name: string
  /** In the transaction, after the 4xx gates and before any append. Throw a BoardError to refuse; return a plan to rewrite. */
  plan?(plan: TaskPlan, tx: TaskTx): TaskPlan | void
  /** In the transaction, after the events were appended and rows persisted. */
  applied?(result: TaskApplied, tx: TaskTx): void
  /** After COMMIT, best effort. Errors are logged and swallowed. */
  committed?(result: TaskApplied): void
  /** Adds bound-parameter SQL to the claim probes: extra WHERE terms, never ORDER BY. */
  candidates?(q: CandidateQuery): CandidateQuery
  /** For each lapsed claim the sweep expires. Nothing, or `expire`, is the default. */
  lapse?(row: Readonly<TaskRow>, tx: TaskTx): LapseAnswer | void
}

/** The hold kind no client may send: the board's own, for a root someone else edited (original api/routes.ts:400-408). */
export const RESERVED_HOLD_KINDS: ReadonlySet<string> = new Set(['edited'])

/** The hooks, reserved prefixes and pending post-commit results of one TaskService. */
export class HookRegistry {
  readonly hooks: TaskHook[] = []
  readonly reservedPrefixes: string[] = []
  private pending: TaskApplied[] = []
  /**
   * Who a root's task events are by, set by a root option's `emit` for the `applied` pass the post's
   * own commit of them runs (TaskService.commitRootEventsInTx), in the same synchronous call.
   */
  rootContext: { op: TaskOp; caller: Identity } | null = null

  use(hook: TaskHook): () => void {
    this.hooks.push(hook)
    return () => {
      const at = this.hooks.indexOf(hook)
      if (at >= 0) this.hooks.splice(at, 1)
    }
  }

  reserveHoldPrefix(prefix: string): void {
    if (!/^[a-z0-9][a-z0-9_-]*\.$/.test(prefix)) {
      throw new BoardError(500, 'internal', `a reserved hold prefix is a kind's first part and a dot, like org.: got ${prefix}`)
    }
    if (!this.reservedPrefixes.includes(prefix)) this.reservedPrefixes.push(prefix)
  }

  /** 400 for a client-sent kind under a reserved prefix: those holds are the board's. */
  checkKind(kind: string | undefined): void {
    if (kind === undefined) return
    const prefix = this.reservedPrefixes.find((p) => kind.startsWith(p))
    if (prefix !== undefined) throw badRequest(`kind: ${prefix}* holds are the board's`)
  }

  /** Step 8: each hook's `plan`, in registration order, over what the verb decided. */
  plan(host: TaskHost, plan: TaskPlan): PlannedTaskEvent[] {
    if (this.hooks.length === 0) return plan.events
    let current: TaskPlan = { ...plan, events: [...plan.events] }
    const tx = taskTx(host)
    for (const hook of this.hooks) {
      if (!hook.plan) continue
      current = hook.plan(current, tx) ?? current
    }
    return current.events
  }

  /**
   * Step 10: each hook's `applied`, in the transaction; then queues the result for `committed`. A
   * write this registry does not wrap (BoardService's edit and delete, which run the root hooks) is
   * `deferred`: its `committed` hooks run in a microtask, once the synchronous write has returned,
   * and only if its events are in the log, so a rolled-back write runs none.
   */
  applied(host: TaskHost, op: TaskOp, caller: Identity | 'system', events: StoredEvent[], opts: { deferred?: boolean } = {}): void {
    if (this.hooks.length === 0 || events.length === 0) return
    const rows = new Map<number, TaskRow>()
    for (const ev of events) {
      const id = ev.payload.id
      if (typeof id === 'number' && !rows.has(id)) {
        const row = loadRow(host.store.db, id)
        if (row) rows.set(id, row)
      }
    }
    const result: TaskApplied = { op, caller, events, rows }
    const tx = taskTx(host)
    for (const hook of this.hooks) hook.applied?.(result, tx)
    if (!this.hooks.some((hook) => hook.committed)) return
    if (!opts.deferred) {
      this.pending.push(result)
      return
    }
    const first = events[0]!
    queueMicrotask(() => {
      try {
        if (!host.store.db.prepare('SELECT 1 FROM board_events WHERE event_id = ?').get(first.id)) return
      } catch {
        return
      }
      this.runCommitted([result])
    })
  }

  private runCommitted(results: readonly TaskApplied[]): void {
    for (const applied of results) {
      for (const hook of this.hooks) {
        try {
          hook.committed?.(applied)
        } catch (error) {
          console.error(`task hook ${hook.name} failed after commit:`, error)
        }
      }
    }
  }

  /** The claim probes' query, after each hook's `candidates`. */
  candidates(q: CandidateQuery): CandidateQuery {
    let current = q
    for (const hook of this.hooks) current = hook.candidates?.(current) ?? current
    return current
  }

  /** The first answer other than `expire` of a hook's `lapse`, or `expire`. */
  lapse(host: TaskHost, row: TaskRow): LapseAnswer {
    if (this.hooks.length === 0) return { action: 'expire' }
    const tx = taskTx(host)
    for (const hook of this.hooks) {
      const answer = hook.lapse?.(cloneRow(row), tx)
      if (answer && answer.action !== 'expire') return answer
    }
    return { action: 'expire' }
  }

  /**
   * Runs `write` (which takes the store's transaction), and after it commits each queued result's
   * `committed` hooks. A write that throws drops what it queued. Nested in an open transaction, the
   * results stay queued for the outermost one.
   */
  around<R>(host: TaskHost, write: () => R): R {
    const outer = !host.store.db.isTransaction
    const mark = this.pending.length
    let result: R
    try {
      result = write()
    } catch (error) {
      this.pending.length = mark
      throw error
    }
    if (outer && this.pending.length > 0) {
      const done = this.pending
      this.pending = []
      this.runCommitted(done)
    }
    return result
  }
}

const registries = new WeakMap<TaskHost, HookRegistry>()

/** The registry of the TaskService built on `host`. */
export function hooksOf(host: TaskHost): HookRegistry {
  let found = registries.get(host)
  if (!found) {
    found = new HookRegistry()
    registries.set(host, found)
  }
  return found
}

/** What a hook may do inside the write it runs in. */
export function taskTx(host: TaskHost): TaskTx {
  const db = host.store.db
  return {
    now: () => host.now(),
    row: (id) => loadRow(db, id),
    transition: (taskId, events) => commitTaskEventsInTx(host, host.loadMessage(taskId), loadRow(db, taskId), events),
    appendOrgEvent: (type, payload, channel) => {
      if (!db.isTransaction) throw new BoardError(500, 'internal', 'org events are written inside a transaction only')
      // Stamped by the injected clock like every task event (BoardServiceOptions.now; read under the lock).
      return host.store.appendEvent({ sessionId: 'org', type, channel, payload, createdAt: isoOf(host.now()) })
    },
    systemAuthor: () => host.systemAuthor(),
    db,
  }
}
