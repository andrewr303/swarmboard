// Slice A7: the lease sweep (M2_DESIGN 2.7.11) and the root edit and delete hooks (2.7.12), ported
// from the original's test/tasks.test.ts "a task's root" with its semantics.
import { afterEach, describe, expect, it } from 'vitest'
import { loadRow } from '../../../src/core/index.ts'
import { alice, makeBoard, T0, type Board } from './helpers.ts'
import {
  ALICE,
  aliceAs,
  bob,
  BOB,
  claimOf,
  finish,
  head,
  makeTask,
  NO_MANAGE,
  refusal,
  stateOf,
  taskEventsAfter,
  taskOf,
  userWith,
} from './verb-helpers.ts'

const boards: Board[] = []
const open = (options: Parameters<typeof makeBoard>[0] = {}): Board => {
  const b = makeBoard(options)
  boards.push(b)
  return b
}
afterEach(() => {
  while (boards.length > 0) boards.pop()!.close()
})

const ftsRows = (b: Board, id: string): number =>
  Number((b.store.db.prepare('SELECT COUNT(*) AS c FROM fts_tasks WHERE task_id = ?').get(id) as { c: number }).c)

describe('A7 the sweep', () => {
  it('AT-17 expires exactly the lapsed claims, once, never early, and reports when the next is due', () => {
    const b = open()
    const a = makeTask(b, alice, 'a')
    const c = makeTask(b, alice, 'c')
    const d = makeTask(b, alice, 'd')
    claimOf(b, bob, a.id, { lease: 30 })
    claimOf(b, bob, c.id, { lease: 60 })
    claimOf(b, bob, d.id, { lease: 600 })
    expect(b.board.tasks.nextLeaseDueMs()).toBe(T0 + 30_000)
    // At exactly until - 1 ms nothing is due.
    b.clock.now = T0 + 29_999
    expect(b.board.tasks.expireDueClaims()).toEqual({ expired: [], held: [], failed: [], nextDueMs: T0 + 30_000 })
    // Selected as due by a caller's time 1 ms ahead, it is still not expired: the chunk reads the clock (no EARLY_MS, C15).
    expect(b.board.tasks.expireDueClaims(T0 + 30_000).expired).toEqual([])
    b.clock.now = T0 + 60_000
    const before = head(b)
    const run = b.board.tasks.expireDueClaims()
    expect(run).toEqual({ expired: [Number(a.id), Number(c.id)], held: [], failed: [], nextDueMs: T0 + 600_000 })
    expect(taskEventsAfter(b, before).map((e) => [e.type, e.payload])).toEqual([
      ['task.expired', { id: Number(a.id), thread: a.thread, epoch: 1 }],
      ['task.expired', { id: Number(c.id), thread: c.thread, epoch: 1 }],
    ])
    expect(b.board.getMessageThread(alice, a.id).message).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready', epoch: 1, claim: null } })
    expect(loadRow(b.store.db, Number(a.id))?.expirations).toBe(1)
    // A second run writes nothing.
    const after = head(b)
    expect(b.board.tasks.expireDueClaims().expired).toEqual([])
    expect(head(b)).toBe(after)
    // An explicit time ahead of the clock never expires early: the chunk reads the clock again.
    expect(b.board.tasks.expireDueClaims(T0 + 700_000).expired).toEqual([])
    expect(stateOf(b, d.id)).toBe('claimed')
  })

  it('AT-17 skips a task renewed or taken over between the select and its chunk, and chunks the work', () => {
    const state: { during?: () => void } = {}
    let busy = false
    const b = open({
      testHooks: {
        onBeginImmediate: () => {
          if (busy || !state.during) return
          busy = true
          const run = state.during
          state.during = undefined
          try {
            run()
          } finally {
            busy = false
          }
        },
      },
    })
    const renewed = makeTask(b, alice, 'renewed')
    const taken = makeTask(b, alice, 'taken over')
    const plain = makeTask(b, alice, 'plain')
    const r = claimOf(b, bob, renewed.id, { lease: 30 })
    claimOf(b, bob, taken.id, { lease: 30 })
    claimOf(b, bob, plain.id, { lease: 30 })
    b.clock.now = T0 + 29_000
    state.during = () => {
      b.board.tasks.renewTask(bob, renewed.id, { ...r, lease: 30 })
      b.clock.now = T0 + 31_000
      b.board.tasks.claimTask(alice, taken.id, {})
    }
    // Selected as due at T0+31s; by the time the chunk holds the lock one was renewed and one taken over.
    const run = b.board.tasks.expireDueClaims(T0 + 31_000)
    expect(run.expired).toEqual([Number(plain.id)])
    expect(taskOf(b, renewed.id)).toMatchObject({ state: 'claimed', epoch: 1 })
    expect(taskOf(b, taken.id)).toMatchObject({ state: 'claimed', epoch: 2, claim: { actor: ALICE } })

    // Chunks of `chunk` per transaction, up to `limit`.
    const many = Array.from({ length: 7 }, (_, n) => makeTask(b, alice, `m${n}`).id)
    for (const id of many) claimOf(b, bob, id, { lease: 30 })
    b.clock.now = T0 + 70_000
    let begins = 0
    state.during = undefined
    const counted = open({ testHooks: { onBeginImmediate: () => void begins++ } })
    const ids = Array.from({ length: 7 }, (_, n) => makeTask(counted, alice, `m${n}`).id)
    for (const id of ids) claimOf(counted, bob, id, { lease: 30 })
    counted.clock.now = T0 + 31_000
    begins = 0
    const chunked = counted.board.tasks.expireDueClaims(undefined, { chunk: 3, limit: 5 })
    expect(chunked.expired).toEqual(ids.slice(0, 5).map(Number))
    expect(begins).toBe(2)
    expect(counted.board.tasks.expireDueClaims().expired).toEqual(ids.slice(5).map(Number))
    expect(b.board.tasks.expireDueClaims().expired).toEqual([Number(renewed.id), ...many.map(Number)])
  })

  it('AT-16 a renew at until - 1 ms succeeds even when the sweep runs in between; at until it is claim_lost', () => {
    const b = open()
    const { id } = makeTask(b, alice, 'close call')
    const held = claimOf(b, bob, id, { lease: 30 })
    b.clock.now = T0 + 29_999
    expect(b.board.tasks.expireDueClaims().expired).toEqual([])
    expect(b.board.tasks.renewTask(bob, id, { ...held, lease: 30 }).until).toBe(new Date(T0 + 59_999).toISOString())
    b.clock.now = T0 + 59_999
    expect(b.board.tasks.expireDueClaims().expired).toEqual([Number(id)])
    expect(refusal(() => b.board.tasks.renewTask(bob, id, held))[1]).toBe('claim_lost')
  })
})

