// Slice A3: claim by ID, the fenced writes, and promotion (M2_DESIGN 2.7.5-2.7.7).
import { afterEach, describe, expect, it } from 'vitest'
import { loadRow } from '../../../src/core/index.ts'
import { alice, eventCount, makeBoard, T0, type Board } from './helpers.ts'
import {
  ALICE,
  aliceAs,
  bob,
  BOB,
  claimOf,
  eventsAfter,
  finish,
  head,
  iso,
  makeTask,
  refusal,
  stateOf,
  taskEventsAfter,
  taskOf,
  userWith,
} from './verb-helpers.ts'

const boards: Board[] = []
const open = (): Board => {
  const b = makeBoard()
  boards.push(b)
  return b
}
afterEach(() => {
  while (boards.length > 0) boards.pop()!.close()
})

const TOKEN = 'K'.repeat(43)

describe('A3 claim by ID', () => {
  it('holds a task for its lease and settles it: released, failed and reopened, completed', () => {
    const b = open()
    const { id } = makeTask(b, alice, 'fix CVE-123')
    const held = b.board.tasks.claimTask(bob, id, {})
    expect(held.claim).toEqual({ epoch: 1, token: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), until: iso(T0 + 900_000) })
    expect(held.task).toMatchObject({
      labels: { 'board.task': 'claimed' },
      task: { state: 'claimed', epoch: 1, claim: { actor: BOB, until: iso(T0 + 900_000) } },
    })
    expect(refusal(() => b.board.tasks.claimTask(alice, id, {}))).toEqual([
      409,
      'task_claimed',
      `#${id} is claimed until ${iso(T0 + 900_000)}`,
    ])
    const released = b.board.tasks.releaseTask(bob, id, { epoch: 1, token: held.claim.token })
    expect(released.task).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready', epoch: 1, claim: null } })

    const second = claimOf(b, alice, id)
    expect(second.epoch).toBe(2)
    const failed = b.board.tasks.failTask(alice, id, { ...second, reason: 'the tests need a database' })
    expect(failed.task).toMatchObject({
      labels: { 'board.task': 'failed' },
      task: { state: 'failed', claim: null, reason: 'the tests need a database', result: null },
    })
    expect(refusal(() => b.board.tasks.claimTask(bob, id, {}))).toEqual([409, 'task_finished', `#${id} is failed`])
    expect(b.board.tasks.reopenTask(alice, id).task.task).toMatchObject({ state: 'ready', reason: null, epoch: 2 })

    const third = claimOf(b, bob, id)
    const done = b.board.tasks.completeTask(bob, id, { ...third, result: 'fixed in a1b2c3' })
    expect(done.task).toMatchObject({
      labels: { 'board.task': 'completed' },
      task: { state: 'completed', epoch: 3, claim: null, result: 'fixed in a1b2c3' },
    })
    expect(refusal(() => b.board.tasks.claimTask(alice, id, {}))).toEqual([409, 'task_finished', `#${id} is completed`])
    // A result is optional; a reason isn't, and both are a line or two.
    const quiet = makeTask(b, alice, 'tidy up')
    expect(b.board.tasks.completeTask(alice, quiet.id, claimOf(b, alice, quiet.id)).task.task).toMatchObject({ state: 'completed', result: null })
    const other = makeTask(b, alice, 'try it')
    const otherClaim = claimOf(b, alice, other.id)
    expect(refusal(() => b.board.tasks.failTask(alice, other.id, otherClaim))[1]).toBe('invalid_request')
    expect(refusal(() => b.board.tasks.completeTask(alice, other.id, { ...otherClaim, result: 'x'.repeat(1001) }))).toEqual([
      400,
      'invalid_request',
      "result: a task's result is at most 1,000 characters",
    ])
    expect(refusal(() => b.board.tasks.failTask(alice, other.id, { ...otherClaim, reason: 'x'.repeat(1001) }))).toEqual([
      400,
      'invalid_request',
      "reason: a task's reason is at most 1,000 characters",
    ])
    expect(taskOf(b, other.id)).toMatchObject({ state: 'claimed', epoch: 1 })
  })

  it('answers 404 for what the caller cannot read, not_a_task for a thread, 403 without label, and the state 409s', () => {
    const b = open()
    const runner = userWith('runner', 'dev=read,post;ops=read,post,label')
    const made = makeTask(b, runner, 'bump the lockfile')
    // Without label, even its own task is not its to claim.
    expect(refusal(() => b.board.tasks.claimTask(runner, made.id, {}))).toEqual([403, 'forbidden', "this token can't label in dev"])
    const secret = b.board.tasks.createTask(alice, { channel: 'secret', text: 'rotate the keys' }).task
    expect(refusal(() => b.board.tasks.claimTask(runner, secret.id, {}))).toEqual([404, 'message_not_found', `message not found: #${secret.id}`])
    const plain = b.board.postMessage(alice, { channel: 'ops', text: 'a thread' }).message
    expect(refusal(() => b.board.tasks.claimTask(runner, plain.id, {}))).toEqual([404, 'not_a_task', `#${plain.id} isn't a task`])
    expect(refusal(() => b.board.tasks.claimTask(runner, '999', {}))[1]).toBe('message_not_found')
    expect(refusal(() => b.board.tasks.claimTask(runner, 'x1', {}))[1]).toBe('message_not_found')
    // A hidden task that is not ready still answers 404: nothing of its state shows.
    b.board.tasks.blockTask(alice, secret.id, { reason: 'held' })
    expect(refusal(() => b.board.tasks.claimTask(runner, secret.id, {}))[1]).toBe('message_not_found')

    const fix = makeTask(b, alice, 'fix')
    const docs = makeTask(b, alice, 'docs')
    const review = makeTask(b, alice, 'review', { needs: [fix.id, docs.id] })
    expect(refusal(() => b.board.tasks.claimTask(bob, review.id, {}))).toEqual([
      409,
      'task_waiting',
      `#${review.id} waits for #${fix.id}, #${docs.id}`,
    ])
    b.board.tasks.blockTask(alice, fix.id, { reason: 'approve the deploy?', kind: 'awaiting_approval' })
    expect(refusal(() => b.board.tasks.claimTask(bob, fix.id, {}))).toEqual([
      409,
      'task_blocked',
      `#${fix.id} is held for a person: approve the deploy?`,
    ])
    for (const lease of [29, 3601, -1, '5m']) expect(refusal(() => b.board.tasks.claimTask(bob, docs.id, { lease }))[1], String(lease)).toBe('invalid_request')
    expect(refusal(() => b.board.tasks.claimTask(bob, docs.id, { token: 'short' }))[1]).toBe('invalid_request')
  })

  it('AT-13 a claim with the live token answers that claim, epoch and until unchanged, and writes nothing', () => {
    const b = open()
    const { id } = makeTask(b, alice, 'idempotent')
    const first = b.board.tasks.claimTask(alice, id, { token: TOKEN, lease: 60 })
    expect(first.claim).toEqual({ epoch: 1, token: TOKEN, until: iso(T0 + 60_000) })
    const before = eventCount(b)
    b.clock.now = T0 + 10_000
    const again = b.board.tasks.claimTask(alice, id, { token: TOKEN, lease: 3600 })
    expect(again.claim).toEqual(first.claim)
    expect(again.task.task).toMatchObject({ state: 'claimed', epoch: 1, claim: { until: iso(T0 + 60_000) } })
    expect(eventCount(b)).toBe(before)
    // Someone else's token, or none, is a claim attempt like any.
    expect(refusal(() => b.board.tasks.claimTask(bob, id, { token: 'Z'.repeat(43) }))[1]).toBe('task_claimed')
    expect(refusal(() => b.board.tasks.claimTask(alice, id, {}))[1]).toBe('task_claimed')
  })

  it('AT-14 a lapsed claim is taken over: task.expired{1} then task.claimed{2} at adjacent indexes, with a new token', () => {
    const b = open()
    const { id } = makeTask(b, alice, 'migrate the table')
    b.board.postMessage(bob, { channel: 'dev', text: 'hello' })
    const a = claimOf(b, alice, id, { lease: 30 })
    b.clock.now = T0 + 31_000
    const at = head(b)
    const taken = b.board.tasks.claimTask(bob, id, {})
    expect(taken.claim.epoch).toBe(2)
    expect(taken.claim.token).not.toBe(a.token)
    const landed = eventsAfter(b, at)
    expect(landed.map((e) => [e.type, e.payload.epoch])).toEqual([
      ['task.expired', 1],
      ['task.claimed', 2],
    ])
    expect(landed[1]!.index).toBe(landed[0]!.index + 1)
    expect(landed[0]!.payload).toEqual({ id: Number(id), thread: taken.task.thread, epoch: 1 })
    expect(loadRow(b.store.db, Number(id))).toMatchObject({ epoch: 2, expirations: 1, claim_actor: BOB })
  })

  it("AT-15 the zombie's writes at its epoch are claim_lost, write nothing and change nothing; mixed proofs too", () => {
    const b = open()
    const { id } = makeTask(b, alice, 'migrate the table')
    const stalled = claimOf(b, alice, id, { lease: 30 })
    // The wrong secret, or another epoch, is no claim at all.
    expect(refusal(() => b.board.tasks.completeTask(alice, id, { epoch: 1, token: 'not-the-token' }))).toEqual([
      409,
      'claim_lost',
      `this claim on #${id} is over: claim it again`,
    ])
    expect(refusal(() => b.board.tasks.completeTask(alice, id, { epoch: 2, token: stalled.token }))[1]).toBe('claim_lost')
    b.clock.now = T0 + 31_000
    const taken = claimOf(b, bob, id)
    const at = eventCount(b)
    const zombie = { epoch: stalled.epoch, token: stalled.token }
    expect(refusal(() => b.board.tasks.completeTask(alice, id, { ...zombie, result: 'done, I think' }))[1]).toBe('claim_lost')
    expect(refusal(() => b.board.tasks.failTask(alice, id, { ...zombie, reason: 'gave up' }))[1]).toBe('claim_lost')
    expect(refusal(() => b.board.tasks.releaseTask(alice, id, zombie))[1]).toBe('claim_lost')
    expect(refusal(() => b.board.tasks.renewTask(alice, id, zombie))[1]).toBe('claim_lost')
    expect(refusal(() => b.board.tasks.blockTask(alice, id, { ...zombie, reason: 'approve?' }))[1]).toBe('claim_lost')
    // Mixed pairs: A's epoch with B's token, B's epoch with A's token.
    expect(refusal(() => b.board.tasks.completeTask(bob, id, { epoch: 1, token: taken.token }))[1]).toBe('claim_lost')
    expect(refusal(() => b.board.tasks.completeTask(alice, id, { epoch: 2, token: stalled.token }))[1]).toBe('claim_lost')
    expect(eventCount(b)).toBe(at)
    expect(taskOf(b, id)).toMatchObject({ state: 'claimed', epoch: 2, claim: { actor: BOB }, result: null })
    // B's own proof works, and once it lets go it's lost too: a settle repeated after it landed is claim_lost.
    expect(b.board.tasks.releaseTask(bob, id, taken).task.task?.state).toBe('ready')
    expect(refusal(() => b.board.tasks.completeTask(bob, id, taken))[1]).toBe('claim_lost')
    expect(refusal(() => b.board.tasks.releaseTask(bob, id, taken))[1]).toBe('claim_lost')
  })

  it('AT-16 a renew at until + 1 ms is claim_lost; one at until - 1 ms lands, counts from now, and may shorten the lease', () => {
    const b = open()
    const { id } = makeTask(b, alice, 'a long build')
    const held = claimOf(b, alice, id, { lease: 30 })
    expect(held.until).toBe(iso(T0 + 30_000))
    b.clock.now = T0 + 30_000 - 1
    const renewed = b.board.tasks.renewTask(alice, id, { epoch: 1, token: held.token, lease: 30 })
    expect(renewed.until).toBe(iso(T0 + 60_000 - 1))
    expect(renewed.task.task?.claim?.until).toBe(iso(T0 + 60_000 - 1))
    b.clock.now = T0 + 20_000 + 30_000
    // Counts from now: a 3600 s lease, then the default, which shortens it.
    expect(b.board.tasks.renewTask(alice, id, { epoch: 1, token: held.token, lease: 3600 }).until).toBe(iso(T0 + 50_000 + 3_600_000))
    expect(b.board.tasks.renewTask(alice, id, { epoch: 1, token: held.token }).until).toBe(iso(T0 + 50_000 + 900_000))
    expect(refusal(() => b.board.tasks.renewTask(alice, id, { epoch: 1, token: held.token, lease: 7200 }))).toEqual([
      400,
      'invalid_request',
      'lease: a lease is 30 to 3600 seconds',
    ])
    // At its until the claim is over: a renew there, or 1 ms past it, is lost, with no takeover.
    const until = T0 + 50_000 + 900_000
    b.clock.now = until
    expect(refusal(() => b.board.tasks.renewTask(alice, id, { epoch: 1, token: held.token }))[1]).toBe('claim_lost')
    b.clock.now = until + 1
    const before = eventCount(b)
    expect(refusal(() => b.board.tasks.renewTask(alice, id, { epoch: 1, token: held.token }))[1]).toBe('claim_lost')
    expect(refusal(() => b.board.tasks.completeTask(alice, id, { epoch: 1, token: held.token }))[1]).toBe('claim_lost')
    expect(eventCount(b)).toBe(before)
    expect(taskOf(b, id)).toMatchObject({ state: 'claimed', result: null })
  })

  it('renew, release, complete and fail need no label: the proof is the claim', () => {
    const b = open()
    const { id } = makeTask(b, alice, 'work')
    const held = claimOf(b, alice, id)
    // A token narrowed to reading still settles a claim it holds.
    const reader = aliceAs(null, 'dev=read')
    expect(b.board.tasks.renewTask(reader, id, held).task.task?.state).toBe('claimed')
    expect(b.board.tasks.completeTask(reader, id, held).task.task?.state).toBe('completed')
  })
})

