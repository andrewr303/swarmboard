// Cross-process wake bridge for Mode 1 shared-file boards (HOST123_DESIGN 3, 6.4, 7.3, 7.5; designs g2 2.2-2.4).
// Watches <db>.wakeup (or its directory until created), runs a safety head poll that re-arms on inode change,
// pumps external commits into store.onEvent listeners via C1 external dispatch, and enforces C5 board identity.
// Runtime imports strictly limited to ../core/public.ts, node:fs, node:path, and ../client/busy.ts (HS-151).
import * as fs from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  BoardError,
  type BoardIdentity,
  type BoardServiceOptions,
  type SqliteUnifiedStore,
  type StoredEvent,
} from '../core/public.ts'
import { isStoreClosedError, replacedError } from '../client/busy.ts'

/** Safety poll while fs.watch is armed: 1500 ms, or 250 ms on win32 until HOST-13 proves its watcher (Q9). */
export const WAKE_SAFETY_POLL_MS: number = process.platform === 'win32' ? 250 : 1_500
/** Poll interval when no watcher can be armed (no .wakeup path, watch error, `watch: false`). */
export const WAKE_DEGRADED_POLL_MS = 250
export const WAKE_PAGE_SIZE = 200
export const WAKE_MAX_PAGES_PER_TURN = 10
/** In poll mode because the watcher failed, try arming it again after this long. */
export const WAKE_REARM_AFTER_MS = 10_000

export type WakeMode = 'fs-watch' | 'poll'
export type WakeBridgeState = 'idle' | 'running' | 'stopped'
export type WakeStopReason = 'stopped' | 'replaced' | 'closed'
export type WakeErrorSite = 'watch' | 'pump' | 'identity' | 'listener'

export interface WakeReset {
  /** The bridge's epoch after this reset (1 after the first). */
  readonly epoch: number
  /** 'restored': checkIdentity saw another instance id. 'rewound': the log head fell below the cursor (410 from the pump). */
  readonly reason: 'restored' | 'rewound'
  readonly identity: BoardIdentity | null
  readonly was: BoardIdentity | null
  /** The new dispatch cursor (the head at re-arm). Events in (old cursor, this] were NOT dispatched. */
  readonly cursor: number
}

export interface WakeStop {
  readonly reason: WakeStopReason
  /** For 'replaced': the 503 every later call should get. Null for 'stopped' and 'closed'. */
  readonly error: BoardError | null
}

export interface WakeTurn {
  readonly dispatched: number
  /** Sum of ExternalDispatchResult.skippedOwn over the turn's pumps (CR-15). */
  readonly skippedOwn: number
  readonly pages: number
  /** A full last page: another turn was scheduled with setImmediate. */
  readonly more: boolean
  readonly reset: WakeReset | null
  readonly stopped: WakeStop | null
}

export interface WakeTestHooks {
  watch?: (path: string, listener: (eventType: string, filename: string | null) => void) => fs.FSWatcher
  statIno?: (path: string) => bigint | null
}

export interface WakeBridgeOptions {
  /** Integer 50..60_000. Default WAKE_SAFETY_POLL_MS. */
  safetyPollMs?: number
  /** Integer 20..safetyPollMs. Default WAKE_DEGRADED_POLL_MS (clamped to safetyPollMs). */
  degradedPollMs?: number
  /** Integer 1..5000. Default 200. */
  pageSize?: number
  /** Integer 1..1000. Default 10. */
  maxPagesPerTurn?: number
  /** false: poll only (tests, filesystems without change events). Default true. */
  watch?: boolean
  /** Called for bridge-side failures; a throwing hook is swallowed. Never receives event payloads. */
  onError?: (error: unknown, site: WakeErrorSite) => void
  /** Test seams, inert when unset. */
  testHooks?: WakeTestHooks
}

export interface WakeBridgeStatus {
  readonly state: WakeBridgeState
  readonly mode: WakeMode | null
  readonly epoch: number
  readonly identity: BoardIdentity | null
  readonly cursor: number
  readonly dispatched: number
  readonly turns: number
  readonly resets: number
  readonly watchRearms: number
  readonly errors: number
  readonly dropped: number
  readonly lastError: { readonly site: WakeErrorSite; readonly message: string } | null
  readonly stopped: WakeStop | null
}