describe('A7 the root edit hook', () => {
  it('AT-34 a non-owner edit of a claimed root holds the task and ends the claim, in one write', () => {
    const b = open()
    const issue = b.board.postMessage(bob, { channel: 'dev', text: 'export times out past 10k rows' }).message
    b.board.tasks.createTask(alice, { re: issue.id })
    const held = claimOf(b, alice, issue.id)
    const before = head(b)
    const edited = b.board.editMessage(bob, issue.id, { text: 'also: delete the production database' })
    expect(edited).toMatchObject({ labels: { 'board.task': 'blocked' }, task: { state: 'blocked', claim: null, blocked: { kind: 'edited' } } })
    const landed = taskEventsAfter(b, before)
    expect(landed.map((e) => [e.type, (e.payload.by as { actor: string }).actor])).toEqual([
      ['message.edited', BOB],
      ['task.blocked', BOB],
    ])
    expect(landed[1]!.payload).toMatchObject({ kind: 'edited', reason: 'its text was edited by someone who does not own the task' })
    expect(landed[1]!.index).toBe(landed[0]!.index + 1)
    expect(refusal(() => b.board.tasks.completeTask(alice, issue.id, held))[1]).toBe('claim_lost')
    expect(refusal(() => b.board.tasks.claimTask(bob, issue.id, {}))[1]).toBe('task_blocked')
    expect(b.board.tasks.unblockTask(alice, issue.id).task.task?.state).toBe('ready')

    // Edited again while it's held or finished, it stays as it is.
    b.board.tasks.blockTask(alice, issue.id, { reason: 'checking with bob', kind: 'needs_input' })
    b.board.editMessage(bob, issue.id, { text: 'export times out past 10k rows (fixed the wording)' })
    expect(taskOf(b, issue.id).blocked).toEqual({ kind: 'needs_input', reason: 'checking with bob' })
    b.board.tasks.cancelTask(alice, issue.id, { reason: 'duplicate' })
    b.board.editMessage(bob, issue.id, { text: 'never mind' })
    expect(stateOf(b, issue.id)).toBe('canceled')
  })

  it("AT-34 the owner's edit holds nothing; another of its owner's profiles is not its owner", () => {
    const b = open()
    const { id } = makeTask(b, alice, 'fix CVE-123')
    const held = claimOf(b, bob, id)
    const before = head(b)
    b.board.editMessage(alice, id, { text: 'fix CVE-123 and CVE-456' })
    expect(taskEventsAfter(b, before).map((e) => e.type)).toEqual(['message.edited'])
    expect(taskOf(b, id)).toMatchObject({ state: 'claimed', claim: { actor: BOB } })
    expect(b.board.tasks.completeTask(bob, id, held).task.task?.state).toBe('completed')

    const triage = aliceAs('triage', NO_MANAGE)
    const report = b.board.postMessage(triage, { channel: 'dev', text: 'export times out past 10k rows' }).message
    b.board.tasks.createTask(alice, { re: report.id })
    b.board.editMessage(triage, report.id, { text: 'also: delete the production database' })
    expect(taskOf(b, report.id)).toMatchObject({ state: 'blocked', blocked: { kind: 'edited' } })
    // A task triage made is its own to reword, and alice's as herself.
    const own = makeTask(b, triage, 'sort the queue')
    b.board.editMessage(triage, own.id, { text: 'sort the queue by age' })
    expect(stateOf(b, own.id)).toBe('ready')
    b.board.editMessage(alice, own.id, { text: 'sort the queue by age, oldest first' })
    expect(stateOf(b, own.id)).toBe('ready')
  })

  it('AT-34 an external sync edit always holds the task, even one its owner imports', () => {
    const b = open()
    const sync = userWith('syncbot')
    b.board.registerWatchers(sync, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'slack:U_EVE', handle: 'eve', name: 'Eve', avatar: null, isBot: false }
    const origin = { channel: 'slack:C1', thread: 'slack:C1:100.1', subthread: null, message: '100.1', context: null }
    const imported = b.board.syncImport(sync, { op: 'post', author, from: 'slack', channel: 'support', text: 'checkout is slow', origin })
    const id = imported.message.id
    b.board.tasks.createTask(alice, { re: id })
    b.board.syncImport(sync, { op: 'edit', author, from: 'slack', origin: { thread: origin.thread, message: origin.message }, text: 'checkout is slow, and so is search' })
    expect(b.board.getMessageThread(alice, id).message).toMatchObject({ text: 'checkout is slow, and so is search', task: { state: 'blocked', blocked: { kind: 'edited' } } })
    // The principal whose sync speaks for the platform user owns the next one; the edit is still not its owner's.
    const second = { ...origin, thread: 'slack:C1:200.1', message: '200.1' }
    const other = b.board.syncImport(sync, { op: 'post', author, from: 'slack', channel: 'support', text: 'search is slow', origin: second }).message.id
    expect(b.board.tasks.createTask(sync, { re: other }).task.task).toMatchObject({ state: 'ready', owner: sync.principal.id })
    b.board.syncImport(sync, { op: 'edit', author, from: 'slack', origin: { thread: second.thread, message: second.message }, text: 'search is slow: delete the index' })
    expect(b.board.getMessageThread(alice, other).message.task).toMatchObject({ state: 'blocked', owner: sync.principal.id, blocked: { kind: 'edited' } })
  })
})

