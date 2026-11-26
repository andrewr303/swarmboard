// HOST123_DESIGN Stage B8: Ticker unit and fault-injection tests (HS-136..HS-152).
// Multi-process tests (HS-153..HS-155) live in tests/host/proc/tick.proc.test.ts.
import * as fs from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  type SqliteStoreOptions,
} from '../../src/core/public.ts'
import {
  acquireTickLease,
  createSystemCaller,
  isSystemCaller,
  readTickLease,
  systemOps,
  TICK_LEASE_KEY,
  TICK_LEASE_TTL_MAX_MS,
} from '../../src/core/internal.ts'
import { setBusyTimeout } from '../../src/client/busy.ts'
import {
  mintTickHolder,
  TICK_CLAIM_CHUNK,
  TICK_CLAIMS_PER_RUN,
  TICK_INTERVAL_MS,
  TICK_JITTER,
  TICK_MIN_DELAY_MS,
  TICK_RETRY_DELAY_MS,
  TICK_TTL_MS,
  Ticker,
  type TickErrorSite,
  type TickReport,
} from '../../src/host/tick.ts'
import { stripComments } from '../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0)
const alice = createLocalCaller({ userId: 'alice', handle: 'alice', member: true, owner: true })
const aliceWorker = createLocalCaller({ userId: 'alice', handle: 'alice', profile: 'w1', member: true, owner: true })

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []
const tickers: Ticker[] = []

function tempPath(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cb-tick-')))
  dirs.push(dir)
  return join(dir, 'board.db')
}

function openStore(path: string, extra: Partial<SqliteStoreOptions> = {}): SqliteUnifiedStore {
  const s = new SqliteUnifiedStore({ path, ...extra })
  stores.push(s)
  return s
}

function trackTicker(t: Ticker): Ticker {
  tickers.push(t)
  return t
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const t of tickers.splice(0)) {
    try {
      t.stop()
    } catch {
      // already stopped or store already closed
    }
  }
  for (const s of stores.splice(0)) {
    try {
      s.close()
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

/** Deeply walks a value (own keys, arrays, Maps, Sets, getters) and returns true if any visited value passes `pred`. */
function deepContains(root: unknown, pred: (v: unknown) => boolean): boolean {
  const seen = new Set<unknown>()
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (pred(cur)) return true
    if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function')) continue
    if (seen.has(cur)) continue
    seen.add(cur)
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item)
    } else if (cur instanceof Map) {
      for (const [k, v] of cur) {
        stack.push(k, v)
      }
    } else if (cur instanceof Set) {
      for (const v of cur) stack.push(v)
    }
    for (const key of Reflect.ownKeys(cur)) {
      try {
        stack.push((cur as Record<PropertyKey, unknown>)[key])
      } catch {
        // ignore inaccessible getters
      }
    }
  }
  return false
}

/** Extracts static and dynamic import/export specifiers from comment-stripped TypeScript source. */
function extractImportSpecifiers(source: string): string[] {
  const stripped = stripComments(source)
  const specs: string[] = []
  for (const m of stripped.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    if (m[1]) specs.push(m[1])
  }
  for (const m of stripped.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (m[1]) specs.push(m[1])
  }
  return [...new Set(specs)]
}

