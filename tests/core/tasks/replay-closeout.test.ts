// M2 slice A closeout (verification round 2): replays follow the original (lead decision D1).
// (a) a batch sent again under an `id` that landed is answered from the landed batch before any grant,
//     limit, ownId, assignee or needs check (original serve.ts:978-994 createdTasks, a2.ts:679-686);
// (b) a single create sent again is judged from the writer's own append (original writes.ts:297-314
//     landedFor, a2.ts:648-650), so a blind poster can't tell whether a reader adopted its post;
// (c) a blind writer's replay never shows what changed after its write.
import { afterEach, describe, expect, it } from 'vitest'
import type { CallerContext } from '../../../src/core/index.ts'
import { alice, eventCount, makeBoard, type Board } from './helpers.ts'
import { outcome, refusal, userWith } from './verb-helpers.ts'

const boards: Board[] = []
const open = (): Board => {
  const b = makeBoard()
  boards.push(b)
  // Only the grants each test gives: alice owns the board, everyone else gets what the test says.
  for (const g of b.board.listGrants(alice)) b.board.revokeGrant(alice, g.id, {})
  b.board.createGrant(alice, { principals: [{ kind: 'user', userId: 'alice' }], can: { '*': 'all' } } as never)
  return b
}
afterEach(() => {
  while (boards.length > 0) boards.pop()!.close()
})

type Can = Record<string, ('read' | 'post' | 'label' | 'react')[]>
const grant = (b: Board, userId: string, can: Can): { id: string } =>
  b.board.createGrant(alice, { principals: [{ kind: 'user', userId }], can } as never) as { id: string }

type Asked = { key?: string; text: string; needs?: (string | { key: string })[]; for?: string | null; attachments?: string[]; labels?: Record<string, string> }
const createTasks = (b: Board, as: CallerContext, channel: string, tasks: Asked[], more: Record<string, unknown> = {}) =>
  b.board.tasks.createTasks(as, { channel, tasks, ...more })

const PLAN: Asked[] = [{ key: 'a', text: 'one' }, { key: 'b', text: 'two', needs: [{ key: 'a' }] }]
const files = Array.from({ length: 11 }, (_, n) => `${'A'.repeat(21)}${String.fromCharCode(65 + n)}`)

/** Requests that today's checks refuse, each in its own way, under a batch's `id`. */
const INVALID: Record<string, { tasks: Asked[]; code: string }> = {
  'a key cycle': { tasks: [{ key: 'a', text: 'one', needs: [{ key: 'b' }] }, { key: 'b', text: 'two', needs: [{ key: 'a' }] }], code: 'invalid_needs' },
  "another principal's profile": { tasks: [{ key: 'a', text: 'one', for: 'local:user:zz+x' }], code: 'invalid_request' },
  'a key over 64': { tasks: [{ key: 'k'.repeat(65), text: 'one' }], code: 'invalid_request' },
  'text over 10,000': { tasks: [{ text: 'x'.repeat(10_001) }], code: 'text_too_long' },
  'eleven files': { tasks: [{ text: 'with files', attachments: files }], code: 'invalid_request' },
}

