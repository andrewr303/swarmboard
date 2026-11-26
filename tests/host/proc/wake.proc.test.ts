// HOST123_DESIGN Stage B7 multi-process WakeBridge tests (HS-123, HS-129..HS-131, HS-133, HS-134).
// Multi-process tests are sleep-sensitive (H0 errata): re-run this file alone before debugging a timeout.
import { fork, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../../src/core/public.ts'
import { withBusyRetry } from '../../../src/client/busy.ts'
import { WakeBridge } from '../../../src/host/wake-bridge.ts'

const CHILD = fileURLToPath(new URL('./wake-child.ts', import.meta.url))
const owner = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []
const bridges: WakeBridge[] = []
const children: ChildProcess[] = []

function tmpDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cb-wake-proc-')))
  dirs.push(d)
  return d
}

interface IpcChild {
  proc: ChildProcess
  call<T = unknown>(op: string, payload?: Record<string, unknown>): Promise<T>
  exit(): Promise<void>
}

async function spawnIpcChild(args: Record<string, unknown>): Promise<IpcChild> {
  const proc = fork(CHILD, [JSON.stringify({ mode: 'ipc', ...args })], {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(proc)
  let stderr = ''
  proc.stderr!.on('data', (b: Buffer) => {
    stderr += b.toString('utf8')
  })

  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  await new Promise<void>((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      const m = raw as { ready?: boolean; id?: number; ok?: boolean; value?: unknown; error?: { message: string } }
      if (m.ready) {
        resolve()
        return
      }
      if (typeof m.id === 'number') {
        const entry = pending.get(m.id)
        if (!entry) return
        pending.delete(m.id)
        if (m.ok) entry.resolve(m.value)
        else entry.reject(new Error(m.error?.message ?? 'child error'))
      }
    }
    proc.on('message', onMessage)
    proc.once('exit', (code, signal) => {
      for (const [, entry] of pending) {
        entry.reject(new Error(`child exited early (code=${code}, signal=${signal}): ${stderr}`))
      }
      pending.clear()
      reject(new Error(`child exited before ready (code=${code}, signal=${signal}): ${stderr}`))
    })
  })

  const call = <T = unknown>(op: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      proc.send({ id, op, ...payload })
    })
  }

  return {
    proc,
    call,
    async exit(): Promise<void> {
      if (proc.exitCode !== null || proc.killed) return
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
      try {
        await call('exit')
      } catch {
        proc.kill('SIGKILL')
      }
      await exited
    },
  }
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]!
}

