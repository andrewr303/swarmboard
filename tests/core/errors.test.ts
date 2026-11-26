import * as fs from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  badRequest,
  batchTooLarge,
  BoardError,
  conflict,
  duplicateId,
  ERROR_STATUSES,
  errorFor,
  forbidden,
  gone,
  notFound,
  notImplemented,
  paymentRequired,
  PostBodySchema,
  rateLimited,
  statusOfCode,
  textTooLong,
  timeoutError,
  toErrorPayload,
  toErrorResponse,
  tooLarge,
  unauthorized,
  unavailable,
  unprocessable,
} from '../../src/core/index.ts'

describe('BoardError & HTTP Error Mapping', () => {
  it('maps every canonical status helper cleanly', () => {
    const cases: Array<[BoardError, number, string]> = [
      [badRequest('bad', 'invalid_fts_query'), 400, 'invalid_fts_query'],
      [unauthorized('nope'), 401, 'unauthorized'],
      [paymentRequired('budget exceeded', 'budget_hard_stop'), 402, 'budget_hard_stop'],
      [forbidden('agent cannot act as human', 'agent_cannot_impersonate_human'), 403, 'agent_cannot_impersonate_human'],
      [notFound('missing agent', 'agent_not_found'), 404, 'agent_not_found'],
      [timeoutError('quorum timed out', 'rfc_quorum_timeout'), 408, 'rfc_quorum_timeout'],
      [conflict('stale rev', 'revision_conflict'), 409, 'revision_conflict'],
      [gone('lease expired', 'lease_expired'), 410, 'lease_expired'],
      [tooLarge('too big', 'budget_exceeded'), 413, 'budget_exceeded'],
      [unprocessable('correlated panel', 'correlated_panel_warning'), 422, 'correlated_panel_warning'],
      [rateLimited('slow down', 12, 'agent_rate_limited'), 429, 'agent_rate_limited'],
      [notImplemented('not implemented', 'not_supported'), 501, 'not_supported'],
      [unavailable('shedding load', 'backpressure_shed'), 503, 'backpressure_shed'],
    ]

    for (const [err, status, code] of cases) {
      expect(err).toBeInstanceOf(BoardError)
      expect(err.status).toBe(status)
      expect(err.code).toBe(code)
      const { status: outStatus, payload } = toErrorPayload(err)
      expect(outStatus).toBe(status)
      expect(payload.error.code).toBe(code)
      expect(payload.error.message).toBe(err.message)
    }
  })

  it('includes Retry-After header on 429 responses and hint/details when set', async () => {
    const err = rateLimited('agent bucket empty', 7, 'agent_rate_limited', {
      hint: 'Wait before retrying',
      details: { agentId: 'worker-1' },
    })
    const res = toErrorResponse(err)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('7')
    expect(res.headers.get('content-type')).toBe('application/json')
    const json = (await res.json()) as { error: { code: string; hint?: string; details?: unknown } }
    expect(json.error.code).toBe('agent_rate_limited')
    expect(json.error.hint).toBe('Wait before retrying')
    expect(json.error.details).toEqual({ agentId: 'worker-1' })
  })

  it('formats ZodError for text_too_long and closest union / record key issues', () => {
    const longSchema = z.object({ text: z.string().max(10_000) })
    const parsedLong = longSchema.safeParse({ text: 'a'.repeat(10_001) })
    expect(parsedLong.success).toBe(false)
    if (!parsedLong.success) {
      const out = toErrorPayload(parsedLong.error)
      expect(out.status).toBe(400)
      expect(out.payload.error.code).toBe('text_too_long')
    }

    const badPost = PostBodySchema.safeParse({ channel: 'Bad Channel', text: 'hi' })
    expect(badPost.success).toBe(false)
    if (!badPost.success) {
      const out = toErrorPayload(badPost.error)
      expect(out.status).toBe(400)
      expect(out.payload.error.code).toBe('invalid_request')
      expect(out.payload.error.message).toContain('channel')
    }
  })

  it('produces canonical duplicateId, textTooLong, and batchTooLarge errors', () => {
    expect(duplicateId().status).toBe(409)
    expect(duplicateId().code).toBe('duplicate_id')
    expect(textTooLong().code).toBe('text_too_long')
    expect(batchTooLarge(120, 100).status).toBe(400)
    // The original's body carries no details; its message names both numbers (server/errors.ts:49-50).
    expect(batchTooLarge(120, 100).details).toBeUndefined()
    expect(toErrorPayload(batchTooLarge(120, 100)).payload).toEqual({
      error: { code: 'batch_too_large', message: 'a batch makes 100 tasks at most, and this one has 120: send it in parts' },
    })
  })
})

