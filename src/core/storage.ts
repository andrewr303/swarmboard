import type { DatabaseSync } from 'node:sqlite'
import type { BoardError } from './errors.ts'

export type SqlQuery = {
  sql: string
  params?: readonly unknown[]
}

export type StoredEvent = {
  index: number
  id: string
  sessionId: string
  type: string
  channel: string | null
  thread: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export type AppendEventInput = {
  id?: string
  sessionId?: string
  type: string
  channel?: string | null
  thread?: string | null
  payload: Record<string, unknown>
  createdAt?: string
}

export type EventFilter = {
  after?: number
  before?: number
  channel?: string
  subtree?: boolean
  sessionId?: string
  types?: readonly string[]
  limit?: number
}

export type FtsScope = 'all' | 'messages' | 'tasks' | 'knowledge'

export type FtsSearchQuery = {
  query: string
  scope?: FtsScope
  channel?: string
  subtree?: boolean
  deptId?: string
  labels?: readonly { key: string; values: readonly string[] | null }[]
  limit?: number
  filter?: (hit: FtsSearchHit) => boolean
}

export type FtsSearchHit = {
  kind: 'message' | 'task' | 'knowledge'
  id: string
  channel: string | null
  thread: string | null
  title: string | null
  snippet: string
  score: number
  createdAt: string
  metadata?: Record<string, unknown>
}

/** A post-commit step whose failure is reported, never thrown (C2). */
export type SidecarStep = 'wakeup' | 'jsonl' | 'listener'

/** C1: what external dispatch has done since it was armed (all zero when disarmed). */
export type ExternalDispatchState = {
  armed: boolean
  /** Highest log_index accounted for (dispatched or skipped); 0 when disarmed. */
  cursor: number
  /** Own commits remembered (at most OWN_TRACK_MAX). */
  tracked: number
  /** Own commits forgotten at the bound since arming: each may be dispatched once more. */
  dropped: number
  /** External events fired since arming. */
  dispatched: number
}
export type ExternalDispatchResult = { dispatched: number; skippedOwn: number; skippedSeen: number; cursor: number }
export type ExternalPumpResult = ExternalDispatchResult & { more: boolean }

/** C2. The first four fields are M1's, unchanged in meaning. */
export type SidecarHealth = {
  /** Failed .wakeup writes plus failed .jsonl appends (not listeners). */
  failures: number
  unflushedJsonl: number
  unwrittenWakeup: number
  /** The most recent failure of any step. */
  last: { step: SidecarStep; error: unknown } | null
  /** .jsonl lines dropped past the held-line cap since open or the last successful repair. */
  droppedJsonl: number
  listenerFailures: number
  /** unflushedJsonl > 0 || unwrittenWakeup > 0 || droppedJsonl > 0 */
  degraded: boolean
  external: ExternalDispatchState
}

/** C5: the board's identity. `boardId` never changes; `instanceId` is rotated when the file is restored. */
export type BoardIdentity = { readonly boardId: string; readonly instanceId: string }

/**
 * C5: whether a store still sits on the file at its path, and on the instance a consumer remembers.
 * `replaced`: the path is gone or names another file (stop: HOST0_DESIGN 3.7, 6.4). `restored`: same
 * file, another `instanceId` (an in-place restore, or a rotation by another connection).
 */
export type IdentityCheck =
  | { readonly status: 'same'; readonly identity: BoardIdentity | null }
  | { readonly status: 'restored'; readonly identity: BoardIdentity; readonly was: BoardIdentity }
  | { readonly status: 'replaced'; readonly was: BoardIdentity | null }

/** C3: the file's ladder position and what this store refuses. */
export type SchemaInfo = {
  /**
   * `core.schema_version`, or the inferred 1 / 2 (2 when `tasks_schema` exists) for a legacy file and for a
   * malformed value. Always a number, never NaN.
   */
  readonly version: number
  /** The write floor; a malformed one reads as its legacy default (2 when `tasks_schema` exists, else 1). */
  readonly writeMin: number
  /** The read floor; a malformed one reads as 1. */
  readonly readMin: number
  /** SCHEMA_VERSION of this build. */
  readonly build: number
  /** 'writes' when this store refuses every write (a floor, the legacy gate, a replaced file). */
  readonly refused: 'writes' | null
  /**
   * Present (and true) only when the stored version or a floor is not a 1-9 digit decimal: the numbers
   * above are then inferred, and the file is one this build does not understand (never migrated; its
   * writes are refused unless the store runs with `schemaGate: 'off'`).
   */
  readonly malformed?: true
}

export interface StorageBackend {
  readonly db: DatabaseSync
  /**
   * Runs `fn` in one transaction. `fn` must be synchronous: one that returns a promise (an async
   * body) is refused with a TypeError and what it wrote before returning is rolled back.
   */
  transaction<T>(fn: () => T): T
  appendEvent(event: AppendEventInput): StoredEvent
  appendEvents(events: readonly AppendEventInput[]): StoredEvent[]
  getEvents(filter?: EventFilter): { events: StoredEvent[]; head: number }
  getHeadIndex(): number
  ftsSearch(query: FtsSearchQuery): FtsSearchHit[]
  emitWakeup(reason?: string): number
  getWakeupGeneration(): number
  /**
   * Hears this store's own commits after COMMIT and, while external dispatch is armed, other
   * connections' commits through `dispatchExternal` / `pumpExternal`. A listener is called at most once
   * per committed event per store (bar the counted overflow, `external.dropped`). The two sources are
   * not merged into log_index order, so a listener must be idempotent by cursor. A throwing listener
   * is reported (step 'listener') and never fails a write or another listener. External events carry
   * their payload as `getEvents` returns it and never a clear claim token (only its sha256): a host
   * forwards `BoardService.getEvents` views to a transport, never raw events.
   */
  onEvent(listener: (event: StoredEvent) => void): () => void
  /**
   * C1: starts hearing other connections' commits. The cursor starts at the log's head; returns it.
   * Already armed: returns the current cursor and changes nothing. Closed: 503. In a transaction:
   * TypeError.
   */
  armExternalDispatch(): number
  /** C1: stops it. Idempotent, and does not throw on a closed store. */
  disarmExternalDispatch(): void
  /**
   * C1: fires listeners for a page of events a host read itself. The page must be in strictly
   * ascending index order, at or below the head, and each id must be the log's id at that index
   * (TypeError otherwise, with nothing fired). Events at or below the cursor are skipped, as are this
   * store's own commits. Prefer `pumpExternal`, which reads the page itself.
   */
  dispatchExternal(events: readonly StoredEvent[]): ExternalDispatchResult
  /**
   * C1: reads the log after the cursor (`limit` events, default 200, at most 5000) and dispatches
   * it. A log behind the cursor (replaced or restored) is 410 `cursor_expired`: disarm and arm again.
   * It never writes and takes no write lock.
   */
  pumpExternal(limit?: number): ExternalPumpResult
  /**
   * Reads `core.*`, `host.*` and `fed.*` keys (and the legacy `tasks_schema` and `wakeup_generation`) of
   * board_meta. A key outside those is a TypeError. Inside a transaction it sees that transaction's writes.
   */
  getMeta(key: string): string | undefined
  /**
   * Compare-and-set on a `host.*` or `fed.*` key: writes `next` only when the stored value equals
   * `expected` (`undefined` means no row) and says whether it did. Outside a transaction it is its own
   * BEGIN IMMEDIATE, atomic across processes; inside one it joins that transaction. It appends no
   * event, wakes no one, and has no delete (a lease releases by writing an expired value). To read a
   * clock under the lock: `store.transaction(() => { const now = clock(); const cur = store.getMeta(k);
   * ...; return store.casMeta(k, cur, next) })`.
   */
  casMeta(key: string, expected: string | undefined, next: string): boolean
  /** C2: post-commit sidecar health. Optional: a backend without sidecars has none. */
  sidecarHealth?(): SidecarHealth
  /**
   * The 503 every write gets when the file was written by a newer build (its `tasks_schema` is
   * newer than this one's, or its write floor is above this build: `schema_too_new`), or the file was
   * replaced under this store; null otherwise. Optional: a backend without the gate refuses nothing.
   */
  writeRefusal?(): BoardError | null
  /** C3: the file's ladder position, read fresh (no lock, no cache). Optional: a backend without a ladder has none. */
  schemaInfo?(): SchemaInfo
  /** C5: `core.board_id` and `core.instance_id` as the file holds them now (null when absent). No lock. Optional. */
  identity?(): BoardIdentity | null
  close(): void
}
