// HOST-0 stage 1 (HOST0_DESIGN section 5): C1 external dispatch, C2 post-commit reporting and repair, C8
// .jsonl order, the meta helpers. HT-09, HT-18, HT-21 and HT-26..HT-28 (separate processes) are in
// store-proc.test.ts.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  type SqliteStoreOptions,
  type StoredEvent,
} from '../../../src/core/index.ts'
import { RESERVED_META_KEYS } from '../../../src/core/meta-keys.ts'

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-host0-'))
  dirs.push(dir)
  return dir
}

function open(path: string, extra: Partial<SqliteStoreOptions> = {}): SqliteUnifiedStore {
  const store = new SqliteUnifiedStore({ path, ...extra })
  stores.push(store)
  return store
}

/** Two stores (A, B) on one temp file. */
function pair(extra: Partial<SqliteStoreOptions> = {}): { dir: string; path: string; a: SqliteUnifiedStore; b: SqliteUnifiedStore } {
  const dir = tempDir()
  const path = join(dir, 'board.db')
  const a = open(path, extra)
  const b = open(path)
  return { dir, path, a, b }
}

const ev = (n = 0): { type: string; payload: Record<string, unknown> } => ({ type: 'x', payload: { n } })
const append = (s: SqliteUnifiedStore, count: number, tag = 'b'): void => {
  for (let i = 0; i < count; i++) s.appendEvent({ type: 'x', payload: { tag, i } })
}
const heardBy = (s: SqliteUnifiedStore): number[] => {
  const heard: number[] = []
  s.onEvent((e) => heard.push(e.index))
  return heard
}
const lineIndices = (path: string): number[] =>
  fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { index: number }).index)

