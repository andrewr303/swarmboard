// HOST-0 stage 1, separate OS processes on one WAL file (HOST0_DESIGN section 5, kind `proc`): HT-09,
// HT-18, HT-21, HT-26, HT-27, HT-28. The parent creates the board file before any child starts (CR-5).
import { fork, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardService, createLocalCaller, SqliteUnifiedStore, toErrorPayload } from '../../../src/core/index.ts'

const CHILD = fileURLToPath(new URL('./store-child.ts', import.meta.url))

type Failure = { status: number; code: string; message: string }
type Reply = { id?: number; ok: boolean; value?: unknown; error?: Failure }

class Child {
  readonly proc: ChildProcess
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private next = 1
  private readonly pending = new Map<number, (r: Reply) => void>()

  private constructor(proc: ChildProcess, exited: Child['exited']) {
    this.proc = proc
    this.exited = exited
    proc.on('message', (raw) => {
      const m = raw as Reply
      if (m.id === undefined) return
      this.pending.get(m.id)?.(m)
      this.pending.delete(m.id)
    })
  }

  static start(path: string, extra: Record<string, unknown> = {}): Promise<Child> {
    const proc = fork(CHILD, [JSON.stringify({ path, ...extra })], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
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
      void exited.then(({ code, signal }) => reject(new Error(`child exited (${code ?? signal}) before it opened the board`)))
    })
  }

  send(op: string, fields: Record<string, unknown> = {}): Promise<Reply> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve)
      void this.exited.then(() => reject(new Error(`child exited before it answered ${op}`)))
      this.proc.send({ id, op, ...fields })
    })
  }

  async ask<T = unknown>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    const reply = await this.send(op, fields)
    if (!reply.ok) throw new Error(`${op} failed: ${JSON.stringify(reply.error)}`)
    return reply.value as T
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return
    try {
      await this.send('exit')
    } catch {
      // It went first.
    }
    await this.exited
  }
}

const dirs: string[] = []
const children: Child[] = []
const stores: SqliteUnifiedStore[] = []

/** A fresh board file, created (opened and closed) before any child starts. */
function board(): { path: string } {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-host0-proc-'))
  dirs.push(dir)
  const path = join(dir, 'board.db')
  new SqliteUnifiedStore({ path }).close()
  return { path }
}
const start = async (path: string, extra: Record<string, unknown> = {}): Promise<Child> => {
  const child = await Child.start(path, extra)
  children.push(child)
  return child
}

