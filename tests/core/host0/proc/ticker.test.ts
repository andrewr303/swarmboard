// HOST-0 stage 3, tickers in separate OS processes on one WAL file (HOST0_DESIGN section 5, kind `proc` and
// `fault`): HT-78, HT-92, HT-93 and HT-94. The parent creates the board file before any child starts.
import { fork, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../../../src/core/index.ts'
import { readTickLease } from '../../../../src/core/tick-lease.ts'
import { tempBoard } from '../../tasks/proc/harness.ts'

const TICKER = fileURLToPath(new URL('./ticker-child.ts', import.meta.url))
const T0 = Date.parse('2026-11-22T12:00:00.000Z')
const alice = createLocalCaller({ userId: 'alice', handle: 'alice', member: true })

type Tick = { sent: string[]; failed: number; skipped: string[]; stopped: boolean }
type Acq = { acquired: boolean; holder?: string; fence?: number; takeover?: boolean; lease?: { holder: string; fence: number } }

/** A ticker child (ticker-child.ts), driven over IPC. */
class Child {
  readonly proc: ChildProcess
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private next = 1
  private readonly pending = new Map<number, (r: { ok: boolean; value?: unknown; error?: unknown }) => void>()

  private constructor(proc: ChildProcess, exited: Child['exited']) {
    this.proc = proc
    this.exited = exited
    proc.on('message', (raw) => {
      const m = raw as { id?: number; ok: boolean; value?: unknown; error?: unknown }
      if (m.id === undefined) return
      this.pending.get(m.id)?.(m)
      this.pending.delete(m.id)
    })
  }

  static start(path: string, extra: Record<string, unknown> = {}): Promise<Child> {
    const proc = fork(TICKER, [JSON.stringify({ path, ...extra })], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once('exit', (code, signal) => resolve({ code, signal })),
    )
    return new Promise((resolve, reject) => {
      const onMessage = (raw: unknown): void => {
        if (!(raw as { ready?: boolean }).ready) return
        proc.off('message', onMessage)
        resolve(new Child(proc, exited))
      }
      proc.on('message', onMessage)
      void exited.then(({ code, signal }) => reject(new Error(`ticker exited (${code ?? signal}) before it opened the board`)))
    })
  }

  send(op: string, fields: Record<string, unknown> = {}): Promise<{ ok: boolean; value?: unknown; error?: unknown }> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve)
      void this.exited.then(() => reject(new Error(`ticker exited before it answered ${op}`)))
      this.proc.send({ id, op, ...fields })
    })
  }

  async ask<T = unknown>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    const reply = await this.send(op, fields)
    if (!reply.ok) throw new Error(`${op} failed: ${JSON.stringify(reply.error)}`)
    return reply.value as T
  }
}

const boards: Array<{ dispose(): void }> = []
const children: Child[] = []

afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill('SIGKILL')
    await c.exited
  }
  for (const b of boards.splice(0)) b.dispose()
})

/** A board file with one every-minute schedule, created (opened and closed) before any child starts. */
function setup(schedules = 1): { path: string; dir: string; ids: string[] } {
  const b = tempBoard()
  boards.push(b)
  const store = new SqliteUnifiedStore({ path: b.path })
  const board = new BoardService(store)
  const ids: string[] = []
  for (let i = 0; i < schedules; i++) ids.push(board.createSchedule(alice, { channel: 'dev', text: 'tick', in: '1m', every: '1m' }, T0).id)
  store.close()
  return { path: b.path, dir: join(b.path, '..'), ids }
}

async function start(path: string, extra: Record<string, unknown> = {}): Promise<Child> {
  const child = await Child.start(path, extra)
  children.push(child)
  return child
}