// M1 gate iteration 2.
const CANONICAL_ERROR_MAP: ReadonlyArray<readonly [status: number, codes: readonly string[]]> = [
  [
    400,
    [
      'invalid_request', 'text_too_long', 'batch_too_large', 'reserved_label', 'invalid_block',
      'schema_not_found', 'invalid_schema_id', 'invalid_schema', 'too_many_schemas',
      'invalid_cursor', 'invalid_after', 'invalid_needs', 'invalid_from', 'invalid_can',
      'invalid_scope', 'invalid_profile', 'message_deleted', 'not_in_grant', 'grant_empty',
      'invalid_grant', 'too_many_watchers', 'bad_watcher', 'size_mismatch', 'no_url',
      'cycle_in_org', 'max_delegation_depth', 'max_reescalations_reached', 'invalid_fts_query',
    ],
  ],
  [401, ['unauthorized']],
  [402, ['budget_hard_stop', 'budget_exhausted']],
  [
    403,
    [
      'forbidden', 'task_not_owned', 'board_not_granted', 'not_a_project', 'depth_exceeded',
      'spawn_budget_exhausted', 'flow_denied', 'captain_role_required',
      'agent_cannot_impersonate_human', 'human_verification_required',
    ],
  ],
  [
    404,
    [
      'not_found', 'message_not_found', 'post_not_found', 'batch_not_found', 'not_a_task',
      'channel_not_found', 'grant_not_found', 'schema_not_found', 'schedule_not_found',
      'attachment_not_found', 'upload_not_found', 'no_registration', 'no_match', 'no_item',
      'thread_not_found', 'not_synced_here', 'no_board', 'org_not_found', 'dept_not_found',
      'agent_not_found', 'decision_not_found', 'escalation_not_found', 'reservation_not_found',
      'slot_not_found',
    ],
  ],
  [408, ['timeout', 'rfc_quorum_timeout']],
  [
    409,
    [
      'duplicate_id', 'newer_message', 'revision_conflict', 'label_conflict', 'task_claimed',
      'task_waiting', 'task_blocked', 'task_finished', 'task_assigned', 'claim_lost',
      'claim_not_held', 'already_a_task', 'grant_lockout', 'schema_immutable', 'reserved_schema',
      'already_synced', 'not_synced', 'not_uploaded', 'sync_key_taken', 'stale_lease',
      'contact_pending', 'contract_superseded', 'stale_contract_digest', 'active_worker_running',
      'already_acked', 'stale_attempt', 'steer_rejected_terminal', 'write_collision',
      'slot_saturated', 'duplicate_agent_id', 'decision_expired', 'snapshot_drift', 'run_paused',
    ],
  ],
  [410, ['cursor_expired', 'lease_expired']],
  [413, ['too_large', 'budget_exceeded']],
  [422, ['dropped', 'correlated_panel_warning', 'invalid_envelope']],
  [429, ['rate_limited', 'agent_rate_limited']],
  [
    501,
    [
      'no_tasks', 'no_grants', 'no_schemas', 'no_files', 'no_direct_uploads', 'no_scheduler',
      'no_verifier', 'not_supported',
    ],
  ],
  [503, ['unavailable', 'backpressure_shed', 'semantic_index_unavailable', 'schema_too_new']],
]

describe('the error code registry (V4: canonical HTTP error mapping)', () => {
  it('has every canonical error code at its mapped HTTP status', () => {
    let listed = 0
    for (const [status, codes] of CANONICAL_ERROR_MAP) {
      for (const code of codes) {
        listed += 1
        expect(ERROR_STATUSES[code], code).toContain(status)
      }
    }
    expect(listed).toBeGreaterThan(100)

    // Optional cross-check against internal design archive when present locally.
    const specPath = join(import.meta.dirname, '../../docs/reverse-engineering/ARCHITECTURE_V2.md')
    if (fs.existsSync(specPath)) {
      const spec = fs.readFileSync(specPath, 'utf8')
      const section = spec.slice(spec.indexOf('## 5. Canonical Error Mapping'))
      let specListed = 0
      for (const line of section.split('\n')) {
        const row = /^- `(\d+)`: (.*)$/.exec(line)
        if (!row) continue
        for (const [, code] of row[2]!.matchAll(/`([a-z_]+)`/g)) {
          specListed += 1
          expect(ERROR_STATUSES[code!], code).toContain(Number(row[1]))
        }
      }
      expect(specListed).toBe(listed)
    }
  })

  it('gives each code its usual status, and refuses a code the board does not have', () => {
    expect(statusOfCode('cursor_expired')).toBe(410)
    expect(statusOfCode('no_scheduler')).toBe(501)
    expect(statusOfCode('schema_not_found')).toBe(404)
    expect(ERROR_STATUSES.schema_not_found).toEqual([404, 400])
    expect(statusOfCode('made_up')).toBeUndefined()
    const err = errorFor('sync_key_taken', 'taken')
    expect([err.status, err.code, err.message]).toEqual([409, 'sync_key_taken', 'taken'])
    expect(() => errorFor('made_up', 'x')).toThrow(TypeError)
  })
})

describe('storage and validation failures as the original answers them (V2, N1)', () => {
  it('answers SQLITE_BUSY and SQLITE_LOCKED with a retryable 503, and a closed database with 503', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' })
    const snapshot = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 517 })
    const locked = Object.assign(new Error('database table is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 6 })
    for (const error of [busy, snapshot, locked]) {
      const out = toErrorPayload(error)
      expect([out.status, out.payload.error.code, out.retryAfter]).toEqual([503, 'unavailable', 1])
    }
    const closed = Object.assign(new Error('database is not open'), { code: 'ERR_INVALID_STATE' })
    expect(toErrorPayload(closed).status).toBe(503)
    const other = Object.assign(new Error('no such table: x'), { code: 'ERR_SQLITE_ERROR', errcode: 1 })
    expect(toErrorPayload(other).status).toBe(500)
  })

  it('answers a ZodError with its first issue only, and no issue list (original server/errors.ts:80-90)', () => {
    const parsed = z.object({ a: z.string(), b: z.string() }).safeParse({})
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const out = toErrorPayload(parsed.error)
      expect(Object.keys(out.payload.error).sort()).toEqual(['code', 'message'])
      expect(out.payload.error.message.startsWith('a: ')).toBe(true)
    }
  })
})
