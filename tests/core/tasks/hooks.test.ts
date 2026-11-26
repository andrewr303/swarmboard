// Slice A8: the phased hook registry, reserved hold kinds and prefixes, the system author and
// capabilities() (M2_DESIGN 2.4.3, 2.5.3), with the hook variants of AT-05 and AT-18 and an AT-41
// baseline: a pass-through hook in every phase changes nothing.
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import {
  BoardError,
  loadAllRows,
  SYSTEM_PRINCIPAL_ID,
  type TaskApplied,
  type TaskHook,
  type TaskPlan,
} from '../../../src/core/index.ts'
import { alice, eventCount, makeBoard, T0, type Board } from './helpers.ts'
import { bob, claimOf, finish, head, makeTask, refusal, stateOf, taskEventsAfter, taskOf } from './verb-helpers.ts'

const boards: Board[] = []
const open = (): Board => {
  const b = makeBoard()
  boards.push(b)
  return b
}
afterEach(() => {
  while (boards.length > 0) boards.pop()!.close()
})

const wakeups = (b: Board): string | undefined =>
  (b.store.db.prepare("SELECT value FROM board_meta WHERE key = 'wakeup_generation'").get() as { value?: string } | undefined)?.value

const SYSTEM = { actor: SYSTEM_PRINCIPAL_ID, principal: SYSTEM_PRINCIPAL_ID, profile: null }

