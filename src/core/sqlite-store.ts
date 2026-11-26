import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { threadId } from 'node:worker_threads'
import { BoardError, badRequest, duplicateId, normalizeError } from './errors.ts'
import { scanJsonl, type JsonlAudit } from './jsonl-audit.ts'
import {
  META_BOARD_ID,
  META_INSTANCE_FILE,
  META_INSTANCE_ID,
  META_READ_MIN,
  META_READABLE_KEY,
  META_READABLE_LEGACY,
  META_SCHEMA_VERSION,
  META_VALUE_MAX_BYTES,
  META_WRITABLE_KEY,
  META_WRITE_MIN,
  RESERVED_META_KEYS,
} from './meta-keys.ts'
import {
  parseDecimal,
  readSchemaState,
  SCHEMA_STEPS,
  SCHEMA_VERSION,
  schemaTooNew,
  upsertMeta,
  type SchemaGate,
  type SchemaStepContext,
} from './migrations.ts'
import type {
  AppendEventInput,
  BoardIdentity,
  EventFilter,
  ExternalDispatchResult,
  ExternalPumpResult,
  FtsSearchHit,
  FtsSearchQuery,
  IdentityCheck,
  SchemaInfo,
  SidecarHealth,
  SidecarStep,
  StorageBackend,
  StoredEvent,
} from './storage.ts'

export type SqliteStoreOptions = {
  path: string
  /**
   * The `.jsonl` audit copy of `board_events` (default `<path>.jsonl`, `null` for none). Lines are appended
   * after COMMIT and are not in `log_index` order across connections; a line may repeat. Order by each
   * line's `index`.
   */
  jsonlPath?: string | null
  wakeupPath?: string | null
  busyTimeoutMs?: number
  /** WAL autocheckpoint page threshold for file-backed stores (default 1000; 0 disables). */
  walAutocheckpoint?: number
  /** Maximum WAL/journal size in bytes retained after checkpoint/reset for file-backed stores (default 67_108_864 = 64 MB; negative = unlimited). */
  journalSizeLimitBytes?: number
  /**
   * Called when a post-commit sidecar step (the .wakeup file or the .jsonl
   * audit append) fails. The write it belongs to has committed and is not
   * reported as failed; .jsonl lines are retried after the next commit.
   */
  onSidecarError?: (error: unknown, step: SidecarStep) => void
  /**
   * C3: `'refuse-newer'` (default) enforces the schema floors and the legacy `tasks_schema` gate; `'off'`
   * (recovery tooling and tests only) enforces neither, still never migrates a file this build does not
   * understand, and keeps the replaced-file fence.
   */
  schemaGate?: SchemaGate
  /**
   * Test-only seams, inert when unset (M2_DESIGN AT-24, AT-37): `onBeginImmediate` runs just before
   * each outermost `BEGIN IMMEDIATE`, `beforeCommit` just before its `COMMIT` (a crash test kills the
   * process there). `afterCommit` runs after the outermost COMMIT and own-commit tracking, before the
   * sidecars (an exception in it is swallowed): a crash test kills the process there. `onSchemaStep`
   * runs inside a ladder step's transaction, after its `up()` and before its meta writes. `newId` makes
   * the board and instance ids deterministic. `statFile` replaces `fs.statSync(absPath, {bigint: true})`
   * for the open-time record, the replaced-file fence and `checkIdentity` (undefined = no entry).
   * `betweenWakeupReads` runs inside the rewind check (C5 case 2), after it read the .wakeup file's
   * generation and before it reads the database's, so a test can commit there and prove the order.
   */
  testHooks?: {
    beforeCommit?: () => void
    onBeginImmediate?: () => void
    afterCommit?: () => void
    onSchemaStep?: (version: number) => void
    newId?: (prefix: 'b_' | 'i_') => string
    statFile?: (absPath: string) => { dev: bigint; ino: bigint } | undefined
    betweenWakeupReads?: () => void
  }
}

/** The task index schema this build writes (board_meta 'tasks_schema', M2_DESIGN 2.6). */
export const TASKS_SCHEMA_VERSION = 1

/** Cap on .jsonl lines held for retry while the sidecar cannot be written. */
const UNFLUSHED_JSONL_MAX = 10_000

/** Cap on own commit indices an armed store remembers so it does not dispatch them again (C1). */
const OWN_TRACK_MAX = 65_536
/** The default page `pumpExternal` reads. */
const PUMP_PAGE_DEFAULT = 200
/** The most events one `getEvents` page (and one pump) reads. */
const EVENTS_PAGE_MAX = 5000

/** C1 state while external dispatch is armed. */
type ExternalState = { cursor: number; own: Set<number>; dropped: number; dispatched: number }

function channelSubtreeWhere(column: string, channel: string, subtree: boolean | undefined, params: (string | number)[]): string {
  if (!subtree) {
    params.push(channel)
    return `${column} = ?`
  }
  const slashPrefix = `${channel}/`
  params.push(channel, slashPrefix, slashPrefix)
  return `(${column} = ? OR substr(${column}, 1, length(?)) = ?)`
}

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4))

/**
 * Whether an FTS5 query holds an empty phrase (`""`, `"   "`), which FTS5 reads oddly. Inside a quoted
 * phrase a doubled quote (`""`) is FTS5's way to write one literal quote character, so it is content:
 * it neither closes the phrase nor makes it empty.
 */
function hasEmptyFtsPhrase(raw: string): boolean {
  let inQuote = false
  let emptyPhrase = true
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === '"') {
      if (!inQuote) {
        inQuote = true
        emptyPhrase = true
      } else if (raw[i + 1] === '"') {
        emptyPhrase = false
        i += 1
      } else {
        if (emptyPhrase) return true
        inQuote = false
      }
    } else if (inQuote && !/\s/.test(ch)) {
      emptyPhrase = false
    }
  }
  return false
}

/**
 * A search's label filter, as conditions on a hit whose message row is `m`: each label must be on
 * the message or on its thread's root. A hit with no message row (`m.id` NULL) matches none.
 */
function labelWhere(
  labels: FtsSearchQuery['labels'],
  where: string[],
  params: (string | number)[],
): void {
  if (!labels) return
  for (const label of labels) {
    if (label.values === null) {
      params.push(label.key)
      where.push('EXISTS (SELECT 1 FROM board_terms t WHERE t.message_id IN (m.id, m.re) AND t.term = ?)')
    } else if (label.values.length > 0) {
      params.push(label.key, ...label.values)
      where.push(
        `EXISTS (SELECT 1 FROM board_terms t WHERE t.message_id IN (m.id, m.re) AND t.term = ? AND t.value IN (${label.values.map(() => '?').join(', ')}))`,
      )
    } else {
      where.push('1 = 0')
    }
  }
}

/**
 * Whether a search failed because of its query: SQLite's generic SQLITE_ERROR (1), which is how
 * FTS5 reports a query it can't parse. Any other SQLite error (corruption, I/O, busy, locked) is
 * the store's, not the caller's, and goes on to normalizeError as a 500 or a retryable 503.
 */