describe('closeout F-1 / ACL-R2-2: a batch under an id that landed is answered before any check', () => {
  it('closeout F-1 (1) a retry after the post grant is revoked answers the landed batch, and writes nothing', () => {
    const b = open()
    const g = grant(b, 'wk', { 'jobs/': ['read', 'post', 'label'] })
    const wk = userWith('wk')
    const first = createTasks(b, wk, 'jobs/a', PLAN, { id: 'B1' })
    b.board.revokeGrant(alice, g.id, {})
    grant(b, 'wk', { 'jobs/': ['read'] })
    const events = eventCount(b)
    const again = createTasks(b, wk, 'jobs/a', PLAN, { id: 'B1' })
    expect(again).toEqual(b.board.tasks.getBatch(wk, 'B1'))
    expect(again.tasks.map((root) => root.id)).toEqual(first.tasks.map((root) => root.id))
    expect(eventCount(b)).toBe(events)
    // Once it can't read either, a batch it wrote where it read is no longer its to have back (original
    // writes.ts:303-306 landedFor): getBatch says none, and the retry is judged as any new request.
    for (const left of b.board.listGrants(alice)) if (left.id !== g.id && JSON.stringify(left).includes('wk')) b.board.revokeGrant(alice, left.id, {})
    const revoked = eventCount(b)
    expect(refusal(() => b.board.tasks.getBatch(wk, 'B1'))[1]).toBe('batch_not_found')
    expect(refusal(() => createTasks(b, wk, 'jobs/a', PLAN, { id: 'B1' }))).toEqual([403, 'forbidden', "this token can't post in jobs/a"])
    expect(eventCount(b)).toBe(revoked)
    // A batch id that never landed is judged on the grants as they are now.
    expect(refusal(() => createTasks(b, wk, 'jobs/a', PLAN, { id: 'B2' }))).toEqual([403, 'forbidden', "this token can't post in jobs/a"])
  })

  it('closeout ACL-R2-2 a blind poster whose post grant is revoked gets its landed batch back, as getBatch does', () => {
    const b = open()
    const g = grant(b, 'carol', { pub: ['post'] })
    const carol = userWith('carol')
    const tasks: Asked[] = [{ text: 'x' }, { text: 'y', for: 'local:user:carol+x' }]
    const first = createTasks(b, carol, 'pub', tasks, { id: 'cb' })
    // alice takes the task on: the blind poster's answer stays what its own write made.
    b.board.tasks.claimTask(alice, first.tasks[0]!.id, {})
    b.board.revokeGrant(alice, g.id, {})
    const events = eventCount(b)
    const again = createTasks(b, carol, 'pub', tasks, { id: 'cb' })
    expect(again).toEqual(b.board.tasks.getBatch(carol, 'cb'))
    expect(again).toEqual({ tasks: first.tasks })
    expect(eventCount(b)).toBe(events)
  })

  it('closeout F-1 (2) a retry the checks of today refuse answers the landed batch: limits, needs, assignee, files', () => {
    const b = open()
    grant(b, 'wk', { 'jobs/': ['read', 'post', 'label'] })
    const wk = userWith('wk')
    // A request that says its own digest is the same request whatever its tasks: what a board of
    // today would refuse in it was the landed batch's, under the limits of the day it landed.
    const first = createTasks(b, wk, 'jobs/a', PLAN, { id: 'R1', request: 'the release plan' })
    const events = eventCount(b)
    for (const [what, { tasks }] of Object.entries(INVALID)) {
      const again = createTasks(b, wk, 'jobs/a', tasks, { id: 'R1', request: 'the release plan' })
      expect(again.tasks.map((root) => root.id), what).toEqual(first.tasks.map((root) => root.id))
    }
    expect(eventCount(b)).toBe(events)
    // The same, sent where the caller may no longer post or label.
    expect(createTasks(b, wk, 'elsewhere', [{ text: 'z', labels: { step: 'x' } }], { id: 'R1', request: 'the release plan' }).tasks).toEqual(
      first.tasks,
    )
    expect(eventCount(b)).toBe(events)
  })

  it('closeout F-1 (3) another request under the landed id is 409 duplicate_id before any limit or check, as the original', () => {
    const b = open()
    grant(b, 'wk', { 'jobs/': ['read', 'post', 'label'] })
    const wk = userWith('wk')
    createTasks(b, wk, 'jobs/a', PLAN, { id: 'B1' })
    const events = eventCount(b)
    for (const [what, { tasks }] of Object.entries(INVALID)) {
      expect(refusal(() => createTasks(b, wk, 'jobs/a', tasks, { id: 'B1' })), what).toEqual([
        409,
        'duplicate_id',
        'that id was already used for a different write',
      ])
    }
    // Where the caller can't post, another request under its landed id is 409 too, not 403.
    expect(refusal(() => createTasks(b, wk, 'elsewhere', PLAN, { id: 'B1' }))[1]).toBe('duplicate_id')
    // What the original's transport and board() refuse before createdTasks still comes first:
    // too many tasks, a misshapen body, and a `board.*` label (serve.ts:174-180, protocol, ownLabels).
    const many = Array.from({ length: 101 }, (_, n) => ({ text: `t${n}` }))
    expect(refusal(() => createTasks(b, wk, 'jobs/a', many, { id: 'B1' }))[1]).toBe('batch_too_large')
    expect(refusal(() => createTasks(b, wk, 'jobs/a', [], { id: 'B1' }))[1]).toBe('invalid_request')
    expect(refusal(() => createTasks(b, wk, 'jobs/a', [{ text: 'one', labels: { 'board.task': 'x' } }], { id: 'B1' }))[1]).toBe('reserved_label')
    expect(eventCount(b)).toBe(events)
  })

  it('closeout F-1 (4) a batch id that has not landed still runs every check, in the order it did', () => {
    const b = open()
    grant(b, 'wk', { 'jobs/': ['read', 'post', 'label'], 'ro/': ['read'], 'po/': ['read', 'post'] })
    const wk = userWith('wk')
    const events = eventCount(b)
    for (const [what, { tasks, code }] of Object.entries(INVALID)) {
      expect(refusal(() => createTasks(b, wk, 'jobs/a', tasks, { id: 'fresh' }))[1], what).toBe(code)
    }
    // Limits before grants, grants before the id, the id before the assignee and the needs.
    expect(refusal(() => createTasks(b, wk, 'ro/a', [{ text: 'x'.repeat(10_001) }], { id: 'fresh' }))[1]).toBe('text_too_long')
    expect(refusal(() => createTasks(b, wk, 'ro/a', PLAN, { id: 'fresh' }))).toEqual([403, 'forbidden', "this token can't post in ro/a"])
    expect(refusal(() => createTasks(b, wk, 'po/a', [{ text: 'one', labels: { step: 'x' } }], { id: 'fresh' }))).toEqual([
      403,
      'forbidden',
      "this token can't label in po/a",
    ])
    expect(refusal(() => createTasks(b, wk, 'jobs/a', PLAN, { id: '0f8fad5b-d9cb-8469-a165-70867728950e' }))[1]).toBe('invalid_request')
    expect(
      refusal(() => createTasks(b, wk, 'ro/a', [{ text: 'one', for: 'local:user:zz+x' }], { id: '0f8fad5b-d9cb-8469-a165-70867728950e' })),
    ).toEqual([403, 'forbidden', "this token can't post in ro/a"])
    expect(eventCount(b)).toBe(events)
    // Someone else's batch is none of the caller's: it runs every check, then is another write's.
    const mine = createTasks(b, alice, 'jobs/a', PLAN, { id: 'theirs' })
    const after = eventCount(b)
    expect(refusal(() => createTasks(b, wk, 'jobs/a', [{ text: 'x'.repeat(10_001) }], { id: 'theirs' }))[1]).toBe('text_too_long')
    expect(refusal(() => createTasks(b, wk, 'ro/a', PLAN, { id: 'theirs' }))[1]).toBe('forbidden')
    expect(refusal(() => createTasks(b, wk, 'jobs/a', INVALID['a key cycle']!.tasks, { id: 'theirs' }))[1]).toBe('invalid_needs')
    expect(refusal(() => createTasks(b, wk, 'jobs/a', PLAN, { id: 'theirs' }))).toEqual([409, 'duplicate_id', 'that id was already used for a different write'])
    expect(eventCount(b)).toBe(after)
    // And a fresh id with a good request lands.
    expect(createTasks(b, wk, 'jobs/a', PLAN, { id: 'fresh' }).tasks).toHaveLength(2)
    expect(mine.tasks).toHaveLength(2)
  })
})