afterEach(() => {
  vi.useRealTimers()
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('C1 external dispatch', () => {
  it('HT-01 arming contract', () => {
    const dir = tempDir()
    const store = open(join(dir, 'b.db'))
    append(store, 3)
    expect(store.armExternalDispatch()).toBe(3)
    expect(store.armExternalDispatch()).toBe(3)
    expect(store.sidecarHealth().external).toEqual({ armed: true, cursor: 3, tracked: 0, dropped: 0, dispatched: 0 })
    store.disarmExternalDispatch()
    expect(() => store.dispatchExternal([])).toThrow(TypeError)
    expect(() => store.dispatchExternal([])).toThrow(/not armed/)
    expect(() => store.pumpExternal()).toThrow(/not armed/)
    store.armExternalDispatch()
    const heard = heardBy(store)
    expect(() => store.transaction(() => store.pumpExternal())).toThrow(/inside a transaction/)
    expect(() => store.transaction(() => store.armExternalDispatch())).toThrow(/inside a transaction/)
    expect(heard).toEqual([])
    store.close()
    for (const call of [() => store.armExternalDispatch(), () => store.pumpExternal()]) {
      expect(call).toThrow(BoardError)
      try {
        call()
      } catch (e) {
        expect(e).toMatchObject({ status: 503, code: 'unavailable' })
      }
    }
    expect(() => store.disarmExternalDispatch()).not.toThrow()
  })

  it("HT-02 another connection's events reach A's listeners once", () => {
    const { a, b } = pair()
    a.armExternalDispatch()
    const heard: StoredEvent[] = []
    a.onEvent((e) => heard.push(e))
    append(b, 5)
    expect(heard).toEqual([])
    expect(a.pumpExternal()).toEqual({ dispatched: 5, skippedOwn: 0, skippedSeen: 0, cursor: 5, more: false })
    expect(heard.map((e) => e.index)).toEqual([1, 2, 3, 4, 5])
    expect(heard).toEqual(b.getEvents().events)
    expect(a.pumpExternal().dispatched).toBe(0)
    expect(heard).toHaveLength(5)
  })

  it('HT-03 own events are never dispatched twice', () => {
    const { a, b } = pair()
    a.armExternalDispatch()
    const heard = heardBy(a)
    append(a, 1, 'a')
    append(b, 1)
    append(a, 1, 'a')
    append(b, 1)
    append(a, 1, 'a')
    expect(heard).toEqual([1, 3, 5])
    expect(a.sidecarHealth().external.tracked).toBe(3)
    const r = a.pumpExternal()
    expect(r).toMatchObject({ dispatched: 2, skippedOwn: 3 })
    expect(heard).toEqual([1, 3, 5, 2, 4])
    expect([...heard].sort()).toEqual([1, 2, 3, 4, 5])
    expect(a.sidecarHealth().external.tracked).toBe(0)
  })

  it('HT-04 replays, overlaps and bad pages', () => {
    const { dir, a, b } = pair()
    a.armExternalDispatch()
    const heard = heardBy(a)
    append(b, 4)
    const page = a.getEvents().events
    expect(a.dispatchExternal(page.slice(0, 2)).dispatched).toBe(2)
    expect(a.dispatchExternal(page)).toMatchObject({ dispatched: 2, skippedSeen: 2 })
    expect(a.dispatchExternal(page)).toMatchObject({ dispatched: 0, skippedSeen: 4 })
    expect(heard).toEqual([1, 2, 3, 4])
    expect(() => a.dispatchExternal([page[1]!, page[0]!])).toThrow(/strictly ascending/)
    expect(() => a.dispatchExternal([page[0]!, page[0]!])).toThrow(TypeError)
    expect(heard).toEqual([1, 2, 3, 4])
    append(b, 2)
    const all = a.getEvents().events
    expect(a.dispatchExternal([all[5]!]).dispatched).toBe(1)
    expect(a.pumpExternal().dispatched).toBe(0)
    expect(heard).toEqual([1, 2, 3, 4, 6])
    // SEC-3: beyond the head, and another board's event at a valid index.
    expect(a.sidecarHealth().external.cursor).toBe(6)
    expect(() => a.dispatchExternal([{ ...all[5]!, index: 1006 }])).toThrow(/beyond the log head/)
    append(b, 1)
    const other = open(join(dir, 'other.db'))
    append(other, 7, 'other')
    const foreign = other.getEvents().events[6]!
    expect(foreign.index).toBe(7)
    expect(() => a.dispatchExternal([foreign])).toThrow(/not this board/)
    expect(heard).toEqual([1, 2, 3, 4, 6])
    expect(a.sidecarHealth().external.cursor).toBe(6)
    expect(a.pumpExternal().dispatched).toBe(1)
    expect(heard).toEqual([1, 2, 3, 4, 6, 7])
  })

  it('HT-05 the pump writes nothing', () => {
    const begins = { n: 0 }
    const { path, a, b } = pair({ testHooks: { onBeginImmediate: () => begins.n++ } })
    a.armExternalDispatch()
    append(b, 10)
    const spy = vi.spyOn(a, 'transaction')
    const snapshot = (): unknown => {
      const raw = new DatabaseSync(path)
      try {
        return {
          events: raw.prepare('SELECT COUNT(*) AS n FROM board_events').get(),
          meta: raw.prepare('SELECT key, value FROM board_meta ORDER BY key').all(),
          jsonl: fs.readFileSync(`${path}.jsonl`),
          wakeup: fs.readFileSync(`${path}.wakeup`),
          gen: a.getWakeupGeneration(),
          health: { ...a.sidecarHealth(), external: null },
        }
      } finally {
        raw.close()
      }
    }
    const before = snapshot()
    begins.n = 0
    expect(a.pumpExternal().dispatched).toBe(10)
    expect(snapshot()).toEqual(before)
    expect(begins.n).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('HT-06 a throwing listener during dispatch', () => {
    const reported: Array<[string, string]> = []
    const { a, b } = pair({ onSidecarError: (e, step) => reported.push([step, (e as Error).message]) })
    a.armExternalDispatch()
    const l1: number[] = []
    const l3: number[] = []
    a.onEvent((e) => l1.push(e.index))
    a.onEvent(() => {
      throw new Error('boom')
    })
    a.onEvent((e) => l3.push(e.index))
    append(b, 3)
    expect(a.pumpExternal().dispatched).toBe(3)
    expect(l1).toEqual([1, 2, 3])
    expect(l3).toEqual([1, 2, 3])
    expect(reported).toEqual([['listener', 'boom'], ['listener', 'boom'], ['listener', 'boom']])
    expect(a.sidecarHealth()).toMatchObject({ listenerFailures: 3, failures: 0, last: { step: 'listener' }, degraded: false })
    append(b, 1)
    expect(a.pumpExternal().dispatched).toBe(1)
  })

  it('HT-07 getEvents(wait) on A wakes through the hook, not its poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { a, b } = pair()
    const owner = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
    const boardA = new BoardService(a)
    const boardB = new BoardService(b)
    boardB.postMessage(owner, { channel: 'dev', text: 'first' })
    a.armExternalDispatch()
    const head = a.getHeadIndex()
    let settled = false
    const waiting = boardA.getEvents(owner, { after: String(head), wait: 5 }).then((r) => {
      settled = true
      return r
    })
    await Promise.resolve()
    boardB.postMessage(owner, { channel: 'dev', text: 'from B' })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2)
    a.pumpExternal()
    const page = await waiting
    expect(page.events.some((e) => e.message?.text === 'from B')).toBe(true)
  })

  it('HT-08 a claimReady waiter on A wakes through the hook', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const owner = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
    const turn = (): Promise<void> => new Promise((r) => setImmediate(r))
    const run = async (pump: boolean): Promise<{ settledEarly: boolean; id: string | undefined; made: string }> => {
      const { a, b } = pair()
      const boardA = new BoardService(a)
      const boardB = new BoardService(b)
      a.armExternalDispatch()
      let settled = false
      const claiming = boardA.tasks.claimReady(owner, { channel: 'dev', wait: 10 }).then((r) => {
        settled = true
        return r
      })
      await vi.advanceTimersByTimeAsync(150)
      const made = boardB.tasks.createTask(owner, { channel: 'dev', text: 'wake' }).task.id
      if (pump) a.pumpExternal()
      await turn()
      await turn()
      await vi.advanceTimersByTimeAsync(6)
      const settledEarly = settled
      if (!pump) await vi.advanceTimersByTimeAsync(2000)
      const got = await claiming
      a.close()
      b.close()
      return { settledEarly, id: got.task?.id, made }
    }
    const woken = await run(true)
    expect(woken.settledEarly).toBe(true)
    expect(woken.id).toBe(woken.made)
    const control = await run(false)
    expect(control.settledEarly).toBe(false)
  })

  it('HT-10 the own-tracking bound', { timeout: 60_000 }, () => {
    const dir = tempDir()
    const store = open(join(dir, 'b.db'), { jsonlPath: null, wakeupPath: null })
    store.armExternalDispatch()
    store.transaction(() => {
      store.appendEvents(Array.from({ length: 65_537 }, (_, i) => ev(i)))
    })
    expect(store.sidecarHealth().external).toMatchObject({ tracked: 65_536, dropped: 1 })
    const heard = heardBy(store)
    expect(store.pumpExternal(5000)).toMatchObject({ dispatched: 1, skippedOwn: 4999 })
    expect(heard).toEqual([1])
    for (let guard = 0; guard < 30; guard++) if (!store.pumpExternal(5000).more) break
    expect(store.sidecarHealth().external).toMatchObject({ dispatched: 1, cursor: 65_537, tracked: 0 })
  })

  it('HT-11 re-entrant pump', () => {
    const { a, b } = pair()
    a.armExternalDispatch()
    const heard: number[] = []
    let first = true
    a.onEvent((e) => {
      heard.push(e.index)
      if (first) {
        first = false
        a.pumpExternal(1)
      }
    })
    append(b, 3)
    expect(() => a.pumpExternal(1)).not.toThrow()
    expect(heard).toEqual([1, 2])
    a.pumpExternal(1)
    expect(heard).toEqual([1, 2, 3])
    expect(new Set(heard).size).toBe(heard.length)
  })

  it('HT-12 a replaced log', () => {
    const { path, a, b } = pair()
    append(b, 5)
    expect(a.armExternalDispatch()).toBe(5)
    const raw = new DatabaseSync(path)
    raw.exec('DELETE FROM board_events WHERE log_index > 2')
    raw.close()
    let caught: unknown
    try {
      a.pumpExternal()
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ status: 410, code: 'cursor_expired' })
    a.disarmExternalDispatch()
    expect(a.armExternalDispatch()).toBe(2)
    expect(a.pumpExternal().dispatched).toBe(0)
  })
})

