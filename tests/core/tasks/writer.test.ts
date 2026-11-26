import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardError,
  commitTaskEventsInTx,
  loadAllRows,
  loadRow,
  TASK_EVENT_TYPES,
  toTaskView,
  type PlannedTaskEvent,
  type StoredMessage,
  type TaskEventType,
} from '../../../src/core/index.ts'
import { alice, AUTHOR, created, ev, eventCount, HASH_A, makeBoard, message_, post, reply, T0, type Board } from './helpers.ts'
import { pick, prng, refFold, refView, type RefMessage } from './reference-fold.ts'

const boards: Board[] = []
const open = (): Board => {
  const b = makeBoard()
  boards.push(b)
  return b
}
afterEach(() => {
  while (boards.length > 0) boards.pop()!.close()
})

const ASSIGNEES = [null, `${AUTHOR.principal}+x`, `${AUTHOR.principal}+y`]

const hex = (rand: () => number): string =>
  Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('')

/** A random task event about `root`, legal or not, with needs among `others`. */
/** The events that can leave each state: the generator leans on them, so sequences go deep. */
const NEXT: Record<string, readonly TaskEventType[]> = {
  none: ['task.created'],
  waiting: ['task.ready', 'task.needs_changed', 'task.blocked', 'task.canceled', 'task.assigned'],
  ready: ['task.claimed', 'task.claimed', 'task.blocked', 'task.canceled', 'task.needs_changed', 'task.assigned'],
  claimed: ['task.renewed', 'task.released', 'task.expired', 'task.expired', 'task.completed', 'task.failed', 'task.blocked', 'task.canceled'],
  blocked: ['task.unblocked', 'task.canceled', 'task.needs_changed', 'task.assigned'],
  failed: ['task.reopened', 'task.canceled', 'task.assigned'],
  completed: ['task.assigned'],
  canceled: ['task.assigned'],
}

function randomPlanned(rand: () => number, root: StoredMessage, state: string, epoch: number, others: number[], nowMs: number): PlannedTaskEvent {
  const type = (rand() < 0.75 ? pick(rand, NEXT[state]!) : pick(rand, TASK_EVENT_TYPES)) as TaskEventType
  const ep = Math.max(1, epoch + Math.floor(rand() * 3) - 1)
  const until = new Date(nowMs + 30_000 + Math.floor(rand() * 600_000)).toISOString()
  const needs = others.filter((id) => id !== root.id && rand() < 0.04).slice(0, 5)
  const p = (extra: Record<string, unknown>) => ev(root, type, extra)
  switch (type) {
    case 'task.created':
      return created(root, needs, pick(rand, ASSIGNEES))
    case 'task.assigned':
      return p({ for: pick(rand, ASSIGNEES), by: AUTHOR })
    case 'task.needs_changed':
      return p({ needs, by: AUTHOR })
    case 'task.ready':
      return p({})
    case 'task.claimed':
      return p({ epoch: rand() < 0.8 ? epoch + 1 : ep, until, token: hex(rand), by: AUTHOR })
    case 'task.renewed':
      return p({ epoch: rand() < 0.8 ? epoch : ep, until, by: AUTHOR })
    case 'task.released':
      return p({ epoch: rand() < 0.8 ? epoch : ep, by: AUTHOR })
    case 'task.expired':
      return p({ epoch: rand() < 0.8 ? epoch : ep })
    case 'task.completed':
      return p({ epoch: rand() < 0.8 ? epoch : ep, result: rand() < 0.5 ? null : 'shipped it', by: AUTHOR })
    case 'task.failed':
      return p({ epoch: rand() < 0.8 ? epoch : ep, reason: 'it broke', by: AUTHOR })
    case 'task.blocked':
      return p({ kind: rand() < 0.5 ? null : 'person', reason: 'needs a human', by: AUTHOR })
    case 'task.unblocked':
    case 'task.reopened':
      return p({ by: AUTHOR })
    default:
      return p({ reason: 'not needed', by: AUTHOR })
  }
}

