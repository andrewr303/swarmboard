// The task engine (M2_DESIGN 2.5.1). BoardService exposes one as `board.tasks`, built on a TaskHost.
// Slice A0/A1 laid its infrastructure: the single writer, the root option's commit, and the index
// rebuild. A2..A4 add create and adopt, claim by ID, the fenced writes, promotion and the owner verbs;
// A5..A8 add batch, list, claim next with its waits, the sweep, the root hooks and the hook registry.
import type { CallerContext, Mentioned, StoredMessage } from '../board-service.ts'
import { FROM_MAX } from './bodies.ts'
import {
  LEASE_CAP_S,
  LEASE_DEFAULT_S,
  LEASE_MIN_S,
  TASK_BATCH_MAX,
  TASK_NEEDS_MAX,
  type MessageView,
  type TaskClaim,
  type TasksPage,
} from '../schemas.ts'
import type { StoredEvent } from '../storage.ts'
import { createTasks, getBatch, type CreatedTasks } from './batch.ts'
import { claimTask } from './claim.ts'
import { claimReady, claimReadyOnce, type ClaimedNext } from './claim-ready.ts'
import { createTask } from './create.ts'
import type { Identity, PlannedTaskEvent, TaskHost } from './host.ts'
import { hooksOf, type HookRegistry, type TaskHook } from './hooks.ts'
import { listTasks } from './list.ts'
import { assignTask, blockTask, cancelTask, reopenTask, setTaskNeeds, unblockTask } from './owner.ts'
import { rebuildTaskIndexInTx } from './rebuild.ts'
import { loadRow } from './row.ts'
import { completeTask, failTask, releaseTask, renewTask } from './settle.ts'
import {
  expireDueClaims,
  nextLeaseDueMs,
  onRootDeletedInTx,
  onRootDeletingInTx,
  onRootEditedInTx,
  type ExpireRun,
} from './sweep.ts'
import { commitTaskEventsInTx } from './tx.ts'
import { WaiterHub } from './waiters.ts'

export interface TaskServiceOptions {
  /** Wake source for waits. Default: host.store.onEvent (in-process). HOST-3's WakeBridge plugs in here. */
  wake?: (listener: (ev: StoredEvent) => void) => () => void
  /** Safety poll ceiling once a cross-process wake source is armed. Default 1500 ms (H:377). */
  armedSafetyPollMs?: number
}

/** What this board's task engine supports (2.5.1): the local board's limits, as literal types. */
export interface TaskCapabilities {
  lease_min_s: 30
  lease_cap_s: 3600
  lease_default_s: 900
  batch_max: 100
  needs_max: 20
  from_max: 32
  conditional_needs: boolean
  priority_native: boolean
  defer: boolean
  resume: boolean
  reserved_hold_prefixes: string[]
}

export class TaskService {
  /** @internal The port to BoardService. Not for transports. */
  readonly host: TaskHost
  protected readonly options: TaskServiceOptions
  private readonly hooks: HookRegistry
  private readonly hub: WaiterHub

  constructor(host: TaskHost, options: TaskServiceOptions = {}) {
    this.host = host
    this.options = options
    this.hooks = hooksOf(host)
    this.hub = new WaiterHub(options.wake ?? ((listener) => host.store.onEvent(listener)))
  }

  /** Called by BoardService inside its edit and delete transactions (2.7.12). */
  readonly rootHooks: {
    /** After message.edited is appended and saved. */
    onRootEditedInTx(root: StoredMessage, editor: Identity, edit: StoredEvent): void
    /** Before message.deleted is appended, while the root still wears its labels. */
    onRootDeletingInTx(root: StoredMessage, deleter: Identity): void
    /** After message.deleted is appended and saved: the index row remembers its root is gone. */
    onRootDeletedInTx(root: StoredMessage): void
  } = {
    onRootEditedInTx: (root, editor) => onRootEditedInTx(this.host, root, editor),
    onRootDeletingInTx: (root, deleter) => onRootDeletingInTx(this.host, root, deleter),
    onRootDeletedInTx: (root) => onRootDeletedInTx(this.host, root),
  }

  /**
   * @internal The task events a new root's post carries (TaskRootOption.emit), through the single
   * writer, inside postMessageAs's transaction. `root` is updated in place.
   */
  commitRootEventsInTx(root: StoredMessage, planned: readonly PlannedTaskEvent[]): StoredEvent[] {
    const context = this.hooks.rootContext
    this.hooks.rootContext = null
    if (planned.length === 0) return []
    const appended = commitTaskEventsInTx(this.host, root, loadRow(this.host.store.db, root.id), planned)
    if (context) this.hooks.applied(this.host, context.op, context.caller, appended)
    return appended
  }

  /**
   * @internal A system transition (TaskTx.transition, 2.5.3): `events` about task `taskId`, through
   * the single writer in one transaction of its own (or the caller's, when nested). No access check:
   * hooks, the sweep and tests only, never a transport.
   */
  transition(taskId: number, events: readonly PlannedTaskEvent[]): StoredEvent[] {
    return this.host.store.transaction(() => {
      const db = this.host.store.db
      return commitTaskEventsInTx(this.host, this.host.loadMessage(taskId), loadRow(db, taskId), events)
    })
  }

