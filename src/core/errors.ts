import { ZodError } from 'zod'

export type ErrorOrigin = 'board' | 'handle'

export type BoardErrorOptions = {
  hint?: string
  details?: unknown
  origin?: ErrorOrigin
  retryAfter?: number
}

export type ErrorPayload = {
  error: {
    code: string
    message: string
    hint?: string
    details?: unknown
  }
}

const MESSAGE_TEXT_MAX_BYTES = 10_000

/**
 * Canonical Swarmboard error mapping cleanly to HTTP status codes
 * (`400`, `401`, `402`, `403`, `404`, `408`, `409`, `410`, `413`, `422`, `429`, `501`, `503`).
 */
export class BoardError extends Error {
  readonly status: number
  readonly code: string
  readonly hint: string | undefined
  readonly details: unknown
  readonly origin: ErrorOrigin
  readonly retryAfter: number | undefined

  constructor(status: number, code: string, message: string, options: BoardErrorOptions = {}) {
    super(message)
    this.name = 'BoardError'
    this.status = status
    this.code = code
    this.hint = options.hint
    this.details = options.details
    this.origin = options.origin ?? 'board'
    this.retryAfter = options.retryAfter
  }
}

export const badRequest = (message: string, code = 'invalid_request', options?: BoardErrorOptions): BoardError =>
  new BoardError(400, code, message, options)

export const unauthorized = (message = 'unauthorized', code = 'unauthorized', options?: BoardErrorOptions): BoardError =>
  new BoardError(401, code, message, options)

export const paymentRequired = (message: string, code = 'budget_hard_stop', options?: BoardErrorOptions): BoardError =>
  new BoardError(402, code, message, options)

export const forbidden = (message: string, code = 'forbidden', options?: BoardErrorOptions): BoardError =>
  new BoardError(403, code, message, options)

export const notFound = (message: string, code = 'not_found', options?: BoardErrorOptions): BoardError =>
  new BoardError(404, code, message, options)

export const timeoutError = (message: string, code = 'timeout', options?: BoardErrorOptions): BoardError =>
  new BoardError(408, code, message, options)

export const conflict = (message: string, code = 'conflict', options?: BoardErrorOptions): BoardError =>
  new BoardError(409, code, message, options)

export const gone = (message: string, code = 'lease_expired', options?: BoardErrorOptions): BoardError =>
  new BoardError(410, code, message, options)

export const tooLarge = (message: string, code = 'too_large', options?: BoardErrorOptions): BoardError =>
  new BoardError(413, code, message, options)

export const unprocessable = (message: string, code = 'invalid_envelope', options?: BoardErrorOptions): BoardError =>
  new BoardError(422, code, message, options)

export const rateLimited = (
  message = 'rate limit exceeded',
  retryAfter = 1,
  code = 'rate_limited',
  options?: Omit<BoardErrorOptions, 'retryAfter'>,
): BoardError => new BoardError(429, code, message, { ...options, retryAfter })

export const notImplemented = (message: string, code = 'not_supported', options?: BoardErrorOptions): BoardError =>
  new BoardError(501, code, message, options)

export const unavailable = (message: string, code = 'unavailable', options?: BoardErrorOptions): BoardError =>
  new BoardError(503, code, message, options)

export const textTooLong = (): BoardError =>
  new BoardError(
    400,
    'text_too_long',
    `A message's text is at most ${MESSAGE_TEXT_MAX_BYTES.toLocaleString('en-US')} characters.`,
    {
      hint: 'Put the long part in a file and attach it to a message, with a short summary as the text.',
    },
  )

export const duplicateId = (message = 'that id was already used for a different write'): BoardError =>
  new BoardError(409, 'duplicate_id', message)

/** Its body is the original's, with no `details`: the message says both numbers (original server/errors.ts:49-50). */
export const batchTooLarge = (tasks: number, most: number): BoardError =>
  new BoardError(400, 'batch_too_large', `a batch makes ${most} tasks at most, and this one has ${tasks}: send it in parts`)

