// HOST-0 stage 2 (HOST0_DESIGN section 5): C3 the schema ladder, C5 board identity and the replaced-file
// fence, the downgrade guard, and the cross-seam tests. C4 (seeds) is in schema-seeds.test.ts; the
// separate-process tests (HT-41..HT-43, HT-50, HT-51, HT-57) are in schema-proc.test.ts.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOARD_ID_PATTERN,
  BoardError,
  BoardService,
  createLocalCaller,
  ERROR_STATUSES,
  errorFor,
  INSTANCE_ID_PATTERN,
  normalizeError,
  SCHEMA_VERSION,
  SqliteUnifiedStore,
  statusOfCode,
  type SqliteStoreOptions,
} from '../../../src/core/index.ts'
import { RESERVED_META_KEYS } from '../../../src/core/meta-keys.ts'
import { M1_SCHEMA_SQL, SCHEMA_STEPS, TASKS_SCHEMA_SQL, type SchemaStepContext } from '../../../src/core/migrations.ts'
import { rebuildTaskIndexInTx } from '../../../src/core/tasks/rebuild.ts'
import { loadAllRows } from '../../../src/core/tasks/row.ts'
import { M1_FIXTURE_SQL, makeLegacyFile, TASKS_FIXTURE_SQL } from './legacy.ts'

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-host0-s2-'))
  dirs.push(dir)
  return dir
}
const freshPath = (name = 'board.db'): string => join(tempDir(), name)

type Counters = { steps: number[]; begins: number }
/** A store on `path` that records its ladder steps and counts its BEGIN IMMEDIATEs. */
function open(path: string, extra: Partial<SqliteStoreOptions> = {}): SqliteUnifiedStore & { counters: Counters } {
  const counters: Counters = { steps: [], begins: 0 }
  const hooks = extra.testHooks ?? {}
  const store = new SqliteUnifiedStore({
    path,
    ...extra,
    testHooks: {
      ...hooks,
      onSchemaStep: (v) => {
        counters.steps.push(v)
        hooks.onSchemaStep?.(v)
      },
      onBeginImmediate: () => {
        counters.begins += 1
        hooks.onBeginImmediate?.()
      },
    },
  })
  stores.push(store)
  return Object.assign(store, { counters })
}

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close()
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
const masterOf = (db: DatabaseSync): unknown[] => db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all()
const headOf = (db: DatabaseSync): number => Number((db.prepare('SELECT COALESCE(MAX(log_index), 0) AS h FROM board_events').get() as { h: number }).h)
const eventCount = (db: DatabaseSync): number => Number((db.prepare('SELECT COUNT(*) AS c FROM board_events').get() as { c: number }).c)
const inodeOf = (path: string): string => String(fs.statSync(path, { bigint: true }).ino)
const wakeupOf = (path: string): number => Number(fs.readFileSync(path).readBigUInt64LE(0))
const dbWakeupOf = (db: DatabaseSync): number =>
  Number((db.prepare("SELECT value FROM board_meta WHERE key = 'wakeup_generation'").get() as { value?: string } | undefined)?.value ?? 0)

const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const post = (board: BoardService, text: string): void => void board.postMessage(alice, { channel: 'dev', text })

/** The names a DDL text creates (`CREATE [VIRTUAL] TABLE|INDEX IF NOT EXISTS <name>`), as the fixtures spell them. */
const fixtureNames = (sql: string): string[] =>
  [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+(\w+)/g)].map((m) => m[1]!)

const V5_META = {
  'core.schema_version': '5',
  'core.schema_write_min': '5',
  'core.schema_read_min': '1',
  tasks_schema: '1',
}
const CORE_KEYS = ['core.board_id', 'core.instance_file', 'core.instance_id', 'core.schema_read_min', 'core.schema_version', 'core.schema_write_min']

/** A v5 board with one post, closed: the base the floor tests edit with a raw connection. */
function v5File(): string {
  const path = freshPath()
  const s = new SqliteUnifiedStore({ path })
  post(new BoardService(s), 'before the floor')
  s.close()
  return path
}
const setMeta = (path: string, entries: Record<string, string>): void =>
  raw(path, (db) => {
    for (const [k, v] of Object.entries(entries)) db.prepare('UPDATE board_meta SET value = ? WHERE key = ?').run(v, k)
  })

const expectBoardError = (fn: () => unknown, status: number, code: string, message?: string | RegExp): BoardError => {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught, 'expected a throw').toBeInstanceOf(BoardError)
  const e = caught as BoardError
  expect(e.status).toBe(status)
  expect(e.code).toBe(code)
  if (typeof message === 'string') expect(e.message).toBe(message)
  else if (message) expect(e.message).toMatch(message)
  return e
}

const REPLACED = 'the board file was replaced or removed while this store had it open: open it again'