describe('C2 post-commit reporting and repair', () => {
  it('HT-13 a listener that throws on a local commit', () => {
    const steps: string[] = []
    const store = open(join(tempDir(), 'b.db'), { onSidecarError: (_e, step) => steps.push(step) })
    store.onEvent(() => {
      throw new Error('l')
    })
    const two = heardBy(store)
    expect(store.appendEvent(ev()).index).toBe(1)
    expect(store.getEvents().events).toHaveLength(1)
    expect(two).toEqual([1])
    expect(steps).toEqual(['listener'])
    expect(store.sidecarHealth()).toMatchObject({ failures: 0, listenerFailures: 1, degraded: false, last: { step: 'listener' } })
    expect(store.appendEvent(ev()).index).toBe(2)
  })

  it('HT-14 .jsonl append fails', () => {
    const dir = tempDir()
    const jsonlPath = join(dir, 'audit.jsonl')
    fs.mkdirSync(jsonlPath)
    const store = open(join(dir, 'b.db'), { jsonlPath })
    expect(store.appendEvent(ev()).index).toBe(1)
    expect(store.getEvents().events).toHaveLength(1)
    expect(store.sidecarHealth()).toMatchObject({ failures: 1, unflushedJsonl: 1, degraded: true })
    fs.rmdirSync(jsonlPath)
    store.appendEvent(ev())
    expect(lineIndices(jsonlPath)).toEqual([1, 2])
    expect(store.sidecarHealth().degraded).toBe(false)
  })

  it('HT-15 the .wakeup lock is held by a live process', { timeout: 20_000 }, async () => {
    const dir = tempDir()
    const path = join(dir, 'b.db')
    const store = open(path)
    const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' })
    try {
      const lock = `${path}.wakeup.lock`
      fs.writeFileSync(lock, `${holder.pid}:0:abcd1234`)
      const future = new Date(Date.now() + 60_000)
      fs.utimesSync(lock, future, future)
      const started = Date.now()
      expect(store.appendEvent(ev()).index).toBe(1)
      expect(Date.now() - started).toBeGreaterThanOrEqual(4800)
      expect(store.sidecarHealth()).toMatchObject({ failures: 1, unwrittenWakeup: 1, degraded: true, last: { step: 'wakeup' } })
      const file = `${path}.wakeup`
      const raised = fs.existsSync(file) ? Number(fs.readFileSync(file).readBigUInt64LE(0)) : 0
      expect(raised).toBeLessThan(1)
      fs.rmSync(lock)
      holder.kill('SIGKILL')
      store.transaction(() => undefined)
      expect(fs.readFileSync(file).readBigUInt64LE(0)).toBe(1n)
      expect(store.sidecarHealth().degraded).toBe(false)
    } finally {
      holder.kill('SIGKILL')
    }
  })

  it('HT-16 the error hook throws for every step', () => {
    const dir = tempDir()
    const jsonlPath = join(dir, 'audit.jsonl')
    fs.mkdirSync(jsonlPath)
    const store = open(join(dir, 'b.db'), {
      jsonlPath,
      onSidecarError: () => {
        throw new Error('hook')
      },
    })
    store.onEvent(() => {
      throw new Error('l')
    })
    expect(store.appendEvent(ev()).index).toBe(1)
    expect(store.appendEvent(ev()).index).toBe(2)
    expect(store.sidecarHealth()).toMatchObject({ failures: 2, listenerFailures: 2 })
  })

  it('HT-17 overflow is counted and repaired', { timeout: 60_000 }, () => {
    const dir = tempDir()
    const jsonlPath = join(dir, 'audit.jsonl')
    fs.mkdirSync(jsonlPath)
    const store = open(join(dir, 'b.db'), { jsonlPath })
    store.transaction(() => {
      store.appendEvents(Array.from({ length: 10_001 }, (_, i) => ev(i)))
    })
    expect(store.sidecarHealth()).toMatchObject({ unflushedJsonl: 10_000, droppedJsonl: 1, degraded: true })
    fs.rmdirSync(jsonlPath)
    store.transaction(() => undefined)
    expect(store.auditJsonl()).toMatchObject({ head: 10_001, present: 10_000, missing: 1, firstMissing: 1 })
    expect(store.auditJsonl({ repair: true }).repaired).toBe(1)
    expect(store.auditJsonl().missing).toBe(0)
    expect(store.sidecarHealth()).toMatchObject({ droppedJsonl: 0, degraded: false })
  })

  it('HT-19 audit classification and append-only repair', () => {
    const dir = tempDir()
    const jsonlPath = join(dir, 'audit.jsonl')
    const store = open(join(dir, 'b.db'), { jsonlPath })
    append(store, 4)
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(4)
    const rewritten =
      [lines[1], lines[2], lines[3], lines[1], 'not json', JSON.stringify({ ...JSON.parse(lines[2]!), id: 'x' }), JSON.stringify({ ...JSON.parse(lines[3]!), index: 99, id: 'fresh' })].join('\n') +
      '\n' +
      lines[3]
    fs.writeFileSync(jsonlPath, rewritten)
    expect(store.auditJsonl()).toMatchObject({
      lines: 8,
      present: 3,
      missing: 1,
      firstMissing: 1,
      duplicates: 1,
      conflicts: 1,
      beyondHead: 1,
      malformed: 2,
      tornTail: true,
    })
    const saved = fs.readFileSync(jsonlPath)
    expect(store.auditJsonl({ repair: true }).repaired).toBe(1)
    const canonical = `${JSON.stringify(store.getEvents().events[0])}\n`
    expect(fs.readFileSync(jsonlPath)).toEqual(Buffer.concat([saved, Buffer.from(`\n${canonical}`)]))
  })
})