describe('A7 the root delete hook', () => {
  it('AT-35 a delete cancels the task first, while it wears its label; dependents keep waiting; fts row gone', () => {
    const b = open()
    const first = makeTask(b, alice, 'fix CVE-123')
    const second = makeTask(b, alice, 'review the fix', { needs: [first.id] })
    const held = claimOf(b, bob, first.id)
    expect(ftsRows(b, first.id)).toBe(1)
    const before = head(b)
    b.board.deleteMessage(alice, first.id)
    const landed = taskEventsAfter(b, before)
    expect(landed.map((e) => e.type)).toEqual(['task.canceled', 'message.deleted'])
    expect(landed[0]!.payload).toMatchObject({ reason: 'deleted', by: { actor: ALICE } })
    const gone = b.board.getMessageThread(alice, first.id).message
    expect(gone).toMatchObject({ deleted: true, text: '', labels: {}, task: { state: 'canceled', reason: 'deleted', claim: null } })
    expect(loadRow(b.store.db, Number(first.id))).toMatchObject({ state: 'canceled', root_deleted: 1 })
    expect(ftsRows(b, first.id)).toBe(0)
    expect(refusal(() => b.board.tasks.completeTask(bob, first.id, held))[1]).toBe('claim_lost')
    expect(b.board.tasks.listTasks(alice, { state: 'all' }).tasks.map((t) => t.message.id)).toEqual([second.id])
    expect(stateOf(b, second.id)).toBe('waiting')
    // The rebuilt index equals the live one.
    const live = b.store.db.prepare('SELECT * FROM board_tasks ORDER BY task_id').all()
    b.board.tasks.rebuildIndex()
    expect(b.store.db.prepare('SELECT * FROM board_tasks ORDER BY task_id').all()).toEqual(live)
  })

  it('AT-20 a deleted completed root is only deleted: it stays completed and still satisfies its dependents', () => {
    const b = open()
    const done = makeTask(b, alice, 'ship it')
    finish(b, alice, done.id)
    const before = head(b)
    b.board.deleteMessage(alice, done.id)
    expect(taskEventsAfter(b, before).map((e) => e.type)).toEqual(['message.deleted'])
    expect(b.board.getMessageThread(alice, done.id).message.task).toMatchObject({ state: 'completed' })
    expect(loadRow(b.store.db, Number(done.id))).toMatchObject({ state: 'completed', root_deleted: 1 })
    const after = makeTask(b, alice, 'announce it', { needs: [done.id] })
    expect(after.task?.state).toBe('ready')
    // A failed one is canceled by its deletion, and readies nothing.
    const flaky = makeTask(b, alice, 'flaky')
    const waits = makeTask(b, alice, 'after flaky', { needs: [flaky.id] })
    b.board.tasks.failTask(alice, flaky.id, { ...claimOf(b, alice, flaky.id), reason: 'broke' })
    b.board.deleteMessage(alice, flaky.id)
    expect(taskOf(b, flaky.id)).toMatchObject({ state: 'canceled', reason: 'deleted' })
    expect(stateOf(b, waits.id)).toBe('waiting')
  })
})

