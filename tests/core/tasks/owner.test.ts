// Slice A4: the owner verbs, set needs and the cycle walk (M2_DESIGN 2.7.8, 2.7.9), with the
// original's ACL (O:tasks.ts:244-258).
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalCaller, loadRow, type CallerContext, type MessageView } from '../../../src/core/index.ts'
import { alice, AUTHOR, eventCount, makeBoard, T0, type Board } from './helpers.ts'
import {
  ALICE,
  aliceAs,
  bob,
  claimOf,
  finish,
  head,
  iso,
  makeTask,
  NO_MANAGE,
  outcome,
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

const needs = (b: Board, caller: CallerContext, id: string, ids: string[]): MessageView =>
  b.board.tasks.setTaskNeeds(caller, id, { needs: ids }).task

describe('A4 holds', () => {
  it('block without proof: the owner holds a ready task; edited is the board kind; blocked again is 409; unblock lifts it, and is a no-op when not held', () => {
    const b = open()
    const { id } = makeTask(b, alice, 'deploy to prod')
    // AT-33 `edited` is the board's own kind.
    expect(refusal(() => b.board.tasks.blockTask(alice, id, { reason: 'looks edited', kind: 'edited' }))[1]).toBe('invalid_request')
    expect(refusal(() => b.board.tasks.blockTask(alice, id, { reason: 'x', kind: 'k'.repeat(65) }))).toEqual([
      400,
      'invalid_request',
      'kind: a kind is up to 64 lowercase letters, numbers, and _.-',
    ])
    expect(refusal(() => b.board.tasks.blockTask(alice, id, { reason: '' }))[1]).toBe('invalid_request')
    expect(refusal(() => b.board.tasks.blockTask(alice, id, { reason: 'x'.repeat(1001) }))[2]).toBe(
      "reason: a task's reason is at most 1,000 characters",
    )
    expect(stateOf(b, id)).toBe('ready')
    // AT-33 until the org layer reserves the prefix, an org.* kind is any client kind, as in the original.
    const held = b.board.tasks.blockTask(alice, id, { reason: 'approve the prod deploy?', kind: 'org.approval' })
    expect(held.task).toMatchObject({
      labels: { 'board.task': 'blocked' },
      task: { state: 'blocked', blocked: { kind: 'org.approval', reason: 'approve the prod deploy?' } },
    })
    expect(refusal(() => b.board.tasks.blockTask(alice, id, { reason: 'again' }))).toEqual([
      409,
      'task_blocked',
      `#${id} is held already: approve the prod deploy?`,
    ])
    expect(b.board.tasks.unblockTask(alice, id).task).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready', blocked: null } })
    const before = eventCount(b)
    expect(b.board.tasks.unblockTask(alice, id).task.task?.state).toBe('ready')
    expect(eventCount(b)).toBe(before)
    expect(b.board.tasks.blockTask(alice, id, { reason: 'no kind' }).task.task?.blocked).toEqual({ kind: null, reason: 'no kind' })
    const at = head(b)
    b.board.tasks.unblockTask(alice, id)
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload])).toEqual([
      ['task.unblocked', { id: Number(id), thread: held.task.thread, by: AUTHOR }],
    ])
  })

  it('unblock returns a task to waiting while what it needs has not completed, and to ready once it has', () => {
    const b = open()
    const first = makeTask(b, alice, 'first')
    const second = makeTask(b, alice, 'second', { needs: [first.id] })
    b.board.tasks.blockTask(alice, second.id, { reason: 'still wanted?' })
    expect(b.board.tasks.unblockTask(alice, second.id).task).toMatchObject({ labels: { 'board.task': 'waiting' }, task: { state: 'waiting' } })
    b.board.tasks.blockTask(alice, second.id, { reason: 'hold on' })
    finish(b, alice, first.id)
    expect(stateOf(b, second.id)).toBe('blocked')
    expect(b.board.tasks.unblockTask(alice, second.id).task.task?.state).toBe('ready')
  })

  it("a claimed task is its claimant's to hold, which ends the claim; a lapsed claim holds nothing, so its owner holds the task", () => {
    const b = open()
    const { id } = makeTask(b, alice, 'migrate the table')
    const held = claimOf(b, bob, id, { lease: 60 })
    expect(refusal(() => b.board.tasks.blockTask(alice, id, { reason: 'wait' }))).toEqual([
      409,
      'task_claimed',
      `#${id} is claimed until ${iso(T0 + 60_000)}: only its claim holds it`,
    ])
    expect(refusal(() => b.board.tasks.blockTask(bob, id, { reason: 'half a claim', epoch: held.epoch }))).toEqual([
      400,
      'invalid_request',
      'a claim is its `epoch` and its `token`: pass both, or neither',
    ])
    // The claimant holds it with its proof, owner or not.
    const narrowedBob = userWith('bob', 'dev=read')
    const blocked = b.board.tasks.blockTask(narrowedBob, id, { reason: 'drop the old column too?', kind: 'needs_input', ...held })
    expect(blocked.task.task).toMatchObject({ state: 'blocked', claim: null, blocked: { kind: 'needs_input', reason: 'drop the old column too?' } })
    expect(refusal(() => b.board.tasks.completeTask(bob, id, held))[1]).toBe('claim_lost')
    b.board.tasks.unblockTask(alice, id)
    claimOf(b, bob, id, { lease: 30 })
    b.clock.now = T0 + 31_000
    const at = head(b)
    expect(b.board.tasks.blockTask(alice, id, { reason: 'bo went quiet' }).task.task).toMatchObject({ state: 'blocked', claim: null, epoch: 2 })
    // No expiry first: task.blocked ends the lapsed claim itself.
    expect(taskEventsAfter(b, at).map((e) => e.type)).toEqual(['task.blocked'])
  })
})

