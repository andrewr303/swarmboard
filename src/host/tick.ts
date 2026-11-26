// HOST-3 Seam B: the Ticker (HOST123_DESIGN 3, 6.5; designs/DESIGN-host123-g2.md 3.2-3.3).
//
// The only src/host file that imports src/core/internal.ts. The SystemCaller and SystemOps are confined
// to the ES private field `#ops`: nothing exported, returned, or reachable via reflection exposes them.
// Reports carry ids and error codes only (never message text, views, profiles, or raw error objects).
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { isRetryableBusy, isStoreClosedError } from '../client/busy.ts'
import {
  acquireTickLease,
  createSystemCaller,
  readTickLease,
  releaseTickLease,
  renewTickLease,
  systemOps,
  TICK_LEASE_TTL_MAX_MS,
  TICK_LEASE_TTL_MIN_MS,
  type AcquireResult,
  type SystemOps,
  type TickLease,
  type TickLeaseRecord,
} from '../core/internal.ts'
import {
  BoardError,
  type BoardService,
  type ExpireRun,
  type ScheduleRun,
  type StorageBackend,
} from '../core/public.ts'

export const TICK_INTERVAL_MS = 5_000
export const TICK_TTL_MS = 20_000
export const TICK_JITTER = 0.2
export const TICK_MIN_DELAY_MS = 25
export const TICK_RETRY_DELAY_MS = 1_000
export const TICK_CLAIMS_PER_RUN = 200
export const TICK_CLAIM_CHUNK = 25

const HOLDER_RE = /^[\x21-\x7e]{1,200}$/
const INTERVAL_MIN_MS = 50
const INTERVAL_MAX_MS = 600_000
const JITTER_MIN = 0
const JITTER_MAX = 0.5
const CLAIMS_PER_RUN_MIN = 1
const CLAIMS_PER_RUN_MAX = 5_000
const CLAIM_CHUNK_MIN = 1
const CLAIM_CHUNK_MAX = 500

/** `${host}:${pid}:${uuid}`: host is os.hostname() with every char outside \x21-\x7e (or ':') replaced by '_', cut to 64 ('host' if empty). */
export function mintTickHolder(): string {
  let raw = ''
  try {
    raw = os.hostname()
  } catch {
    raw = ''
  }
  const host = raw.replace(/[^\x21-\x7e]|:/g, '_').slice(0, 64) || 'host'
  return `${host}:${process.pid}:${randomUUID()}`
}

export type TickOutcome = 'ran' | 'not_holder' | 'refused' | 'busy' | 'error' | 'reentrant' | 'stopped' | 'closed'
export type TickErrorSite = 'acquire' | 'renew' | 'release' | 'schedules' | 'claims' | 'plan' | 'skew' | 'report'

export interface TickReport {
  readonly outcome: TickOutcome
  /** The ticker's clock at the start of the run. */
  readonly at: number
  /** Who holds the lease as this run saw it: this ticker's holder when it ran, another's when not_holder, else null. */
  readonly holder: string | null
  readonly fence: number | null
  readonly takeover: boolean
  /** The lease was lost during this run (shouldContinue saw another holder or fence): the run stopped sending. */
  readonly lost: boolean
  /** Ids and codes only: never message text or a view (rule 4 and log hygiene). */
  readonly schedules: {
    readonly sent: readonly string[]
    readonly skipped: readonly string[]
    readonly failed: readonly { readonly schedule: string; readonly code: string }[]
    readonly stopped: boolean
  } | null
  readonly claims: {
    readonly expired: readonly number[]
    readonly held: readonly number[]
    readonly failed: readonly { readonly task: number; readonly code: string }[]
    /** expired + held + failed reached claimsPerRun: more may be due. */
    readonly backlog: boolean
  } | null
  /** The clock moved more than ttlMs + 2 * intervalMs since the last run, or backwards by more than 1000 ms. */
  readonly clockJump: boolean
  /** Another holder's lease ends further ahead than TICK_LEASE_TTL_MAX_MS + 1000: some clock went backwards. */
  readonly skew: boolean
  readonly nextDelayMs: number
}

