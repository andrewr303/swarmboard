// HS-156..HS-162: SharedFileTransport open, process registry, ref-counting, first-open race, close, FileHost order,
// pre-ready unknown op refusal.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOARD_ID_PATTERN,
  BoardService,
  INSTANCE_ID_PATTERN,
  SCHEMA_VERSION,
  SqliteUnifiedStore,
} from '../../src/core/public.ts'
import { isStoreClosedError, LONG_LIVED_BUSY_TIMEOUT_MS } from '../../src/client/busy.ts'
import { isBoardError } from '../../src/client/errors.ts'
import { localIdentity } from '../../src/client/identity.ts'
import { openedBoards, SharedFileTransport } from '../../src/client/transport-file.ts'
import { ada } from './fixtures.ts'
import { createRecordingFileHost, spawnPeerChild } from './host-stub.ts'
import { call, events, post, rejection, sleep } from './suite/util.ts'

const dirs: string[] = []
const transports: SharedFileTransport[] = []

function freshDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hs-sft-open-')))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (transports.length > 0) {
    await transports.pop()!.close().catch(() => {})
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('SharedFileTransport open, registry and lifecycle (HS-156..HS-162)', () => {
  it('HS-156 constructor touches no file; pre-ready capabilities have null ids & schemaVersion 0; ready() creates db & populates capabilities', async () => {
    const dir = freshDir()
    const db = join(dir, 'board.db')

    expect(() => new SharedFileTransport({ path: ':memory:', identity: ada() })).toThrow(TypeError)
    expect(() => new SharedFileTransport({ path: 'relative/board.db', identity: ada() })).toThrow(TypeError)

    const t = new SharedFileTransport({ path: db, identity: ada() })
    transports.push(t)

    expect(fs.existsSync(db)).toBe(false)
    expect(Object.isFrozen(t.capabilities)).toBe(true)
    expect(t.capabilities.boardId).toBeNull()
    expect(t.capabilities.instanceId).toBeNull()
    expect(t.capabilities.schemaVersion).toBe(0)

    const caps = await t.ready()
    expect(fs.existsSync(db)).toBe(true)
    expect(Object.isFrozen(caps)).toBe(true)
    expect(caps).toMatchObject({
      mode: 'shared-file',
      transport: 'direct',
      schemaVersion: SCHEMA_VERSION,
      maxWaitS: 300,
      leaseCapS: 3600,
      batchMax: 100,
      crossProcessWake: true,
      wake: 'poll',
      schedules: 'none',
    })
    expect(caps.boardId).toMatch(BOARD_ID_PATTERN)
    expect(caps.instanceId).toMatch(INSTANCE_ID_PATTERN)
    expect(t.capabilities).toBe(caps)
  })

  it('HS-157 two path spellings share one store (refs 2), in-process listener wakes <50ms, close decrements & closes store at 0', async () => {
    const dir = freshDir()
    const dbA = join(dir, 'board.db')
    const dbB = join(dir, '.', 'board.db')

    let openedStore: SqliteUnifiedStore | null = null
    const stub = createRecordingFileHost()
    const origOpen = stub.host.open
    const capturingHost = {
      ...stub.host,
      open(path: string, opts?: Parameters<typeof origOpen>[1]) {
        const res = origOpen(path, opts)
        openedStore = res.store
        return res
      },
    }

    const a = new SharedFileTransport({ path: dbA, identity: ada(), host: capturingHost })
    const b = new SharedFileTransport({ path: dbB, identity: ada() })
    transports.push(a, b)

    await a.ready()
    await b.ready()

    const key = join(dir, 'board.db')
    const mine = openedBoards().filter((e) => e.key === key)
    expect(mine).toEqual([{ key, refs: 2, state: 'open' }])
    expect(openedStore).not.toBeNull()

    const waiting = events(b, { wait: 5 })
    await sleep(15)
    const t0 = performance.now()
    const posted = await post(a, 'dev', 'inproc-wake')
    const page = await waiting
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(50)
    expect(page.events.some((e) => String(e.message?.id) === String(posted['id']))).toBe(true)

    await a.close()
    expect(openedBoards().filter((e) => e.key === key)).toEqual([{ key, refs: 1, state: 'open' }])
    expect((await call(b, 'me', {}))['actor']).toBe('local:user:ada')

    await b.close()
    expect(openedBoards().filter((e) => e.key === key)).toEqual([])
    try {
      void openedStore!.db
      expect.unreachable('expected closed store error')
    } catch (e) {
      expect(isStoreClosedError(e)).toBe(true)
    }
  })

  it('HS-158 BEGIN IMMEDIATE count: fresh ready() = SCHEMA_VERSION + 1 (ladder + 1 seed); seeded ready() + me + read = 0', async () => {
    const dir = freshDir()
    const db = join(dir, 'board.db')

    let freshBegins = 0
    const t1 = new SharedFileTransport({
      path: db,
      identity: ada(),
      testStoreOptions: { testHooks: { onBeginImmediate: () => void (freshBegins += 1) } },
    })
    transports.push(t1)
    await t1.ready()
    expect(freshBegins).toBe(SCHEMA_VERSION + 1)
    await t1.close()

    let seededBegins = 0
    const t2 = new SharedFileTransport({
      path: db,
      identity: ada(),
      testStoreOptions: { testHooks: { onBeginImmediate: () => void (seededBegins += 1) } },
    })
    transports.push(t2)
    await t2.ready()
    await call(t2, 'me', {})
    await call(t2, 'channelMessages', { channel: 'dev' })
    expect(seededBegins).toBe(0)
  })

  it('HS-160 close() is idempotent, later call rejects 503 "this transport is closed", pending wait resolves <100ms, events() exits cleanly', async () => {
    const dir = freshDir()
    const db = join(dir, 'board.db')
    const t = new SharedFileTransport({ path: db, identity: ada() })
    transports.push(t)
    await t.ready()

    const pendingWait = events(t, { wait: 30 })
    const feedDone = (async () => {
      let count = 0
      for await (const _ of t.events({})) count += 1
      return count
    })()
    await sleep(30)

    const t0 = performance.now()
    const closing = t.close()
    const page = await pendingWait
    expect(performance.now() - t0).toBeLessThan(100)
    expect(page.events).toEqual([])
    expect(page.cursor).toBeTypeOf('string')
    await expect(feedDone).resolves.toBeTypeOf('number')
    await closing

    await expect(t.close()).resolves.toBeUndefined()
    expect(t.closed).toBe(true)

    const err = await rejection(call(t, 'me', {}))
    expect(err).toMatchObject({ status: 503, code: 'unavailable', message: 'this transport is closed' })
    expect(err.retryAfter).toBeUndefined()
  })

  it('HS-161 recording FileHost order (open -> attach -> BoardService(serviceOptions) -> bindBoard), attachment.close() before store.close(), bare uses {}, busy_timeout=50', async () => {
    const dir = freshDir()
    const db = join(dir, 'board.db')
    const rec = createRecordingFileHost({ closeDelayMs: 25 })

    // Spy on BoardService.prototype.boardInfo to verify the exact board instance bound in bindBoard
    const seenBoards: BoardService[] = []
    const origMe = BoardService.prototype.me
    vi.spyOn(BoardService.prototype, 'me').mockImplementation(function (this: BoardService, caller) {
      seenBoards.push(this)
      return origMe.call(this, caller)
    })

    const t = new SharedFileTransport({ path: db, identity: ada(), host: rec.host })
    transports.push(t)
    await t.ready()

    expect(rec.events).toEqual([`open:${db}`, 'attach', 'serviceOptions', 'bindBoard'])
    expect(rec.boards).toHaveLength(1)
    await call(t, 'me', {})
    expect(seenBoards[0]).toBe(rec.boards[0])

    // Verify BoardService received the exact serviceOptions object from attachment.serviceOptions()
    const svcOpts = rec.serviceOptionsReturned[0]!
    expect(t.capabilities.wakePollMs).toBe(svcOpts.eventsWaitPollMs)
    // Verify busy_timeout === 50 on the opened connection
    const store = rec.stores[0]!
    const timeoutRow = store.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(timeoutRow.timeout).toBe(LONG_LIVED_BUSY_TIMEOUT_MS)

    await t.close()
    // attachment.close:done MUST precede store.close (proves await completed before store.close)
    const idxAttachDone = rec.events.indexOf('attachment.close:done')
    const idxStoreClose = rec.events.indexOf('store.close')
    expect(idxAttachDone).toBeGreaterThan(-1)
    expect(idxStoreClose).toBeGreaterThan(idxAttachDone)

    // Without FileHost: bare mode builds service with {} (wake 'poll', wakePollMs 100) and still sets busy_timeout 50
    const bareDir = freshDir()
    const bareDb = join(bareDir, 'board.db')
    const bare = new SharedFileTransport({
      path: bareDb,
      identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
    })
    transports.push(bare)
    const bareCaps = await bare.ready()
    expect(bareCaps.wake).toBe('poll')
    expect(bareCaps.wakePollMs).toBe(100)
    expect(bareCaps.schedules).toBe('none')
    await bare.close()
  })

  it('HS-162 call("nope", {}) rejects 501 not_supported before ready() opens anything', async () => {
    const dir = freshDir()
    const db = join(dir, 'never-opened.db')
    const t = new SharedFileTransport({ path: db, identity: ada() })
    transports.push(t)

    try {
      await call(t, 'nope', {})
      expect.unreachable('expected 501 not_supported')
    } catch (e) {
      expect(isBoardError(e)).toBe(true)
      if (isBoardError(e)) {
        expect(e.status).toBe(501)
        expect(e.code).toBe('not_supported')
      }
    }
    expect(fs.existsSync(db)).toBe(false)
    expect(openedBoards().some((b) => b.key.endsWith('never-opened.db'))).toBe(false)
  })

  it('HS-157 / B9-F2 concurrent ready() sibling succeeds when opener closes mid-busy-retry; closing sole opener aborts & leaks nothing', async () => {
    // (a) Opener tA closes mid-busy-retry while sibling tB awaits the shared open -> tB succeeds cleanly.
    {
      const dir = freshDir()
      const db = join(dir, 'board.db')
      const base = createRecordingFileHost()
      let attempts = 0
      let resolveSecondAttempt!: () => void
      const secondAttemptReached = new Promise<void>((r) => {
        resolveSecondAttempt = r
      })

      const busyOnceHost = {
        ...base.host,
        open(path: string, storeOpts?: Parameters<typeof base.host.open>[1]) {
          attempts += 1
          if (attempts <= 3) {
            if (attempts === 2) resolveSecondAttempt()
            throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
          }
          return base.host.open(path, storeOpts)
        },
      }

      const tA = new SharedFileTransport({ path: db, identity: ada(), host: busyOnceHost })
      const tB = new SharedFileTransport({ path: db, identity: ada(), host: busyOnceHost })
      transports.push(tA, tB)

      const readyA = tA.ready()
      const readyB = tB.ready()
      await secondAttemptReached
      await tA.close()

      const errA = await rejection(readyA)
      expect(errA).toMatchObject({ status: 503, code: 'unavailable', message: 'this transport is closed' })

      const capsB = await readyB
      expect(capsB.boardId).toMatch(BOARD_ID_PATTERN)
      expect((await call(tB, 'me', {}))['actor']).toBe('local:user:ada')
      expect(openedBoards().filter((b) => b.key === db)).toEqual([{ key: db, refs: 1, state: 'open' }])
      await tB.close()
      expect(openedBoards().filter((b) => b.key === db)).toEqual([])
    }

    // (b) Sole opener closing mid-busy-retry aborts the shared open cleanly and leaves registry empty.
    {
      const dir = freshDir()
      const db = join(dir, 'sole.db')
      const base = createRecordingFileHost()
      let attempts = 0
      const alwaysBusyHost = {
        ...base.host,
        open() {
          attempts += 1
          throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
        },
      }
      const sole = new SharedFileTransport({ path: db, identity: ada(), host: alwaysBusyHost })
      transports.push(sole)
      const p = sole.ready()
      await sleep(20)
      await sole.close()
      expect(await rejection(p)).toMatchObject({ status: 503, code: 'unavailable', message: 'this transport is closed' })
      expect(attempts).toBeGreaterThanOrEqual(1)
      expect(openedBoards().filter((b) => b.key === db)).toEqual([])
    }
  })

  it('HS-160 / B9-F3 concurrent close() calls all await full write drain, attachment.close(), and store.close()', async () => {
    const dir = freshDir()
    const db = join(dir, 'board.db')
    const rec = createRecordingFileHost({ closeDelayMs: 80 })
    const t = new SharedFileTransport({ path: db, identity: ada(), host: rec.host })
    transports.push(t)
    await t.ready()

    const t0 = performance.now()
    let c2Elapsed = 0
    let c2SawStoreClose = false
    const c1 = t.close()
    const c2 = t.close().then(() => {
      c2Elapsed = performance.now() - t0
      c2SawStoreClose = rec.events.includes('store.close')
    })

    await Promise.all([c1, c2])
    expect(c2Elapsed).toBeGreaterThanOrEqual(70)
    expect(c2SawStoreClose).toBe(true)
    expect(rec.closeCount()).toBe(1)
    expect(rec.events.indexOf('attachment.close:done')).toBeLessThan(rec.events.indexOf('store.close'))
  })

  it(
    'HS-159 16 children released together each ready() via real FileHost on one fresh path and post 1 message (×3 rounds)',
    async () => {
      for (let round = 0; round < 3; round++) {
        const dir = freshDir()
        const bdir = join(dir, `r${round}`)
        const db = join(bdir, 'board.db')
        const ids = Object.fromEntries(
          Array.from({ length: 16 }, (_, i) => [`u${i}`, { userId: `u${i}`, member: true }]),
        )
        // Spawn child processes in small waves before the barrier so V8 cold-boot doesn't starve parallel tests,
        // then release all 16 ready() + post() calls simultaneously against the fresh path.
        const children = []
        for (let i = 0; i < 16; i += 4) {
          const wave = await Promise.all(
            Array.from({ length: 4 }, (_, j) =>
              spawnPeerChild({ db, ids, defaultAs: `u${i + j}`, host: 'real' }),
            ),
          )
          children.push(...wave)
        }
        try {
          const results = await Promise.all(
            children.map(async (c, i) => {
              await c.ready(`u${i}`)
              return c.call('post', { channel: 'dev', text: `hello-${round}-${i}` })
            }),
          )
          expect(results).toHaveLength(16)
        } finally {
          await Promise.all(children.map((c) => c.close()))
        }

        const manifests = fs.readdirSync(bdir).filter((f) => f.endsWith('.manifest.json'))
        expect(manifests).toEqual(['board.db.manifest.json'])

        const check = new DatabaseSync(db, { readOnly: true })
        try {
          const integrity = (check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
          expect(integrity).toBe('ok')
          const count = Number(
            (check.prepare("SELECT COUNT(*) AS n FROM board_events WHERE type = 'message.posted'").get() as { n: number }).n,
          )
          expect(count).toBe(16)
        } finally {
          check.close()
        }
      }
    },
    120_000,
  )
})
