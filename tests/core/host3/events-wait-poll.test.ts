// HOST123_DESIGN Stage B6 (HS-99, HS-100): BoardServiceOptions.eventsWaitPollMs.
// Validates constructor bounds (RangeError before seeding, 0 BEGIN IMMEDIATE on invalid values)
// and verifies cross-connection getEvents wait polling latency at default, 1500 ms, and 1000 ms.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../../src/core/public.ts'

const owner = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function openStore(path: string, onBeginImmediate?: () => void): SqliteUnifiedStore {
  const store = new SqliteUnifiedStore({
    path,
    ...(onBeginImmediate ? { testHooks: { onBeginImmediate } } : {}),
  })
  stores.push(store)
  return store
}

function tempDb(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cb-ewp-'))
  dirs.push(dir)
  return join(dir, 'board.db')
}

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close()
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('BoardServiceOptions.eventsWaitPollMs (HS-99, HS-100)', () => {
  it('HS-99 rejects out-of-range and non-integer values with RangeError before seeding (0 BEGIN IMMEDIATE)', () => {
    const invalid: unknown[] = [9, 60_001, 1.5, Number.NaN, '100', 0, -10, Number.POSITIVE_INFINITY, null]
    for (const bad of invalid) {
      let begins = 0
      const store = openStore(':memory:', () => {
        begins += 1
      })
      // Reset after openSchema/migrations so we count only what new BoardService() attempts.
      begins = 0
      expect(
        () => new BoardService(store, { eventsWaitPollMs: bad as number }),
        `eventsWaitPollMs=${String(bad)}`,
      ).toThrow(RangeError)
      expect(begins, `0 BEGIN IMMEDIATE for eventsWaitPollMs=${String(bad)}`).toBe(0)
      const grantCount = (store.db.prepare('SELECT COUNT(*) AS n FROM board_grants').get() as { n: number }).n
      expect(grantCount, `no seedDefaults for eventsWaitPollMs=${String(bad)}`).toBe(0)
    }

    // Valid boundaries: 10, 60_000, undefined (default 100), omitted.
    for (const valid of [10, 60_000, undefined] as const) {
      const store = openStore(':memory:')
      const opts = valid === undefined ? { eventsWaitPollMs: undefined } : { eventsWaitPollMs: valid }
      const board = new BoardService(store, opts)
      expect(board.listGrants(owner).length).toBeGreaterThan(0)
    }
    const defaultBoard = new BoardService(openStore(':memory:'))
    expect(defaultBoard.listGrants(owner).length).toBeGreaterThan(0)
  })

  it('HS-100 default 100 ms wakes within 250 ms; 1500 ms waits in [1000, 2500] ms; 1000 ms across 5 random phases', async () => {
    const path = tempDb()
    const storeA = openStore(path)
    const storeB = openStore(path)
    const boardDefault = new BoardService(storeA)
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })

    // 1. Default (100 ms): B posts 30 ms into A's wait; A resolves within 250 ms of B's post.
    {
      const head = String(storeA.getHeadIndex())
      const waitP = boardDefault.getEvents(owner, { after: head, wait: 5 })
      await new Promise((r) => setTimeout(r, 30))
      const postedAt = performance.now()
      const posted = boardB.postMessage(owner, { channel: 'dev', text: 'default-poll' })
      const page = await waitP
      const lagMs = performance.now() - postedAt
      expect(page.events.some((e) => e.type === 'message.posted' && e.message?.id === posted.message.id)).toBe(true)
      expect(lagMs).toBeLessThanOrEqual(250)
    }

    // 2. eventsWaitPollMs: 1500: B posts 50 ms into A's wait; A resolves in [1000, 2500] ms after B's post.
    {
      const boardSlow = new BoardService(storeA, { eventsWaitPollMs: 1500 })
      const head = String(storeA.getHeadIndex())
      const waitP = boardSlow.getEvents(owner, { after: head, wait: 5 })
      await new Promise((r) => setTimeout(r, 50))
      const postedAt = performance.now()
      const posted = boardB.postMessage(owner, { channel: 'dev', text: 'slow-1500' })
      const page = await waitP
      const lagMs = performance.now() - postedAt
      expect(page.events.some((e) => e.type === 'message.posted' && e.message?.id === posted.message.id)).toBe(true)
      expect(lagMs).toBeGreaterThanOrEqual(1000)
      expect(lagMs).toBeLessThanOrEqual(2500)
    }

    // 3. eventsWaitPollMs: 1000 across 5 posts at random phases spanning the interval:
    //    each resolves in [0, 1300] ms after its post and at least one later than 250 ms.
    {
      const board1000 = new BoardService(storeA, { eventsWaitPollMs: 1000 })
      const lags: number[] = []
      // Stratified random phases in 5 buckets covering [50, 950) ms so phases are randomized yet
      // deterministically include early phases (guaranteed > 250 ms until the 1000 ms poll tick).
      const buckets: readonly [number, number][] = [
        [50, 200],
        [200, 380],
        [380, 560],
        [560, 740],
        [740, 920],
      ]
      for (let i = 0; i < buckets.length; i++) {
        const [lo, hi] = buckets[i]!
        const phaseMs = lo + Math.floor(Math.random() * (hi - lo))
        const head = String(storeA.getHeadIndex())
        const waitP = board1000.getEvents(owner, { after: head, wait: 5 })
        await new Promise((r) => setTimeout(r, phaseMs))
        const postedAt = performance.now()
        const posted = boardB.postMessage(owner, { channel: 'dev', text: `phase-${i}` })
        const page = await waitP
        const lagMs = performance.now() - postedAt
        expect(page.events.some((e) => e.type === 'message.posted' && e.message?.id === posted.message.id)).toBe(true)
        expect(lagMs).toBeGreaterThanOrEqual(0)
        expect(lagMs).toBeLessThanOrEqual(1300)
        lags.push(lagMs)
      }
      expect(lags.some((ms) => ms > 250)).toBe(true)
    }
  }, 30_000)
})