afterEach(async () => {
  for (const b of bridges.splice(0)) {
    try {
      b.stop()
    } catch {
      // ignore
    }
  }
  for (const s of stores.splice(0)) {
    try {
      s.close()
    } catch {
      // ignore
    }
  }
  for (const p of children.splice(0)) {
    if (p.exitCode === null && !p.killed) {
      p.kill('SIGKILL')
      await new Promise<void>((resolve) => p.once('exit', () => resolve()))
    }
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('WakeBridge multi-process (HS-123, HS-129..HS-131, HS-133, HS-134)', () => {
  it('HS-123 real file replacement under a live child stops with reason replaced within 2 s, ends pending wait, 1 DatabaseSync open', async () => {
    const dir = tmpDir()
    const db = join(dir, 'board.db')
    {
      const init = new SqliteUnifiedStore({ path: db })
      const b = new BoardService(init)
      b.createChannel(owner, { path: 'dev' })
      b.postMessage(owner, { channel: 'dev', text: 'init' })
      init.close()
    }

    const child = await spawnIpcChild({ path: db, bridge: true, safetyPollMs: 300 })
    const waitP = child.call<{ events: number; cursor: string }>('wait', { wait: 30 })
    // Let the wait park in getEvents.
    await new Promise((r) => setTimeout(r, 80))

    // Prepare a fresh board file and rename it over board.db while the child holds it open.
    const freshDb = join(dir, 'fresh.db')
    {
      const fresh = new SqliteUnifiedStore({ path: freshDb })
      fresh.close()
      fs.rmSync(`${freshDb}-wal`, { force: true })
      fs.rmSync(`${freshDb}-shm`, { force: true })
    }
    const replacedAt = performance.now()
    fs.renameSync(freshDb, db)

    // Pending wait returns and status shows stopped.reason === 'replaced' within 2,000 ms.
    const waitRes = await waitP
    expect(waitRes.events).toBe(0)

    let status: { dbOpens: number; bridge: { stopped: { reason: string } | null } | null } | null = null
    while (performance.now() - replacedAt < 2_000) {
      status = await child.call('status')
      if (status?.bridge?.stopped?.reason === 'replaced') break
      await new Promise((r) => setTimeout(r, 25))
    }
    const elapsed = performance.now() - replacedAt
    expect(elapsed).toBeLessThan(2_000)
    expect(status?.bridge?.stopped?.reason).toBe('replaced')
    expect(status?.dbOpens).toBe(1)

    await child.exit()
  }, 30_000)

  it('HS-129 immediate cross-process wake: 40 posts with 150-300 ms gaps arrive with p95 < 50 ms and max < 1500 ms', async () => {
    const dir = tmpDir()
    const db = join(dir, 'board.db')

    const store = new SqliteUnifiedStore({ path: db })
    stores.push(store)
    const bridge = new WakeBridge(store)
    bridges.push(bridge)
    const board = new BoardService(store, bridge.serviceOptions())
    board.createChannel(owner, { path: 'dev' })
    board.postMessage(owner, { channel: 'dev', text: 'seed' })
    bridge.start()

    const child = await spawnIpcChild({ path: db, bridge: false, userId: 'poster' })
    const count = 40
    let cursor = String(store.getHeadIndex())
    const lagsMs: number[] = []
    const seen = new Set<number>()

    const posterP = child.call('postSlow', {
      channel: 'dev',
      count,
      minGapMs: 150,
      maxGapMs: 300,
      tag: 'hs129',
    })

    while (seen.size < count) {
      const page = await board.getEvents(owner, { after: cursor, wait: 5 })
      const gotAt = process.hrtime.bigint()
      cursor = page.cursor
      for (const ev of page.events) {
        if (ev.type !== 'message.posted' || !ev.message) continue
        try {
          const parsed = JSON.parse(ev.message.text) as { tag?: string; seq?: number; t0?: string }
          if (parsed.tag === 'hs129' && typeof parsed.seq === 'number' && typeof parsed.t0 === 'string') {
            seen.add(parsed.seq)
            lagsMs.push(Number(gotAt - BigInt(parsed.t0)) / 1e6)
          }
        } catch {
          // ignore non-JSON messages
        }
      }
    }

    await posterP
    await child.exit()

    expect(seen.size).toBe(count)
    expect(lagsMs).toHaveLength(count)
    expect(percentile(lagsMs, 95)).toBeLessThan(50)
    expect(Math.max(...lagsMs)).toBeLessThan(1_500)
  }, 60_000)

  it('HS-130 poll-only bound: watch false + safetyPollMs 300 delivers all 40 posts within 500 ms with none missed', async () => {
    const dir = tmpDir()
    const db = join(dir, 'board.db')

    const store = new SqliteUnifiedStore({ path: db })
    stores.push(store)
    const bridge = new WakeBridge(store, { watch: false, safetyPollMs: 300 })
    bridges.push(bridge)
    const board = new BoardService(store, bridge.serviceOptions())
    board.createChannel(owner, { path: 'dev' })
    board.postMessage(owner, { channel: 'dev', text: 'seed' })
    bridge.start()

    const child = await spawnIpcChild({ path: db, bridge: false, userId: 'poster-poll' })
    const count = 40
    let cursor = String(store.getHeadIndex())
    const lagsMs: number[] = []
    const seen = new Set<number>()

    const posterP = child.call('postSlow', {
      channel: 'dev',
      count,
      minGapMs: 150,
      maxGapMs: 300,
      tag: 'hs130',
    })

    while (seen.size < count) {
      const page = await board.getEvents(owner, { after: cursor, wait: 5 })
      const gotAt = process.hrtime.bigint()
      cursor = page.cursor
      for (const ev of page.events) {
        if (ev.type !== 'message.posted' || !ev.message) continue
        try {
          const parsed = JSON.parse(ev.message.text) as { tag?: string; seq?: number; t0?: string }
          if (parsed.tag === 'hs130' && typeof parsed.seq === 'number' && typeof parsed.t0 === 'string') {
            seen.add(parsed.seq)
            lagsMs.push(Number(gotAt - BigInt(parsed.t0)) / 1e6)
          }
        } catch {
          // ignore
        }
      }
    }

    await posterP
    await child.exit()

    expect(seen.size).toBe(count)
    expect(lagsMs).toHaveLength(count)
    expect(Math.max(...lagsMs)).toBeLessThanOrEqual(300 + 200)
  }, 60_000)

  it('HS-131 6 writer children x 150 posts + 150 own posts, pageSize 7, safetyPollMs 200, 3 rounds: 0 missing, 0 duplicates', async () => {
    const dir = tmpDir()
    const db = join(dir, 'board.db')

    const store = new SqliteUnifiedStore({ path: db })
    stores.push(store)
    const board = new BoardService(store)
    board.createChannel(owner, { path: 'dev' })
    board.postMessage(owner, { channel: 'dev', text: 'seed' })

    const writers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => spawnIpcChild({ path: db, bridge: false, userId: `writer-${i}` })),
    )

    for (let round = 0; round < 3; round++) {
      let inOwn = false
      const ownIndices = new Set<number>()
      const foreignCounts = new Map<number, number>()
      const unsub = store.onEvent((ev) => {
        if (inOwn) {
          ownIndices.add(ev.index)
        } else {
          foreignCounts.set(ev.index, (foreignCounts.get(ev.index) ?? 0) + 1)
        }
      })

      const bridge = new WakeBridge(store, { pageSize: 7, safetyPollMs: 200 })
      bridges.push(bridge)
      const startCursor = store.getHeadIndex()
      bridge.start()

      const childPromises = writers.map((w, i) =>
        w.call('postSlow', {
          channel: 'dev',
          count: 150,
          minGapMs: 0,
          maxGapMs: 4,
          tag: `r${round}-w${i}`,
        }),
      )

      const ownPromise = (async () => {
        for (let i = 0; i < 150; i++) {
          const gap = Math.floor(Math.random() * 5)
          if (gap > 0) await new Promise((r) => setTimeout(r, gap))
          await withBusyRetry(() => {
            inOwn = true
            try {
              return board.postMessage(owner, { channel: 'dev', text: `r${round}-own-${i}` })
            } finally {
              inOwn = false
            }
          })
        }
      })()

      await Promise.all([...childPromises, ownPromise])

      // Wait for the bridge to drain naturally to head (via fs.watch + scheduled follow-ups).
      const head = store.getHeadIndex()
      const drainDeadline = performance.now() + 10_000
      while (store.sidecarHealth().external.cursor < head) {
        if (performance.now() > drainDeadline) {
          throw new Error(`round ${round}: bridge did not reach head ${head} (at ${store.sidecarHealth().external.cursor})`)
        }
        await new Promise((r) => setTimeout(r, 10))
      }

      const ext = store.sidecarHealth().external
      expect(ext.dropped, `round ${round} dropped`).toBe(0)
      expect(ext.cursor, `round ${round} cursor`).toBe(head)
      expect(ownIndices.size, `round ${round} own count`).toBeGreaterThanOrEqual(150)

      let missing = 0
      let dupes = 0
      let ownHeardAsForeign = 0
      for (let idx = startCursor + 1; idx <= head; idx++) {
        const fc = foreignCounts.get(idx) ?? 0
        if (ownIndices.has(idx)) {
          if (fc !== 0) ownHeardAsForeign += 1
        } else {
          if (fc === 0) missing += 1
          else if (fc !== 1) dupes += 1
        }
      }
      expect(missing, `round ${round} missing`).toBe(0)
      expect(dupes, `round ${round} duplicates`).toBe(0)
      expect(ownHeardAsForeign, `round ${round} own heard as foreign`).toBe(0)

      bridge.stop()
      unsub()
    }

    await Promise.all(writers.map((w) => w.exit()))
  }, 120_000)

  it('HS-133 cross-process task wake: parent bridged claimReady claims task created by child within 200 ms', async () => {
    const dir = tmpDir()
    const db = join(dir, 'board.db')

    const store = new SqliteUnifiedStore({ path: db })
    stores.push(store)
    const bridge = new WakeBridge(store)
    bridges.push(bridge)
    const board = new BoardService(store, bridge.serviceOptions())
    board.createChannel(owner, { path: 'jobs' })
    board.postMessage(owner, { channel: 'jobs', text: 'seed' })
    bridge.start()

    const child = await spawnIpcChild({ path: db, bridge: false, userId: 'alice' })

    const claimP = board.tasks.claimReady(owner, { channel: 'jobs', wait: 10 })
    await new Promise((r) => setTimeout(r, 50))

    const created = await child.call<{ taskId: string }>('createTask', { channel: 'jobs', text: 'cross-proc-job' })
    const childReturnedAt = performance.now()
    const claimed = await claimP
    const lagMs = performance.now() - childReturnedAt

    expect(claimed.task?.id).toBe(created.taskId)
    expect(lagMs).toBeLessThan(200)

    await child.exit()
  }, 30_000)

  it('HS-134 a child that starts a bridge and does nothing else exits on its own within 2,000 ms with code 0', async () => {
    const dir = tmpDir()
    const db = join(dir, 'board.db')
    {
      const init = new SqliteUnifiedStore({ path: db })
      const b = new BoardService(init)
      b.createChannel(owner, { path: 'dev' })
      b.postMessage(owner, { channel: 'dev', text: 'seed' })
      init.close()
    }

    const startedAt = performance.now()
    const proc = spawn(process.execPath, [CHILD, JSON.stringify({ mode: 'idleExit', path: db })], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(proc)
    let stderr = ''
    proc.stderr!.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new Error(`idleExit child did not exit within 2,000 ms (stderr: ${stderr})`))
      }, 2_000)
      proc.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal })
      })
    })
    const elapsed = performance.now() - startedAt
    expect(exit.code, stderr).toBe(0)
    expect(exit.signal).toBeNull()
    expect(elapsed).toBeLessThan(2_000)
  }, 15_000)
})
