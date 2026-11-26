// Generic full-jitter async retry wrapper (HOST123_DESIGN 3, 6.3, CON-1). Thin: zero runtime imports,
// so later socket and HTTP transports can reuse it without loading the core or zod.

export interface RetryPolicy {
  readonly baseMs: number
  readonly capMs: number
  readonly budgetMs: number
  readonly maxAttempts: number
}

export const DEFAULT_BUSY_RETRY: Readonly<RetryPolicy> = Object.freeze({
  baseMs: 5,
  capMs: 100,
  budgetMs: 30_000,
  maxAttempts: 10_000,
})

/** An attempt that ran this long before it failed made progress: the budget clock restarts at its failure (CON-1). */
export const RETRY_STREAK_BREAK_MS = 1_000

/** min(capMs, baseMs * 2 ** (attempt - 1)) for attempt >= 1. */
export function backoffCeiling(attempt: number, policy: RetryPolicy): number {
  if (policy.baseMs <= 0 || policy.capMs <= 0) return 0
  if (attempt <= 1) return Math.min(policy.capMs, policy.baseMs)
  return Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1))
}

/** elapsedMs: since the call's first attempt started (a wait op computes its remaining wait from it). */
export interface RetryContext {
  readonly attempt: number
  readonly elapsedMs: number
  readonly signal: AbortSignal | undefined
}

export interface RetryOptions {
  readonly isRetryable: (error: unknown) => boolean
  readonly policy?: Partial<RetryPolicy>
  /**
   * 'call' (default): the budget counts from the first attempt's start. 'streak': it counts from the call start,
   * or from the failure of the latest attempt that ran >= RETRY_STREAK_BREAK_MS, whichever is later. Transports
   * pass 'streak' for wait ops (laneKind 'wait'), so a busy look late in a long wait is retried (F23).
   */
  readonly budgetFrom?: 'call' | 'streak'
  readonly signal?: AbortSignal
  readonly onRetry?: (info: { readonly attempt: number; readonly delayMs: number; readonly error: unknown }) => void
  readonly now?: () => number
  readonly random?: () => number
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onDone = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onDone)
      resolve()
    }
    const timer = setTimeout(onDone, ms)
    signal?.addEventListener('abort', onDone, { once: true })
  })
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<T>).then === 'function'
  )
}

/**
 * Full jitter backoff. Rethrows the LAST error unchanged (same object) on a non-retryable error, budget exhaustion,
 * maxAttempts, or abort.
 */
export async function withRetry<T>(fn: (ctx: RetryContext) => T | Promise<T>, options: RetryOptions): Promise<T> {
  const policy: RetryPolicy = {
    baseMs: options.policy?.baseMs ?? DEFAULT_BUSY_RETRY.baseMs,
    capMs: options.policy?.capMs ?? DEFAULT_BUSY_RETRY.capMs,
    budgetMs: options.policy?.budgetMs ?? DEFAULT_BUSY_RETRY.budgetMs,
    maxAttempts: options.policy?.maxAttempts ?? DEFAULT_BUSY_RETRY.maxAttempts,
  }
  if (!Number.isFinite(policy.baseMs) || policy.baseMs < 0) {
    throw new RangeError(`retry baseMs must be a finite number >= 0: ${String(policy.baseMs)}`)
  }
  if (!Number.isFinite(policy.capMs) || policy.capMs < 0) {
    throw new RangeError(`retry capMs must be a finite number >= 0: ${String(policy.capMs)}`)
  }
  if (typeof policy.budgetMs !== 'number' || Number.isNaN(policy.budgetMs) || policy.budgetMs < 0) {
    throw new RangeError(`retry budgetMs must be >= 0: ${String(policy.budgetMs)}`)
  }
  if (typeof policy.maxAttempts !== 'number' || Number.isNaN(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError(`retry maxAttempts must be >= 1: ${String(policy.maxAttempts)}`)
  }

  const budgetFrom = options.budgetFrom ?? 'call'
  const signal = options.signal
  const now = options.now ?? (() => performance.now())
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? defaultSleep

  const callStart = now()
  let budgetStart = callStart
  let attempt = 0

  for (;;) {
    attempt += 1
    const attemptStart = attempt === 1 ? callStart : now()
    const elapsedMs = Math.max(0, attemptStart - callStart)
    try {
      const out = fn({ attempt, elapsedMs, signal })
      if (isPromiseLike(out)) return await out
      return out
    } catch (error) {
      if (!options.isRetryable(error) || attempt >= policy.maxAttempts || signal?.aborted) {
        throw error
      }
      const failedAt = now()
      if (budgetFrom === 'streak' && failedAt - attemptStart >= RETRY_STREAK_BREAK_MS) {
        budgetStart = failedAt
      }
      const delay = Math.max(1, Math.floor(random() * backoffCeiling(attempt, policy)))
      if (failedAt - budgetStart + delay > policy.budgetMs) {
        throw error
      }
      try {
        options.onRetry?.({ attempt, delayMs: delay, error })
      } catch {
        // An observer error must not stop retries.
      }
      try {
        await sleep(delay, signal)
      } catch (sleepError) {
        if (signal?.aborted) throw error
        throw sleepError
      }
      if (signal?.aborted) {
        throw error
      }
    }
  }
}