describe('C8 the .jsonl order is not a contract', () => {
  it('HT-20 the inversion is real and the log is the order', () => {
    const { path, a, b } = pair()
    const jsonlPath = `${path}.jsonl`
    fs.mkdirSync(jsonlPath)
    append(a, 1, 'a')
    fs.rmdirSync(jsonlPath)
    append(b, 1)
    // A holds line 1 and B's line 2 reaches the file first; A's next commit flushes 1, then 3.
    append(a, 1, 'a')
    expect(lineIndices(jsonlPath)).toEqual([2, 1, 3])
    expect(a.auditJsonl()).toMatchObject({ missing: 0, duplicates: 0, inversions: 1 })
    expect(a.getEvents().events.map((e) => e.index)).toEqual([1, 2, 3])
    const fileLines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l !== '')
    const byId = new Map<string, { index: number; line: string }>()
    for (const line of fileLines) {
      const { index, id } = JSON.parse(line) as { index: number; id: string }
      if (!byId.has(id)) byId.set(id, { index, line })
    }
    const sorted = [...byId.values()].sort((x, y) => x.index - y.index).map((l) => `${l.line}\n`)
    expect(sorted).toEqual(a.getEvents().events.map((e) => `${JSON.stringify(e)}\n`))
  })
})

describe('meta helpers', () => {
  const metaStore = (): SqliteUnifiedStore => open(join(tempDir(), 'b.db'))
  const metaRows = (s: SqliteUnifiedStore): unknown => s.db.prepare('SELECT key, value FROM board_meta ORDER BY key').all()

  it('HT-22 CAS semantics', () => {
    const s = metaStore()
    const k = 'host.test.k'
    expect(s.getMeta(k)).toBeUndefined()
    expect(s.casMeta(k, undefined, 'a')).toBe(true)
    expect(s.getMeta(k)).toBe('a')
    expect(s.casMeta(k, undefined, 'b')).toBe(false)
    expect(s.getMeta(k)).toBe('a')
    expect(s.casMeta(k, 'a', 'b')).toBe(true)
    expect(s.casMeta(k, 'a', 'c')).toBe(false)
    expect(s.getMeta(k)).toBe('b')
    expect(s.casMeta(k, 'b', 'b')).toBe(true)
    expect(s.casMeta(k, 'b', '')).toBe(true)
    expect(s.getMeta(k)).toBe('')
    expect(s.casMeta(k, undefined, 'x')).toBe(false)
  })

  it('HT-23 namespaces and bounds', () => {
    const s = metaStore()
    const before = metaRows(s)
    const bad = ['tasks_schema', 'wakeup_generation', 'schemas_seeded', 'next_grant', 'schedule_principal:1', 'Host.x', 'host.', 'x', `host.${'k'.repeat(124)}`]
    for (const key of bad) expect(() => s.casMeta(key, undefined, 'v'), key).toThrow(TypeError)
    expect(() => s.casMeta('host.k', undefined, 5 as unknown as string)).toThrow(TypeError)
    expect(() => s.casMeta('host.k', 7 as unknown as string, 'v')).toThrow(TypeError)
    expect(() => s.casMeta('host.k', undefined, 'x'.repeat(65_537))).toThrow(TypeError)
    expect(() => s.casMeta('host.k', undefined, 'é'.repeat(32_769))).toThrow(TypeError)
    for (const key of [...RESERVED_META_KEYS, 'core.board_id', 'core.anything']) {
      expect(() => s.casMeta(key, undefined, 'v'), key).toThrow(TypeError)
      expect(() => s.casMeta(key, '1', 'v'), key).toThrow(TypeError)
    }
    expect(metaRows(s)).toEqual(before)
    expect(s.casMeta('host.k', undefined, 'x'.repeat(65_536))).toBe(true)
    expect(s.casMeta('fed.cursor.ABC234.1', undefined, '1')).toBe(true)
    expect(s.getMeta('tasks_schema')).toBe('1')
    expect(() => s.getMeta('core.board_id')).not.toThrow()
    expect(() => s.getMeta('schedule_principal:1')).toThrow(TypeError)
    expect(() => s.getMeta('schemas_seeded')).toThrow(TypeError)
  })

  it('HT-24 no event, no wakeup, transactional', () => {
    const begins = { n: 0 }
    const dir = tempDir()
    const path = join(dir, 'b.db')
    const s = open(path, { testHooks: { onBeginImmediate: () => begins.n++ } })
    s.appendEvent(ev())
    const heard = heardBy(s)
    const head = s.getHeadIndex()
    const gen = s.getWakeupGeneration()
    const size = fs.statSync(`${path}.jsonl`).size
    expect(s.casMeta('host.t', undefined, 'v')).toBe(true)
    expect(s.getHeadIndex()).toBe(head)
    expect(s.getWakeupGeneration()).toBe(gen)
    expect(fs.statSync(`${path}.jsonl`).size).toBe(size)
    expect(heard).toEqual([])
    expect(() =>
      s.transaction(() => {
        s.casMeta('host.u', undefined, 'v')
        throw new Error('x')
      }),
    ).toThrow('x')
    expect(s.getMeta('host.u')).toBeUndefined()
    begins.n = 0
    s.transaction(() => {
      s.casMeta('host.w', undefined, 'v')
      expect(s.getMeta('host.w')).toBe('v')
    })
    expect(begins.n).toBe(1)
  })

  it('HT-25 refusals', () => {
    const dir = tempDir()
    const path = join(dir, 'b.db')
    const s = open(path)
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE board_meta SET value = '2' WHERE key = 'tasks_schema'").run()
    raw.close()
    const refused = open(path)
    expect(refused.getMeta('tasks_schema')).toBe('2')
    expect(() => refused.casMeta('host.k', undefined, 'v')).toThrow(/newer Swarmboard/)
    try {
      refused.casMeta('host.k', undefined, 'v')
    } catch (e) {
      expect(e).toMatchObject({ status: 503, code: 'unavailable' })
    }
    expect(refused.getMeta('host.k')).toBeUndefined()
    s.close()
    for (const call of [() => s.getMeta('host.k'), () => s.casMeta('host.k', undefined, 'v')]) {
      try {
        call()
        expect.unreachable()
      } catch (e) {
        expect(e).toMatchObject({ status: 503, code: 'unavailable' })
      }
    }
  })
})

describe('gate', () => {
  it('HT-29 an unarmed store is unchanged', () => {
    const run = (arm: boolean): { wakeup: Buffer; jsonl: Buffer } => {
      const dir = tempDir()
      const path = join(dir, 'b.db')
      const s = open(path)
      if (arm) {
        s.armExternalDispatch()
        s.disarmExternalDispatch()
      }
      for (let i = 0; i < 100; i++) {
        s.appendEvent({ id: `e${i}`, createdAt: '2026-11-24T00:00:00.000Z', type: 'x', payload: { i } })
      }
      expect(s.getWakeupGeneration()).toBe(100)
      const out = { wakeup: fs.readFileSync(`${path}.wakeup`), jsonl: fs.readFileSync(`${path}.jsonl`) }
      expect(out.jsonl.toString('utf8').split('\n').filter((l) => l !== '')).toHaveLength(100)
      s.close()
      return out
    }
    const plain = run(false)
    const armed = run(true)
    expect(armed.wakeup).toEqual(plain.wakeup)
    expect(armed.jsonl).toEqual(plain.jsonl)
  })
})
