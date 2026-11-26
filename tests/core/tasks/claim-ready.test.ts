// Slice A6: claim the next ready task, and waits (M2_DESIGN 2.7.10), ported from the original's
// test/tasks.test.ts "claiming the next ready task", plus the claim-order differential (AT-21).
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardService,
  createLocalCaller,
  loadAllRows,
  SqliteUnifiedStore,
  type CallerContext,
  type TaskRow,
} from '../../../src/core/index.ts'
import { alice, eventCount, makeBoard, T0, type Board } from './helpers.ts'
import { ALICE, aliceAs, BOB, bob, claimOf, finish, makeTask, refusal, stateOf, taskOf, userWith } from './verb-helpers.ts'

const boards: Board[] = []
const open = (): Board => {
  const b = makeBoard()
  boards.push(b)
  return b
}
afterEach(() => {
  while (boards.length > 0) boards.pop()!.close()
})

const next = (b: Board, caller: CallerContext, body: Record<string, unknown>) => b.board.tasks.claimReadyOnce(caller, body)
const nextId = (b: Board, caller: CallerContext, body: Record<string, unknown>): string | null => next(b, caller, body).task?.id ?? null

describe('A6 claim next ready', () => {
  it('takes the oldest in a channel or its subtree that has every label asked for', () => {
    const b = open()
    const review = makeTask(b, alice, 'review the fix', { labels: { step: 'review' } })
    const fix = makeTask(b, alice, 'fix CVE-123', { labels: { step: 'fix', area: 'web' } })
    const later = b.board.tasks.createTask(alice, { channel: 'dev/api', text: 'fix CVE-456', labels: { step: 'fix' } }).task
    b.board.tasks.createTask(alice, { channel: 'ops', text: 'elsewhere', labels: { step: 'fix' } })

    expect(next(b, alice, { channel: 'dev', label: { step: 'fix', area: 'api' } })).toEqual({ task: null })
    const first = next(b, alice, { channel: 'dev/', label: { step: 'fix' }, lease: 60 })
    expect(first).toMatchObject({
      task: { id: fix.id, task: { state: 'claimed' } },
      claim: { epoch: 1, until: new Date(T0 + 60_000).toISOString() },
    })
    // The channel alone leaves out what's under it; the subtree has both.
    expect(next(b, alice, { channel: 'dev', label: { step: 'fix' } })).toEqual({ task: null })
    expect(nextId(b, alice, { channel: 'dev/', label: { step: 'fix' } })).toBe(later.id)
    expect(nextId(b, alice, { channel: 'dev/' })).toBe(review.id)
    expect(next(b, alice, { channel: 'dev/' })).toEqual({ task: null })
    expect(refusal(() => next(b, alice, { channel: 'Not A Channel' }))[1]).toBe('invalid_request')
  })

  it("takes the caller's own tasks, and another owner's only when it names them by ID", () => {
    const b = open()
    const carol = userWith('carol')
    const hers = makeTask(b, alice, "alice's")
    const theirs = makeTask(b, carol, "carol's")
    const his = makeTask(b, bob, "bob's")
    expect(nextId(b, bob, { channel: 'dev' })).toBe(his.id)
    expect(next(b, bob, { channel: 'dev' })).toEqual({ task: null })
    // A handle names no owner, known to the board or not.
    expect(refusal(() => next(b, bob, { channel: 'dev', from: ['alice'] }))).toEqual([
      400,
      'invalid_from',
      'from: alice is a handle, which several can share: name the owner by ID',
    ])
    expect(refusal(() => next(b, bob, { channel: 'dev', from: ['nobody'] }))[1]).toBe('invalid_from')
    expect(nextId(b, bob, { channel: 'dev', from: [ALICE, carol.principal.id] })).toBe(hers.id)
    expect(nextId(b, bob, { channel: 'dev', from: [ALICE, carol.principal.id] })).toBe(theirs.id)
    // An ID the board has never seen is still an ID: it names no one's tasks yet.
    expect(next(b, bob, { channel: 'dev', from: ['local:user:nobody'] })).toEqual({ task: null })
    // An owner that only ever wrote through a profile owns its tasks all the same.
    const planned = makeTask(b, aliceAs('planner'), 'plan the migration')
    expect(planned.task).toMatchObject({ owner: ALICE })
    expect(nextId(b, bob, { channel: 'dev', from: [ALICE] })).toBe(planned.id)
  })

  it('takes one assigned to the caller before an older one from the pool', () => {
    const b = open()
    const fixer = aliceAs('fixer')
    const pool = makeTask(b, alice, 'anyone can do this')
    const reviewers = makeTask(b, alice, 'for the reviewer', { for: `${ALICE}+reviewer` })
    const mine = makeTask(b, alice, 'for the fixer', { for: `${ALICE}+fixer` })
    expect(nextId(b, fixer, { channel: 'dev' })).toBe(mine.id)
    expect(nextId(b, fixer, { channel: 'dev' })).toBe(pool.id)
    expect(next(b, fixer, { channel: 'dev' })).toEqual({ task: null })
    expect(stateOf(b, reviewers.id)).toBe('ready')
  })

  it('AT-32 a lookalike principal whose own ID reads as the assignee takes nothing; the assignee does', () => {
    const b = open()
    const lookalike = createLocalCaller({ userId: 'alice+fixer', handle: 'lookalike' })
    const made = makeTask(b, alice, 'fix CVE-123', { for: `${ALICE}+fixer` })
    expect(lookalike.actor.id).toBe(made.task!.for)
    expect(next(b, lookalike, { channel: 'dev' })).toEqual({ task: null })
    expect(next(b, lookalike, { channel: 'dev', from: [ALICE] })).toEqual({ task: null })
    expect(stateOf(b, made.id)).toBe('ready')
    expect(nextId(b, aliceAs('fixer'), { channel: 'dev' })).toBe(made.id)
  })

  it('takes a lapsed claim as ready, expiring it in the same write, and a token sent is the new claim', () => {
    const b = open()
    const { id } = makeTask(b, alice, 'a job on a board without a sweep')
    claimOf(b, alice, id, { lease: 60 })
    expect(next(b, bob, { channel: 'dev', from: [ALICE] })).toEqual({ task: null })
    b.clock.now = T0 + 61_000
    const token = 'T'.repeat(43)
    const taken = next(b, bob, { channel: 'dev', from: [ALICE], token })
    expect(taken).toMatchObject({ task: { id, task: { state: 'claimed', epoch: 2 } }, claim: { epoch: 2, token } })
    expect(taskOf(b, id).claim?.actor).toBe(BOB)
  })

  it('AT-22 gate order: lease, from count, label, empty scope, then invalid_from', () => {
    const b = open()
    makeTask(b, alice, 'something')
    // Channels are the ones the board has: ops is one once something is posted there.
    b.board.postMessage(alice, { channel: 'ops', text: 'hello' })
    expect(refusal(() => next(b, alice, { channel: 'dev', lease: 29 }))).toEqual([400, 'invalid_request', 'lease: a lease is 30 to 3600 seconds'])
    const from = Array.from({ length: 33 }, (_, n) => `local:user:u${n}`)
    expect(refusal(() => next(b, alice, { channel: 'dev', from, lease: 29 }))[2]).toBe('lease: a lease is 30 to 3600 seconds')
    expect(refusal(() => next(b, alice, { channel: 'dev', from }))).toEqual([400, 'invalid_request', 'from: a claim takes tasks from at most 32 owners'])
    expect(refusal(() => next(b, alice, { channel: 'dev', wait: 301 }))[1]).toBe('invalid_request')
    const noLabel = userWith('nolabel', '*=read,post')
    expect(refusal(() => next(b, noLabel, { channel: 'dev', from: ['handle'] }))).toEqual([403, 'forbidden', "this token can't label in dev"])
    expect(refusal(() => next(b, noLabel, { channel: 'dev/', from: ['handle'] }))).toEqual([
      403,
      'forbidden',
      "this token can't label anywhere, so it can't claim a task",
    ])
    // Label somewhere, but nowhere under the subtree asked for: nothing to claim, before `from` is looked at.
    const opsOnly = userWith('opsonly', '*=read,post;ops=read,post,label')
    expect(next(b, opsOnly, { channel: 'dev/', from: ['handle'] })).toEqual({ task: null })
    expect(refusal(() => next(b, opsOnly, { channel: 'ops/', from: ['handle'] }))[1]).toBe('invalid_from')
    expect(refusal(() => next(b, alice, { channel: 'dev', from: ['handle'] }))[1]).toBe('invalid_from')
  })

  it('claims nothing for a caller that stopped, and a found task stays ready', () => {
    const b = open()
    const made = makeTask(b, alice, 'fix CVE-123')
    const gone = new AbortController()
    gone.abort()
    expect(b.board.tasks.claimReadyOnce(alice, { channel: 'dev' }, gone.signal)).toEqual({ task: null })
    expect(taskOf(b, made.id)).toMatchObject({ state: 'ready', epoch: 0, claim: null })
  })

  // 500 random boards in five parts of 100, each under the default test timeout.
  for (const part of [0, 1, 2, 3, 4]) it(`AT-21 the sequence of picks equals a transcription of the original claimNext on 500 random boards (part ${part + 1} of 5)`, () => {
    const fixer = aliceAs('fixer')
    const reviewer = aliceAs('reviewer')
    const carol = userWith('carol')
    const dave = userWith('dave', '*=read,post;dev=read,post,label;ops=read,post,label')
    const callers = [alice, fixer, reviewer, bob, carol, dave]
    const owners = [alice, fixer, bob, carol]
    const channels = ['dev', 'dev/api', 'dev/web', 'ops']
    let seed = 0x2545f491 + part * 7919
    const rand = (n: number): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) % n
    }
    const pick = <T,>(xs: readonly T[]): T => xs[rand(xs.length)]!
    let picks = 0
    for (let boardNo = 0; boardNo < 100; boardNo++) {
      const b = open()
      const n = 6 + rand(10)
      const made: string[] = []
      for (let i = 0; i < n; i++) {
        const owner = pick(owners)
        const channel = pick(channels)
        const labels = rand(2) === 0 ? { step: pick(['fix', 'review']) } : {}
        const assignee = rand(3) === 0 ? `${owner.principal.id}+${pick(['fixer', 'reviewer'])}` : null
        const needs = made.length > 0 && rand(5) === 0 ? [pick(made)] : []
        const root = b.board.tasks.createTask(owner, { channel, text: `t${i}`, labels, needs, ...(assignee ? { for: assignee } : {}) }).task
        made.push(root.id)
        // A reply's label must not qualify its root.
        if (rand(4) === 0) b.board.postMessage(alice, { re: root.id, text: 'r', labels: { step: pick(['fix', 'review']) } })
        const roll = rand(8)
        try {
          if (roll === 0) b.board.tasks.claimTask(alice, root.id, { lease: 30 }) // lapses below
          else if (roll === 1) b.board.tasks.claimTask(alice, root.id, { lease: 3600 }) // stays live
          else if (roll === 2) b.board.tasks.blockTask(alice, root.id, { reason: 'held' })
          else if (roll === 3) finish(b, alice, root.id)
        } catch {
          // Waiting or assigned: left as it is.
        }
      }
      b.clock.now = T0 + 31_000
      for (let step = 0; step < 12; step++) {
        const caller = pick(callers)
        const channel = rand(2) === 0 ? pick(['dev', 'ops']) : pick(['dev/', 'ops/'])
        const body: Record<string, unknown> = { channel }
        if (rand(3) === 0) body.label = { step: pick(['fix', 'review']) }
        if (rand(2) === 0) body.from = [pick(owners).principal.id]
        const expected = reference(b, caller, body)
        let got: string | null
        try {
          got = nextId(b, caller, body)
        } catch (error) {
          got = `refused:${(error as { code?: string }).code}`
        }
        expect(got, `board ${boardNo} step ${step}`).toBe(expected)
        if (got !== null) picks++
      }
      b.close()
      boards.pop()
    }
    expect(picks).toBeGreaterThan(100)
    // Each part takes about 1.5-2 s alone; a loaded full run took 5.1 s against the 5 s default, so it
    // carries an explicit generous timeout (D5). What it asserts is unchanged.
  }, 60_000)
})