export interface TickerOptions {
  /** Test-only override of the minted holder; must match the lease holder pattern. Never share one between processes. */
  holder?: string
  /** Integer 50..600_000. Default 5000. */
  intervalMs?: number
  /** Integer 1000..300_000 and >= 2 * intervalMs. Default max(1000, min(300_000, 4 * intervalMs)). */
  ttlMs?: number
  /** 0..0.5. Default 0.2. */
  jitter?: number
  /** The clock for the lease and for planning. MUST be the function given as BoardServiceOptions.now (default Date.now). */
  now?: () => number
  random?: () => number
  /** Integer 1..5000. Default 200. */
  claimsPerRun?: number
  /** Integer 1..500. Default 25. */
  claimChunk?: number
  onReport?: (report: TickReport) => void
  onError?: (error: unknown, site: TickErrorSite) => void
}

export type TickerState = 'idle' | 'running' | 'stopped'

export interface TickerStatus {
  readonly state: TickerState
  readonly holder: string
  readonly holding: boolean
  readonly fence: number | null
  readonly runs: number
  readonly lastReport: TickReport | null
}

function freezeScheduleSummary(run: ScheduleRun): NonNullable<TickReport['schedules']> {
  return Object.freeze({
    sent: Object.freeze(run.sent.map((m) => m.id)),
    skipped: Object.freeze([...run.skipped]),
    failed: Object.freeze(run.failed.map((f) => Object.freeze({ schedule: f.schedule, code: f.error.code }))),
    stopped: run.stopped,
  })
}

function freezeClaimsSummary(run: ExpireRun, claimsPerRun: number): NonNullable<TickReport['claims']> {
  return Object.freeze({
    expired: Object.freeze([...run.expired]),
    held: Object.freeze([...run.held]),
    failed: Object.freeze(run.failed.map((f) => Object.freeze({ task: f.task, code: f.error.code }))),
    backlog: run.expired.length + run.held.length + run.failed.length >= claimsPerRun,
  })
}

function makeReport(fields: TickReport): TickReport {
  return Object.freeze({ ...fields })
}

export class Ticker {
  readonly holder: string
  readonly #store: StorageBackend
  readonly #ops: SystemOps
  readonly #intervalMs: number
  readonly #ttlMs: number
  readonly #jitter: number
  readonly #now: () => number
  readonly #random: () => number
  readonly #claimsPerRun: number
  readonly #claimChunk: number
  readonly #onReport: ((report: TickReport) => void) | undefined
  readonly #onError: ((error: unknown, site: TickErrorSite) => void) | undefined

  #state: TickerState = 'idle'
  #lease: TickLease | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #timerDueAt: number | null = null
  #unsubscribe: (() => void) | null = null
  #inRun = false
  #pokedAfterPlan = false
  #lastRunAt: number | null = null
  #runs = 0
  #lastReport: TickReport | null = null
  #skewActive = false

