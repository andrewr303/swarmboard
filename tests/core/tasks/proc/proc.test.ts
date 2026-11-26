// The multi-process acceptance tests (M2_DESIGN 2.11 [proc]): separate OS processes, each with its own
// connection to one WAL file, racing through BEGIN IMMEDIATE. The parent opens the same file for setup
// and for its checks; the children (proc/child.ts) run the verbs on their own clocks.
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  type MessageView,
  type TaskClaim,
} from '../../../../src/core/index.ts'
import { Child, startAll, tempBoard, type Reply } from './harness.ts'

const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })

type Opened = { store: SqliteUnifiedStore; board: BoardService; close(): void }

/** The parent's own connection to the file, on the real clock (the children's too). */
function open(path: string): Opened {
  const store = new SqliteUnifiedStore({ path })
  const board = new BoardService(store, { now: () => Date.now() })
  return { store, board, close: () => store.close() }
}

const count = (o: Opened, sql: string, ...args: Array<string | number>): number =>
  Number((o.store.db.prepare(sql).get(...args) as { c: number }).c)

const eventsOf = (o: Opened, type: string, taskId?: string): number =>
  taskId === undefined
    ? count(o, 'SELECT COUNT(*) AS c FROM board_events WHERE type = ?', type)
    : count(o, "SELECT COUNT(*) AS c FROM board_events WHERE type = ? AND json_extract(payload_json, '$.id') = ?", type, Number(taskId))

const wakeupGeneration = (o: Opened): number =>
  count(o, "SELECT COALESCE(CAST((SELECT value FROM board_meta WHERE key = 'wakeup_generation') AS INTEGER), 0) AS c")

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Everything a test opened, closed and removed after it, whatever it ended with. */
let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  const steps = cleanup.reverse()
  cleanup = []
  for (const step of steps) await step()
})

function board(): { path: string; parent: Opened } {
  const dir = tempBoard()
  const parent = open(dir.path)
  cleanup.push(dir.dispose)
  cleanup.push(() => {
    try {
      parent.close()
    } catch {
      // closed by the test
    }
  })
  return { path: dir.path, parent }
}

async function children(path: string, n: number, extra: Record<string, unknown> = {}): Promise<Child[]> {
  const started = await startAll(path, n, extra)
  cleanup.push(async () => {
    await Promise.all(started.map((c) => c.stop()))
  })
  return started
}

const errorOf = (reply: Reply): [number, string] | 'ok' => (reply.ok ? 'ok' : [reply.error.status, reply.error.code])

