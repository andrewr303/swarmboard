// Core Scale Hardening regression tests:
// 1. Rowid-keyed FTS5 for fts_messages + safe v3->v4 upgrade migration + zero FTS scan on edits/deletes/reactions
// 2. Bounded WAL pragmas (wal_autocheckpoint = 1000, journal_size_limit = 67108864) on file-backed stores
// 3. F23 claimReady busy-wait fix under busy_timeout = 50 (retries transient SQLITE_BUSY/SQLITE_LOCKED within deadline,
//    honors abort, and propagates closed-store/non-busy errors immediately)
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  SCHEMA_VERSION,
  SqliteUnifiedStore,
  type SqliteStoreOptions,
} from '../../src/core/index.ts'
import { SCHEMA_STEPS, type SchemaStepContext } from '../../src/core/migrations.ts'

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function freshPath(name = 'board.db'): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-scale-'))
  dirs.push(dir)
  return join(dir, name)
}

function openStore(path: string, extra: Partial<SqliteStoreOptions> = {}): SqliteUnifiedStore {
  const store = new SqliteUnifiedStore({ path, ...extra })
  stores.push(store)
  return store
}

afterEach(() => {
  vi.restoreAllMocks()
  while (stores.length > 0) {
    try {
      stores.pop()!.close()
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const bob = createLocalCaller({ userId: 'bob', handle: 'bob', member: true })
const ALICE = alice.principal.id

function preparedBy(store: SqliteUnifiedStore, fn: () => void): string[] {
  const seen: string[] = []
  const db = store.db
  const real = db.prepare.bind(db)
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    seen.push(sql)
    return real(sql)
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return seen
}

describe('Core Scale Fix 1: Rowid-keyed FTS5 for fts_messages & v3->v4 migration', () => {
  it('uses O(log N) rowid point lookup (INDEX 0:=) on edit/delete and skips FTS on react/label', () => {
    const store = openStore(':memory:')
    const board = new BoardService(store)

    // EXPLAIN QUERY PLAN proof: rowid delete uses FTS5 rowid lookup (INDEX 0:=), unlike UNINDEXED message_id scan (INDEX 0:)
    const rowidPlan = store.db
      .prepare('EXPLAIN QUERY PLAN DELETE FROM fts_messages WHERE rowid = ?')
      .all(1) as Array<{ detail: string }>
    const scanPlan = store.db
      .prepare('EXPLAIN QUERY PLAN DELETE FROM fts_messages WHERE message_id = ?')
      .all('1') as Array<{ detail: string }>
    expect(rowidPlan.some((r) => /VIRTUAL TABLE INDEX 0:=/.test(r.detail))).toBe(true)
    expect(scanPlan.some((r) => /VIRTUAL TABLE INDEX 0:$/.test(r.detail))).toBe(true)

    const { message: m1 } = board.postMessage(alice, {
      channel: 'dev',
      text: 'alpha launch checklist',
      labels: { stage: 'draft' },
    })
    const m1Row = store.db
      .prepare('SELECT rowid, message_id, body FROM fts_messages WHERE rowid = ?')
      .get(Number(m1.id)) as { rowid: number; message_id: string; body: string } | undefined
    expect(m1Row).toEqual({ rowid: Number(m1.id), message_id: m1.id, body: 'alpha launch checklist' })

    // Edit issues DELETE WHERE rowid = ? (never WHERE message_id = ?) + INSERT OR REPLACE with rowid
    const editSql = preparedBy(store, () => {
      board.editMessage(alice, m1.id, { text: 'beta rollout checklist' })
    })
    expect(editSql.some((s) => /DELETE\s+FROM\s+fts_messages\s+WHERE\s+rowid\s*=\s*\?/i.test(s))).toBe(true)
    expect(editSql.some((s) => /DELETE\s+FROM\s+fts_messages\s+WHERE\s+message_id/i.test(s))).toBe(false)
    expect(editSql.some((s) => /INSERT\s+OR\s+REPLACE\s+INTO\s+fts_messages\s*\(\s*rowid\b/i.test(s))).toBe(true)

    // React and label do NOT touch fts_messages at all
    const reactSql = preparedBy(store, () => {
      board.reactMessage(alice, m1.id, { emoji: '+1' })
      board.reactMessage(alice, m1.id, { emoji: '+1', remove: true })
    })
    expect(reactSql.filter((s) => /fts_messages/i.test(s))).toEqual([])

    const labelSql = preparedBy(store, () => {
      board.labelMessage(alice, m1.id, { set: { stage: 'shipped' } })
    })
    expect(labelSql.filter((s) => /fts_messages/i.test(s))).toEqual([])

    // Search (with and without label filter) and read --text (listChannelMessages text filter) stay accurate
    expect(board.search(alice, { query: 'alpha' }).filter((h) => h.kind === 'message')).toEqual([])
    expect(
      board.search(alice, { query: 'beta', labels: [{ key: 'stage', values: ['shipped'] }] }).map((h) => h.id),
    ).toEqual([m1.id])
    expect(board.listThreads(alice, { channel: 'dev', text: 'rollout' }).threads.map((t) => t.message.id)).toEqual([m1.id])

    // Delete issues DELETE WHERE rowid = ? and removes the row cleanly
    const delSql = preparedBy(store, () => {
      board.deleteMessage(alice, m1.id)
    })
    expect(delSql.some((s) => /DELETE\s+FROM\s+fts_messages\s+WHERE\s+rowid\s*=\s*\?/i.test(s))).toBe(true)
    expect(delSql.some((s) => /DELETE\s+FROM\s+fts_messages\s+WHERE\s+message_id/i.test(s))).toBe(false)
    expect(board.search(alice, { query: 'beta' }).filter((h) => h.kind === 'message')).toEqual([])
    expect(store.db.prepare('SELECT rowid FROM fts_messages WHERE rowid = ?').get(Number(m1.id))).toBeUndefined()
  })

  it('edits, deletes, and reacts complete in single-digit ms on a 25,000-row fts_messages index', () => {
    const store = openStore(freshPath('perf.db'))
    const board = new BoardService(store)

    const targets: string[] = []
    for (let i = 0; i < 12; i++) {
      targets.push(board.postMessage(alice, { channel: 'dev', text: `target message number ${i} xenon` }).message.id)
    }

    // Pad fts_messages with 25,000 rows (with non-colliding high rowids, simulating a large board)
    store.transaction(() => {
      const ins = store.db.prepare(
        'INSERT INTO fts_messages (rowid, message_id, channel, thread, body) VALUES (?, ?, ?, ?, ?)',
      )
      for (let i = 0; i < 25_000; i++) {
        const id = 10_000_000 + i
        ins.run(id, String(id), 'pad', String(id), `background chatter row ${i} lorem ipsum dolor sit amet`)
      }
    })

    // Warm statement cache with target[0]
    board.editMessage(alice, targets[0]!, { text: 'warmed edit krypton' })
    board.reactMessage(alice, targets[0]!, { emoji: '+1' })
    board.deleteMessage(alice, targets[0]!)

    const editTimes: number[] = []
    const reactTimes: number[] = []
    const deleteTimes: number[] = []
    for (let i = 1; i < targets.length; i++) {
      const id = targets[i]!
      let t0 = performance.now()
      board.editMessage(alice, id, { text: `edited target ${i} argon` })
      editTimes.push(performance.now() - t0)

      t0 = performance.now()
      board.reactMessage(alice, id, { emoji: '+1' })
      reactTimes.push(performance.now() - t0)

      t0 = performance.now()
      board.deleteMessage(alice, id)
      deleteTimes.push(performance.now() - t0)
    }

    const median = (xs: number[]): number => {
      const sorted = [...xs].sort((a, b) => a - b)
      return sorted[Math.floor(sorted.length / 2)]!
    }
    // Before rowid keying, a 25k full FTS scan took ~250ms per edit/delete/react.
    // With rowid lookup, each is sub-millisecond (generous < 10 ms ceiling under parallel suite load).
    expect(median(editTimes)).toBeLessThan(10)
    expect(median(reactTimes)).toBeLessThan(10)
    expect(median(deleteTimes)).toBeLessThan(10)
    expect(board.search(alice, { query: 'xenon' }).filter((h) => h.kind === 'message')).toEqual([])
    expect(board.search(alice, { query: 'argon' }).filter((h) => h.kind === 'message')).toEqual([])
  })

  it('safely migrates an existing v3 database with misaligned/swapped fts_messages rowids without data loss', () => {
    const dbPath = freshPath('v3-upgrade.db')
    const init = new SqliteUnifiedStore({ path: dbPath })
    const initBoard = new BoardService(init)
    const m1 = initBoard.postMessage(alice, { channel: 'dev', text: 'first alpha message' }).message
    const m2 = initBoard.postMessage(alice, { channel: 'dev', text: 'second bravo message' }).message
    const m3 = initBoard.postMessage(alice, { channel: 'dev', text: 'third charlie message' }).message
    const mDel = initBoard.postMessage(alice, { channel: 'dev', text: 'deleted delta message' }).message
    initBoard.deleteMessage(alice, mDel.id)
    const taskRoot = initBoard.tasks.createTask(alice, { channel: 'dev', text: 'task echo root' }).task
    init.close()

    // Simulate a real v3 database whose fts_messages rows have drifted/swapped rowids (from prior v3 edits/gaps),
    // a live whitespace-only message (e.g. attachment-only post), and a stale tombstone row left behind.
    const emptyMsgId = 900_000
    const raw = new DatabaseSync(dbPath)
    try {
      raw.exec('BEGIN IMMEDIATE')
      raw.exec("UPDATE board_meta SET value = '3' WHERE key = 'core.schema_version'")
      raw.exec("UPDATE board_meta SET value = '2' WHERE key = 'core.schema_write_min'")
      raw.prepare(
        `INSERT INTO board_messages (id, event_id, channel, re, reply_to, thread, by_actor, by_principal, by_profile,
           from_key, no_sync, text, text_lower, deleted, created_at, edited_at, replies, at, version, revision, data)
         VALUES (?, 'evt-empty-900000', 'dev', NULL, NULL, ?, ?, ?, NULL, NULL, 0, '   \t\n  ', '   \t\n  ', 0, 1, NULL, 0, ?, 1, 1, '{}')`,
      ).run(emptyMsgId, String(emptyMsgId), alice.actor.id, alice.principal.id, emptyMsgId)
      raw.exec('DELETE FROM fts_messages')
      const ins = raw.prepare(
        'INSERT INTO fts_messages (rowid, message_id, channel, thread, body) VALUES (?, ?, ?, ?, ?)',
      )
      // Deliberately swap rowids of m1 & m2, shift m3 to 99999, and leave a stale deleted row for mDel!
      ins.run(Number(m2.id), m1.id, 'dev', m1.thread, 'first alpha message')
      ins.run(Number(m1.id), m2.id, 'dev', m2.thread, 'second bravo message')
      ins.run(99_999, m3.id, 'dev', m3.thread, 'third charlie message')
      ins.run(88_888, mDel.id, 'dev', mDel.thread, 'deleted delta message')
      ins.run(77_777, taskRoot.id, 'dev', taskRoot.thread, 'task echo root')
      raw.exec('COMMIT')
    } finally {
      raw.close()
    }

    // Reopen: Steps 4 and 5 run once and cleanly align every live rowid = board_messages.id
    const steps: number[] = []
    const upgraded = openStore(dbPath, { testHooks: { onSchemaStep: (v) => void steps.push(v) } })
    expect(steps).toEqual([4, 5])
    expect(upgraded.schemaInfo()).toEqual({ version: SCHEMA_VERSION, writeMin: 5, readMin: 1, build: 5, refused: null })

    const ftsRows = upgraded.db
      .prepare('SELECT rowid, message_id, body FROM fts_messages ORDER BY rowid ASC')
      .all() as Array<{ rowid: number; message_id: string; body: string }>
    expect(ftsRows).toEqual([
      { rowid: Number(m1.id), message_id: m1.id, body: 'first alpha message' },
      { rowid: Number(m2.id), message_id: m2.id, body: 'second bravo message' },
      { rowid: Number(m3.id), message_id: m3.id, body: 'third charlie message' },
      { rowid: Number(taskRoot.id), message_id: taskRoot.id, body: 'task echo root' },
    ])
    // Empty and deleted messages are excluded
    expect(ftsRows.some((r) => r.message_id === String(emptyMsgId) || r.message_id === mDel.id)).toBe(false)

    // Subsequent edit/delete/react/search/read/rebuildIndex all work cleanly without collateral damage
    const board = new BoardService(upgraded)
    board.editMessage(alice, m1.id, { text: 'first alpha updated foxtrot' })
    expect(board.search(alice, { query: 'foxtrot' }).map((h) => h.id)).toEqual([m1.id])
    expect(board.search(alice, { query: 'bravo' }).map((h) => h.id)).toEqual([m2.id])
    expect(board.search(alice, { query: 'charlie' }).map((h) => h.id)).toEqual([m3.id])
    expect(board.search(alice, { query: 'delta' })).toEqual([])

    board.deleteMessage(alice, m2.id)
    expect(board.search(alice, { query: 'bravo' })).toEqual([])
    expect(board.search(alice, { query: 'foxtrot' }).map((h) => h.id)).toEqual([m1.id])

    board.reactMessage(alice, m3.id, { emoji: '+1' })
    expect(board.listThreads(alice, { channel: 'dev', text: 'charlie' }).threads.map((t) => t.message.id)).toEqual([m3.id])

    const rebuilt = board.tasks.rebuildIndex()
    expect(rebuilt.tasks).toBe(1)
    expect(board.search(alice, { query: 'echo', scope: 'tasks' }).map((h) => h.id)).toEqual([taskRoot.id])

    // Running Step 4 again directly on the populated DB is strictly idempotent
    const beforeIdem = upgraded.db.prepare('SELECT rowid, message_id, channel, thread, body FROM fts_messages ORDER BY rowid').all()
    const ctx: SchemaStepContext = {
      wakeupFileGeneration: () => 0,
      wakeupDbGeneration: () => 0,
      fileId: '',
      newId: (p) => `${p}${'0'.repeat(32)}`,
    }
    upgraded.transaction(() => {
      SCHEMA_STEPS[3]!.up(upgraded.db, ctx)
    })
    expect(upgraded.db.prepare('SELECT rowid, message_id, channel, thread, body FROM fts_messages ORDER BY rowid').all()).toEqual(beforeIdem)

    upgraded.close()

    // Second reopen is completely read-only (0 steps, 0 BEGIN IMMEDIATE)
    let begins = 0
    const steps2: number[] = []
    const reopened = openStore(dbPath, {
      testHooks: {
        onSchemaStep: (v) => void steps2.push(v),
        onBeginImmediate: () => void (begins += 1),
      },
    })
    expect(steps2).toEqual([])
    expect(begins).toBe(0)
    expect(reopened.schemaInfo().version).toBe(5)
  })
})

describe('Core Scale Fix 2: Bounded WAL pragmas in SqliteUnifiedStore', () => {
  it('sets wal_autocheckpoint=1000 and journal_size_limit=67108864 by default on file-backed stores', () => {
    const dbPath = freshPath('wal-defaults.db')
    const store = openStore(dbPath)
    expect((store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode.toLowerCase()).toBe('wal')
    expect((store.db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint).toBe(1000)
    expect((store.db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number }).journal_size_limit).toBe(67_108_864)

    // Writes + explicit TRUNCATE checkpoint + close stay healthy
    const board = new BoardService(store)
    for (let i = 0; i < 20; i++) board.postMessage(alice, { channel: 'dev', text: `wal check ${i}` })
    const ckpt = store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
    expect(ckpt.busy).toBe(0)
    store.close()
  })

  it('supports overriding walAutocheckpoint and journalSizeLimitBytes, and opens under concurrent write lock with busyTimeoutMs=0', () => {
    const dbPath = freshPath('wal-custom.db')
    const seed = new SqliteUnifiedStore({ path: dbPath })
    new BoardService(seed).postMessage(alice, { channel: 'dev', text: 'seeded' })
    seed.close()

    const holder = new DatabaseSync(dbPath)
    holder.exec('BEGIN IMMEDIATE')
    try {
      const store = openStore(dbPath, {
        busyTimeoutMs: 0,
        walAutocheckpoint: 250,
        journalSizeLimitBytes: 16 * 1024 * 1024,
      })
      expect((store.db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint).toBe(250)
      expect((store.db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number }).journal_size_limit).toBe(
        16 * 1024 * 1024,
      )
      holder.exec('COMMIT')
    } finally {
      if (holder.isTransaction) holder.exec('ROLLBACK')
      holder.close()
    }

    // :memory: store remains unaffected
    const mem = openStore(':memory:')
    expect(mem.getHeadIndex()).toBe(0)
  })
})

describe('Core Scale Fix 3: F23 claimReady survives transient SQLITE_BUSY during wait re-poll', () => {
  it('survives a 250ms write-lock hold under busy_timeout=50 during wait re-poll and claims as soon as lock releases', async () => {
    const dbPath = freshPath('f23-repoll.db')
    const writerStore = openStore(dbPath, { busyTimeoutMs: 5000 })
    const waiterStore = openStore(dbPath, { busyTimeoutMs: 50 })
    const writerBoard = new BoardService(writerStore)
    const waiterBoard = new BoardService(waiterStore)
    // Seed channel & actors before waiting
    writerBoard.createChannel(alice, { path: 'dev' })
    writerBoard.postMessage(bob, { channel: 'dev', text: 'hello' })

    const waiting = waiterBoard.tasks.claimReady(bob, { channel: 'dev', from: [ALICE], wait: 5 })
    await new Promise((r) => setTimeout(r, 80))

    // Create task and IMMEDIATELY hold BEGIN IMMEDIATE for 250ms (> 50ms busy_timeout) so waiter's re-poll hits SQLITE_BUSY
    const { task } = writerBoard.tasks.createTask(alice, { channel: 'dev', text: 'busy-survived job' })
    writerStore.db.exec('BEGIN IMMEDIATE')
    let releasedAt = 0
    const releaseTimer = setTimeout(() => {
      releasedAt = performance.now()
      writerStore.db.exec('COMMIT')
    }, 250)

    try {
      const claimed = await waiting
      const afterRelease = performance.now() - releasedAt
      expect(claimed.task?.id).toBe(task.id)
      expect(releasedAt).toBeGreaterThan(0)
      expect(afterRelease).toBeLessThan(1000)
    } finally {
      clearTimeout(releaseTimer)
      if (writerStore.db.isTransaction) writerStore.db.exec('ROLLBACK')
    }
  })

  it('survives transient SQLITE_BUSY on the initial attempt when wait > 0, but throws when wait = 0', async () => {
    const dbPath = freshPath('f23-initial.db')
    const writerStore = openStore(dbPath, { busyTimeoutMs: 5000 })
    const waiterStore = openStore(dbPath, { busyTimeoutMs: 50 })
    const writerBoard = new BoardService(writerStore)
    const waiterBoard = new BoardService(waiterStore)

    const { task } = writerBoard.tasks.createTask(alice, { channel: 'dev', text: 'ready under lock' })
    writerStore.db.exec('BEGIN IMMEDIATE')
    const releaseTimer = setTimeout(() => {
      writerStore.db.exec('COMMIT')
    }, 220)

    try {
      // wait: 0 (single-shot) still surfaces SQLITE_BUSY immediately
      await expect(waiterBoard.tasks.claimReady(bob, { channel: 'dev', from: [ALICE], wait: 0 })).rejects.toMatchObject({
        code: 'ERR_SQLITE_ERROR',
      })
      // wait > 0 retries cleanly until the lock releases and claims the task
      const claimed = await waiterBoard.tasks.claimReady(bob, { channel: 'dev', from: [ALICE], wait: 3 })
      expect(claimed.task?.id).toBe(task.id)
    } finally {
      clearTimeout(releaseTimer)
      if (writerStore.db.isTransaction) writerStore.db.exec('ROLLBACK')
    }
  })

  it('honors caller deadline and signal abort under sustained SQLITE_BUSY, and propagates closed/non-busy errors immediately', async () => {
    const dbPath = freshPath('f23-bounds.db')
    const writerStore = openStore(dbPath, { busyTimeoutMs: 5000 })
    const waiterStore = openStore(dbPath, { busyTimeoutMs: 50 })
    const writerBoard = new BoardService(writerStore)
    const waiterBoard = new BoardService(waiterStore)

    const { task } = writerBoard.tasks.createTask(alice, { channel: 'dev', text: 'locked task' })
    writerStore.db.exec('BEGIN IMMEDIATE')
    try {
      // (a) Deadline is never extended past wait + single busy_timeout slack
      const t0 = performance.now()
      const timedOut = await waiterBoard.tasks.claimReady(bob, { channel: 'dev', from: [ALICE], wait: 0.35 })
      const elapsed = performance.now() - t0
      expect(timedOut).toEqual({ task: null })
      expect(elapsed).toBeGreaterThanOrEqual(300)
      expect(elapsed).toBeLessThan(800)

      // (b) Abort signal stops busy-retry promptly
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 120)
      const t1 = performance.now()
      const aborted = await waiterBoard.tasks.claimReady(bob, { channel: 'dev', from: [ALICE], wait: 10 }, ac.signal)
      const abortElapsed = performance.now() - t1
      expect(aborted).toEqual({ task: null })
      expect(abortElapsed).toBeLessThan(500)
    } finally {
      if (writerStore.db.isTransaction) writerStore.db.exec('ROLLBACK')
    }
    // Task remained unclaimed through both timeout and abort
    expect(writerBoard.getMessageThread(alice, task.id).message.task?.state).toBe('ready')

    // (c) Closed-store error propagates immediately (never swallowed as busy)
    const closedStore = openStore(freshPath('f23-closed.db'), { busyTimeoutMs: 50 })
    const closedBoard = new BoardService(closedStore)
    const waitOnClose = closedBoard.tasks.claimReady(alice, { channel: 'dev', wait: 10 })
    await new Promise((r) => setTimeout(r, 60))
    const tClose = performance.now()
    closedStore.close()
    await expect(waitOnClose).rejects.toSatisfy(
      (e: unknown) => e instanceof BoardError && e.status === 503 && e.code === 'unavailable' && e.message === 'storage is closed',
    )
    expect(performance.now() - tClose).toBeLessThan(1000)

    // (d) SQLITE_LOCKED (errcode 6) is also retried cleanly during wait
    const lockedStore = openStore(':memory:')
    const lockedBoard = new BoardService(lockedStore)
    const { task: tLocked } = lockedBoard.tasks.createTask(alice, { channel: 'dev', text: 'transient locked' })
    let lockedThrows = 2
    const realTx = lockedStore.transaction.bind(lockedStore)
    vi.spyOn(lockedStore, 'transaction').mockImplementation((fn) => {
      if (lockedThrows > 0) {
        lockedThrows -= 1
        throw Object.assign(new Error('database table is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 6 })
      }
      return realTx(fn)
    })
    const gotLocked = await lockedBoard.tasks.claimReady(alice, { channel: 'dev', wait: 3 })
    expect(gotLocked.task?.id).toBe(tLocked.id)
    expect(lockedThrows).toBe(0)
  })
})
