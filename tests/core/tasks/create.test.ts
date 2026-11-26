// Slice A2: create, adopt, single-create idempotency and needs validation (M2_DESIGN 2.7.3, 2.7.9).
import { afterEach, describe, expect, it } from 'vitest'
import { loadRow } from '../../../src/core/index.ts'
import { alice, AUTHOR, eventCount, makeBoard, T0, type Board } from './helpers.ts'
import {
  ALICE,
  aliceAs,
  bob,
  finish,
  head,
  iso,
  makeTask,
  messageCount,
  refusal,
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

const TOKEN = 'T'.repeat(43)
const BOB_ID = bob.principal.id

describe('A2 create', () => {
  it('AT-06 create forms: needs de-duplicated in order, along counts what comes with the post, no needs is ready with no task.ready', () => {
    const b = open()
    const fix = makeTask(b, alice, 'fix CVE-123')
    const docs = b.board.tasks.createTask(alice, { channel: 'docs', text: 'write the advisory' }).task
    // A plain create: message.posted{along:1}, task.created, ready with no task.ready.
    expect(fix).toMatchObject({ channel: 'dev', text: 'fix CVE-123', re: null, labels: { 'board.task': 'ready' } })
    expect(fix.task).toEqual({
      state: 'ready',
      owner: ALICE,
      by: ALICE,
      for: null,
      needs: [],
      epoch: 0,
      claim: null,
      blocked: null,
      result: null,
      reason: null,
    })

    let at = head(b)
    const review = makeTask(b, alice, 'review both', { needs: [fix.id, docs.id, fix.id] })
    expect(review).toMatchObject({ labels: { 'board.task': 'waiting' }, task: { state: 'waiting', needs: [fix.id, docs.id] } })
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload.along ?? null])).toEqual([
      ['message.posted', 1],
      ['task.created', null],
    ])
    expect(loadRow(b.store.db, Number(review.id))!.needs).toEqual([Number(fix.id), Number(docs.id)])
    // The event carries the needs as numbers, first appearance kept.
    expect(taskEventsAfter(b, at)[1]!.payload).toEqual({
      id: Number(review.id),
      thread: review.thread,
      needs: [Number(fix.id), Number(docs.id)],
      for: null,
      by: AUTHOR,
    })

    finish(b, alice, fix.id)
    finish(b, alice, docs.id)
    at = head(b)
    const announce = makeTask(b, alice, 'announce it', { needs: [fix.id, docs.id] })
    expect(announce.task).toMatchObject({ state: 'ready', needs: [fix.id, docs.id] })
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload.along ?? null])).toEqual([
      ['message.posted', 2],
      ['task.created', null],
      ['task.ready', null],
    ])

    at = head(b)
    const plain = makeTask(b, alice, 'nothing to wait for')
    expect(plain.task?.state).toBe('ready')
    expect(taskEventsAfter(b, at).map((e) => e.type)).toEqual(['message.posted', 'task.created'])
  })

  it('AT-06 create with claim: along 2, epoch 1, a 22-character board token, until now + the lease', () => {
    const b = open()
    const at = head(b)
    const made = b.board.tasks.createTask(alice, { channel: 'dev', text: 'mine now', claim: true })
    expect(made.claim).toEqual({ epoch: 1, token: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), until: iso(T0 + 900_000) })
    expect(made.task).toMatchObject({
      labels: { 'board.task': 'claimed' },
      task: { state: 'claimed', epoch: 1, claim: { actor: ALICE, until: iso(T0 + 900_000) } },
    })
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload.along ?? null])).toEqual([
      ['message.posted', 2],
      ['task.created', null],
      ['task.claimed', null],
    ])
    const withLease = b.board.tasks.createTask(alice, { channel: 'dev', text: 'short', claim: true, lease: 30, token: TOKEN })
    expect(withLease.claim).toEqual({ epoch: 1, token: TOKEN, until: iso(T0 + 30_000) })
  })

  it('AT-07 a create with claim that hits task_waiting or task_assigned writes nothing', () => {
    const b = open()
    const fix = makeTask(b, alice, 'fix it')
    const events = eventCount(b)
    const messages = messageCount(b)
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'ship it', needs: [fix.id], claim: true }))).toEqual([
      409,
      'task_waiting',
      `the task would wait for #${fix.id}: nothing was made`,
    ])
    expect(
      refusal(() =>
        b.board.tasks.createTask(alice, { channel: 'dev', text: 'for fixer', for: `${ALICE}+fixer`, claim: true }),
      ),
    ).toEqual([409, 'task_assigned', `the task would be assigned to ${ALICE}+fixer: nothing was made`])
    expect(eventCount(b)).toBe(events)
    expect(messageCount(b)).toBe(messages)
    // The assignee itself may make it claimed.
    const fixer = aliceAs('fixer')
    const own = b.board.tasks.createTask(fixer, { channel: 'dev', text: 'mine from the start', for: `${ALICE}+fixer`, claim: true })
    expect(own.task.task).toMatchObject({ state: 'claimed', for: `${ALICE}+fixer`, by: `${ALICE}+fixer`, claim: { actor: `${ALICE}+fixer` } })
  })

  it("AT-08 single-create idempotency: a retry gets the task back, its claim only with the live token, and another write's id is 409", () => {
    const b = open()
    const first = b.board.tasks.createTask(alice, { channel: 'dev', text: 'deploy a1b2c3', id: 'deploy-a1b2c3', claim: true })
    expect(first.claim).toMatchObject({ epoch: 1, until: iso(T0 + 900_000) })
    const events = eventCount(b)
    const again = b.board.tasks.createTask(alice, { channel: 'dev', text: 'deploy a1b2c3', id: 'deploy-a1b2c3', claim: true })
    expect(again.task.id).toBe(first.task.id)
    // The board's secret was answered once: no claim comes back, and the task is still held by the claim that made it.
    expect(again.claim).toBeUndefined()
    expect(again.task.task).toMatchObject({ state: 'claimed', epoch: 1 })
    expect(eventCount(b)).toBe(events)
    // The claim it was made with still settles it.
    expect(b.board.tasks.completeTask(alice, first.task.id, { epoch: 1, token: first.claim!.token }).task.task?.state).toBe('completed')

    // With the live token the retry gets the claim back too.
    const held = b.board.tasks.createTask(alice, { channel: 'dev', text: 'deploy d4', id: 'deploy-d4', claim: true, token: TOKEN })
    const before = eventCount(b)
    const replayed = b.board.tasks.createTask(alice, { channel: 'dev', text: 'deploy d4', id: 'deploy-d4', claim: true, token: TOKEN })
    expect(replayed.claim).toEqual(held.claim)
    expect(replayed.task.id).toBe(held.task.id)
    expect(eventCount(b)).toBe(before)
    // A retry without claim, of a create that claimed, is still a 201 with the task.
    expect(b.board.tasks.createTask(alice, { channel: 'dev', text: 'deploy d4', id: 'deploy-d4' }).task.id).toBe(held.task.id)

    // An id a plain post took is that post's; another author's id is another write's.
    b.board.postMessage(alice, { channel: 'dev', text: 'just a note', id: 'a-note' })
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'just a note', id: 'a-note' }))).toEqual([
      409,
      'duplicate_id',
      'that id was already used for a different write',
    ])
    expect(refusal(() => b.board.tasks.createTask(bob, { channel: 'dev', text: 'deploy a1b2c3', id: 'deploy-a1b2c3' }))[1]).toBe(
      'duplicate_id',
    )
    // In another channel it's another write too.
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'ops', text: 'deploy a1b2c3', id: 'deploy-a1b2c3' }))[1]).toBe(
      'duplicate_id',
    )
    // The board's own ids are no request's.
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'x', id: 'sync:abc' }))[1]).toBe('invalid_request')
  })

  it("holds a root's limits and the board's labels: text, files, needs, lease, for and board.*", () => {
    const b = open()
    const before = eventCount(b)
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'x'.repeat(10_001) }))[1]).toBe('text_too_long')
    const files = Array.from({ length: 11 }, (_, n) => `${'A'.repeat(21)}${String.fromCharCode(65 + n)}`)
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'with a trace', attachments: files }))).toEqual([
      400,
      'invalid_request',
      'attachments: a message carries at most 10',
    ])
    const many = Array.from({ length: 21 }, (_, i) => String(1000 + i))
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'all', needs: many }))).toEqual([
      400,
      'invalid_request',
      'needs: a task waits for at most 20 tasks',
    ])
    // Twenty distinct, however often each is named, are within it: they're looked up, and these aren't tasks.
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'all', needs: many.slice(0, 20) }))[1]).toBe(
      'invalid_needs',
    )
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'x', claim: true, lease: 29 }))).toEqual([
      400,
      'invalid_request',
      'lease: a lease is 30 to 3600 seconds',
    ])
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'x', lease: 60 }))[1]).toBe('invalid_request')
    for (const actor of [`${BOB_ID}+fixer`, ALICE, `${ALICE}+`, `${ALICE}+Not A Profile`, 'fixer']) {
      expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'for someone else', for: actor })), actor).toEqual([
        400,
        'invalid_request',
        `for: a task is assigned to one of its owner's profiles, ${ALICE}+<profile>, got ${actor}`,
      ])
    }
    // AT-33 board.task is the board's own label, on a task's root as on any post.
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev', text: 'x', labels: { 'board.task': 'completed' } }))).toEqual([
      400,
      'reserved_label',
      "board.task is the board's own label: only its task writes set labels under board.",
    ])
    expect(refusal(() => b.board.tasks.createTask(alice, { channel: 'dev' }))[1]).toBe('invalid_request')
    expect(eventCount(b)).toBe(before)
  })

  it('needs `post` to start a thread as one, `label` for its labels or a claim', () => {
    const b = open()
    const runner = userWith('runner', 'dev=read,post;triage=read,post,label;audit=read')
    const made = b.board.tasks.createTask(runner, { channel: 'dev', text: 'bump the lockfile' })
    expect(made.task).toMatchObject({ labels: { 'board.task': 'ready' }, task: { owner: 'local:user:runner' } })
    expect(refusal(() => b.board.tasks.createTask(runner, { channel: 'dev', text: 'labeled', labels: { step: 'fix' } }))).toEqual([
      403,
      'forbidden',
      "this token can't label in dev",
    ])
    expect(refusal(() => b.board.tasks.createTask(runner, { channel: 'dev', text: 'claimed', claim: true }))).toEqual([
      403,
      'forbidden',
      "this token can't label in dev",
    ])
    expect(b.board.tasks.createTask(runner, { channel: 'triage', text: 'labeled', labels: { step: 'fix' }, claim: true }).claim?.epoch).toBe(1)
    expect(refusal(() => b.board.tasks.createTask(runner, { channel: 'audit', text: 'read-only here' }))).toEqual([
      403,
      'forbidden',
      "this token can't post in audit",
    ])
    expect(refusal(() => b.board.tasks.createTask(runner, { channel: 'elsewhere', text: 'no access' }))[0]).toBe(403)
  })
})


