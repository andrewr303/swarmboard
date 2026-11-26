// HOST-0 stage 2, C4 (HOST0_DESIGN 3.6): `seedDefaults` reads first, so a seeded board opens without the
// write lock; seeding happens once, in one transaction, on the injected clock. HT-47..HT-49 (HT-50 and
// HT-51 are separate processes, in schema-proc.test.ts).
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, createLocalCaller, SqliteUnifiedStore, type SqliteStoreOptions } from '../../../src/core/index.ts'

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function freshPath(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-host0-s2s-'))
  dirs.push(dir)
  return join(dir, 'board.db')
}

function open(path: string, extra: Partial<SqliteStoreOptions> = {}): SqliteUnifiedStore {
  const store = new SqliteUnifiedStore({ path, ...extra })
  stores.push(store)
  return store
}

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close()
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const metaValue = (db: DatabaseSync, key: string): string | undefined =>
  (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value

describe('HOST-0 stage 2: C4, seeds read first', () => {
  it('HT-47 a seeded board opens without the write lock', () => {
    const path = freshPath()
    const first = new SqliteUnifiedStore({ path })
    new BoardService(first).postMessage(alice, { channel: 'dev', text: 'seeded' })
    first.close()

    const holder = new DatabaseSync(path)
    holder.exec('CREATE TABLE IF NOT EXISTS scratch_holder (n INTEGER)')
    holder.exec('BEGIN IMMEDIATE')
    holder.exec('INSERT INTO scratch_holder (n) VALUES (1)')
    try {
      let begins = 0
      const store = open(path, { busyTimeoutMs: 0, testHooks: { onBeginImmediate: () => void begins++ } })
      const board = new BoardService(store)
      expect(begins).toBe(0)
      expect(board.listThreads(alice, { channel: 'dev' }).threads).toHaveLength(1)
      holder.exec('COMMIT')
    } finally {
      if (holder.isTransaction) holder.exec('ROLLBACK')
      holder.close()
    }
  })

  it('HT-48 seeding happens once, in one transaction', () => {
    let begins = 0
    const store = open(freshPath(), { testHooks: { onBeginImmediate: () => void begins++ } })
    expect(begins).toBe(5)
    new BoardService(store)
    expect(begins).toBe(6)
    new BoardService(store)
    expect(begins).toBe(6)

    let later = 0
    const bare = open(freshPath(), { testHooks: { onBeginImmediate: () => void later++ } })
    new BoardService(bare, { seedDefaultGrants: false })
    expect((bare.db.prepare('SELECT COUNT(*) AS c FROM board_grants').get() as { c: number }).c).toBe(0)
    expect(metaValue(bare.db, 'grants_seeded')).toBeUndefined()
    expect(metaValue(bare.db, 'schemas_seeded')).toBe('1')
    const atBare = later
    new BoardService(bare)
    expect(later).toBe(atBare + 1)
    expect((bare.db.prepare('SELECT COUNT(*) AS c FROM board_grants').get() as { c: number }).c).toBe(3)
    new BoardService(bare)
    expect(later).toBe(atBare + 1)
  })

  it('HT-49 seed rows use the injected clock', () => {
    const T0 = Date.UTC(2030, 4, 6, 7, 8, 9)
    const store = open(freshPath())
    new BoardService(store, { now: () => T0 })
    const rows = store.db.prepare("SELECT created_at FROM board_schemas WHERE by_actor = 'board'").all() as Array<{ created_at: string }>
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.created_at).toBe(new Date(T0).toISOString())
  })
})