  constructor(board: BoardService, options: TickerOptions = {}) {
    const intervalMs = options.intervalMs === undefined ? TICK_INTERVAL_MS : options.intervalMs
    if (!Number.isInteger(intervalMs) || intervalMs < INTERVAL_MIN_MS || intervalMs > INTERVAL_MAX_MS) {
      throw new RangeError(
        `intervalMs must be an integer from ${INTERVAL_MIN_MS} to ${INTERVAL_MAX_MS}: ${String(options.intervalMs)}`,
      )
    }
    const defaultTtlMs = Math.max(TICK_LEASE_TTL_MIN_MS, Math.min(TICK_LEASE_TTL_MAX_MS, 4 * intervalMs))
    const ttlMs = options.ttlMs === undefined ? defaultTtlMs : options.ttlMs
    if (
      !Number.isInteger(ttlMs) ||
      ttlMs < TICK_LEASE_TTL_MIN_MS ||
      ttlMs > TICK_LEASE_TTL_MAX_MS ||
      ttlMs < 2 * intervalMs
    ) {
      throw new RangeError(
        `ttlMs must be an integer from ${TICK_LEASE_TTL_MIN_MS} to ${TICK_LEASE_TTL_MAX_MS} and >= 2 * intervalMs: ${String(options.ttlMs)}`,
      )
    }
    const jitter = options.jitter === undefined ? TICK_JITTER : options.jitter
    if (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < JITTER_MIN || jitter > JITTER_MAX) {
      throw new RangeError(`jitter must be a finite number from ${JITTER_MIN} to ${JITTER_MAX}: ${String(options.jitter)}`)
    }
    const claimsPerRun = options.claimsPerRun === undefined ? TICK_CLAIMS_PER_RUN : options.claimsPerRun
    if (!Number.isInteger(claimsPerRun) || claimsPerRun < CLAIMS_PER_RUN_MIN || claimsPerRun > CLAIMS_PER_RUN_MAX) {
      throw new RangeError(
        `claimsPerRun must be an integer from ${CLAIMS_PER_RUN_MIN} to ${CLAIMS_PER_RUN_MAX}: ${String(options.claimsPerRun)}`,
      )
    }
    const claimChunk = options.claimChunk === undefined ? TICK_CLAIM_CHUNK : options.claimChunk
    if (!Number.isInteger(claimChunk) || claimChunk < CLAIM_CHUNK_MIN || claimChunk > CLAIM_CHUNK_MAX) {
      throw new RangeError(
        `claimChunk must be an integer from ${CLAIM_CHUNK_MIN} to ${CLAIM_CHUNK_MAX}: ${String(options.claimChunk)}`,
      )
    }
    const holder = options.holder === undefined ? mintTickHolder() : options.holder
    if (typeof holder !== 'string' || !HOLDER_RE.test(holder)) {
      throw new RangeError('holder must be 1 to 200 printable ASCII characters without spaces')
    }

    this.holder = holder
    this.#store = board.store
    this.#ops = systemOps(board, createSystemCaller())
    this.#intervalMs = intervalMs
    this.#ttlMs = ttlMs
    this.#jitter = jitter
    this.#now = options.now ?? Date.now
    this.#random = options.random ?? Math.random
    this.#claimsPerRun = claimsPerRun
    this.#claimChunk = claimChunk
    this.#onReport = options.onReport
    this.#onError = options.onError
  }