describe('A8 the hook registry', () => {
  it('AT-05 a plan hook that rewrites a verb into an illegal event rolls the whole write back with 500', () => {
    const b = open()
    const { id } = makeTask(b, alice, 'fix CVE-123')
    const remove = b.board.tasks.use({
      name: 'forger',
      plan: (plan) => (plan.op === 'claim' ? { ...plan, events: [...plan.events, { ...plan.events.at(-1)!, type: 'task.ready' }] } : plan),
    })
    const events = eventCount(b)
    const rows = JSON.stringify(loadAllRows(b.store.db))
    const message = b.store.db.prepare('SELECT data FROM board_messages WHERE id = ?').get(Number(id))
    const gen = wakeups(b)
    expect(refusal(() => b.board.tasks.claimTask(bob, id, {}))).toEqual([500, 'internal', `fold refused task.ready on #${id} at claimed`])
    expect(eventCount(b)).toBe(events)
    expect(JSON.stringify(loadAllRows(b.store.db))).toBe(rows)
    expect(b.store.db.prepare('SELECT data FROM board_messages WHERE id = ?').get(Number(id))).toEqual(message)
    expect(wakeups(b)).toBe(gen)
    remove()
    expect(claimOf(b, bob, id).epoch).toBe(1)
  })

  it('a plan hook may refuse a write, or rewrite a completion into a hold, which promotes nothing (step 8a)', () => {
    const b = open()
    const fix = makeTask(b, alice, 'fix CVE-123')
    const review = makeTask(b, alice, 'review it', { needs: [fix.id] })
    const seen: string[] = []
    b.board.tasks.use({
      name: 'gate',
      plan: (plan, tx) => {
        seen.push(`${plan.op}:${plan.taskId}:${plan.caller === 'system' ? 'system' : plan.caller.actor.id}`)
        if (plan.op === 'cancel') throw new BoardError(409, 'task_blocked', 'canceling is for the org layer')
        if (plan.op !== 'complete') return
        const done = plan.events[0]!
        expect(plan.before?.state).toBe('claimed')
        expect(tx.now()).toBe(b.clock.now)
        return {
          ...plan,
          events: [
            { type: 'task.blocked', taskId: done.taskId, payload: { id: done.payload.id, thread: done.payload.thread, kind: 'org.review', reason: 'awaiting review', by: tx.systemAuthor() } },
          ],
        }
      },
    })
    const before = eventCount(b)
    expect(refusal(() => b.board.tasks.cancelTask(alice, fix.id, { reason: 'no' }))).toEqual([409, 'task_blocked', 'canceling is for the org layer'])
    expect(eventCount(b)).toBe(before)
    const held = claimOf(b, bob, fix.id)
    const at = head(b)
    b.board.tasks.completeTask(bob, fix.id, held)
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload.kind ?? null])).toEqual([['task.blocked', 'org.review']])
    expect(taskOf(b, fix.id)).toMatchObject({ state: 'blocked', blocked: { kind: 'org.review', reason: 'awaiting review' } })
    expect(stateOf(b, review.id)).toBe('waiting')
    expect(seen).toContain(`complete:${fix.id}:${bob.actor.id}`)
    expect(seen).toContain(`claim:${fix.id}:${bob.actor.id}`)
  })

  it('applied runs inside the write (a throw rolls it back), committed after it, and tx.transition cascades through the writer', () => {
    const b = open()
    const parent = makeTask(b, alice, 'parent')
    const child = makeTask(b, alice, 'child')
    const applied: TaskApplied[] = []
    const committed: string[] = []
    let explode = false
    b.board.tasks.use({
      name: 'cascade',
      applied: (result, tx) => {
        applied.push(result)
        if (explode) throw new BoardError(409, 'conflict', 'no')
        // Canceling the parent cancels the child, in the same write.
        if (result.op === 'cancel' && result.events.some((e) => e.payload.id === Number(parent.id))) {
          tx.transition(Number(child.id), [
            { type: 'task.canceled', taskId: Number(child.id), payload: { id: Number(child.id), thread: child.thread, reason: 'parent canceled', by: tx.systemAuthor() } },
          ])
        }
      },
      committed: (result) => {
        committed.push(`${result.op}:${result.events.map((e) => e.type).join(',')}`)
        throw new Error('swallowed')
      },
    })
    explode = true
    const before = eventCount(b)
    expect(refusal(() => b.board.tasks.claimTask(bob, parent.id, {}))[1]).toBe('conflict')
    expect(eventCount(b)).toBe(before)
    expect(committed).toEqual([])
    explode = false
    const at = head(b)
    b.board.tasks.cancelTask(alice, parent.id, { reason: 'scope cut' })
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload.id])).toEqual([
      ['task.canceled', Number(parent.id)],
      ['task.canceled', Number(child.id)],
    ])
    expect(taskOf(b, child.id)).toMatchObject({ state: 'canceled', reason: 'parent canceled' })
    expect(applied.at(-1)?.rows.get(Number(parent.id))?.state).toBe('canceled')
    expect(committed).toEqual(['cancel:task.canceled'])
    // A create runs its hooks too, under op `create`; a batch under `batch`.
    b.board.tasks.createTask(alice, { channel: 'dev', text: 'new' })
    b.board.tasks.createTasks(alice, { channel: 'dev', tasks: [{ text: 'one' }, { text: 'two' }] })
    expect(committed.slice(1)).toEqual(['create:task.created', 'batch:task.created', 'batch:task.created'])
  })

  it('a candidates hook narrows claim next; unregistering restores it', () => {
    const b = open()
    const first = makeTask(b, alice, 'first')
    const second = makeTask(b, alice, 'second')
    const remove = b.board.tasks.use({
      name: 'skip-first',
      candidates: (q) => ({ ...q, where: [...q.where, { sql: 'task_id <> ?', params: [Number(first.id)] }] }),
    })
    expect(b.board.tasks.claimReadyOnce(bob, { channel: 'dev', from: [alice.principal.id] }).task?.id).toBe(second.id)
    expect(b.board.tasks.claimReadyOnce(bob, { channel: 'dev', from: [alice.principal.id] })).toEqual({ task: null })
    remove()
    expect(b.board.tasks.claimReadyOnce(bob, { channel: 'dev', from: [alice.principal.id] }).task?.id).toBe(first.id)
  })

  it('AT-18 a lapse hook turns an expiry into a failure or a poison hold by the system author; both pass FEI', () => {
    const b = open()
    const failing = makeTask(b, alice, 'flaky')
    const poisoned = makeTask(b, alice, 'poison')
    const plain = makeTask(b, alice, 'plain')
    b.board.tasks.use({ name: 'noop', lapse: () => ({ action: 'expire' }) })
    b.board.tasks.use({
      name: 'stalls',
      lapse: (row) =>
        row.task_id === Number(failing.id)
          ? { action: 'fail', reason: 'stalled: no renew' }
          : row.task_id === Number(poisoned.id)
            ? { action: 'hold', kind: 'org.poison', reason: 'expired too often' }
            : undefined,
    })
    for (const t of [failing, poisoned, plain]) claimOf(b, bob, t.id, { lease: 30 })
    b.clock.now = T0 + 30_000
    const at = head(b)
    const run = b.board.tasks.expireDueClaims()
    expect(run).toMatchObject({ expired: [Number(plain.id)], held: [Number(failing.id), Number(poisoned.id)], failed: [] })
    expect(taskEventsAfter(b, at).map((e) => [e.type, e.payload])).toEqual([
      ['task.failed', { id: Number(failing.id), thread: failing.thread, epoch: 1, reason: 'stalled: no renew', by: SYSTEM }],
      ['task.expired', { id: Number(poisoned.id), thread: poisoned.thread, epoch: 1 }],
      ['task.blocked', { id: Number(poisoned.id), thread: poisoned.thread, kind: 'org.poison', reason: 'expired too often', by: SYSTEM }],
      ['task.expired', { id: Number(plain.id), thread: plain.thread, epoch: 1 }],
    ])
    expect(taskOf(b, failing.id)).toMatchObject({ state: 'failed', reason: 'stalled: no renew' })
    expect(taskOf(b, poisoned.id)).toMatchObject({ state: 'blocked', blocked: { kind: 'org.poison' } })
    // A failing chunk is reported, and the others still run.
    const broken = makeTask(b, alice, 'broken')
    claimOf(b, bob, broken.id, { lease: 30 })
    b.clock.now = T0 + 60_000
    b.board.tasks.use({
      name: 'bad',
      lapse: () => {
        throw new BoardError(500, 'internal', 'the lapse hook broke')
      },
    })
    const bad = b.board.tasks.expireDueClaims()
    expect(bad.failed.map((f) => [f.task, f.error.code])).toEqual([[Number(broken.id), 'internal']])
    expect(stateOf(b, broken.id)).toBe('claimed')
  })

  it('AT-33 org.* kinds are accepted until reserveHoldPrefix reserves them; edited always is; capabilities says so', () => {
    const b = open()
    const a = makeTask(b, alice, 'a')
    const c = makeTask(b, alice, 'c')
    expect(b.board.tasks.capabilities()).toEqual({
      lease_min_s: 30,
      lease_cap_s: 3600,
      lease_default_s: 900,
      batch_max: 100,
      needs_max: 20,
      from_max: 32,
      conditional_needs: false,
      priority_native: false,
      defer: false,
      resume: false,
      reserved_hold_prefixes: [],
    })
    expect(refusal(() => b.board.tasks.blockTask(alice, a.id, { reason: 'x', kind: 'edited' }))[1]).toBe('invalid_request')
    expect(b.board.tasks.blockTask(alice, a.id, { reason: 'gate', kind: 'org.x' }).task.task?.blocked).toEqual({ kind: 'org.x', reason: 'gate' })
    b.board.tasks.reserveHoldPrefix('org.')
    b.board.tasks.reserveHoldPrefix('org.')
    expect(b.board.tasks.capabilities().reserved_hold_prefixes).toEqual(['org.'])
    expect(refusal(() => b.board.tasks.blockTask(alice, c.id, { reason: 'gate', kind: 'org.x' }))).toEqual([
      400,
      'invalid_request',
      "kind: org.* holds are the board's",
    ])
    const held = claimOf(b, bob, c.id)
    expect(refusal(() => b.board.tasks.blockTask(bob, c.id, { ...held, reason: 'gate', kind: 'org.review' }))[1]).toBe('invalid_request')
    expect(b.board.tasks.blockTask(bob, c.id, { ...held, reason: 'mine', kind: 'organic' }).task.task?.blocked?.kind).toBe('organic')
    expect(() => b.board.tasks.reserveHoldPrefix('org' as 'org.')).toThrow()
  })
})

