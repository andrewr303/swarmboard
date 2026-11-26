import { describe, expect, it } from 'vitest'
import {
  BlockTaskBody,
  BoardError,
  ClaimReadyTaskBody,
  CreateTaskBody,
  CreateTasksBody,
  RenewTaskBody,
  taskLimits,
  TasksQuery,
} from '../../../src/core/index.ts'

const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }): string[] =>
  result.success ? [] : result.error!.issues.map((i) => i.message)

const refused = (fn: () => void): BoardError => {
  try {
    fn()
  } catch (error) {
    if (error instanceof BoardError) return error
    throw error
  }
  throw new Error('not refused')
}

describe('A1 request bodies, ported from the original api/routes.ts', () => {
  it('CreateTaskBody: exactly one of channel and re, a new thread needs text, re takes nothing of a post, lease and token need claim', () => {
    expect(messages(CreateTaskBody.safeParse({ text: 'x' }))).toContain(
      "a task needs `channel` and `text` for a new thread, or `re` for a thread that's there",
    )
    expect(messages(CreateTaskBody.safeParse({ channel: 'dev', text: '  ' }))).toContain('message text is empty')
    expect(messages(CreateTaskBody.safeParse({ re: '4', text: 'x' }))).toContain(
      "`text`, `labels`, `noSync`, `attachments`, and `id` are a new thread's: `re` makes a task of a thread as it is",
    )
    expect(messages(CreateTaskBody.safeParse({ channel: 'dev', text: 'x', lease: 60 }))).toContain('`lease` goes with `claim`')
    expect(messages(CreateTaskBody.safeParse({ channel: 'dev', text: 'x', token: 'a'.repeat(43) }))).toContain('`token` goes with `claim`')
    expect(messages(CreateTaskBody.safeParse({ channel: 'dev', text: 'x', claim: true, token: 'short' }))).toContain(
      'a claim token is 32 bytes in base64url: 43 characters',
    )
    // Non-strict: unknown keys are stripped (original api/routes.ts:396).
    const ok = CreateTaskBody.parse({ channel: 'dev', text: 'x', claim: true, lease: 60, extra: 1 })
    expect(ok).toEqual({ channel: 'dev', text: 'x', claim: true, lease: 60 })
  })

  it('BlockTaskBody refuses the board\'s own kind and a half claim; batch needs take ids or {key}', () => {
    expect(messages(BlockTaskBody.safeParse({ reason: 'r', kind: 'edited' }))).toContain(
      "`edited` is the board's own kind, for a task whose root someone else edited: name another",
    )
    expect(messages(BlockTaskBody.safeParse({ reason: 'r', epoch: 1 }))).toContain(
      'a claim is its `epoch` and its `token`: pass both, or neither',
    )
    expect(messages(BlockTaskBody.safeParse({ reason: ' ' }))).toContain('it is empty')
    expect(CreateTasksBody.safeParse({ channel: 'dev', tasks: [{ text: 'a', needs: ['3', { key: 'b' }] }] }).success).toBe(true)
    expect(CreateTasksBody.safeParse({ channel: 'dev', tasks: [{ text: 'a', needs: [{ key: 'b', x: 1 }] }] }).success).toBe(false)
    expect(RenewTaskBody.safeParse({ epoch: 0, token: 't' }).success).toBe(false)
    expect(ClaimReadyTaskBody.safeParse({ channel: 'work/' }).success).toBe(true)
    expect(ClaimReadyTaskBody.safeParse({ channel: 'dev', wait: 301 }).success).toBe(false)
    expect(TasksQuery.safeParse({ latest: 'true', after: '3' }).success).toBe(false)
    expect(TasksQuery.parse({ label: 'area=ui', limit: '10' })).toMatchObject({ label: [['area', ['ui']]], limit: 10 })
  })

  it('taskLimits: the local board\'s own limits, 400 invalid_request with the original\'s messages', () => {
    const lease = refused(() => taskLimits.lease(29))
    expect([lease.status, lease.code, lease.message]).toEqual([400, 'invalid_request', 'lease: a lease is 30 to 3600 seconds'])
    expect(() => taskLimits.lease(30)).not.toThrow()
    expect(() => taskLimits.lease(3601)).toThrow('lease: a lease is 30 to 3600 seconds')
    expect(() => taskLimits.needs(Array.from({ length: 21 }, (_, i) => String(i + 1)))).toThrow('needs: a task waits for at most 20 tasks')
    // Repeats count once.
    expect(() => taskLimits.needs([...Array.from({ length: 20 }, (_, i) => String(i + 1)), '1'])).not.toThrow()
    expect(() => taskLimits.note('result', 'x'.repeat(1001))).toThrow("result: a task's result is at most 1,000 characters")
    expect(() => taskLimits.kind('k'.repeat(65))).toThrow('kind: a kind is up to 64 lowercase letters, numbers, and _.-')
    expect(() => taskLimits.from(Array.from({ length: 33 }, (_, i) => `p:${i}`))).toThrow('from: a claim takes tasks from at most 32 owners')
    const big = refused(() => taskLimits.batch(Array.from({ length: 101 }, () => ({}))))
    expect([big.status, big.code, big.message]).toEqual([400, 'batch_too_large', 'a batch makes 100 tasks at most, and this one has 101: send it in parts'])
    expect(() => taskLimits.batch([{ key: 'k'.repeat(65) }])).toThrow("tasks.0.key: a task's key is at most 64 characters")
  })
})

describe('TasksQuery flags (round-1 compat nit)', () => {
  it("a bad `latest` gets the original's enum error verbatim; the strings and an in-process boolean read as before", () => {
    const bad = TasksQuery.safeParse({ latest: 'yes' })
    expect(bad.success).toBe(false)
    expect(bad.error!.issues.map((i) => [i.code, i.path, i.message])).toEqual([
      ['invalid_value', ['latest'], 'Invalid option: expected one of "0"|"1"|"true"|"false"'],
    ])
    for (const [sent, read] of [['true', true], ['1', true], ['false', false], ['0', false], [true, true], [false, false]] as const) {
      expect(TasksQuery.parse({ latest: sent }).latest).toBe(read)
    }
    expect(TasksQuery.parse({}).latest).toBeUndefined()
  })
})
