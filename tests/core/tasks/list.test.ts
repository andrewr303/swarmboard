// Slice A6: listing tasks (M2_DESIGN 2.7.13), ported from the original's test/tasks.test.ts
// "listing tasks" with its semantics: open by default, a lapsed claim reads `ready`, the cursor rule.
import { afterEach, describe, expect, it } from 'vitest'
import { alice, makeBoard, T0, type Board } from './helpers.ts'
import { ALICE, BOB, bob, claimOf, finish, head, makeTask, refusal, userWith } from './verb-helpers.ts'

const boards: Board[] = []
const open = (): Board => {
  const b = makeBoard()
  boards.push(b)
  return b
}
afterEach(() => {
  while (boards.length > 0) boards.pop()!.close()
})

const ids = (b: Board, query: Record<string, unknown> = {}, as = alice): string[] =>
  b.board.tasks.listTasks(as, query).tasks.map((t) => t.message.id)

describe('A6 listTasks', () => {
  it('lists open tasks oldest first, as thread summaries, and others by their state', () => {
    const b = open()
    const first = makeTask(b, alice, 'first')
    const waiting = makeTask(b, alice, 'second', { needs: [first.id] })
    const held = makeTask(b, alice, 'held')
    b.board.tasks.blockTask(alice, held.id, { reason: 'hold on' })
    const done = b.board.tasks.createTask(bob, { channel: 'ops', text: 'done' }).task
    finish(b, bob, done.id)
    const dropped = makeTask(b, alice, 'dropped')
    b.board.tasks.cancelTask(alice, dropped.id, { reason: 'no' })
    const failed = makeTask(b, alice, 'failed')
    b.board.tasks.failTask(alice, failed.id, { ...claimOf(b, alice, failed.id), reason: 'broke' })
    const working = makeTask(b, alice, 'in progress')
    claimOf(b, bob, working.id)
    b.board.postMessage(bob, { re: working.id, text: 'halfway' })
    const last = b.board.postMessage(bob, { re: working.id, text: 'nearly' }).message
    b.board.postMessage(alice, { channel: 'dev', text: 'not a task at all' })

    expect(ids(b)).toEqual([first.id, waiting.id, held.id, working.id])
    expect(ids(b, { state: 'open' })).toEqual([first.id, waiting.id, held.id, working.id])
    expect(ids(b, { state: 'all' })).toEqual([first.id, waiting.id, held.id, done.id, dropped.id, failed.id, working.id])
    expect(ids(b, { state: 'ready' })).toEqual([first.id])
    expect(ids(b, { state: 'waiting' })).toEqual([waiting.id])
    expect(ids(b, { state: 'claimed' })).toEqual([working.id])
    expect(ids(b, { state: 'blocked' })).toEqual([held.id])
    expect(ids(b, { state: 'completed' })).toEqual([done.id])
    expect(ids(b, { state: 'canceled' })).toEqual([dropped.id])
    expect(ids(b, { state: 'failed' })).toEqual([failed.id])
    expect(refusal(() => b.board.tasks.listTasks(alice, { state: 'done' }))[1]).toBe('invalid_request')
    expect(ids(b, { state: 'all', channel: 'ops' })).toEqual([done.id])
    expect(ids(b, { state: 'all', owner: 'bob' })).toEqual([done.id])
    expect(ids(b, { state: 'all', owner: BOB })).toEqual([done.id])
    expect(ids(b, { state: 'all', by: 'bob' })).toEqual([done.id])
    expect(ids(b, { state: 'all', by: 'me' })).toEqual([first.id, waiting.id, held.id, dropped.id, failed.id, working.id])
    expect(ids(b, { needs: first.id })).toEqual([waiting.id])
    expect(ids(b, { needs: 'nope' })).toEqual([])

    // A summary: the root, how many replies it has, and the latest.
    const summary = b.board.tasks.listTasks(alice, { state: 'claimed' }).tasks[0]
    expect(summary).toMatchObject({ message: { id: working.id, task: { state: 'claimed' } }, replies: 2, last: { id: last.id, text: 'nearly' } })
    expect(b.board.tasks.listTasks(alice, { state: 'ready' }).tasks[0]).toMatchObject({ replies: 0, last: null })
  })

  it('pages by the cursor it reports, and finds tasks by their root labels and who they are for', () => {
    const b = open()
    const made: string[] = []
    for (let n = 1; n <= 5; n++) {
      made.push(makeTask(b, alice, `task ${n}`, { labels: { step: n % 2 ? 'fix' : 'review' }, ...(n === 4 ? { for: `${ALICE}+reviewer` } : {}) }).id)
    }
    const page = (query: Record<string, unknown>) => {
      const { tasks, cursor } = b.board.tasks.listTasks(alice, query)
      return { ids: tasks.map((t) => t.message.id), cursor }
    }
    const first = page({ limit: 2 })
    expect(first).toEqual({ ids: made.slice(0, 2), cursor: made[1] })
    const second = page({ limit: 2, after: first.cursor })
    expect(second.ids).toEqual(made.slice(2, 4))
    const third = page({ limit: 2, after: second.cursor })
    expect(third.ids).toEqual(made.slice(4))
    // Read to the end, the cursor is where the board is: a task made since comes after it.
    expect(third.cursor).toBe(String(head(b)))
    expect(page({ limit: 2, after: third.cursor }).ids).toEqual([])
    const later = makeTask(b, alice, 'task 6')
    expect(page({ limit: 2, after: third.cursor }).ids).toEqual([later.id])

    expect(page({ label: 'step=review' }).ids).toEqual([made[1], made[3]])
    expect(page({ label: ['step=fix'], limit: 2 }).ids).toEqual([made[0], made[2]])
    expect(page({ label: 'step=fix|review', limit: 50 }).ids).toEqual(made)
    expect(page({ for: `${ALICE}+reviewer` }).ids).toEqual([made[3]])
    expect(page({ for: 'nobody' }).ids).toEqual([])
    // A reply's label says nothing of its root.
    b.board.postMessage(alice, { re: made[1]!, text: 'a fix in a review', labels: { step: 'fix' } })
    expect(page({ label: 'step=fix' }).ids).toEqual([made[0], made[2], made[4]])
    expect(refusal(() => b.board.tasks.listTasks(alice, { after: 'nope' }))).toEqual([400, 'invalid_cursor', "nope isn't a cursor or a message ID on this board"])
    expect(refusal(() => b.board.tasks.listTasks(alice, { latest: true, after: made[0] }))[1]).toBe('invalid_request')
    expect(refusal(() => b.board.tasks.listTasks(alice, { limit: 501 }))[1]).toBe('invalid_request')
  })

  it('reads a lapsed claim as ready, and latest keeps the most recently active', () => {
    const b = open()
    const a = makeTask(b, alice, 'a')
    const c = makeTask(b, alice, 'c')
    claimOf(b, bob, a.id, { lease: 60 })
    expect(ids(b, { state: 'ready' })).toEqual([c.id])
    expect(ids(b, { state: 'claimed' })).toEqual([a.id])
    b.clock.now = T0 + 61_000
    // Nothing told the label yet, and the task is ready all the same.
    expect(b.board.getMessageThread(alice, a.id).message.labels['board.task']).toBe('claimed')
    expect(ids(b, { state: 'ready' })).toEqual([a.id, c.id])
    expect(ids(b, { state: 'claimed' })).toEqual([])
    // `latest`: the last `limit` by when each was last active, a reply counting for its thread.
    b.clock.now = T0 + 62_000
    b.board.postMessage(alice, { re: a.id, text: 'still on it' })
    const d = makeTask(b, alice, 'd')
    b.clock.now = T0 + 63_000
    b.board.postMessage(alice, { re: c.id, text: 'bump' })
    expect(ids(b, { latest: true, limit: 2 })).toEqual([d.id, c.id])
    expect(b.board.tasks.listTasks(alice, { latest: true, limit: 2 }).cursor).toBe(String(head(b)))
  })

  it('shows a reader only the tasks in channels it reads, and a subtree only its channels', () => {
    const b = open()
    const shown = makeTask(b, alice, 'in the open')
    const api = b.board.tasks.createTask(alice, { channel: 'dev/api', text: 'in the api' }).task
    b.board.tasks.createTask(alice, { channel: 'secret', text: 'rotate the keys' })
    const reader = userWith('reader', 'dev=read')
    expect(ids(b, { state: 'all' }, reader)).toEqual([shown.id])
    expect(ids(b, { channel: 'secret' }, reader)).toEqual([])
    expect(ids(b, { channel: 'dev/' })).toEqual([shown.id, api.id])
    expect(ids(b, { channel: 'dev' })).toEqual([shown.id])
    expect(ids(b, { channel: 'dev/' }, userWith('sub', 'dev/=read'))).toEqual([shown.id, api.id])
  })
})