/** A transcription of the original's claimNext walk (server/tasks.ts:455-486), from the index rows. */
function reference(b: Board, caller: CallerContext, body: Record<string, unknown>): string | null {
  const channel = body.channel as string
  const subtree = channel.endsWith('/')
  const path = subtree ? channel.slice(0, -1) : channel
  const access = b.board.resolveAccess(caller).caller
  const can = (ch: string): boolean => access.can('label', ch)
  if (!subtree && !can(path)) return 'refused:forbidden'
  const inside = (ch: string): boolean => ch === path || (subtree && ch.startsWith(`${path}/`))
  const labels = Object.entries((body.label as Record<string, string> | undefined) ?? {})
  const owners = new Set([caller.principal.id, ...((body.from as string[] | undefined) ?? [])])
  const now = b.clock.now
  let mine: TaskRow | null = null
  let pool: TaskRow | null = null
  for (const row of loadAllRows(b.store.db)) {
    if (row.state !== 'ready' && row.state !== 'claimed') continue
    if (!inside(row.channel) || !can(row.channel)) continue
    const terms = b.store.db.prepare('SELECT term, value FROM board_terms WHERE message_id = ?').all(row.task_id) as Array<{ term: string; value: string }>
    if (!labels.every(([k, v]) => terms.some((t) => t.term === k && t.value === v))) continue
    const stateNow = row.state === 'claimed' && (row.claim_until_ms ?? 0) <= now ? 'ready' : row.state
    if (stateNow !== 'ready') continue
    if (row.for_actor === caller.actor.id && row.owner === caller.principal.id) {
      mine = row
      break
    }
    if (row.for_actor === null && pool === null && owners.has(row.owner)) pool = row
  }
  const found = mine ?? pool
  return found ? String(found.task_id) : null
}

