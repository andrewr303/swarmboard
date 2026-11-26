// SharedFileTransport (Mode 1, HOST123_DESIGN 3, 5.3-5.5, 6.6, 7.1-7.5): shared-file board transport with a
// process-level store registry, per-identity FIFO write lanes, async full-jitter busy retry, and injected FileHost
// lifecycle hooks for wake-bridge and tick integration.
//
// Thick client module: imports only ../core/public.ts, other client modules, and node built-ins.
import { createHash } from 'node:crypto'
import * as nodePath from 'node:path'
import {
  BoardService,
  LEASE_CAP_S,
  LEASE_DEFAULT_S,
  LEASE_MIN_S,
  SqliteUnifiedStore,
  TASK_BATCH_MAX,
  type BoardIdentity,
  type BoardServiceOptions,
  type EventsPage,
  type SqliteStoreOptions,
} from '../core/public.ts'
import {
  isRetryableBusy,
  isStoreClosedError,
  LONG_LIVED_BUSY_TIMEOUT_MS,
  replacedError,
  setBusyTimeout,
  withBusyRetry,
} from './busy.ts'
import {
  createBoardWatch,
  eventsFeed,
  guardFor,
  linkSignals,
  prepareCall,
  runPrepared,
  type BoardWatch,
  type DispatchContext,
} from './dispatch.ts'
import { clientError, isBoardError, type BoardErrorLike } from './errors.ts'
import type { KeyBodyGuard } from './idempotency.ts'
import type { IdentityProvider } from './identity.ts'
import { Lanes } from './lanes.ts'
import { normalizeThrown } from './normalize.ts'
import { isOpName, laneKind, OP_NAMES, type OpInput, type OpName, type OpOutput } from './ops.ts'
import { nodeResolverFs, type ExplainStep } from './resolve.ts'
import { DEFAULT_BUSY_RETRY } from './retry.ts'
import { baseCapabilities } from './transport-inproc.ts'
import type { BoardTransport, CallOptions, Capabilities, EventsFeedQuery } from './types.ts'
import { CLIENT_VERSION, PROTOCOL_VERSION } from './version.ts'

/** Implemented by the host composition layer (createFileHost). Declared here so the client layer stays decoupled. */
export interface FileHost {
  /** Opens or creates the board file under the layout rules (guard, 0700/0600, manifest). Synchronous; throws BoardErrorLike. */
  open(
    path: string,
    storeOptions?: Pick<SqliteStoreOptions, 'testHooks'>,
  ): { readonly store: SqliteUnifiedStore; readonly warnings: readonly ExplainStep[] }
  /** Builds (does not start) the WakeBridge for this store. No I/O. */
  attach(store: SqliteUnifiedStore): FileHostAttachment
}

export interface FileHostAttachment {
  /** The bridge's current mode. */
  readonly wake: 'fs-watch' | 'poll'
  readonly safetyPollMs: number
  /** True once bindBoard started a Ticker (and while it is running). */
  readonly ticking: boolean
  /** Spread into BoardServiceOptions (frozen): {eventsWaitPollMs: safetyPollMs, tasks: {wake, armedSafetyPollMs}}. */
  serviceOptions(): Readonly<Pick<BoardServiceOptions, 'eventsWaitPollMs' | 'tasks'>>
  /** Starts the bridge, then the Ticker per config. Called once, after the BoardService exists. */
  bindBoard(board: BoardService): void
  onReset(
    listener: (reset: {
      readonly epoch: number
      readonly reason: 'restored' | 'rewound'
      readonly identity: BoardIdentity | null
      readonly cursor: number
    }) => void,
  ): () => void
  onStop(
    listener: (stop: {
      readonly reason: 'replaced' | 'closed' | 'stopped'
      readonly error: BoardErrorLike | null
    }) => void,
  ): () => void
  /** For doctor: bridge and ticker status as plain data (ids, counts, codes; never a caller). */
  status(): Readonly<Record<string, unknown>>
  /** ticker.stop() (releases the lease) then bridge.stop(). Idempotent. NEVER closes the store. */
  close(): Promise<void>
}