afterEach(async () => {
  vi.useRealTimers()
  for (const s of stores.splice(0)) s.close()
  await Promise.all(children.splice(0).map((c) => c.stop()))
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('HOST-0 stage 1 across processes', () => {
  it("HT-09 a child's commits reach the parent's waiter at once, exactly once", { timeout: 60_000 }, async () => {
    const { path } = board()
    const parent = new SqliteUnifiedStore({ path })
    stores.push(parent)
    const owner = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
    const boardP = new BoardService(parent)
    const child = await start(path)
    const heard: number[] = []
    parent.onEvent((e) => heard.push(e.index))
    parent.armExternalDispatch()
    const mine = (n: number): void => {
      for (let i = 0; i < n; i++) parent.appendEvent({ type: 'x', payload: { p: i } })
    }
    await child.ask('append', { n: 3 })
    mine(2)
    await child.ask('append', { n: 3 })
    mine(2)
    expect(parent.pumpExternal()).toMatchObject({ dispatched: 6, skippedOwn: 4 })
    expect([...heard].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const head = parent.getHeadIndex()
    let settled = false
    const waiting = boardP.getEvents(owner, { after: String(head), wait: 5 }).then((r) => {
      settled = true
      return r
    })
    await Promise.resolve()
    await child.ask('post', { text: 'from child' })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2)
    parent.pumpExternal()
    const page = await waiting
    expect(page.events.some((e) => e.message?.text === 'from child')).toBe(true)
  })

  it('HT-18 crash between COMMIT and the sidecars', { timeout: 60_000 }, async () => {
    const { path } = board()
    const parent = new SqliteUnifiedStore({ path })
    stores.push(parent)
    parent.appendEvent({ type: 'x', payload: {} })
    parent.appendEvent({ type: 'x', payload: {} })
    const child = await start(path)
    const reply = child.send('crashAppend', { tag: 'doomed' }).catch(() => null)
    expect((await child.exited).signal).toBe('SIGKILL')
    await reply
    expect(parent.getHeadIndex()).toBe(3)
    expect(parent.getEvents().events[2]!.payload).toEqual({ tag: 'doomed' })
    const jsonl = `${path}.jsonl`
    expect(fs.readFileSync(jsonl, 'utf8').split('\n').filter((l) => l !== '')).toHaveLength(2)
    expect(fs.readFileSync(`${path}.wakeup`).readBigUInt64LE(0)).toBe(2n)
    const raw = new DatabaseSync(path)
    expect(raw.prepare("SELECT value FROM board_meta WHERE key = 'wakeup_generation'").get()).toEqual({ value: '3' })
    raw.close()
    expect(parent.auditJsonl()).toMatchObject({ missing: 1, firstMissing: 3 })
    expect(parent.auditJsonl({ repair: true }).repaired).toBe(1)
    expect(parent.auditJsonl().missing).toBe(0)
    parent.appendEvent({ type: 'x', payload: {} })
    expect(fs.readFileSync(`${path}.wakeup`).readBigUInt64LE(0)).toBe(4n)
  })

  it('HT-21 many writers: the file is the log as a set', { timeout: 120_000 }, async () => {
    const { path } = board()
    const kids = await Promise.all(Array.from({ length: 8 }, () => start(path)))
    await Promise.all(kids.map((k) => k.ask('append', { n: 100 })))
    const store = new SqliteUnifiedStore({ path })
    stores.push(store)
    expect(store.getHeadIndex()).toBe(800)
    const audit = store.auditJsonl()
    console.log(`HT-21 inversions: ${audit.inversions}`)
    expect(audit).toMatchObject({ head: 800, present: 800, missing: 0, duplicates: 0, conflicts: 0, malformed: 0 })
    const fromFile = new Set(
      fs
        .readFileSync(`${path}.jsonl`, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => {
          const { index, id } = JSON.parse(l) as { index: number; id: string }
          return `${index}:${id}`
        }),
    )
    const fromLog = new Set<string>()
    for (let after = 0; ; ) {
      const { events } = store.getEvents({ after, limit: 500 })
      if (events.length === 0) break
      for (const e of events) fromLog.add(`${e.index}:${e.id}`)
      after = events[events.length - 1]!.index
    }
    expect(fromFile).toEqual(fromLog)
  })

  it('HT-26 eight processes race one CAS from absent', { timeout: 60_000 }, async () => {
    const { path } = board()
    const kids = await Promise.all(Array.from({ length: 8 }, () => start(path)))
    const results = await Promise.all(kids.map((k) => k.ask<boolean>('casMeta', { key: 'host.test.owner', expected: null, next: String(k.proc.pid) })))
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = kids[results.indexOf(true)]!.proc.pid
    for (const k of kids) expect(await k.ask('getMeta', { key: 'host.test.owner' })).toBe(String(winner))
  })

  it('HT-27 no lost update', { timeout: 120_000 }, async () => {
    const { path } = board()
    const kids = await Promise.all(Array.from({ length: 8 }, () => start(path)))
    const counts = await Promise.all(kids.map((k) => k.ask<number>('casIncrement', { key: 'host.test.n', rounds: 100 })))
    expect(counts).toEqual(Array(8).fill(100))
    expect(await kids[0]!.ask('getMeta', { key: 'host.test.n' })).toBe('800')
  })

  it('HT-28 a busy lock is a retryable 503', { timeout: 60_000 }, async () => {
    const { path } = board()
    const parent = new SqliteUnifiedStore({ path, busyTimeoutMs: 20 })
    stores.push(parent)
    const child = await start(path)
    expect(await child.ask('hold', { ms: 400 })).toEqual({ held: true })
    let caught: unknown
    try {
      parent.casMeta('host.k', undefined, 'v')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect(toErrorPayload(caught)).toMatchObject({ status: 503, payload: { error: { code: 'unavailable' } } })
    expect(toErrorPayload(caught).retryAfter).toBe(1)
    expect(parent.getMeta('host.k')).toBeUndefined()
    await new Promise((r) => setTimeout(r, 500))
    expect(parent.casMeta('host.k', undefined, 'v')).toBe(true)
  })
})
