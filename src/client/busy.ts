// SQLite busy classification, busy_timeout helper, and busy-retry wrapper (HOST123_DESIGN 3, 6.3).
// Thick layer: runtime imports only ./retry.ts and ./normalize.ts (which loads ../core/public.ts).
// Every thrown value is classified through normalizeThrown so ClientErrors keep their status/code.
import type { StorageBackend } from '../core/public.ts'
import { normalizeThrown, replacedError } from './normalize.ts'
import { withRetry, type RetryContext, type RetryOptions } from './retry.ts'

export { replacedError }

/** busy_timeout a long-lived Mode 1 process sets after open (F12, F13, OD-5). */
export const LONG_LIVED_BUSY_TIMEOUT_MS = 50

/** normalizeThrown(e) is status 503, code 'unavailable', retryAfter set: not committed, may be sent again. */
export function isRetryableBusy(error: unknown): boolean {
  const n = normalizeThrown(error)
  return (
    n.status === 503 &&
    n.code === 'unavailable' &&
    typeof n.retryAfter === 'number' &&
    Number.isFinite(n.retryAfter)
  )
}

/** The store's own "storage is closed" 503 (text pinned by HS-102). */
export function isStoreClosedError(error: unknown): boolean {
  const n = normalizeThrown(error)
  return (
    n.origin === 'board' &&
    n.status === 503 &&
    n.code === 'unavailable' &&
    n.message === 'storage is closed' &&
    n.retryAfter === undefined
  )
}

/** PRAGMA busy_timeout on this connection only. Integer 0..60_000 else RangeError; closed store: 503. */
export function setBusyTimeout(store: Pick<StorageBackend, 'db'>, ms: number): void {
  if (!Number.isInteger(ms) || ms < 0 || ms > 60_000) {
    throw new RangeError(`busyTimeoutMs must be an integer from 0 to 60000: ${String(ms)}`)
  }
  try {
    store.db.exec(`PRAGMA busy_timeout = ${ms};`)
  } catch (error) {
    throw normalizeThrown(error)
  }
}

/** Async full-jitter busy retry wrapper; rethrows the last error unchanged on give-up, abort, or non-retryable failure. */
export function withBusyRetry<T>(
  fn: (ctx: RetryContext) => T | Promise<T>,
  options?: Omit<RetryOptions, 'isRetryable'>,
): Promise<T> {
  return withRetry(fn, { ...options, isRetryable: isRetryableBusy })
}