describe('A4 cancel, reopen and assign', () => {
  it('cancel ends a claim and any hold; completed or canceled is 409; a failed task is canceled or reopened in place', () => {
    const b = open()
    const { id } = makeTask(b, alice, 'rotate the keys')
    claimOf(b, bob, id)
    const at = head(b)
    expect(b.board.tasks.cancelTask(alice, id, { reason: 'superseded' }).task).toMatchObject({
      labels: { 'board.task': 'canceled' },
      task: { state: 'canceled', claim: null, reason: 'superseded' },
    })
    expect(taskEventsAfter(b, at).map((e) => e.payload)).toEqual([{ id: Number(id), thread: expect.any(String), reason: 'superseded', by: AUTHOR }])
    expect(refusal(() => b.board.tasks.cancelTask(alice, id, { reason: 'again' }))).toEqual([409, 'task_finished', `#${id} is canceled`])
    expect(refusal(() => b.board.tasks.reopenTask(alice, id))).toEqual([409, 'task_finished', `#${id} is canceled`])
    expect(refusal(() => b.board.tasks.cancelTask(alice, id, { reason: 'x'.repeat(1001) }))[1]).toBe('invalid_request')
    expect(refusal(() => b.board.tasks.cancelTask(alice, id, {}))[1]).toBe('invalid_request')

    const done = makeTask(b, alice, 'done')
    finish(b, alice, done.id)
    expect(refusal(() => b.board.tasks.cancelTask(alice, done.id, { reason: 'late' }))).toEqual([409, 'task_finished', `#${done.id} is completed`])
    expect(refusal(() => b.board.tasks.reopenTask(alice, done.id))[1]).toBe('task_finished')

    const failed = makeTask(b, alice, 'failed')
    const fc = claimOf(b, alice, failed.id)
    b.board.tasks.failTask(alice, failed.id, { ...fc, reason: 'no' })
    // Reopen keeps the epoch and clears the reason; reopen of an open task is a no-op.
    expect(b.board.tasks.reopenTask(alice, failed.id).task.task).toMatchObject({ state: 'ready', epoch: 1, reason: null })
    const before = eventCount(b)
    expect(b.board.tasks.reopenTask(alice, failed.id).task.task?.state).toBe('ready')
    expect(eventCount(b)).toBe(before)
    const again = claimOf(b, alice, failed.id)
    expect(again.epoch).toBe(2)
    b.board.tasks.failTask(alice, failed.id, { ...again, reason: 'still no' })
    expect(b.board.tasks.cancelTask(alice, failed.id, { reason: 'give up' }).task.task).toMatchObject({ state: 'canceled', reason: 'give up' })

    const held = makeTask(b, alice, 'held')
    b.board.tasks.blockTask(alice, held.id, { reason: 'wait' })
    expect(b.board.tasks.cancelTask(alice, held.id, { reason: 'drop' }).task.task).toMatchObject({ state: 'canceled', blocked: null })
  })

  it("assign: one of the owner's profiles or null; the same is a no-op; a claim stays; finished is 409", () => {
    const b = open()
    const { id } = makeTask(b, alice, 'review the fix')
    const at = head(b)
    expect(b.board.tasks.assignTask(alice, id, { for: `${ALICE}+reviewer` }).task.task?.for).toBe(`${ALICE}+reviewer`)
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload])).toEqual([
      ['task.assigned', { id: Number(id), thread: expect.any(String), for: `${ALICE}+reviewer`, by: AUTHOR }],
    ])
    const before = eventCount(b)
    expect(b.board.tasks.assignTask(alice, id, { for: `${ALICE}+reviewer` }).task.task?.for).toBe(`${ALICE}+reviewer`)
    expect(eventCount(b)).toBe(before)
    const fixer = aliceAs('fixer')
    expect(refusal(() => b.board.tasks.claimTask(fixer, id, {}))).toEqual([409, 'task_assigned', `#${id} is assigned to ${ALICE}+reviewer`])
    expect(b.board.tasks.assignTask(alice, id, { for: null }).task.task?.for).toBeNull()
    const held = claimOf(b, fixer, id)
    // A claim it has stays when it is assigned.
    expect(b.board.tasks.assignTask(alice, id, { for: `${ALICE}+reviewer` }).task.task).toMatchObject({
      state: 'claimed',
      for: `${ALICE}+reviewer`,
      claim: { actor: `${ALICE}+fixer` },
    })
    expect(refusal(() => b.board.tasks.assignTask(alice, id, { for: `${bob.principal.id}+fixer` }))).toEqual([
      400,
      'invalid_request',
      `for: a task is assigned to one of its owner's profiles, ${ALICE}+<profile>, got ${bob.principal.id}+fixer`,
    ])
    // The owner the profile must be of is the task's, not the caller's.
    const bobsTask = makeTask(b, bob, 'bob owns this')
    expect(b.board.tasks.assignTask(alice, bobsTask.id, { for: `${bob.principal.id}+fixer` }).task.task?.for).toBe(`${bob.principal.id}+fixer`)
    b.board.tasks.completeTask(fixer, id, held)
    expect(refusal(() => b.board.tasks.assignTask(alice, id, { for: null }))).toEqual([409, 'task_finished', `#${id} is completed`])
    expect(refusal(() => b.board.tasks.assignTask(alice, id, {}))[1]).toBe('invalid_request')
  })

  it('AT-32 an assigned task is refused to every other actor even after its lease ran out, and to a lookalike principal', () => {
    const b = open()
    const fixer = aliceAs('fixer')
    const reviewer = aliceAs('reviewer')
    const made = makeTask(b, alice, 'fix CVE-123', { for: `${ALICE}+fixer` })
    for (const caller of [alice, reviewer, bob]) {
      expect(refusal(() => b.board.tasks.claimTask(caller, made.id, {}))).toEqual([409, 'task_assigned', `#${made.id} is assigned to ${ALICE}+fixer`])
    }
    const held = claimOf(b, fixer, made.id, { lease: 30 })
    b.clock.now = T0 + 31_000
    expect(refusal(() => b.board.tasks.claimTask(reviewer, made.id, {}))[1]).toBe('task_assigned')
    expect(b.board.tasks.claimTask(fixer, made.id, {}).claim.epoch).toBe(held.epoch + 1)

    // A principal whose own ID reads the same as alice's fixer actor is not alice's fixer.
    const lookalike = createLocalCaller({ userId: 'alice+fixer', handle: 'lookalike' })
    expect(lookalike.actor.id).toBe(`${ALICE}+fixer`)
    const other = makeTask(b, alice, 'another fix', { for: `${ALICE}+fixer` })
    expect(refusal(() => b.board.tasks.claimTask(lookalike, other.id, {}))[1]).toBe('task_assigned')
    expect(stateOf(b, other.id)).toBe('ready')
  })
})