  start(): void {
    if (this.#state === 'running') return
    if (this.#state === 'stopped') {
      throw new TypeError('a stopped Ticker cannot start again')
    }
    this.#state = 'running'
    this.#unsubscribe = this.#store.onEvent((ev) => {
      if (ev.type === 'schedule.created') this.poke()
    })
    const staggerMs = Math.max(0, Math.round(this.#random() * Math.min(this.#intervalMs, 1_000)))
    this.#armTimer(staggerMs)
  }

  poke(): void {
    if (this.#state !== 'running' || this.#lease === null) return
    if (this.#inRun) {
      this.#pokedAfterPlan = true
      return
    }
    if (this.#timer === null || this.#timerDueAt === null) {
      this.#armTimer(TICK_MIN_DELAY_MS)
      return
    }
    const remaining = this.#timerDueAt - Date.now()
    if (remaining > TICK_MIN_DELAY_MS) {
      this.#armTimer(TICK_MIN_DELAY_MS)
    }
  }

  stop(): void {
    this.#state = 'stopped'
    this.#clearTimer()
    this.#clearSubscription()
    const lease = this.#lease
    this.#lease = null
    if (lease !== null) {
      try {
        releaseTickLease(this.#store, lease, { now: this.#now })
      } catch (error) {
        this.#emitError(error, 'release')
      }
    }
  }

  status(): TickerStatus {
    return Object.freeze({
      state: this.#state,
      holder: this.holder,
      holding: this.#lease !== null,
      fence: this.#lease?.fence ?? null,
      runs: this.#runs,
      lastReport: this.#lastReport,
    })
  }

  runOnce(): TickReport {
    if (this.#state === 'stopped') {
      return makeReport({
        outcome: 'stopped',
        at: this.#now(),
        holder: null,
        fence: null,
        takeover: false,
        lost: false,
        schedules: null,
        claims: null,
        clockJump: false,
        skew: false,
        nextDelayMs: 0,
      })
    }
    if (this.#inRun) {
      return makeReport({
        outcome: 'reentrant',
        at: this.#now(),
        holder: null,
        fence: null,
        takeover: false,
        lost: false,
        schedules: null,
        claims: null,
        clockJump: false,
        skew: false,
        nextDelayMs: 0,
      })
    }

    let inTx = false
    try {
      inTx = this.#store.db.isTransaction
    } catch (error) {
      if (isStoreClosedError(error)) {
        const t0 = this.#now()
        const clockJump = this.#advanceRunClock(t0)
        return this.#finishClosed(t0, clockJump)
      }
      throw error
    }
    if (inTx) {
      throw new TypeError('Ticker.runOnce cannot run inside a transaction')
    }

    this.#inRun = true
    try {
      const t0 = this.#now()
      const clockJump = this.#advanceRunClock(t0)

      if (this.#store.writeRefusal?.() != null) {
        this.#lease = null
        this.#skewActive = false
        return this.#finish(
          makeReport({
            outcome: 'refused',
            at: t0,
            holder: null,
            fence: null,
            takeover: false,
            lost: false,
            schedules: null,
            claims: null,
            clockJump,
            skew: false,
            nextDelayMs: this.#jittered(this.#intervalMs),
          }),
        )
      }

      let acq: AcquireResult
      try {
        acq = acquireTickLease(this.#store, {
          holder: this.holder,
          ttlMs: this.#ttlMs,
          now: this.#now,
        })
      } catch (error) {
        if (isStoreClosedError(error)) {
          return this.#finishClosed(t0, clockJump)
        }
        if (isRetryableBusy(error)) {
          if (this.#lease !== null && this.#lease.until <= t0) this.#lease = null
          return this.#finish(
            makeReport({
              outcome: 'busy',
              at: t0,
              holder: null,
              fence: null,
              takeover: false,
              lost: false,
              schedules: null,
              claims: null,
              clockJump,
              skew: false,
              nextDelayMs: this.#jittered(TICK_RETRY_DELAY_MS),
            }),
          )
        }
        if (this.#isWriteRefusalError(error)) {
          this.#lease = null
          this.#skewActive = false
          return this.#finish(
            makeReport({
              outcome: 'refused',
              at: t0,
              holder: null,
              fence: null,
              takeover: false,
              lost: false,
              schedules: null,
              claims: null,
              clockJump,
              skew: false,
              nextDelayMs: this.#jittered(this.#intervalMs),
            }),
          )
        }
        if (this.#lease !== null && this.#lease.until <= t0) this.#lease = null
        this.#emitError(error, 'acquire')
        return this.#finish(
          makeReport({
            outcome: 'error',
            at: t0,
            holder: null,
            fence: null,
            takeover: false,
            lost: false,
            schedules: null,
            claims: null,
            clockJump,
            skew: false,
            nextDelayMs: this.#jittered(TICK_RETRY_DELAY_MS),
          }),
        )
      }

      if (!acq.acquired) {
        this.#lease = null
        const skew = acq.until - t0 > TICK_LEASE_TTL_MAX_MS + 1_000
        if (skew && !this.#skewActive) {
          this.#skewActive = true
          this.#emitError(
            new Error('the tick lease ends further ahead than any lease can: a clock went backwards'),
            'skew',
          )
        } else if (!skew) {
          this.#skewActive = false
        }
        let d = this.#intervalMs * (1 + this.#jitter * (2 * this.#random() - 1))
        const rem = acq.until - t0
        if (rem > 0 && rem < d) {
          d = rem + this.#random() * this.#jitter * this.#intervalMs
        }
        const nextDelayMs = Math.max(TICK_MIN_DELAY_MS, Math.round(d))
        return this.#finish(
          makeReport({
            outcome: 'not_holder',
            at: t0,
            holder: acq.holder,
            fence: acq.fence,
            takeover: false,
            lost: false,
            schedules: null,
            claims: null,
            clockJump,
            skew,
            nextDelayMs,
          }),
        )
      }