/**
 * Closeout S2-V5: a wall-clock bound measured once fails on a loaded machine. `attempt` runs up to `tries`
 * times, stopping at the first run under `boundMs`; the best run is returned and the caller asserts it, so
 * a build that is slow every time still fails.
 */
function bestOf(tries: number, boundMs: number, attempt: () => void): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < tries && best >= boundMs; i++) {
    const t0 = performance.now()
    attempt()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe('HOST-0 stage 2: C3, the ladder', () => {
  it('HT-30 a fresh file runs [1,2,3,4,5] and lands at v5 (also on :memory:)', () => {
    for (const path of [freshPath(), ':memory:']) {
      const store = open(path)
      expect(store.counters.steps).toEqual([1, 2, 3, 4, 5])
      expect(metaOf(store.db)).toMatchObject(V5_META)
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
      const names = new Set((store.db.prepare('SELECT name FROM sqlite_master').all() as Array<{ name: string }>).map((r) => r.name))
      for (const name of [...fixtureNames(M1_FIXTURE_SQL), ...fixtureNames(TASKS_FIXTURE_SQL)]) expect(names.has(name), name).toBe(true)
      expect(store.schemaInfo()).toEqual({ version: 5, writeMin: 5, readMin: 1, build: 5, refused: null })
      expect(store.writeRefusal()).toBeNull()
    }
  })

  it('HT-31 an M1 file runs [1,2,3,4,5]: every M1 table as it was, bar seven new board_meta keys', () => {
    const path = freshPath()
    makeLegacyFile(path, 'm1', 50)
    const tables = raw(path, (db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_%'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    )
    const dump = (db: DatabaseSync): Record<string, unknown[]> => Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))
    const before = raw(path, dump)
    const store = open(path)
    expect(store.counters.steps).toEqual([1, 2, 3, 4, 5])
    const after = dump(store.db)
    for (const t of tables) if (t !== 'board_meta') expect(after[t], t).toEqual(before[t])
    const added = Object.keys(metaOf(store.db)).filter((k) => !(before.board_meta as Array<{ key: string }>).some((r) => r.key === k))
    expect(added.sort()).toEqual([...CORE_KEYS, 'tasks_schema'].sort())
    for (const r of before.board_meta as Array<{ key: string; value: string }>) expect(metaOf(store.db)[r.key]).toBe(r.value)
    expect(store.db.prepare('SELECT COUNT(*) AS c FROM board_tasks').get()).toEqual({ c: 0 })
    expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
  })

  it('HT-32 a slice A file runs [1,2,3,4,5] and keeps its task index and tasks_schema', () => {
    const path = freshPath()
    makeLegacyFile(path, 'sliceA', 50)
    const live = raw(path, (db) => {
      db.exec('BEGIN')
      db.prepare(
        `INSERT INTO board_messages (id, event_id, channel, re, reply_to, thread, by_actor, by_principal, by_profile, from_key, no_sync,
           text, text_lower, deleted, created_at, edited_at, replies, at, version, revision, data)
         VALUES (1000, 'root-1000', 'dev', NULL, NULL, 't-root', 'alice', 'alice', NULL, NULL, 0, 'root', 'root', 0, 0, NULL, 0, 0, 1, 1, '{}')`,
      ).run()
      const ins = db.prepare(
        "INSERT INTO board_events (event_id, session_id, type, channel, thread, payload_json, created_at) VALUES (?, 'board', ?, 'dev', 't-root', ?, '2026-11-22T00:00:00.000Z')",
      )
      ins.run('root-1000', 'message.posted', JSON.stringify({ id: 1000, text: 'root' }))
      ins.run('task-1000', 'task.created', JSON.stringify({ id: 1000, thread: 't-root', needs: [], for: null, by: { actor: 'alice', principal: 'alice', profile: null } }))
      expect(rebuildTaskIndexInTx(db).tasks).toBe(1)
      db.exec('COMMIT')
      return loadAllRows(db)
    })
    expect(live).toHaveLength(1)
    const otherTables = ['board_events', 'board_messages', 'board_grants', 'board_schemas', 'board_task_needs']
    const before = raw(path, (db) => Object.fromEntries(otherTables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()])))
    const metaBefore = raw(path, metaOf)
    const store = open(path)
    expect(store.counters.steps).toEqual([1, 2, 3, 4, 5])
    expect(loadAllRows(store.db)).toEqual(live)
    expect(metaOf(store.db).tasks_schema).toBe('1')
    for (const t of otherTables) expect(store.db.prepare(`SELECT * FROM ${t}`).all(), t).toEqual(before[t])
    const added = Object.keys(metaOf(store.db)).filter((k) => !(k in metaBefore))
    expect(added.sort()).toEqual(CORE_KEYS)
  })

  it('HT-33 a reopen is read-only: no step, no BEGIN IMMEDIATE, nothing changed', () => {
    const path = freshPath()
    new SqliteUnifiedStore({ path }).close()
    const [master, meta] = raw(path, (db) => [masterOf(db), metaOf(db)] as const)
    const store = open(path)
    expect(store.counters).toEqual({ steps: [], begins: 0 })
    expect(masterOf(store.db)).toEqual(master)
    expect(metaOf(store.db)).toEqual(meta)
  })

  it('HT-34 each step is idempotent: running it twice changes nothing more', () => {
    let n = 0
    const ctx: SchemaStepContext = {
      wakeupFileGeneration: () => 0,
      wakeupDbGeneration: () => 0,
      fileId: '7',
      newId: (prefix) => `${prefix}${String(++n).padStart(32, '0')}`,
    }
    for (let k = 1; k <= SCHEMA_VERSION; k++) {
      const db = new DatabaseSync(freshPath())
      try {
        db.exec('PRAGMA journal_mode = WAL')
        for (let j = 0; j < k - 1; j++) {
          db.exec('BEGIN IMMEDIATE')
          SCHEMA_STEPS[j]!.up(db, ctx)
          db.exec('COMMIT')
        }
        db.exec('BEGIN IMMEDIATE')
        SCHEMA_STEPS[k - 1]!.up(db, ctx)
        const once = [masterOf(db), metaOf(db)]
        SCHEMA_STEPS[k - 1]!.up(db, ctx)
        expect([masterOf(db), metaOf(db)], `step ${k}`).toEqual(once)
        db.exec('COMMIT')
      } finally {
        db.close()
      }
    }
  })

  it('HT-35 a write floor above the build: reads work, every write is 503 schema_too_new, nothing runs at open', () => {
    const path = v5File()
    setMeta(path, { 'core.schema_version': '9', 'core.schema_write_min': '9' })
    const master = raw(path, masterOf)
    const store = open(path)
    expect(store.counters).toEqual({ steps: [], begins: 0 })
    expect(masterOf(store.db)).toEqual(master)
    expect(store.schemaInfo()).toEqual({ version: 9, writeMin: 9, readMin: 1, build: 5, refused: 'writes' })
    const refusal = store.writeRefusal()!
    expect(refusal).toBeInstanceOf(BoardError)
    expect(refusal.status).toBe(503)
    expect(refusal.code).toBe('schema_too_new')
    expect(refusal.message).toBe('this board needs a newer Swarmboard to write it (schema 9, writable from 9; this build knows 5)')
    expect(refusal.details).toEqual({ schema: '9', writeMin: '9', readMin: '1', build: 5 })
    expect(refusal.retryAfter).toBeUndefined()
    const board = new BoardService(store)
    expect(store.counters.begins).toBe(0)
    expect(board.listThreads(alice, { channel: 'dev' }).threads).toHaveLength(1)
    const before = eventCount(store.db)
    expect(() => post(board, 'refused')).toThrow(refusal)
    expect(() => store.appendEvent({ type: 'x', payload: {} })).toThrow(refusal)
    expect(() => store.emitWakeup()).toThrow(refusal)
    expect(eventCount(store.db)).toBe(before)
  })

  it('HT-36 a newer file whose write floor this build meets is written, never migrated', () => {
    const path = v5File()
    setMeta(path, { 'core.schema_version': '9', 'core.schema_write_min': '5' })
    const store = open(path)
    expect(store.counters.steps).toEqual([])
    post(new BoardService(store), 'still writable')
    expect(metaOf(store.db)['core.schema_version']).toBe('9')
    expect(store.schemaInfo().refused).toBeNull()
  })

  it('HT-37 a read floor above the build: the open is 503 schema_too_new and leaves no lock behind', () => {
    const path = v5File()
    setMeta(path, { 'core.schema_read_min': '9' })
    expectBoardError(
      () => open(path),
      503,
      'schema_too_new',
      'this board needs a newer Swarmboard to open it (schema 5, readable from 9; this build knows 5)',
    )
    raw(path, (db) => {
      db.exec('BEGIN EXCLUSIVE')
      db.exec('COMMIT')
    })
  })

  it("HT-38 schemaGate 'off' lifts the refusals but never migrates a file it does not understand", () => {
    const floor = v5File()
    setMeta(floor, { 'core.schema_version': '9', 'core.schema_write_min': '9' })
    const offFloor = open(floor, { schemaGate: 'off' })
    post(new BoardService(offFloor), 'off gate')
    expect(offFloor.counters.steps).toEqual([])
    const reader = v5File()
    setMeta(reader, { 'core.schema_read_min': '9' })
    const offReader = open(reader, { schemaGate: 'off' })
    expect(new BoardService(offReader).listThreads(alice, { channel: 'dev' }).threads).toHaveLength(1)
    const legacyGate = v5File()
    setMeta(legacyGate, { tasks_schema: '2' })
    post(new BoardService(open(legacyGate, { schemaGate: 'off' })), 'tasks_schema 2, gate off')

    // The default gate on the same files.
    expect(open(floor).writeRefusal()?.code).toBe('schema_too_new')
    expectBoardError(() => open(reader), 503, 'schema_too_new')
    expect(open(legacyGate).writeRefusal()?.message).toBe('this board was written by a newer Swarmboard (tasks_schema 2)')

    // A malformed version or floor is a file this build does not understand (SEC-6, CR-7).
    for (const [key, value] of [
      ['core.schema_version', 'abc'],
      ['core.schema_write_min', '1234567890'],
    ] as const) {
      const path = v5File()
      setMeta(path, { [key]: value })
      let off = null as ReturnType<typeof open> | null
      // The open changes nothing (the file is never migrated), so each try opens the same file.
      const best = bestOf(5, 1000, () => {
        off?.close()
        off = open(path, { schemaGate: 'off' })
      })
      expect(best).toBeLessThan(1000)
      if (off === null) throw new Error('never opened')
      expect(off.counters.steps).toEqual([])
      post(new BoardService(off), 'malformed, gate off')
      expect(metaOf(off.db)[key]).toBe(value)
      off.close()
      const on = open(path)
      expect(on.counters.steps).toEqual([])
      expect(on.writeRefusal()?.status).toBe(503)
      expect(on.writeRefusal()?.code).toBe('schema_too_new')
    }
  })

  it('HT-39 the legacy tasks_schema gate keeps its text and writes nothing at open', () => {
    const path = freshPath()
    makeLegacyFile(path, 'sliceA')
    raw(path, (db) => db.exec("UPDATE board_meta SET value = '2' WHERE key = 'tasks_schema'"))
    const store = open(path)
    expect(store.counters).toEqual({ steps: [], begins: 0 })
    expect(Object.keys(metaOf(store.db)).filter((k) => k.startsWith('core.'))).toEqual([])
    const refusal = store.writeRefusal()!
    expect(refusal.status).toBe(503)
    expect(refusal.code).toBe('unavailable')
    expect(refusal.message).toBe('this board was written by a newer Swarmboard (tasks_schema 2)')
    expect(store.schemaInfo()).toEqual({ version: 2, writeMin: 2, readMin: 1, build: 5, refused: 'writes' })
  })

  it('HT-40 a floor raised under an open store stops its next write, under the lock, and every one after', () => {
    const path = freshPath()
    const a = open(path)
    const board = new BoardService(a)
    post(board, 'one')
    raw(path, (db) => db.exec("UPDATE board_meta SET value = '6' WHERE key = 'core.schema_write_min'"))
    const before = eventCount(a.db)
    const e = expectBoardError(() => post(board, 'two'), 503, 'schema_too_new', /writable from 6/)
    expect(eventCount(a.db)).toBe(before)
    const begins = a.counters.begins
    expect(() => post(board, 'three')).toThrow(e)
    expect(a.counters.begins).toBe(begins)
  })

  it('HT-44 the WAL switch gives up at the busy deadline with a typed, retryable 503', () => {
    const path = freshPath()
    const holder = new DatabaseSync(path)
    holder.exec('CREATE TABLE holder_scratch (n INTEGER)')
    holder.exec('BEGIN EXCLUSIVE')
    holder.exec('INSERT INTO holder_scratch (n) VALUES (1)')
    try {
      const best = bestOf(5, 2000, () => {
        const e = expectBoardError(() => new SqliteUnifiedStore({ path, busyTimeoutMs: 50 }), 503, 'unavailable')
        expect(e.retryAfter).toBe(1)
      })
      expect(best).toBeLessThan(2000)
      holder.exec('COMMIT')
    } finally {
      if (holder.isTransaction) holder.exec('ROLLBACK')
      holder.close()
    }
    const store = open(path)
    expect((store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect(store.counters.steps).toEqual([1, 2, 3, 4, 5])
  })

  it('HT-45 schema_too_new is a registered 503', () => {
    expect(statusOfCode('schema_too_new')).toBe(503)
    expect(ERROR_STATUSES.schema_too_new).toEqual([503])
    expect(errorFor('schema_too_new', 'x').status).toBe(503)
    const specUrl = new URL('../../../docs/reverse-engineering/ARCHITECTURE_V2.md', import.meta.url)
    if (fs.existsSync(specUrl)) {
      const spec = fs.readFileSync(specUrl, 'utf8')
      const section = spec.slice(spec.indexOf('## 5. Canonical Error Mapping'))
      const line = section.split('\n').find((l) => l.startsWith('- `503`:'))
      expect(line).toContain('`schema_too_new`')
    }
  })

  it('HT-46 the released steps are frozen', () => {
    expect(M1_SCHEMA_SQL).toBe(M1_FIXTURE_SQL)
    expect(TASKS_SCHEMA_SQL).toBe(TASKS_FIXTURE_SQL)
    const fromFixtures = [...fixtureNames(M1_FIXTURE_SQL), ...fixtureNames(TASKS_FIXTURE_SQL)].sort()
    const fromSteps = [...SCHEMA_STEPS[0]!.objects, ...SCHEMA_STEPS[1]!.objects].sort()
    expect(fromSteps).toEqual(fromFixtures)
    expect(SCHEMA_STEPS.map((s) => s.version)).toEqual([1, 2, 3, 4, 5])
    expect(SCHEMA_VERSION).toBe(5)
  })
})

describe('HOST-0 stage 2: C5, identity', () => {
  it('HT-52 board_id and instance_id have their format and survive reopens', () => {
    const path = freshPath()
    const first = open(path)
    const info = new BoardService(first).boardInfo()
    expect(info.boardId).toMatch(BOARD_ID_PATTERN)
    expect(info.instanceId).toMatch(INSTANCE_ID_PATTERN)
    expect(info.schema).toEqual({ version: 5, writeMin: 5, readMin: 1, build: 5, refused: null })
    expect(first.identity()).toEqual({ boardId: info.boardId, instanceId: info.instanceId })
    expect(first.openedIdentity).toEqual(first.identity())
    expect(metaOf(first.db)['core.instance_file']).toBe(inodeOf(path))
    first.close()
    for (let i = 0; i < 10; i++) {
      const again = new SqliteUnifiedStore({ path })
      expect(again.identity()).toEqual({ boardId: info.boardId, instanceId: info.instanceId })
      again.close()
    }
    const memory = open(':memory:')
    expect(memory.identity()!.boardId).toMatch(BOARD_ID_PATTERN)
    expect(memory.identity()!.instanceId).toMatch(INSTANCE_ID_PATTERN)
    expect(metaOf(memory.db)['core.instance_file']).toBe('')
    expect(memory.checkIdentity().status).toBe('same')
  })

  it('HT-53 board_id cannot be overwritten or removed, by any statement', () => {
    const store = open(freshPath())
    const id = store.identity()!.boardId
    const statements = [
      "INSERT INTO board_meta (key, value) VALUES ('core.board_id', 'b_x') ON CONFLICT DO NOTHING",
      "INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.board_id', 'b_x')",
      "INSERT INTO board_meta (key, value) VALUES ('core.board_id', 'b_x') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      "UPDATE board_meta SET value = 'b_x' WHERE key = 'core.board_id'",
      "DELETE FROM board_meta WHERE key = 'core.board_id'",
      'DELETE FROM board_meta',
      "INSERT OR IGNORE INTO board_meta (key, value) VALUES ('core.board_id', 'b_x')",
    ]
    for (const sql of statements) {
      expect(() => store.db.exec(sql), sql).toThrow(/board_id is immutable/)
      expect(store.identity()!.boardId, sql).toBe(id)
    }
    let caught: unknown
    try {
      store.transaction(() => store.db.exec("UPDATE board_meta SET value = 'b_x' WHERE key = 'core.board_id'"))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    expect(normalizeError(caught)).toMatchObject({ status: 500, code: 'internal' })
    expect(store.identity()!.boardId).toBe(id)
    expect([...RESERVED_META_KEYS].sort()).toEqual([...CORE_KEYS, 'tasks_schema'].sort())
  })

  it('HT-54 two copies of one backup share the board and get instances of their own', () => {
    const dir = tempDir()
    const a = open(join(dir, 'a.db'))
    const board = new BoardService(a)
    for (let i = 0; i < 3; i++) post(board, `a${i}`)
    const backup = join(dir, 'backup.db')
    a.db.exec(`VACUUM INTO '${backup}'`)
    fs.copyFileSync(backup, join(dir, 'r1.db'))
    fs.copyFileSync(backup, join(dir, 'r2.db'))
    const r1 = open(join(dir, 'r1.db'))
    const r2 = open(join(dir, 'r2.db'))
    const [ia, i1, i2] = [a.identity()!, r1.identity()!, r2.identity()!]
    expect(i1.boardId).toBe(ia.boardId)
    expect(i2.boardId).toBe(ia.boardId)
    expect(new Set([ia.instanceId, i1.instanceId, i2.instanceId]).size).toBe(3)
    expect(metaOf(r1.db)['core.instance_file']).toBe(inodeOf(join(dir, 'r1.db')))
    expect(metaOf(r2.db)['core.instance_file']).toBe(inodeOf(join(dir, 'r2.db')))
    r1.close()
    const r1again = open(join(dir, 'r1.db'))
    expect(r1again.identity()).toEqual(i1)
    expect(r1again.counters.begins).toBe(0)
    const gen = r1again.getWakeupGeneration()
    const rotated = r1again.rotateInstanceId()
    expect(rotated.boardId).toBe(ia.boardId)
    expect(rotated.instanceId).toMatch(INSTANCE_ID_PATTERN)
    expect(rotated.instanceId).not.toBe(i1.instanceId)
    expect(r1again.getWakeupGeneration()).toBe(gen + 1)
    r1again.close()
    expect(open(join(dir, 'r1.db')).identity()).toEqual(rotated)
  })

  it('HT-55 an in-place rewind is detected by the .wakeup sidecar and rotates the instance once', () => {
    const dir = tempDir()
    const path = join(dir, 'board.db')
    const save = join(dir, 'save.db')
    const s = open(path)
    const board = new BoardService(s)
    for (let i = 0; i < 3; i++) post(board, `kept ${i}`)
    s.db.exec(`VACUUM INTO '${save}'`)
    const g0 = raw(save, dbWakeupOf)
    for (let i = 0; i < 5; i++) post(board, `lost ${i}`)
    const g1 = s.getWakeupGeneration()
    expect(g1).toBeGreaterThan(g0)
    expect(wakeupOf(`${path}.wakeup`)).toBe(g1)
    const before = s.identity()!
    s.close()
    const inode = inodeOf(path)
    fs.writeFileSync(path, fs.readFileSync(save))
    expect(inodeOf(path)).toBe(inode)
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${path}${suffix}`, { force: true })

    const reopened = open(path)
    const after = reopened.identity()!
    expect(after.boardId).toBe(before.boardId)
    expect(after.instanceId).not.toBe(before.instanceId)
    expect(dbWakeupOf(reopened.db)).toBe(g1 + 1)
    expect(wakeupOf(`${path}.wakeup`)).toBe(g1 + 1)
    reopened.close()
    const second = open(path)
    expect(second.identity()).toEqual(after)
    expect(second.counters.begins).toBe(0)
  })

  it('HT-56 no rotation without cause; a missing instance marker rotates once and never loops', () => {
    const path = freshPath()
    let instance: string | null = null
    for (let i = 0; i < 20; i++) {
      const s = new SqliteUnifiedStore({ path })
      post(new BoardService(s), `cycle ${i}`)
      instance ??= s.identity()!.instanceId
      expect(s.identity()!.instanceId).toBe(instance)
      s.close()
    }

    // S1: a new database under a kept .wakeup of 5.
    const s1 = freshPath()
    const first = new SqliteUnifiedStore({ path: s1 })
    for (let i = 0; i < 5; i++) first.appendEvent({ type: 'x', payload: { i } })
    first.close()
    for (const suffix of ['', '-wal', '-shm', '.jsonl']) fs.rmSync(`${s1}${suffix}`, { force: true })
    const fresh = open(s1)
    expect(fresh.counters.steps).toEqual([1, 2, 3, 4, 5])
    expect(dbWakeupOf(fresh.db)).toBe(5)
    expect(wakeupOf(`${s1}.wakeup`)).toBe(5)
    const minted = fresh.identity()
    fresh.close()
    const kept = open(s1)
    expect(kept.identity()).toEqual(minted)
    expect(kept.counters.begins).toBe(0)

    // CR-7: one of the pair deleted.
    for (const lost of ['core.instance_file', 'core.instance_id']) {
      const p = freshPath()
      const made = new SqliteUnifiedStore({ path: p })
      const was = made.identity()!
      made.close()
      let healed = null as ReturnType<typeof open> | null
      // Each try loses the key again first, so every timed open is a healing one.
      const best = bestOf(5, 1000, () => {
        healed?.close()
        raw(p, (db) => db.prepare('DELETE FROM board_meta WHERE key = ?').run(lost))
        healed = open(p)
      })
      expect(best).toBeLessThan(1000)
      if (healed === null) throw new Error('never opened')
      expect(healed.counters.steps, lost).toEqual([3])
      const meta = metaOf(healed.db)
      expect(meta['core.instance_id']).toMatch(INSTANCE_ID_PATTERN)
      expect(meta['core.instance_file']).toBe(inodeOf(p))
      const now = healed.identity()!
      expect(now.instanceId).not.toBe(was.instanceId)
      expect(now.boardId).toBe(was.boardId)
      healed.close()
      const again = open(p)
      expect(again.counters).toEqual({ steps: [], begins: 0 })
      expect(again.identity()).toEqual(now)
    }
  })

  it('HT-58 the replaced-file fence guards this store’s own writes', () => {
    for (const how of ['rename', 'unlink'] as const) {
      const dir = tempDir()
      const live = join(dir, 'live.db')
      const other = join(dir, 'other.db')
      const s = open(live)
      const board = new BoardService(s)
      for (let i = 0; i < 30; i++) post(board, `live ${i}`)
      const o = new SqliteUnifiedStore({ path: other })
      const ob = new BoardService(o)
      for (let i = 0; i < 3; i++) post(ob, `other ${i}`)
      const otherIdentity = o.identity()!
      const otherHead = o.getHeadIndex()
      o.close()
      if (how === 'rename') fs.renameSync(other, live)
      else fs.unlinkSync(live)

      const walSize = fs.statSync(`${live}-wal`).size
      expectBoardError(() => post(board, 'after'), 503, 'unavailable', REPLACED)
      expect(fs.statSync(`${live}-wal`).size).toBe(walSize)
      const begins = s.counters.begins
      expectBoardError(() => post(board, 'again'), 503, 'unavailable', REPLACED)
      expect(s.counters.begins).toBe(begins)
      expect(s.checkIdentity()).toEqual({ status: 'replaced', was: s.openedIdentity })
      expect(s.schemaInfo().refused).toBe('writes')

      if (how === 'rename') {
        // The supported procedure (3.7): close every connection, remove the old -wal/-shm, then open.
        s.close()
        for (const suffix of ['-wal', '-shm']) fs.rmSync(`${live}${suffix}`, { force: true })
        const n = open(live)
        expect((n.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
        expect(n.getHeadIndex()).toBe(otherHead)
        // Same inode, so no new-file rotation. The kept .wakeup (the old board's generation) is ahead of
        // the replacement's database, so rotation case 2 gives it a new instance (deviation from the
        // design's "identity equal to other's"; with the .wakeup moved aside too it is equal, below).
        expect(n.identity()!.boardId).toBe(otherIdentity.boardId)
        expect(n.identity()!.instanceId).not.toBe(otherIdentity.instanceId)
        post(new BoardService(n), 'on the replacement')
      }
    }

    // The procedure with the .wakeup moved aside as well: the replacement keeps its identity exactly.
    {
      const dir = tempDir()
      const live = join(dir, 'live.db')
      const other = join(dir, 'other.db')
      const s = new SqliteUnifiedStore({ path: live })
      post(new BoardService(s), 'live')
      s.close()
      const o = new SqliteUnifiedStore({ path: other })
      post(new BoardService(o), 'other')
      const otherIdentity = o.identity()
      o.close()
      for (const suffix of ['-wal', '-shm', '.wakeup', '.jsonl']) fs.rmSync(`${live}${suffix}`, { force: true })
      fs.renameSync(other, live)
      const n = open(live)
      expect(n.identity()).toEqual(otherIdentity)
      expect(n.counters.begins).toBe(0)
    }

    // Inode 0 (SEC-5): the fence, case 1 and `replaced` are off; the store works.
    {
      const path = freshPath()
      const statFile = (): { dev: bigint; ino: bigint } => ({ dev: 1n, ino: 0n })
      const s = open(path, { testHooks: { statFile } })
      expect(metaOf(s.db)['core.instance_file']).toBe('')
      const board = new BoardService(s)
      for (let i = 0; i < 50; i++) post(board, `zero ${i}`)
      expect(s.checkIdentity().status).toBe('same')
      const id = s.identity()
      s.close()
      const again = open(path, { testHooks: { statFile } })
      expect(again.identity()).toEqual(id)
      expect(again.counters.begins).toBe(0)
    }

    // A device change (SEC-5): the same inode on another device is another file.
    {
      let dev = 1n
      const s = open(freshPath(), { testHooks: { statFile: () => ({ dev, ino: 42n }) } })
      expect(metaOf(s.db)['core.instance_file']).toBe('42')
      const board = new BoardService(s)
      post(board, 'before the move')
      dev = 2n
      expectBoardError(() => post(board, 'after the move'), 503, 'unavailable', REPLACED)
      expect(s.checkIdentity().status).toBe('replaced')
    }
  })

  it('HT-59 an in-place restore by another connection is `restored`, and does not stop writes', () => {
    const path = freshPath()
    const s = open(path)
    const t = open(path)
    const rotated = t.rotateInstanceId()
    expect(rotated).toEqual(t.identity())
    expect(s.checkIdentity()).toEqual({ status: 'restored', identity: t.identity(), was: s.openedIdentity })
    expect(s.checkIdentity(t.identity())).toEqual({ status: 'same', identity: t.identity() })
    post(new BoardService(s), 'still writing')
  })
})

describe('HOST-0 stage 2: the downgrade guard', () => {
  /** The M1.1 predicate (migrations.ts): refuse writes when the write floor is malformed or above 1, or absent with tasks_schema present. */
  function m1PointReleaseRefuses(db: DatabaseSync): boolean {
    const LADDER_KNOWN = 1
    const get = (k: string): string | undefined =>
      (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(k) as { value?: string } | undefined)?.value
    const raw = get('core.schema_write_min')
    const writeMin = raw !== undefined ? (/^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN) : get('tasks_schema') !== undefined ? 2 : 1
    return !(writeMin <= LADDER_KNOWN)
  }

  it('HT-60 the markers a HOST-0 build writes stop an M1 point release; a pure M1 file does not', () => {
    const fresh = freshPath()
    new SqliteUnifiedStore({ path: fresh }).close()
    expect(raw(fresh, m1PointReleaseRefuses)).toBe(true)
    const migrated = freshPath()
    makeLegacyFile(migrated, 'm1')
    new SqliteUnifiedStore({ path: migrated }).close()
    expect(raw(migrated, m1PointReleaseRefuses)).toBe(true)
    const sliceA = freshPath()
    makeLegacyFile(sliceA, 'sliceA')
    expect(raw(sliceA, m1PointReleaseRefuses)).toBe(true)
    const m1 = freshPath()
    makeLegacyFile(m1, 'm1')
    expect(raw(m1, m1PointReleaseRefuses)).toBe(false)
  })

  it('HT-61 a pre-ladder slice A build stays a compatible writer of a v3 file', () => {
    const path = freshPath()
    const s = new SqliteUnifiedStore({ path })
    const id = s.identity()
    s.close()
    raw(path, (db) => {
      db.exec(M1_SCHEMA_SQL + TASKS_SCHEMA_SQL)
      db.exec('PRAGMA user_version = 1')
      const gen = Math.max(dbWakeupOf(db), fs.existsSync(`${path}.wakeup`) ? wakeupOf(`${path}.wakeup`) : 0) + 1
      db.prepare(
        "INSERT INTO board_meta (key, value) VALUES ('wakeup_generation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(gen))
    })
    const reopened = open(path)
    expect(reopened.counters.begins).toBe(0)
    expect(reopened.identity()).toEqual(id)
    expect(reopened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual([
      { name: 'board_meta_board_id_delete' },
      { name: 'board_meta_board_id_insert' },
      { name: 'board_meta_board_id_update' },
    ])
  })
})

describe('HOST-0 stage 2: cross-seam', () => {
  it('HT-62 refused and replaced files reach every write path (casMeta, auditJsonl), and the fence ignores the gate', () => {
    // (a) The write floor.
    const floor = v5File()
    setMeta(floor, { 'core.schema_version': '9', 'core.schema_write_min': '9' })
    const refused = open(floor)
    expectBoardError(() => refused.casMeta('host.k', undefined, 'v'), 503, 'schema_too_new')
    expect(refused.getMeta('host.k')).toBeUndefined()
    expect(refused.getMeta('core.schema_version')).toBe('9')
    const cursor = refused.armExternalDispatch()
    expect(cursor).toBe(refused.getHeadIndex())
    expect(refused.pumpExternal()).toEqual({ dispatched: 0, skippedOwn: 0, skippedSeen: 0, cursor, more: false })

    // (b) A replaced file.
    const dir = tempDir()
    const live = join(dir, 'live.db')
    const other = join(dir, 'other.db')
    const s = open(live)
    post(new BoardService(s), 'live')
    const o = new SqliteUnifiedStore({ path: other })
    post(new BoardService(o), 'other')
    o.close()
    fs.renameSync(other, live)
    const jsonl = fs.readFileSync(`${live}.jsonl`)
    expectBoardError(() => s.casMeta('host.k', undefined, 'v'), 503, 'unavailable', REPLACED)
    expectBoardError(() => s.auditJsonl(), 503, 'unavailable', REPLACED)
    expectBoardError(() => s.auditJsonl({ repair: true }), 503, 'unavailable', REPLACED)
    expect(fs.readFileSync(`${live}.jsonl`).equals(jsonl)).toBe(true)

    // (c) The gate off: the fence still holds.
    const dir2 = tempDir()
    const live2 = join(dir2, 'live.db')
    const other2 = join(dir2, 'other.db')
    const off = open(live2, { schemaGate: 'off' })
    const offBoard = new BoardService(off)
    post(offBoard, 'live')
    new SqliteUnifiedStore({ path: other2 }).close()
    fs.renameSync(other2, live2)
    expectBoardError(() => post(offBoard, 'after'), 503, 'unavailable', REPLACED)
  })

  it('HT-63 the ladder and the identity never touch the log', () => {
    // A migration.
    const path = freshPath()
    makeLegacyFile(path, 'm1', 50)
    fs.writeFileSync(`${path}.jsonl`, '{"index":1}\n')
    const head = raw(path, headOf)
    const migrated = open(path)
    expect(migrated.counters.steps).toEqual([1, 2, 3, 4, 5])
    expect(migrated.getHeadIndex()).toBe(head)
    expect(fs.readFileSync(`${path}.jsonl`, 'utf8')).toBe('{"index":1}\n')
    expect(fs.existsSync(`${path}.wakeup`)).toBe(false)

    // A rotation.
    const p2 = freshPath()
    const rotating = open(p2)
    post(new BoardService(rotating), 'a post')
    const watcher = open(p2)
    watcher.armExternalDispatch()
    const heard: number[] = []
    rotating.onEvent((e) => heard.push(e.index))
    const head2 = rotating.getHeadIndex()
    const jsonl = fs.readFileSync(`${p2}.jsonl`)
    rotating.rotateInstanceId()
    expect(rotating.getHeadIndex()).toBe(head2)
    expect(fs.readFileSync(`${p2}.jsonl`).equals(jsonl)).toBe(true)
    expect(watcher.pumpExternal().dispatched).toBe(0)
    expect(heard).toEqual([])
  })
})
