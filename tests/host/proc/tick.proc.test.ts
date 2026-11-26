// HOST123_DESIGN Stage B8 multi-process Ticker tests (HS-153..HS-155).
// Multi-process tests are sleep-sensitive (H0 errata): re-run this file alone before debugging a timeout.
import { fork, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../../src/core/public.ts'
import { readTickLease } from '../../../src/core/internal.ts'
import type { TickerStatus, TickReport } from '../../../src/host/tick.ts'

const CHILD = fileURLToPath(new URL('./tick-child.ts', import.meta.url))
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0)
const alice = createLocalCaller({ userId: 'alice', handle: 'alice', member: true, owner: true })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class VirtualClock {
  readonly path: string
  private readonly fd: number
  private current: number

  constructor(dir: string, initialMs: number) {
    this.path = join(dir, 'vclock.bin')
    this.fd = fs.openSync(this.path, 'w+')
    this.current = initialMs
    this.write(initialMs)
  }

  get ms(): number {
    return this.current
  }

  write(ms: number): void {
    this.current = ms
    const buf = Buffer.alloc(8)
    buf.writeBigInt64LE(BigInt(ms), 0)
    fs.writeSync(this.fd, buf, 0, 8, 0)
  }

  close(): void {
    try {
      fs.closeSync(this.fd)
    } catch {
      // already closed
    }
  }
}

interface ReportEvent {
  pid: number
  holder: string
  report: TickReport
}

class LoopChild {
  readonly proc: ChildProcess
  readonly pid: number
  readonly holder: string
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  readonly reports: ReportEvent[] = []
  private nextId = 1
  private readonly pending = new Map<number, (r: { ok: boolean; value?: unknown; error?: string }) => void>()
  private readonly reportWaiters: Array<(ev: ReportEvent) => void> = []

  private constructor(
    proc: ChildProcess,
    pid: number,
    holder: string,
    exited: LoopChild['exited'],
  ) {
    this.proc = proc
    this.pid = pid
    this.holder = holder
    this.exited = exited
    proc.on('message', (raw) => {
      const m = raw as { id?: number; type?: string; ok?: boolean; value?: unknown; error?: string; pid?: number; holder?: string; report?: TickReport }
      if (m.type === 'report' && m.report && m.holder !== undefined && m.pid !== undefined) {
        const ev: ReportEvent = { pid: m.pid, holder: m.holder, report: m.report }
        this.reports.push(ev)
        for (const fn of this.reportWaiters.splice(0)) fn(ev)
        return
      }
      if (m.id !== undefined) {
        this.pending.get(m.id)?.({ ok: Boolean(m.ok), value: m.value, error: m.error })
        this.pending.delete(m.id)
      }
    })
  }

  static start(config: Record<string, unknown>): Promise<LoopChild> {
    const proc = fork(CHILD, [JSON.stringify({ mode: 'loop', ...config })], {
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once('exit', (code, signal) => resolve({ code, signal })),
    )
    return new Promise((resolve, reject) => {
      const onMsg = (raw: unknown): void => {
        const m = raw as { type?: string; pid?: number; holder?: string }
        if (m.type !== 'ready' || typeof m.pid !== 'number' || typeof m.holder !== 'string') return
        proc.off('message', onMsg)
        resolve(new LoopChild(proc, m.pid, m.holder, exited))
      }
      proc.on('message', onMsg)
      void exited.then(({ code, signal }) =>
        reject(new Error(`tick-child exited (${code ?? signal}) before becoming ready`)),
      )
    })
  }

  ask<T = unknown>(op: 'start' | 'stop' | 'status' | 'exit'): Promise<T> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => {
        if (r.ok) resolve(r.value as T)
        else reject(new Error(`${op} failed: ${r.error}`))
      })
      void this.exited.then(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`tick-child exited before answering ${op}`))
        }
      })
      this.proc.send({ id, op })
    })
  }

  waitForReport(predicate: (ev: ReportEvent) => boolean, timeoutMs = 15_000): Promise<ReportEvent> {
    const existing = this.reports.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for TickReport')), timeoutMs)
      const check = (ev: ReportEvent): void => {
        if (predicate(ev)) {
          clearTimeout(timer)
          resolve(ev)
        } else {
          this.reportWaiters.push(check)
        }
      }
      this.reportWaiters.push(check)
    })
  }
}