function reportedIssue(issue: ZodError['issues'][number]): ZodError['issues'][number] {
  if (issue.code === 'invalid_key' && issue.issues[0]) {
    return reportedIssue({ ...issue.issues[0], path: issue.path.slice(0, -1) })
  }
  if (issue.code !== 'invalid_union' || issue.errors.length === 0) {
    return issue
  }
  const closest = issue.errors.reduce((best, option) => (option.length < best.length ? option : best))
  const first = closest[0]
  return first ? reportedIssue({ ...first, path: [...issue.path, ...first.path] }) : issue
}

export function normalizeError(error: unknown): BoardError {
  if (error instanceof BoardError) return error
  if (error instanceof ZodError) {
    const rawFirst = error.issues[0]
    const issue = rawFirst ? reportedIssue(rawFirst) : undefined
    if (
      issue?.code === 'too_big' &&
      issue.origin === 'string' &&
      issue.maximum === MESSAGE_TEXT_MAX_BYTES &&
      issue.path.length === 1 &&
      issue.path[0] === 'text'
    ) {
      return textTooLong()
    }
    // The first issue only, as the original answers it: `{ code, message }` and no issue list
    // (original server/errors.ts:80-90).
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    return badRequest(`${path}${issue?.message ?? 'invalid request'}`, 'invalid_request')
  }
  const errCode = (error as { code?: unknown } | null)?.code
  const errMsg = error instanceof Error ? error.message : String(error)
  if (errCode === 'INVALID_PAYLOAD') return badRequest(errMsg, 'invalid_request')
  if (errCode === 'PARTIAL_DUPLICATE_BATCH' || errCode === 'DUPLICATE_EVENT_ID') return duplicateId()
  if (errCode === 'STORE_UNAVAILABLE' || errCode === 'STORE_NOT_CONFIGURED') return unavailable(errMsg, 'unavailable')
  if (isStorageBusy(error)) {
    // Another writer held the database past busy_timeout: a retry is what fixes it, not a bug report.
    return unavailable('storage is busy: try again', 'unavailable', { retryAfter: 1 })
  }
  if (errCode === 'ERR_INVALID_STATE' && /database is not open/i.test(errMsg)) {
    return unavailable('storage is closed', 'unavailable')
  }
  return new BoardError(500, 'internal', 'internal error')
}

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), in any of their extended forms, as node:sqlite reports them. */
function isStorageBusy(error: unknown): boolean {
  const e = error as { code?: unknown; errcode?: unknown; errstr?: unknown } | null
  if (e?.code !== 'ERR_SQLITE_ERROR') return false
  if (typeof e.errcode === 'number') {
    const primary = e.errcode & 0xff
    return primary === 5 || primary === 6
  }
  return typeof e.errstr === 'string' && /database (?:table )?is locked/i.test(e.errstr)
}

/**
 * Every error code the board answers with, and its HTTP status: ARCHITECTURE_V2 section 5, plus the
 * few the original also answers that the section leaves out (`invalid_attachment`, `not_a_target`,
 * `internal`, `no_wake_by_url`, `no_wake_by_path`). `schema_not_found` is 404 for a schema read and 400 for a block naming a schema the
 * board doesn't have (original server/serve.ts:457), so it lists both, the first being its usual one.
 */
