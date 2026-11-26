// HOST-0 stage 2, separate OS processes on one WAL file (HOST0_DESIGN section 5, kinds `proc` and `fault`):
// HT-41, HT-42, HT-43, HT-50, HT-51, HT-57. Each child is tests/core/host0/schema-child.ts.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, SqliteUnifiedStore } from '../../../src/core/index.ts'
import { makeLegacyFile } from './legacy.ts'

const CHILD = fileURLToPath(new URL('./schema-child.ts', import.meta.url))

type ChildOptions = {
  path: string
  startAt?: number
  busyTimeoutMs?: number
  seedDefaultGrants?: boolean
  killAtStep?: number
  notifyBegin?: string
  writer?: number
  storeOnly?: boolean
}
type ChildReply = {
  ok: boolean
  steps?: number[]
  begins?: number
  appended?: number
  boardInfo?: { boardId: string | null; instanceId: string | null }
  error?: { status: number; code: string; message: string; raw: string }
}
type ChildRun = { code: number | null; signal: NodeJS.Signals | null; reply: ChildReply | null; stderr: string }

function runChild(o: ChildOptions): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CHILD, JSON.stringify(o)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code, signal) => {
      const line = out.trim().split('\n').pop() ?? ''
      let reply: ChildReply | null = null
      try {
        reply = JSON.parse(line) as ChildReply
      } catch {
        reply = null
      }
      resolve({ code, signal, reply, stderr: err })
    })
  })
}

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-host0-s2p-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

function raw<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
const metaOf = (db: DatabaseSync): Record<string, string> =>
  Object.fromEntries((db.prepare('SELECT key, value FROM board_meta').all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]))
const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { c: number }).c)

/** The seed rows of a fresh board opened by one process, the reference the racers must equal. */
function singleProcessSeed(): { schemas: number; grants: Array<Record<string, unknown>> } {
  const path = join(tempDir(), 'single.db')
  const store = new SqliteUnifiedStore({ path })
  new BoardService(store)
  const schemas = count(store.db, 'SELECT COUNT(*) AS c FROM board_schemas')
  const grants = store.db.prepare('SELECT id, seq, principals_json, can_json FROM board_grants ORDER BY seq').all() as Array<
    Record<string, unknown>
  >
  store.close()
  return { schemas, grants }
}

/** 16 children open `path` at one instant; every one must answer ok. */
async function wave(path: string, n = 16): Promise<ChildReply[]> {
  const startAt = Date.now() + 1500
  const runs = await Promise.all(Array.from({ length: n }, () => runChild({ path, startAt })))
  for (const r of runs) expect(r.reply, `child failed: ${JSON.stringify(r.reply)} ${r.stderr}`).toMatchObject({ ok: true })
  return runs.map((r) => r.reply!)
}