  // ---- v1, wire-compatible verbs. `raw` is parsed with the ported zod bodies (original
  //      api/routes.ts:249-414): a misshapen body is 400 invalid_request before anything is read.

  /** POST /tasks: 201. Exactly one of channel | re. */
  createTask(caller: CallerContext, raw: unknown): { task: MessageView; claim?: TaskClaim; mentions?: Mentioned[] } {
    return createTask(this.host, caller, raw)
  }
  /** POST /tasks/batch: 201. 1..100 tasks, all or none. */
  createTasks(caller: CallerContext, raw: unknown): CreatedTasks {
    return createTasks(this.host, caller, raw)
  }
  /** GET /tasks/batch/:id?request=: 200 | 404 batch_not_found | 409 duplicate_id. */
  getBatch(caller: CallerContext, id: string, raw?: unknown): { tasks: MessageView[] } {
    return getBatch(this.host, caller, id, raw)
  }
  /** GET /tasks: 200. */
  listTasks(caller: CallerContext, raw?: unknown): TasksPage {
    return listTasks(this.host, caller, raw)
  }
  /** POST /tasks/:id/claim: 200. Body {lease?, token?}. */
  claimTask(caller: CallerContext, id: string | number, raw?: unknown): { task: MessageView; claim: TaskClaim } {
    return claimTask(this.host, caller, id, raw)
  }
  /** POST /tasks/claim, one attempt, no wait. */
  claimReadyOnce(caller: CallerContext, raw: unknown, signal?: AbortSignal): ClaimedNext {
    return claimReadyOnce(this.host, caller, raw, signal)
  }
  /** POST /tasks/claim: 200. Body {channel, label?, from?, lease?, wait? (0..300), token?}. */
  claimReady(caller: CallerContext, raw: unknown, signal?: AbortSignal): Promise<ClaimedNext> {
    const armed = this.options.wake !== undefined
    return claimReady(this.host, this.hub, { armed, armedPollMs: this.options.armedSafetyPollMs ?? 1500 }, caller, raw, signal)
  }
  renewTask(caller: CallerContext, id: string | number, raw: unknown): { task: MessageView; until: string } {
    return renewTask(this.host, caller, id, raw)
  }
  releaseTask(caller: CallerContext, id: string | number, raw: unknown): { task: MessageView } {
    return releaseTask(this.host, caller, id, raw)
  }
  completeTask(caller: CallerContext, id: string | number, raw: unknown): { task: MessageView } {
    return completeTask(this.host, caller, id, raw)
  }
  failTask(caller: CallerContext, id: string | number, raw: unknown): { task: MessageView } {
    return failTask(this.host, caller, id, raw)
  }
  blockTask(caller: CallerContext, id: string | number, raw: unknown): { task: MessageView } {
    return blockTask(this.host, caller, id, raw)
  }
  unblockTask(caller: CallerContext, id: string | number): { task: MessageView } {
    return unblockTask(this.host, caller, id)
  }
  reopenTask(caller: CallerContext, id: string | number): { task: MessageView } {
    return reopenTask(this.host, caller, id)
  }
  assignTask(caller: CallerContext, id: string | number, raw: unknown): { task: MessageView } {
    return assignTask(this.host, caller, id, raw)
  }
  setTaskNeeds(caller: CallerContext, id: string | number, raw: unknown): { task: MessageView } {
    return setTaskNeeds(this.host, caller, id, raw)
  }
  cancelTask(caller: CallerContext, id: string | number, raw: unknown): { task: MessageView } {
    return cancelTask(this.host, caller, id, raw)
  }

  // ---- system calls, not routes

  /** Expire lapsed claims in chunks, never early. Driven by HOST-3's tick lease or `swarmboard tick`. */
  expireDueClaims(nowMs?: number, opts?: { limit?: number; chunk?: number }): ExpireRun {
    return expireDueClaims(this.host, nowMs, opts)
  }
  /** Earliest claim_until_ms of any claimed row, or null. Lets a tick sleep exactly. */
  nextLeaseDueMs(): number | null {
    return nextLeaseDueMs(this.host.store.db)
  }
  /** Truncate and replay board_tasks and board_task_needs from the log. Returns the row and edge counts. */
  rebuildIndex(): { tasks: number; edges: number } {
    const { tasks, edges } = this.host.store.transaction(() => rebuildTaskIndexInTx(this.host.store.db))
    return { tasks, edges }
  }
  /** For capability discovery (v2 and agent-mesh). */
  capabilities(): TaskCapabilities {
    return {
      lease_min_s: LEASE_MIN_S,
      lease_cap_s: LEASE_CAP_S,
      lease_default_s: LEASE_DEFAULT_S,
      batch_max: TASK_BATCH_MAX,
      needs_max: TASK_NEEDS_MAX,
      from_max: FROM_MAX,
      conditional_needs: false,
      priority_native: false,
      defer: false,
      resume: false,
      reserved_hold_prefixes: [...this.hooks.reservedPrefixes],
    }
  }

  // ---- seams

  /** Registers a hook; returns its unregister function. Empty in slice A. */
  use(hook: TaskHook): () => void {
    return this.hooks.use(hook)
  }
  /** Reserves a hold-kind prefix for the board (the org bootstrap's `org.`): clients may no longer send it. */
  reserveHoldPrefix(prefix: `${string}.`): void {
    this.hooks.reserveHoldPrefix(prefix)
  }
}