export type WakeStatus = WakeBridgeStatus

/** Module-level guard ensuring at most one running WakeBridge per store (two dispatchers would split one cursor). */
const runningStores = new WeakSet<SqliteUnifiedStore>()

function checkIntRange(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}: ${String(value)}`)
  }
  return value
}

function isCursorExpiredError(error: unknown): boolean {
  return error instanceof BoardError && error.status === 410 && error.code === 'cursor_expired'
}

function errnoCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined
}

export class WakeBridge {
  private readonly store: SqliteUnifiedStore
  private readonly safetyPollMs: number
  private readonly degradedPollMs: number
  private readonly pageSize: number
  private readonly maxPagesPerTurn: number
  private readonly watchEnabled: boolean
  private readonly onErrorHook: ((error: unknown, site: WakeErrorSite) => void) | null
  private readonly testHooks: WakeTestHooks | null
  private readonly cachedServiceOptions: Readonly<Required<Pick<BoardServiceOptions, 'eventsWaitPollMs' | 'tasks'>>>

  private state: WakeBridgeState = 'idle'
  private mode: WakeMode | null = null
  private watchPermanentPoll = false
  private watcher: fs.FSWatcher | null = null
  private watchTarget: 'file' | 'dir' | null = null
  private watchedIno: bigint | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pollIntervalMs: number | null = null
  private rearmTimer: ReturnType<typeof setTimeout> | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private turnImmediate: ReturnType<typeof setImmediate> | null = null

  private baseline: BoardIdentity | null = null
  private pendingReset: { readonly reason: 'restored' | 'rewound'; readonly was: BoardIdentity | null } | null = null
  private epochValue = 0
  private dispatched = 0
  private turns = 0
  private resets = 0
  private watchRearms = 0
  private errors = 0
  private lastError: { readonly site: WakeErrorSite; readonly message: string } | null = null
  private stoppedInfo: WakeStop | null = null

  private readonly resetListeners = new Set<(reset: WakeReset) => void>()
  private readonly stopListeners = new Set<(stop: WakeStop) => void>()

  constructor(store: SqliteUnifiedStore, options: WakeBridgeOptions = {}) {
    const safetyPollMs =
      options.safetyPollMs !== undefined
        ? checkIntRange('safetyPollMs', options.safetyPollMs, 50, 60_000)
        : WAKE_SAFETY_POLL_MS
    const degradedPollMs =
      options.degradedPollMs !== undefined
        ? checkIntRange('degradedPollMs', options.degradedPollMs, 20, safetyPollMs)
        : Math.min(WAKE_DEGRADED_POLL_MS, safetyPollMs)
    const pageSize =
      options.pageSize !== undefined ? checkIntRange('pageSize', options.pageSize, 1, 5_000) : WAKE_PAGE_SIZE
    const maxPagesPerTurn =
      options.maxPagesPerTurn !== undefined
        ? checkIntRange('maxPagesPerTurn', options.maxPagesPerTurn, 1, 1_000)
        : WAKE_MAX_PAGES_PER_TURN
    if (options.watch !== undefined && typeof options.watch !== 'boolean') {
      throw new RangeError(`watch must be a boolean: ${String(options.watch)}`)
    }

    this.store = store
    this.safetyPollMs = safetyPollMs
    this.degradedPollMs = degradedPollMs
    this.pageSize = pageSize
    this.maxPagesPerTurn = maxPagesPerTurn
    this.watchEnabled = options.watch ?? true
    this.onErrorHook = options.onError ?? null
    this.testHooks = options.testHooks ?? null

    this.cachedServiceOptions = Object.freeze({
      eventsWaitPollMs: this.safetyPollMs,
      tasks: Object.freeze({
        wake: (listener: (ev: StoredEvent) => void) => this.store.onEvent(listener),
        armedSafetyPollMs: this.safetyPollMs,
      }),
    })
  }

  get epoch(): number {
    return this.epochValue
  }

  /** What to spread into BoardServiceOptions before the service is built (g2 §2.4). */
  serviceOptions(): Readonly<Required<Pick<BoardServiceOptions, 'eventsWaitPollMs' | 'tasks'>>> {
    return this.cachedServiceOptions
  }

  onReset(listener: (reset: WakeReset) => void): () => void {
    if (this.state === 'stopped') return () => {}
    this.resetListeners.add(listener)
    return () => {
      this.resetListeners.delete(listener)
    }
  }

  onStop(listener: (stop: WakeStop) => void): () => void {
    if (this.state === 'stopped') return () => {}
    this.stopListeners.add(listener)
    return () => {
      this.stopListeners.delete(listener)
    }
  }

  start(): void {
    if (this.state === 'running') return
    if (this.state === 'stopped') {
      throw new TypeError('a stopped WakeBridge cannot start again: make a new one')
    }
    if (runningStores.has(this.store)) {
      throw new TypeError('this store already has a running WakeBridge')
    }
    if (this.store.sidecarHealth().external.armed) {
      throw new TypeError('external dispatch is already armed on this store')
    }

    // Propagates 503 (closed) or TypeError (inside a transaction); state remains 'idle'.
    this.store.armExternalDispatch()

    this.baseline = this.store.openedIdentity
    this.state = 'running'
    this.watchPermanentPoll = !this.watchEnabled || this.store.wakeupPath === null
    runningStores.add(this.store)

    this.armWatch()
    this.syncPollTimer()
    // Re-read-after-arm: closes the window between armExternalDispatch and armWatch.
    this.scheduleTurn()
  }

  stop(): void {
    if (this.state === 'stopped') return
    if (this.state === 'idle') {
      this.state = 'stopped'
      this.stoppedInfo = Object.freeze({ reason: 'stopped', error: null })
      this.resetListeners.clear()
      this.stopListeners.clear()
      return
    }
    this.clearHandles()
    this.pendingReset = null
    runningStores.delete(this.store)
    this.store.disarmExternalDispatch()
    this.state = 'stopped'
    const stopInfo: WakeStop = Object.freeze({ reason: 'stopped', error: null })
    this.stoppedInfo = stopInfo
    this.emitStop(stopInfo)
  }

  /** One synchronous turn now (tests, hosts doing bulk synchronous writes). TypeError inside a transaction. */
  pumpNow(): WakeTurn {
    if (this.state === 'stopped') {
      return { dispatched: 0, skippedOwn: 0, pages: 0, more: false, reset: null, stopped: this.stoppedInfo }
    }
    let inTx = false
    try {
      inTx = this.store.db.isTransaction
    } catch {
      // Closed store is handled cleanly by checkIdentity inside runTurn.
    }
    if (inTx) {
      throw new TypeError('pumpNow cannot run inside a transaction')
    }
    if (this.state !== 'running') {
      return { dispatched: 0, skippedOwn: 0, pages: 0, more: false, reset: null, stopped: null }
    }
    return this.runTurn()
  }

  status(): WakeBridgeStatus {
    const ext = this.state === 'running' ? this.store.sidecarHealth().external : null
    return Object.freeze({
      state: this.state,
      mode: this.mode,
      epoch: this.epochValue,
      identity: this.baseline,
      cursor: ext ? ext.cursor : 0,
      dispatched: this.dispatched,
      turns: this.turns,
      resets: this.resets,
      watchRearms: this.watchRearms,
      errors: this.errors,
      dropped: ext ? ext.dropped : 0,
      lastError: this.lastError,
      stopped: this.stoppedInfo,
    })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Watch management

  private statIno(path: string): bigint | null {
    if (this.testHooks?.statIno) {
      return this.testHooks.statIno(path)
    }
    try {
      const st = fs.statSync(path, { bigint: true, throwIfNoEntry: false })
      return st ? st.ino : null
    } catch {
      return null
    }
  }

  private openWatcher(
    path: string,
    listener: (eventType: string, filename: string | null) => void,
  ): fs.FSWatcher {
    if (this.testHooks?.watch) {
      return this.testHooks.watch(path, listener)
    }
    return fs.watch(path, { persistent: false }, (eventType, filename) => {
      listener(eventType, filename === null ? null : String(filename))
    })
  }

  private closeWatcher(): void {
    this.clearSettleTimer()
    const old = this.watcher
    this.watcher = null
    this.watchTarget = null
    this.watchedIno = null
    if (!old) return
    try {
      old.close()
    } catch {
      // Ignore close failures on already-errored watchers.
    }
  }

  private clearRearmTimer(): void {
    if (this.rearmTimer !== null) {
      clearTimeout(this.rearmTimer)
      this.rearmTimer = null
    }
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
  }

  private clearHandles(): void {
    this.closeWatcher()
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
      this.pollIntervalMs = null
    }
    this.clearRearmTimer()
    this.clearSettleTimer()
    if (this.turnImmediate !== null) {
      clearImmediate(this.turnImmediate)
      this.turnImmediate = null
    }
  }

  private armWatch(): void {
    if (this.state !== 'running') return
    this.clearRearmTimer()
    this.closeWatcher()

    const wakeupPath = this.store.wakeupPath
    if (this.watchPermanentPoll || wakeupPath === null) {
      this.mode = 'poll'
      return
    }

    const ino = this.statIno(wakeupPath)
    if (ino !== null) {
      try {
        const w = this.openWatcher(wakeupPath, () => {
          if (this.watcher !== w || this.state !== 'running') return
          this.scheduleTurn()
        })
        this.attachWatcher(w, 'file', ino)
        return
      } catch (error) {
        // If .wakeup vanished between statIno and watch, fall through to directory watch.
        if (errnoCode(error) !== 'ENOENT') {
          this.handleWatchFailure(error)
          return
        }
      }
    }

    const dir = dirname(wakeupPath)
    const wantName = basename(wakeupPath)
    try {
      const w = this.openWatcher(dir, (_eventType, filename) => {
        if (this.watcher !== w || this.state !== 'running') return
        if (filename != null && filename !== wantName) return
        this.checkWatch()
        this.scheduleTurn()
      })
      this.attachWatcher(w, 'dir', null)
    } catch (error) {
      this.handleWatchFailure(error)
    }
  }

  private attachWatcher(w: fs.FSWatcher, target: 'file' | 'dir', ino: bigint | null): void {
    this.watcher = w
    this.watchTarget = target
    this.watchedIno = ino
    this.mode = 'fs-watch'
    this.watchRearms += 1
    if (typeof w.on === 'function') {
      w.on('error', (error: unknown) => {
        if (this.watcher !== w || this.state !== 'running') return
        this.handleWatchFailure(error)
      })
    }
    // On macOS, libuv starts FSEventStream asynchronously on a background CFRunLoop thread (~5-15 ms after
    // fs.watch returns). One short unref'd follow-up turn closes that startup window on fresh arms/upgrades.
    this.clearSettleTimer()
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      if (this.state !== 'running') return
      this.scheduleTurn()
    }, 25)
    this.settleTimer.unref()
    this.syncPollTimer()
  }

  private handleWatchFailure(error: unknown): void {
    this.closeWatcher()
    this.reportError(error, 'watch')
    this.mode = 'poll'
    if (this.state !== 'running') return
    this.syncPollTimer()
    if (!this.watchPermanentPoll && this.rearmTimer === null) {
      this.rearmTimer = setTimeout(() => {
        this.rearmTimer = null
        if (this.state !== 'running') return
        this.armWatch()
        if (this.mode === 'fs-watch') {
          this.scheduleTurn()
        }
      }, WAKE_REARM_AFTER_MS)
      this.rearmTimer.unref()
    }
  }

  private checkWatch(): void {
    if (this.state !== 'running' || this.mode !== 'fs-watch' || this.watchPermanentPoll) return
    const wakeupPath = this.store.wakeupPath
    if (wakeupPath === null) return

    if (this.watcher === null) {
      this.armWatch()
      return
    }
    const currentIno = this.statIno(wakeupPath)
    if (this.watchTarget === 'file') {
      // Unlinked (currentIno === null) or rename-over / recreated (inode changed): re-arm.
      if (currentIno === null || currentIno !== this.watchedIno) {
        this.armWatch()
      }
    } else if (this.watchTarget === 'dir') {
      // File now exists: upgrade from directory watch to file watch.
      if (currentIno !== null) {
        this.armWatch()
      }
    }
  }

  private syncPollTimer(): void {
    if (this.state !== 'running') return
    const desired = this.mode === 'fs-watch' ? this.safetyPollMs : this.degradedPollMs
    if (this.pollTimer !== null && this.pollIntervalMs === desired) return
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
    }
    this.pollIntervalMs = desired
    this.pollTimer = setInterval(() => this.onPoll(), desired)
    this.pollTimer.unref()
  }

  private onPoll(): void {
    if (this.state !== 'running') return
    if (this.mode === 'fs-watch') {
      this.checkWatch()
    }
    this.scheduleTurn()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Turns, resets & stop paths

  private scheduleTurn(): void {
    if (this.state !== 'running' || this.turnImmediate !== null) return
    this.turnImmediate = setImmediate(() => {
      this.turnImmediate = null
      if (this.state !== 'running') return
      this.runTurn()
    })
  }

  private runTurn(): WakeTurn {
    if (this.state !== 'running') {
      return { dispatched: 0, skippedOwn: 0, pages: 0, more: false, reset: null, stopped: this.stoppedInfo }
    }
    if (this.mode === 'fs-watch' && this.watchTarget === 'dir') {
      this.checkWatch()
    }
    this.turns += 1

    // Step 1: check board identity against baseline.
    let idCheck: ReturnType<SqliteUnifiedStore['checkIdentity']>
    try {
      idCheck = this.store.checkIdentity(this.baseline)
    } catch (error) {
      if (isStoreClosedError(error)) {
        const stopInfo = this.stopAsClosed()
        return { dispatched: 0, skippedOwn: 0, pages: 0, more: false, reset: null, stopped: stopInfo }
      }
      this.reportError(error, 'identity')
      return { dispatched: 0, skippedOwn: 0, pages: 0, more: false, reset: null, stopped: null }
    }

    if (idCheck.status === 'replaced') {
      const stopInfo = this.closeAndStop()
      return { dispatched: 0, skippedOwn: 0, pages: 0, more: false, reset: null, stopped: stopInfo }
    }

    if (idCheck.status === 'restored') {
      const resetInfo = this.reset('restored', idCheck.identity, idCheck.was)
      return {
        dispatched: 0,
        skippedOwn: 0,
        pages: 0,
        more: false,
        reset: resetInfo,
        stopped: this.state === 'running' ? null : this.stoppedInfo,
      }
    }

    // Complete any pending reset (e.g. a previous armExternalDispatch failed transiently after disarm).
    if (this.pendingReset !== null || !this.store.sidecarHealth().external.armed) {
      const pending = this.pendingReset ?? { reason: 'rewound' as const, was: this.baseline }
      const resetInfo = this.reset(pending.reason, idCheck.identity, pending.was)
      return {
        dispatched: 0,
        skippedOwn: 0,
        pages: 0,
        more: false,
        reset: resetInfo,
        stopped: this.state === 'running' ? null : this.stoppedInfo,
      }
    }

    // Step 2: pump up to maxPagesPerTurn pages, yielding with setImmediate if still full.
    let turnDispatched = 0
    let turnSkippedOwn = 0
    let pages = 0
    let more = false

    for (let i = 0; i < this.maxPagesPerTurn; i++) {
      let page: ReturnType<SqliteUnifiedStore['pumpExternal']>
      try {
        page = this.store.pumpExternal(this.pageSize)
      } catch (error) {
        if (error instanceof TypeError && error.message.includes('cannot run inside a transaction')) {
          throw error
        }
        if (isCursorExpiredError(error)) {
          let currentIdentity: BoardIdentity | null = null
          try {
            currentIdentity = this.store.identity()
          } catch (idErr) {
            if (isStoreClosedError(idErr)) {
              const stopInfo = this.stopAsClosed()
              return {
                dispatched: turnDispatched,
                skippedOwn: turnSkippedOwn,
                pages,
                more: false,
                reset: null,
                stopped: stopInfo,
              }
            }
            this.reportError(idErr, 'identity')
            return {
              dispatched: turnDispatched,
              skippedOwn: turnSkippedOwn,
              pages,
              more: false,
              reset: null,
              stopped: null,
            }
          }
          const resetInfo = this.reset('rewound', currentIdentity, this.baseline)
          return {
            dispatched: turnDispatched,
            skippedOwn: turnSkippedOwn,
            pages,
            more: false,
            reset: resetInfo,
            stopped: this.state === 'running' ? null : this.stoppedInfo,
          }
        }
        if (isStoreClosedError(error)) {
          const stopInfo = this.stopAsClosed()
          return {
            dispatched: turnDispatched,
            skippedOwn: turnSkippedOwn,
            pages,
            more: false,
            reset: null,
            stopped: stopInfo,
          }
        }
        this.reportError(error, 'pump')
        return {
          dispatched: turnDispatched,
          skippedOwn: turnSkippedOwn,
          pages,
          more: false,
          reset: null,
          stopped: null,
        }
      }

      pages += 1
      turnDispatched += page.dispatched
      turnSkippedOwn += page.skippedOwn
      this.dispatched += page.dispatched
      more = page.more

      if (this.state !== 'running') {
        return {
          dispatched: turnDispatched,
          skippedOwn: turnSkippedOwn,
          pages,
          more: false,
          reset: null,
          stopped: this.stoppedInfo,
        }
      }
      if (!page.more) {
        return {
          dispatched: turnDispatched,
          skippedOwn: turnSkippedOwn,
          pages,
          more: false,
          reset: null,
          stopped: null,
        }
      }
    }

    // Step 3: all pages were full; yield via setImmediate so the event loop stays responsive.
    if (more && this.state === 'running') {
      this.scheduleTurn()
    }
    return {
      dispatched: turnDispatched,
      skippedOwn: turnSkippedOwn,
      pages,
      more,
      reset: null,
      stopped: null,
    }
  }

  private reset(reason: 'restored' | 'rewound', identity: BoardIdentity | null, was: BoardIdentity | null): WakeReset | null {
    const effectiveWas = this.pendingReset !== null ? this.pendingReset.was : was
    this.store.disarmExternalDispatch()
    let cursor: number
    try {
      cursor = this.store.armExternalDispatch()
    } catch (error) {
      if (isStoreClosedError(error)) {
        this.pendingReset = null
        this.stopAsClosed()
        return null
      }
      this.pendingReset = { reason, was: effectiveWas }
      this.reportError(error, reason === 'restored' ? 'identity' : 'pump')
      return null
    }

    this.pendingReset = null
    this.baseline = identity
    this.epochValue += 1
    this.resets += 1

    const resetInfo: WakeReset = Object.freeze({
      epoch: this.epochValue,
      reason,
      identity,
      was: effectiveWas,
      cursor,
    })

    for (const listener of [...this.resetListeners]) {
      try {
        listener(resetInfo)
      } catch (error) {
        this.reportError(error, 'listener')
      }
    }
    return resetInfo
  }

  private closeAndStop(): WakeStop {
    const error = replacedError(this.store.path)
    this.clearHandles()
    this.pendingReset = null
    runningStores.delete(this.store)
    this.store.disarmExternalDispatch()
    try {
      this.store.close()
    } catch (closeErr) {
      this.reportError(closeErr, 'identity')
    }
    this.state = 'stopped'
    const stopInfo: WakeStop = Object.freeze({ reason: 'replaced', error })
    this.stoppedInfo = stopInfo
    this.emitStop(stopInfo)
    return stopInfo
  }

  private stopAsClosed(): WakeStop {
    this.clearHandles()
    this.pendingReset = null
    runningStores.delete(this.store)
    this.store.disarmExternalDispatch()
    this.state = 'stopped'
    const stopInfo: WakeStop = Object.freeze({ reason: 'closed', error: null })
    this.stoppedInfo = stopInfo
    this.emitStop(stopInfo)
    return stopInfo
  }

  private emitStop(stopInfo: WakeStop): void {
    const listeners = [...this.stopListeners]
    this.resetListeners.clear()
    this.stopListeners.clear()
    for (const listener of listeners) {
      try {
        listener(stopInfo)
      } catch (error) {
        this.reportError(error, 'listener')
      }
    }
  }

  private reportError(error: unknown, site: WakeErrorSite): void {
    this.errors += 1
    const message = error instanceof Error ? error.message : String(error)
    this.lastError = Object.freeze({ site, message })
    const hook = this.onErrorHook
    if (!hook) return
    try {
      hook(error, site)
    } catch {
      // A throwing onError hook is swallowed (g2 §2.2).
    }
  }
}