      // Acquired the lease.
      this.#skewActive = false
      let lease: TickLease = acq.lease
      this.#lease = lease
      let lastRenew = lease.until - this.#ttlMs
      const renewThreshold = Math.floor(this.#ttlMs / 3)
      let lost = false
      let stopRun = false
      let closedMidRun = false

      const shouldContinue = (): boolean => {
        if (this.#state === 'stopped') return false
        let rec: TickLeaseRecord | null
        try {
          rec = readTickLease(this.#store)
        } catch (error) {
          if (isStoreClosedError(error)) {
            closedMidRun = true
            this.#enterClosedState()
            return false
          }
          this.#emitError(error, 'renew')
          stopRun = true
          return false
        }
        if (rec === null || rec.holder !== lease.holder || rec.fence !== lease.fence || rec.until === 0) {
          lost = true
          return false
        }
        const t = this.#now()
        if (t - lastRenew >= renewThreshold || rec.until - t < renewThreshold) {
          let next: TickLease | null
          try {
            next = renewTickLease(this.#store, lease, { ttlMs: this.#ttlMs, now: this.#now })
          } catch (error) {
            if (isStoreClosedError(error)) {
              closedMidRun = true
              this.#enterClosedState()
              return false
            }
            this.#emitError(error, 'renew')
            stopRun = true
            return false
          }
          if (next === null) {
            lost = true
            return false
          }
          lease = next
          this.#lease = next
          lastRenew = next.until - this.#ttlMs
        }
        return true
      }

      let schedules: TickReport['schedules'] = null
      try {
        schedules = freezeScheduleSummary(this.#ops.runDueSchedules(undefined, { shouldContinue }))
      } catch (error) {
        if (isStoreClosedError(error)) {
          return this.#finishClosed(t0, clockJump)
        }
        this.#emitError(error, 'schedules')
      }

      if (lost) {
        this.#lease = null
      }

      let claims: TickReport['claims'] = null
      if (!lost && !stopRun && !closedMidRun && !this.#isStopped()) {
        if (shouldContinue()) {
          try {
            claims = freezeClaimsSummary(
              this.#ops.expireDueClaims(undefined, { limit: this.#claimsPerRun, chunk: this.#claimChunk }),
              this.#claimsPerRun,
            )
          } catch (error) {
            if (isStoreClosedError(error)) {
              closedMidRun = true
              this.#enterClosedState()
            } else {
              this.#emitError(error, 'claims')
            }
          }
        } else if (lost) {
          this.#lease = null
        }
      }

      const nextDelayMs = this.#planAfterRun(lost, schedules, claims)
      return this.#finish(
        makeReport({
          outcome: 'ran',
          at: t0,
          holder: this.holder,
          fence: lease.fence,
          takeover: acq.takeover,
          lost,
          schedules,
          claims,
          clockJump,
          skew: false,
          nextDelayMs,
        }),
      )
    } finally {
      this.#inRun = false
    }
  }

  #isStopped(): boolean {
    return this.#state === 'stopped'
  }

  #advanceRunClock(t0: number): boolean {
    const prev = this.#lastRunAt
    this.#lastRunAt = t0
    return prev !== null && (t0 - prev > this.#ttlMs + 2 * this.#intervalMs || t0 < prev - 1_000)
  }

  #jittered(base: number): number {
    const raw = base * (1 + this.#jitter * (2 * this.#random() - 1))
    return Math.max(TICK_MIN_DELAY_MS, Math.round(raw))
  }

  #isWriteRefusalError(error: unknown): boolean {
    if (this.#store.writeRefusal?.() != null) return true
    if (error instanceof BoardError) {
      if (error.code === 'schema_too_new') return true
      if (
        error.status === 503 &&
        error.code === 'unavailable' &&
        error.retryAfter === undefined &&
        !isStoreClosedError(error) &&
        error.message !== 'storage ended the transaction before it could commit'
      ) {
        return true
      }
    }
    return false
  }

  #planAfterRun(
    lost: boolean,
    schedules: TickReport['schedules'],
    claims: TickReport['claims'],
  ): number {
    if (this.#state === 'stopped') return 0
    if (lost) return this.#jittered(this.#intervalMs)
    const madeClaimProgress = claims !== null && (claims.expired.length > 0 || claims.held.length > 0)
    if (
      (schedules !== null && schedules.stopped) ||
      (claims !== null && claims.backlog && (madeClaimProgress || claims.failed.length === 0))
    ) {
      return TICK_MIN_DELAY_MS
    }
    if (
      schedules === null ||
      claims === null ||
      schedules.failed.length > 0 ||
      claims.failed.length > 0
    ) {
      return this.#intervalMs
    }
    let due: number | null = null
    try {
      const sDue = this.#ops.nextScheduleDueMs()
      const lDue = this.#ops.nextLeaseDueMs()
      if (sDue !== null && lDue !== null) due = Math.min(sDue, lDue)
      else due = sDue ?? lDue
    } catch (error) {
      if (isStoreClosedError(error)) {
        this.#enterClosedState()
        return 0
      }
      this.#emitError(error, 'plan')
      return this.#intervalMs
    }
    if (due === null) return this.#intervalMs
    const now = this.#now()
    const didNothing =
      schedules.sent.length === 0 &&
      schedules.skipped.length === 0 &&
      claims.expired.length === 0 &&
      claims.held.length === 0
    if (due <= now && didNothing) {
      return this.#intervalMs
    }
    return Math.max(TICK_MIN_DELAY_MS, Math.min(this.#intervalMs, due - now))
  }

  #enterClosedState(): void {
    this.#state = 'stopped'
    this.#clearTimer()
    this.#clearSubscription()
    this.#lease = null
  }

  #finishClosed(t0: number, clockJump: boolean): TickReport {
    this.#enterClosedState()
    return this.#finish(
      makeReport({
        outcome: 'closed',
        at: t0,
        holder: null,
        fence: null,
        takeover: false,
        lost: false,
        schedules: null,
        claims: null,
        clockJump,
        skew: false,
        nextDelayMs: 0,
      }),
    )
  }

