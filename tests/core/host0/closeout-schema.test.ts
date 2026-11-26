// HOST-0 closeout (HOST0_GATE_REPORT carry-over): the store-side items. S2-V1 (floors from SchemaState's legacy
// defaults), S2-V2 (`checkIdentity` on :memory:), F2 (a malformed `core.schema_version` in `schemaInfo`), F4 /
// S2-V4 (floors never fall; auditJsonl's own replaced-file check) and S2-V3 (the read order of the rewind
// evidence, and the lock re-check that keeps two openers from rotating twice).
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardError, BoardService, createLocalCaller, SqliteUnifiedStore, type SqliteStoreOptions } from '../../../src/core/index.ts'
import { makeLegacyFile } from './legacy.ts'

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-closeout-s-'))
  dirs.push(dir)
  return dir
}
const freshPath = (name = 'board.db'): string => join(tempDir(), name)

type Counted = SqliteUnifiedStore & { steps: number[]; begins: () => number }
/** A store on `path` that records its ladder steps and counts its BEGIN IMMEDIATEs (extra hooks still run). */
function open(path: string, extra: Partial<SqliteStoreOptions> = {}): Counted {
  const steps: number[] = []
  let begins = 0
  const hooks = extra.testHooks ?? {}
  const store = new SqliteUnifiedStore({
    path,
    ...extra,
    testHooks: {
      ...hooks,
      onSchemaStep: (v) => {
        steps.push(v)
        hooks.onSchemaStep?.(v)
      },
      onBeginImmediate: () => {
        begins += 1
        hooks.onBeginImmediate?.()
      },
    },
  })
  stores.push(store)
  return Object.assign(store, { steps, begins: () => begins })
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
const wakeupOf = (path: string): number => Number(fs.readFileSync(path).readBigUInt64LE(0))
const writeWakeup = (path: string, gen: number): void => {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(gen), 0)
  fs.writeFileSync(path, buf)
}
const dbWakeupOf = (db: DatabaseSync): number =>
  Number((db.prepare("SELECT value FROM board_meta WHERE key = 'wakeup_generation'").get() as { value?: string } | undefined)?.value ?? 0)

const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const post = (store: SqliteUnifiedStore, text: string): void => void new BoardService(store).postMessage(alice, { channel: 'dev', text })
const REPLACED = 'the board file was replaced or removed while this store had it open: open it again'

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

describe('HOST-0 closeout: the ladder floors', () => {
  it('closeout S2-V1 a crash after step 1 keeps a slice A file at write floor 2; an M1 file gets 1', () => {
    for (const [kind, floor] of [
      ['sliceA', '2'],
      ['m1', '1'],
    ] as const) {
      const path = freshPath()
      makeLegacyFile(path, kind, 5)
      const crash = new Error('crash inside step 2')
      const e = thrown(
        () =>
          new SqliteUnifiedStore({
            path,
            testHooks: {
              onSchemaStep: (v) => {
                if (v === 2) throw crash
              },
            },
          }),
      )
      expect(e, kind).toBe(crash)
      raw(path, (db) => {
        const meta = metaOf(db)
        expect(meta['core.schema_version'], kind).toBe('1')
        expect(meta['core.schema_write_min'], kind).toBe(floor)
        expect(meta['core.schema_read_min'], kind).toBe('1')
        expect(meta.tasks_schema, kind).toBe(kind === 'sliceA' ? '1' : undefined)
      })
      // A reopen finishes the ladder and lands on the v5 floors either way.
      const store = open(path)
      expect(store.steps, kind).toEqual([2, 3, 4, 5])
      expect(metaOf(store.db), kind).toMatchObject({ 'core.schema_version': '5', 'core.schema_write_min': '5', 'core.schema_read_min': '1' })
    }
  })

  it('closeout F4 floors never fall: a step re-run on a file whose floors are above its own keeps them', () => {
    const path = freshPath()
    new SqliteUnifiedStore({ path }).close()
    raw(path, (db) => {
      db.prepare("UPDATE board_meta SET value = '5' WHERE key = 'core.schema_write_min'").run()
      db.prepare("UPDATE board_meta SET value = '2' WHERE key = 'core.schema_read_min'").run()
      // A deleted step 3 object makes `effective` 2, so step 3 (writeMin 2, readMin 1) runs again.
      db.exec('DROP TRIGGER board_meta_board_id_delete')
    })
    const store = open(path)
    expect(store.steps).toEqual([3])
    expect(store.writeRefusal()).toBeNull()
    expect(metaOf(store.db)).toMatchObject({ 'core.schema_version': '5', 'core.schema_write_min': '5', 'core.schema_read_min': '2' })
    expect(store.schemaInfo()).toEqual({ version: 5, writeMin: 5, readMin: 2, build: 5, refused: null })
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'board_meta_board_id_delete'").get()).toBeDefined()
  })
})