/** AT-04: the three projections of one task agree, and its hash stays out of the message. */
function expectConsistent(b: Board, taskId: number): void {
  const row = loadRow(b.store.db, taskId)
  const msg = message_(b, taskId)
  if (!row) {
    expect(msg.task).toBeUndefined()
    return
  }
  expect(msg.task).toEqual(toTaskView(row))
  if (!msg.deleted) expect(msg.labels['board.task']).toBe(row.state)
  if (row.claim_token_hash) expect(JSON.stringify(msg)).not.toContain(row.claim_token_hash)
}

function snapshot(b: Board): { tasks: unknown[]; needs: unknown[] } {
  return {
    tasks: b.store.db.prepare('SELECT * FROM board_tasks ORDER BY task_id').all(),
    needs: b.store.db.prepare('SELECT * FROM board_task_needs ORDER BY task_id, need_id').all(),
  }
}

/** Runs seeded random event sequences on one board; returns how many events landed and how many were refused. */
function runSeed(b: Board, seed: number, roots = 100, steps = 1000): { landed: number; refused: number } {
  const rand = prng(seed)
  const messages: StoredMessage[] = []
  for (let i = 0; i < roots; i++) messages.push(post(b, `task ${seed}/${i}`, rand() < 0.5 ? 'dev' : 'ops/a'))
  // Replies too: task.created never lands on one.
  for (let i = 0; i < 5; i++) messages.push(reply(b, messages[i]!.id, `reply ${i}`))
  const ids = messages.map((m) => m.id)
  const model = new Map<number, RefMessage>(messages.map((m) => [m.id, { id: m.id, re: m.re, deleted: false }]))
  let landed = 0
  let refused = 0
  for (let step = 0; step < steps; step++) {
    b.clock.now += Math.floor(rand() * 5000)
    const root = pick(rand, messages)
    const ref = model.get(root.id)!
    const planned = randomPlanned(rand, root, ref.task?.state ?? 'none', ref.task?.epoch ?? 0, ids, b.clock.now)
    const predicted = structuredClone(ref)
    const legal = refFold(predicted, { type: planned.type, payload: planned.payload })
    const before = eventCount(b)
    const rowBefore = loadRow(b.store.db, root.id)
    if (legal) {
      const out = b.board.tasks.transition(root.id, [planned])
      expect(out).toHaveLength(1)
      expect(eventCount(b)).toBe(before + 1)
      model.set(root.id, predicted)
      landed += 1
    } else {
      let error: unknown
      try {
        b.board.tasks.transition(root.id, [planned])
      } catch (e) {
        error = e
      }
      expect(error, `seed ${seed} step ${step}: ${planned.type} on ${ref.task?.state ?? 'no task'}`).toBeInstanceOf(BoardError)
      expect((error as BoardError).status).toBe(500)
      expect((error as BoardError).code).toBe('internal')
      expect(eventCount(b)).toBe(before)
      expect(loadRow(b.store.db, root.id)).toEqual(rowBefore)
      refused += 1
    }
    expectConsistent(b, root.id)
  }
  return { landed, refused }
}