const waitFor = async (file: string, ms = 20_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const countDev = (path: string): { messages: number; next_at: number | null; sent: number } => {
  const s = new SqliteUnifiedStore({ path })
  try {
    const messages = (s.db.prepare("SELECT COUNT(*) AS n FROM board_messages WHERE channel = 'dev'").get() as { n: number }).n
    const r = s.db.prepare("SELECT next_at, data FROM board_schedules WHERE id = 's1'").get() as { next_at: number | null; data: string }
    return { messages, next_at: r.next_at === null ? null : Number(r.next_at), sent: (JSON.parse(r.data) as { sent: number }).sent }
  } finally {
    s.close()
  }
}

describe('C7 tickers in separate processes', () => {
  it('HT-78 two processes racing one due schedule send it once', async () => {
    const { path, dir } = setup()
    const gate = { ready: join(dir, 'ready'), go: join(dir, 'go') }
    const b = await start(path, { gate })
    const a = await start(path)
    await b.ask('arm', { what: 'gate' })
    const bTick = b.ask<Tick>('tick', { nowMs: T0 + 60_000 })
    await waitFor(gate.ready)
    const aRun = await a.ask<Tick>('tick', { nowMs: T0 + 60_000 })
    fs.writeFileSync(gate.go, '1')
    const bRun = await bTick
    expect(aRun.sent).toEqual(['board-schedule:1:0'])
    expect(bRun.sent).toEqual([])
    expect(bRun.skipped).toEqual(['s1'])
    const state = countDev(path)
    expect(state.messages).toBe(1)
    expect(state.next_at).toBe(T0 + 120_000)
  }, 60_000)

  it('HT-92 eight processes contend for the lease and exactly one holds it', async () => {
    const { path, dir } = setup(0)
    const kids = await Promise.all(Array.from({ length: 8 }, () => start(path)))
    const startFile = join(dir, 'start')
    const replies = kids.map((k, i) => k.ask<Acq>('acquire', { holder: `p${i}`, ttlMs: 60_000, nowMs: T0, start: startFile }))
    await new Promise((r) => setTimeout(r, 100))
    fs.writeFileSync(startFile, '1')
    const results = await Promise.all(replies)
    const winners = results.map((r, i) => ({ r, i })).filter((x) => x.r.acquired)
    expect(winners).toHaveLength(1)
    const winner = `p${winners[0]!.i}`
    expect(winners[0]!.r.lease).toMatchObject({ holder: winner, fence: 1 })
    for (const r of results.filter((x) => !x.acquired)) expect(r.holder).toBe(winner)
    expect(results.filter((x) => !x.acquired)).toHaveLength(7)
    const s = new SqliteUnifiedStore({ path })
    try {
      expect(readTickLease(s)?.holder).toBe(winner)
    } finally {
      s.close()
    }
  }, 90_000)

  it('HT-93 a holder killed mid-fire sends nothing, and its successor takes over after the ttl and sends once', async () => {
    const { path } = setup()
    const TA = T0 + 60_000
    const a = await start(path)
    expect(await a.ask<Acq>('acquire', { holder: 'A', ttlMs: 30_000, nowMs: TA })).toMatchObject({ acquired: true })
    await a.ask('arm', { what: 'crash' })
    const dying = a.send('tick', { nowMs: T0 + 60_000 }).catch(() => null)
    const exit = await a.exited
    await dying
    expect(exit.signal).toBe('SIGKILL')
    const state = countDev(path)
    expect(state).toEqual({ messages: 0, next_at: T0 + 60_000, sent: 0 })
    const s = new SqliteUnifiedStore({ path })
    try {
      expect(readTickLease(s)).toMatchObject({ holder: 'A', fence: 1 })
    } finally {
      s.close()
    }
    const b = await start(path)
    expect(await b.ask<Acq>('acquire', { holder: 'B', ttlMs: 30_000, nowMs: TA + 29_999 })).toMatchObject({ acquired: false, holder: 'A' })
    expect(await b.ask<Acq>('acquire', { holder: 'B', ttlMs: 30_000, nowMs: TA + 30_000 })).toMatchObject({
      acquired: true,
      takeover: true,
      lease: { fence: 2 },
    })
    expect((await b.ask<Tick>('tick', { nowMs: T0 + 60_000 })).sent).toEqual(['board-schedule:1:0'])
    expect(countDev(path).messages).toBe(1)
  }, 60_000)

  it('HT-94 a holder killed during acquire leaves no lease', async () => {
    const { path } = setup(0)
    const a = await start(path)
    await a.ask('arm', { what: 'crash' })
    const dying = a.send('acquire', { holder: 'A', ttlMs: 30_000, nowMs: T0 }).catch(() => null)
    const exit = await a.exited
    await dying
    expect(exit.signal).toBe('SIGKILL')
    const s = new SqliteUnifiedStore({ path })
    try {
      expect(readTickLease(s)).toBeNull()
    } finally {
      s.close()
    }
    const b = await start(path)
    expect(await b.ask<Acq>('acquire', { holder: 'B', ttlMs: 30_000, nowMs: T0 })).toMatchObject({ acquired: true, lease: { fence: 1 } })
  }, 60_000)
})