  #finish(report: TickReport): TickReport {
    this.#runs += 1
    this.#lastReport = report
    this.#pokedAfterPlan = false
    if (this.#onReport) {
      try {
        this.#onReport(report)
      } catch (error) {
        this.#emitError(error, 'report')
      }
    }
    if (this.#state === 'running') {
      const delay = this.#pokedAfterPlan ? Math.min(report.nextDelayMs, TICK_MIN_DELAY_MS) : report.nextDelayMs
      this.#armTimer(delay)
    }
    return report
  }

  #armTimer(delayMs: number): void {
    this.#clearTimer()
    const clamped = Math.max(0, Math.round(delayMs))
    this.#timerDueAt = Date.now() + clamped
    const timer = setTimeout(() => {
      this.#timer = null
      this.#timerDueAt = null
      if (this.#state === 'running') {
        this.runOnce()
      }
    }, clamped)
    timer.unref()
    this.#timer = timer
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
      this.#timerDueAt = null
    }
  }

  #clearSubscription(): void {
    if (this.#unsubscribe !== null) {
      const unsub = this.#unsubscribe
      this.#unsubscribe = null
      try {
        unsub()
      } catch {
        // ignored
      }
    }
  }

  #emitError(error: unknown, site: TickErrorSite): void {
    if (!this.#onError) return
    try {
      this.#onError(error, site)
    } catch {
      // A throwing error hook must never crash the ticker.
    }
  }
}