describe('HOST-0 stage 2 [proc]: concurrent first opens (C3, C5)', () => {
  it('HT-41 16 openers on one fresh file: every one opens, each ladder step runs once, one board_id', async () => {
    const reference = singleProcessSeed()
    for (let round = 0; round < 5; round++) {
      const path = join(tempDir(), 'board.db')
      const replies = await wave(path)
      expect(replies.flatMap((r) => r.steps ?? []).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
      raw(path, (db) => {
        expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
        const meta = metaOf(db)
        expect(meta).toMatchObject({
          'core.schema_version': '5',
          'core.schema_write_min': '5',
          'core.schema_read_min': '1',
          tasks_schema: '1',
        })
        expect(meta['core.board_id']).toMatch(/^b_[0-9a-f]{32}$/)
        expect(meta['core.instance_id']).toMatch(/^i_[0-9a-f]{32}$/)
        expect(meta['core.instance_file']).toBe(String(fs.statSync(path, { bigint: true }).ino))
        expect(count(db, "SELECT COUNT(*) AS c FROM board_meta WHERE key = 'core.board_id'")).toBe(1)
        expect(count(db, 'SELECT COUNT(*) AS c FROM board_schemas')).toBe(reference.schemas)
        expect(db.prepare('SELECT id, seq, principals_json, can_json FROM board_grants ORDER BY seq').all()).toEqual(reference.grants)
        for (const r of replies) {
          expect(r.boardInfo).toMatchObject({ boardId: meta['core.board_id'], instanceId: meta['core.instance_id'] })
        }
      })
    }
    // A sixth round on an M1 file with a long log: one process migrates it, step by step.
    const legacy = join(tempDir(), 'm1.db')
    makeLegacyFile(legacy, 'm1', 2000)
    const replies = await wave(legacy)
    expect(replies.flatMap((r) => r.steps ?? []).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    raw(legacy, (db) => {
      expect(metaOf(db)).toMatchObject({ tasks_schema: '1', 'core.schema_version': '5' })
      expect(count(db, 'SELECT COUNT(*) AS c FROM board_events')).toBe(2000)
    })
  }, 180_000)

  it('HT-51 a second wave on a current board takes no lock and runs no step', async () => {
    const path = join(tempDir(), 'board.db')
    await wave(path)
    const second = await wave(path)
    for (const r of second) {
      expect(r.begins).toBe(0)
      expect(r.steps).toEqual([])
    }
  }, 120_000)
})

describe('HOST-0 stage 2 [fault]: kill -9 inside and between ladder steps (C3)', () => {
  /** Every table of the file (or only `only`), its rows in rowid order; FTS5 and SQLite's own tables aside. */
  const dumpM1 = (db: DatabaseSync, only?: readonly string[]): Record<string, unknown[]> => {
    const tables =
      only ??
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_%' ORDER BY name").all() as Array<{
          name: string
        }>
      ).map((r) => r.name)
    return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))
  }

  it('HT-42 kill -9 inside step 2 leaves step 1 committed and the log intact; a reopen runs [2,3]', async () => {
    const path = join(tempDir(), 'm1.db')
    makeLegacyFile(path, 'm1', 200)
    const before = raw(path, dumpM1)
    const run = await runChild({ path, killAtStep: 2 })
    expect(run.signal).toBe('SIGKILL')
    raw(path, (db) => {
      const meta = metaOf(db)
      expect(meta['core.schema_version']).toBe('1')
      expect(meta['core.schema_write_min']).toBe('1')
      expect(meta['core.schema_read_min']).toBe('1')
      expect(meta.tasks_schema).toBeUndefined()
      expect(meta['core.board_id']).toBeUndefined()
      expect(meta['core.instance_id']).toBeUndefined()
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'board_tasks'").get()).toBeUndefined()
      expect(count(db, 'SELECT COUNT(*) AS c FROM board_events')).toBe(200)
      expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    })
    const steps: number[] = []
    const store = new SqliteUnifiedStore({ path, testHooks: { onSchemaStep: (v) => void steps.push(v) } })
    expect(steps).toEqual([2, 3, 4, 5])
    const after = dumpM1(store.db, Object.keys(before))
    const tasks = store.db.prepare('SELECT * FROM board_tasks').all()
    store.close()
    // As HT-31: every M1 table as it was, bar board_meta's new keys.
    for (const [table, rows] of Object.entries(before)) {
      if (table === 'board_meta') continue
      expect(after[table], table).toEqual(rows)
    }
    const added = (after.board_meta as Array<{ key: string }>).map((r) => r.key).filter((k) => !(before.board_meta as Array<{ key: string }>).some((b) => b.key === k))
    expect(added.sort()).toEqual(
      ['core.board_id', 'core.instance_file', 'core.instance_id', 'core.schema_read_min', 'core.schema_version', 'core.schema_write_min', 'tasks_schema'].sort(),
    )
    expect(tasks).toEqual([])

    // killAtStep 1 on a fresh path: nothing of the board is left, and a reopen runs every step.
    const fresh = join(tempDir(), 'fresh.db')
    const killed = await runChild({ path: fresh, killAtStep: 1 })
    expect(killed.signal).toBe('SIGKILL')
    raw(fresh, (db) => {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'board_%'").all()).toEqual([])
    })
    const again: number[] = []
    new SqliteUnifiedStore({ path: fresh, testHooks: { onSchemaStep: (v) => void again.push(v) } }).close()
    expect(again).toEqual([1, 2, 3, 4, 5])
  }, 60_000)

  it('HT-43 kill -9 between steps (inside step 3) leaves version 2; a reopen runs [3,4,5] only', async () => {
    const path = join(tempDir(), 'fresh.db')
    const run = await runChild({ path, killAtStep: 3 })
    expect(run.signal).toBe('SIGKILL')
    raw(path, (db) => {
      const meta = metaOf(db)
      expect(meta['core.schema_version']).toBe('2')
      expect(meta.tasks_schema).toBe('1')
      expect(meta['core.board_id']).toBeUndefined()
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toEqual([])
    })
    const steps: number[] = []
    new SqliteUnifiedStore({ path, testHooks: { onSchemaStep: (v) => void steps.push(v) } }).close()
    expect(steps).toEqual([3, 4, 5])
  }, 60_000)
})