describe('A6 waits', () => {
  /** A board on the real clock, offset by `skew` ms, so a lease can run out in a test's time. */
  function realBoard(): { board: BoardService; store: SqliteUnifiedStore; skew: { ms: number } } {
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    const skew = { ms: 0 }
    const board = new BoardService(store, { now: () => Date.now() + skew.ms })
    closers.push(() => store.close())
    return { board, store, skew }
  }
  const closers: (() => void)[] = []
  afterEach(() => {
    while (closers.length > 0) closers.pop()!()
  })

  // Wake latency against the safety poll (reviewer R2-4, lead decision D3). A waiter's own poll looks
  // first after 100 ms (claim-ready.ts POLL_FIRST_MS), then after 200 more: with no in-process wake,
  // the create below (150 ms in) is seen about 150 ms late and the lapse (120 ms in) about 180 ms
  // late, every time. The in-process wake answers within a few ms. A loaded machine can stretch any
  // one attempt, never shorten one, so the bound is on the best of several attempts, and it is half
  // the poll's first step: it holds under load and fails whenever only polling woke the waiter.
  const POLL_FIRST_MS = 100
  const WAKE_BOUND_MS = POLL_FIRST_MS / 2
  const ATTEMPTS = 5
  /** The best of up to `ATTEMPTS` runs of `attempt`, stopping at the first within `WAKE_BOUND_MS`. */
  async function bestOf(attempt: () => Promise<number>): Promise<{ best: number; all: number[] }> {
    const all: number[] = []
    while (all.length < ATTEMPTS) {
      all.push(await attempt())
      if (all[all.length - 1]! <= WAKE_BOUND_MS) break
    }
    return { best: Math.min(...all), all }
  }

  it('AT-23 a waiter wakes on an in-process create far inside the 100 ms poll (best of 5 within 50 ms)', async () => {
    const { best, all } = await bestOf(async () => {
      const { board } = realBoard()
      const waiting = board.tasks.claimReady(bob, { channel: 'dev', from: [ALICE], wait: 10 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      const made = Date.now()
      const { task } = board.tasks.createTask(alice, { channel: 'dev', text: 'fix CVE-123' })
      const got = await waiting
      const took = Date.now() - made
      expect(got).toMatchObject({ task: { id: task.id, task: { state: 'claimed' } }, claim: { epoch: 1 } })
      return took
    })
    expect(best, `wake latencies ${all.join(', ')} ms`).toBeLessThanOrEqual(WAKE_BOUND_MS)
  })

  it('AT-23 a lapse wakes a waiter far inside the 100 ms poll after until (best of 5 within 50 ms), never before it, with no event written', async () => {
    const { best, all } = await bestOf(async () => {
      const { board, store, skew } = realBoard()
      const { task } = board.tasks.createTask(alice, { channel: 'dev', text: 'fix CVE-123' })
      const held = board.tasks.claimTask(alice, task.id, { lease: 30 })
      // The lease ends 120 ms from now, in real time.
      const until = Date.parse(held.claim.until)
      skew.ms = until - Date.now() - 120
      const events = Number((store.db.prepare('SELECT COUNT(*) AS c FROM board_events').get() as { c: number }).c)
      const waiting = board.tasks.claimReady(bob, { channel: 'dev', from: [ALICE], wait: 5 })
      const got = await waiting
      const late = Date.now() + skew.ms - until
      expect(got).toMatchObject({ task: { id: task.id, task: { state: 'claimed', epoch: 2 } } })
      // Never early, on every attempt, however loaded the machine.
      expect(late).toBeGreaterThanOrEqual(0)
      // Only the takeover's own events: nothing was written for the lapse while it waited.
      const types = (store.db.prepare('SELECT type FROM board_events WHERE log_index > (SELECT MAX(log_index) FROM board_events) - 10 ORDER BY log_index').all() as Array<{ type: string }>).map((r) => r.type)
      expect(Number((store.db.prepare('SELECT COUNT(*) AS c FROM board_events').get() as { c: number }).c) - events).toBe(types.slice(-3).includes('actor.seen') ? 3 : 2)
      expect(types.slice(-2)).toEqual(['task.expired', 'task.claimed'])
      return late
    })
    expect(best, `lapse wake latencies ${all.join(', ')} ms`).toBeLessThanOrEqual(WAKE_BOUND_MS)
  })

  it('AT-23 an aborted waiter claims nothing, and a wait with nothing coming answers null at its end', async () => {
    const { board } = realBoard()
    const gone = new AbortController()
    const waiting = board.tasks.claimReady(bob, { channel: 'dev', from: [ALICE], wait: 10 }, gone.signal)
    await new Promise((resolve) => setTimeout(resolve, 50))
    gone.abort()
    const { task } = board.tasks.createTask(alice, { channel: 'dev', text: 'fix CVE-123' })
    expect(await waiting).toEqual({ task: null })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(board.getMessageThread(alice, task.id).message.task).toMatchObject({ state: 'ready', epoch: 0, claim: null })
    const started = Date.now()
    expect(await board.tasks.claimReady(alice, { channel: 'dev', label: { step: 'nothing-has-this' }, wait: 0.3 })).toEqual({ task: null })
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })

  it('AT-23 waiters on one scope take turns: each of five gets one task, oldest waiter first', async () => {
    const { board } = realBoard()
    const order: number[] = []
    const waiters = Array.from({ length: 5 }, (_, n) =>
      board.tasks.claimReady(bob, { channel: 'dev', from: [ALICE], wait: 10 }).then((got) => {
        order.push(n)
        return got.task?.id ?? null
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    const made = Array.from({ length: 5 }, (_, n) => board.tasks.createTask(alice, { channel: 'dev', text: `t${n}` }).task.id)
    const got = await Promise.all(waiters)
    expect(new Set(got)).toEqual(new Set(made))
    expect(order).toEqual([0, 1, 2, 3, 4])
  })

  it('answers at once when a task is ready, and a wait of 0 is one look', async () => {
    const b = open()
    const before = eventCount(b)
    expect(await b.board.tasks.claimReady(alice, { channel: 'dev' })).toEqual({ task: null })
    expect(eventCount(b)).toBe(before)
    const made = makeTask(b, alice, 'ready now')
    expect((await b.board.tasks.claimReady(alice, { channel: 'dev', wait: 5 })).task?.id).toBe(made.id)
  })
})

describe('A6 waits re-judge the caller on every try (round-1 F1/F2)', () => {
  const closers: (() => void)[] = []
  afterEach(() => {
    while (closers.length > 0) closers.pop()!()
  })
  function realBoard(): { board: BoardService; store: SqliteUnifiedStore } {
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    const board = new BoardService(store, { now: () => Date.now() })
    closers.push(() => store.close())
    return { board, store }
  }
  const settle = (p: Promise<unknown>): Promise<[number, string] | 'ok'> =>
    p.then(
      () => 'ok' as const,
      (e: unknown) => [(e as { status: number }).status, (e as { code: string }).code] as [number, string],
    )
  const stateIn = (store: SqliteUnifiedStore, id: string): unknown =>
    (store.db.prepare('SELECT state, claim_actor FROM board_tasks WHERE task_id = ?').get(Number(id)) as Record<string, unknown>)

  it('a waiter whose label grant is revoked while it waits claims nothing: 403, as a fresh call is, and the task stays ready', async () => {
    const { board, store } = realBoard()
    for (const g of board.listGrants(alice)) board.revokeGrant(alice, g.id, {})
    board.createGrant(alice, { principals: [{ kind: 'all-users' }], can: { '*': ['read'] } })
    const lbl = board.createGrant(alice, { principals: [{ kind: 'user', userId: 'bob' }], can: { secret: ['read', 'label'] } })
    board.postMessage(alice, { channel: 'secret', text: 'the channel' })
    const waiting = settle(board.tasks.claimReady(bob, { channel: 'secret', from: [ALICE], wait: 5 }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    board.revokeGrant(alice, lbl.id, {})
    const { task } = board.tasks.createTask(alice, { channel: 'secret', text: 'payroll job' })
    expect(refusal(() => board.tasks.claimReadyOnce(bob, { channel: 'secret', from: [ALICE] }))[0]).toBe(403)
    expect(await waiting).toEqual([403, 'forbidden'])
    expect(stateIn(store, task.id)).toEqual({ state: 'ready', claim_actor: null })
  })

  it('a waiter that loses every grant takes nothing, and a subtree waiter is narrowed to where it may still label', async () => {
    const { board, store } = realBoard()
    for (const g of board.listGrants(alice)) board.revokeGrant(alice, g.id, {})
    const wide = board.createGrant(alice, { principals: [{ kind: 'user', userId: 'bob' }], can: { 'jobs/': ['read', 'label'] } })
    board.postMessage(alice, { channel: 'jobs/a', text: 'a' })
    board.postMessage(alice, { channel: 'jobs/b', text: 'b' })
    const waiting = settle(board.tasks.claimReady(bob, { channel: 'jobs/', from: [ALICE], wait: 1.5 }).then((got) => {
      if (got.task) throw new Error(`claimed #${got.task.id} in ${got.task.channel}`)
    }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    // Narrowed to jobs/b only: a task in jobs/a is no longer this waiter's to take.
    board.revokeGrant(alice, wide.id, {})
    board.createGrant(alice, { principals: [{ kind: 'user', userId: 'bob' }], can: { 'jobs/b': ['read', 'label'] } })
    const { task } = board.tasks.createTask(alice, { channel: 'jobs/a', text: 'not for bob any more' })
    expect(await waiting).toBe('ok')
    expect(stateIn(store, task.id)).toEqual({ state: 'ready', claim_actor: null })
  })

  it('a restricted waiter on a subtree with no channel yet waits, and claims in a channel made during the wait', async () => {
    const { board } = realBoard()
    const worker = userWith('worker', 'jobs/=read,post,label')
    const started = Date.now()
    const waiting = board.tasks.claimReady(worker, { channel: 'jobs/', from: [ALICE], wait: 3 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const first = board.tasks.createTask(alice, { channel: 'jobs/a', text: 'first job' }).task
    const got = await waiting
    expect(got.task?.id).toBe(first.id)
    expect(Date.now() - started).toBeLessThan(2000)
    // And a channel that appears under the subtree during the wait is looked in too.
    const again = board.tasks.claimReady(worker, { channel: 'jobs/', from: [ALICE], wait: 3 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const later = board.tasks.createTask(alice, { channel: 'jobs/c', text: 'in a new channel' }).task
    expect((await again).task?.id).toBe(later.id)
  })

  it('a restricted waiter on an exact channel that does not exist yet waits for it', async () => {
    const { board } = realBoard()
    const worker = userWith('worker', 'jobs=read,post,label')
    const waiting = board.tasks.claimReady(worker, { channel: 'jobs', from: [ALICE], wait: 3 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const made = board.tasks.createTask(alice, { channel: 'jobs', text: 'the first job' }).task
    expect((await waiting).task?.id).toBe(made.id)
  })
})
