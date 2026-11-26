// AT-02/03/04 at the verb level (the A1 writer tests drive the single writer directly): seeded random
// sequences of the A2..A4 verbs, by several callers on an injected clock, refusals included. No verb
// may answer 500; every task event that landed must replay through the independent transcription of
// the original fold; rebuildIndex must reproduce the index byte for byte; the three projections of
// each task must agree after every step.
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardError,
  loadAllRows,
  loadRow,
  toTaskView,
  type CallerContext,
  type TaskClaim,
} from '../../../src/core/index.ts'
import { alice, makeBoard, message_, type Board } from './helpers.ts'
import { pick, prng, refFold, refView, type RefMessage } from './reference-fold.ts'
import { ALICE, aliceAs, bob, NO_MANAGE, userWith } from './verb-helpers.ts'

const boards: Board[] = []
afterEach(() => {
  while (boards.length > 0) boards.pop()!.close()
})

function expectConsistent(b: Board, taskId: number): void {
  const row = loadRow(b.store.db, taskId)
  const msg = message_(b, taskId)
  if (!row) {
    expect(msg.task).toBeUndefined()
    return
  }
  expect(msg.task).toEqual(toTaskView(row))
  if (!msg.deleted) expect(msg.labels['board.task']).toBe(row.state)
}

const snapshot = (b: Board): string =>
  JSON.stringify({
    tasks: b.store.db.prepare('SELECT * FROM board_tasks ORDER BY task_id').all(),
    needs: b.store.db.prepare('SELECT * FROM board_task_needs ORDER BY task_id, need_id').all(),
  })

type Held = { caller: CallerContext; claim: TaskClaim }

function runSeed(b: Board, seed: number, steps: number): { ok: number; refused: Map<string, number> } {
  const rand = prng(seed)
  const callers: CallerContext[] = [
    alice,
    bob,
    aliceAs('fixer'),
    aliceAs('triage', NO_MANAGE),
    userWith('carol', NO_MANAGE),
    userWith('dana', 'dev=read,post,label;ops=read'),
  ]
  const assignees = [null, `${ALICE}+fixer`, `${ALICE}+triage`, `${ALICE}+nobody`]
  const tasks: string[] = []
  const plain: string[] = []
  const held = new Map<string, Held[]>()
  const refused = new Map<string, number>()
  let ok = 0
  const someNeeds = (): string[] => {
    const n = Math.floor(rand() * 4)
    const out: string[] = []
    for (let i = 0; i < n && tasks.length > 0; i++) out.push(rand() < 0.9 ? pick(rand, tasks) : pick(rand, ['999999', ...plain]))
    return out
  }
  const proofOf = (id: string): Held | null => {
    const list = held.get(id) ?? []
    return list.length === 0 ? null : rand() < 0.85 ? list[list.length - 1]! : pick(rand, list)
  }
  for (let step = 0; step < steps; step++) {
    b.clock.now += Math.floor(rand() * 20_000)
    const caller = pick(rand, callers)
    const id = tasks.length > 0 ? pick(rand, tasks) : '1'
    const verb = tasks.length < 5 ? 'create' : pick(rand, VERBS)
    const run = (): unknown => {
      switch (verb) {
        case 'create': {
          const made = b.board.tasks.createTask(caller, {
            channel: rand() < 0.8 ? 'dev' : 'ops',
            text: `task ${seed}/${step}`,
            ...(rand() < 0.5 ? { needs: someNeeds() } : {}),
            ...(rand() < 0.2 ? { for: pick(rand, assignees) } : {}),
            ...(rand() < 0.2 ? { claim: true, lease: 30 + Math.floor(rand() * 120) } : {}),
            ...(rand() < 0.1 ? { id: `t-${seed}-${Math.floor(rand() * 20)}` } : {}),
          })
          if (!tasks.includes(made.task.id)) tasks.push(made.task.id)
          if (made.claim) held.set(made.task.id, [...(held.get(made.task.id) ?? []), { caller, claim: made.claim }])
          return made
        }
        case 'adopt': {
          const thread = b.board.postMessage(alice, { channel: 'dev', text: `thread ${step}` }).message
          plain.push(thread.id)
          const made = b.board.tasks.createTask(caller, { re: rand() < 0.8 ? thread.id : pick(rand, [...plain, ...tasks]), ...(rand() < 0.4 ? { needs: someNeeds() } : {}) })
          if (!tasks.includes(made.task.id)) tasks.push(made.task.id)
          return made
        }
        case 'claim': {
          const out = b.board.tasks.claimTask(caller, id, { lease: 30 + Math.floor(rand() * 120) })
          held.set(id, [...(held.get(id) ?? []), { caller, claim: out.claim }])
          return out
        }
        case 'renew':
        case 'release':
        case 'complete':
        case 'fail':
        case 'blockProof': {
          const h = proofOf(id)
          const proof = h ? { epoch: h.claim.epoch, token: h.claim.token } : { epoch: 1, token: 'nope' }
          const who = h && rand() < 0.9 ? h.caller : caller
          if (verb === 'renew') return b.board.tasks.renewTask(who, id, { ...proof, lease: 30 + Math.floor(rand() * 60) })
          if (verb === 'release') return b.board.tasks.releaseTask(who, id, proof)
          if (verb === 'complete') return b.board.tasks.completeTask(who, id, { ...proof, ...(rand() < 0.5 ? { result: 'done' } : {}) })
          if (verb === 'fail') return b.board.tasks.failTask(who, id, { ...proof, reason: 'broke' })
          return b.board.tasks.blockTask(who, id, { ...proof, reason: 'ask a person', kind: 'person' })
        }
        case 'block':
          return b.board.tasks.blockTask(caller, id, { reason: 'hold on' })
        case 'unblock':
          return b.board.tasks.unblockTask(caller, id)
        case 'cancel':
          return b.board.tasks.cancelTask(caller, id, { reason: 'not needed' })
        case 'reopen':
          return b.board.tasks.reopenTask(caller, id)
        case 'assign':
          return b.board.tasks.assignTask(caller, id, { for: pick(rand, assignees) })
        default:
          return b.board.tasks.setTaskNeeds(caller, id, { needs: someNeeds() })
      }
    }
    try {
      run()
      ok += 1
    } catch (error) {
      expect(error, `seed ${seed} step ${step} ${verb}`).toBeInstanceOf(BoardError)
      const e = error as BoardError
      expect(e.status, `seed ${seed} step ${step} ${verb}: ${e.code} ${e.message}`).toBeLessThan(500)
      refused.set(e.code, (refused.get(e.code) ?? 0) + 1)
    }
    for (const t of tasks) expectConsistent(b, Number(t))
  }
  return { ok, refused }
}