export interface SharedFileTransportOptions {
  /** Absolute path to board.db, never ':memory:' (TypeError). */
  readonly path: string
  readonly identity: IdentityProvider
  /** Omitted = degraded ("bare") mode: no guard, no manifest, no bridge, no tick. */
  readonly host?: FileHost
  /** After open; default LONG_LIVED_BUSY_TIMEOUT_MS (50); integer 0..5000. */
  readonly busyTimeoutMs?: number
  /** Default 30_000; integer 0..300_000. */
  readonly busyBudgetMs?: number
  /** Writes one identity may have queued behind the running write; default 64. */
  readonly laneMax?: number
  /** Operational log: one record per call, never inputs, outputs, keys, ids or tokens. */
  readonly log?: (record: TransportLogRecord) => void
  /** TEST ONLY: store options used when this instance opens the store. */
  readonly testStoreOptions?: Pick<SqliteStoreOptions, 'testHooks'>
}

export interface TransportLogRecord {
  readonly op: OpName
  /** sha256(principal + '\u001f' + profile) first 12 hex. */
  readonly lane: string
  readonly attempts: number
  readonly ms: number
  readonly outcome: 'ok' | 'error'
  readonly status?: number
  readonly code?: string
}

export interface TransportStats {
  readonly calls: number
  readonly attempts: number
  readonly busyRetries: number
  readonly busyGiveUps: number
}

const DEFAULT_BUSY_BUDGET_MS = DEFAULT_BUSY_RETRY.budgetMs
const MAX_BUSY_TIMEOUT_MS = 5_000
const MAX_BUSY_BUDGET_MS = 300_000
const DEFAULT_LANE_MAX = 64

const OS_USER = Object.freeze(['os-user'] as const)
const NONE = Object.freeze([] as const)

const PRE_READY_CAPABILITIES: Capabilities = Object.freeze({
  protocol: PROTOCOL_VERSION,
  mode: 'shared-file',
  transport: 'direct',
  coreVersion: CLIENT_VERSION,
  schemaVersion: 0,
  schemaBuild: 0,
  writable: false,
  boardId: null,
  instanceId: null,
  wake: 'poll',
  crossProcessWake: true,
  wakePollMs: 100,
  maxWaitS: 300,
  leaseMinS: LEASE_MIN_S,
  leaseCapS: LEASE_CAP_S,
  leaseDefaultS: LEASE_DEFAULT_S,
  batchMax: TASK_BATCH_MAX,
  schedules: 'none',
  auth: OS_USER,
  assurances: NONE,
  conditionalNeeds: false,
  priorityNative: false,
  defer: false,
  resume: false,
  subtreeRead: true,
  ops: OP_NAMES,
})

function isWin32Path(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(p)
}

function isAbsoluteBoardPath(p: string): boolean {
  if (isWin32Path(p)) return nodePath.win32.isAbsolute(p)
  return nodePath.posix.isAbsolute(p)
}

/** Canonical registry key: realpathish(dir) + sep + basename (HOST123_DESIGN 6.6). */
function boardKeyFor(path: string): string {
  const P = isWin32Path(path) ? nodePath.win32 : nodePath.posix
  const dir = P.dirname(path)
  const base = P.basename(path)
  const realDir = nodeResolverFs.realpathish(dir)
  return realDir.endsWith(P.sep) ? `${realDir}${base}` : `${realDir}${P.sep}${base}`
}

function hashLane(lane: string): string {
  return createHash('sha256').update(lane).digest('hex').slice(0, 12)
}

function checkIntOption(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}: ${String(value)}`)
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}: ${String(value)}`)
  }
  return value
}

// ---------------------------------------------------------------------------------------------------------------
// Process-level board registry (one store, BoardService, BoardWatch, Lanes, KeyBodyGuard, attachment per board key)