describe('A2 adopt', () => {
  it('AT-09 adopt: a reply 400, a deleted root message_deleted, a task 409, unreadable 404, readable without label 403', () => {
    const b = open()
    const issue = b.board.postMessage(bob, { channel: 'issues', text: 'export times out', labels: { kind: 'bug' } }).message
    const reply = b.board.postMessage(bob, { re: issue.id, text: 'still happening' }).message

    let at = head(b)
    const made = b.board.tasks.createTask(alice, { re: issue.id })
    expect(made.task).toMatchObject({
      id: issue.id,
      text: 'export times out',
      by: { actor: BOB_ID },
      labels: { kind: 'bug', 'board.task': 'ready' },
      task: { state: 'ready', owner: ALICE, by: ALICE },
    })
    expect(made.claim).toBeUndefined()
    // No message.posted: the thread is as it was written.
    expect(taskEventsAfter(b, at).map((e) => e.type)).toEqual(['task.created'])

    expect(refusal(() => b.board.tasks.createTask(alice, { re: issue.id }))).toEqual([409, 'already_a_task', `#${issue.id} is a task already`])
    expect(refusal(() => b.board.tasks.createTask(alice, { re: reply.id }))).toEqual([
      400,
      'invalid_request',
      `#${reply.id} is a reply: a task is a thread, so name its root, #${issue.id}`,
    ])
    expect(refusal(() => b.board.tasks.createTask(alice, { re: '999' }))).toEqual([404, 'message_not_found', 'message not found: #999'])
    expect(refusal(() => b.board.tasks.createTask(alice, { re: 'nope' }))[1]).toBe('message_not_found')
    const gone = b.board.postMessage(bob, { channel: 'issues', text: 'never mind' }).message
    b.board.deleteMessage(bob, gone.id)
    expect(refusal(() => b.board.tasks.createTask(alice, { re: gone.id }))).toEqual([400, 'message_deleted', 'message was deleted'])
    // `re` takes the thread as it is.
    expect(refusal(() => b.board.tasks.createTask(alice, { re: issue.id, text: 'mine now' }))[1]).toBe('invalid_request')

    // Unreadable is not there; readable without label is forbidden: both before the reply, deleted and task checks.
    const runner = userWith('runner', 'issues=read,post')
    const hidden = b.board.postMessage(alice, { channel: 'secret', text: 'out of sight' }).message
    expect(refusal(() => b.board.tasks.createTask(runner, { re: hidden.id }))).toEqual([404, 'message_not_found', `message not found: #${hidden.id}`])
    const plain = b.board.postMessage(alice, { channel: 'issues', text: 'a thread' }).message
    expect(refusal(() => b.board.tasks.createTask(runner, { re: plain.id }))).toEqual([403, 'forbidden', "this token can't label in issues"])
    expect(refusal(() => b.board.tasks.createTask(runner, { re: reply.id }))[0]).toBe(403)
    expect(refusal(() => b.board.tasks.createTask(runner, { re: issue.id }))[0]).toBe(403)
    expect(refusal(() => b.board.tasks.createTask(runner, { re: gone.id }))[0]).toBe(403)
    const hiddenReply = b.board.postMessage(alice, { re: hidden.id, text: 'a hidden reply' }).message
    expect(refusal(() => b.board.tasks.createTask(runner, { re: hiddenReply.id }))[0]).toBe(404)

    // Adopt with needs and a claim: the same waits and assigned checks, with the adopt's own words.
    at = head(b)
    const other = makeTask(b, alice, 'not done')
    const thread = b.board.postMessage(alice, { channel: 'issues', text: 'later' }).message
    expect(refusal(() => b.board.tasks.createTask(alice, { re: thread.id, needs: [other.id], claim: true }))).toEqual([
      409,
      'task_waiting',
      `#${thread.id} would wait for #${other.id}: it wasn't made a task`,
    ])
    expect(refusal(() => b.board.tasks.createTask(alice, { re: thread.id, for: `${ALICE}+fixer`, claim: true }))).toEqual([
      409,
      'task_assigned',
      `#${thread.id} would be assigned to ${ALICE}+fixer: it wasn't made a task`,
    ])
    expect(refusal(() => b.board.tasks.createTask(alice, { re: thread.id, needs: [thread.id] }))).toEqual([
      400,
      'invalid_needs',
      `needs: #${thread.id} is the task itself: it can't wait for itself`,
    ])
    at = head(b)
    const claimed = b.board.tasks.createTask(alice, { re: thread.id, claim: true, lease: 60 })
    expect(claimed.claim).toEqual({ epoch: 1, token: expect.any(String), until: iso(T0 + 60_000) })
    expect(taskEventsAfter(b, at).map((e) => e.type)).toEqual(['task.created', 'task.claimed'])
    expect(taskOf(b, thread.id)).toMatchObject({ state: 'claimed', owner: ALICE })
  })
})

