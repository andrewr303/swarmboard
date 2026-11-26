// HOST-0 stage 3, C7 tick lease (HOST0_DESIGN 3.10): HT-83 to HT-91, HT-95 and HT-100. The multi-process
// cases (HT-92 to HT-94) are in proc/ticker.test.ts.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardError, BoardService, createLocalCaller, SqliteUnifiedStore, type SqliteStoreOptions } from '../../../src/core/index.ts'
import { createSystemCaller, systemOps } from '../../../src/core/system.ts'
import {
  acquireTickLease,
  readTickLease,
  releaseTickLease,
  renewTickLease,
  TICK_LEASE_KEY,
  type AcquireResult,
  type TickLease,
} from '../../../src/core/tick-lease.ts'

const T = Date.UTC(2026, 10, 24, 12, 0, 0)
const T0 = Date.parse('2026-11-22T12:00:00.000Z')
const alice = createLocalCaller({ userId: 'alice', handle: 'alice', member: true })

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function tempPath(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-lease-'))
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

const at = (t: number) => ({ now: () => t })
const acquired = (r: AcquireResult): Extract<AcquireResult, { acquired: true }> => {
  expect(r.acquired).toBe(true)
  return r as Extract<AcquireResult, { acquired: true }>
}
const raw = (s: SqliteUnifiedStore): string | undefined =>
  (s.db.prepare('SELECT value FROM board_meta WHERE key = ?').get(TICK_LEASE_KEY) as { value: string } | undefined)?.value

describe('C7 the tick lease', () => {
  it('HT-83 a fresh acquire writes the record', () => {
    const s = open(tempPath())
    const r = acquired(acquireTickLease(s, { holder: 'h1', ttlMs: 30_000, ...at(T) }))
    expect(r.takeover).toBe(false)
    expect(r.corrupt).toBe(false)
    expect(r.lease).toEqual({ key: 'host.tick.lease', holder: 'h1', fence: 1, until: T + 30_000 })
    expect(raw(s)).toBe(JSON.stringify({ v: 1, holder: 'h1', fence: 1, until: T + 30_000, at: T }))
  })

  it('HT-84 a lease is never taken early', () => {
    const s = open(tempPath())
    const h1 = acquired(acquireTickLease(s, { holder: 'h1', ttlMs: 30_000, ...at(T) })).lease
    expect(acquireTickLease(s, { holder: 'h2', ttlMs: 30_000, ...at(T + 29_999) })).toEqual({
      acquired: false,
      holder: 'h1',
      fence: 1,
      until: T + 30_000,
    })
    const h2 = acquired(acquireTickLease(s, { holder: 'h2', ttlMs: 30_000, ...at(T + 30_000) }))
    expect(h2.lease.fence).toBe(2)
    expect(h2.takeover).toBe(true)
    expect(renewTickLease(s, h1, { ttlMs: 30_000, ...at(T + 30_001) })).toBeNull()
    expect(releaseTickLease(s, h1, at(T + 30_001))).toBe(false)
    expect(readTickLease(s)?.holder).toBe('h2')
  })

  it('HT-85 renew and release', () => {
    const s = open(tempPath())
    const h1 = acquired(acquireTickLease(s, { holder: 'h1', ttlMs: 30_000, ...at(T) })).lease
    const renewed = renewTickLease(s, h1, { ttlMs: 30_000, ...at(T + 10_000) })
    expect(renewed).toMatchObject({ fence: 1, until: T + 40_000 })
    const again = acquired(acquireTickLease(s, { holder: 'h1', ttlMs: 30_000, ...at(T + 11_000) }))
    expect(again.lease.fence).toBe(1)
    expect(again.takeover).toBe(false)
    expect(again.lease.until).toBe(T + 41_000)
    expect(releaseTickLease(s, again.lease, at(T + 12_000))).toBe(true)
    expect(readTickLease(s)).toMatchObject({ until: 0, fence: 1 })
    expect(releaseTickLease(s, again.lease, at(T + 13_000))).toBe(false)
    expect(renewTickLease(s, again.lease, { ttlMs: 30_000, ...at(T + 14_000) })).toBeNull()
    const next = acquired(acquireTickLease(s, { holder: 'h1', ttlMs: 30_000, ...at(T + 15_000) }))
    expect(next.lease.fence).toBe(2)
    expect(next.takeover).toBe(false)
  })

  it('HT-86 the clock is read after the lock', () => {
    const clock = { now: T }
    let armed = false
    const s = open(tempPath(), { testHooks: { onBeginImmediate: () => void (armed && (clock.now = T + 5_000)) } })
    // The hook also fires for the constructor's own transactions; arm it only now and rewind the clock.
    armed = true
    clock.now = T
    const r = acquired(acquireTickLease(s, { holder: 'h1', ttlMs: 30_000, now: () => clock.now }))
    expect(r.lease.until).toBe(T + 5_000 + 30_000)
  })

  it('HT-87 a live lease held by another costs the loser no write lock', () => {
    const path = tempPath()
    const a = open(path)
    let begins = 0
    const b = open(path, { testHooks: { onBeginImmediate: () => void begins++ } })
    acquired(acquireTickLease(a, { holder: 'h1', ttlMs: 30_000, ...at(T) }))
    begins = 0
    const r = acquireTickLease(b, { holder: 'h2', ttlMs: 30_000, ...at(T + 1) })
    expect(r.acquired).toBe(false)
    expect(begins).toBe(0)
  })

  it('HT-88 lease writes append no event and emit no wakeup', () => {
    const path = tempPath()
    const s = open(path, { wakeupPath: `${path}.wakeup` })
    const board = new BoardService(s)
    board.postMessage(alice, { channel: 'dev', text: 'warm' })
    const head = s.getHeadIndex()
    const gen = s.getWakeupGeneration()
    const l = acquired(acquireTickLease(s, { holder: 'h1', ttlMs: 30_000, ...at(T) })).lease
    renewTickLease(s, l, { ttlMs: 30_000, ...at(T + 1) })
    releaseTickLease(s, l, at(T + 2))
    expect(s.getHeadIndex()).toBe(head)
    expect(s.getWakeupGeneration()).toBe(gen)
  })

  it('HT-89 validation throws RangeError', () => {
    const s = open(tempPath())
    for (const ttlMs of [999, 300_001, 1_000.5]) {
      expect(() => acquireTickLease(s, { holder: 'h', ttlMs, ...at(T) }), String(ttlMs)).toThrow(RangeError)
    }
    for (const holder of ['', 'a b', 'x'.repeat(201)]) {
      expect(() => acquireTickLease(s, { holder, ttlMs: 30_000, ...at(T) }), holder.slice(0, 5)).toThrow(RangeError)
    }
    expect(() => acquireTickLease(s, { holder: 'h', ttlMs: 30_000, key: 'tick', ...at(T) })).toThrow(RangeError)
    expect(() => readTickLease(s, 'tick')).toThrow(RangeError)
    expect(acquireTickLease(s, { holder: 'a', ttlMs: 1_000, key: 'host.a', ...at(T) }).acquired).toBe(true)
    expect(acquireTickLease(s, { holder: 'b', ttlMs: 300_000, key: 'host.b', ...at(T) }).acquired).toBe(true)
  })

  it('HT-90 a corrupt record counts as absent and the fence is carried when it can be', () => {
    const put = (s: SqliteUnifiedStore, v: string): void => void s.casMeta(TICK_LEASE_KEY, raw(s), v)
    const s1 = open(tempPath())
    put(s1, '{')
    expect(readTickLease(s1)).toBeNull()
    const r1 = acquired(acquireTickLease(s1, { holder: 'h1', ttlMs: 30_000, ...at(T) }))
    expect([r1.lease.fence, r1.corrupt]).toEqual([1, true])

    const s2 = open(tempPath())
    put(s2, '{"v":1,"holder":"","fence":7,"until":0,"at":0}')
    expect(readTickLease(s2)).toBeNull()
    const r2 = acquired(acquireTickLease(s2, { holder: 'h1', ttlMs: 30_000, ...at(T) }))
    expect([r2.lease.fence, r2.corrupt]).toEqual([8, true])

    const s3 = open(tempPath())
    put(s3, '{"v":1,"holder":"x","fence":-3,"until":0,"at":0}')
    const r3 = acquired(acquireTickLease(s3, { holder: 'h1', ttlMs: 30_000, ...at(T) }))
    expect(r3.lease.fence).toBe(1)
  })

  it('HT-91 a refused board refuses acquire and still reads', () => {
    const path = tempPath()
    const s = open(path)
    acquired(acquireTickLease(s, { holder: 'h1', ttlMs: 30_000, ...at(T) }))
    s.db.prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('tasks_schema', '99')").run()
    s.close()
    const r = open(path)
    let err: unknown
    try {
      acquireTickLease(r, { holder: 'h2', ttlMs: 30_000, ...at(T + 60_000) })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BoardError)
    expect([(err as BoardError).status, (err as BoardError).code]).toEqual([503, 'unavailable'])
    expect(readTickLease(r)).toMatchObject({ holder: 'h1', fence: 1 })
  })

  it('HT-95 a lease lost mid-run stops the run, and the new holder sends the rest once', () => {
    const path = tempPath()
    const sA = open(path)
    const sB = open(path)
    const A = new BoardService(sA)
    const B = new BoardService(sB)
    for (const t of ['a', 'b', 'c']) A.createSchedule(alice, { channel: 'dev', text: t, in: '1m' }, T0)
    const clock = { now: T0 + 60_000 }
    const lease: TickLease = acquired(acquireTickLease(sA, { holder: 'A', ttlMs: 10_000, now: () => clock.now })).lease
    let calls = 0
    const shouldContinue = (): boolean => {
      calls += 1
      if (calls === 2) {
        clock.now = T0 + 70_000
        expect(acquireTickLease(sB, { holder: 'B', ttlMs: 10_000, now: () => clock.now })).toMatchObject({
          acquired: true,
          lease: { fence: 2 },
        })
      }
      return renewTickLease(sA, lease, { ttlMs: 10_000, now: () => clock.now }) !== null
    }
    const runA = A.runDueSchedules(clock.now, { shouldContinue })
    expect(runA.sent).toHaveLength(1)
    expect(runA.stopped).toBe(true)
    const runB = B.runDueSchedules(clock.now)
    expect(runB.sent).toHaveLength(2)
    const threads = (sA.db.prepare("SELECT thread FROM board_messages WHERE channel = 'dev' ORDER BY id").all() as Array<{ thread: string }>).map(
      (r) => r.thread,
    )
    expect(threads).toEqual(['board-schedule:1:0', 'board-schedule:2:0', 'board-schedule:3:0'])
  })

  it('HT-100 the tick on a write-floor-too-new file refuses, and the lease still reads', () => {
    const path = tempPath()
    const s = open(path)
    const board = new BoardService(s)
    acquired(acquireTickLease(s, { holder: 'h1', ttlMs: 30_000, ...at(T) }))
    board.createSchedule(alice, { channel: 'dev', text: 'x', in: '1m' }, T0)
    s.db.prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.schema_write_min', '9')").run()
    s.close()
    const r = open(path)
    const b2 = new BoardService(r)
    const head = r.getHeadIndex()
    let err: unknown
    try {
      acquireTickLease(r, { holder: 'h2', ttlMs: 30_000, ...at(T + 60_000) })
    } catch (e) {
      err = e
    }
    expect([(err as BoardError).status, (err as BoardError).code]).toEqual([503, 'schema_too_new'])
    expect(readTickLease(r)?.holder).toBe('h1')
    const run = systemOps(b2, createSystemCaller()).runDueSchedules(T0 + 60_000)
    expect(run.sent).toEqual([])
    expect(run.skipped).toEqual([])
    expect(run.failed).toHaveLength(1)
    expect([run.failed[0]!.error.status, run.failed[0]!.error.code]).toEqual([503, 'schema_too_new'])
    expect(r.getHeadIndex()).toBe(head)
  })
})
