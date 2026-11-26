// Client-side errors (HOST123_DESIGN 3, 5.2). No imports: thin by design, so a later transport can reuse it.
//
// A ClientError has the core error's shape (name 'BoardError', status, code, hint, details, retryAfter) but is a
// different class, so the core's own normalizer would not recognise it and would answer 500. Client and host code
// therefore catches with `isBoardError` and formats with `errorPayload` (or the B4 normalize module), and never
// hands a value that may be a ClientError to the core's error normalizers.

export type ErrorOrigin = 'board' | 'handle'

/** Structural view of the core's BoardError and of ClientError. */
export interface BoardErrorLike extends Error {
  readonly status: number
  readonly code: string
  readonly hint: string | undefined
  readonly details: unknown
  readonly origin: ErrorOrigin
  readonly retryAfter: number | undefined
}

export type ClientErrorCode =
  | 'conflicting_options' | 'invalid_db_path' | 'invalid_url' | 'invalid_mode' | 'invalid_config'
  | 'invalid_profile' | 'invalid_request' // 400
  | 'agent_identity_required' // 401
  | 'config_forbidden' | 'unsafe_config' | 'unsafe_location' | 'profile_mismatch' | 'daemon_required' // 403
  | 'no_board' // 404
  | 'manifest_mismatch' | 'duplicate_id' // 409
  | 'internal' // 500
  | 'not_supported' // 501
  | 'unavailable' | 'backpressure_shed' | 'schema_too_new' | 'daemon_unavailable' // 503

/** Codes that the core also uses keep the core's status (checked by a test); the rest stay client-side for now. */
export const CLIENT_ERROR_STATUSES: Readonly<Record<ClientErrorCode, number>> = Object.freeze({
  conflicting_options: 400,
  invalid_db_path: 400,
  invalid_url: 400,
  invalid_mode: 400,
  invalid_config: 400,
  invalid_profile: 400,
  invalid_request: 400,
  agent_identity_required: 401,
  config_forbidden: 403,
  unsafe_config: 403,
  unsafe_location: 403,
  profile_mismatch: 403,
  daemon_required: 403,
  no_board: 404,
  manifest_mismatch: 409,
  duplicate_id: 409,
  internal: 500,
  not_supported: 501,
  unavailable: 503,
  backpressure_shed: 503,
  schema_too_new: 503,
  daemon_unavailable: 503,
})

export interface ClientErrorOptions {
  hint?: string
  details?: unknown
  retryAfter?: number
  cause?: unknown
}

/** Raised by client-side code (resolver, layout, envelope, identity, key guard, lanes): origin 'handle'. */
export class ClientError extends Error implements BoardErrorLike {
  readonly status: number
  readonly code: string
  readonly hint: string | undefined
  readonly details: unknown
  readonly origin: ErrorOrigin
  readonly retryAfter: number | undefined

  constructor(status: number, code: string, message: string, options: ClientErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'BoardError'
    this.status = status
    this.code = code
    this.hint = options.hint
    this.details = options.details
    this.origin = 'handle'
    this.retryAfter = options.retryAfter
  }
}

/** A ClientError for a known client code, at that code's status. */
export function clientError(code: ClientErrorCode, message: string, options?: ClientErrorOptions): ClientError {
  return new ClientError(CLIENT_ERROR_STATUSES[code], code, message, options)
}

/** True for the core's BoardError and for ClientError. Catch with this, never `instanceof`. */
export function isBoardError(e: unknown): e is BoardErrorLike {
  if (typeof e !== 'object' || e === null) return false
  const v = e as Record<string, unknown>
  return (
    v.name === 'BoardError' &&
    typeof v.message === 'string' &&
    typeof v.status === 'number' &&
    typeof v.code === 'string' &&
    (v.origin === 'board' || v.origin === 'handle')
  )
}

/** The wire form of a BoardErrorLike, the same shape as the core's toErrorPayload; no normalization (pure). */
export function errorPayload(e: BoardErrorLike): {
  status: number
  payload: { error: { code: string; message: string; hint?: string; details?: unknown } }
  retryAfter?: number
} {
  return {
    status: e.status,
    payload: {
      error: {
        code: e.code,
        message: e.message,
        ...(e.hint !== undefined ? { hint: e.hint } : {}),
        ...(e.details !== undefined ? { details: e.details } : {}),
      },
    },
    ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}),
  }
}