function isFtsSyntaxError(error: unknown): boolean {
  const e = error as { code?: unknown; errcode?: unknown } | null
  if (e?.code !== 'ERR_SQLITE_ERROR') return false
  // Also SQLITE_ERROR, but a statement too large for SQLite (a label filter of thousands of
  // values) is no fault of the FTS query's.
  if (error instanceof Error && /too many SQL variables/i.test(error.message)) return false
  if (typeof e.errcode === 'number') return (e.errcode & 0xff) === 1
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    msg.includes('fts5: syntax error') ||
    msg.includes('syntax error') ||
    msg.includes('unterminated string') ||
    msg.includes('no such column')
  )
}

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), with any extended code: another connection holds a lock. */
function isBusyError(error: unknown): boolean {
  const e = error as { code?: unknown; errcode?: unknown; message?: unknown } | null
  if (e?.code !== 'ERR_SQLITE_ERROR') return false
  if (typeof e.errcode === 'number') {
    const primary = e.errcode & 0xff
    return primary === 5 || primary === 6
  }
  return typeof e.message === 'string' && /database (?:table )?is locked/i.test(e.message)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** An empty .wakeup.lock older than this was left between its create and its holder's write. */
const EMPTY_LOCK_STALE_MS = 200

/**
 * What a writer puts in the .wakeup.lock it holds: its process, its thread, and a nonce of this
 * hold. Worker threads share a pid, so the thread tells this thread's own lock from a sibling's,
 * and the nonce tells this hold's from any other, so a holder removes only the lock it made.
 * @internal
 */
export function wakeupLockToken(): string {
  return `${process.pid}:${threadId}:${randomUUID().slice(0, 8)}`
}

/**
 * Whether a .wakeup.lock was left by a writer that is gone: one naming a process that no longer
 * exists, or this very thread (which holds the lock only inside a synchronous write, so never
 * while it waits for it), or one that is empty past the moment its holder writes its token, or one
 * naming this process by its pid alone. A
 * live holder keeps it for a few file operations, so a waiter breaks a dead one at once instead of
 * stalling. Another thread of this process is alive while the process is: its lock is waited for,
 * and only the five-second fallback breaks one a thread that died left.
 * @internal
 */
export function staleWakeupLock(lockPath: string): boolean {
  let content: string
  let ageMs: number
  try {
    content = fs.readFileSync(lockPath, 'utf8').trim()
    ageMs = Date.now() - fs.statSync(lockPath).mtimeMs
  } catch {
    return false
  }
  const holder = /^([1-9]\d{0,9})(?::(\d{1,10})(?::[0-9a-f]{1,32})?)?$/.exec(content)
  if (!holder) return ageMs > EMPTY_LOCK_STALE_MS
  const pid = Number(holder[1])
  // A pid alone is no lock this code wrote (it writes its thread too), so one naming this process
  // was left by an earlier process that had its pid.
  if (pid === process.pid) return holder[2] === undefined || Number(holder[2]) === threadId
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as { code?: string } | null)?.code === 'ESRCH'
  }
}

/**
 * Removes the .wakeup.lock only if it is still the one `token` made: a holder whose lock another
 * writer broke (after the five-second fallback) must not remove the lock that writer holds now.
 * @internal
 */