describe('A3 promotion', () => {
  it('AT-19 diamond: one need completing leaves the task waiting, the last readies it at N+1 in the same commit; five dependents ascend', () => {
    const b = open()
    const bTask = makeTask(b, alice, 'b')
    const cTask = makeTask(b, alice, 'c')
    const aTask = makeTask(b, alice, 'a', { needs: [bTask.id, cTask.id] })
    finish(b, alice, bTask.id)
    expect(stateOf(b, aTask.id)).toBe('waiting')
    const held = claimOf(b, alice, cTask.id)
    const at = head(b)
    b.board.tasks.completeTask(alice, cTask.id, held)
    const landed = taskEventsAfter(b, at)
    expect(landed.map((e) => [e.type, e.payload.id])).toEqual([
      ['task.completed', Number(cTask.id)],
      ['task.ready', Number(aTask.id)],
    ])
    expect(landed[1]!.index).toBe(landed[0]!.index + 1)
    expect(landed[1]!.payload).toEqual({ id: Number(aTask.id), thread: aTask.thread })
    expect(b.board.getMessageThread(alice, aTask.id).message).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready' } })

    const root = makeTask(b, alice, 'root')
    const dependents = Array.from({ length: 5 }, (_, n) => makeTask(b, alice, `dependent ${n}`, { needs: [root.id] }))
    // One more that also waits for something else stays waiting.
    const other = makeTask(b, alice, 'other')
    const both = makeTask(b, alice, 'both', { needs: [other.id, root.id] })
    const rootClaim = claimOf(b, alice, root.id)
    const at2 = head(b)
    b.board.tasks.completeTask(alice, root.id, rootClaim)
    const promoted = taskEventsAfter(b, at2).filter((e) => e.type === 'task.ready')
    expect(promoted.map((e) => e.payload.id)).toEqual(dependents.map((d) => Number(d.id)))
    expect(stateOf(b, both.id)).toBe('waiting')
  })

  it('AT-20 a failed or canceled prerequisite readies nothing; a blocked dependent waits for its unblock; a deleted completed root still counts', () => {
    const b = open()
    const build = makeTask(b, alice, 'build the image')
    const deploy = makeTask(b, alice, 'deploy it', { needs: [build.id] })
    const held = claimOf(b, alice, build.id)
    let at = head(b)
    b.board.tasks.failTask(alice, build.id, { ...held, reason: 'registry is down' })
    expect(taskEventsAfter(b, at).map((e) => e.type)).toEqual(['task.failed'])
    expect(stateOf(b, deploy.id)).toBe('waiting')
    expect(refusal(() => b.board.tasks.claimTask(alice, deploy.id, {}))[1]).toBe('task_waiting')
    b.board.tasks.reopenTask(alice, build.id)
    expect(stateOf(b, deploy.id)).toBe('waiting')
    finish(b, alice, build.id)
    expect(stateOf(b, deploy.id)).toBe('ready')

    const lint = makeTask(b, alice, 'lint')
    const merge = makeTask(b, alice, 'merge', { needs: [lint.id] })
    at = head(b)
    expect(b.board.tasks.cancelTask(alice, lint.id, { reason: 'not needed after all' }).task.task).toMatchObject({
      state: 'canceled',
      reason: 'not needed after all',
    })
    expect(taskEventsAfter(b, at).map((e) => e.type)).toEqual(['task.canceled'])
    expect(stateOf(b, merge.id)).toBe('waiting')

    // A blocked dependent is not readied; lifting the hold readies it.
    const first = makeTask(b, alice, 'first')
    const second = makeTask(b, alice, 'second', { needs: [first.id] })
    b.board.tasks.blockTask(alice, second.id, { reason: 'hold on' })
    at = head(b)
    finish(b, alice, first.id)
    expect(taskEventsAfter(b, at).map((e) => e.type)).toEqual(['task.claimed', 'task.completed'])
    expect(stateOf(b, second.id)).toBe('blocked')
    at = head(b)
    expect(b.board.tasks.unblockTask(alice, second.id).task).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready' } })
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload.id])).toEqual([
      ['task.unblocked', Number(second.id)],
      ['task.ready', Number(second.id)],
    ])

    // A deleted but completed root still satisfies what waits for it.
    const x = makeTask(b, alice, 'x')
    const z = makeTask(b, alice, 'z')
    const y = makeTask(b, alice, 'y', { needs: [x.id, z.id] })
    finish(b, alice, x.id)
    b.board.deleteMessage(alice, x.id)
    expect(stateOf(b, y.id)).toBe('waiting')
    finish(b, alice, z.id)
    expect(stateOf(b, y.id)).toBe('ready')
    // And a new task may still wait for it: it completed.
    expect(makeTask(b, alice, 'after x', { needs: [x.id] }).task?.state).toBe('ready')
    expect(ALICE).toBe(alice.principal.id)
  })
})
