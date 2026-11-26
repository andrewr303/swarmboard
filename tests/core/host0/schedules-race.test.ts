// HOST-0 stage 3, C7 (HOST0_DESIGN 3.10): recurring schedules re-checked under the lock (HT-77, HT-79 to
// HT-82). The two-process race (HT-78) is in proc/ticker.test.ts.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, createLocalCaller, SqliteUnifiedStore, type SqliteStoreOptions } from '../../../src/core/index.ts'

const T0 = Date.parse('2026-11-22T12:00:00.000Z')
const alice = createLocalCaller({ userId: 'alice', handle: 'alice', member: true })

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function tempPath(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-sched-'))
  dirs.push(dir)
  return join(dir, 'board.db')
}
function open(path: string, extra: Partial<SqliteStoreOptions> = {}): SqliteUnifiedStore {
  const s = new SqliteUnifiedStore({ path, ...extra })
  stores.push(s)
  return s
}

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close()
    } catch {
      // Closed already.
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

type Fixture = { sA: SqliteUnifiedStore; A: BoardService; sB: SqliteUnifiedStore; B: BoardService; arm(fn: () => void): void }

/** Two connections on one file. `arm(fn)` runs `fn` once, at the start of B's next write transaction. */
function twoTickers(): Fixture {
  const path = tempPath()
  let armed: (() => void) | null = null
  const sA = open(path)
  const sB = open(path, {
    testHooks: {
      onBeginImmediate: () => {
        const fn = armed
        armed = null
        fn?.()
      },
    },
  })
  return { sA, A: new BoardService(sA), sB, B: new BoardService(sB), arm: (fn) => (armed = fn) }
}

const count = (s: SqliteUnifiedStore, channel = 'dev'): number =>
  (s.db.prepare('SELECT COUNT(*) AS n FROM board_messages WHERE channel = ?').get(channel) as { n: number }).n
const row = (s: SqliteUnifiedStore, id: string): { next_at: number | null; data: { sent: number; state: string; canceled?: { reason: string } } } => {
  const r = s.db.prepare('SELECT next_at, data FROM board_schedules WHERE id = ?').get(id) as { next_at: number | null; data: string }
  return { next_at: r.next_at, data: JSON.parse(r.data) }
}

describe('C7 schedule compare-and-set', () => {
  it('HT-77 an in-process two-ticker race sends one message and skips the loser', () => {
    const { sA, A, B, arm } = twoTickers()
    const s = A.createSchedule(alice, { channel: 'dev', text: 'tick', in: '1m', every: '1m' }, T0)
    let inner: ReturnType<BoardService['runDueSchedules']> | null = null
    arm(() => {
      inner = A.runDueSchedules(T0 + 60_000)
    })
    const outer = B.runDueSchedules(T0 + 60_000)
    expect(inner!.sent.map((m) => m.thread)).toEqual(['board-schedule:1:0'])
    expect(outer.sent).toEqual([])
    expect(outer.failed).toEqual([])
    expect(outer.skipped).toEqual([s.id])
    expect(count(sA)).toBe(1)
    const r = row(sA, s.id)
    expect(r.next_at).toBe(T0 + 120_000)
    expect(r.data.sent).toBe(1)
  })

  it('HT-79 a cancel that races a fire makes the fire skip', () => {
    const { sA, A, B, arm } = twoTickers()
    const s = A.createSchedule(alice, { channel: 'dev', text: 'tick', in: '1m', every: '1m' }, T0)
    arm(() => {
      A.cancelSchedule(alice, s.id)
    })
    const outer = B.runDueSchedules(T0 + 60_000)
    expect(outer.skipped).toEqual([s.id])
    expect(outer.sent).toEqual([])
    expect(count(sA)).toBe(0)
    const r = row(sA, s.id)
    expect(r.data.state).toBe('canceled')
    expect(r.data.canceled?.reason).toBe('canceled')
  })

  it('HT-80 a single ticker is unchanged, and a raced one-shot sends once', () => {
    const { sA, A } = twoTickers()
    const s = A.createSchedule(alice, { channel: 'dev', text: 'tick', in: '1m', every: '1m' }, T0)
    const first = A.runDueSchedules(T0 + 330_000)
    expect(first.sent.map((m) => m.thread)).toEqual(['board-schedule:1:0'])
    expect(row(sA, s.id).next_at).toBe(T0 + 360_000)
    expect(first.skipped).toEqual([])
    expect(first.stopped).toBe(false)
    const again = A.runDueSchedules(T0 + 330_000)
    expect(again.sent).toEqual([])
    expect(again.skipped).toEqual([])

    const f = twoTickers()
    const one = f.A.createSchedule(alice, { channel: 'dev', text: 'once', in: '1m' }, T0)
    f.arm(() => {
      f.A.runDueSchedules(T0 + 60_000)
    })
    const outer = f.B.runDueSchedules(T0 + 60_000)
    expect(count(f.sA)).toBe(1)
    expect(outer.skipped).toEqual([one.id])
  })

  it('HT-81 shouldContinue stops the run before the next due schedule', () => {
    const mk = (): { sA: SqliteUnifiedStore; A: BoardService } => {
      const { sA, A } = twoTickers()
      for (const t of ['a', 'b', 'c']) A.createSchedule(alice, { channel: 'dev', text: t, in: '1m' }, T0)
      return { sA, A }
    }
    const pending = (s: SqliteUnifiedStore): number =>
      (s.db.prepare("SELECT COUNT(*) AS n FROM board_schedules WHERE state = 'pending'").get() as { n: number }).n

    const a = mk()
    const ra = a.A.runDueSchedules(T0 + 60_000, { shouldContinue: () => false })
    expect(ra.sent).toEqual([])
    expect(ra.stopped).toBe(true)
    expect(pending(a.sA)).toBe(3)

    const b = mk()
    let calls = 0
    const rb = b.A.runDueSchedules(T0 + 60_000, { shouldContinue: () => ++calls < 2 })
    expect(rb.sent).toHaveLength(1)
    expect(rb.stopped).toBe(true)
    expect(pending(b.sA)).toBe(2)

    const c = mk()
    let n = 0
    const rc = c.A.runDueSchedules(T0 + 60_000, {
      shouldContinue: () => {
        if (++n === 2) throw new Error('boom')
        return true
      },
    })
    expect(rc.sent).toHaveLength(1)
    expect(rc.stopped).toBe(true)

    const d = mk()
    const rd = d.A.runDueSchedules(T0 + 60_000)
    expect(rd.sent).toHaveLength(3)
    expect(rd.stopped).toBe(false)
  })

  it('HT-82 the default clock of createSchedule and runDueSchedules is the injected one', () => {
    const clock = { now: Date.UTC(2031, 0, 1) }
    const store = open(tempPath())
    const board = new BoardService(store, { now: () => clock.now })
    const s = board.createSchedule(alice, { channel: 'dev', text: 'x', in: '1m' })
    expect(s.next).toBe(new Date(clock.now + 60_000).toISOString())
    expect(board.runDueSchedules().sent).toEqual([])
    clock.now += 60_000
    expect(board.runDueSchedules().sent).toHaveLength(1)
  })
})