describe('A4 set needs', () => {
  it('AT-28 a live claim is 409; a lapsed claim expires first; the same set in another order is a no-op; a blocked task stays blocked', () => {
    const b = open()
    const fix = makeTask(b, alice, 'fix CVE-123')
    const docs = makeTask(b, alice, 'write the advisory')
    const review = makeTask(b, alice, 'review it', { needs: [fix.id] })

    let at = head(b)
    const moved = needs(b, alice, review.id, [docs.id])
    expect(moved).toMatchObject({ id: review.id, labels: { 'board.task': 'waiting' }, task: { state: 'waiting', needs: [docs.id] } })
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload])).toEqual([
      ['task.needs_changed', { id: Number(review.id), thread: review.thread, needs: [Number(docs.id)], by: AUTHOR }],
    ])
    finish(b, alice, fix.id)
    expect(stateOf(b, review.id)).toBe('waiting')
    finish(b, alice, docs.id)
    expect(stateOf(b, review.id)).toBe('ready')

    // For ones that have all completed: needs_changed (waiting), then task.ready at the next index.
    at = head(b)
    expect(needs(b, alice, review.id, [fix.id, docs.id]).task).toMatchObject({ state: 'ready', needs: [fix.id, docs.id] })
    const landed = taskEventsAfter(b, at)
    expect(landed.map((e) => e.type)).toEqual(['task.needs_changed', 'task.ready'])
    expect(landed[1]!.index).toBe(landed[0]!.index + 1)
    // The same set, in any order and said twice, changes nothing.
    at = eventCount(b)
    expect(needs(b, alice, review.id, [docs.id, fix.id, docs.id]).task).toMatchObject({ state: 'ready', needs: [fix.id, docs.id] })
    expect(eventCount(b)).toBe(at)
    // With none, it's ready, and only the change says so.
    const ship = makeTask(b, alice, 'ship it')
    needs(b, alice, review.id, [ship.id])
    at = head(b)
    expect(needs(b, alice, review.id, []).task).toMatchObject({ state: 'ready', needs: [] })
    expect(taskEventsAfter(b, at).map((e) => e.type)).toEqual(['task.needs_changed'])

    // A live claim keeps what it needs.
    const held = claimOf(b, bob, review.id, { lease: 60 })
    expect(refusal(() => needs(b, alice, review.id, [fix.id]))).toEqual([
      409,
      'task_claimed',
      `#${review.id} is claimed until ${iso(T0 + 60_000)}: what it needs changes once no one holds it`,
    ])
    // A lapsed one expires first, in the same write.
    b.clock.now = T0 + 61_000
    at = head(b)
    expect(needs(b, alice, review.id, [fix.id]).task).toMatchObject({ state: 'ready', needs: [fix.id], claim: null, epoch: 1 })
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload.epoch ?? null])).toEqual([
      ['task.expired', held.epoch],
      ['task.needs_changed', null],
      ['task.ready', null],
    ])
    expect(loadRow(b.store.db, Number(review.id))!.expirations).toBe(1)

    // A held task takes the change and stays held.
    const other = makeTask(b, alice, 'other')
    b.board.tasks.blockTask(alice, review.id, { reason: 'which release?' })
    at = head(b)
    expect(needs(b, alice, review.id, [other.id]).task).toMatchObject({ state: 'blocked', needs: [other.id], blocked: { reason: 'which release?' } })
    expect(taskEventsAfter(b, at).map((e) => e.type)).toEqual(['task.needs_changed'])
    // Even to needs that have all completed: no task.ready while held.
    at = head(b)
    needs(b, alice, review.id, [fix.id])
    expect(taskEventsAfter(b, at).map((e) => e.type)).toEqual(['task.needs_changed'])
    expect(b.board.tasks.unblockTask(alice, review.id).task.task?.state).toBe('ready')

    // Finished tasks keep theirs.
    const done = makeTask(b, alice, 'done')
    finish(b, alice, done.id)
    const dropped = makeTask(b, alice, 'dropped')
    b.board.tasks.cancelTask(alice, dropped.id, { reason: 'no' })
    for (const t of [done, dropped]) expect(refusal(() => needs(b, alice, t.id, [fix.id]))[1]).toBe('task_finished')
  })

  it('takes what a new task takes: readable tasks, none canceled, at most 20, never itself; a non-task is not_a_task', () => {
    const b = open()
    const root = makeTask(b, alice, 'ship it')
    const failed = makeTask(b, alice, 'build the image')
    b.board.tasks.failTask(alice, failed.id, { ...claimOf(b, alice, failed.id), reason: 'registry is down' })
    const dropped = makeTask(b, alice, 'migrate the old table')
    b.board.tasks.cancelTask(alice, dropped.id, { reason: 'not needed after all' })
    const plain = b.board.postMessage(alice, { channel: 'dev', text: 'just a thread' }).message
    const reply = b.board.postMessage(alice, { re: root.id, text: 'a reply' }).message
    const secret = b.board.tasks.createTask(alice, { channel: 'secret', text: 'rotate the keys' }).task
    for (const refused of [dropped.id, plain.id, reply.id, '99999', root.id]) {
      expect(refusal(() => needs(b, alice, root.id, [failed.id, refused]))[1], refused).toBe('invalid_needs')
    }
    const narrowed = aliceAs(null, '*=post;dev=read,post,label')
    expect(refusal(() => needs(b, narrowed, root.id, [secret.id]))).toEqual([400, 'invalid_needs', `needs: #${secret.id} isn't a task`])
    expect(refusal(() => needs(b, alice, root.id, Array.from({ length: 21 }, (_, i) => String(1000 + i))))).toEqual([
      400,
      'invalid_request',
      'needs: a task waits for at most 20 tasks',
    ])
    expect(refusal(() => needs(b, alice, root.id, Array.from({ length: 40 }, (_, i) => String(1000 + (i % 20)))))[1]).toBe('invalid_needs')
    expect(refusal(() => b.board.tasks.setTaskNeeds(alice, root.id, {}))[1]).toBe('invalid_request')
    expect(taskOf(b, root.id)).toMatchObject({ state: 'ready', needs: [] })
    expect(needs(b, alice, root.id, [failed.id]).task).toMatchObject({ state: 'waiting', needs: [failed.id] })
    // The set is checked as given before it is found to be the same.
    const gone = makeTask(b, alice, 'needed for now')
    const waits = makeTask(b, alice, 'waits for it and a secret', { needs: [gone.id, secret.id] })
    expect(refusal(() => needs(b, narrowed, waits.id, [secret.id, gone.id]))[1]).toBe('invalid_needs')
    b.board.tasks.cancelTask(alice, gone.id, { reason: 'not needed after all' })
    expect(refusal(() => needs(b, alice, waits.id, [gone.id, secret.id]))[1]).toBe('invalid_needs')
    expect(taskOf(b, waits.id)).toMatchObject({ state: 'waiting', needs: [gone.id, secret.id] })
    expect(refusal(() => needs(b, alice, plain.id, []))).toEqual([404, 'not_a_task', `#${plain.id} isn't a task`])
    expect(refusal(() => needs(b, alice, reply.id, []))[1]).toBe('not_a_task')
    expect(refusal(() => needs(b, alice, '99999', []))).toEqual([404, 'message_not_found', 'message not found: #99999'])
  })

  it('AT-26 a change that would close a cycle is refused, naming the added prerequisite; refs and self are checked over the whole list first', () => {
    const b = open()
    const a = makeTask(b, alice, 'a')
    const bb = makeTask(b, alice, 'b', { needs: [a.id] })
    const c = makeTask(b, alice, 'c', { needs: [bb.id] })
    // a <- b <- c, i.e. b needs a and c needs b. Setting a's needs to [c] walks c, then b, whose edge closes it.
    expect(refusal(() => needs(b, alice, a.id, [c.id]))).toEqual([
      400,
      'invalid_needs',
      `needs: #${c.id} waits for #${a.id} already: they would wait for each other`,
    ])
    expect(refusal(() => needs(b, alice, a.id, [bb.id]))[2]).toBe(`needs: #${bb.id} waits for #${a.id} already: they would wait for each other`)
    const other = makeTask(b, alice, 'on its own')
    expect(refusal(() => needs(b, alice, a.id, [other.id, c.id]))[2]).toBe(
      `needs: #${c.id} waits for #${a.id} already: they would wait for each other`,
    )
    expect(taskOf(b, a.id)).toMatchObject({ state: 'ready', needs: [] })
    // Once what was in the way waits for something else, the same change lands.
    needs(b, alice, bb.id, [other.id])
    expect(needs(b, alice, a.id, [other.id, c.id]).task).toMatchObject({ state: 'waiting', needs: [other.id, c.id] })
    expect(refusal(() => needs(b, alice, other.id, [a.id]))[1]).toBe('invalid_needs')
    expect(refusal(() => needs(b, alice, bb.id, [a.id]))[1]).toBe('invalid_needs')

    // [#999, #self]: the whole list is checked for refs and self before any is looked up.
    expect(refusal(() => needs(b, alice, other.id, ['999', other.id]))).toEqual([
      400,
      'invalid_needs',
      `needs: #${other.id} is the task itself: it can't wait for itself`,
    ])
  })

  it('AT-26 a cycle through a task the caller cannot read is still found; completed readable tasks are not followed; a canceled one is', () => {
    const b = open()
    const narrowed = aliceAs(null, '*=post;dev=read,post,label')
    const a = makeTask(b, alice, 'a')
    const hidden = b.board.tasks.createTask(alice, { channel: 'secret', text: 'hidden', needs: [a.id] }).task
    const c = makeTask(b, alice, 'c', { needs: [hidden.id] })
    expect(refusal(() => needs(b, narrowed, a.id, [c.id]))).toEqual([
      400,
      'invalid_needs',
      `needs: #${c.id} waits for #${a.id} already: they would wait for each other`,
    ])
    // A canceled task may have waited for anything: it is followed.
    const dropped = makeTask(b, alice, 'dropped while it waited', { needs: [a.id] })
    const behind = makeTask(b, alice, 'waits for the dropped one', { needs: [dropped.id] })
    b.board.tasks.cancelTask(alice, dropped.id, { reason: 'not needed' })
    expect(refusal(() => needs(b, alice, a.id, [behind.id]))[1]).toBe('invalid_needs')
    expect(taskOf(b, a.id)).toMatchObject({ state: 'ready', needs: [] })
  })

  it('AT-26 the walk stops past 500 tasks behind what is added; completed readable work is never walked', () => {
    const b = open()
    // A line of 501 tasks, each waiting for the one before, and one that would wait for its end.
    let last = makeTask(b, alice, 'the first')
    const line = [last.id]
    for (let n = 1; n <= 500; n++) {
      last = makeTask(b, alice, `waits for #${last.id}`, { needs: [last.id] })
      line.push(last.id)
    }
    const root = makeTask(b, alice, 'waits for the whole line')
    expect(refusal(() => needs(b, alice, root.id, [line[500]!]))).toEqual([
      400,
      'invalid_needs',
      `needs: #${line[500]} has more than 500 tasks behind it and the others: too many to check that none waits for #${root.id}`,
    ])
    // One nearer, the walk gets to the end.
    expect(needs(b, alice, root.id, [line[499]!]).task).toMatchObject({ state: 'waiting', needs: [line[499]] })
    // It walks only behind what a change adds.
    const other = makeTask(b, alice, 'beside the line')
    const made = makeTask(b, alice, 'made waiting for the whole line', { needs: [line[500]!, other.id] })
    expect(needs(b, alice, made.id, [line[500]!]).task).toMatchObject({ needs: [line[500]] })
    expect(needs(b, alice, made.id, [line[500]!, other.id]).task).toMatchObject({ needs: [line[500], other.id] })

    // Completed, readable work behind a prerequisite is not walked, so it is never too much.
    const done = makeTask(b, alice, 'done head')
    const chain = [done.id]
    for (let n = 1; n <= 510; n++) chain.push(makeTask(b, alice, `done ${n}`, { needs: [chain[n - 1]!] }).id)
    for (const id of chain) finish(b, alice, id)
    const recent = makeTask(b, alice, 'the next release', { needs: [chain[510]!] })
    const ship = makeTask(b, alice, 'ship')
    expect(needs(b, alice, ship.id, [recent.id]).task).toMatchObject({ state: 'waiting', needs: [recent.id] })
  }, 60_000)
})