describe('HOST-0 closeout: schemaInfo on a malformed version (F2)', () => {
  it('closeout F2 a malformed core.schema_version reports the inferred version and malformed: true', () => {
    // Normal: no `malformed` key at all.
    const normal = open(freshPath())
    expect(normal.schemaInfo()).toEqual({ version: 5, writeMin: 5, readMin: 1, build: 5, refused: null })
    expect('malformed' in normal.schemaInfo()).toBe(false)
    expect(new BoardService(normal).boardInfo().schema).toEqual(normal.schemaInfo())

    // Absent (a legacy file under a refusal, so nothing migrates it): inferred, not malformed.
    const legacy = freshPath()
    makeLegacyFile(legacy, 'sliceA')
    raw(legacy, (db) => db.exec("UPDATE board_meta SET value = '2' WHERE key = 'tasks_schema'"))
    const absent = open(legacy)
    expect(absent.schemaInfo()).toEqual({ version: 2, writeMin: 2, readMin: 1, build: 5, refused: 'writes' })
    expect('malformed' in absent.schemaInfo()).toBe(false)

    // Malformed version: 2 on a file with tasks_schema, 1 without; JSON keeps a number.
    for (const [withTasks, inferred] of [
      [true, 2],
      [false, 1],
    ] as const) {
      const path = freshPath()
      new SqliteUnifiedStore({ path }).close()
      raw(path, (db) => {
        db.prepare("UPDATE board_meta SET value = 'abc' WHERE key = 'core.schema_version'").run()
        if (!withTasks) db.exec("DELETE FROM board_meta WHERE key = 'tasks_schema'")
      })
      const store = open(path)
      const info = store.schemaInfo()
      expect(info).toEqual({ version: inferred, writeMin: 5, readMin: 1, build: 5, refused: 'writes', malformed: true })
      expect(JSON.parse(JSON.stringify(info)).version).toBe(inferred)
      expect(new BoardService(store).boardInfo().schema).toEqual(info)
    }

    // A malformed floor is reported the same way: the default, never NaN, and malformed: true.
    const floor = freshPath()
    new SqliteUnifiedStore({ path: floor }).close()
    raw(floor, (db) => db.prepare("UPDATE board_meta SET value = '1234567890' WHERE key = 'core.schema_read_min'").run())
    const info = open(floor, { schemaGate: 'off' }).schemaInfo()
    expect(info).toEqual({ version: 5, writeMin: 5, readMin: 1, build: 5, refused: null, malformed: true })

    // The same for a malformed WRITE floor (verifier finding F-2: only the read floor was covered, so putting
    // `writeMin: s.writeMin` back, which reports NaN, survived): the inferred default, never NaN, malformed: true.
    for (const bad of ['1234567890', 'abc', '']) {
      const writeFloor = freshPath()
      new SqliteUnifiedStore({ path: writeFloor }).close()
      raw(writeFloor, (db) => db.prepare("UPDATE board_meta SET value = ? WHERE key = 'core.schema_write_min'").run(bad))
      const got = open(writeFloor, { schemaGate: 'off' }).schemaInfo()
      expect(Number.isNaN(got.writeMin), `write floor ${JSON.stringify(bad)} must never report NaN`).toBe(false)
      expect(got).toEqual({ version: 5, writeMin: 2, readMin: 1, build: 5, refused: null, malformed: true })
      expect(JSON.parse(JSON.stringify(got)).writeMin).toBe(2)
    }
  })
})

