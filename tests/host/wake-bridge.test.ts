// HOST123_DESIGN Stage B7 (HS-112..HS-122, HS-124..HS-128, HS-132, HS-135): WakeBridge unit, fault & regression tests.
// Multi-process tests (HS-123, HS-129..HS-131, HS-133, HS-134) live in tests/host/proc/wake.proc.test.ts.
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  type SqliteStoreOptions,
  type StoredEvent,
} from '../../src/core/public.ts'
import { isRetryableBusy, isStoreClosedError, replacedError } from '../../src/client/busy.ts'
import {
  WAKE_DEGRADED_POLL_MS,
  WAKE_MAX_PAGES_PER_TURN,
  WAKE_PAGE_SIZE,
  WAKE_REARM_AFTER_MS,
  WAKE_SAFETY_POLL_MS,
  WakeBridge,
  type WakeErrorSite,
  type WakeReset,
  type WakeStop,
} from '../../src/host/wake-bridge.ts'

const owner = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []
const bridges: WakeBridge[] = []

function tempDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cb-wake-')))
  dirs.push(d)
  return d
}

function tempDb(): string {
  return join(tempDir(), 'board.db')
}

function openStore(opts: SqliteStoreOptions): SqliteUnifiedStore {
  const s = new SqliteUnifiedStore(opts)
  stores.push(s)
  return s
}

function trackBridge(b: WakeBridge): WakeBridge {
  bridges.push(b)
  return b
}

