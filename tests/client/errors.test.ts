// HS-03 (B1 part): the client error class, its structural guard and the pure wire form. The normalize half of
// HS-03 belongs to B4 (tests/client/normalize.test.ts).
import { describe, expect, it } from 'vitest'
import { BoardError, ERROR_STATUSES } from '../../src/core/public.ts'
import {
  CLIENT_ERROR_STATUSES,
  ClientError,
  clientError,
  errorPayload,
  isBoardError,
  type ClientErrorCode,
} from '../../src/client/errors.ts'
import { CLIENT_VERSION, PROTOCOL_VERSION } from '../../src/client/version.ts'

describe('client errors (HS-03)', () => {
  it('HS-03 ClientError has the core error shape with origin handle', () => {
    const e = new ClientError(403, 'unsafe_config', 'm', { details: { a: 1 } })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('BoardError')
    expect(e.status).toBe(403)
    expect(e.code).toBe('unsafe_config')
    expect(e.message).toBe('m')
    expect(e.origin).toBe('handle')
    expect(e.details).toEqual({ a: 1 })
    expect(e.hint).toBeUndefined()
    expect(e.retryAfter).toBeUndefined()
    const cause = new Error('inner')
    expect(new ClientError(400, 'invalid_config', 'x', { cause, hint: 'h', retryAfter: 2 })).toMatchObject({
      cause,
      hint: 'h',
      retryAfter: 2,
    })
  })

  it('HS-03 isBoardError is structural: core and client errors yes, look-alikes no', () => {
    expect(isBoardError(new ClientError(403, 'unsafe_config', 'm'))).toBe(true)
    expect(isBoardError(new BoardError(409, 'x', 'y'))).toBe(true)
    expect(isBoardError(new Error())).toBe(false)
    expect(isBoardError({ status: 1, code: 'x' })).toBe(false)
    expect(isBoardError(null)).toBe(false)
    expect(isBoardError('BoardError')).toBe(false)
    const named = Object.assign(new Error('m'), { status: 'x', code: 'c' })
    named.name = 'BoardError'
    expect(isBoardError(named)).toBe(false)
  })

  it('HS-03 every client code that the core also knows has the core status; daemon_required is 403', () => {
    let shared = 0
    for (const [code, status] of Object.entries(CLIENT_ERROR_STATUSES)) {
      if (Object.hasOwn(ERROR_STATUSES, code)) {
        shared += 1
        expect(ERROR_STATUSES[code]![0], code).toBe(status)
      }
    }
    expect(shared).toBeGreaterThanOrEqual(11)
    expect(CLIENT_ERROR_STATUSES.backpressure_shed).toBe(503)
    expect(CLIENT_ERROR_STATUSES.duplicate_id).toBe(409)
    expect(CLIENT_ERROR_STATUSES.daemon_required).toBe(403)
    expect(CLIENT_ERROR_STATUSES.agent_identity_required).toBe(401)
    expect(CLIENT_ERROR_STATUSES.daemon_unavailable).toBe(503)
    expect(Object.isFrozen(CLIENT_ERROR_STATUSES)).toBe(true)
  })

  it('HS-03 clientError takes the status from the table', () => {
    const codes = Object.keys(CLIENT_ERROR_STATUSES) as ClientErrorCode[]
    expect(codes.length).toBe(22)
    for (const code of codes) {
      const e = clientError(code, 'm')
      expect(e.status).toBe(CLIENT_ERROR_STATUSES[code])
      expect(e.code).toBe(code)
      expect(e.origin).toBe('handle')
    }
  })

  it('HS-03 errorPayload is pure and has the same shape as the core toErrorPayload', () => {
    const e = new ClientError(403, 'unsafe_location', 'm', { details: { reasons: ['symlink'] } })
    expect(errorPayload(e)).toEqual({
      status: 403,
      payload: { error: { code: 'unsafe_location', message: 'm', details: { reasons: ['symlink'] } } },
    })
    const busy = new ClientError(503, 'backpressure_shed', 'slow down', { retryAfter: 1, hint: 'wait' })
    const p = errorPayload(busy)
    expect(p.status).toBe(503)
    expect(p.retryAfter).toBe(1)
    expect(p.payload.error.hint).toBe('wait')
    // no undefined keys: the payload serializes like the core's
    expect(Object.keys(errorPayload(new ClientError(404, 'no_board', 'm')))).toEqual(['status', 'payload'])
    expect(Object.keys(errorPayload(new ClientError(404, 'no_board', 'm')).payload.error)).toEqual(['code', 'message'])
    // a core BoardError formats too (structural)
    expect(errorPayload(new BoardError(409, 'duplicate_id', 'd')).status).toBe(409)
  })

  it('HS-03 version constants', () => {
    expect(CLIENT_VERSION).toBe('0.2.0')
    expect(PROTOCOL_VERSION).toBe(1)
  })
})