describe('A4 ACL', () => {
  /**
   * AT-31: the callers of the matrix. The task is made by alice's `triage` profile in `dev`, so
   * the owner principal is alice as herself and the owner profile is `triage`.
   */
  const CALLERS: Record<string, () => CallerContext> = {
    'read-only': () => userWith('reader', 'dev=read'),
    'post-only': () => userWith('poster', 'dev=post'),
    'label-only': () => userWith('labeler', 'dev=label'),
    manage: () => bob,
    'owner principal': () => aliceAs(null, NO_MANAGE),
    'owner read-only': () => aliceAs(null, 'dev=read'),
    'owner profile': () => aliceAs('triage', NO_MANAGE),
    'sibling profile': () => aliceAs('fixer', NO_MANAGE),
    'other principal': () => userWith('carol', NO_MANAGE),
  }
  const OWNS = new Set(['manage', 'owner principal', 'owner profile'])
  const LABELS = new Set(['label-only', 'manage', 'owner principal', 'owner profile', 'sibling profile', 'other principal'])

  type Verb = (b: Board, caller: CallerContext, id: string) => unknown
  const VERBS: Record<string, Verb> = {
    block: (b, caller, id) => b.board.tasks.blockTask(caller, id, { reason: 'not yet' }),
    unblock: (b, caller, id) => b.board.tasks.unblockTask(caller, id),
    cancel: (b, caller, id) => b.board.tasks.cancelTask(caller, id, { reason: 'mine now' }),
    reopen: (b, caller, id) => b.board.tasks.reopenTask(caller, id),
    assign: (b, caller, id) => b.board.tasks.assignTask(caller, id, { for: `${ALICE}+triage` }),
    needs: (b, caller, id) => b.board.tasks.setTaskNeeds(caller, id, { needs: [] }),
    claim: (b, caller, id) => b.board.tasks.claimTask(caller, id, {}),
  }

  it('AT-31 each verb answers each caller as 2.4.2 says: hidden 404, task_not_owned 403, forbidden 403 without label', () => {
    const b = open()
    const triage = aliceAs('triage', NO_MANAGE)
    const table: string[] = []
    const expected: string[] = []
    for (const [who, caller] of Object.entries(CALLERS)) {
      for (const [verb, run] of Object.entries(VERBS)) {
        const { id } = makeTask(b, triage, `${verb} by ${who}`)
        table.push(`${who} ${verb} ${outcome(() => run(b, caller(), id)).join(' ')}`)
        const readable = who !== 'post-only'
        const allowed = verb === 'claim' ? LABELS.has(who) : OWNS.has(who)
        const refused = verb === 'claim' ? '403 forbidden' : '403 task_not_owned'
        expected.push(`${who} ${verb} ${!readable ? '404 message_not_found' : allowed ? '200' : refused}`)
      }
    }
    expect(table).toEqual(expected)
  })

  it('AT-31 a non-owner gets 403 before any 409, on a finished, claimed or blocked task', () => {
    const b = open()
    const other = userWith('carol', NO_MANAGE)
    const done = makeTask(b, alice, 'done')
    finish(b, alice, done.id)
    const claimed = makeTask(b, alice, 'claimed')
    claimOf(b, bob, claimed.id)
    const blocked = makeTask(b, alice, 'blocked')
    b.board.tasks.blockTask(alice, blocked.id, { reason: 'wait' })
    for (const t of [done, claimed, blocked]) {
      for (const [verb, run] of Object.entries(VERBS)) {
        if (verb === 'claim') continue
        expect(outcome(() => run(b, other, t.id)), `${verb} ${t.text}`).toEqual([403, 'task_not_owned'])
      }
    }
    const [, , words] = refusal(() => b.board.tasks.cancelTask(other, done.id, { reason: 'x' }))
    expect(words).toBe(`#${done.id} is someone else's task: its owner as itself, the profile that made it, or manage in dev, changes it`)
    // A body the verb refuses is 400 before the ACL: nothing is read.
    expect(outcome(() => b.board.tasks.cancelTask(other, done.id, {}))).toEqual([400, 'invalid_request'])
    // Manage gets to the 409s.
    expect(outcome(() => b.board.tasks.cancelTask(bob, done.id, { reason: 'x' }))).toEqual([409, 'task_finished'])
  })

  it("AT-31 the owner's read-only token cannot cancel; one that posts can; its profile changes only what it made", () => {
    const b = open()
    const { id } = makeTask(b, alice, 'rotate the keys')
    expect(outcome(() => b.board.tasks.cancelTask(aliceAs(null, 'dev=read'), id, { reason: 'from a sandbox' }))).toEqual([403, 'task_not_owned'])
    expect(stateOf(b, id)).toBe('ready')
    expect(outcome(() => b.board.tasks.cancelTask(aliceAs(null, 'dev=read,post'), id, { reason: 'from one that posts' }))).toEqual([200])
    // A profile owns only what it made; alice as herself any of them.
    const triage = aliceAs('triage', NO_MANAGE)
    const own = makeTask(b, triage, 'sort the queue')
    expect(own.task).toMatchObject({ owner: ALICE, by: `${ALICE}+triage` })
    expect(b.board.tasks.assignTask(triage, own.id, { for: `${ALICE}+fixer` }).task.task?.for).toBe(`${ALICE}+fixer`)
    expect(b.board.tasks.assignTask(aliceAs(null, NO_MANAGE), own.id, { for: null }).task.task).toMatchObject({ for: null, by: `${ALICE}+triage` })
    const hers = makeTask(b, alice, 'hers', { for: `${ALICE}+fixer` })
    expect(outcome(() => b.board.tasks.assignTask(triage, hers.id, { for: `${ALICE}+triage` }))).toEqual([403, 'task_not_owned'])
    expect(outcome(() => b.board.tasks.claimTask(triage, hers.id, {}))).toEqual([409, 'task_assigned'])
    // A non-owner with label may still claim and settle someone else's task: that takes label, not the task.
    const theirs = makeTask(b, alice, 'theirs')
    const other = userWith('carol', NO_MANAGE)
    expect(b.board.tasks.completeTask(other, theirs.id, claimOf(b, other, theirs.id)).task.task?.state).toBe('completed')
  })
})