describe('A8 AT-41 baseline', () => {
  /** The same script of verbs on a board, with `hooks` registered. */
  function script(hooks: TaskHook[]): { events: unknown[]; rows: unknown[] } {
    const b = open()
    for (const hook of hooks) b.board.tasks.use(hook)
    const fix = makeTask(b, alice, 'fix')
    const docs = makeTask(b, alice, 'docs')
    const review = makeTask(b, alice, 'review', { needs: [fix.id, docs.id] })
    const many = b.board.tasks.createTasks(alice, { channel: 'dev', tasks: [{ key: 'a', text: 'a' }, { text: 'b', needs: [{ key: 'a' }] }], id: 'plan-1' })
    finish(b, bob, fix.id)
    const held = claimOf(b, bob, docs.id, { lease: 30 })
    b.board.tasks.renewTask(bob, docs.id, { ...held, lease: 60 })
    b.clock.now = T0 + 61_000
    b.board.tasks.expireDueClaims()
    const next = b.board.tasks.claimReadyOnce(bob, { channel: 'dev', from: [alice.principal.id] })
    if (!next.task) throw new Error('expected a task to claim')
    b.board.tasks.completeTask(bob, next.task.id, next.claim)
    b.board.tasks.blockTask(alice, review.id, { reason: 'wait' })
    b.board.tasks.unblockTask(alice, review.id)
    b.board.tasks.assignTask(alice, review.id, { for: `${alice.principal.id}+fixer` })
    b.board.tasks.setTaskNeeds(alice, many.tasks[1]!.id, { needs: [] })
    const f = claimOf(b, bob, many.tasks[0]!.id)
    b.board.tasks.failTask(bob, many.tasks[0]!.id, { ...f, reason: 'broke' })
    b.board.tasks.reopenTask(alice, many.tasks[0]!.id)
    b.board.editMessage(bob, b.board.postMessage(bob, { channel: 'dev', text: 'q' }).message.id, { text: 'q2' })
    b.board.deleteMessage(alice, review.id)
    b.board.tasks.cancelTask(alice, many.tasks[1]!.id, { reason: 'cut' })
    // Threads are random UUIDs and claim tokens random secrets: everything else must match exactly.
    const rows = b.store.db.prepare('SELECT log_index, type, payload_json FROM board_events ORDER BY log_index').all() as Array<{
      log_index: number
      type: string
      payload_json: string
    }>
    const events = rows.map((r) => {
      const { thread: _thread, token: _token, ...payload } = JSON.parse(r.payload_json) as Record<string, unknown>
      return [r.log_index, r.type, payload]
    })
    return {
      events,
      rows: loadAllRows(b.store.db).map(({ thread: _thread, claim_token_hash, ...r }) => ({ ...r, hashed: claim_token_hash !== null })),
    }
  }

  it('AT-41 a pass-through hook in every phase leaves the log and the index exactly as an empty registry does', () => {
    const calls: Record<string, number> = { plan: 0, applied: 0, committed: 0, candidates: 0, lapse: 0 }
    const passThrough: TaskHook = {
      name: 'pass-through',
      plan: (plan: TaskPlan) => {
        calls.plan!++
        return plan
      },
      applied: () => void calls.applied!++,
      committed: () => void calls.committed!++,
      candidates: (q) => {
        calls.candidates!++
        return q
      },
      lapse: () => {
        calls.lapse!++
        return { action: 'expire' }
      },
    }
    const bare = script([])
    const hooked = script([passThrough, { name: 'empty' }])
    expect(hooked).toEqual(bare)
    for (const [phase, n] of Object.entries(calls)) expect(n, phase).toBeGreaterThan(0)
  })
})

describe('capabilities types (round-1 F5)', () => {
  it("TaskCapabilities carries 2.5.1's literal limits, so a client may rely on them at the type level", () => {
    const b = makeBoard()
    try {
      const caps = b.board.tasks.capabilities()
      expectTypeOf(caps.lease_min_s).toEqualTypeOf<30>()
      expectTypeOf(caps.lease_cap_s).toEqualTypeOf<3600>()
      expectTypeOf(caps.lease_default_s).toEqualTypeOf<900>()
      expectTypeOf(caps.batch_max).toEqualTypeOf<100>()
      expectTypeOf(caps.needs_max).toEqualTypeOf<20>()
      expectTypeOf(caps.from_max).toEqualTypeOf<32>()
      expect([caps.lease_min_s, caps.lease_cap_s, caps.lease_default_s, caps.batch_max, caps.needs_max, caps.from_max]).toEqual([30, 3600, 900, 100, 20, 32])
    } finally {
      b.close()
    }
  })
})