export function releaseWakeupLock(lockPath: string, token: string): boolean {
  try {
    if (fs.readFileSync(lockPath, 'utf8').trim() !== token) return false
    fs.unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

export class SqliteUnifiedStore implements StorageBackend {
  private readonly database: DatabaseSync
  readonly path: string
  readonly jsonlPath: string | null
  readonly wakeupPath: string | null

  private txDepth = 0
  /** A nested savepoint failed to roll back: the outermost transaction may only roll back. */
  private rollbackOnly = false
  private pendingJsonl: string[] = []
  private pendingEvents: StoredEvent[] = []
  private pendingWakeups = 0
  private committedWakeupGen = 0
  private unflushedJsonl: string[] = []
  /** A committed generation the .wakeup file could not be raised to yet: retried after the next commit. */
  private unwrittenWakeupGen = 0
  private sidecarFailures = 0
  private droppedJsonl = 0
  private listenerFailures = 0
  private external: ExternalState | null = null
  private lastSidecarErrorValue: { step: SidecarStep; error: unknown } | null = null
  private readonly onSidecarError: ((error: unknown, step: SidecarStep) => void) | null
  private readonly listeners = new Set<(event: StoredEvent) => void>()
  private closed = false
  private readonly testHooks: NonNullable<SqliteStoreOptions['testHooks']> | null
  /** Set when the file's task index or write floor is newer than this build's, or the file was replaced: every write is refused with it. */
  private writesRefusedBy: BoardError | null = null
  /** The sticky refusal once the path was found to name another file, or none (C5). */
  private replacedBy: BoardError | null = null
  private readonly gate: SchemaGate
  private readonly isMemory: boolean
  /** The absolute path the fence stats ('' for `:memory:`). */
  private readonly absPath: string
  /** The inode as a decimal, as `core.instance_file` records it; '' for `:memory:` and inode 0. */
  private fileId = ''
  /** `dev:ino` of the file opened, which the fence compares; '' turns the fence off (`:memory:`, inode 0). */
  private openedFileKey = ''
  /** False while the ladder runs at open, so the fences never read a board_meta step 1 has not made. */
  private ladderReady = false
  private metaStmt: ReturnType<DatabaseSync['prepare']> | null = null
  /** C5: the identity as this store left the file at open (after any rotation); null for a write-refused legacy file. */
  readonly openedIdentity: BoardIdentity | null = null

  constructor(options: SqliteStoreOptions) {
    this.path = options.path
    this.testHooks = options.testHooks ?? null
    this.onSidecarError = options.onSidecarError ?? null
    this.gate = options.schemaGate ?? 'refuse-newer'
    const isMemory = options.path === ':memory:'
    this.isMemory = isMemory
    this.jsonlPath = options.jsonlPath !== undefined ? options.jsonlPath : isMemory ? null : `${options.path}.jsonl`
    this.wakeupPath = options.wakeupPath !== undefined ? options.wakeupPath : isMemory ? null : `${options.path}.wakeup`
    this.absPath = isMemory ? '' : resolve(options.path)

    if (!isMemory) {
      fs.mkdirSync(dirname(options.path), { recursive: true })
    }
    if (this.jsonlPath) {
      fs.mkdirSync(dirname(this.jsonlPath), { recursive: true })
    }
    if (this.wakeupPath) {
      fs.mkdirSync(dirname(this.wakeupPath), { recursive: true })
    }

    this.database = new DatabaseSync(options.path)
    // HOST0_DESIGN 6.3: a failure anywhere in the open closes the handle before it is thrown, so a
    // refused or busy open leaves no connection (and no lock) behind.
    try {
      const timeout = Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))
      this.database.exec(`PRAGMA busy_timeout = ${timeout};`)
      this.database.exec('PRAGMA foreign_keys = ON;')
      if (!isMemory) {
        this.ensureWal(timeout)
        this.database.exec('PRAGMA synchronous = NORMAL;')
        const walAutocheckpoint =
          options.walAutocheckpoint !== undefined && Number.isFinite(options.walAutocheckpoint)
            ? Math.max(0, Math.floor(options.walAutocheckpoint))
            : 1000
        const journalSizeLimit =
          options.journalSizeLimitBytes !== undefined && Number.isFinite(options.journalSizeLimitBytes)
            ? Math.trunc(options.journalSizeLimitBytes)
            : 67_108_864
        this.database.exec(`PRAGMA wal_autocheckpoint = ${walAutocheckpoint};`)
        this.database.exec(`PRAGMA journal_size_limit = ${journalSizeLimit};`)
      }
      const opened = this.statFile()
      if (opened && opened.ino !== 0n) {
        this.fileId = String(opened.ino)
        this.openedFileKey = `${opened.dev}:${opened.ino}`
      }
      this.openSchema()
      this.committedWakeupGen = Math.max(this.committedWakeupGen, this.readInitialWakeupGeneration())
      this.openedIdentity = this.identity()
    } catch (error) {
      this.closed = true
      try {
        this.database.close()
      } catch {
        // Already unusable
      }
      throw isBusyError(error) ? normalizeError(error) : error
    }
  }

  /**
   * The open database. Once the store is closed every use of it, a read as much as a write, is a
   * typed 503 `unavailable` rather than node:sqlite's raw `ERR_INVALID_STATE`, which a server would
   * answer with a 500.
   */
  get db(): DatabaseSync {
    if (this.closed) throw new BoardError(503, 'unavailable', 'storage is closed')
    return this.database
  }

  /**
   * Puts a file board in WAL mode (C3, CR-4, SEC-4). `PRAGMA journal_mode = WAL` does not wait on the
   * busy handler, so simultaneous first opens of one file lost processes to `database is locked` (g2 P2):
   * the mode is read first (a WAL file never tries the switch), and the read and the switch are retried
   * until `busyTimeoutMs`. Only a lock problem is retried; anything else fails at once. A mode that never
   * becomes `wal` without throwing ends at the deadline too: 503 `unavailable`, `retryAfter` 1.
   */
  private ensureWal(busyTimeoutMs: number): void {
    const deadline = Date.now() + busyTimeoutMs
    let delay = 1
    let last: unknown = null
    for (;;) {
      try {
        const now = this.database.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined
        if (String(now?.journal_mode).toLowerCase() === 'wal') return
        const set = this.database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined
        const mode = String(set?.journal_mode).toLowerCase()
        if (mode === 'wal') return
        last = new BoardError(503, 'unavailable', `the board file did not switch to WAL (journal_mode ${mode})`, { retryAfter: 1 })
      } catch (error) {
        if (!isBusyError(error)) {
          // Not a lock problem: fail at once. A 500 keeps what SQLite said as its cause.
          const normalized = normalizeError(error)
          if (normalized !== error) normalized.cause ??= error
          throw normalized
        }
        last = error
      }
      if (Date.now() >= deadline) throw normalizeError(last)
      Atomics.wait(SLEEP_ARRAY, 0, 0, delay)
      delay = Math.min(delay * 2, 32)
    }
  }

  /** `fs.statSync(absPath, {bigint})` (or `testHooks.statFile`); undefined for `:memory:` or no entry. */
  private statFile(): { dev: bigint; ino: bigint } | undefined {
    if (this.isMemory) return undefined
    const hook = this.testHooks?.statFile
    if (hook) return hook(this.absPath)
    const st = fs.statSync(this.absPath, { bigint: true, throwIfNoEntry: false })
    return st ? { dev: st.dev, ino: st.ino } : undefined
  }

  /** Whether the path still names the file this store opened (always true when the fence is off: `:memory:`, inode 0). */
  private stillOnOpenedFile(): boolean {
    if (this.openedFileKey === '') return true
    const now = this.statFile()
    return now !== undefined && `${now.dev}:${now.ino}` === this.openedFileKey
  }

  /** The sticky refusal of a store whose path was replaced or removed under it (C5, 3.7). */
  private refuseReplaced(): BoardError {
    this.replacedBy ??= new BoardError(
      503,
      'unavailable',
      'the board file was replaced or removed while this store had it open: open it again',
    )
    this.writesRefusedBy = this.replacedBy
    return this.replacedBy
  }

  /**
   * The open-time ladder (C3): the read floor, the legacy `tasks_schema` gate and the write floor (gate
   * `'refuse-newer'` only), then the migration of an older file (never of a `newer` one, under either
   * gate), then the automatic instance rotation (C5). A refused or newer file sees no write at open.
   */
  private openSchema(): void {
    const state = readSchemaState(this.database)
    if (this.gate === 'refuse-newer') {
      if (!(state.readMin <= SCHEMA_VERSION)) throw schemaTooNew('read', state)
      const tasks = state.tasksSchema
      if (tasks !== undefined && !(parseDecimal(tasks) <= TASKS_SCHEMA_VERSION)) {
        this.writesRefusedBy = new BoardError(503, 'unavailable', `this board was written by a newer Swarmboard (tasks_schema ${tasks})`)
      }
      // A write floor above this build, or a malformed floor or version (a file this build does not understand).
      const malformedVersion = state.stored !== null && Number.isNaN(state.stored)
      if (!(state.writeMin <= SCHEMA_VERSION) || malformedVersion) this.writesRefusedBy ??= schemaTooNew('write', state)
    }
    if (!this.writesRefusedBy && !state.newer && state.effective < SCHEMA_VERSION) this.migrate()
    this.ladderReady = true
    // Only a file whose identity existed before this open can have been restored: one this open minted
    // has nothing to fence.
    if (!this.writesRefusedBy && !state.newer && !this.isMemory && state.identity !== null) this.maybeRotateInstance()
  }

  /** What a ladder step sees of this store. */
  private stepContext(): SchemaStepContext {
    return {
      wakeupFileGeneration: () => this.readFileWakeupGeneration(),
      wakeupDbGeneration: () => this.readDbWakeupGeneration(),
      fileId: this.fileId,
      newId: (prefix) => this.newId(prefix),
    }
  }

  private newId(prefix: 'b_' | 'i_'): string {
    const hook = this.testHooks?.newId
    return hook ? hook(prefix) : `${prefix}${randomUUID().replaceAll('-', '')}`
  }

  /**
   * Runs the missing ladder steps, one BEGIN IMMEDIATE each, re-reading the state under the lock so that
   * with many openers each step runs exactly once. Bounded (CR-7, SEC-6): at most one pass per step, and a
   * step that does not raise `effective` is a 500 that rolls back.
   */
  private migrate(): void {
    const ctx = this.stepContext()
    for (let pass = 0; pass < SCHEMA_STEPS.length; pass++) {
      const outside = readSchemaState(this.database)
      if (outside.newer || outside.effective >= SCHEMA_VERSION) return
      this.transaction(() => {
        const s = readSchemaState(this.database)
        if (s.newer || s.effective >= SCHEMA_VERSION) return
        const step = SCHEMA_STEPS[s.effective]!
        step.up(this.database, ctx)
        this.testHooks?.onSchemaStep?.(step.version)
        // Floors never fall: each is max(old, step), with `old` as SchemaState reads it, so an absent floor
        // is its legacy default (write 2 when `tasks_schema` exists, else 1; read 1) and a slice A file
        // keeps its downgrade marker through a crash after step 1 (HOST0_DESIGN 3.5). A malformed stored
        // value made the file `newer`, so every value here is a decimal.
        upsertMeta(this.database, META_SCHEMA_VERSION, String(Math.max(s.stored ?? 0, step.version)))
        upsertMeta(this.database, META_WRITE_MIN, String(Math.max(s.writeMin, step.writeMin)))
        upsertMeta(this.database, META_READ_MIN, String(Math.max(s.readMin, step.readMin)))
        if (!(readSchemaState(this.database).effective > s.effective)) {
          throw new BoardError(500, 'internal', `schema step ${step.version} did not take effect`)
        }
      })
    }
    const after = readSchemaState(this.database)
    if (!after.newer && after.effective < SCHEMA_VERSION) {
      throw new BoardError(500, 'internal', `schema step ${after.effective + 1} did not take effect`)
    }
  }

  /**
   * Whether the file at the path is not the one `core.instance_file` names (case 1: a new file there), or
   * the .wakeup sidecar is ahead of the database (case 2: rewound in place). The file is read before the
   * database: a writer commits the database before it raises the file, so this order never sees the file
   * ahead of an intact database.
   */
  private restoreEvidence(): boolean {
    const fileGen = this.readFileWakeupGeneration()
    this.testHooks?.betweenWakeupReads?.()
    const dbGen = this.readDbWakeupGeneration()
    const stored = this.metaValue(META_INSTANCE_FILE) ?? ''
    const newFile = this.fileId !== '' && stored !== '' && stored !== this.fileId
    return newFile || fileGen > dbGen
  }

  /**
   * C5 rotation cases 1 and 2, at open. Lock-free unless there is evidence; then one transaction that
   * re-reads the evidence under the lock (another opener may have rotated first) and rotates. The
   * rotation's wakeup raises both generations past the file's, so N simultaneous openers rotate once.
   */
  private maybeRotateInstance(): void {
    if (!this.restoreEvidence()) return
    this.transaction(() => {
      if (this.identity() === null || !this.restoreEvidence()) return
      this.writeNewInstance()
    })
  }

  private writeNewInstance(): void {
    upsertMeta(this.database, META_INSTANCE_ID, this.newId('i_'))
    upsertMeta(this.database, META_INSTANCE_FILE, this.fileId)
    this.emitWakeup('instance')
  }

  private metaValue(key: string): string | undefined {
    const stmt = (this.metaStmt ??= this.database.prepare('SELECT value FROM board_meta WHERE key = ?'))
    return (stmt.get(key) as { value?: string } | undefined)?.value
  }

  /**
   * The per-write fences (C3, C5), in the outermost transaction, under the lock, before the body: a
   * replaced or removed file (whatever the gate, X7), then a write floor raised above this build (gate
   * `'refuse-newer'`). Each refusal is sticky, and its throw rolls back, so nothing reaches the file.
   */
  private checkFencesInTx(): void {
    if (!this.stillOnOpenedFile()) throw this.refuseReplaced()
    if (this.gate === 'refuse-newer') {
      const raw = this.metaValue(META_WRITE_MIN)
      if (raw !== undefined && !(parseDecimal(raw) <= SCHEMA_VERSION)) {
        this.writesRefusedBy = schemaTooNew('write', readSchemaState(this.database))
        throw this.writesRefusedBy
      }
    }
  }

  /**
   * C3: the file's ladder position, read fresh (no lock, no cache). An absent version is the inferred 1 or 2
   * (2 when `tasks_schema` exists); so is a malformed one, and a malformed floor is its legacy default, so
   * every number is a number (never NaN, which JSON writes as null). Either case of malformed adds
   * `malformed: true`; the key is absent otherwise.
   */
  schemaInfo(): SchemaInfo {
    const s = readSchemaState(this.db)
    const inferred = s.tasksSchema !== undefined ? 2 : 1
    const versionMalformed = s.stored !== null && Number.isNaN(s.stored)
    const malformed = versionMalformed || Number.isNaN(s.writeMin) || Number.isNaN(s.readMin)
    return {
      version: s.stored === null || versionMalformed ? inferred : s.stored,
      writeMin: Number.isNaN(s.writeMin) ? inferred : s.writeMin,
      readMin: Number.isNaN(s.readMin) ? 1 : s.readMin,
      build: SCHEMA_VERSION,
      refused: this.writesRefusedBy ? 'writes' : null,
      ...(malformed ? { malformed: true as const } : {}),
    }
  }

  /** C5: `core.board_id` and `core.instance_id` as the file holds them now; null when either is absent. Two primary-key reads, no lock. */
  identity(): BoardIdentity | null {
    this.assertOpen()
    const boardId = this.metaValue(META_BOARD_ID)
    const instanceId = this.metaValue(META_INSTANCE_ID)
    return boardId !== undefined && instanceId !== undefined ? { boardId, instanceId } : null
  }

  /**
   * C5: whether this store still sits on the file at its path, and on the instance `since` names (default
   * `openedIdentity`). Keeps no state, so each consumer can hold its own baseline. `replaced`: the path is
   * gone or names another file (never answered for `:memory:` or inode 0); the host closes and stops
   * (HOST0_DESIGN 6.4). `restored`: the same file under another instance.
   */
  checkIdentity(since: BoardIdentity | null = this.openedIdentity): IdentityCheck {
    this.assertOpen()
    // A `:memory:` board is this connection's alone: nothing can replace or restore it (HOST0_DESIGN 3.7).
    if (this.isMemory) return { status: 'same', identity: this.identity() }
    if (!this.stillOnOpenedFile()) return { status: 'replaced', was: since }
    const identity = this.identity()
    if (identity === null) {
      if (since !== null) throw new BoardError(500, 'internal', 'the board file lost its identity')
      return { status: 'same', identity: null }
    }
    if (since === null || identity.instanceId === since.instanceId) return { status: 'same', identity }
    return { status: 'restored', identity, was: since }
  }

  /**
   * C5: gives this file a new `core.instance_id` (and records its inode), keeping `core.board_id`, in one
   * BEGIN IMMEDIATE that emits one wakeup. Refused like any write.
   *
   * The supported restore procedure (HOST0_DESIGN 3.7): (1) stop every connection to the path, in every
   * process; (2) prepare the copy at another path (`VACUUM INTO`, or open it, `PRAGMA
   * wal_checkpoint(TRUNCATE)` and close) and call `rotateInstanceId()` on it; (3) remove `<path>-wal` and
   * `<path>-shm` (checkpoint a non-empty `-wal` into the old file first, or discard it on purpose); (4)
   * rename the copy over the path, move the old `<path>.jsonl` aside, keep `<path>.wakeup`; (5) open
   * normally. Replacing a WAL board file while any connection holds the path is unsupported and corrupts
   * the replacement; a live restore goes through the SQLite backup API and then this method.
   */
  rotateInstanceId(): BoardIdentity {
    return this.transaction(() => {
      if (this.metaValue(META_BOARD_ID) === undefined) throw new BoardError(500, 'internal', 'the board file has no identity to rotate')
      this.writeNewInstance()
      return this.identity()!
    })
  }

  private readDbWakeupGeneration(): number {
    const row = this.db
      .prepare("SELECT COALESCE(CAST(value AS INTEGER), 0) AS gen FROM board_meta WHERE key = 'wakeup_generation'")
      .get() as { gen?: number } | undefined
    return Number(row?.gen ?? 0)
  }

  /** The generation in the .wakeup file, or 0 when there is none to read. */
  private readFileWakeupGeneration(): number {
    if (!this.wakeupPath) return 0
    try {
      const fd = fs.openSync(this.wakeupPath, 'r')
      try {
        const buf = Buffer.alloc(8)
        return fs.readSync(fd, buf, 0, 8, 0) === 8 ? Number(buf.readBigUInt64LE(0)) : 0
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return 0
    }
  }

  private readInitialWakeupGeneration(): number {
    return Math.max(this.readDbWakeupGeneration(), this.readFileWakeupGeneration())
  }

  /** The highest wakeup generation the database, the .wakeup file, or this connection has seen. */
  private highestWakeupGeneration(): number {
    return Math.max(this.readDbWakeupGeneration(), this.readFileWakeupGeneration(), this.committedWakeupGen)
  }

  /**
   * The 503 every write gets, or null: the file's task index is newer than this build's (`unavailable`,
   * its M2 text), its write floor is above this build (`schema_too_new`), or it was replaced under this
   * store (`unavailable`).
   */
  writeRefusal(): BoardError | null {
    return this.writesRefusedBy
  }

  transaction<T>(fn: () => T): T {
    if (this.closed) {
      throw new BoardError(503, 'unavailable', 'storage is closed')
    }
    const depth = this.txDepth
    const isOuter = depth === 0
    if (isOuter) {
      if (this.writesRefusedBy) throw this.writesRefusedBy
      this.testHooks?.onBeginImmediate?.()
      this.db.exec('BEGIN IMMEDIATE')
      this.rollbackOnly = false
      this.pendingJsonl = []
      this.pendingEvents = []
      this.pendingWakeups = 0
    } else {
      // Outside a transaction a SAVEPOINT would open a new one, which its RELEASE commits: after
      // SQLite has ended the outer one by itself, nothing nested may write.
      if (!this.db.isTransaction || this.rollbackOnly) {
        this.rollbackOnly = true
        throw new BoardError(503, 'unavailable', 'storage ended the transaction before it could commit')
      }
      this.db.exec(`SAVEPOINT sp_${depth}`)
    }

    const savedJsonlLen = this.pendingJsonl.length
    const savedEventsLen = this.pendingEvents.length
    const savedWakeups = this.pendingWakeups

    // Phase 1: the body and the COMMIT (or RELEASE). Any failure here rolls back.
    // The depth counter is restored exactly once, in `finally`, so neither a body
    // failure nor a later sidecar failure can leave it out of step with SQLite.
    let result: T
    let nextGen = 0
    this.txDepth = depth + 1
    try {
      // C3/C5: under the lock, before the body; a refusal rolls back (no frame reaches the file).
      if (isOuter && this.ladderReady) this.checkFencesInTx()
      result = fn()
      if (isThenable(result)) {
        // An async body would have COMMIT come at its first await, and every write after it run
        // outside any transaction, beyond a rollback's reach. Refused, and what it wrote so far
        // rolled back; its own later outcome is no one's to handle now.
        result.then(undefined, () => {})
        throw new TypeError(
          'a transaction body must be synchronous: it returned a promise, so its writes after an await would commit outside the transaction',
        )
      }
      if (isOuter) {
        // SQLite ends a transaction by itself on some failures (SQLITE_FULL, SQLITE_IOERR, ...). A body
        // that caught one and went on would have written outside it: nothing here may commit then.
        if (!this.db.isTransaction || this.rollbackOnly) {
          throw new BoardError(503, 'unavailable', 'storage ended the transaction before it could commit')
        }
        if (this.pendingWakeups > 0) {
          // From the highest generation anyone has seen: the database's, and the .wakeup file's,
          // which is ahead of it when the database was recreated or restored under a kept file. A
          // generation at or below the file's would leave the file as it is and wake no one.
          nextGen = this.highestWakeupGeneration() + this.pendingWakeups
          upsertMeta(this.db, 'wakeup_generation', String(nextGen))
        }
        this.testHooks?.beforeCommit?.()
        this.db.exec('COMMIT')
      } else {
        this.db.exec(`RELEASE SAVEPOINT sp_${depth}`)
      }
    } catch (error) {
      if (isOuter) {
        try {
          if (this.db.isTransaction) this.db.exec('ROLLBACK')
        } catch {
          // Ignore rollback error if already aborted
        }
        this.pendingJsonl = []
        this.pendingEvents = []
        this.pendingWakeups = 0
      } else {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT sp_${depth}; RELEASE SAVEPOINT sp_${depth}`)
        } catch {
          // Its writes could not be undone on their own: even a body that catches this error and
          // goes on must not commit them, so the outermost transaction now only rolls back.
          this.rollbackOnly = true
        }
        this.pendingJsonl.length = savedJsonlLen
        this.pendingEvents.length = savedEventsLen
        this.pendingWakeups = savedWakeups
      }
      throw error
    } finally {
      this.txDepth = depth
    }

    // Phase 2 (outermost only): the write is committed. Post-commit sidecars are
    // best-effort and never fail, unwind, or report as failed a committed write
    // (ARCHITECTURE_V2 section 2, Post-Commit Sidecar Discipline).
    if (isOuter) {
      // Taken before anything below runs, so a hook that writes cannot lose this commit's batches.
      const batch = { jsonl: this.pendingJsonl, events: this.pendingEvents, wakeups: this.pendingWakeups }
      this.pendingJsonl = []
      this.pendingEvents = []
      this.pendingWakeups = 0
      this.trackOwn(batch.events)
      try {
        this.testHooks?.afterCommit?.()
      } catch {
        // A test hook must not fail a committed write either
      }
      this.flushAfterCommit(nextGen, batch)
    }
    return result
  }

  /**
   * Flushes the wakeup file, the .jsonl audit sidecar and in-process listeners
   * after the outermost COMMIT. Each step is isolated: a failing step is
   * reported through `onSidecarError` and never thrown. A .jsonl batch that
   * could not be written is kept and retried, in order, after the next commit.
   */
  private flushAfterCommit(nextGen: number, batch: { jsonl: string[]; events: StoredEvent[]; wakeups: number }): void {
    const jsonlBatch = batch.jsonl
    const eventBatch = batch.events
    const wakeupInc = batch.wakeups

    if (wakeupInc > 0) this.committedWakeupGen = Math.max(this.committedWakeupGen, nextGen)
    // The file only ever rises (writeWakeupFile keeps the larger value), so a generation that
    // could not be written is folded into the next attempt, which a commit with no events makes too.
    const wakeupTarget = Math.max(wakeupInc > 0 ? nextGen : 0, this.unwrittenWakeupGen)
    if (wakeupTarget > 0 && this.wakeupPath) {
      try {
        this.writeWakeupFile(wakeupTarget)
        this.unwrittenWakeupGen = 0
      } catch (error) {
        this.unwrittenWakeupGen = wakeupTarget
        this.reportSidecarError('wakeup', error)
      }
    }
    // Lines that could not be appended before go first, so the file keeps this connection's commit
    // order. Connections (and processes) sharing the database append after their own COMMITs
    // without coordinating, so across them the file is not in log_index order: a reader orders it
    // by each line's `index`, and board_events stays the authority for order. A failed
    // append can leave part of its batch written; the retry writes the whole batch again, so a
    // reader of the .jsonl must take a repeated event id as the same event (board_events is the
    // authority, the .jsonl is its audit copy).
    if (this.jsonlPath && (jsonlBatch.length > 0 || this.unflushedJsonl.length > 0)) {
      const lines = this.unflushedJsonl.concat(jsonlBatch)
      try {
        fs.appendFileSync(this.jsonlPath, lines.join(''), 'utf8')
        this.unflushedJsonl = []
      } catch (error) {
        const keep = lines.slice(-UNFLUSHED_JSONL_MAX)
        this.droppedJsonl += lines.length - keep.length
        this.unflushedJsonl = keep
        this.reportSidecarError('jsonl', error)
      }
    }
    for (const ev of eventBatch) {
      this.fire(ev)
    }
  }

  /** Calls every live listener with `ev`; a throwing one is reported (C2) and never stops the rest. */
  private fire(ev: StoredEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(ev)
      } catch (error) {
        this.reportListenerError(error)
      }
    }
  }

  /** A listener failed: counted apart from `failures`, handed to the hook, never thrown. */
  private reportListenerError(error: unknown): void {
    this.listenerFailures += 1
    this.lastSidecarErrorValue = { step: 'listener', error }
    const hook = this.onSidecarError
    if (!hook) return
    try {
      hook(error, 'listener')
    } catch {
      // A failing error hook must not fail a committed write either
    }
  }

  /** C1 own tracking (outermost commit, after COMMIT): remembers the commit's indices. Cannot throw. */
  private trackOwn(events: readonly StoredEvent[]): void {
    const ext = this.external
    if (!ext) return
    for (const ev of events) {
      if (ev.index <= ext.cursor) continue
      ext.own.add(ev.index)
      if (ext.own.size > OWN_TRACK_MAX) {
        for (const oldest of ext.own) {
          ext.own.delete(oldest)
          break
        }
        ext.dropped += 1
      }
    }
  }

  private reportSidecarError(step: SidecarStep, error: unknown): void {
    this.sidecarFailures += 1
    this.lastSidecarErrorValue = { step, error }
    const hook = this.onSidecarError
    if (!hook) return
    try {
      hook(error, step)
    } catch {
      // A failing error hook must not fail a committed write either
    }
  }

  /** Post-commit sidecar failures since open, and the most recent one. */
  sidecarHealth(): SidecarHealth {
    const unflushedJsonl = this.unflushedJsonl.length
    const ext = this.external
    return {
      failures: this.sidecarFailures,
      unflushedJsonl,
      unwrittenWakeup: this.unwrittenWakeupGen,
      last: this.lastSidecarErrorValue,
      droppedJsonl: this.droppedJsonl,
      listenerFailures: this.listenerFailures,
      degraded: unflushedJsonl > 0 || this.unwrittenWakeupGen > 0 || this.droppedJsonl > 0,
      external: ext
        ? { armed: true, cursor: ext.cursor, tracked: ext.own.size, dropped: ext.dropped, dispatched: ext.dispatched }
        : { armed: false, cursor: 0, tracked: 0, dropped: 0, dispatched: 0 },
    }
  }

  private writeWakeupFile(generation: number): void {
    if (!this.wakeupPath) return
    const targetGen = BigInt(generation)
    const lockPath = `${this.wakeupPath}.lock`
    const start = Date.now()
    const token = wakeupLockToken()
    let lockFd: number | null = null
    while (lockFd === null) {
      try {
        lockFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o644)
        // Who holds it, so a writer that finds it left by a process that has died breaks it at once.
        fs.writeSync(lockFd, token)
      } catch (err) {
        const code = (err as { code?: string } | null)?.code
        if (code !== 'EEXIST') {
          if (lockFd !== null) {
            // Created, but its pid could not be written: it's ours to remove.
            fs.closeSync(lockFd)
            try {
              fs.unlinkSync(lockPath)
            } catch {
              // Left for the next writer to find empty and break
            }
          }
          throw err
        }
        if (staleWakeupLock(lockPath)) {
          try {
            fs.unlinkSync(lockPath)
          } catch {
            // Another writer broke it first
          }
          continue
        }
        if (Date.now() - start > 5000) {
          try {
            const st = fs.statSync(lockPath)
            if (Date.now() - st.mtimeMs > 5000) {
              fs.unlinkSync(lockPath)
              continue
            }
          } catch {
            continue
          }
          throw new BoardError(503, 'unavailable', 'timed out waiting for wakeup lock')
        }
        Atomics.wait(SLEEP_ARRAY, 0, 0, 1)
      }
    }
    try {
      const fd = fs.openSync(this.wakeupPath, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o644)
      try {
        const stat = fs.fstatSync(fd)
        if (stat.size >= 8) {
          const existingBuf = Buffer.allocUnsafe(8)
          fs.readSync(fd, existingBuf, 0, 8, 0)
          const existingGen = existingBuf.readBigUInt64LE(0)
          if (existingGen >= targetGen) {
            this.committedWakeupGen = Math.max(this.committedWakeupGen, Number(existingGen))
            return
          }
        }
        const buf = Buffer.allocUnsafe(8)
        buf.writeBigUInt64LE(targetGen, 0)
        fs.writeSync(fd, buf, 0, 8, 0)
        this.committedWakeupGen = Math.max(this.committedWakeupGen, generation)
      } finally {
        fs.closeSync(fd)
      }
    } finally {
      try {
        fs.closeSync(lockFd)
      } catch {
        // Ignore close error on lockfile
      }
      // Only this hold's own lock: another writer may have broken it and hold its own by now.
      releaseWakeupLock(lockPath, token)
    }
  }

  appendEvent(event: AppendEventInput): StoredEvent {
    return this.transaction(() => this.insertEventInTx(event))
  }

  appendEvents(events: readonly AppendEventInput[]): StoredEvent[] {
    if (events.length === 0) return []
    return this.transaction(() => events.map((event) => this.insertEventInTx(event)))
  }

  private insertEventInTx(event: AppendEventInput): StoredEvent {
    const id = event.id ?? randomUUID()
    const sessionId = event.sessionId ?? 'board'
    const channel = event.channel ?? null
    const thread = event.thread ?? null
    const createdAt = event.createdAt ?? new Date().toISOString()
    const payloadJson = JSON.stringify(event.payload)

    let row: { log_index: number }
    try {
      row = this.db
        .prepare(
          `INSERT INTO board_events (event_id, session_id, type, channel, thread, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING log_index`,
        )
        .get(id, sessionId, event.type, channel, thread, payloadJson, createdAt) as { log_index: number }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('UNIQUE constraint failed') && msg.includes('event_id')) {
        throw duplicateId(`duplicate event id: ${id}`)
      }
      throw error
    }

    const stored: StoredEvent = {
      index: Number(row.log_index),
      id,
      sessionId,
      type: event.type,
      channel,
      thread,
      payload: event.payload,
      createdAt,
    }
    this.pendingJsonl.push(`${JSON.stringify(stored)}\n`)
    this.pendingEvents.push(stored)
    this.pendingWakeups += 1
    return stored
  }

  getHeadIndex(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(log_index), 0) AS head FROM board_events').get() as {
      head: number
    }
    return Number(row.head)
  }

  getEvents(filter: EventFilter = {}): { events: StoredEvent[]; head: number } {
    const head = this.getHeadIndex()
    const where: string[] = []
    const params: (string | number)[] = []

    if (filter.after !== undefined) {
      where.push('log_index > ?')
      params.push(filter.after)
    }
    if (filter.before !== undefined) {
      where.push('log_index < ?')
      params.push(filter.before)
    }
    if (filter.sessionId !== undefined) {
      where.push('session_id = ?')
      params.push(filter.sessionId)
    }
    if (filter.channel !== undefined) {
      where.push(channelSubtreeWhere('channel', filter.channel, filter.subtree, params))
    }
    if (filter.types && filter.types.length > 0) {
      where.push(`type IN (${filter.types.map(() => '?').join(', ')})`)
      params.push(...filter.types)
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 500, 5000))
    params.push(limit)
    const sql = `SELECT log_index, event_id, session_id, type, channel, thread, payload_json, created_at
                 FROM board_events
                 ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY log_index ASC
                 LIMIT ?`
    const rows = this.db.prepare(sql).all(...params) as Array<{
      log_index: number
      event_id: string
      session_id: string
      type: string
      channel: string | null
      thread: string | null
      payload_json: string
      created_at: string
    }>

    return {
      head,
      events: rows.map((row) => ({
        index: Number(row.log_index),
        id: row.event_id,
        sessionId: row.session_id,
        type: row.type,
        channel: row.channel,
        thread: row.thread,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        createdAt: row.created_at,
      })),
    }
  }

  emitWakeup(_reason?: string): number {
    if (this.txDepth > 0) {
      this.pendingWakeups += 1
      return this.highestWakeupGeneration() + this.pendingWakeups
    }
    return this.transaction(() => {
      this.pendingWakeups += 1
      return this.highestWakeupGeneration() + this.pendingWakeups
    })
  }

  getWakeupGeneration(): number {
    if (this.closed) return this.committedWakeupGen
    return Math.max(this.committedWakeupGen, this.readDbWakeupGeneration())
  }

  onEvent(listener: (event: StoredEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private assertNotInTransaction(what: string): void {
    if (this.txDepth > 0) throw new TypeError(`${what} cannot run inside a transaction`)
  }

  armExternalDispatch(): number {
    this.assertOpen()
    this.assertNotInTransaction('armExternalDispatch')
    if (this.external) return this.external.cursor
    const cursor = this.getHeadIndex()
    this.external = { cursor, own: new Set(), dropped: 0, dispatched: 0 }
    return cursor
  }

  disarmExternalDispatch(): void {
    this.external = null
  }

  /** The guards `dispatchExternal` and `pumpExternal` share. */
  private armedOrThrow(what: string): ExternalState {
    this.assertOpen()
    this.assertNotInTransaction(what)
    if (!this.external) throw new TypeError('external dispatch is not armed')
    return this.external
  }

  dispatchExternal(events: readonly StoredEvent[]): ExternalDispatchResult {
    this.armedOrThrow('dispatchExternal')
    this.validatePage(events)
    return this.dispatchPage(events)
  }

  pumpExternal(limit: number = PUMP_PAGE_DEFAULT): ExternalPumpResult {
    const ext = this.armedOrThrow('pumpExternal')
    const n = Math.min(EVENTS_PAGE_MAX, Math.max(1, Math.floor(limit) || PUMP_PAGE_DEFAULT))
    const head = this.getHeadIndex()
    if (head < ext.cursor) {
      throw new BoardError(
        410,
        'cursor_expired',
        'the log is behind the dispatch cursor: the database was replaced or restored; disarm and arm again',
      )
    }
    if (head === ext.cursor) return { dispatched: 0, skippedOwn: 0, skippedSeen: 0, cursor: ext.cursor, more: false }
    const { events } = this.getEvents({ after: ext.cursor, limit: n })
    return { ...this.dispatchPage(events), more: events.length === n }
  }

  /** Whole-page checks (SEC-3): nothing is fired and the cursor stays where it was when one fails. */
  private validatePage(events: readonly StoredEvent[]): void {
    let previous = 0
    for (const ev of events) {
      if (!Number.isSafeInteger(ev.index) || ev.index <= previous) {
        throw new TypeError('dispatchExternal needs events in strictly ascending log_index order')
      }
      previous = ev.index
    }
    if (events.length === 0) return
    const head = this.getHeadIndex()
    if (previous > head) throw new TypeError(`dispatchExternal: event ${previous} is beyond the log head ${head}`)
    const idAt = this.db.prepare('SELECT event_id FROM board_events WHERE log_index = ?')
    for (const ev of events) {
      const row = idAt.get(ev.index) as { event_id?: string } | undefined
      if (row?.event_id !== ev.id) throw new TypeError(`dispatchExternal: event ${ev.index} is not this board's`)
    }
  }

  /** Fires the page's events above the cursor, skipping this store's own commits. No checks: see validatePage. */
  private dispatchPage(events: readonly StoredEvent[]): ExternalDispatchResult {
    const ext = this.external
    if (!ext) throw new TypeError('external dispatch is not armed')
    let dispatched = 0
    let skippedOwn = 0
    let skippedSeen = 0
    for (const ev of events) {
      // A listener that disarmed or re-armed ended this page's dispatch.
      if (this.external !== ext) break
      if (ev.index <= ext.cursor) {
        skippedSeen += 1
        continue
      }
      // Before any listener runs, so a re-entrant pump never repeats the event.
      ext.cursor = ev.index
      if (ext.own.delete(ev.index)) {
        skippedOwn += 1
        continue
      }
      this.fire(ev)
      dispatched += 1
      ext.dispatched += 1
    }
    // Own indices are added in ascending order, so the stale ones are the first.
    for (const index of ext.own) {
      if (index > ext.cursor) break
      ext.own.delete(index)
    }
    return { dispatched, skippedOwn, skippedSeen, cursor: ext.cursor }
  }

  getMeta(key: string): string | undefined {
    const db = this.db
    if (!META_READABLE_KEY.test(key) && !META_READABLE_LEGACY.has(key)) {
      throw new TypeError(`getMeta: key outside the meta namespaces: ${key}`)
    }
    const row = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value
  }

  casMeta(key: string, expected: string | undefined, next: string): boolean {
    if (!META_WRITABLE_KEY.test(key) || RESERVED_META_KEYS.has(key)) {
      throw new TypeError(`casMeta: key outside the writable meta namespaces (host.*, fed.*): ${key}`)
    }
    if (expected !== undefined && typeof expected !== 'string') throw new TypeError('casMeta: expected must be a string or undefined')
    if (typeof next !== 'string') throw new TypeError('casMeta: next must be a string')
    if (Buffer.byteLength(next, 'utf8') > META_VALUE_MAX_BYTES) {
      throw new TypeError(`casMeta: value over ${META_VALUE_MAX_BYTES} bytes`)
    }
    return this.transaction(() => {
      const row = this.db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value?: string } | undefined
      if (row?.value !== expected) return false
      upsertMeta(this.db, key, next)
      return true
    })
  }

  /**
   * Compares the .jsonl audit copy with board_events (C2, class only; takes no write lock). It reports
   * what the file holds and lacks; with `repair` it first retries this store's held lines, then
   * appends the missing events, in index order, never rewriting existing bytes. The counts of a repair
   * are those found before it, plus `repaired`. A repair clears `droppedJsonl`.
   */
  auditJsonl(options: { repair?: boolean } = {}): JsonlAudit {
    this.assertOpen()
    this.assertNotInTransaction('auditJsonl')
    // X8: once the path names another file, this connection's log and the path's .jsonl are two boards'.
    if (this.replacedBy) throw this.replacedBy
    if (!this.stillOnOpenedFile()) throw this.refuseReplaced()
    const path = this.jsonlPath
    const empty: JsonlAudit = {
      path,
      head: 0,
      lines: 0,
      present: 0,
      missing: 0,
      firstMissing: null,
      duplicates: 0,
      conflicts: 0,
      beyondHead: 0,
      malformed: 0,
      inversions: 0,
      tornTail: false,
      repaired: 0,
    }
    if (!path) return { ...empty, path: null }
    const repair = options.repair === true
    if (repair && this.unflushedJsonl.length > 0) {
      fs.appendFileSync(path, this.unflushedJsonl.join(''), 'utf8')
      this.unflushedJsonl = []
    }
    const head = this.getHeadIndex()
    const idAt = this.db.prepare('SELECT event_id FROM board_events WHERE log_index = ?')
    const scan = scanJsonl(path, head, (index) => (idAt.get(index) as { event_id?: string } | undefined)?.event_id)
    const headEnd = this.getHeadIndex()
    const missing: number[] = []
    for (let i = 1; i <= head; i++) if (scan.seen[i] === 0) missing.push(i)
    let repaired = 0
    if (repair) {
      let first = true
      const select = (n: number): ReturnType<DatabaseSync['prepare']> =>
        this.db.prepare(
          `SELECT log_index, event_id, session_id, type, channel, thread, payload_json, created_at
           FROM board_events WHERE log_index IN (${Array.from({ length: n }, () => '?').join(', ')}) ORDER BY log_index ASC`,
        )
      for (let at = 0; at < missing.length; at += 500) {
        const slice = missing.slice(at, at + 500)
        const rows = select(slice.length).all(...slice) as Array<{
          log_index: number
          event_id: string
          session_id: string
          type: string
          channel: string | null
          thread: string | null
          payload_json: string
          created_at: string
        }>
        let text = rows
          .map((row) => {
            const stored: StoredEvent = {
              index: Number(row.log_index),
              id: row.event_id,
              sessionId: row.session_id,
              type: row.type,
              channel: row.channel,
              thread: row.thread,
              payload: JSON.parse(row.payload_json) as Record<string, unknown>,
              createdAt: row.created_at,
            }
            return `${JSON.stringify(stored)}\n`
          })
          .join('')
        if (first && scan.size > 0 && !scan.endsWithNewline) text = `\n${text}`
        first = false
        fs.appendFileSync(path, text, 'utf8')
        repaired += rows.length
      }
      this.droppedJsonl = 0
    }
    return {
      path,
      head,
      lines: scan.lines,
      present: scan.present,
      missing: missing.length,
      firstMissing: missing[0] ?? null,
      duplicates: scan.duplicates,
      conflicts: scan.conflicts,
      beyondHead: scan.setAside.filter((index) => index > headEnd).length,
      malformed: scan.malformed,
      inversions: scan.inversions,
      tornTail: scan.tornTail,
      repaired,
    }
  }

  /** Throws the typed 503 a closed store answers, before anything else is looked at. */
  private assertOpen(): void {
    if (this.closed) throw new BoardError(503, 'unavailable', 'storage is closed')
  }

  /**
   * The first `limit` rows of `stmt` that `keep` takes, as hits: it reads `batchSize` rows at a
   * time, so a filter that drops many still fills the page, and stops at the end of the results.
   * `stmt` takes `params`, then LIMIT and OFFSET.
   */
  private collectHits<Row>(
    stmt: ReturnType<DatabaseSync['prepare']>,
    params: readonly (string | number)[],
    limit: number,
    batchSize: number,
    toHit: (row: Row) => FtsSearchHit,
    keep: ((hit: FtsSearchHit) => boolean) | undefined,
  ): FtsSearchHit[] {
    const collected: FtsSearchHit[] = []
    for (let offset = 0; collected.length < limit; ) {
      const rows = stmt.all(...params, batchSize, offset) as Row[]
      for (const row of rows) {
        const hit = toHit(row)
        if (keep && !keep(hit)) continue
        collected.push(hit)
        if (collected.length >= limit) break
      }
      if (rows.length < batchSize) break
      offset += rows.length
    }
    return collected
  }

  ftsSearch(query: FtsSearchQuery): FtsSearchHit[] {
    this.assertOpen()
    const raw = query.query.trim()
    if (!raw || hasEmptyFtsPhrase(raw)) {
      throw badRequest('search query must not be empty', 'invalid_fts_query')
    }
    const scope = query.scope ?? 'all'
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200))
    const filterFn = query.filter
    const batchSize = filterFn ? Math.max(limit * 4, 100) : limit
    const hits: FtsSearchHit[] = []

    try {
      if (scope === 'all' || scope === 'messages') {
        const params: (string | number)[] = [raw]
        const where: string[] = ['fts_messages MATCH ?', 'm.deleted = 0']
        if (query.channel !== undefined) {
          where.push(channelSubtreeWhere('m.channel', query.channel, query.subtree, params))
        }
        labelWhere(query.labels, where, params)
        const stmt = this.db.prepare(
          `SELECT m.id, m.channel, m.thread, m.created_at,
                  snippet(fts_messages, 3, '[', ']', '...', 16) AS snippet,
                  bm25(fts_messages) AS score
           FROM fts_messages
           JOIN board_messages m ON m.id = CAST(fts_messages.message_id AS INTEGER)
           WHERE ${where.join(' AND ')}
           ORDER BY score ASC, m.id DESC
           LIMIT ? OFFSET ?`,
        )
        type Row = { id: number; channel: string; thread: string; created_at: number; snippet: string; score: number }
        hits.push(
          ...this.collectHits<Row>(stmt, params, limit, batchSize, (r) => ({
            kind: 'message',
            id: String(r.id),
            channel: r.channel,
            thread: r.thread,
            title: null,
            snippet: r.snippet,
            score: Number(r.score),
            createdAt: new Date(r.created_at).toISOString(),
          }), filterFn),
        )
      }

      if (scope === 'all' || scope === 'tasks') {
        const params: (string | number)[] = [raw]
        const where: string[] = ['fts_tasks MATCH ?', '(m.id IS NULL OR m.deleted = 0)']
        if (query.channel !== undefined) {
          where.push(channelSubtreeWhere('fts_tasks.channel', query.channel, query.subtree, params))
        }
        // A task carries the labels of the message it is (its thread's root's too, as a reply's do).
        labelWhere(query.labels, where, params)
        const stmt = this.db.prepare(
          `SELECT fts_tasks.task_id, fts_tasks.channel, COALESCE(bt.state, fts_tasks.state) AS state,
                  m.thread, m.created_at,
                  snippet(fts_tasks, 3, '[', ']', '...', 16) AS snippet,
                  bm25(fts_tasks) AS score
           FROM fts_tasks
           LEFT JOIN board_messages m ON m.id = CAST(fts_tasks.task_id AS INTEGER)
           LEFT JOIN board_tasks bt ON bt.task_id = CAST(fts_tasks.task_id AS INTEGER)
           WHERE ${where.join(' AND ')}
           ORDER BY score ASC, fts_tasks.task_id DESC
           LIMIT ? OFFSET ?`,
        )
        type Row = {
          task_id: string
          channel: string
          state: string
          thread: string | null
          created_at: number | null
          snippet: string
          score: number
        }
        hits.push(
          ...this.collectHits<Row>(stmt, params, limit, batchSize, (r) => ({
            kind: 'task',
            id: String(r.task_id),
            channel: r.channel,
            thread: r.thread ?? String(r.task_id),
            title: null,
            snippet: r.snippet,
            score: Number(r.score),
            createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date(0).toISOString(),
            metadata: { state: r.state },
          }), filterFn),
        )
      }

      // Knowledge entries carry no labels, so a search filtered by label finds none of them.
      if ((scope === 'all' || scope === 'knowledge') && !(query.labels && query.labels.length > 0)) {
        const params: (string | number)[] = [raw]
        const where: string[] = ['fts_knowledge MATCH ?', '(k.id IS NULL OR k.valid = 1)']
        if (query.channel !== undefined) {
          where.push(channelSubtreeWhere('fts_knowledge.channel', query.channel, query.subtree, params))
        }
        if (query.deptId !== undefined) {
          params.push(query.deptId)
          where.push('fts_knowledge.dept_id = ?')
        }
        const stmt = this.db.prepare(
          `SELECT fts_knowledge.entry_id, fts_knowledge.channel, fts_knowledge.dept_id,
                  fts_knowledge.title,
                  COALESCE(k.created_at, '') AS created_at,
                  snippet(fts_knowledge, 4, '[', ']', '...', 16) AS snippet,
                  bm25(fts_knowledge) AS score
           FROM fts_knowledge
           LEFT JOIN knowledge_entries k ON k.id = fts_knowledge.entry_id
           WHERE ${where.join(' AND ')}
           ORDER BY score ASC, fts_knowledge.entry_id ASC
           LIMIT ? OFFSET ?`,
        )
        type Row = {
          entry_id: string
          channel: string
          dept_id: string | null
          title: string
          created_at: string
          snippet: string
          score: number
        }
        hits.push(
          ...this.collectHits<Row>(stmt, params, limit, batchSize, (r) => ({
            kind: 'knowledge',
            id: r.entry_id,
            channel: r.channel || null,
            thread: null,
            title: r.title,
            snippet: r.snippet,
            score: Number(r.score),
            createdAt: r.created_at || new Date(0).toISOString(),
            ...(r.dept_id ? { metadata: { deptId: r.dept_id } } : {}),
          }), filterFn),
        )
      }
    } catch (error) {
      if (isFtsSyntaxError(error)) {
        throw badRequest(
          `invalid FTS5 query: ${error instanceof Error ? error.message : String(error)}`,
          'invalid_fts_query',
        )
      }
      throw error
    }

    return hits.sort((a, b) => a.score - b.score).slice(0, limit)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.external = null
    this.listeners.clear()
    this.database.close()
  }
}
