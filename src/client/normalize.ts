// Error normalization for every client and host path (HOST123_DESIGN 3, 5.2; CR-4, F27). Thick: it loads the
// core's public surface for its normalizer and error class.
//
// The core's own normalizer recognises only its BoardError class, so a ClientError (same shape, other class) given
// to it would come back as 500 'internal'. Every client and host path therefore turns a thrown value into a status
// here: a BoardErrorLike (the core's or a ClientError) passes through as the same object, anything else goes to the
// core's normalizer, with the original value kept as `cause`. This module is the only client or host file that
// calls the core's normalizer (HS-03 scans for it).
import { BoardError, normalizeError } from '../core/public.ts'
import { errorPayload, isBoardError, type BoardErrorLike } from './errors.ts'

/** BoardErrorLike (core or client) passes as the same object; anything else becomes the core's mapping, cause = e. */
export function normalizeThrown(e: unknown): BoardErrorLike {
  if (isBoardError(e)) return e
  const mapped = normalizeError(e)
  if (mapped !== e) {
    try {
      Object.defineProperty(mapped, 'cause', { value: e, writable: true, configurable: true, enumerable: false })
    } catch {
      // A frozen error keeps no cause; the mapping still stands.
    }
  }
  return mapped
}

/** errorPayload(normalizeThrown(e)): equals the core's payload for every value that is not a ClientError. */
export function clientErrorPayload(e: unknown): ReturnType<typeof errorPayload> {
  return errorPayload(normalizeThrown(e))
}

/**
 * The one sticky error of a board file replaced under this process (HOST0 6.4; designs g2 2.3 closeAndStop): a 503
 * with no retryAfter, so no retry policy sends the call again. Every later call on the path gets it; only a new
 * process opens the path again. The WakeBridge and the transports share this text.
 */
export function replacedError(path: string): BoardError {
  return new BoardError(
    503,
    'unavailable',
    `the board file ${path} was replaced or removed while this process had it open: this process closed it and will not reopen it`,
    {
      hint: 'stop every process using this board, follow the restore procedure (remove -wal and -shm only once nothing holds the path), check the file, then restart',
      details: { reason: 'replaced', path },
    },
  )
}
