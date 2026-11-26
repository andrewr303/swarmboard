// HOST-0 stage 3, C6 (HOST0_DESIGN 3.9): the system caller, the reserved ids, systemAuthor and systemOps
// (HT-64 to HT-70).
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  SYSTEM_PRINCIPAL_ID as FROM_INDEX,
  type CallerContext,
} from '../../../src/core/index.ts'
import * as internal from '../../../src/core/internal.ts'
import {
  createSystemCaller,
  isSystemCaller,
  SYSTEM_PRINCIPAL_ID,
  systemAuthor,
  systemOps,
} from '../../../src/core/system.ts'
import { alice as taskAlice, makeBoard, T0, type Board } from '../tasks/helpers.ts'
import { bob, claimOf, head, makeTask, taskEventsAfter } from '../tasks/verb-helpers.ts'

const alice = createLocalCaller({ userId: 'alice', handle: 'alice', member: true })
const stores: SqliteUnifiedStore[] = []
const boards: Board[] = []

function mem(options: ConstructorParameters<typeof BoardService>[1] = {}): { store: SqliteUnifiedStore; board: BoardService } {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return { store, board: new BoardService(store, options) }
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  while (boards.length > 0) boards.pop()!.close()
})

const refused = (fn: () => unknown): BoardError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(BoardError)
    return e as BoardError
  }
  throw new Error('expected a refusal')
}