describe('closeout ACL-R2-1: a create sent again is judged from the writer’s own append', () => {
  it('closeout ACL-R2-1 (5) a blind poster’s create retry of its plain post is 409 whether or not a reader adopted it', () => {
    const b = open()
    grant(b, 'carol', { dev: ['post'] })
    const carol = userWith('carol')
    b.board.postMessage(carol, { channel: 'dev', text: 'plain A', id: 'blind-A' })
    const adopted = b.board.postMessage(carol, { channel: 'dev', text: 'plain B', id: 'blind-B' }).message.id
    const before = refusal(() => b.board.tasks.createTask(carol, { channel: 'dev', text: 'plain B', id: 'blind-B' }))
    expect(before).toEqual([409, 'duplicate_id', 'that id was already used for a different write'])
    // A reader makes B a task, where carol can't see it.
    b.board.tasks.createTask(alice, { re: adopted })
    const events = eventCount(b)
    const never = refusal(() => b.board.tasks.createTask(carol, { channel: 'dev', text: 'plain A', id: 'blind-A' }))
    const after = refusal(() => b.board.tasks.createTask(carol, { channel: 'dev', text: 'plain B', id: 'blind-B' }))
    expect(after).toEqual(never)
    expect(after).toEqual(before)
    // Under another text, or another author's id, the same answer too.
    expect(refusal(() => b.board.tasks.createTask(carol, { channel: 'dev', text: 'other', id: 'blind-B' }))).toEqual(before)
    expect(eventCount(b)).toBe(events)
    // What carol can learn of B is only what getPosted gives a blind writer: its post as it sent it, no task.
    expect(b.board.getPosted(carol, 'blind-B').message.task ?? null).toBeNull()
  })

  it('closeout ACL-R2-1 (6) a writer’s own create retry still answers its task: a blind one as made, a reader with its claim', () => {
    const b = open()
    grant(b, 'carol', { dev: ['post'] })
    grant(b, 'dan', { dev: ['read', 'post', 'label'] })
    const carol = userWith('carol')
    const dan = userWith('dan')
    const TOKEN = 'T'.repeat(43)
    const blind = b.board.tasks.createTask(carol, { channel: 'dev', text: 'my task', id: 'own-carol' })
    const read = b.board.tasks.createTask(dan, { channel: 'dev', text: 'my task', id: 'own-dan', claim: true, token: TOKEN })
    const events = eventCount(b)
    const blindAgain = b.board.tasks.createTask(carol, { channel: 'dev', text: 'my task', id: 'own-carol' })
    expect(blindAgain).toEqual(blind)
    expect(blindAgain.task.task).toMatchObject({ state: 'ready', owner: 'local:user:carol' })
    const readAgain = b.board.tasks.createTask(dan, { channel: 'dev', text: 'my task', id: 'own-dan', claim: true, token: TOKEN })
    expect(readAgain.task.id).toBe(read.task.id)
    expect(readAgain.task.task).toMatchObject({ state: 'claimed', epoch: 1 })
    expect(readAgain.claim).toEqual(read.claim)
    expect(readAgain.task).toEqual(read.task)
    expect(eventCount(b)).toBe(events)
  })

  it('closeout ACL-R2-1 (7) a blind writer’s replay shows the task as its write left it, never what came after', () => {
    const b = open()
    grant(b, 'carol', { dev: ['post'] })
    const carol = userWith('carol')
    const made = b.board.tasks.createTask(carol, { channel: 'dev', text: 'deploy', id: 'blind-task' })
    // After the write: alice claims it, replies in its thread, and gives it a label.
    const taken = b.board.tasks.claimTask(alice, made.task.id, {})
    b.board.postMessage(alice, { re: made.task.id, text: 'on it' })
    b.board.labelMessage(alice, made.task.id, { set: { step: 'two' } })
    expect(taken.task.task?.state).toBe('claimed')
    const events = eventCount(b)
    const again = b.board.tasks.createTask(carol, { channel: 'dev', text: 'deploy', id: 'blind-task' })
    expect(again).toEqual(made)
    expect(again.task.task).toMatchObject({ state: 'ready', epoch: 0, claim: null, for: null })
    expect(again.task.labels).toEqual({ 'board.task': 'ready' })
    expect(eventCount(b)).toBe(events)
    // And a blind batch writer's replay, likewise, in getBatch's shape.
    const filed = createTasks(b, carol, 'dev', PLAN, { id: 'blind-batch' })
    b.board.tasks.claimTask(alice, filed.tasks[0]!.id, {})
    expect(createTasks(b, carol, 'dev', PLAN, { id: 'blind-batch' })).toEqual({ tasks: filed.tasks })
    expect(b.board.tasks.getBatch(carol, 'blind-batch')).toEqual({ tasks: filed.tasks })
    expect(outcome(() => b.board.tasks.getBatch(carol, 'blind-batch'))).toEqual([200])
  })
})