describe('Ticker (HOST123_DESIGN Stage B8: HS-136..HS-152)', () => {
  it('HS-136 mintTickHolder format, pid, per-instance uniqueness, and hostname sanitization', () => {
    const h1 = mintTickHolder()
    expect(h1).toMatch(/^[\x21-\x7e]{1,200}$/)
    expect(h1).toMatch(/^[^:]+:\d+:[0-9a-f-]{36}$/)
    const parts = h1.split(':')
    expect(parts).toHaveLength(3)
    expect(parts[1]).toBe(String(process.pid))

    const store = openStore(tempPath())
    const board = new BoardService(store)
    const t1 = trackTicker(new Ticker(board))
    const t2 = trackTicker(new Ticker(board))
    expect(t1.holder).not.toBe(t2.holder)
    expect(t1.holder).toMatch(/^[^:]+:\d+:[0-9a-f-]{36}$/)
    expect(t2.holder).toMatch(/^[^:]+:\d+:[0-9a-f-]{36}$/)

    vi.spyOn(os, 'hostname').mockReturnValue('my host é')
    const sanitized = mintTickHolder()
    expect(sanitized.split(':')[0]).toBe('my_host__')
    expect(sanitized).toMatch(/^[\x21-\x7e]{1,200}$/)
    expect(sanitized).toMatch(/^[^:]+:\d+:[0-9a-f-]{36}$/)

    vi.spyOn(os, 'hostname').mockReturnValue('')
    expect(mintTickHolder().split(':')[0]).toBe('host')

    vi.spyOn(os, 'hostname').mockReturnValue('a'.repeat(80))
    expect(mintTickHolder().split(':')[0]).toBe('a'.repeat(64))

    // Constants match HOST123_DESIGN §3.
    expect(TICK_INTERVAL_MS).toBe(5_000)
    expect(TICK_TTL_MS).toBe(20_000)
    expect(TICK_JITTER).toBe(0.2)
    expect(TICK_MIN_DELAY_MS).toBe(25)
    expect(TICK_RETRY_DELAY_MS).toBe(1_000)
    expect(TICK_CLAIMS_PER_RUN).toBe(200)
    expect(TICK_CLAIM_CHUNK).toBe(25)
  })

  it('HS-137 constructor validates options with RangeError and performs no I/O', () => {
    let begins = 0
    const store = openStore(tempPath(), { testHooks: { onBeginImmediate: () => void begins++ } })
    const board = new BoardService(store)
    begins = 0

    const badOptions: Array<[string, Record<string, unknown>]> = [
      ['intervalMs 49', { intervalMs: 49 }],
      ['intervalMs 600_001', { intervalMs: 600_001 }],
      ['intervalMs 1.5', { intervalMs: 1.5 }],
      ['ttlMs 999', { intervalMs: 50, ttlMs: 999 }],
      ['ttlMs 300_001', { intervalMs: 5_000, ttlMs: 300_001 }],
      ['ttlMs < 2 * intervalMs', { intervalMs: 5_000, ttlMs: 9_999 }],
      ['jitter -0.1', { jitter: -0.1 }],
      ['jitter 0.6', { jitter: 0.6 }],
      ['holder with space', { holder: 'a b' }],
      ['empty holder', { holder: '' }],
      ['claimsPerRun 0', { claimsPerRun: 0 }],
      ['claimChunk 501', { claimChunk: 501 }],
    ]

    for (const [label, opts] of badOptions) {
      expect(() => new Ticker(board, opts as never), label).toThrow(RangeError)
    }

    // Valid edge bounds construct with zero DB write transactions.
    const valid = trackTicker(
      new Ticker(board, {
        intervalMs: 50,
        ttlMs: 1_000,
        jitter: 0,
        claimsPerRun: 1,
        claimChunk: 1,
      }),
    )
    expect(valid.status()).toEqual({
      state: 'idle',
      holder: valid.holder,
      holding: false,
      fence: null,
      runs: 0,
      lastReport: null,
    })
    expect(begins).toBe(0)
  })

  it('HS-138 runOnce sends two due schedules, writes lease, and preserves creator authorship', () => {
    let clock = T0
    const now = () => clock
    const store = openStore(tempPath())
    const board = new BoardService(store, { now })
    board.createChannel(alice, { path: 'dev' })
    board.createSchedule(alice, { channel: 'dev', text: 'first scheduled', in: '1m' }, T0)
    board.createSchedule(alice, { channel: 'dev', text: 'second scheduled', in: '1m' }, T0)

    const ticker = trackTicker(new Ticker(board, { now, ttlMs: 20_000 }))
    clock = T0 + 60_000
    const report = ticker.runOnce()

    expect(Object.isFrozen(report)).toBe(true)
    expect(report).toMatchObject({
      outcome: 'ran',
      at: T0 + 60_000,
      holder: ticker.holder,
      fence: 1,
      takeover: false,
      lost: false,
      clockJump: false,
      skew: false,
    })
    expect(report.schedules).not.toBeNull()
    expect(report.schedules!.sent).toHaveLength(2)
    expect(report.schedules!.skipped).toEqual([])
    expect(report.schedules!.failed).toEqual([])
    expect(report.schedules!.stopped).toBe(false)

    expect(readTickLease(store)).toMatchObject({
      holder: ticker.holder,
      fence: 1,
      until: T0 + 60_000 + 20_000,
    })

    const msgs = board.listChannelMessages(alice, { channel: 'dev', limit: 10 }).messages
    expect(msgs).toHaveLength(2)
    for (const m of msgs) {
      expect(m.by.actor).toBe(alice.actor.id)
      expect(m.by.actor).not.toBe('board:system')
      expect(m.author?.handle).toBe(alice.actor.handle)
      expect(m.author?.handle).not.toBe('system')
    }
  })

  it('HS-139 not_holder pays 0 BEGIN IMMEDIATE, sends nothing, and schedules near lease expiry', () => {
    const path = tempPath()
    const sOther = openStore(path)
    const bOther = new BoardService(sOther, { now: () => T0 + 60_000 })
    bOther.createChannel(alice, { path: 'dev' })
    bOther.createSchedule(alice, { channel: 'dev', text: 'due', in: '1m' }, T0)

    // Another holder holds a lease ending in 1,200 ms.
    const nowMs = T0 + 60_000
    acquireTickLease(sOther, { holder: 'other-host:42:00000000-0000-4000-8000-000000000001', ttlMs: 1_200, now: () => nowMs })

    let begins = 0
    const store = openStore(path, { testHooks: { onBeginImmediate: () => void begins++ } })
    const board = new BoardService(store, { now: () => nowMs })
    begins = 0

    const ticker = trackTicker(new Ticker(board, { intervalMs: 5_000, ttlMs: 20_000, jitter: 0.2, now: () => nowMs }))
    const report = ticker.runOnce()

    expect(begins).toBe(0)
    expect(report).toMatchObject({
      outcome: 'not_holder',
      holder: 'other-host:42:00000000-0000-4000-8000-000000000001',
      fence: 1,
      takeover: false,
      lost: false,
      schedules: null,
      claims: null,
      skew: false,
    })
    expect(report.nextDelayMs).toBeGreaterThanOrEqual(1_200)
    expect(report.nextDelayMs).toBeLessThanOrEqual(1_200 + 0.2 * 5_000)
    expect(board.listChannelMessages(alice, { channel: 'dev', limit: 10 }).messages).toHaveLength(0)
    expect(ticker.status().holding).toBe(false)
  })

  it('HS-140 takeover boundary: until - 1 is not_holder; until takes over with fence + 1', () => {
    const path = tempPath()
    const sOther = openStore(path)
    new BoardService(sOther)
    const acq = acquireTickLease(sOther, { holder: 'other:1:a', ttlMs: 10_000, now: () => T0 })
    expect(acq.acquired).toBe(true)
    const until = T0 + 10_000

    let clock = until - 1
    const store = openStore(path)
    const board = new BoardService(store, { now: () => clock })
    const ticker = trackTicker(new Ticker(board, { intervalMs: 5_000, ttlMs: 20_000, now: () => clock }))

    const r1 = ticker.runOnce()
    expect(r1.outcome).toBe('not_holder')
    expect(r1.holder).toBe('other:1:a')
    expect(r1.fence).toBe(1)

    clock = until
    const r2 = ticker.runOnce()
    expect(r2.outcome).toBe('ran')
    expect(r2.takeover).toBe(true)
    expect(r2.holder).toBe(ticker.holder)
    expect(r2.fence).toBe(2)
  })

  it('HS-141 lease lost mid-run stops sending, skips claims, preserves remaining schedules and takeover record', () => {
    const path = tempPath()
    const nowMs = T0 + 60_000
    const ttlMs = 20_000
    const storeA = openStore(path)
    const boardA = new BoardService(storeA, { now: () => nowMs })
    const storeB = openStore(path)

    boardA.createChannel(alice, { path: 'dev' })
    boardA.createSchedule(alice, { channel: 'dev', text: 's1', in: '1m' }, T0)
    boardA.createSchedule(alice, { channel: 'dev', text: 's2', in: '1m' }, T0)
    boardA.createSchedule(alice, { channel: 'dev', text: 's3', in: '1m' }, T0)

    let tookOver = false
    const unsub = storeA.onEvent((ev) => {
      if (ev.type === 'message.posted' && !tookOver) {
        tookOver = true
        const current = readTickLease(storeB)!
        const taken = acquireTickLease(storeB, {
          holder: 'other:1:x',
          ttlMs,
          now: () => current.until,
        })
        expect(taken.acquired).toBe(true)
      }
    })

    const ticker = trackTicker(new Ticker(boardA, { ttlMs, now: () => nowMs }))
    const report = ticker.runOnce()
    unsub()

    expect(report.outcome).toBe('ran')
    expect(report.lost).toBe(true)
    expect(report.schedules).not.toBeNull()
    expect(report.schedules!.sent).toHaveLength(1)
    expect(report.schedules!.stopped).toBe(true)
    expect(report.claims).toBeNull()
    expect(ticker.status().holding).toBe(false)
    expect(ticker.status().fence).toBeNull()

    const pending = storeA.db
      .prepare("SELECT id, state, next_at FROM board_schedules WHERE state = 'pending' ORDER BY seq")
      .all() as Array<{ id: string; state: string; next_at: number }>
    expect(pending).toHaveLength(2)
    for (const row of pending) {
      expect(Number(row.next_at)).toBe(T0 + 60_000)
    }

    const lease = readTickLease(storeA)
    expect(lease).toMatchObject({ holder: 'other:1:x', fence: 2 })
    expect(lease!.until).toBeGreaterThan(nowMs)
  })

  it('HS-142 renew cadence extends lease every ttl/3 during a long run with bounded casMeta writes', () => {
    const ttlMs = 20_000
    let clock = T0 + 60_000
    let advancing = false
    let clockAtLastSend = clock

    const boardNow = (): number => {
      if (advancing) clock += 4_000
      return clock
    }
    const tickerNow = (): number => clock

    const store = openStore(tempPath())
    const board = new BoardService(store, { now: boardNow })
    board.createChannel(alice, { path: 'dev' })
    for (let i = 0; i < 5; i++) {
      board.createSchedule(alice, { channel: 'dev', text: `sched-${i}`, in: '1m' }, T0)
    }

    store.onEvent((ev) => {
      if (ev.type === 'message.posted') clockAtLastSend = clock
    })

    const casSpy = vi.spyOn(store, 'casMeta')
    const ticker = trackTicker(new Ticker(board, { intervalMs: 5_000, ttlMs, now: tickerNow }))

    const startClock = clock
    advancing = true
    const report = ticker.runOnce()
    advancing = false
    const elapsed = clock - startClock

    expect(report.outcome).toBe('ran')
    expect(report.lost).toBe(false)
    expect(report.schedules!.sent).toHaveLength(5)

    const lease = readTickLease(store)!
    expect(lease.until).toBeGreaterThanOrEqual(clockAtLastSend + ttlMs - Math.floor(ttlMs / 3))

    const maxWrites = 1 + Math.ceil(elapsed / Math.floor(ttlMs / 3))
    expect(casSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(casSpy.mock.calls.length).toBeLessThanOrEqual(maxWrites)
  })

  it('HS-143 stop releases held lease with until=0, allows immediate takeover, writes nothing if lost, and is terminal/idempotent', () => {
    const path = tempPath()
    const nowMs = T0 + 60_000
    const sA = openStore(path)
    const bA = new BoardService(sA, { now: () => nowMs })
    const sB = openStore(path)
    const bB = new BoardService(sB, { now: () => nowMs })

    const tA = trackTicker(new Ticker(bA, { ttlMs: 20_000, now: () => nowMs }))
    const rA = tA.runOnce()
    expect(rA.outcome).toBe('ran')
    expect(rA.fence).toBe(1)
    expect(tA.status().holding).toBe(true)

    tA.stop()
    expect(readTickLease(sA)).toMatchObject({ holder: tA.holder, fence: 1, until: 0 })
    expect(tA.status().state).toBe('stopped')
    expect(tA.status().holding).toBe(false)

    // Second ticker acquires immediately at the same timestamp with fence + 1.
    const tB = trackTicker(new Ticker(bB, { ttlMs: 20_000, now: () => nowMs }))
    const rB = tB.runOnce()
    expect(rB.outcome).toBe('ran')
    expect(rB.fence).toBe(2)

    // Idempotent stop, stopped runOnce, and start-after-stop TypeError.
    expect(() => tA.stop()).not.toThrow()
    const afterStop = tA.runOnce()
    expect(afterStop.outcome).toBe('stopped')
    expect(() => tA.start()).toThrow(TypeError)

    // After a lost lease, stop() writes nothing.
    const path2 = tempPath()
    const s1 = openStore(path2)
    const b1 = new BoardService(s1, { now: () => nowMs })
    const s2 = openStore(path2)
    b1.createChannel(alice, { path: 'dev' })
    b1.createSchedule(alice, { channel: 'dev', text: 'a', in: '1m' }, T0)
    b1.createSchedule(alice, { channel: 'dev', text: 'b', in: '1m' }, T0)
    let stole = false
    s1.onEvent((ev) => {
      if (ev.type === 'message.posted' && !stole) {
        stole = true
        const cur = readTickLease(s2)!
        acquireTickLease(s2, { holder: 'thief:1:z', ttlMs: 20_000, now: () => cur.until })
      }
    })
    const loser = trackTicker(new Ticker(b1, { ttlMs: 20_000, now: () => nowMs }))
    expect(loser.runOnce().lost).toBe(true)
    const casSpy = vi.spyOn(s1, 'casMeta')
    loser.stop()
    expect(casSpy).not.toHaveBeenCalled()
    expect(readTickLease(s1)).toMatchObject({ holder: 'thief:1:z', fence: 2 })
  })

  it('HS-144 refused board: (a) floor raised before open -> 0 BEGIN IMMEDIATE; (b) raised after open -> <=1 then 0', () => {
    // (a) Floor raised on closed file before ticker's store opens.
    {
      const path = tempPath()
      const init = openStore(path)
      new BoardService(init)
      acquireTickLease(init, { holder: 'prev:1:a', ttlMs: 10_000, now: () => T0 })
      const beforeLease = readTickLease(init)
      init.db.prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.schema_write_min', '99')").run()
      init.close()

      let begins = 0
      const store = openStore(path, { testHooks: { onBeginImmediate: () => void begins++ } })
      const board = new BoardService(store, { now: () => T0 + 60_000 })
      begins = 0

      const ticker = trackTicker(new Ticker(board, { now: () => T0 + 60_000 }))
      const r1 = ticker.runOnce()
      expect(r1.outcome).toBe('refused')
      expect(begins).toBe(0)
      expect(readTickLease(store)).toEqual(beforeLease)

      // Also verify against a LIVE foreign lease (T0 + 5s < T0 + 10s): Ticker's writeRefusal() pre-check
      // must return 'refused' (not 'not_holder') with 0 BEGIN IMMEDIATE.
      const liveTicker = trackTicker(new Ticker(board, { now: () => T0 + 5_000 }))
      const rLive = liveTicker.runOnce()
      expect(rLive.outcome).toBe('refused')
      expect(begins).toBe(0)
      expect(readTickLease(store)).toEqual(beforeLease)
    }

    // (b) Floor raised on a second connection after ticker's store opened.
    {
      const path = tempPath()
      let begins = 0
      const store = openStore(path, { testHooks: { onBeginImmediate: () => void begins++ } })
      const board = new BoardService(store, { now: () => T0 + 60_000 })
      const peer = openStore(path)
      acquireTickLease(peer, { holder: 'prev:1:b', ttlMs: 10_000, now: () => T0 })
      const beforeLease = readTickLease(peer)
      peer.db.prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.schema_write_min', '99')").run()

      const ticker = trackTicker(new Ticker(board, { now: () => T0 + 60_000 }))
      begins = 0
      const r1 = ticker.runOnce()
      expect(r1.outcome).toBe('refused')
      expect(begins).toBeLessThanOrEqual(1)
      expect(readTickLease(store)).toEqual(beforeLease)

      begins = 0
      const r2 = ticker.runOnce()
      expect(r2.outcome).toBe('refused')
      expect(begins).toBe(0)
      expect(readTickLease(store)).toEqual(beforeLease)
    }
  })

  it('HS-145 store closed under ticker reports closed and transitions ticker to stopped', () => {
    const errors: Array<{ error: unknown; site: TickErrorSite }> = []
    const store = openStore(tempPath())
    const board = new BoardService(store)
    const ticker = trackTicker(
      new Ticker(board, {
        onError: (error, site) => errors.push({ error, site }),
      }),
    )
    ticker.start()
    store.close()

    const report = ticker.runOnce()
    expect(report.outcome).toBe('closed')
    expect(ticker.status().state).toBe('stopped')
    expect(ticker.status().holding).toBe(false)
    expect(errors).toEqual([])
    expect(ticker.runOnce().outcome).toBe('stopped')
  })

  it('HS-146 busy lock yields outcome busy with jittered retry delay in [800, 1200] and sends after commit', () => {
    const path = tempPath()
    const nowMs = T0 + 60_000
    const storeA = openStore(path)
    const boardA = new BoardService(storeA, { now: () => nowMs })
    boardA.createChannel(alice, { path: 'dev' })
    boardA.createSchedule(alice, { channel: 'dev', text: 'after-busy', in: '1m' }, T0)
    setBusyTimeout(storeA, 0)

    const storeB = openStore(path)
    storeB.db.exec('BEGIN IMMEDIATE')
    const ticker = trackTicker(new Ticker(boardA, { now: () => nowMs }))
    let busyReport: TickReport
    try {
      busyReport = ticker.runOnce()
    } finally {
      storeB.db.exec('COMMIT')
    }

    expect(busyReport.outcome).toBe('busy')
    expect(busyReport.nextDelayMs).toBeGreaterThanOrEqual(800)
    expect(busyReport.nextDelayMs).toBeLessThanOrEqual(1_200)
    expect(boardA.listChannelMessages(alice, { channel: 'dev', limit: 10 }).messages).toHaveLength(0)

    const okReport = ticker.runOnce()
    expect(okReport.outcome).toBe('ran')
    expect(okReport.schedules!.sent).toHaveLength(1)
    expect(boardA.listChannelMessages(alice, { channel: 'dev', limit: 10 }).messages).toHaveLength(1)
  })

  it('HS-147 forward clock step with two tickers hands off cleanly with exactly 3 distinct schedule messages', () => {
    const path = tempPath()
    const ttlMs = 20_000
    let clock = T0 + 60_000
    const now = () => clock

    const sA = openStore(path)
    const bA = new BoardService(sA, { now })
    const sB = openStore(path)
    const bB = new BoardService(sB, { now })

    bA.createChannel(alice, { path: 'dev' })
    bA.createSchedule(alice, { channel: 'dev', text: 'one', in: '1m' }, T0)
    bA.createSchedule(alice, { channel: 'dev', text: 'two', in: '1m' }, T0)
    bA.createSchedule(alice, { channel: 'dev', text: 'three', in: '1m' }, T0)

    const tA = trackTicker(new Ticker(bA, { ttlMs, now }))
    const tB = trackTicker(new Ticker(bB, { ttlMs, now }))

    let rB: TickReport | null = null
    sA.onEvent((ev) => {
      if (ev.type === 'message.posted' && rB === null) {
        clock += ttlMs + 1
        rB = tB.runOnce()
      }
    })

    const rA = tA.runOnce()
    expect(rA.outcome).toBe('ran')
    expect(rA.lost).toBe(true)
    expect(rA.schedules!.sent).toHaveLength(1)
    expect(rA.schedules!.stopped).toBe(true)

    expect(rB).not.toBeNull()
    expect(rB!.outcome).toBe('ran')
    expect(rB!.takeover).toBe(true)
    expect(rB!.fence).toBe(2)
    expect(rB!.schedules!.sent).toHaveLength(2)

    const threads = (
      sA.db.prepare("SELECT thread FROM board_messages WHERE channel = 'dev' ORDER BY id").all() as Array<{ thread: string }>
    ).map((r) => r.thread)
    expect(threads).toEqual(['board-schedule:1:0', 'board-schedule:2:0', 'board-schedule:3:0'])

    const schedRows = sA.db.prepare('SELECT data FROM board_schedules ORDER BY seq').all() as Array<{ data: string }>
    expect(schedRows).toHaveLength(3)
    for (const r of schedRows) {
      expect((JSON.parse(r.data) as { sent: number }).sent).toBe(1)
    }
  })

  it('HS-148 backward clock step (skew > TTL_MAX + 1000) reports skew and calls onError(skew) once over 3 runs', () => {
    const path = tempPath()
    const sOther = openStore(path)
    new BoardService(sOther)
    // Write a valid lease record whose until = T0 + 400_000 (> TICK_LEASE_TTL_MAX_MS + 1000).
    const until = T0 + 400_000
    expect(until - T0).toBeGreaterThan(TICK_LEASE_TTL_MAX_MS + 1_000)
    const raw = JSON.stringify({ v: 1, holder: 'skewed:1:a', fence: 1, until, at: T0 })
    expect(sOther.casMeta(TICK_LEASE_KEY, undefined, raw)).toBe(true)

    const store = openStore(path)
    const board = new BoardService(store, { now: () => T0 })
    const skewErrors: Array<{ error: unknown; site: TickErrorSite }> = []
    const ticker = trackTicker(
      new Ticker(board, {
        now: () => T0,
        onError: (error, site) => skewErrors.push({ error, site }),
      }),
    )

    for (let i = 0; i < 3; i++) {
      const r = ticker.runOnce()
      expect(r.outcome).toBe('not_holder')
      expect(r.skew).toBe(true)
    }
    expect(skewErrors.filter((e) => e.site === 'skew')).toHaveLength(1)
  })

  it('HS-149 sleep catch-up coalesces missed hourly periods, flags clockJump, and advances next_at to next boundary', () => {
    let clock = T0
    const now = () => clock
    const store = openStore(tempPath())
    const board = new BoardService(store, { now })
    board.createChannel(alice, { path: 'dev' })
    board.createSchedule(alice, { channel: 'dev', text: 'hourly', in: '1h', every: '1h' }, T0)

    const ticker = trackTicker(new Ticker(board, { intervalMs: 5_000, ttlMs: 20_000, now }))
    const r0 = ticker.runOnce()
    expect(r0.outcome).toBe('ran')
    expect(r0.clockJump).toBe(false)
    expect(r0.schedules!.sent).toHaveLength(0)

    // Jump 3 hours ahead (missed T0+1h, T0+2h, T0+3h).
    clock = T0 + 3 * 3_600_000
    const r1 = ticker.runOnce()
    expect(r1.outcome).toBe('ran')
    expect(r1.clockJump).toBe(true)
    expect(r1.schedules!.sent).toHaveLength(1)

    const row = store.db.prepare('SELECT next_at FROM board_schedules WHERE seq = 1').get() as { next_at: number }
    expect(Number(row.next_at)).toBe(T0 + 4 * 3_600_000)
  })

  it('HS-150 planning: exact next schedule delay, interval clamp, claim backlog drain, and anti-hot-loop', () => {
    // (a) Next schedule due in 1,200 ms -> nextDelayMs === 1200; due in 60 s -> 5000.
    {
      let clock = T0
      const store = openStore(tempPath())
      const board = new BoardService(store, { now: () => clock })
      board.createChannel(alice, { path: 'dev' })
      board.createSchedule(alice, { channel: 'dev', text: 'far', at: new Date(T0 + 60_000).toISOString() }, T0)

      const ticker = trackTicker(new Ticker(board, { intervalMs: 5_000, ttlMs: 20_000, now: () => clock }))
      expect(ticker.runOnce().nextDelayMs).toBe(5_000)

      board.createSchedule(alice, { channel: 'dev', text: 'near', at: new Date(T0 + 1_200).toISOString() }, T0)
      expect(ticker.runOnce().nextDelayMs).toBe(1_200)
      clock = T0 + 1_200
      const sent = ticker.runOnce()
      expect(sent.schedules!.sent).toHaveLength(1)
      expect(sent.nextDelayMs).toBe(5_000)
    }

    // (b) claimsPerRun: 2 with 5 lapsed claims -> backlog: true, nextDelayMs: 25, then 2 more runs expire the rest.
    {
      let clock = T0
      const store = openStore(tempPath())
      const board = new BoardService(store, { now: () => clock })
      board.createChannel(alice, { path: 'work' })
      for (let i = 0; i < 5; i++) {
        board.tasks.createTask(alice, { channel: 'work', text: `task-${i}`, claim: true, lease: 30 })
      }
      clock = T0 + 30_000

      const ticker = trackTicker(new Ticker(board, { intervalMs: 5_000, ttlMs: 20_000, claimsPerRun: 2, now: () => clock }))
      const r1 = ticker.runOnce()
      expect(r1.claims).not.toBeNull()
      expect(r1.claims!.expired).toHaveLength(2)
      expect(r1.claims!.backlog).toBe(true)
      expect(r1.nextDelayMs).toBe(25)

      const r2 = ticker.runOnce()
      expect(r2.claims!.expired).toHaveLength(2)
      expect(r2.claims!.backlog).toBe(true)
      expect(r2.nextDelayMs).toBe(25)

      const r3 = ticker.runOnce()
      expect(r3.claims!.expired).toHaveLength(1)
      expect(r3.claims!.backlog).toBe(false)
      expect(r3.nextDelayMs).toBe(5_000)

      const stillClaimed = (
        store.db.prepare("SELECT COUNT(*) AS n FROM board_tasks WHERE state = 'claimed'").get() as { n: number }
      ).n
      expect(stillClaimed).toBe(0)
    }

    // (c) Anti-hot-loop: board clock 10 min behind ticker clock -> over 10 intervals at most 11 runs.
    {
      vi.useFakeTimers()
      vi.setSystemTime(T0 + 10 * 60_000)
      const boardClock = () => T0
      const tickerClock = () => Date.now()

      const store = openStore(tempPath())
      const board = new BoardService(store, { now: boardClock })
      board.createChannel(alice, { path: 'dev' })
      // Due at T0 + 60s: overdue by tickerClock (T0 + 10m), not due by boardClock (T0).
      board.createSchedule(alice, { channel: 'dev', text: 'overdue-for-ticker', in: '1m' }, T0)

      const reports: TickReport[] = []
      const ticker = trackTicker(
        new Ticker(board, {
          intervalMs: 5_000,
          ttlMs: 20_000,
          now: tickerClock,
          random: () => 0,
          onReport: (r) => reports.push(r),
        }),
      )
      ticker.start()
      // Advance 10 full intervals (50,000 ms).
      vi.advanceTimersByTime(10 * 5_000)

      expect(reports.length).toBeGreaterThanOrEqual(10)
      expect(reports.length).toBeLessThanOrEqual(11)
      for (const r of reports) {
        expect(r.outcome).toBe('ran')
        expect(r.nextDelayMs).toBe(5_000)
      }
      ticker.stop()
    }
  })

  it('HS-151 security: system caller confined in #ops, no text/profile in reports, no internal re-exports, import boundary clean', async () => {
    let clock = T0
    const store = openStore(tempPath())
    const board = new BoardService(store, { now: () => clock })
    board.createChannel(aliceWorker, { path: 'dev' })
    board.createSchedule(aliceWorker, { channel: 'dev', text: 'SECRET-MESSAGE-BODY', in: '1m' }, T0)

    const seenReports: TickReport[] = []
    const ticker = trackTicker(
      new Ticker(board, {
        now: () => clock,
        onReport: (r) => seenReports.push(r),
      }),
    )

    clock = T0 + 60_000
    seenReports.push(ticker.runOnce())
    const status = ticker.status()

    // Reflect.ownKeys(ticker), status(), and every report never expose a SystemCaller.
    expect(Reflect.ownKeys(ticker)).toEqual(['holder'])
    expect(deepContains(ticker, isSystemCaller)).toBe(false)
    expect(deepContains(status, isSystemCaller)).toBe(false)
    for (const r of seenReports) {
      expect(deepContains(r, isSystemCaller)).toBe(false)
      const json = JSON.stringify(r)
      expect(json).not.toContain('"text"')
      expect(json).not.toContain('"profile"')
      expect(json).not.toContain('SECRET-MESSAGE-BODY')
    }

    // tick.ts exports neither createSystemCaller nor systemOps (nor any internal.ts value).
    const tickMod = await import('../../src/host/tick.ts')
    const exportedValues = Object.values(tickMod)
    expect(exportedValues).not.toContain(createSystemCaller)
    expect(exportedValues).not.toContain(systemOps)
    expect(Object.keys(tickMod)).not.toContain('createSystemCaller')
    expect(Object.keys(tickMod)).not.toContain('systemOps')

    // Source scan: tick.ts imports from src/core only public.ts and internal.ts (plus ../client/busy.ts and node:*).
    const tickSrc = fs.readFileSync(join(ROOT, 'src/host/tick.ts'), 'utf8')
    const tickImports = extractImportSpecifiers(tickSrc)
    expect(tickImports.length).toBeGreaterThan(0)
    for (const spec of tickImports) {
      if (spec.includes('/core/')) {
        expect(['../core/public.ts', '../core/internal.ts']).toContain(spec)
      } else if (spec.includes('/client/')) {
        expect(spec).toBe('../client/busy.ts')
      } else {
        expect(['node:os', 'node:crypto']).toContain(spec)
      }
    }

    // Source scan: wake-bridge.ts (when present) imports from src/core only public.ts (plus ../client/busy.ts and node:*).
    const bridgePath = join(ROOT, 'src/host/wake-bridge.ts')
    if (fs.existsSync(bridgePath)) {
      const bridgeSrc = fs.readFileSync(bridgePath, 'utf8')
      const bridgeImports = extractImportSpecifiers(bridgeSrc)
      for (const spec of bridgeImports) {
        if (spec.includes('/core/')) {
          expect(spec).toBe('../core/public.ts')
        } else if (spec.includes('/client/')) {
          expect(spec).toBe('../client/busy.ts')
        } else {
          expect(spec.startsWith('node:')).toBe(true)
        }
      }
    }
  })

  it('HS-152 poke wakes a sleeping holder so a newly scheduled message due in 100 ms sends by 100 + 25 + 50 ms', () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)

    const path = tempPath()
    const storeA = openStore(path)
    const boardA = new BoardService(storeA, { now: () => Date.now() })
    boardA.createChannel(alice, { path: 'dev' })

    const ticker = trackTicker(
      new Ticker(boardA, {
        intervalMs: 5_000,
        ttlMs: 20_000,
        now: () => Date.now(),
        random: () => 0,
      }),
    )
    ticker.start()
    // Run the initial tick at t=0 so ticker holds the lease and arms a 5 s sleep.
    vi.advanceTimersByTime(10)
    expect(ticker.status().holding).toBe(true)
    expect(ticker.status().lastReport?.nextDelayMs).toBe(5_000)

    // Case 1: same-store schedule.created commit due in 100 ms wakes the holder via store.onEvent -> poke().
    boardA.createSchedule(alice, { channel: 'dev', text: 'poked-same', at: new Date(Date.now() + 100).toISOString() }, Date.now())
    vi.advanceTimersByTime(100 + 25 + 50)
    expect(boardA.listChannelMessages(alice, { channel: 'dev', limit: 10 }).messages.map((m) => m.text)).toEqual(['poked-same'])

    // Case 2: foreign connection commit delivered through external dispatch (simulating WakeBridge) wakes holder too.
    storeA.armExternalDispatch()
    const storeB = openStore(path)
    const boardB = new BoardService(storeB, { now: () => Date.now() })
    boardB.createSchedule(alice, { channel: 'dev', text: 'poked-foreign', at: new Date(Date.now() + 100).toISOString() }, Date.now())
    storeA.pumpExternal()
    vi.advanceTimersByTime(100 + 25 + 50)
    expect(boardA.listChannelMessages(alice, { channel: 'dev', limit: 10 }).messages.map((m) => m.text)).toEqual([
      'poked-same',
      'poked-foreign',
    ])

    ticker.stop()
  })

  it('defensive cases: reentrant runOnce, TypeError inside transaction, and throwing hooks isolated', () => {
    let clock = T0 + 60_000
    const store = openStore(tempPath())
    const board = new BoardService(store, { now: () => clock })
    board.createChannel(alice, { path: 'dev' })
    board.createSchedule(alice, { channel: 'dev', text: 'reenter', in: '1m' }, T0)

    const errors: Array<{ error: unknown; site: TickErrorSite }> = []
    let reentrantReport: TickReport | null = null
    const ticker = trackTicker(
      new Ticker(board, {
        now: () => clock,
        onReport: () => {
          throw new Error('report-boom')
        },
        onError: (e, site) => {
          errors.push({ error: e, site })
          if (site === 'report') throw new Error('onerror-boom')
        },
      }),
    )

    // Inside a transaction -> TypeError.
    expect(() => store.transaction(() => ticker.runOnce())).toThrow(TypeError)

    // Reentrant runOnce from an onEvent listener -> outcome 'reentrant'.
    store.onEvent((ev) => {
      if (ev.type === 'message.posted' && reentrantReport === null) {
        reentrantReport = ticker.runOnce()
      }
    })

    const report = ticker.runOnce()
    expect(report.outcome).toBe('ran')
    expect(reentrantReport).not.toBeNull()
    expect(reentrantReport!.outcome).toBe('reentrant')
    expect(errors.map((e) => e.site)).toEqual(['report'])
    expect(ticker.status().runs).toBe(1)

    // start() is idempotent when already running.
    ticker.start()
    expect(() => ticker.start()).not.toThrow()
    ticker.stop()
  })
})