function countMultiset(items: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) out[item] = (out[item] ?? 0) + 1
  return out
}

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<number> {
  const started = performance.now()
  const deadline = started + timeoutMs
  while (!pred()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  return performance.now() - started
}

function isPostedMessage(ev: StoredEvent, messageId: string): boolean {
  return ev.type === 'message.posted' && String(ev.index) === messageId
}

function fakeWatcher(): fs.FSWatcher & EventEmitter & { closed: boolean } {
  const ee = new EventEmitter() as fs.FSWatcher & EventEmitter & { closed: boolean }
  ee.closed = false
  ee.close = () => {
    ee.closed = true
  }
  ee.ref = () => ee
  ee.unref = () => ee
  return ee
}

afterEach(() => {
  vi.useRealTimers()
  for (const b of bridges.splice(0)) {
    try {
      b.stop()
    } catch {
      // already stopped
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

describe('WakeBridge constructor & constants', () => {
  it('validates option bounds with RangeError and performs no I/O in constructor', () => {
    expect(WAKE_SAFETY_POLL_MS).toBe(process.platform === 'win32' ? 250 : 1500)
    expect(WAKE_DEGRADED_POLL_MS).toBe(250)
    expect(WAKE_PAGE_SIZE).toBe(200)
    expect(WAKE_MAX_PAGES_PER_TURN).toBe(10)
    expect(WAKE_REARM_AFTER_MS).toBe(10_000)

    const store = openStore({ path: tempDb() })
    const badOptions: Array<Record<string, unknown>> = [
      { safetyPollMs: 49 },
      { safetyPollMs: 60_001 },
      { safetyPollMs: 100.5 },
      { safetyPollMs: Number.NaN },
      { safetyPollMs: '1500' },
      { degradedPollMs: 19 },
      { degradedPollMs: 1501 },
      { safetyPollMs: 100, degradedPollMs: 101 },
      { degradedPollMs: 25.5 },
      { pageSize: 0 },
      { pageSize: 5001 },
      { pageSize: 1.2 },
      { maxPagesPerTurn: 0 },
      { maxPagesPerTurn: 1001 },
      { maxPagesPerTurn: Number.POSITIVE_INFINITY },
    ]
    for (const opts of badOptions) {
      expect(() => new WakeBridge(store, opts as never), JSON.stringify(opts)).toThrow(RangeError)
    }

    // Default degradedPollMs clamps to safetyPollMs when safetyPollMs < WAKE_DEGRADED_POLL_MS.
    const clamped = trackBridge(new WakeBridge(store, { safetyPollMs: 100 }))
    expect(clamped.status()).toEqual({
      state: 'idle',
      mode: null,
      epoch: 0,
      identity: null,
      cursor: 0,
      dispatched: 0,
      turns: 0,
      resets: 0,
      watchRearms: 0,
      errors: 0,
      dropped: 0,
      lastError: null,
      stopped: null,
    })
    expect(clamped.epoch).toBe(0)
    expect(store.sidecarHealth().external.armed).toBe(false)
  })
})

describe('WakeBridge lifecycle (HS-112, HS-113)', () => {
  it('HS-112 start arms at head, ignores pre-start commits, and enforces single-bridge & error guards', () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })
    boardB.postMessage(owner, { channel: 'dev', text: 'before-start' })

    const heardBefore: StoredEvent[] = []
    storeA.onEvent((ev) => heardBefore.push(ev))

    const headAtStart = storeA.getHeadIndex()
    expect(headAtStart).toBeGreaterThan(0)

    // start() inside store.transaction() -> TypeError, state stays idle.
    const txBridge = trackBridge(new WakeBridge(storeA))
    expect(() => storeA.transaction(() => txBridge.start())).toThrow(TypeError)
    expect(txBridge.status().state).toBe('idle')
    expect(storeA.sidecarHealth().external.armed).toBe(false)

    // Normal start() arms at head.
    const bridge = trackBridge(new WakeBridge(storeA))
    bridge.start()
    expect(storeA.sidecarHealth().external).toMatchObject({ armed: true, cursor: headAtStart })
    expect(bridge.status()).toMatchObject({ state: 'running', mode: 'fs-watch', epoch: 0 })

    // Pre-start B commit is never dispatched.
    const turn = bridge.pumpNow()
    expect(turn.dispatched).toBe(0)
    expect(heardBefore).toEqual([])

    // pumpNow() inside store.transaction() -> TypeError.
    expect(() => storeA.transaction(() => bridge.pumpNow())).toThrow(TypeError)

    // Second start() is a no-op.
    const turnsBefore = bridge.status().turns
    bridge.start()
    expect(bridge.status().state).toBe('running')
    expect(bridge.status().turns).toBe(turnsBefore)

    // Second WakeBridge on the same store -> TypeError "already has a running WakeBridge".
    const dup = trackBridge(new WakeBridge(storeA))
    expect(() => dup.start()).toThrow(TypeError)
    expect(() => dup.start()).toThrow(/already has a running WakeBridge/)
    // Stopping the idle duplicate must NOT disarm the running bridge.
    dup.stop()
    expect(bridge.status().state).toBe('running')
    expect(storeA.sidecarHealth().external.armed).toBe(true)

    // Store armed by hand -> TypeError "already armed".
    const storeC = openStore({ path })
    storeC.armExternalDispatch()
    const manualBridge = trackBridge(new WakeBridge(storeC))
    expect(() => manualBridge.start()).toThrow(TypeError)
    expect(() => manualBridge.start()).toThrow(/already armed/)
    expect(manualBridge.status().state).toBe('idle')

    // Closed store -> BoardError 503.
    const storeClosed = openStore({ path })
    storeClosed.close()
    const closedBridge = trackBridge(new WakeBridge(storeClosed))
    let caught: unknown
    try {
      closedBridge.start()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(BoardError)
    expect((caught as BoardError).status).toBe(503)
    expect(closedBridge.status().state).toBe('idle')

    // start() after stop() -> TypeError.
    bridge.stop()
    expect(() => bridge.start()).toThrow(TypeError)
  })

  it('HS-113 stop is idempotent, disarms, releases all active handles, keeps store open, fires onStop once', async () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const boardA = new BoardService(storeA)
    boardA.createChannel(owner, { path: 'dev' })
    boardA.postMessage(owner, { channel: 'dev', text: 'seed' })

    // Let any transient test-setup timer settle before snapshotting active resources.
    await new Promise((r) => setTimeout(r, 15))
    const before = countMultiset(process.getActiveResourcesInfo())
    let watcherCloses = 0
    const bridge = trackBridge(
      new WakeBridge(storeA, {
        testHooks: {
          watch: (p, l) => {
            const w = fs.watch(p, { persistent: false }, (ev, name) => l(ev, name === null ? null : String(name)))
            const origClose = w.close.bind(w)
            w.close = () => {
              watcherCloses += 1
              origClose()
            }
            return w
          },
        },
      }),
    )
    const stops: WakeStop[] = []
    bridge.onStop((s) => stops.push(s))

    bridge.start()
    // Let the initial turn run so the watcher and poll timer are settled.
    await new Promise((r) => setTimeout(r, 20))
    expect(bridge.status().mode).toBe('fs-watch')
    expect(bridge.status().watchRearms).toBeGreaterThanOrEqual(1)
    expect(watcherCloses).toBe(0)

    bridge.stop()
    bridge.stop() // idempotent

    expect(watcherCloses).toBe(1)
    expect(storeA.sidecarHealth().external.armed).toBe(false)
    expect(bridge.status().state).toBe('stopped')
    expect(bridge.status().stopped).toEqual({ reason: 'stopped', error: null })
    expect(stops).toEqual([{ reason: 'stopped', error: null }])
    // Store remains open.
    expect(storeA.getHeadIndex()).toBeGreaterThan(0)

    // Give libuv one tick to finalize closed FSWatcher handles, then verify zero leaked active resources
    // (a pre-existing Vitest runner Timeout captured in `before` may expire during the test, so compare per-kind <=).
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))
    const after = countMultiset(process.getActiveResourcesInfo())
    expect(after['FSEvent'] ?? 0).toBe(0)
    expect(after['FSWatcher'] ?? 0).toBe(0)
    expect(after['FSStatWatcher'] ?? 0).toBe(0)
    expect(after['Immediate'] ?? 0).toBe(0)
    for (const [kind, count] of Object.entries(after)) {
      expect(count, `leaked active resource ${kind}`).toBeLessThanOrEqual(before[kind] ?? 0)
    }
  })
})