interface OpenedEntry {
  readonly key: string
  readonly path: string
  readonly store: SqliteUnifiedStore
  readonly board: BoardService
  readonly attachment: FileHostAttachment | null
  readonly watch: BoardWatch
  readonly lanes: Lanes
  readonly guard: KeyBodyGuard
  readonly warnings: readonly ExplainStep[]
  readonly unsubReset: (() => void) | null
  readonly unsubStop: (() => void) | null
  readonly unsubWatchStop: (() => void) | null
  readonly transports: Set<SharedFileTransport>
  refs: number
  state: 'open' | 'stopped'
  stoppedBy: BoardErrorLike | null
  stopPromise: Promise<void> | null
}

interface PendingOpen {
  promise: Promise<OpenedEntry>
  readonly abort: AbortController
  readonly liveWaiters: Set<SharedFileTransport>
  pendingCleanup: number
}

const registry = new Map<string, OpenedEntry>()
const pendingOpens = new Map<string, PendingOpen>()
const pendingCloses = new Map<string, Promise<void>>()

/** Stops an opened entry on `replaced`, poisons its key for this process, and closes attachment before store. */
function stopEntry(entry: OpenedEntry, error: BoardErrorLike): Promise<void> {
  if (entry.stopPromise !== null) return entry.stopPromise
  entry.state = 'stopped'
  entry.stoppedBy = error
  // Ensure watch is stopped so watch.stopSignal aborts every in-flight wait on every transport sharing this board.
  entry.watch.stop(error)
  entry.lanes.rejectAll(error)
  entry.stopPromise = (async () => {
    entry.unsubReset?.()
    entry.unsubStop?.()
    entry.unsubWatchStop?.()
    if (entry.attachment !== null) {
      try {
        await entry.attachment.close()
      } catch {
        // best-effort attachment teardown
      }
    }
    try {
      entry.store.close()
    } catch {
      // idempotent; harmless when the bridge already closed the store
    }
  })()
  return entry.stopPromise
}

/** Closes an unpoisoned entry whose refcount dropped to 0, always closing attachment before store. */
function teardownOpenEntry(entry: OpenedEntry): Promise<void> {
  if (entry.state === 'stopped') {
    return entry.stopPromise ?? Promise.resolve()
  }
  const existing = pendingCloses.get(entry.key)
  if (existing !== undefined) return existing
  if (registry.get(entry.key) === entry) {
    registry.delete(entry.key)
  }
  const p = (async () => {
    entry.unsubReset?.()
    entry.unsubStop?.()
    entry.unsubWatchStop?.()
    if (entry.attachment !== null) {
      try {
        await entry.attachment.close()
      } catch {
        // best-effort attachment teardown
      }
    }
    try {
      entry.store.close()
    } catch {
      // already closed
    }
  })().finally(() => {
    if (pendingCloses.get(entry.key) === p) {
      pendingCloses.delete(entry.key)
    }
  })
  pendingCloses.set(entry.key, p)
  return p
}