describe('HOST-0 closeout: identity', () => {
  it('closeout S2-V2 checkIdentity on :memory: is always same, also after the store rotates itself', () => {
    const memory = open(':memory:')
    const opened = memory.identity()!
    expect(memory.checkIdentity()).toEqual({ status: 'same', identity: opened })
    const rotated = memory.rotateInstanceId()
    expect(rotated.instanceId).not.toBe(opened.instanceId)
    expect(memory.checkIdentity()).toEqual({ status: 'same', identity: rotated })
    expect(memory.checkIdentity(opened)).toEqual({ status: 'same', identity: rotated })
    // Control: a file store that rotates itself is `restored` against its opened identity.
    const file = open(freshPath())
    const was = file.openedIdentity
    const now = file.rotateInstanceId()
    expect(file.checkIdentity()).toEqual({ status: 'restored', identity: now, was })
  })

  it('closeout S2-V3 the rewind evidence reads the .wakeup file before the database: a live commit between them takes no lock', () => {
    const path = freshPath()
    const first = new SqliteUnifiedStore({ path })
    post(first, 'before')
    const instance = first.identity()!.instanceId
    first.close()
    const writer = open(path)
    let fired = 0
    const gen0 = writer.getWakeupGeneration()
    // Between the two generation reads, another connection commits: the database first, then the file.
    const reader = open(path, {
      testHooks: {
        betweenWakeupReads: () => {
          if (fired++ > 0) return
          writer.appendEvent({ type: 'x.write', payload: {} })
        },
      },
    })
    expect(fired).toBeGreaterThan(0)
    expect(writer.getWakeupGeneration()).toBe(gen0 + 1)
    expect(wakeupOf(`${path}.wakeup`)).toBe(gen0 + 1)
    // File first sees the old file and the new database: no evidence, so no write lock at open.
    expect(reader.begins()).toBe(0)
    expect(reader.identity()!.instanceId).toBe(instance)
    expect(reader.checkIdentity()).toEqual({ status: 'same', identity: writer.identity() })
  })

  it('closeout S2-V3 the lock re-check: an opener that another rotated first does not rotate again', () => {
    const path = freshPath()
    const first = new SqliteUnifiedStore({ path })
    post(first, 'before')
    const original = first.identity()!
    first.close()
    // An in-place rewind's evidence: the .wakeup sidecar ahead of the database.
    const g = raw(path, dbWakeupOf)
    writeWakeup(`${path}.wakeup`, g + 5)
    const seen: { other: Counted | null } = { other: null }
    const late = open(path, {
      testHooks: {
        // Just before the late opener's BEGIN IMMEDIATE (its unlocked read saw the evidence), another opener rotates.
        onBeginImmediate: () => {
          seen.other ??= open(path)
        },
      },
    })
    expect(seen.other).not.toBeNull()
    const winner = seen.other!.identity()!
    expect(winner.boardId).toBe(original.boardId)
    expect(winner.instanceId).not.toBe(original.instanceId)
    // The late opener took the lock, found the evidence gone, and rotated nothing.
    expect(late.begins()).toBe(1)
    expect(late.identity()).toEqual(winner)
    expect(late.openedIdentity).toEqual(winner)
    expect(raw(path, dbWakeupOf)).toBe(g + 6)
    expect(wakeupOf(`${path}.wakeup`)).toBe(g + 6)
  })
})

describe('HOST-0 closeout: auditJsonl on a replaced file (S2-V4)', () => {
  it('closeout S2-V4 auditJsonl refuses a freshly replaced store by its own check, before any write saw it', () => {
    for (const repair of [false, true]) {
      const dir = tempDir()
      const live = join(dir, 'live.db')
      const other = join(dir, 'other.db')
      const s = open(live)
      post(s, 'live')
      const o = new SqliteUnifiedStore({ path: other })
      post(o, 'other')
      o.close()
      fs.renameSync(other, live)
      const jsonl = fs.readFileSync(`${live}.jsonl`)
      const begins = s.begins()
      // auditJsonl is the first call after the replacement: nothing has set the sticky refusal yet.
      expect(s.writeRefusal()).toBeNull()
      const e = thrown(() => s.auditJsonl({ repair }))
      expect(e).toBeInstanceOf(BoardError)
      expect(e).toMatchObject({ status: 503, code: 'unavailable', message: REPLACED })
      expect(fs.readFileSync(`${live}.jsonl`).equals(jsonl)).toBe(true)
      expect(s.begins()).toBe(begins)
      // The refusal is sticky now, for writes too.
      expect(s.writeRefusal()?.message).toBe(REPLACED)
      expect(thrown(() => s.auditJsonl())).toBe(e)
    }
  })
})