describe('WakeBridge dispatch, watches & faults (HS-114..HS-121)', () => {
  it('HS-114 dispatches foreign posts once, skips own commits with skippedOwn, and wakes on fs.watch', async () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const boardA = new BoardService(storeA)
    const boardB = new BoardService(storeB)
    boardA.createChannel(owner, { path: 'dev' })
    // Warm up owner actor so posts emit predictable events.
    boardA.postMessage(owner, { channel: 'dev', text: 'warmup' })

    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    const bridge = trackBridge(new WakeBridge(storeA, { safetyPollMs: 60_000 }))
    bridge.start()
    // Wait for initial turn + macOS FSEvents watcher startup so the watch path below is live.
    await new Promise((r) => setTimeout(r, 40))

    // B commits 3 posts -> pumpNow gives dispatched: 3, indices [h+1, h+2, h+3] once each.
    const h = storeA.getHeadIndex()
    boardB.postMessage(owner, { channel: 'dev', text: 'b1' })
    boardB.postMessage(owner, { channel: 'dev', text: 'b2' })
    boardB.postMessage(owner, { channel: 'dev', text: 'b3' })

    const t1 = bridge.pumpNow()
    expect(t1).toMatchObject({ dispatched: 3, skippedOwn: 0, more: false, reset: null, stopped: null })
    expect(heard.map((e) => e.index)).toEqual([h + 1, h + 2, h + 3])

    // A commits 2 posts -> listener hears each once from flushAfterCommit; pumpNow skips them as skippedOwn.
    heard.length = 0
    boardA.postMessage(owner, { channel: 'dev', text: 'a1' })
    boardA.postMessage(owner, { channel: 'dev', text: 'a2' })
    const ownEvents = heard.length
    expect(ownEvents).toBeGreaterThanOrEqual(2)

    const t2 = bridge.pumpNow()
    expect(t2).toMatchObject({ dispatched: 0, skippedOwn: ownEvents, more: false, reset: null, stopped: null })
    // Listener heard nothing additional from pumpNow.
    expect(heard).toHaveLength(ownEvents)

    // Without pumpNow(), a B commit reaches A's listener within 500 ms via fs.watch.
    heard.length = 0
    const b4 = boardB.postMessage(owner, { channel: 'dev', text: 'b4-watch' })
    const lag = await waitFor(
      () => heard.some((e) => isPostedMessage(e, b4.message.id)),
      500,
      'fs.watch delivery of b4',
    )
    expect(lag).toBeLessThan(500)
  })

  it('HS-115 fresh board without .wakeup uses directory watch, upgrades to file watch on first commit', async () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    new BoardService(storeA)
    const boardB = new BoardService(storeB)
    // seedDefaults writes no event, so .wakeup must not exist yet (P1).
    expect(fs.existsSync(`${path}.wakeup`)).toBe(false)

    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    const bridge = trackBridge(new WakeBridge(storeA, { safetyPollMs: 60_000 }))
    bridge.start()
    // Let start()'s initial turn and macOS FSEvents dir-watch startup finish before B posts.
    await new Promise((r) => setTimeout(r, 40))
    expect(bridge.status().mode).toBe('fs-watch')
    expect(bridge.status().watchRearms).toBe(1)

    // First post creates .wakeup: directory watch catches it within 500 ms (60 s poll cannot have run).
    const m1 = boardB.postMessage(owner, { channel: 'dev', text: 'first-ever' })
    await waitFor(
      () => heard.some((e) => isPostedMessage(e, m1.message.id)),
      500,
      'first post via dir watch',
    )
    expect(fs.existsSync(`${path}.wakeup`)).toBe(true)
    expect(bridge.status().watchRearms).toBeGreaterThanOrEqual(2)

    // Allow the upgraded file watcher's FSEvents stream (and 25 ms settle turn) to finish starting so m2 proves live file watch.
    await new Promise((r) => setTimeout(r, 40))
    // Second post arrives via the upgraded file watch within 500 ms.
    const m2 = boardB.postMessage(owner, { channel: 'dev', text: 'second-post' })
    await waitFor(
      () => heard.some((e) => isPostedMessage(e, m2.message.id)),
      500,
      'second post via file watch',
    )
  })

  it('HS-116 .wakeup unlinked while running recovers via safety poll and re-arms on the new inode', async () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })
    boardB.postMessage(owner, { channel: 'dev', text: 'seed' })
    expect(fs.existsSync(`${path}.wakeup`)).toBe(true)

    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    const bridge = trackBridge(new WakeBridge(storeA, { safetyPollMs: 300 }))
    bridge.start()
    const rearms0 = bridge.status().watchRearms
    expect(rearms0).toBe(1)

    // Unlink .wakeup while running.
    fs.unlinkSync(`${path}.wakeup`)

    // B posts -> recreates .wakeup with a new inode; A dispatches within 1,000 ms.
    const m1 = boardB.postMessage(owner, { channel: 'dev', text: 'after-unlink' })
    await waitFor(
      () => heard.some((e) => isPostedMessage(e, m1.message.id)),
      1_000,
      'dispatch after unlink',
    )

    // Within 1,000 ms after that, the bridge has re-armed onto the new inode.
    await waitFor(() => bridge.status().watchRearms > rearms0, 1_000, 'watchRearms increment after unlink')

    // With a new bridge at safetyPollMs: 60_000 (no poll involved), a further B post dispatches within 500 ms.
    bridge.stop()
    const bridge2 = trackBridge(new WakeBridge(storeA, { safetyPollMs: 60_000 }))
    bridge2.start()
    await new Promise((r) => setTimeout(r, 40))
    const m2 = boardB.postMessage(owner, { channel: 'dev', text: 'after-rearm' })
    await waitFor(
      () => heard.some((e) => isPostedMessage(e, m2.message.id)),
      500,
      'dispatch on new inode with 60s poll',
    )
  })

  it('HS-117 .wakeup replaced by rename (no watch event) still dispatches and re-arms on next poll', async () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })
    boardB.postMessage(owner, { channel: 'dev', text: 'seed' })

    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    const bridge = trackBridge(new WakeBridge(storeA, { safetyPollMs: 300 }))
    bridge.start()
    const rearms0 = bridge.status().watchRearms

    // Rename a temp file holding a much larger generation over .wakeup (kills file watcher silently on macOS).
    const tmp = `${path}.wakeup.replacement`
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64LE(1_000_000n, 0)
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, `${path}.wakeup`)

    const m1 = boardB.postMessage(owner, { channel: 'dev', text: 'after-rename-over' })
    await waitFor(
      () => heard.some((e) => isPostedMessage(e, m1.message.id)),
      1_000,
      'dispatch after rename-over',
    )
    await waitFor(() => bridge.status().watchRearms > rearms0, 1_000, 'watchRearms increment after rename-over')
  })

  it('HS-118 EMFILE from testHooks.watch degrades to poll, dispatches within degradedPollMs + 300, and recovers after WAKE_REARM_AFTER_MS', async () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })
    boardB.postMessage(owner, { channel: 'dev', text: 'seed' })

    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    // Part 1: real timers — EMFILE enters poll mode and dispatches within degradedPollMs + 300 ms.
    const errors: Array<{ error: unknown; site: WakeErrorSite }> = []
    const degradedPollMs = 100
    const bridge = trackBridge(
      new WakeBridge(storeA, {
        safetyPollMs: 1_500,
        degradedPollMs,
        onError: (error, site) => errors.push({ error, site }),
        testHooks: {
          watch: () => {
            throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
          },
        },
      }),
    )
    bridge.start()
    expect(bridge.status().mode).toBe('poll')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.site).toBe('watch')

    const m1 = boardB.postMessage(owner, { channel: 'dev', text: 'degraded-poll-post' })
    await waitFor(
      () => heard.some((e) => isPostedMessage(e, m1.message.id)),
      degradedPollMs + 300,
      'degraded poll dispatch',
    )
    bridge.stop()

    // Part 2: fake timers — after WAKE_REARM_AFTER_MS, stub succeeds and mode switches back to 'fs-watch'.
    vi.useFakeTimers()
    let shouldFail = true
    const createdWatchers: ReturnType<typeof fakeWatcher>[] = []
    const errors2: WakeErrorSite[] = []
    const bridge2 = trackBridge(
      new WakeBridge(storeA, {
        onError: (_e, site) => errors2.push(site),
        testHooks: {
          watch: () => {
            if (shouldFail) {
              throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' })
            }
            const w = fakeWatcher()
            createdWatchers.push(w)
            return w
          },
        },
      }),
    )
    bridge2.start()
    expect(bridge2.status().mode).toBe('poll')
    expect(errors2).toEqual(['watch'])

    shouldFail = false
    vi.advanceTimersByTime(WAKE_REARM_AFTER_MS - 1)
    expect(bridge2.status().mode).toBe('poll')
    vi.advanceTimersByTime(1)
    expect(bridge2.status().mode).toBe('fs-watch')
    expect(createdWatchers).toHaveLength(1)

    // Watcher emitting 'error' also degrades to 'poll' and re-arms after WAKE_REARM_AFTER_MS.
    createdWatchers[0]!.emit('error', new Error('watcher died'))
    expect(bridge2.status().mode).toBe('poll')
    expect(createdWatchers[0]!.closed).toBe(true)
    expect(errors2).toEqual(['watch', 'watch'])
    vi.advanceTimersByTime(WAKE_REARM_AFTER_MS)
    expect(bridge2.status().mode).toBe('fs-watch')
    expect(createdWatchers).toHaveLength(2)
  })

  it('HS-119 store with wakeupPath: null stays in poll mode permanently and dispatches within degradedPollMs + 300', async () => {
    const path = tempDb()
    const storeA = openStore({ path, wakeupPath: null })
    const storeB = openStore({ path, wakeupPath: null })
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })

    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    const degradedPollMs = 100
    const bridge = trackBridge(new WakeBridge(storeA, { safetyPollMs: 1_500, degradedPollMs }))
    bridge.start()
    expect(bridge.status().mode).toBe('poll')
    expect(bridge.status().watchRearms).toBe(0)
    expect(bridge.status().errors).toBe(0)

    const m1 = boardB.postMessage(owner, { channel: 'dev', text: 'no-wakeup-path' })
    await waitFor(
      () => heard.some((e) => isPostedMessage(e, m1.message.id)),
      degradedPollMs + 300,
      'poll dispatch without wakeupPath',
    )
    expect(bridge.status().mode).toBe('poll')
    expect(bridge.status().watchRearms).toBe(0)
  })

  it('HS-120 B commit with suppressed .wakeup write is still dispatched by A via head poll within 1,000 ms', async () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path, wakeupPath: null })
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })
    // Create .wakeup once via A so A is in real fs-watch mode.
    const boardA = new BoardService(storeA)
    boardA.postMessage(owner, { channel: 'dev', text: 'create-wakeup' })
    expect(fs.existsSync(`${path}.wakeup`)).toBe(true)

    const genBefore = fs.readFileSync(`${path}.wakeup`).readBigUInt64LE(0)
    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    const bridge = trackBridge(new WakeBridge(storeA, { safetyPollMs: 300 }))
    bridge.start()
    expect(bridge.status().mode).toBe('fs-watch')

    // B commits with wakeupPath: null -> .wakeup generation stays unchanged, no watch event fires.
    const m1 = boardB.postMessage(owner, { channel: 'dev', text: 'silent-commit' })
    expect(fs.readFileSync(`${path}.wakeup`).readBigUInt64LE(0)).toBe(genBefore)

    await waitFor(
      () => heard.some((e) => isPostedMessage(e, m1.message.id)),
      1_000,
      'head poll dispatch of silent commit',
    )
  })

  it('HS-121 paging dispatches 2,000 events in pumpNow (10 x 200, more: true) and remaining 500 in scheduled follow-up within 100 ms', async () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    new BoardService(storeA)

    const heardIndices: number[] = []
    storeA.onEvent((ev) => heardIndices.push(ev.index))

    const bridge = trackBridge(
      new WakeBridge(storeA, { watch: false, safetyPollMs: 60_000, pageSize: 200, maxPagesPerTurn: 10 }),
    )
    bridge.start()
    await new Promise((r) => setImmediate(r))

    const batch = Array.from({ length: 2_500 }, (_, i) => ({
      type: 'test.ping',
      payload: { i },
    }))
    storeB.appendEvents(batch)

    const firstTurn = bridge.pumpNow()
    expect(firstTurn).toEqual({
      pages: 10,
      dispatched: 2_000,
      skippedOwn: 0,
      more: true,
      reset: null,
      stopped: null,
    })

    const followUpMs = await waitFor(() => heardIndices.length === 2_500, 100, 'follow-up turn for remaining 500')
    expect(followUpMs).toBeLessThanOrEqual(100)
    expect(bridge.status().dispatched).toBe(2_500)

    // Strictly ascending indices with no repeats.
    for (let i = 1; i < heardIndices.length; i++) {
      expect(heardIndices[i]!).toBeGreaterThan(heardIndices[i - 1]!)
    }
    expect(new Set(heardIndices).size).toBe(2_500)
  })
})