describe('HOST-0 stage 2 [proc]: seeding races and live writers (C4, C5)', () => {
  it('HT-50 both racers find the board unseeded, and exactly one seeds', async () => {
    const reference = singleProcessSeed()
    const dir = tempDir()
    const path = join(dir, 'board.db')
    new SqliteUnifiedStore({ path }).close()
    const notify = join(dir, 'begins')
    fs.mkdirSync(notify)
    const holder = new DatabaseSync(path)
    holder.exec('BEGIN IMMEDIATE')
    const runs = [0, 1].map(() => runChild({ path, notifyBegin: notify, busyTimeoutMs: 20_000 }))
    const deadline = Date.now() + 30_000
    while (fs.readdirSync(notify).length < 2) {
      if (Date.now() > deadline) throw new Error('the children never reached BEGIN IMMEDIATE')
      await new Promise((r) => setTimeout(r, 10))
    }
    holder.exec('ROLLBACK')
    holder.close()
    const done = await Promise.all(runs)
    for (const r of done) expect(r.reply, r.stderr).toMatchObject({ ok: true, steps: [] })
    raw(path, (db) => {
      expect(count(db, 'SELECT COUNT(*) AS c FROM board_schemas')).toBe(reference.schemas)
      expect(count(db, 'SELECT COUNT(*) AS c FROM (SELECT name, version FROM board_schemas GROUP BY name, version HAVING COUNT(*) > 1)')).toBe(0)
      expect(db.prepare('SELECT id, seq, principals_json, can_json FROM board_grants ORDER BY seq').all()).toEqual(reference.grants)
      const meta = metaOf(db)
      expect(meta.schemas_seeded).toBe('1')
      expect(meta.grants_seeded).toBe('1')
    })
  }, 60_000)

  it('HT-57 no false rotation under a live writer: 200 opens keep one instance and take no lock', async () => {
    const path = join(tempDir(), 'board.db')
    const first = new SqliteUnifiedStore({ path })
    const instance = first.identity()!.instanceId
    first.close()
    const writer = runChild({ path, writer: 3000 })
    const deadline = Date.now() + 20_000
    while (raw(path, (db) => count(db, 'SELECT COUNT(*) AS c FROM board_events')) === 0) {
      if (Date.now() > deadline) throw new Error('the writer never wrote')
      await new Promise((r) => setTimeout(r, 5))
    }
    let begins = 0
    for (let i = 0; i < 200; i++) {
      const store = new SqliteUnifiedStore({ path, testHooks: { onBeginImmediate: () => void begins++ } })
      expect(store.identity()!.instanceId).toBe(instance)
      store.close()
    }
    const wrote = await writer
    expect(wrote.reply, wrote.stderr).toMatchObject({ ok: true })
    expect(wrote.reply!.appended).toBeGreaterThan(100)
    expect(begins).toBe(0)
    raw(path, (db) => expect(metaOf(db)['core.instance_id']).toBe(instance))
  }, 60_000)
})