/** TEST ONLY: the process registry. */
export function openedBoards(): ReadonlyArray<{
  readonly key: string
  readonly refs: number
  readonly state: 'open' | 'stopped'
}> {
  const out: Array<{ readonly key: string; readonly refs: number; readonly state: 'open' | 'stopped' }> = []
  for (const entry of registry.values()) {
    out.push(Object.freeze({ key: entry.key, refs: entry.refs, state: entry.state }))
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// SharedFileTransport

export class SharedFileTransport implements BoardTransport {
  readonly #path: string
  readonly #identity: IdentityProvider
  readonly #host: FileHost | undefined
  readonly #busyTimeoutMs: number
  readonly #busyBudgetMs: number
  readonly #laneMax: number
  readonly #log: ((record: TransportLogRecord) => void) | undefined
  readonly #testStoreOptions: Pick<SqliteStoreOptions, 'testHooks'> | undefined

  readonly #close = new AbortController()
  readonly #inFlightWrites = new Set<Promise<unknown>>()

  #closed = false
  #entry: OpenedEntry | null = null
  #readyPromise: Promise<Capabilities> | null = null
  #closePromise: Promise<void> | null = null

  #caps: Capabilities = PRE_READY_CAPABILITIES
  #capsEntry: OpenedEntry | null = null
  #capsEpoch = -1
  #capsWake: 'fs-watch' | 'poll' | null = null
  #capsTicking: boolean | null = null

  #calls = 0
  #attempts = 0
  #busyRetries = 0
  #busyGiveUps = 0

  constructor(options: SharedFileTransportOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('SharedFileTransport requires an options object')
    }
    if (typeof options.path !== 'string' || options.path === '' || options.path === ':memory:' || !isAbsoluteBoardPath(options.path)) {
      throw new TypeError(`SharedFileTransport path must be an absolute file path (never ':memory:'): ${String(options.path)}`)
    }
    if (options.identity === undefined || options.identity === null) {
      throw new TypeError('SharedFileTransport requires an identity provider')
    }
    this.#path = options.path
    this.#identity = options.identity
    this.#host = options.host
    this.#busyTimeoutMs = checkIntOption('busyTimeoutMs', options.busyTimeoutMs, LONG_LIVED_BUSY_TIMEOUT_MS, 0, MAX_BUSY_TIMEOUT_MS)
    this.#busyBudgetMs = checkIntOption('busyBudgetMs', options.busyBudgetMs, DEFAULT_BUSY_BUDGET_MS, 0, MAX_BUSY_BUDGET_MS)
    this.#laneMax = checkIntOption('laneMax', options.laneMax, DEFAULT_LANE_MAX, 0, 10_000)
    this.#log = options.log
    this.#testStoreOptions = options.testStoreOptions
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Layout / FileHost warnings observed when the shared board opened (empty before ready()). */
  get warnings(): readonly ExplainStep[] {
    return this.#entry?.warnings ?? []
  }

  /** Current frozen capability snapshot; replaced on ready(), restore, or attachment wake/tick state change. */
  get capabilities(): Capabilities {
    const entry = this.#entry
    if (entry === null || this.#closed || entry.state === 'stopped') return this.#caps
    const wake: 'fs-watch' | 'poll' = entry.attachment !== null ? entry.attachment.wake : 'poll'
    const ticking = entry.attachment !== null ? entry.attachment.ticking : false
    const epoch = entry.watch.epoch
    if (
      this.#capsEntry === entry &&
      this.#capsEpoch === epoch &&
      this.#capsWake === wake &&
      this.#capsTicking === ticking
    ) {
      return this.#caps
    }
    let info: ReturnType<BoardService['boardInfo']>
    let nextCaps: Capabilities
    try {
      info = entry.board.boardInfo()
      const wakePollMs = entry.attachment !== null ? entry.attachment.safetyPollMs : 100
      nextCaps = baseCapabilities(entry.board, {
        mode: 'shared-file',
        transport: 'direct',
        wake,
        crossProcessWake: true,
        wakePollMs,
        schedules: ticking ? 'tick-lease' : 'none',
        boardId: entry.watch.baseline?.boardId ?? info.boardId,
        instanceId: entry.watch.baseline?.instanceId ?? info.instanceId,
      })
    } catch (error) {
      if (isStoreClosedError(error)) return this.#caps
      throw error
    }
    this.#caps = nextCaps
    this.#capsEntry = entry
    this.#capsEpoch = epoch
    this.#capsWake = wake
    this.#capsTicking = ticking
    return this.#caps
  }

  stats(): TransportStats {
    return Object.freeze({
      calls: this.#calls,
      attempts: this.#attempts,
      busyRetries: this.#busyRetries,
      busyGiveUps: this.#busyGiveUps,
    })
  }

  /** Opens or joins this process's store for the board. Idempotent; concurrent calls share one promise. */
  ready(): Promise<Capabilities> {
    if (this.#closed) {
      return Promise.reject(clientError('unavailable', 'this transport is closed', { hint: 'open a new client' }))
    }
    if (this.#entry !== null) {
      if (this.#entry.state === 'stopped' && this.#entry.stoppedBy !== null) {
        return Promise.reject(this.#entry.stoppedBy)
      }
      return Promise.resolve(this.capabilities)
    }
    if (this.#readyPromise !== null) {
      return this.#readyPromise
    }
    const p = this.#doReady().finally(() => {
      if (this.#readyPromise === p) {
        this.#readyPromise = null
      }
    })
    this.#readyPromise = p
    return p
  }

  async #doReady(): Promise<Capabilities> {
    const key = boardKeyFor(this.#path)

    // Wait for any in-progress teardown on the same key before checking or opening.
    const closing = pendingCloses.get(key)
    if (closing !== undefined) {
      await closing
    }
    if (this.#closed) {
      throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
    }

    const existing = registry.get(key)
    if (existing !== undefined) {
      if (existing.state === 'stopped') {
        throw existing.stoppedBy ?? replacedError(existing.path)
      }
      this.#attachEntry(existing)
      return this.capabilities
    }

    let pending = pendingOpens.get(key)
    if (pending === undefined) {
      const abort = new AbortController()
      const created: PendingOpen = {
        promise: null!,
        abort,
        liveWaiters: new Set(),
        pendingCleanup: 0,
      }
      const openPromise = this.#openNewEntry(key, abort.signal).finally(() => {
        if (pendingOpens.get(key) === created) {
          pendingOpens.delete(key)
        }
      })
      created.promise = openPromise
      pending = created
      pendingOpens.set(key, pending)
    }

    const activePending = pending
    activePending.liveWaiters.add(this)
    activePending.pendingCleanup += 1

    let rejectOnClose: ((err: unknown) => void) | null = null
    const closedRace = new Promise<never>((_res, rej) => {
      rejectOnClose = rej
    })
    // Prevent unhandled rejection if closedRace rejects after promise wins.
    closedRace.catch(() => {})

    const onMyClose = (): void => {
      activePending.liveWaiters.delete(this)
      if (activePending.liveWaiters.size === 0 && !activePending.abort.signal.aborted) {
        activePending.abort.abort(clientError('unavailable', 'this transport is closed', { hint: 'open a new client' }))
      }
      rejectOnClose?.(clientError('unavailable', 'this transport is closed', { hint: 'open a new client' }))
    }

    if (this.#close.signal.aborted) {
      onMyClose()
    } else {
      this.#close.signal.addEventListener('abort', onMyClose, { once: true })
    }

    let entry: OpenedEntry | null = null
    try {
      entry = await Promise.race([activePending.promise, closedRace])
    } catch (error) {
      this.#close.signal.removeEventListener('abort', onMyClose)
      activePending.liveWaiters.delete(this)
      // If we rejected locally due to close() while openNewEntry is still resolving for siblings (or racing with
      // resolution), ensure teardown runs once openNewEntry settles if 0 live refs remain.
      void activePending.promise.then(
        async (resolved) => {
          activePending.pendingCleanup -= 1
          if (activePending.pendingCleanup === 0 && resolved.refs === 0 && resolved.state === 'open') {
            await teardownOpenEntry(resolved)
          }
        },
        () => {
          activePending.pendingCleanup -= 1
        },
      )
      throw normalizeThrown(error)
    }

    this.#close.signal.removeEventListener('abort', onMyClose)
    activePending.liveWaiters.delete(this)

    try {
      if (this.#closed) {
        throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
      }
      if (entry.state === 'stopped') {
        throw entry.stoppedBy ?? replacedError(entry.path)
      }
      this.#attachEntry(entry)
      return this.capabilities
    } finally {
      activePending.pendingCleanup -= 1
      if (activePending.pendingCleanup === 0 && entry.refs === 0 && entry.state === 'open') {
        await teardownOpenEntry(entry)
      }
    }
  }

  #attachEntry(entry: OpenedEntry): void {
    if (this.#entry === entry) return
    this.#entry = entry
    if (!entry.transports.has(this)) {
      entry.transports.add(this)
      entry.refs += 1
    }
  }

  async #openNewEntry(key: string, openSignal: AbortSignal): Promise<OpenedEntry> {
    try {
      return await withBusyRetry(
        async () => {
          if (openSignal.aborted) {
            throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
          }
          // Re-check poisoning between retry attempts.
          const cur = registry.get(key)
          if (cur !== undefined) {
            if (cur.state === 'stopped') {
              throw cur.stoppedBy ?? replacedError(cur.path)
            }
            return cur
          }

          // (1) Open store under default 5,000 ms busy_timeout (ladder & seed run under 5,000 ms).
          let store: SqliteUnifiedStore
          let warnings: readonly ExplainStep[]
          if (this.#host !== undefined) {
            const opened = this.#host.open(this.#path, this.#testStoreOptions)
            store = opened.store
            warnings = opened.warnings
          } else {
            const testHooks = this.#testStoreOptions?.testHooks
            store = new SqliteUnifiedStore({
              path: this.#path,
              ...(testHooks !== undefined ? { testHooks } : {}),
            })
            warnings = []
          }

          let attachment: FileHostAttachment | null = null
          try {
            // (2) Attach WakeBridge (not yet started).
            attachment = this.#host !== undefined ? this.#host.attach(store) : null
            // (3) Construct BoardService with attachment's exact serviceOptions() object, or {} when bare.
            const serviceOpts = attachment !== null ? attachment.serviceOptions() : {}
            const board = new BoardService(store, serviceOpts)
            // (4) Lower busy_timeout for long-lived async retry.
            setBusyTimeout(store, this.#busyTimeoutMs)
            // (5) Start bridge and optional Ticker.
            attachment?.bindBoard(board)
            // (6) Wire BoardWatch, reset/stop handlers, Lanes, KeyBodyGuard, and register.
            const watch = createBoardWatch(store)
            const lanes = new Lanes({ max: this.#laneMax })
            const guard = guardFor(board)
            let entryRef: OpenedEntry | null = null

            const unsubReset =
              attachment !== null
                ? attachment.onReset((r) => {
                    watch.reset(r.reason, r.identity)
                  })
                : null

            const unsubStop =
              attachment !== null
                ? attachment.onStop((s) => {
                    if (s.reason === 'replaced') {
                      watch.stop(s.error ?? replacedError(store.path))
                    }
                  })
                : null

            const unsubWatchStop = watch.onStop((err) => {
              if (entryRef !== null) {
                void stopEntry(entryRef, err)
              }
            })

            const entry: OpenedEntry = {
              key,
              path: store.path,
              store,
              board,
              attachment,
              watch,
              lanes,
              guard,
              warnings: Object.freeze([...warnings]),
              unsubReset,
              unsubStop,
              unsubWatchStop,
              transports: new Set(),
              refs: 0,
              state: 'open',
              stoppedBy: null,
              stopPromise: null,
            }
            entryRef = entry
            registry.set(key, entry)
            // Handle the rare case where attachment already fired replaced during bindBoard.
            if (watch.stopped !== null) {
              void stopEntry(entry, watch.stopped)
            }
            return entry
          } catch (error) {
            if (attachment !== null) {
              try {
                await attachment.close()
              } catch {
                // best-effort cleanup
              }
            }
            try {
              store.close()
            } catch {
              // already closed
            }
            throw normalizeThrown(error)
          }
        },
        {
          policy: { budgetMs: this.#busyBudgetMs },
          signal: openSignal,
        },
      )
    } catch (error) {
      if (openSignal.aborted) {
        throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
      }
      throw normalizeThrown(error)
    }
  }

  call<O extends OpName>(op: O, input: OpInput<O>, opts?: CallOptions): Promise<OpOutput<O>> {
    return this.#call(op, input, opts) as Promise<OpOutput<O>>
  }

  async #call(op: string, input: unknown, opts: CallOptions | undefined): Promise<unknown> {
    // Pre-ready refusals (HS-162: unknown op rejects 501 without opening/creating board.db).
    if (this.#closed) {
      throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
    }
    if (typeof op !== 'string' || !isOpName(op)) {
      throw clientError('not_supported', `no operation named ${String(op)}`, {
        hint: 'the capabilities list the operations this board serves',
      })
    }
    if (opts?.signal?.aborted === true && laneKind(op) !== 'wait') {
      throw opts.signal.reason
    }

    if (this.#entry === null) {
      await this.ready()
    }
    if (this.#closed) {
      throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
    }

    const entry = this.#entry!
    const ctx: DispatchContext = {
      board: entry.board,
      identity: this.#identity,
      guard: entry.guard,
      watch: entry.watch,
    }

    const started = performance.now()
    let callAttempts = 0
    let laneHash = hashLane(`${this.#identity.base.principal}\u001f${this.#identity.base.profile ?? ''}`)
    this.#calls += 1

    try {
      // Pass cached ops (OP_NAMES) without re-querying boardInfo() so prepareCall checks watch.stopped first
      // even if the store was already closed by `replaced` (B9-F1).
      const prepared = prepareCall(ctx, op, input, opts, { closed: this.#closed, ops: this.#caps.ops })
      laneHash = hashLane(prepared.lane)

      const rawWait0 = prepared.spec.wait === 'core' ? Number(prepared.input['wait'] ?? 0) : 0
      const waitDeadlineMs = Number.isFinite(rawWait0) && rawWait0 > 0 ? rawWait0 * 1000 : 0

      const safeHeadCursor = (): string => {
        try {
          return String(entry.board.store.getHeadIndex())
        } catch {
          return '0'
        }
      }

      const run = async (): Promise<unknown> =>
        runPrepared(prepared, ctx, this.#close.signal, async (once, waitLinkedSignal) => {
          // For reads and writes, a restore (epochSignal) must NOT abort a queued write or busy backoff (section 7.5:
          // "calls otherwise succeed"). Only wait ops cancel on epochSignal.
          const nonWaitLink =
            prepared.laneKind === 'wait'
              ? null
              : linkSignals(prepared.signal, this.#close.signal, entry.watch.stopSignal)
          const opSignal = nonWaitLink !== null ? nonWaitLink.signal : waitLinkedSignal
          try {
            return await entry.lanes.run(
              prepared.lane,
              prepared.laneKind,
              async () => {
                try {
                  return await withBusyRetry(
                    (retryCtx) => {
                      // A timed core wait whose caller deadline has already elapsed during busy retries resolves its
                      // empty answer instead of retrying past the caller's wait budget (HS-172).
                      if (waitDeadlineMs > 0 && retryCtx.attempt > 1 && retryCtx.elapsedMs >= waitDeadlineMs) {
                        if (prepared.op === 'claimReadyTask') return { task: null }
                        if (prepared.op === 'events') {
                          return { events: [], cursor: safeHeadCursor() }
                        }
                      }
                      callAttempts += 1
                      this.#attempts += 1
                      return once(retryCtx.elapsedMs)
                    },
                    {
                      policy: { budgetMs: this.#busyBudgetMs },
                      budgetFrom: prepared.laneKind === 'wait' ? 'streak' : 'call',
                      signal: opSignal,
                      onRetry: () => {
                        this.#busyRetries += 1
                      },
                    },
                  )
                } catch (err) {
                  if (entry.watch.stopped !== null && prepared.signal?.aborted !== true) {
                    throw entry.watch.stopped
                  }
                  if (opSignal.aborted) {
                    if (prepared.laneKind === 'wait') {
                      // CF-08: an aborted wait resolves (never rejects with a transient busy 503).
                      // If this was an events call cut by an epoch reset, runPrepared converts the return to 410.
                      if (prepared.op === 'claimReadyTask') return { task: null }
                      if (prepared.op === 'matches') return []
                      if (prepared.op === 'events') {
                        try {
                          return await once(0)
                        } catch {
                          return { events: [], cursor: safeHeadCursor() }
                        }
                      }
                    }
                    if (prepared.signal?.aborted === true) {
                      throw prepared.signal.reason
                    }
                    if (this.#closed) {
                      throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
                    }
                  }
                  if (isRetryableBusy(err) && !opSignal.aborted) {
                    this.#busyGiveUps += 1
                  }
                  throw err
                }
              },
              opSignal,
            )
          } finally {
            nonWaitLink?.dispose()
          }
        })

      const p = run()
      if (prepared.laneKind === 'write') {
        this.#inFlightWrites.add(p)
        void p.then(
          () => this.#inFlightWrites.delete(p),
          () => this.#inFlightWrites.delete(p),
        )
      }
      const result = await p
      this.#emitLog({
        op: prepared.op,
        lane: laneHash,
        attempts: callAttempts,
        ms: performance.now() - started,
        outcome: 'ok',
      })
      return result
    } catch (error) {
      if (entry.stopPromise !== null) {
        await entry.stopPromise
      }
      const status = isBoardError(error) ? error.status : undefined
      const code = isBoardError(error) ? error.code : undefined
      this.#emitLog({
        op,
        lane: laneHash,
        attempts: callAttempts,
        ms: performance.now() - started,
        outcome: 'error',
        ...(status !== undefined ? { status } : {}),
        ...(code !== undefined ? { code } : {}),
      })
      throw error
    }
  }

  events(query: EventsFeedQuery, opts?: CallOptions): AsyncIterable<EventsPage> {
    const self = this
    const isEnded = (): boolean => self.#closed || opts?.signal?.aborted === true
    async function* feed(): AsyncGenerator<EventsPage, void, undefined> {
      if (isEnded()) return
      if (self.#entry === null) {
        await self.ready()
      }
      if (isEnded()) return
      const entry = self.#entry!
      const ctx: DispatchContext = {
        board: entry.board,
        identity: self.#identity,
        guard: entry.guard,
        watch: entry.watch,
      }
      yield* eventsFeed(
        ctx,
        query ?? {},
        opts,
        (input, signal) => self.#call('events', input, { ...opts, signal }) as Promise<EventsPage>,
        self.#close.signal,
      )
    }
    return feed()
  }

  /** Aborts this instance's waits, drains its in-flight writes, decrements refs, and closes at refs === 0. Idempotent; never throws. */
  close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise
    }
    this.#closePromise = this.#doClose()
    return this.#closePromise
  }

  async #doClose(): Promise<void> {
    this.#closed = true
    this.#close.abort(clientError('unavailable', 'this transport is closed', { hint: 'open a new client' }))

    // If ready() was in flight, let it settle so its refcount / teardown finishes cleanly.
    if (this.#readyPromise !== null) {
      await this.#readyPromise.catch(() => {})
    }

    // Wait for this transport instance's own in-flight writes to leave their lanes.
    if (this.#inFlightWrites.size > 0) {
      await Promise.allSettled([...this.#inFlightWrites])
    }

    const entry = this.#entry
    if (entry === null) return

    if (entry.transports.delete(this)) {
      entry.refs = Math.max(0, entry.refs - 1)
    }

    if (entry.state === 'stopped') {
      // Poisoned entry stays registered as 'stopped' for the rest of this process (HOST123_DESIGN 6.6).
      if (entry.stopPromise !== null) {
        await entry.stopPromise.catch(() => {})
      }
      return
    }

    if (entry.refs === 0) {
      await teardownOpenEntry(entry)
    }
  }

  #emitLog(record: TransportLogRecord): void {
    const fn = this.#log
    if (fn === undefined) return
    try {
      fn(Object.freeze(record))
    } catch {
      // A throwing log observer never breaks a transport call.
    }
  }
}