describe('WakeBridge identity, errors & serviceOptions (HS-122, HS-124..HS-128, HS-132, HS-135)', () => {
  it('HS-122 replaced closes store, stops bridge with replacedError, fires onStop once, ends pending wait', async () => {
    const path = tempDb()
    let replaced = false
    const storeA = openStore({
      path,
      testHooks: {
        statFile: (absPath) => {
          const st = fs.statSync(absPath, { bigint: true, throwIfNoEntry: false })
          if (!st) return undefined
          return replaced ? { dev: st.dev, ino: st.ino + 999n } : { dev: st.dev, ino: st.ino }
        },
      },
    })
    const safetyPollMs = 200
    const bridge = trackBridge(new WakeBridge(storeA, { safetyPollMs }))
    const boardA = new BoardService(storeA, bridge.serviceOptions())
    boardA.createChannel(owner, { path: 'dev' })
    bridge.start()

    const stops: WakeStop[] = []
    bridge.onStop((s) => stops.push(s))

    const waitStarted = performance.now()
    const waitP = boardA.getEvents(owner, { after: String(storeA.getHeadIndex()), wait: 30 })

    // Flip statFile to report a different inode and run a turn.
    replaced = true
    const turn = bridge.pumpNow()
    const expected = replacedError(path)

    expect(turn.stopped).not.toBeNull()
    expect(turn.stopped!.reason).toBe('replaced')
    expect(bridge.status().state).toBe('stopped')
    expect(bridge.status().stopped?.reason).toBe('replaced')

    const err = bridge.status().stopped!.error!
    expect(err).toBeInstanceOf(BoardError)
    expect(err.status).toBe(503)
    expect(err.code).toBe('unavailable')
    expect(err.retryAfter).toBeUndefined()
    expect(err.details).toEqual({ reason: 'replaced', path })
    expect(err.message).toContain(path)
    expect(err.message).toBe(expected.message)
    expect(isRetryableBusy(err)).toBe(false)

    // Store was closed by the bridge itself.
    let closedErr: unknown
    try {
      storeA.getHeadIndex()
    } catch (e) {
      closedErr = e
    }
    expect(isStoreClosedError(closedErr)).toBe(true)

    expect(stops).toHaveLength(1)
    expect(stops[0]!.reason).toBe('replaced')
    expect(stops[0]!.error).toBe(err)
    expect(() => bridge.start()).toThrow(TypeError)

    // Pending getEvents(wait: 30) resolves within eventsWaitPollMs + 500 ms.
    const page = await waitP
    const waitElapsed = performance.now() - waitStarted
    expect(page.events).toEqual([])
    expect(waitElapsed).toBeLessThanOrEqual(safetyPollMs + 500)
  })

  it('HS-124 restored via rotateInstanceId resets epoch, updates baseline, dispatches later posts without resetting again', () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })

    const bridge = trackBridge(new WakeBridge(storeA, { watch: false, safetyPollMs: 60_000 }))
    const resets: WakeReset[] = []
    bridge.onReset((r) => resets.push(r))
    bridge.start()

    const oldId = storeA.openedIdentity!
    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    const rotated = storeB.rotateInstanceId()
    expect(rotated.instanceId).not.toBe(oldId.instanceId)

    // Post before the reset is skipped (between old cursor and new head).
    boardB.postMessage(owner, { channel: 'dev', text: 'during-restore' })
    const headAtReset = storeA.getHeadIndex()

    const t1 = bridge.pumpNow()
    expect(t1.reset).toEqual({
      epoch: 1,
      reason: 'restored',
      identity: rotated,
      was: oldId,
      cursor: headAtReset,
    })
    expect(resets).toHaveLength(1)
    expect(resets[0]).toEqual(t1.reset)
    expect(bridge.epoch).toBe(1)
    expect(storeA.sidecarHealth().external.cursor).toBe(headAtReset)
    expect(bridge.status().identity?.instanceId).toBe(rotated.instanceId)
    expect(heard).toEqual([])

    // Second turn does not reset again.
    const t2 = bridge.pumpNow()
    expect(t2.reset).toBeNull()
    expect(resets).toHaveLength(1)

    // Later B post IS dispatched.
    const afterPost = boardB.postMessage(owner, { channel: 'dev', text: 'after-restore' })
    const t3 = bridge.pumpNow()
    expect(t3.dispatched).toBeGreaterThanOrEqual(1)
    expect(heard.some((e) => isPostedMessage(e, afterPost.message.id))).toBe(true)
  })

  it('HS-125 pumpExternal 410 resets as rewound; transient pump error logs site pump, stays running, resumes on next pumpNow', () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })

    const errors: Array<{ error: unknown; site: WakeErrorSite }> = []
    const resets: WakeReset[] = []
    const bridge = trackBridge(
      new WakeBridge(storeA, {
        watch: false,
        safetyPollMs: 60_000,
        onError: (error, site) => errors.push({ error, site }),
      }),
    )
    bridge.onReset((r) => resets.push(r))
    bridge.start()

    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    // 1. Stub pumpExternal to throw 410 cursor_expired once.
    const origPump = storeA.pumpExternal.bind(storeA)
    let failMode: '410' | 'io' | 'none' = '410'
    storeA.pumpExternal = ((limit?: number) => {
      if (failMode === '410') {
        failMode = 'none'
        throw new BoardError(410, 'cursor_expired', 'rewound')
      }
      if (failMode === 'io') {
        failMode = 'none'
        throw new Error('io')
      }
      return origPump(limit)
    }) as typeof storeA.pumpExternal

    const t1 = bridge.pumpNow()
    expect(t1.reset).toMatchObject({ epoch: 1, reason: 'rewound' })
    expect(resets).toHaveLength(1)
    expect(bridge.epoch).toBe(1)
    expect(storeA.sidecarHealth().external.armed).toBe(true)

    const m1 = boardB.postMessage(owner, { channel: 'dev', text: 'after-rewound' })
    const t2 = bridge.pumpNow()
    expect(t2.dispatched).toBeGreaterThanOrEqual(1)
    expect(heard.some((e) => isPostedMessage(e, m1.message.id))).toBe(true)

    // 2. Stub pumpExternal to throw Error('io') once.
    heard.length = 0
    const m2 = boardB.postMessage(owner, { channel: 'dev', text: 'after-io-err' })
    failMode = 'io'
    const t3 = bridge.pumpNow()
    expect(t3.dispatched).toBe(0)
    expect(t3.reset).toBeNull()
    expect(t3.stopped).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.site).toBe('pump')
    expect(bridge.status().errors).toBe(1)
    expect(bridge.status().lastError).toEqual({ site: 'pump', message: 'io' })
    expect(bridge.status().state).toBe('running')

    // Next pumpNow dispatches the pending event.
    const t4 = bridge.pumpNow()
    expect(t4.dispatched).toBeGreaterThanOrEqual(1)
    expect(heard.some((e) => isPostedMessage(e, m2.message.id))).toBe(true)
  })

  it('HS-125 (B7-F1) transient armExternalDispatch failure during rewound or restored reset recovers on next turn without wedging', () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })

    const errors: Array<{ error: unknown; site: WakeErrorSite }> = []
    const resets: WakeReset[] = []
    const bridge = trackBridge(
      new WakeBridge(storeA, {
        watch: false,
        safetyPollMs: 60_000,
        onError: (error, site) => errors.push({ error, site }),
      }),
    )
    bridge.onReset((r) => resets.push(r))
    bridge.start()

    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    const origPump = storeA.pumpExternal.bind(storeA)
    const origArm = storeA.armExternalDispatch.bind(storeA)
    let throw410 = true
    let failArmOnce = true

    storeA.pumpExternal = ((limit?: number) => {
      if (throw410) {
        throw410 = false
        throw new BoardError(410, 'cursor_expired', 'rewound')
      }
      return origPump(limit)
    }) as typeof storeA.pumpExternal

    storeA.armExternalDispatch = (() => {
      if (failArmOnce) {
        failArmOnce = false
        throw new Error('transient arm failure')
      }
      return origArm()
    }) as typeof storeA.armExternalDispatch

    // Turn 1: 410 triggers reset('rewound'), disarm runs, armExternalDispatch throws transiently.
    const t1 = bridge.pumpNow()
    expect(t1.reset).toBeNull()
    expect(t1.stopped).toBeNull()
    expect(bridge.status().state).toBe('running')
    expect(bridge.status().epoch).toBe(0)
    expect(bridge.status().errors).toBe(1)
    expect(errors[0]!.site).toBe('pump')
    expect(storeA.sidecarHealth().external.armed).toBe(false)

    // Turn 2: pending rewound reset completes, re-arms the store, and increments epoch.
    const t2 = bridge.pumpNow()
    expect(t2.reset).toMatchObject({ epoch: 1, reason: 'rewound' })
    expect(t2.stopped).toBeNull()
    expect(bridge.epoch).toBe(1)
    expect(storeA.sidecarHealth().external.armed).toBe(true)
    expect(resets).toHaveLength(1)

    // Turn 3: subsequent foreign posts dispatch normally.
    const m1 = boardB.postMessage(owner, { channel: 'dev', text: 'after-recovered-rewound' })
    const t3 = bridge.pumpNow()
    expect(t3.dispatched).toBeGreaterThanOrEqual(1)
    expect(heard.some((e) => isPostedMessage(e, m1.message.id))).toBe(true)

    // Also verify transient armExternalDispatch failure during 'restored' reset preserves 'was' and recovers.
    const oldIdentity = bridge.status().identity!
    const rotated = storeB.rotateInstanceId()
    failArmOnce = true
    const t4 = bridge.pumpNow()
    expect(t4.reset).toBeNull()
    expect(bridge.status().errors).toBe(2)
    expect(errors[1]!.site).toBe('identity')
    expect(storeA.sidecarHealth().external.armed).toBe(false)

    const t5 = bridge.pumpNow()
    expect(t5.reset).toMatchObject({ epoch: 2, reason: 'restored', identity: rotated, was: oldIdentity })
    expect(storeA.sidecarHealth().external.armed).toBe(true)
    expect(resets).toHaveLength(2)

    heard.length = 0
    const m2 = boardB.postMessage(owner, { channel: 'dev', text: 'after-recovered-restored' })
    const t6 = bridge.pumpNow()
    expect(t6.dispatched).toBeGreaterThanOrEqual(1)
    expect(heard.some((e) => isPostedMessage(e, m2.message.id))).toBe(true)
  })

  it('HS-126 owner closes store without stop: next turn stops with reason closed, error null, no onError, onStop once', () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const errors: unknown[] = []
    const stops: WakeStop[] = []

    const bridge = trackBridge(
      new WakeBridge(storeA, {
        watch: false,
        safetyPollMs: 60_000,
        onError: (e) => errors.push(e),
      }),
    )
    bridge.onStop((s) => stops.push(s))
    bridge.start()

    storeA.close()
    const turn = bridge.pumpNow()
    expect(turn.stopped).toEqual({ reason: 'closed', error: null })
    expect(bridge.status().state).toBe('stopped')
    expect(bridge.status().stopped).toEqual({ reason: 'closed', error: null })
    expect(errors).toEqual([])
    expect(stops).toEqual([{ reason: 'closed', error: null }])
  })

  it('HS-127 store onEvent listener errors count in sidecarHealth().listenerFailures not bridge errors; throwing onReset listener isolated', () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })
    boardB.postMessage(owner, { channel: 'dev', text: 'warmup' })

    const errors: Array<{ error: unknown; site: WakeErrorSite }> = []
    const bridge = trackBridge(
      new WakeBridge(storeA, {
        watch: false,
        safetyPollMs: 60_000,
        onError: (error, site) => errors.push({ error, site }),
      }),
    )
    bridge.start()

    const delivered: number[] = []
    storeA.onEvent(() => {
      throw new Error('boom-listener')
    })
    storeA.onEvent((ev) => delivered.push(ev.index))

    for (let i = 0; i < 5; i++) {
      boardB.postMessage(owner, { channel: 'dev', text: `msg-${i}` })
    }
    const failuresBefore = storeA.sidecarHealth().listenerFailures
    const turn = bridge.pumpNow()
    expect(turn.dispatched).toBe(5)
    expect(delivered).toHaveLength(5)
    expect(storeA.sidecarHealth().listenerFailures - failuresBefore).toBe(5)
    expect(bridge.status().errors).toBe(0)
    expect(errors).toEqual([])

    // Throwing onReset listener: errors becomes 1 with site 'listener', and second onReset listener still runs.
    const secondResetCalls: WakeReset[] = []
    bridge.onReset(() => {
      throw new Error('reset-boom')
    })
    bridge.onReset((r) => secondResetCalls.push(r))

    storeB.rotateInstanceId()
    bridge.pumpNow()
    expect(bridge.status().errors).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.site).toBe('listener')
    expect(secondResetCalls).toHaveLength(1)
    expect(secondResetCalls[0]!.reason).toBe('restored')
  })

  it('HS-128 serviceOptions() is frozen with safetyPollMs; bridged BoardService wakes getEvents, claimReady, and pumpNow fast', async () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const bridge = trackBridge(new WakeBridge(storeA, { safetyPollMs: 1500 }))
    const opts = bridge.serviceOptions()

    expect(Object.isFrozen(opts)).toBe(true)
    expect(Object.isFrozen(opts.tasks)).toBe(true)
    expect(opts).toEqual({
      eventsWaitPollMs: 1500,
      tasks: {
        wake: expect.any(Function),
        armedSafetyPollMs: 1500,
      },
    })

    const boardA = new BoardService(storeA, opts)
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })
    boardB.createChannel(owner, { path: 'jobs' })
    boardB.postMessage(owner, { channel: 'dev', text: 'seed' })
    bridge.start()

    // 1. getEvents(wait: 10) on A returns B post within 100 ms.
    {
      const head = String(storeA.getHeadIndex())
      const waitP = boardA.getEvents(owner, { after: head, wait: 10 })
      await new Promise((r) => setTimeout(r, 20))
      const t0 = performance.now()
      const posted = boardB.postMessage(owner, { channel: 'dev', text: 'fast-event' })
      const page = await waitP
      const lag = performance.now() - t0
      expect(page.events.some((e) => e.type === 'message.posted' && e.message?.id === posted.message.id)).toBe(true)
      expect(lag).toBeLessThan(100)
    }

    // 2. claimReady({channel: 'jobs', wait: 10}) on A returns task created on B within 200 ms.
    {
      const claimP = boardA.tasks.claimReady(owner, { channel: 'jobs', wait: 10 })
      await new Promise((r) => setTimeout(r, 20))
      const t0 = performance.now()
      const created = boardB.tasks.createTask(owner, { channel: 'jobs', text: 'do work' })
      const claimed = await claimP
      const lag = performance.now() - t0
      expect(claimed.task?.id).toBe(created.task.id)
      expect(lag).toBeLessThan(200)
    }

    // 3. HS-2.25 pumpNow clause: with {eventsWaitPollMs: 1500} and watch: false, pumpNow() right after B post
    //    makes pending A wait return within 50 ms.
    bridge.stop()
    const bridgePoll = trackBridge(new WakeBridge(storeA, { watch: false, safetyPollMs: 1500 }))
    const boardPoll = new BoardService(storeA, bridgePoll.serviceOptions())
    bridgePoll.start()
    const head = String(storeA.getHeadIndex())
    const waitP = boardPoll.getEvents(owner, { after: head, wait: 10 })
    await new Promise((r) => setTimeout(r, 20))
    const posted = boardB.postMessage(owner, { channel: 'dev', text: 'pump-now-wake' })
    const t0 = performance.now()
    bridgePoll.pumpNow()
    const page = await waitP
    const lag = performance.now() - t0
    expect(page.events.some((e) => e.type === 'message.posted' && e.message?.id === posted.message.id)).toBe(true)
    expect(lag).toBeLessThan(50)
  })

  it('HS-132 own-set overflow past 65,536 yields counted duplicate (dropped === 1), no loss, no cursor_expired', () => {
    const path = tempDb()
    const storeA = openStore({ path, jsonlPath: null })
    const bridge = trackBridge(
      new WakeBridge(storeA, { watch: false, safetyPollMs: 60_000, pageSize: 5_000, maxPagesPerTurn: 20 }),
    )
    bridge.start()

    const startCursor = storeA.getHeadIndex()
    const count = 65_537
    const counts = new Uint8Array(count + 1)
    storeA.onEvent((ev) => {
      const offset = ev.index - startCursor
      if (offset >= 1 && offset <= count) counts[offset] = (counts[offset] ?? 0) + 1
    })

    const inputs = Array.from({ length: count }, (_, i) => ({
      type: 'test.bulk',
      payload: { i },
    }))
    storeA.appendEvents(inputs)

    const turn = bridge.pumpNow()
    expect(turn.reset).toBeNull()
    expect(turn.stopped).toBeNull()
    expect(turn.more).toBe(false)
    expect(turn.dispatched).toBe(1)
    expect(turn.skippedOwn).toBe(65_536)
    expect(bridge.status().dropped).toBe(1)
    expect(bridge.status().resets).toBe(0)
    expect(bridge.status().cursor).toBe(startCursor + count)

    // Oldest own index (offset 1) heard twice; every other index heard once; none missed.
    expect(counts[1]).toBe(2)
    let missed = 0
    let extraDupes = 0
    for (let i = 2; i <= count; i++) {
      if (counts[i] === 0) missed += 1
      else if (counts[i] !== 1) extraDupes += 1
    }
    expect(missed).toBe(0)
    expect(extraDupes).toBe(0)
  })

  it('HS-135 no bridge: A onEvent hears only own commits; getEvents(wait: 5) still returns B post within 300 ms', async () => {
    const path = tempDb()
    const storeA = openStore({ path })
    const storeB = openStore({ path })
    const boardA = new BoardService(storeA)
    const boardB = new BoardService(storeB)
    boardA.createChannel(owner, { path: 'dev' })

    const heard: StoredEvent[] = []
    storeA.onEvent((ev) => heard.push(ev))

    boardB.postMessage(owner, { channel: 'dev', text: 'b1' })
    boardB.postMessage(owner, { channel: 'dev', text: 'b2' })
    boardB.postMessage(owner, { channel: 'dev', text: 'b3' })
    await new Promise((r) => setTimeout(r, 30))
    expect(heard).toHaveLength(0)

    const own = boardA.postMessage(owner, { channel: 'dev', text: 'a1' })
    expect(heard.some((e) => isPostedMessage(e, own.message.id))).toBe(true)

    const head = String(storeA.getHeadIndex())
    const waitP = boardA.getEvents(owner, { after: head, wait: 5 })
    await new Promise((r) => setTimeout(r, 20))
    const t0 = performance.now()
    const b4 = boardB.postMessage(owner, { channel: 'dev', text: 'b4-head-poll' })
    const page = await waitP
    const lag = performance.now() - t0
    expect(page.events.some((e) => e.type === 'message.posted' && e.message?.id === b4.message.id)).toBe(true)
    expect(lag).toBeLessThan(300)
  })
})