describe('A2 needs validation', () => {
  it('AT-27 an unreadable task, a missing ID and a plain message give the same invalid_needs words', () => {
    const b = open()
    const runner = userWith('runner', 'dev=read,post,label')
    const plain = b.board.postMessage(alice, { channel: 'dev', text: 'not a task' }).message
    const secret = b.board.tasks.createTask(alice, { channel: 'secret', text: 'rotate the keys' }).task
    const mine = makeTask(b, runner, 'bump the lockfile')
    const words = (needs: string[]) => refusal(() => b.board.tasks.createTask(runner, { channel: 'dev', text: 'after that', needs }))
    expect(words(['999'])).toEqual([400, 'invalid_needs', "needs: #999 isn't a task"])
    expect(words([secret.id])).toEqual([400, 'invalid_needs', `needs: #${secret.id} isn't a task`])
    expect(words([plain.id])).toEqual([400, 'invalid_needs', `needs: #${plain.id} isn't a task`])
    expect(words(['nope'])).toEqual([400, 'invalid_needs', "needs: #nope isn't a task"])
    expect(words(['0'])).toEqual([400, 'invalid_needs', "needs: #0 isn't a task"])
    expect(words([mine.id, plain.id])[2]).toBe(`needs: #${plain.id} isn't a task`)
    // A canceled one says so, but only to a caller that reads it.
    const dropped = makeTask(b, alice, 'dropped')
    b.board.tasks.cancelTask(alice, dropped.id, { reason: 'not needed after all' })
    expect(words([mine.id, dropped.id])).toEqual([400, 'invalid_needs', `needs: #${dropped.id} was canceled: it can never complete`])
    b.board.tasks.cancelTask(alice, secret.id, { reason: 'rotated by hand' })
    expect(words([secret.id])).toEqual([400, 'invalid_needs', `needs: #${secret.id} isn't a task`])
    // A failed one may be reopened, so it's still something to wait for.
    const build = makeTask(b, runner, 'build the image')
    const claim = b.board.tasks.claimTask(runner, build.id, {}).claim
    b.board.tasks.failTask(runner, build.id, { epoch: claim.epoch, token: claim.token, reason: 'registry is down' })
    expect(makeTask(b, runner, 'deploy it', { needs: [build.id] }).task).toMatchObject({ state: 'waiting', needs: [build.id] })
  })
})
