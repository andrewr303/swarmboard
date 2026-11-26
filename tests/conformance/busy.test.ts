// HS-166..HS-169: Mode 1 busy-retry policy (budget/give-up, event-loop lag vs busyTimeoutMs=5000 mutation,
// non-retryable schema floor, abort during busy retry).
import { fork, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, SCHEMA_VERSION, SqliteUnifiedStore } from '../../src/core/public.ts'
import { localIdentity } from '../../src/client/identity.ts'
import { SharedFileTransport } from '../../src/client/transport-file.ts'
import { realHostFor } from './host-stub.ts'
import { head, post, rejection } from './suite/util.ts'

const LOCKER_CHILD = resolve(import.meta.dirname, 'proc', 'locker-child.ts')

const dirs: string[] = []
const transports: SharedFileTransport[] = []
const children: ChildProcess[] = []

function freshDb(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hs-busy-')))
  dirs.push(dir)
  return join(dir, 'board.db')
}

async function holdLock(db: string, holdMs: number): Promise<{ released: Promise<void>; releaseNow: () => void }> {
  const child = fork(LOCKER_CHILD, [JSON.stringify({ db, holdMs })], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(child)
  let resolveReleased!: () => void
  const released = new Promise<void>((r) => {
    resolveReleased = r
  })
  await new Promise<void>((res, rej) => {
    child.on('message', (raw: unknown) => {
      const m = raw as { held?: boolean; released?: boolean }
      if (m?.held) res()
      if (m?.released) resolveReleased()
    })
    child.on('exit', () => resolveReleased())
    child.on('error', rej)
  })
  return {
    released,
    releaseNow: () => {
      if (child.connected) child.send({ release: true })
    },
  }
}

afterEach(async () => {
  while (children.length > 0) {
    const c = children.pop()!
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  }
  while (transports.length > 0) {
    await transports.pop()!.close().catch(() => {})
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('Mode 1 busy policy (HS-166..HS-169)', () => {
  it(
    'HS-166 busyBudgetMs:500 behind 3000ms hold rejects 503 unavailable "storage is busy: try again" retryAfter 1 in [450, 1000]ms; 0 messages; busyGiveUps === 1',
    async () => {
      const db = freshDb()
      const t = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
        host: realHostFor(db),
        busyBudgetMs: 500,
      })
      transports.push(t)
      await t.ready()

      const before = await head(t)
      const lock = await holdLock(db, 3_000)
      const t0 = performance.now()
      const err = await rejection(post(t, 'dev', 'budget-exhausted'))
      const elapsed = performance.now() - t0

      expect(err).toMatchObject({
        status: 503,
        code: 'unavailable',
        message: 'storage is busy: try again',
        retryAfter: 1,
      })
      // With HS-104's pre-sleep check (`elapsed + delay > budgetMs`) and DEFAULT_BUSY_RETRY.capMs = 100,
      // give-up occurs once elapsed + jitterDelay > 500 ms (exact lower bound: 500 - 100 = 400 ms).
      expect(elapsed).toBeGreaterThanOrEqual(400)
      expect(elapsed).toBeLessThanOrEqual(1_000)
      expect(t.stats().busyRetries).toBeGreaterThanOrEqual(1)
      expect(t.stats().busyGiveUps).toBe(1)

      lock.releaseNow()
      await lock.released
      expect(await head(t)).toBe(before)
    },
    30_000,
  )

  it(
    'HS-167 default policy behind 1500ms hold keeps event-loop lag < 400ms (busyRetries >= 1); mutation busyTimeoutMs:5000 spikes lag >= 1400ms',
    async () => {
      const measureHold = async (busyTimeoutMs?: number) => {
        const db = freshDb()
        const t = new SharedFileTransport({
          path: db,
          identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
          host: realHostFor(db),
          ...(busyTimeoutMs !== undefined ? { busyTimeoutMs } : {}),
        })
        transports.push(t)
        await t.ready()

        const lock = await holdLock(db, 1_500)
        let maxLag = 0
        let last = performance.now()
        const timer = setInterval(() => {
          const now = performance.now()
          const lag = Math.max(0, now - last - 10)
          if (lag > maxLag) maxLag = lag
          last = now
        }, 10)
        try {
          const msg = await post(t, 'dev', 'lag-check')
          await lock.released
          return { msg, maxLag, stats: t.stats() }
        } finally {
          clearInterval(timer)
          await t.close()
        }
      }

      const normal = await measureHold()
      expect(normal.msg['text']).toBe('lag-check')
      expect(normal.stats.busyRetries).toBeGreaterThanOrEqual(1)
      expect(normal.maxLag).toBeLessThan(400)

      // Mutation check: synchronous busyTimeoutMs 5000 blocks the event loop for the entire 1500ms hold.
      const mutated = await measureHold(5_000)
      expect(mutated.msg['text']).toBe('lag-check')
      expect(mutated.maxLag).toBeGreaterThanOrEqual(1_400)
    },
    30_000,
  )

  it('HS-168 write floor above SCHEMA_VERSION rejects 503 schema_too_new within 50ms with attempts +1 and busyRetries +0', async () => {
    const db = freshDb()
    const init = new SqliteUnifiedStore({ path: db })
    new BoardService(init)
    init.db
      .prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.schema_write_min', ?)")
      .run(String(SCHEMA_VERSION + 1))
    init.close()

    const t = new SharedFileTransport({
      path: db,
      identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
      host: realHostFor(db),
    })
    transports.push(t)
    await t.ready()

    const before = t.stats()
    const t0 = performance.now()
    const err = await rejection(post(t, 'dev', 'refused'))
    const elapsed = performance.now() - t0
    const after = t.stats()

    expect(err).toMatchObject({ status: 503, code: 'schema_too_new' })
    expect(err.retryAfter).toBeUndefined()
    expect(elapsed).toBeLessThan(50)
    expect(after.attempts - before.attempts).toBe(1)
    expect(after.busyRetries - before.busyRetries).toBe(0)
  })

  it(
    'HS-169 abort at 150ms during 1000ms lock hold rejects with AbortError within 300ms and writes nothing',
    async () => {
      const db = freshDb()
      const t = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
        host: realHostFor(db),
      })
      transports.push(t)
      await t.ready()

      const before = await head(t)
      const lock = await holdLock(db, 1_000)
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 150)

      const t0 = performance.now()
      let thrown: unknown
      try {
        await post(t, 'dev', 'aborted-post', {}, { signal: ac.signal })
      } catch (e) {
        thrown = e
      }
      const elapsed = performance.now() - t0

      expect(thrown).toBe(ac.signal.reason)
      expect((thrown as Error).name).toBe('AbortError')
      expect(elapsed).toBeLessThan(300)

      await lock.released
      expect(await head(t)).toBe(before)
    },
    30_000,
  )
})