interface OneShotResult {
  pid: number
  holder: string
  report: TickReport
  begins: number
  status: TickerStatus
}

function runOneShotChild(config: Record<string, unknown>): Promise<OneShotResult> {
  const proc = fork(CHILD, [JSON.stringify({ mode: 'once', ...config })], {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = ''
  let stderr = ''
  proc.stdout!.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
  proc.stderr!.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
  return new Promise((resolve, reject) => {
    proc.once('exit', (code, signal) => {
      if (code !== 0) {
        return reject(new Error(`one-shot tick-child exited ${code ?? signal}: ${stderr}`))
      }
      const line = stdout.trim().split('\n').filter(Boolean).at(-1)
      if (!line) return reject(new Error(`one-shot tick-child produced no output: ${stderr}`))
      resolve(JSON.parse(line) as OneShotResult)
    })
  })
}

const dirs: string[] = []
const clocks: VirtualClock[] = []
const stores: SqliteUnifiedStore[] = []
const children: LoopChild[] = []

function setupBoard(scheduleCount: number): { dir: string; path: string; clock: VirtualClock } {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cb-tick-proc-')))
  dirs.push(dir)
  const path = join(dir, 'board.db')
  const clock = new VirtualClock(dir, T0)
  clocks.push(clock)
  const store = new SqliteUnifiedStore({ path })
  const board = new BoardService(store, { now: () => T0 })
  board.createChannel(alice, { path: 'dev' })
  for (let i = 0; i < scheduleCount; i++) {
    board.createSchedule(alice, { channel: 'dev', text: `sched-${i + 1}`, in: '1m', every: '1m' }, T0)
  }
  store.close()
  return { dir, path, clock }
}

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 15_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(stepMs)
  }
}

afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.proc.exitCode === null && c.proc.signalCode === null) {
      try {
        await Promise.race([c.ask('exit'), sleep(1_000)])
      } catch {
        // fall through to kill
      }
      if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill('SIGKILL')
    }
    await c.exited
  }
  for (const s of stores.splice(0)) {
    try {
      s.close()
    } catch {
      // already closed
    }
  }
  for (const clk of clocks.splice(0)) clk.close()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('Ticker multi-process coordination (HS-153..HS-155)', () => {
  it('HS-153 6 ticker processes over 20 periods x 10 schedules deliver 200 contiguous sends with single live lease holder', async () => {
    const { path, clock } = setupBoard(10)
    const obsStore = new SqliteUnifiedStore({ path })
    stores.push(obsStore)

    const kids = await Promise.all(
      Array.from({ length: 6 }, () =>
        LoopChild.start({ path, clockFile: clock.path, intervalMs: 50, ttlMs: 1_000 }),
      ),
    )
    children.push(...kids)

    // Wait for an initial lease at T0 before advancing periods.
    await waitUntil(() => readTickLease(obsStore) !== null, 'initial lease acquisition', 10_000)

    const leaseSamples: Array<{ clock: number; holder: string | null; until: number; fence: number }> = []
    const sampleLease = (): void => {
      const c = clock.ms
      const rec = readTickLease(obsStore)
      leaseSamples.push({
        clock: c,
        holder: rec && rec.until > c ? rec.holder : null,
        until: rec?.until ?? 0,
        fence: rec?.fence ?? 0,
      })
    }

    // Advance clock 60 s every 300 ms for 20 periods, taking 5 samples per period (= 100 samples).
    for (let period = 1; period <= 20; period++) {
      clock.write(T0 + period * 60_000)
      for (let s = 0; s < 5; s++) {
        await sleep(60)
        sampleLease()
      }
    }
    await sleep(1_000)

    expect(leaseSamples).toHaveLength(100)
    // Every sample has at most one live holder (and fences are non-decreasing).
    let maxFence = 0
    for (const s of leaseSamples) {
      expect(s.fence).toBeGreaterThanOrEqual(maxFence)
      maxFence = s.fence
      if (s.holder !== null) {
        expect(s.until).toBeGreaterThan(s.clock)
      }
    }
    expect(leaseSamples.some((s) => s.holder !== null)).toBe(true)

    // Every fence number was held by at most one distinct holder across all 6 processes.
    const holdersByFence = new Map<number, Set<string>>()
    for (const c of kids) {
      for (const ev of c.reports) {
        if (ev.report.outcome === 'ran' && ev.report.fence !== null) {
          const set = holdersByFence.get(ev.report.fence) ?? new Set<string>()
          set.add(ev.holder)
          holdersByFence.set(ev.report.fence, set)
        }
      }
    }
    expect(holdersByFence.size).toBeGreaterThan(0)
    for (const [fence, holders] of holdersByFence) {
      expect(holders.size, `multiple holders claimed fence ${fence}`).toBe(1)
    }

    // Stop all children cleanly before inspecting final messages.
    await Promise.all(kids.map((c) => c.ask('exit')))
    await Promise.all(kids.map((c) => c.exited))

    const rows = obsStore.db
      .prepare("SELECT id, thread, data FROM board_messages WHERE channel = 'dev' ORDER BY id")
      .all() as Array<{ id: number; thread: string; data: string }>
    expect(rows).toHaveLength(200)

    const bySeq = new Map<number, Array<{ n: number; period: number; thread: string }>>()
    for (const row of rows) {
      const m = /^board-schedule:(\d+):(\d+)$/.exec(row.thread)
      expect(m, row.thread).not.toBeNull()
      const seq = Number(m![1])
      const n = Number(m![2])
      const createdAt = (JSON.parse(row.data) as { createdAt: string }).createdAt
      const period = Math.floor((Date.parse(createdAt) - T0) / 60_000)
      const list = bySeq.get(seq) ?? []
      list.push({ n, period, thread: row.thread })
      bySeq.set(seq, list)
    }

    expect(bySeq.size).toBe(10)
    for (let seq = 1; seq <= 10; seq++) {
      const list = bySeq.get(seq) ?? []
      expect(list.map((x) => x.thread)).toEqual(Array.from({ length: 20 }, (_, n) => `board-schedule:${seq}:${n}`))
      const periods = list.map((x) => x.period)
      expect(new Set(periods).size).toBe(20)
    }
  }, 60_000)

  it('HS-154 SIGKILLing the lease holder at period 8 hands over at until with fence + 1 and zero duplicates', async () => {
    const { path, clock } = setupBoard(10)
    const obsStore = new SqliteUnifiedStore({ path })
    stores.push(obsStore)

    const kids = await Promise.all(
      Array.from({ length: 6 }, () =>
        LoopChild.start({ path, clockFile: clock.path, intervalMs: 50, ttlMs: 1_000 }),
      ),
    )
    children.push(...kids)

    await waitUntil(() => readTickLease(obsStore) !== null, 'initial lease acquisition', 10_000)

    for (let period = 1; period <= 20; period++) {
      const periodClock = T0 + period * 60_000
      clock.write(periodClock)

      if (period === 8) {
        // Wait until a live holder owns the lease at period 8, then SIGKILL it.
        await waitUntil(() => {
          const rec = readTickLease(obsStore)
          return rec !== null && rec.until > periodClock
        }, 'period 8 live lease')
        const deadLease = readTickLease(obsStore)!
        const holderPid = Number(deadLease.holder.split(':')[1])
        const victim = kids.find((k) => k.pid === holderPid)
        expect(victim, `holder pid ${holderPid} not found among children`).toBeDefined()

        victim!.proc.kill('SIGKILL')
        const exit = await victim!.exited
        expect(exit.signal).toBe('SIGKILL')

        // As soon as virtual clock reaches deadLease.until, another child takes over with fence + 1.
        clock.write(deadLease.until)
        await waitUntil(() => {
          const rec = readTickLease(obsStore)
          return rec !== null && rec.holder !== deadLease.holder && rec.until > deadLease.until
        }, 'successor takeover after SIGKILL', 10_000)
        const successor = readTickLease(obsStore)!
        expect(successor.holder).not.toBe(deadLease.holder)
        expect(successor.fence).toBe(deadLease.fence + 1)

        await sleep(300)
      } else {
        await sleep(300)
      }
    }
    await sleep(1_000)

    const survivors = kids.filter((c) => c.proc.exitCode === null && c.proc.signalCode === null)
    await Promise.all(survivors.map((c) => c.ask('exit')))
    await Promise.all(survivors.map((c) => c.exited))

    const rows = obsStore.db
      .prepare("SELECT thread, data FROM board_messages WHERE channel = 'dev' ORDER BY id")
      .all() as Array<{ thread: string; data: string }>
    expect(rows.length).toBeGreaterThanOrEqual(190)

    const seenPairs = new Set<string>()
    const periodsBySeq = new Map<number, number[]>()
    for (const row of rows) {
      const m = /^board-schedule:(\d+):(\d+)$/.exec(row.thread)
      expect(m, row.thread).not.toBeNull()
      expect(seenPairs.has(row.thread), `duplicate ${row.thread}`).toBe(false)
      seenPairs.add(row.thread)
      const seq = Number(m![1])
      const createdAt = (JSON.parse(row.data) as { createdAt: string }).createdAt
      const period = Math.floor((Date.parse(createdAt) - T0) / 60_000)
      const list = periodsBySeq.get(seq) ?? []
      list.push(period)
      periodsBySeq.set(seq, list)
    }

    expect(periodsBySeq.size).toBe(10)
    for (let seq = 1; seq <= 10; seq++) {
      const periods = periodsBySeq.get(seq) ?? []
      expect(periods.length).toBeGreaterThan(0)
      for (let i = 1; i < periods.length; i++) {
        expect(periods[i]!, `seq ${seq} period order`).toBeGreaterThan(periods[i - 1]!)
      }
    }

    const finalClock = clock.ms
    const schedRows = obsStore.db.prepare('SELECT id, next_at FROM board_schedules ORDER BY seq').all() as Array<{
      id: string
      next_at: number | null
    }>
    expect(schedRows).toHaveLength(10)
    for (const s of schedRows) {
      expect(s.next_at).not.toBeNull()
      expect(Number(s.next_at)).toBeGreaterThan(finalClock - 60_000)
    }
  }, 60_000)

  it('HS-155 one-shot runOnce alongside a live holder gets not_holder (0 BEGIN IMMEDIATE), then ran immediately after stop()', async () => {
    const { path, clock } = setupBoard(0)
    const obsStore = new SqliteUnifiedStore({ path })
    stores.push(obsStore)

    // Long-lived child holds the lease with a long TTL (20 s).
    const holderChild = await LoopChild.start({ path, clockFile: clock.path, intervalMs: 200, ttlMs: 20_000 })
    children.push(holderChild)

    const firstRan = await holderChild.waitForReport((ev) => ev.report.outcome === 'ran')
    expect(firstRan.report.fence).toBe(1)

    // Fresh one-shot process while holder holds the lease: not_holder with 0 BEGIN IMMEDIATE.
    const blocked = await runOneShotChild({ path, clockFile: clock.path, intervalMs: 200, ttlMs: 20_000 })
    expect(blocked.report.outcome).toBe('not_holder')
    expect(blocked.report.holder).toBe(holderChild.holder)
    expect(blocked.begins).toBe(0)

    // Holder calls stop() (writes until: 0 without advancing the virtual clock!).
    const stoppedStatus = await holderChild.ask<TickerStatus>('stop')
    expect(stoppedStatus.state).toBe('stopped')
    expect(readTickLease(obsStore)).toMatchObject({ holder: holderChild.holder, fence: 1, until: 0 })

    // Fresh one-shot process runs immediately (same virtual clock, no TTL wait) -> ran, then releases on stop().
    const takeover = await runOneShotChild({ path, clockFile: clock.path, intervalMs: 200, ttlMs: 20_000 })
    expect(takeover.report.outcome).toBe('ran')
    expect(takeover.report.holder).toBe(takeover.holder)
    expect(takeover.report.fence).toBe(2)
    expect(takeover.status.state).toBe('stopped')
    expect(readTickLease(obsStore)).toMatchObject({
      holder: takeover.holder,
      fence: 2,
      until: 0,
    })

    await holderChild.ask('exit')
    await holderChild.exited
  }, 60_000)
})