const VERBS = [
  'create',
  'create',
  'adopt',
  'claim',
  'claim',
  'renew',
  'release',
  'complete',
  'complete',
  'fail',
  'blockProof',
  'block',
  'unblock',
  'cancel',
  'reopen',
  'assign',
  'needs',
  'needs',
] as const

describe('the verbs (AT-02..AT-04 at the verb level)', () => {
  it('AT-02 random verb sequences never answer 500, and every landed task event replays through the original fold', () => {
    const codes = new Map<string, number>()
    let ok = 0
    for (let seed = 1; seed <= 12; seed++) {
      const b = makeBoard()
      boards.push(b)
      const r = runSeed(b, seed, 300)
      ok += r.ok
      for (const [code, n] of r.refused) codes.set(code, (codes.get(code) ?? 0) + n)

      const log = b.store.db
        .prepare("SELECT log_index, type, payload_json FROM board_events WHERE substr(type, 1, 5) = 'task.' ORDER BY log_index")
        .all() as Array<{ log_index: number; type: string; payload_json: string }>
      const replay = new Map<number, RefMessage>()
      const expired = new Map<number, number>()
      for (const row of log) {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>
        const id = payload.id as number
        if (!replay.has(id)) replay.set(id, { id, re: message_(b, id).re, deleted: false })
        expect(refFold(replay.get(id), { type: row.type, payload }), `seed ${seed} #${row.log_index} ${row.type}`).toBe(true)
        if (row.type === 'task.expired') expired.set(id, (expired.get(id) ?? 0) + 1)
      }
      for (const row of loadAllRows(b.store.db)) {
        const task = replay.get(row.task_id)!.task!
        expect(toTaskView(row)).toEqual(refView(task))
        expect(row.claim_token_hash).toBe(task.claim?.token ?? null)
        expect(row.expirations).toBe(expired.get(row.task_id) ?? 0)
      }

      // AT-03: the index is a projection of the log.
      const live = snapshot(b)
      b.board.tasks.rebuildIndex()
      expect(snapshot(b)).toBe(live)

      // AT-04: every task event has its own version snapshot, and no hash leaves board_tasks and the log.
      const missing = b.store.db
        .prepare(
          `SELECT e.log_index FROM board_events e
           LEFT JOIN board_versions v ON v.log_index = e.log_index AND v.message_id = json_extract(e.payload_json, '$.id')
           WHERE substr(e.type, 1, 5) = 'task.' AND v.log_index IS NULL`,
        )
        .all()
      expect(missing).toEqual([])
      const blobs = [
        ...(b.store.db.prepare('SELECT data FROM board_versions').all() as Array<{ data: string }>),
        ...(b.store.db.prepare('SELECT data FROM board_messages').all() as Array<{ data: string }>),
      ]
        .map((r) => r.data)
        .join('\n')
      const hashes = log.filter((e) => e.type === 'task.claimed').map((e) => (JSON.parse(e.payload_json) as { token: string }).token)
      for (const h of hashes) expect(blobs).not.toContain(h)
    }
    // The sequences reach every kind of answer, not just the happy path.
    expect(ok).toBeGreaterThan(1000)
    for (const code of ['claim_lost', 'task_claimed', 'task_finished', 'task_not_owned', 'invalid_needs', 'task_waiting', 'task_assigned']) {
      expect(codes.get(code) ?? 0, code).toBeGreaterThan(0)
    }
  }, 120_000)
})