describe('the single writer (AT-02..AT-05)', () => {
  it('AT-02 fold equivalence: random sequences, refusals included, project exactly what a replay of the log through the original fold gives', () => {
    let landed = 0
    let refused = 0
    for (let seed = 1; seed <= 20; seed++) {
      const b = open()
      const r = runSeed(b, seed)
      landed += r.landed
      refused += r.refused

      // Replay every logged task event through the independent transcription of the original fold.
      const log = b.store.db
        .prepare("SELECT log_index, type, payload_json FROM board_events WHERE substr(type, 1, 5) = 'task.' ORDER BY log_index")
        .all() as Array<{ log_index: number; type: string; payload_json: string }>
      const replay = new Map<number, RefMessage>()
      const expired = new Map<number, number>()
      for (const row of log) {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>
        const id = payload.id as number
        if (!replay.has(id)) {
          const m = message_(b, id)
          replay.set(id, { id, re: m.re, deleted: false })
        }
        // No written event was a fold no-op.
        expect(refFold(replay.get(id), { type: row.type, payload }), `#${row.log_index} ${row.type}`).toBe(true)
        if (row.type === 'task.expired') expired.set(id, (expired.get(id) ?? 0) + 1)
      }
      const rows = loadAllRows(b.store.db)
      expect(rows.map((r) => r.task_id)).toEqual([...replay.values()].filter((m) => m.task).map((m) => m.id).sort((x, y) => x - y))
      for (const row of rows) {
        const task = replay.get(row.task_id)!.task!
        expect(toTaskView(row)).toEqual(refView(task))
        expect(message_(b, row.task_id).task).toEqual(refView(task))
        expect(row.claim_token_hash).toBe(task.claim?.token ?? null)
        expect(row.expirations).toBe(expired.get(row.task_id) ?? 0)
      }
      b.close()
      boards.pop()
    }
    expect(landed).toBeGreaterThan(4000)
    expect(refused).toBeGreaterThan(4000)
  }, 120_000)

  it('AT-03 rebuild equality: rebuildIndex reproduces board_tasks and board_task_needs byte for byte, expirations included', () => {
    for (let seed = 101; seed <= 105; seed++) {
      const b = open()
      runSeed(b, seed, 60, 800)
      const live = snapshot(b)
      expect((live.tasks as Array<{ expirations: number }>).some((r) => r.expirations > 0)).toBe(true)
      expect(live.needs.length).toBeGreaterThan(0)
      const counts = b.board.tasks.rebuildIndex()
      expect(counts.tasks).toBe(live.tasks.length)
      expect(counts.edges).toBe(live.needs.length)
      expect(JSON.stringify(snapshot(b))).toBe(JSON.stringify(live))
    }
  }, 60_000)

  it('AT-03 rebuild marks a deleted root and keeps its last task index, as the live delete hook will', () => {
    const b = open()
    const root = post(b, 'doomed')
    b.board.tasks.transition(root.id, [created(root)])
    b.board.deleteMessage(alice, String(root.id))
    const row = loadRow(b.store.db, root.id)!
    // The live delete hook (A7) has landed: it canceled the task and marked the root deleted.
    expect(row).toMatchObject({ state: 'canceled', reason: 'deleted', root_deleted: 1 })
    b.board.tasks.rebuildIndex()
    const rebuilt = loadRow(b.store.db, root.id)!
    expect(rebuilt.root_deleted).toBe(1)
    expect(rebuilt.updated_index).toBe(row.updated_index)
    expect({ ...rebuilt, root_deleted: 0 }).toEqual({ ...row, root_deleted: 0 })
    expect(rebuilt).toEqual(row)
  })

  it('AT-04 projection consistency: after every write the row, message.task and the label agree, and every task event has its own board_versions snapshot', () => {
    const b = open()
    runSeed(b, 7, 40, 600)
    for (const row of loadAllRows(b.store.db)) expectConsistent(b, row.task_id)
    const missing = b.store.db
      .prepare(
        `SELECT e.log_index FROM board_events e
         LEFT JOIN board_versions v ON v.log_index = e.log_index AND v.message_id = json_extract(e.payload_json, '$.id')
         WHERE substr(e.type, 1, 5) = 'task.' AND v.log_index IS NULL`,
      )
      .all()
    expect(missing).toEqual([])
    // The claim hash lives only in board_tasks and the task.claimed payload: never in a message or a version.
    const hashes = (b.store.db.prepare('SELECT claim_token_hash AS h FROM board_tasks WHERE claim_token_hash IS NOT NULL').all() as Array<{ h: string }>).map((r) => r.h)
    expect(hashes.length).toBeGreaterThan(0)
    const versions = (b.store.db.prepare('SELECT data FROM board_versions').all() as Array<{ data: string }>).map((r) => r.data).join('\n')
    const messages = (b.store.db.prepare('SELECT data FROM board_messages').all() as Array<{ data: string }>).map((r) => r.data).join('\n')
    for (const h of hashes) {
      expect(versions).not.toContain(h)
      expect(messages).not.toContain(h)
    }
    // Task events bump a root's version, never its revision.
    const root = message_(b, loadAllRows(b.store.db)[0]!.task_id)
    expect(root.version).toBeGreaterThan(root.revision)
  })

  it('AT-04 a task event updates the label, version and index row at its own log index', () => {
    const b = open()
    const root = post(b, 'one task')
    const [c] = b.board.tasks.transition(root.id, [created(root)])
    const until = new Date(T0 + 60_000).toISOString()
    const [cl] = b.board.tasks.transition(root.id, [ev(root, 'task.claimed', { epoch: 1, until, token: HASH_A, by: AUTHOR })])
    const msg = message_(b, root.id)
    expect(msg.labels['board.task']).toBe('claimed')
    expect(msg.version).toBe(cl!.index)
    expect(msg.revision).toBe(root.revision)
    expect(msg.task!.claim).toEqual({ actor: AUTHOR.actor, until })
    const row = loadRow(b.store.db, root.id)!
    expect([row.created_index, row.updated_index, row.epoch, row.claim_until_ms]).toEqual([c!.index, cl!.index, 1, T0 + 60_000])
    // Event times come from the injected clock.
    expect(cl!.createdAt).toBe(new Date(T0).toISOString())
  })

  it('AT-05 FEI rollback: a planned event that folds to a no-op answers 500 internal and rolls the whole write back', () => {
    const b = open()
    const root = post(b, 'fenced')
    const dep = post(b, 'dependent')
    b.board.tasks.transition(root.id, [created(root)])
    b.board.tasks.transition(dep.id, [created(dep, [root.id])])
    const before = {
      events: eventCount(b),
      versions: b.store.db.prepare('SELECT COUNT(*) AS c FROM board_versions').get(),
      tasks: snapshot(b),
      root: message_(b, root.id),
      dep: message_(b, dep.id),
      gen: b.store.getWakeupGeneration(),
      fts: b.store.db.prepare('SELECT * FROM fts_tasks ORDER BY task_id').all(),
    }
    const until = new Date(T0 + 60_000).toISOString()
    const claim = ev(root, 'task.claimed', { epoch: 1, until, token: HASH_A, by: AUTHOR })
    // A legal claim, a legal completion and a promotion, then an event the fold refuses (a second
    // claim at the same epoch): nothing of the four may stay.
    const plan: PlannedTaskEvent[] = [
      claim,
      ev(root, 'task.completed', { epoch: 1, result: 'done', by: AUTHOR }),
      ev(dep, 'task.ready'),
      { ...claim },
    ]
    let error: unknown
    try {
      b.board.tasks.transition(root.id, plan)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(BoardError)
    expect((error as BoardError).status).toBe(500)
    expect((error as BoardError).code).toBe('internal')
    expect((error as BoardError).message).toBe(`fold refused task.claimed on #${root.id} at completed`)
    expect(eventCount(b)).toBe(before.events)
    expect(b.store.db.prepare('SELECT COUNT(*) AS c FROM board_versions').get()).toEqual(before.versions)
    expect(snapshot(b)).toEqual(before.tasks)
    expect(message_(b, root.id)).toEqual(before.root)
    expect(message_(b, dep.id)).toEqual(before.dep)
    expect(b.store.getWakeupGeneration()).toBe(before.gen)
    expect(b.store.db.prepare('SELECT * FROM fts_tasks ORDER BY task_id').all()).toEqual(before.fts)

    // The same plan without the refused event lands whole, the promotion at the next index.
    const out = b.board.tasks.transition(root.id, plan.slice(0, 3))
    expect(out.map((e) => e.type)).toEqual(['task.claimed', 'task.completed', 'task.ready'])
    expect(out[2]!.index).toBe(out[1]!.index + 1)
    expect(loadRow(b.store.db, dep.id)!.state).toBe('ready')
    expect(b.store.getWakeupGeneration()).toBeGreaterThan(before.gen)
  })

  it('AT-05 the writer refuses to run outside a transaction, and a task.created on a root that already wears a task', () => {
    const b = open()
    const root = post(b, 'twice')
    expect(() => commitTaskEventsInTx(b.board.tasks.host, root, null, [created(root)])).toThrow(/inside a transaction only/)
    expect(loadRow(b.store.db, root.id)).toBeNull()
    b.board.tasks.transition(root.id, [created(root)])
    expect(() => b.board.tasks.transition(root.id, [created(root)])).toThrow(/fold refused task\.created/)
    const missing = { ...root, id: 99_999 }
    expect(() => b.board.tasks.transition(99_999, [created(missing)])).toThrow(/fold refused task\.created on #99999 at no task/)
  })
})