describe('[proc] tasks across processes on one WAL file', () => {
  it('AT-08 [proc] two first creates of one id in two processes give one write and one replay', async () => {
    const { path, parent } = board()
    const [a, b] = await children(path, 2)
    for (let round = 0; round < 15; round++) {
      const body = { channel: 'dev', text: `deploy ${round}`, id: `deploy-${round}` }
      const replies = await Promise.all([a!, b!].map((c) => c.call<{ task: MessageView }>('alice', 'createTask', [body], true)))
      const ids = replies.map((r) => (r.ok ? r.value.task.id : JSON.stringify(r.error)))
      // Both are 201s with the one task: the later one is the earlier one's replay.
      expect(ids[0]).toBe(ids[1])
      expect(eventsOf(parent, 'task.created', ids[0])).toBe(1)
      expect(count(parent, "SELECT COUNT(*) AS c FROM board_events WHERE type = 'message.posted' AND event_id = ?", `deploy-${round}`)).toBe(1)
    }
    expect(eventsOf(parent, 'task.created')).toBe(15)
  }, 30_000)

  it('AT-10 [proc] eight processes claim one ready task: exactly one wins, seven get task_claimed', async () => {
    const { path, parent } = board()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(parent.board.tasks.createTask(alice, { channel: 'dev', text: `race ${i}` }).task.id)
    const racers = await children(path, 8)
    for (const id of ids) {
      // Retried on 503 (busy past busy_timeout), as a client is told to.
      const replies = await Promise.all(racers.map((c, i) => c.call<{ claim: TaskClaim }>(`alice+w${i}`, 'claimTask', [id, {}], true)))
      const outcomes = replies.map(errorOf)
      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1)
      expect(outcomes.filter((o) => o !== 'ok')).toEqual(Array.from({ length: 7 }, () => [409, 'task_claimed']))
      const won = replies.find((r) => r.ok) as { ok: true; value: { claim: TaskClaim } }
      expect(won.value.claim.epoch).toBe(1)
      expect(eventsOf(parent, 'task.claimed', id)).toBe(1)
      expect(count(parent, 'SELECT epoch AS c FROM board_tasks WHERE task_id = ?', Number(id))).toBe(1)
    }
  }, 30_000)

  it('AT-11 [proc] eight connections claim and release one task over 200 rounds: one success a round', async () => {
    const { path, parent } = board()
    const id = parent.board.tasks.createTask(alice, { channel: 'dev', text: 'hot potato' }).task.id
    const racers = await children(path, 8)
    const ROUNDS = 200
    for (let round = 1; round <= ROUNDS; round++) {
      // The barrier: every racer's claim of a round is in flight together, and the winner lets go after.
      const replies = await Promise.all(racers.map((c, i) => c.call<{ claim: TaskClaim }>(`alice+w${i}`, 'claimTask', [id, {}], true)))
      const winners = replies.flatMap((r, i) => (r.ok ? [{ i, claim: r.value.claim }] : []))
      expect(winners, `round ${round}`).toHaveLength(1)
      expect(replies.filter((r) => !r.ok).map(errorOf)).toEqual(Array.from({ length: 7 }, () => [409, 'task_claimed']))
      const { i, claim } = winners[0]!
      expect(claim.epoch).toBe(round)
      await racers[i]!.ask('call', { caller: `alice+w${i}`, method: 'releaseTask', args: [id, { epoch: claim.epoch, token: claim.token }], retry: true })
    }
    expect(count(parent, 'SELECT epoch AS c FROM board_tasks WHERE task_id = ?', Number(id))).toBe(ROUNDS)
    expect(eventsOf(parent, 'task.claimed', id)).toBe(ROUNDS)
    expect(eventsOf(parent, 'task.released', id)).toBe(ROUNDS)
  }, 120_000)

  it('AT-12 [proc] sixteen processes drain 2,000 ready tasks: each claimed once at epoch 1 and completed once', async () => {
    const { path, parent } = board()
    const TASKS = 2000
    for (let start = 0; start < TASKS; start += 100) {
      parent.board.tasks.createTasks(alice, {
        channel: 'dev',
        tasks: Array.from({ length: 100 }, (_, i) => ({ text: `job ${start + i}` })),
      })
    }
    expect(count(parent, "SELECT COUNT(*) AS c FROM board_tasks WHERE state = 'ready'")).toBe(TASKS)
    const workers = await children(path, 16)
    const drained = await Promise.all(
      workers.map((c, i) => c.ask<Array<[string, number]>>('drain', { caller: `alice+w${i}`, body: { channel: 'dev' } })),
    )
    const all = drained.flat()
    expect(all).toHaveLength(TASKS)
    expect(new Set(all.map(([id]) => id)).size).toBe(TASKS)
    expect(all.every(([, epoch]) => epoch === 1)).toBe(true)
    // Work spread over the processes rather than one taking it all.
    expect(drained.filter((d) => d.length > 0).length).toBeGreaterThan(1)
    expect(eventsOf(parent, 'task.claimed')).toBe(TASKS)
    expect(eventsOf(parent, 'task.completed')).toBe(TASKS)
    expect(count(parent, "SELECT COUNT(*) AS c FROM board_tasks WHERE state = 'completed' AND epoch = 1")).toBe(TASKS)
    expect(count(parent, 'SELECT COUNT(DISTINCT json_extract(payload_json, \'$.id\')) AS c FROM board_events WHERE type = ?', 'task.completed')).toBe(TASKS)
  }, 180_000)

  it('AT-17 [proc] two sweepers in two processes expire each lapse exactly once', async () => {
    const { path, parent } = board()
    const N = 40
    const ids: string[] = []
    for (let i = 0; i < N; i++) {
      const id = parent.board.tasks.createTask(alice, { channel: 'dev', text: `lease ${i}` }).task.id
      parent.board.tasks.claimTask(alice, id, { lease: 30 })
      ids.push(id)
    }
    const sweepers = await children(path, 2)
    // Their clocks run 31 s ahead: every claim has lapsed for them.
    await Promise.all(sweepers.map((c) => c.ask('clock', { offset: 31_000 })))
    const runs = await Promise.all(
      sweepers.map(async (c) => {
        const out: number[] = []
        for (let pass = 0; pass < 10; pass++) out.push(...(await c.ask<{ expired: number[] }>('expire', { opts: { chunk: 2, limit: 6 } })).expired)
        return out
      }),
    )
    const expired = runs.flat()
    expect(expired.sort((x, y) => x - y)).toEqual(ids.map(Number).sort((x, y) => x - y))
    expect(eventsOf(parent, 'task.expired')).toBe(N)
    for (const id of ids) expect(eventsOf(parent, 'task.expired', id)).toBe(1)
    expect(count(parent, "SELECT COUNT(*) AS c FROM board_tasks WHERE state = 'ready' AND epoch = 1")).toBe(N)
  }, 60_000)

  it('AT-17 [proc] a sweep interleaved with a renew never gives both an expiry and a successful renew at one epoch', async () => {
    const { path, parent } = board()
    const N = 40
    const held: Array<[string, number, string]> = []
    for (let i = 0; i < N; i++) {
      const id = parent.board.tasks.createTask(alice, { channel: 'dev', text: `lease ${i}` }).task.id
      const { claim } = parent.board.tasks.claimTask(alice, id, { lease: 30 })
      held.push([id, claim.epoch, claim.token])
    }
    const [renewer] = await children(path, 1)
    // The sweeper selects every lapse at once, then pauses before each one-task chunk: the renews land
    // between its select and its chunks, which must re-read each row.
    const [sweeper] = await children(path, 1, { beginDelayMs: 3 })
    // To the renewer every claim is live, and a renew holds it for two minutes; to the sweeper each
    // lapsed a second ago, and a renewed one has not.
    await sweeper!.ask('clock', { offset: 31_000 })
    const [renewed, expired] = await Promise.all([
      renewer!.ask<Array<[string, number, string]>>('renewEach', { caller: 'alice', claims: held, lease: 120 }),
      sweeper!.ask<{ expired: number[] }>('expire', { opts: { limit: N, chunk: 1 } }),
    ])
    const expiredSet = new Set(expired.expired)
    for (const [id, epoch, outcome] of renewed) {
      const wasExpired = expiredSet.has(Number(id))
      const expiryEvents = count(
        parent,
        "SELECT COUNT(*) AS c FROM board_events WHERE type = 'task.expired' AND json_extract(payload_json, '$.id') = ? AND json_extract(payload_json, '$.epoch') = ?",
        Number(id),
        epoch,
      )
      // Exactly one of the two went through, and the log agrees with the answers.
      if (outcome === 'renewed') {
        expect(wasExpired, `#${id} renewed and expired`).toBe(false)
        expect(expiryEvents).toBe(0)
      } else {
        expect(outcome).toBe('claim_lost')
        expect(wasExpired || expiryEvents === 1, `#${id} refused a renew but was never expired`).toBe(true)
        expect(expiryEvents).toBe(1)
      }
    }
    // Every task went one way or the other, and the race was a race: some of each.
    const renewedCount = renewed.filter(([, , o]) => o === 'renewed').length
    expect(renewedCount + eventsOf(parent, 'task.expired')).toBe(N)
    expect(renewedCount).toBeGreaterThan(0)
  }, 60_000)

  it('AT-23 [proc] without a wake bridge, a create in another process wakes a waiter within the 1 s backoff ceiling', async () => {
    const { path, parent } = board()
    const [waiter] = await children(path, 1)
    const waiting = waiter!.call<{ task: MessageView | null }>('alice+w1', 'claimReady', [{ channel: 'dev', wait: 10 }])
    // Let the backoff climb to its ceiling first: 100 + 200 + 400 + 800 ms.
    await sleep(1600)
    const made = parent.board.tasks.createTask(alice, { channel: 'dev', text: 'wake up' }).task.id
    const createdAt = Date.now()
    const reply = await waiting
    const latency = Date.now() - createdAt
    expect(reply.ok && reply.value.task?.id).toBe(made)
    // The ceiling is 1 s, plus 0-5 ms of jitter, plus the IPC hop: a generous bound.
    expect(latency).toBeLessThan(1500)
  }, 30_000)

  it('AT-24 [proc] herd: 20 processes with 5 waiters each on one scope, one task: one claim, at most one BEGIN IMMEDIATE a process', async () => {
    const { path, parent } = board()
    const procs = await children(path, 20)
    await Promise.all(procs.map((c) => c.ask('begins', { reset: true })))
    const waits = procs.flatMap((c, p) =>
      Array.from({ length: 5 }, () => c.call<{ task: MessageView | null }>(`alice+p${p}`, 'claimReady', [{ channel: 'dev', wait: 4 }])),
    )
    await sleep(700)
    const made = parent.board.tasks.createTask(alice, { channel: 'dev', text: 'the one task' }).task.id
    const replies = await Promise.all(waits)
    const got = replies.flatMap((r) => (r.ok && r.value.task ? [r.value.task.id] : []))
    expect(replies.every((r) => r.ok)).toBe(true)
    expect(got).toEqual([made])
    const begins = await Promise.all(procs.map((c) => c.ask<number>('begins')))
    expect(Math.max(...begins)).toBeLessThanOrEqual(1)
    expect(begins.reduce((s, n) => s + n, 0)).toBeGreaterThanOrEqual(1)
    expect(eventsOf(parent, 'task.claimed', made)).toBe(1)
  }, 60_000)

  it('AT-25 a read-only pre-probe holding a read transaction does not delay another connection\'s BEGIN IMMEDIATE beyond 5 ms', async () => {
    const { path, parent } = board()
    for (let i = 0; i < 20; i++) parent.board.tasks.createTask(alice, { channel: 'dev', text: `ready ${i}` })
    const [reader] = await children(path, 1)
    const timeBegin = (): number => {
      const start = performance.now()
      parent.store.db.exec('BEGIN IMMEDIATE')
      const took = performance.now() - start
      parent.store.db.exec('ROLLBACK')
      return took
    }
    const median = (xs: number[]): number => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!
    const baseline = median(Array.from({ length: 31 }, timeBegin))
    // The pre-probe found a candidate and keeps its read transaction (a WAL snapshot) open.
    const found = await reader!.ask<number | null>('holdRead', { caller: 'alice+w1', body: { channel: 'dev' } })
    expect(found).not.toBeNull()
    const held = Array.from({ length: 31 }, timeBegin)
    // A real write goes through too while the read is held, and the reader's snapshot doesn't see it.
    const start = performance.now()
    parent.board.tasks.createTask(alice, { channel: 'dev', text: 'while a read is held' })
    const writeMs = performance.now() - start
    await reader!.ask('endRead')
    expect(median(held)).toBeLessThan(baseline + 5)
    expect(Math.max(...held)).toBeLessThan(250)
    expect(writeMs).toBeLessThan(250)
  }, 30_000)

  it('AT-37 [proc] a kill -9 before COMMIT of a complete with dependents leaves no partial state; one after COMMIT leaves exactly the committed state', async () => {
    const { path, parent } = board()
    const need = parent.board.tasks.createTask(alice, { channel: 'dev', text: 'build' }).task.id
    const dependents = [1, 2, 3].map((i) => parent.board.tasks.createTask(alice, { channel: 'dev', text: `ship ${i}`, needs: [need] }).task.id)
    const [doomed] = await children(path, 1)
    const claim = (await doomed!.ask<{ claim: TaskClaim }>('call', { caller: 'alice+w1', method: 'claimTask', args: [need, {}] })).claim
    const generation = wakeupGeneration(parent)
    const head = count(parent, 'SELECT MAX(log_index) AS c FROM board_events')
    parent.close()

    await doomed!.ask('armCrash')
    // The child dies inside the transaction: its statements ran, its COMMIT never did.
    const dying = doomed!.send('call', { caller: 'alice+w1', method: 'completeTask', args: [need, { epoch: claim.epoch, token: claim.token }] })
    await expect(dying).rejects.toThrow(/exited/)
    expect((await doomed!.exited).signal).toBe('SIGKILL')

    const reopened = open(path)
    cleanup.push(() => reopened.close())
    expect(count(reopened, 'SELECT MAX(log_index) AS c FROM board_events')).toBe(head)
    expect(eventsOf(reopened, 'task.completed')).toBe(0)
    expect(wakeupGeneration(reopened)).toBe(generation)
    const row = reopened.store.db.prepare('SELECT state, epoch FROM board_tasks WHERE task_id = ?').get(Number(need)) as { state: string; epoch: number }
    expect(row).toEqual({ state: 'claimed', epoch: 1 })
    for (const id of dependents) {
      expect(reopened.board.getMessageThread(alice, id).message.task?.state).toBe('waiting')
    }
    expect(reopened.board.getMessageThread(alice, need).message.task?.state).toBe('claimed')
    reopened.close()

    // Now a process that completes, commits, answers, and is killed right after.
    const [survivor] = await children(path, 1)
    const done = await survivor!.ask<{ task: MessageView }>('call', {
      caller: 'alice+w1',
      method: 'completeTask',
      args: [need, { epoch: claim.epoch, token: claim.token, result: 'built' }],
    })
    expect(done.task.task?.state).toBe('completed')
    await survivor!.kill()

    const after = open(path)
    cleanup.push(() => after.close())
    expect(eventsOf(after, 'task.completed', need)).toBe(1)
    expect(after.board.getMessageThread(alice, need).message.task).toMatchObject({ state: 'completed', result: 'built' })
    for (const id of dependents) {
      expect(after.board.getMessageThread(alice, id).message.task?.state).toBe('ready')
      expect(eventsOf(after, 'task.ready', id)).toBe(1)
    }
    expect(wakeupGeneration(after)).toBeGreaterThan(generation)
    // The retry a client makes when it never saw the answer: the claim is over.
    let retried: unknown
    try {
      after.board.tasks.completeTask(createLocalCaller({ userId: 'alice', handle: 'alice', owner: true, profile: 'w1' }), need, {
        epoch: claim.epoch,
        token: claim.token,
      })
    } catch (error) {
      retried = error
    }
    expect(retried).toMatchObject({ status: 409, code: 'claim_lost' })
    expect(eventsOf(after, 'task.completed', need)).toBe(1)
  }, 30_000)
})