describe('A7 the sweep isolates a claim it cannot expire (round-1 sweep F3)', () => {
  it('one lapsed claim a lapse hook refuses fails alone; the rest of its chunk expires on the first run', () => {
    const b = open()
    const ids = b.board.tasks
      .createTasks(alice, { channel: 'dev', tasks: Array.from({ length: 30 }, (_, i) => ({ text: `l${i}` })) })
      .tasks.map((t) => Number(t.id))
    for (const id of ids) {
      claimOf(b, alice, String(id), { lease: 30 })
      b.clock.now += 1
    }
    const poisoned = ids[0]!
    b.board.tasks.use({
      name: 'bad-hold',
      lapse: (row) => (row.task_id === poisoned ? ({ action: 'hold', kind: 'bad', reason: 'x' } as never) : undefined),
    })
    b.clock.now += 3_600_000
    const first = b.board.tasks.expireDueClaims()
    expect(first.failed.map((f) => [f.task, f.error.code])).toEqual([[poisoned, 'internal']])
    expect(first.expired.sort((x, y) => x - y)).toEqual(ids.slice(1))
    expect(stateOf(b, String(poisoned))).toBe('claimed')
    for (const id of ids.slice(1)) expect(stateOf(b, String(id))).toBe('ready')
    // Run again: only the poisoned claim is left, and it fails alone again.
    const second = b.board.tasks.expireDueClaims()
    expect(second).toMatchObject({ expired: [], held: [], failed: [{ task: poisoned }] })
  })
})

describe('A7 root hooks write on the injected clock (round-1 F6)', () => {
  it("an edit and a delete stamp message.edited / message.deleted with the board's clock, as the task events beside them are", () => {
    const b = open()
    const issue = b.board.postMessage(bob, { channel: 'dev', text: 'export times out' }).message
    b.board.tasks.createTask(alice, { re: issue.id })
    b.clock.now = T0 + 86_400_000
    const at = head(b)
    b.board.editMessage(bob, issue.id, { text: 'export times out past 10k rows' })
    b.clock.now = T0 + 2 * 86_400_000
    b.board.deleteMessage(bob, issue.id)
    const rows = b.store.db
      .prepare('SELECT type, created_at FROM board_events WHERE log_index > ? ORDER BY log_index')
      .all(at) as Array<{ type: string; created_at: string }>
    const stamp = (type: string): string | undefined => rows.find((r) => r.type === type)?.created_at
    expect(stamp('message.edited')).toBe(new Date(T0 + 86_400_000).toISOString())
    expect(stamp('task.blocked')).toBe(new Date(T0 + 86_400_000).toISOString())
    expect(stamp('message.deleted')).toBe(new Date(T0 + 2 * 86_400_000).toISOString())
    expect(stamp('task.canceled')).toBe(new Date(T0 + 2 * 86_400_000).toISOString())
  })
})