describe('C6 the system caller', () => {
  it('HT-64 createSystemCaller returns one frozen object that nothing can copy', () => {
    const c = createSystemCaller()
    expect(createSystemCaller()).toBe(c)
    expect(c.principal).toEqual({ id: 'board:system', kind: 'deployment', handle: 'system' })
    expect(c.actor).toEqual({ id: 'board:system', kind: 'deployment', handle: 'system', name: 'system', avatar: null })
    expect(c.profile).toBeNull()
    expect('canHeader' in c).toBe(false)
    expect(Object.isFrozen(c)).toBe(true)
    expect(Object.isFrozen(c.principal)).toBe(true)
    expect(Object.isFrozen(c.actor)).toBe(true)
    expect(() => {
      ;(c as { profile: string | null }).profile = 'p'
    }).toThrow(TypeError)
    expect(isSystemCaller(c)).toBe(true)
    expect(isSystemCaller({ ...c })).toBe(false)
    expect(isSystemCaller(structuredClone(c))).toBe(false)
    expect(isSystemCaller(null)).toBe(false)
    expect(isSystemCaller({})).toBe(false)
    const a = systemAuthor()
    expect(a).toEqual({ actor: 'board:system', principal: 'board:system', profile: null })
    expect(systemAuthor()).not.toBe(a)
  })

  it('HT-65 the genuine system caller is refused by every verb family', () => {
    const { board } = mem()
    const sys = createSystemCaller() as unknown as CallerContext
    const head0 = board.store.getHeadIndex()
    const calls: Array<() => unknown> = [
      () => board.postMessage(sys, { channel: 'dev', text: 'x' }),
      () => board.createSchedule(sys, { channel: 'dev', text: 'x', in: '1m' }),
      () => board.registerWatchers(sys, { url: null, watch: {}, sync: [] }),
      () => board.createChannel(sys, { path: 'dev' }),
      () => board.tasks.createTask(sys, { channel: 'dev', text: 'x' }),
    ]
    for (const call of calls) {
      const e = refused(call)
      expect([e.status, e.code]).toEqual([403, 'forbidden'])
      expect(e.message).toContain('board:system')
    }
    expect(board.store.getHeadIndex()).toBe(head0)
  })

  it('HT-66 forged look-alikes are refused and nothing is written', () => {
    const { board } = mem()
    const sys = createSystemCaller()
    const forged: CallerContext[] = [
      {
        principal: { id: 'board:system', kind: 'user', handle: 'x', member: true },
        actor: { id: 'local:user:x', kind: 'person', handle: 'x', name: 'x', avatar: null },
        profile: null,
      },
      {
        principal: { id: 'board:deployment', kind: 'deployment', handle: 'board' },
        actor: { id: 'board:system', kind: 'deployment', handle: 'system', name: 'system', avatar: null },
        profile: null,
      },
      {
        principal: { id: 'board:deployment', kind: 'deployment', handle: 'board' },
        actor: { id: 'board:schedule', kind: 'deployment', handle: 'schedule', name: 'schedule', avatar: null },
        profile: null,
      },
      { ...sys, profile: 'p' } as unknown as CallerContext,
      { ...sys, canHeader: '*=read' } as unknown as CallerContext,
    ]
    const head0 = board.store.getHeadIndex()
    for (const f of forged) {
      const e = refused(() => board.postMessage(f, { channel: 'dev', text: 'x' }))
      expect([e.status, e.code]).toEqual([403, 'forbidden'])
    }
    expect(board.store.getHeadIndex()).toBe(head0)
    // Control: the M1 deployment caller still posts.
    const deployment: CallerContext = {
      principal: { id: 'board:deployment', kind: 'deployment', handle: 'board' },
      actor: { id: 'board:deployment', kind: 'deployment', handle: 'board', name: 'board', avatar: null },
      profile: null,
    }
    expect(board.postMessage(deployment, { channel: 'dev', text: 'ok' }).message.text).toBe('ok')
  })

  it('HT-67 the lapse and plan author is board:system', () => {
    expect(SYSTEM_PRINCIPAL_ID).toBe('board:system')
    expect(FROM_INDEX).toBe('board:system')
    expect(internal.SYSTEM_PRINCIPAL_ID).toBe('board:system')
    const b = makeBoard()
    boards.push(b)
    b.board.tasks.use({ name: 'l', lapse: () => ({ action: 'fail', reason: 'poison' }) })
    const t = makeTask(b, taskAlice, 'flaky')
    claimOf(b, bob, t.id, { lease: 30 })
    b.clock.now = T0 + 30_000
    const at = head(b)
    b.board.tasks.expireDueClaims()
    const failed = taskEventsAfter(b, at).filter((e) => e.type === 'task.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.payload.by).toEqual({ actor: 'board:system', principal: 'board:system', profile: null })
    let author: unknown
    const b2 = makeBoard()
    boards.push(b2)
    b2.board.tasks.use({ name: 'p', plan: (_plan, tx) => void (author = tx.systemAuthor()) })
    makeTask(b2, taskAlice, 'x')
    expect(author).toEqual({ actor: 'board:system', principal: 'board:system', profile: null })
  })

  it('HT-68 a revoked schedule is canceled by board:schedule', () => {
    let allowed = true
    const { board } = mem({ principalNow: (p) => (allowed ? p : null) })
    const s = board.createSchedule(alice, { channel: 'dev', text: 'x', in: '1m' }, T0)
    allowed = false
    const run = board.runDueSchedules(T0 + 60_000)
    expect(run.sent).toEqual([])
    const by = { actor: 'board:schedule', principal: 'board:schedule', profile: null }
    const ev = board.store.db.prepare("SELECT payload_json FROM board_events WHERE type = 'schedule.canceled'").get() as {
      payload_json: string
    }
    expect((JSON.parse(ev.payload_json) as { by: unknown }).by).toEqual(by)
    const listed = board.listSchedules(alice, { all: true }) as Array<{ id: string; canceled?: { by: unknown; reason: string } }>
    expect(listed.find((x) => x.id === s.id)?.canceled).toEqual({ by, reason: 'revoked' })
  })

  it('HT-69 systemOps refuses a copy and offers the tick', () => {
    const { board } = mem()
    expect(() => systemOps(board, { ...createSystemCaller() } as never)).toThrow(TypeError)
    const ops = systemOps(board, createSystemCaller())
    expect(Object.isFrozen(ops)).toBe(true)
    board.createSchedule(alice, { channel: 'dev', text: 'x', in: '1m' }, T0)
    expect(ops.nextScheduleDueMs()).toBe(T0 + 60_000)
    expect(ops.runDueSchedules(T0 + 60_000).sent).toHaveLength(1)
    expect(ops.nextScheduleDueMs()).toBeNull()
    expect(ops.nextLeaseDueMs()).toBe(board.tasks.nextLeaseDueMs())
    const rebuilt = board.tasks.rebuildIndex()
    expect(ops.rebuildTaskIndex()).toEqual(rebuilt)
  })

  it('HT-70 no board member leaks the tick under a second name', () => {
    const { board } = mem()
    for (const name of ['fireDueSchedules', 'systemOps', 'nextScheduleDueMs', 'createSystemCaller']) {
      expect(name in board).toBe(false)
    }
    expect('systemOps' in board.tasks).toBe(false)
  })
})