export const ERROR_STATUSES: Readonly<Record<string, readonly number[]>> = (() => {
  const byStatus: Record<number, readonly string[]> = {
    400: [
      'invalid_request', 'text_too_long', 'batch_too_large', 'reserved_label', 'invalid_block', 'schema_not_found',
      'invalid_schema_id', 'invalid_schema', 'too_many_schemas', 'invalid_cursor', 'invalid_after', 'invalid_needs',
      'invalid_from', 'invalid_can', 'invalid_scope', 'invalid_profile', 'message_deleted', 'not_in_grant',
      'grant_empty', 'invalid_grant', 'too_many_watchers', 'bad_watcher', 'size_mismatch', 'no_url', 'cycle_in_org',
      'max_delegation_depth', 'max_reescalations_reached', 'invalid_fts_query', 'invalid_attachment', 'not_a_target',
      'group_reserved',
    ],
    401: ['unauthorized', 'agent_identity_required', 'token_revoked', 'token_expired'],
    402: ['budget_hard_stop', 'budget_exhausted'],
    403: [
      'forbidden', 'task_not_owned', 'board_not_granted', 'not_a_project', 'depth_exceeded', 'spawn_budget_exhausted',
      'flow_denied', 'captain_role_required', 'agent_cannot_impersonate_human', 'human_verification_required',
    ],
    404: [
      'not_found', 'message_not_found', 'post_not_found', 'batch_not_found', 'not_a_task', 'channel_not_found',
      'grant_not_found', 'schema_not_found', 'schedule_not_found', 'attachment_not_found', 'upload_not_found',
      'no_registration', 'no_match', 'no_item', 'thread_not_found', 'not_synced_here', 'no_board', 'org_not_found',
      'dept_not_found', 'agent_not_found', 'decision_not_found', 'escalation_not_found', 'reservation_not_found',
      'slot_not_found', 'group_not_found', 'pin_not_found', 'notification_not_found', 'token_not_found',
    ],
    408: ['timeout', 'rfc_quorum_timeout'],
    409: [
      'duplicate_id', 'newer_message', 'revision_conflict', 'label_conflict', 'task_claimed', 'task_waiting',
      'task_blocked', 'task_finished', 'task_assigned', 'claim_lost', 'claim_not_held', 'already_a_task',
      'grant_lockout', 'schema_immutable', 'reserved_schema', 'already_synced', 'not_synced', 'not_uploaded',
      'sync_key_taken', 'stale_lease', 'contact_pending', 'contract_superseded', 'stale_contract_digest',
      'active_worker_running', 'already_acked', 'stale_attempt', 'steer_rejected_terminal', 'write_collision',
      'slot_saturated', 'duplicate_agent_id', 'decision_expired', 'snapshot_drift', 'run_paused', 'group_exists',
    ],
    410: ['cursor_expired', 'lease_expired'],
    413: ['too_large', 'budget_exceeded'],
    422: ['dropped', 'correlated_panel_warning', 'invalid_envelope'],
    429: ['rate_limited', 'agent_rate_limited'],
    500: ['internal'],
    501: [
      'no_tasks', 'no_grants', 'no_schemas', 'no_files', 'no_direct_uploads', 'no_scheduler', 'no_verifier', 'not_supported',
      // A board that wakes nothing refuses a registration's wake target (original server/a2.ts:766-767).
      'no_wake_by_url', 'no_wake_by_path',
    ],
    503: ['unavailable', 'backpressure_shed', 'semantic_index_unavailable', 'schema_too_new', 'daemon_unavailable'],
  }
  const out: Record<string, number[]> = {}
  // 404 first, so `schema_not_found`'s usual status leads its list.
  const order = [404, ...Object.keys(byStatus).map(Number).filter((s) => s !== 404)]
  for (const status of order) {
    for (const code of byStatus[status]!) (out[code] ??= []).push(status)
  }
  return Object.freeze(Object.fromEntries(Object.entries(out).map(([code, s]) => [code, Object.freeze(s)])))
})()

/** The HTTP status a known error code answers with, or undefined for a code the board doesn't use. */
export const statusOfCode = (code: string): number | undefined =>
  Object.hasOwn(ERROR_STATUSES, code) ? ERROR_STATUSES[code]![0] : undefined

/**
 * A `BoardError` for a known code, at that code's status. An unknown code is a programming error,
 * so it throws rather than make up a status.
 */
export function errorFor(code: string, message: string, options?: BoardErrorOptions): BoardError {
  const status = statusOfCode(code)
  if (status === undefined) throw new TypeError(`unknown board error code: ${code}`)
  return new BoardError(status, code, message, options)
}

export function toErrorPayload(error: unknown): { status: number; payload: ErrorPayload; retryAfter?: number } {
  const normalized = normalizeError(error)
  const payload: ErrorPayload = {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.hint !== undefined ? { hint: normalized.hint } : {}),
      ...(normalized.details !== undefined ? { details: normalized.details } : {}),
    },
  }
  return {
    status: normalized.status,
    payload,
    ...(normalized.retryAfter !== undefined ? { retryAfter: normalized.retryAfter } : {}),
  }
}

export function toErrorResponse(error: unknown): Response {
  const { status, payload, retryAfter } = toErrorPayload(error)
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {}),
    },
  })
}
