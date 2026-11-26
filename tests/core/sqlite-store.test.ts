import * as fs from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardError, BoardService, createLocalCaller, SqliteUnifiedStore, toErrorPayload } from '../../src/core/index.ts'
import { releaseWakeupLock, staleWakeupLock } from '../../src/core/sqlite-store.ts'

const tempDirs: string[] = []

function makeTempDb(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(join(import.meta.dirname, '.tmp-store-'))
  tempDirs.push(dir)
  return { dir, dbPath: join(dir, 'board.sqlite') }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('SqliteUnifiedStore (WAL, Transactions, Sidecars, Wakeup, M2 Tables)', () => {
  it('enables WAL mode, creates M2 extension tables & FTS5 tables, and maintains monotonic cursors', () => {
    const { dbPath } = makeTempDb()
    const store = new SqliteUnifiedStore({ path: dbPath })
    try {
      const mode = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(mode.journal_mode.toLowerCase()).toBe('wal')

      const tables = new Set(
        (
          store.db
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      )

      const requiredTables = [
        'board_events',
        'board_channels',
        'board_messages',
        'board_versions',
        'board_terms',
        'board_actors',
        'board_grants',
        'board_schemas',
        'board_schedules',
        'board_attachments',
        'board_upload_tickets',
        'board_watchers',
        'board_watcher_matches',
        'board_sync_threads',
        'board_external_threads',
        'board_copies',
        'board_external_messages',
        'board_inbox',
        'board_meta',
        'fts_messages',
        'fts_tasks',
        'fts_knowledge',
        'org_nodes',
        'departments',
        'squads',
        'agent_cards',
        'communication_flows',
        'bridge_rfcs',
        'envelopes_v2',
        'deliveries',
        'escalations',
        'reservations',
        'build_slots',
        'decisions',
        'budget_policies',
        'wakeup_requests',
        'knowledge_entries',
        'tasks_ext',
      ]
      for (const name of requiredTables) {
        expect(tables.has(name), `missing table ${name}`).toBe(true)
      }

      const e1 = store.appendEvent({ type: 'message.posted', channel: 'dev', payload: { n: 1 } })
      const e2 = store.appendEvent({ type: 'message.posted', channel: 'work/m1', payload: { n: 2 } })
      const e3 = store.appendEvent({ type: 'message.posted', channel: 'work/m2', payload: { n: 3 } })
      expect([e1.index, e2.index, e3.index]).toEqual([1, 2, 3])

      const sub = store.getEvents({ channel: 'work', subtree: true })
      expect(sub.head).toBe(3)
      expect(sub.events.map((e) => e.index)).toEqual([2, 3])
    } finally {
      store.close()
    }
  })

  it('defers .jsonl sidecar and 8-byte LE .wakeup writes until commit and discards on rollback', () => {
    const { dbPath } = makeTempDb()
    const store = new SqliteUnifiedStore({ path: dbPath })
    try {
      const seenByListener: number[] = []
      store.onEvent((ev) => seenByListener.push(ev.index))

      // Rolled back transaction must NOT write JSONL, advance wakeup, or fire listeners
      expect(() =>
        store.transaction(() => {
          store.appendEvent({ type: 'message.posted', channel: 'dev', payload: { rolledBack: true } })
          store.emitWakeup('rolled-back')
          throw new Error('force rollback')
        }),
      ).toThrow('force rollback')

      expect(store.getHeadIndex()).toBe(0)
      expect(store.getWakeupGeneration()).toBe(0)
      expect(fs.existsSync(`${dbPath}.jsonl`)).toBe(false)
      expect(fs.existsSync(`${dbPath}.wakeup`)).toBe(false)
      expect(seenByListener).toEqual([])

      // Committed nested transaction writes JSONL + 8-byte LE uint64 wakeup
      store.transaction(() => {
        store.appendEvent({ type: 'message.posted', channel: 'dev', payload: { ok: 1 } })
        store.transaction(() => {
          store.appendEvent({ type: 'message.posted', channel: 'dev', payload: { ok: 2 } })
        })
        // Inner savepoint rollback must not affect outer commit
        expect(() =>
          store.transaction(() => {
            store.appendEvent({ type: 'message.posted', channel: 'dev', payload: { innerAbort: true } })
            throw new Error('inner abort')
          }),
        ).toThrow('inner abort')
      })

      expect(store.getHeadIndex()).toBe(2)
      expect(seenByListener).toEqual([1, 2])

      const jsonlLines = fs.readFileSync(`${dbPath}.jsonl`, 'utf8').trim().split('\n')
      expect(jsonlLines).toHaveLength(2)
      expect(JSON.parse(jsonlLines[0]!).payload).toEqual({ ok: 1 })
      expect(JSON.parse(jsonlLines[1]!).payload).toEqual({ ok: 2 })

      const wakeupBuf = fs.readFileSync(`${dbPath}.wakeup`)
      expect(wakeupBuf.byteLength).toBe(8)
      expect(Number(wakeupBuf.readBigUInt64LE(0))).toBe(store.getWakeupGeneration())
      expect(store.getWakeupGeneration()).toBe(2)
    } finally {
      store.close()
    }
  })

  it('reloads wakeup generation from disk on reopen', () => {
    const { dbPath } = makeTempDb()
    const store1 = new SqliteUnifiedStore({ path: dbPath })
    store1.appendEvent({ type: 'channel.created', channel: 'dev', payload: { path: 'dev' } })
    const gen1 = store1.getWakeupGeneration()
    expect(gen1).toBe(1)
    store1.close()

    const store2 = new SqliteUnifiedStore({ path: dbPath })
    expect(store2.getWakeupGeneration()).toBe(1)
    const gen2 = store2.emitWakeup('manual')
    expect(gen2).toBe(2)
    expect(Number(fs.readFileSync(`${dbPath}.wakeup`).readBigUInt64LE(0))).toBe(2)
    store2.close()
  })

  it('keeps .wakeup generation monotonic across multiple concurrent connections and 4 worker_threads', async () => {
    const { dbPath } = makeTempDb()

    // Two concurrent connections opened before writes
    const s1 = new SqliteUnifiedStore({ path: dbPath })
    const s2 = new SqliteUnifiedStore({ path: dbPath })
    try {
      s1.appendEvent({ type: 'message.posted', channel: 'dev', payload: { n: 1 } })
      s1.appendEvent({ type: 'message.posted', channel: 'dev', payload: { n: 2 } })
      expect(fs.readFileSync(`${dbPath}.wakeup`).readBigUInt64LE(0)).toBe(2n)

      // s2 was opened when generation was 0, yet must advance from board_meta -> 3
      s2.appendEvent({ type: 'message.posted', channel: 'dev', payload: { n: 3 } })
      expect(s2.getWakeupGeneration()).toBe(3)
      expect(s1.getWakeupGeneration()).toBe(3)
      expect(fs.readFileSync(`${dbPath}.wakeup`).readBigUInt64LE(0)).toBe(3n)
    } finally {
      s1.close()
      s2.close()
    }

    // 4 worker_threads writing 25 events each against a fresh DB (100 total)
    const { dbPath: mtDbPath } = makeTempDb()
    const initStore = new SqliteUnifiedStore({ path: mtDbPath })
    initStore.close()

    const storeModuleUrl = new URL('../../src/core/sqlite-store.ts', import.meta.url).href
    const workerCode = `
      import { parentPort, workerData } from 'node:worker_threads';
      import { SqliteUnifiedStore } from ${JSON.stringify(storeModuleUrl)};
      const store = new SqliteUnifiedStore({ path: workerData.dbPath, busyTimeoutMs: 5000 });
      try {
        for (let i = 0; i < workerData.count; i++) {
          store.appendEvent({
            type: 'message.posted',
            channel: 'dev',
            payload: { worker: workerData.workerId, seq: i },
          });
        }
        parentPort.postMessage({ ok: true });
      } finally {
        store.close();
      }
    `

    await Promise.all(
      [0, 1, 2, 3].map(
        (workerId) =>
          new Promise<void>((resolve, reject) => {
            const w = new Worker(workerCode, {
              eval: true,
              workerData: { dbPath: mtDbPath, workerId, count: 25 },
            })
            w.on('message', () => resolve())
            w.on('error', reject)
            w.on('exit', (code) => {
              if (code !== 0) reject(new Error(`worker ${workerId} exited with ${code}`))
            })
          }),
      ),
    )

    const verify = new SqliteUnifiedStore({ path: mtDbPath })
    try {
      const eventCount = verify.db.prepare('SELECT COUNT(*) AS c FROM board_events').get() as { c: number }
      expect(Number(eventCount.c)).toBe(100)
      const metaRow = verify.db
        .prepare("SELECT value FROM board_meta WHERE key = 'wakeup_generation'")
        .get() as { value: string }
      expect(metaRow.value).toBe('100')
      expect(fs.readFileSync(`${mtDbPath}.wakeup`).readBigUInt64LE(0)).toBe(100n)
      const jsonlLines = fs.readFileSync(`${mtDbPath}.jsonl`, 'utf8').trim().split('\n')
      expect(jsonlLines).toHaveLength(100)
    } finally {
      verify.close()
    }
  })
})

// M1 gate iteration 2: a sidecar step that fails after COMMIT (V1 / storage F1) and a closed store (storage F2).
function statusOf(fn: () => unknown): number | string {
  try {
    fn()
  } catch (error) {
    return error instanceof BoardError ? error.status : `raw ${(error as Error).message}`
  }
  return 'no error'
}

const payloadsIn = (path: string): unknown[] =>
  fs
    .readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { payload: unknown }).payload)

describe('post-commit sidecar failures never fail or unwind a committed write (V1, storage F1)', () => {
  it('keeps a write whose .jsonl append fails, stays usable, and appends the held lines first, in order', () => {
    const { dir, dbPath } = makeTempDb()
    const jsonlPath = join(dir, 'audit.jsonl')
    fs.mkdirSync(jsonlPath) // a directory: every append fails with EISDIR
    const reported: string[] = []
    const store = new SqliteUnifiedStore({ path: dbPath, jsonlPath, onSidecarError: (_e, step) => reported.push(step) })
    const seen: number[] = []
    store.onEvent((ev) => seen.push(ev.index))
    try {
      // The append committed: it is no error, and its listeners hear of it.
      expect(store.appendEvent({ type: 'x', payload: { n: 1 } }).index).toBe(1)
      expect(store.getHeadIndex()).toBe(1)
      expect(seen).toEqual([1])
      expect(reported).toEqual(['jsonl'])
      expect(store.sidecarHealth()).toMatchObject({ failures: 1, unflushedJsonl: 1 })

      // Nested transactions still work: the depth counter came back to 0.
      store.transaction(() => {
        store.appendEvent({ type: 'x', payload: { n: 2 } })
        store.transaction(() => store.appendEvent({ type: 'x', payload: { n: 3 } }))
        expect(() =>
          store.transaction(() => {
            store.appendEvent({ type: 'x', payload: { inner: 'rolled back' } })
            throw new Error('inner')
          }),
        ).toThrow('inner')
      })
      expect(store.getHeadIndex()).toBe(3)
      expect(store.getEvents().events.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
      expect(seen).toEqual([1, 2, 3])
      expect(store.sidecarHealth().unflushedJsonl).toBe(3)

      fs.rmdirSync(jsonlPath)
      store.appendEvent({ type: 'x', payload: { n: 4 } })
      expect(payloadsIn(jsonlPath)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }])
      expect(store.sidecarHealth()).toMatchObject({ failures: 2, unflushedJsonl: 0 })
    } finally {
      store.close()
    }
  })

  it('keeps a write whose .wakeup write fails, and raises the file at the next commit, one with no events too', () => {
    const { dir, dbPath } = makeTempDb()
    const wakeupPath = join(dir, 'wake')
    fs.mkdirSync(wakeupPath) // a directory: the 8-byte write fails with EISDIR
    const store = new SqliteUnifiedStore({ path: dbPath, wakeupPath })
    try {
      store.appendEvent({ type: 'x', payload: {} })
      store.appendEvent({ type: 'x', payload: {} })
      expect(store.getWakeupGeneration()).toBe(2)
      expect(store.sidecarHealth()).toMatchObject({ failures: 2, unwrittenWakeup: 2, last: { step: 'wakeup' } })

      fs.rmdirSync(wakeupPath)
      store.transaction(() => undefined)
      expect(fs.readFileSync(wakeupPath).readBigUInt64LE(0)).toBe(2n)
      expect(store.sidecarHealth().unwrittenWakeup).toBe(0)
    } finally {
      store.close()
    }
  })

  it('commits nothing once SQLite ended the transaction or a savepoint could not roll back, even if the body goes on', () => {
    const { dbPath } = makeTempDb()
    const store = new SqliteUnifiedStore({ path: dbPath })
    const seen: number[] = []
    store.onEvent((ev) => seen.push(ev.index))
    try {
      // A savepoint whose rollback fails (here: the body released it itself) poisons the outer commit.
      const poisoned = statusOf(() =>
        store.transaction(() => {
          store.appendEvent({ type: 'x', payload: { outer: 1 } })
          try {
            store.transaction(() => {
              store.appendEvent({ type: 'x', payload: { inner: 1 } })
              store.db.exec('RELEASE SAVEPOINT sp_1')
              throw new Error('inner failed')
            })
          } catch {
            // a body that swallows the failure and goes on
          }
          store.appendEvent({ type: 'x', payload: { outer: 2 } })
        }),
      )
      expect(poisoned).toBe(503)
      expect(store.getHeadIndex()).toBe(0)

      // SQLite ending the transaction itself (as on SQLITE_FULL) is no commit either, nested or not.
      const ended = statusOf(() =>
        store.transaction(() => {
          store.appendEvent({ type: 'x', payload: { lost: 1 } })
          store.db.exec('ROLLBACK')
          try {
            store.transaction(() => store.appendEvent({ type: 'x', payload: { lost: 2 } }))
          } catch {
            // refused: it would have opened and committed a transaction of its own
          }
        }),
      )
      expect(ended).toBe(503)
      expect(store.getHeadIndex()).toBe(0)
      expect(seen).toEqual([])
      expect(fs.existsSync(`${dbPath}.jsonl`)).toBe(false)
      // And the store goes on as normal.
      expect(store.appendEvent({ type: 'x', payload: {} }).index).toBe(1)
    } finally {
      store.close()
    }
  })

  it('fails nothing when the error hook itself throws', () => {
    const { dir, dbPath } = makeTempDb()
    const jsonlPath = join(dir, 'audit.jsonl')
    fs.mkdirSync(jsonlPath)
    const store = new SqliteUnifiedStore({
      path: dbPath,
      jsonlPath,
      onSidecarError: () => {
        throw new Error('hook broke')
      },
    })
    try {
      expect(() => store.appendEvent({ type: 'x', payload: {} })).not.toThrow()
      expect(store.appendEvent({ type: 'x', payload: {} }).index).toBe(2)
    } finally {
      store.close()
    }
  })

  it('stays usable after BEGIN IMMEDIATE is refused busy, and that refusal is a 503 (V2)', () => {
    const { dbPath } = makeTempDb()
    const a = new SqliteUnifiedStore({ path: dbPath, busyTimeoutMs: 20 })
    const b = new SqliteUnifiedStore({ path: dbPath, busyTimeoutMs: 20 })
    try {
      b.db.exec('BEGIN IMMEDIATE')
      let refused: unknown
      try {
        a.appendEvent({ type: 'x', payload: {} })
      } catch (error) {
        refused = error
      }
      const { status, payload, retryAfter } = toErrorPayload(refused)
      expect([status, payload.error.code, retryAfter]).toEqual([503, 'unavailable', 1])
      b.db.exec('ROLLBACK')
      expect(a.appendEvent({ type: 'x', payload: {} }).index).toBe(1)
    } finally {
      a.close()
      b.close()
    }
  })
})

describe('a closed store answers 503 unavailable for every use, a read too (storage F2)', () => {
  it('refuses the store and the board alike with a typed 503', async () => {
    const { dbPath } = makeTempDb()
    const store = new SqliteUnifiedStore({ path: dbPath })
    const board = new BoardService(store)
    const owner = createLocalCaller({ userId: 'owner', handle: 'owner', owner: true })
    board.postMessage(owner, { channel: 'dev', text: 'before close' })
    store.close()
    expect(statusOf(() => store.db)).toBe(503)
    expect(statusOf(() => store.getHeadIndex())).toBe(503)
    expect(statusOf(() => store.getEvents())).toBe(503)
    expect(statusOf(() => store.ftsSearch({ query: 'close' }))).toBe(503)
    expect(statusOf(() => store.appendEvent({ type: 'x', payload: {} }))).toBe(503)
    expect(statusOf(() => board.postMessage(owner, { channel: 'dev', text: 'x' }))).toBe(503)
    expect(statusOf(() => board.listThreads(owner, {}))).toBe(503)
    expect(statusOf(() => board.search(owner, { query: 'close' }))).toBe(503)
    await expect(board.getEvents(owner, {})).rejects.toMatchObject({ status: 503, code: 'unavailable' })
    expect(store.getWakeupGeneration()).toBeGreaterThan(0)
  })
})

// ============================================================================
// M1 gate iteration 3.

const wakeupOf = (path: string): number => Number(fs.readFileSync(path).readBigUInt64LE(0))

describe('the .wakeup file rises at every commit, even under a database newer than it (S1)', () => {
  it('raises a kept .wakeup file past its own generation when the database was recreated', () => {
    const { dbPath } = makeTempDb()
    const first = new SqliteUnifiedStore({ path: dbPath })
    for (let i = 0; i < 5; i++) first.appendEvent({ type: 'x', payload: { i } })
    first.close()
    const kept = wakeupOf(`${dbPath}.wakeup`)
    expect(kept).toBe(5)
    for (const suffix of ['', '-wal', '-shm', '.jsonl']) fs.rmSync(`${dbPath}${suffix}`, { force: true })

    const fresh = new SqliteUnifiedStore({ path: dbPath })
    try {
      let last = kept
      for (let i = 0; i < 3; i++) {
        fresh.appendEvent({ type: 'y', payload: { i } })
        const now = wakeupOf(`${dbPath}.wakeup`)
        expect(now).toBeGreaterThan(last)
        last = now
      }
      expect(fresh.getWakeupGeneration()).toBe(last)
    } finally {
      fresh.close()
    }
  })
})

describe('a dead writer’s .wakeup.lock is broken at once, not after five seconds (S5)', () => {
  it('breaks a lock that names a process that is gone, and one left empty', () => {
    const { dbPath } = makeTempDb()
    const store = new SqliteUnifiedStore({ path: dbPath })
    const lockPath = `${dbPath}.wakeup.lock`
    try {
      // A pid no process has: the kernel's limit is far below it.
      fs.writeFileSync(lockPath, '2147483646')
      let started = Date.now()
      store.appendEvent({ type: 'x', payload: {} })
      expect(Date.now() - started).toBeLessThan(1000)
      expect(fs.existsSync(lockPath)).toBe(false)
      expect(wakeupOf(`${dbPath}.wakeup`)).toBe(1)

      fs.writeFileSync(lockPath, '')
      started = Date.now()
      store.appendEvent({ type: 'x', payload: {} })
      expect(Date.now() - started).toBeLessThan(1500)
      expect(wakeupOf(`${dbPath}.wakeup`)).toBe(2)
      expect(store.sidecarHealth().failures).toBe(0)
    } finally {
      store.close()
    }
  })
})

describe('a waiting events poll sees a commit another connection made (S2)', () => {
  it('answers as soon as another store on the same database commits, not when the wait runs out', async () => {
    const { dbPath } = makeTempDb()
    const reader = new SqliteUnifiedStore({ path: dbPath })
    const writer = new SqliteUnifiedStore({ path: dbPath })
    const owner = createLocalCaller({ userId: 'owner', handle: 'owner', owner: true })
    const readBoard = new BoardService(reader)
    const writeBoard = new BoardService(writer)
    try {
      writeBoard.postMessage(owner, { channel: 'dev', text: 'before' })
      const head = String(reader.getHeadIndex())
      const started = Date.now()
      const waiting = readBoard.getEvents(owner, { after: head, wait: 5 })
      setTimeout(() => writeBoard.postMessage(owner, { channel: 'dev', text: 'from elsewhere' }), 100)
      const page = await waiting
      expect(Date.now() - started).toBeLessThan(2000)
      expect(page.events.map((e) => e.message?.text)).toContain('from elsewhere')
    } finally {
      reader.close()
      writer.close()
    }
  })
})

describe('a search that fails for the store, not its query, is no 400 (S3)', () => {
  it('answers a damaged FTS index as a 500, and a bad query still as 400 invalid_fts_query', () => {
    const { dbPath } = makeTempDb()
    const store = new SqliteUnifiedStore({ path: dbPath })
    const board = new BoardService(store)
    const owner = createLocalCaller({ userId: 'owner', handle: 'owner', owner: true })
    try {
      board.postMessage(owner, { channel: 'dev', text: 'hello world' })
      expect(toErrorPayload(caughtAny(() => board.search(owner, { query: '"unterminated' }))).payload.error.code).toBe(
        'invalid_fts_query',
      )
      const raw = new DatabaseSync(dbPath, { defensive: false } as ConstructorParameters<typeof DatabaseSync>[1])
      raw.exec('DELETE FROM fts_messages_data WHERE id > 10')
      raw.close()
      const { status, payload } = toErrorPayload(caughtAny(() => board.search(owner, { query: 'hello' })))
      expect([status, payload.error.code]).toEqual([500, 'internal'])
    } finally {
      store.close()
    }
  })
})

function caughtAny(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

// ============================================================================
// M1 gate iteration 4.

describe("another thread's .wakeup.lock is waited for, though it names this process (storage F1)", () => {
  it('waits for a lock a worker thread of this process holds, and leaves it to that thread to remove', async () => {
    const { dbPath } = makeTempDb()
    const store = new SqliteUnifiedStore({ path: dbPath })
    const lockPath = `${dbPath}.wakeup.lock`
    const storeModuleUrl = new URL('../../src/core/sqlite-store.ts', import.meta.url).href
    const worker = new Worker(
      `
        import * as fs from 'node:fs';
        import { parentPort, workerData } from 'node:worker_threads';
        import { wakeupLockToken, releaseWakeupLock } from ${JSON.stringify(storeModuleUrl)};
        const token = wakeupLockToken();
        fs.writeFileSync(workerData.lockPath, token, { flag: 'wx' });
        parentPort.postMessage({ held: true });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        parentPort.postMessage({ released: releaseWakeupLock(workerData.lockPath, token) });
      `,
      { eval: true, workerData: { lockPath } },
    )
    try {
      const messages: Record<string, unknown>[] = []
      const released = new Promise<boolean>((resolve, reject) => {
        worker.on('message', (m: Record<string, unknown>) => {
          messages.push(m)
          if ('released' in m) resolve(m.released as boolean)
        })
        worker.on('error', reject)
      })
      await vi.waitFor(() => expect(messages).toContainEqual({ held: true }))
      expect(staleWakeupLock(lockPath)).toBe(false)
      const started = Date.now()
      store.appendEvent({ type: 'x', payload: {} })
      expect(Date.now() - started).toBeGreaterThanOrEqual(250)
      expect(await released).toBe(true)
      expect(wakeupOf(`${dbPath}.wakeup`)).toBe(1)
    } finally {
      await worker.terminate()
      store.close()
    }
  })

  it("breaks this thread's own lock and a bare pid of this process, and removes only its own", () => {
    const { dir } = makeTempDb()
    const lockPath = join(dir, 'x.lock')
    fs.writeFileSync(lockPath, `${process.pid}:0:abcd`)
    expect(staleWakeupLock(lockPath)).toBe(true)
    fs.writeFileSync(lockPath, String(process.pid))
    expect(staleWakeupLock(lockPath)).toBe(true)
    fs.writeFileSync(lockPath, `${process.pid}:4242:abcd`)
    expect(staleWakeupLock(lockPath)).toBe(false)
    expect(releaseWakeupLock(lockPath, `${process.pid}:4242:ffff`)).toBe(false)
    expect(fs.existsSync(lockPath)).toBe(true)
    expect(releaseWakeupLock(lockPath, `${process.pid}:4242:abcd`)).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
  })
})

describe('a transaction refuses a body that returns a promise (storage F3)', () => {
  it('throws, and rolls back what the body wrote before it returned', async () => {
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    try {
      let later: Promise<void> | undefined
      expect(() =>
        store.transaction(() => {
          store.appendEvent({ type: 'before-await', payload: {} })
          later = Promise.reject(new Error('the body failed after its await'))
          return later
        }),
      ).toThrow(TypeError)
      expect(store.getHeadIndex()).toBe(0)
      // Its own later failure is handled, so it is no unhandled rejection.
      await expect(later).rejects.toThrow('after its await')
      expect(store.appendEvent({ type: 'next', payload: {} }).index).toBe(1)
    } finally {
      store.close()
    }
  })
})

describe('a write judged before a revoke another connection committed is not written after it (storage F2)', () => {
  it('answers a retryable 503 and writes nothing, and the write sent again is refused', () => {
    const { dbPath } = makeTempDb()
    const ownerStore = new SqliteUnifiedStore({ path: dbPath })
    const bobStore = new SqliteUnifiedStore({ path: dbPath })
    const owner = createLocalCaller({ userId: 'owner', handle: 'owner', owner: true })
    const bob = createLocalCaller({ userId: 'bob', handle: 'bob' })
    try {
      const ownerBoard = new BoardService(ownerStore, { seedDefaultGrants: false })
      const bobBoard = new BoardService(bobStore, { seedDefaultGrants: false })
      const bobs = ownerBoard.createGrant(owner, { principals: [{ kind: 'user', userId: 'bob' }], can: { dev: 'all' } }).id
      bobBoard.postMessage(bob, { channel: 'dev', text: 'while granted' })

      // The revoke commits after bob's post was judged and before its transaction takes the write lock.
      const transaction = bobStore.transaction.bind(bobStore)
      let raced = false
      vi.spyOn(bobStore, 'transaction').mockImplementation(<T>(fn: () => T): T => {
        if (!raced) {
          raced = true
          ownerBoard.revokeGrant(owner, bobs)
        }
        return transaction(fn)
      })
      let refused: unknown
      try {
        bobBoard.postMessage(bob, { channel: 'dev', text: 'after the revoke' })
      } catch (error) {
        refused = error
      }
      const { status, payload, retryAfter } = toErrorPayload(refused)
      expect([status, payload.error.code, retryAfter]).toEqual([503, 'unavailable', 1])
      const posted = ownerStore.db
        .prepare("SELECT payload_json FROM board_events WHERE type = 'message.posted'")
        .all() as { payload_json: string }[]
      expect(posted.map((r) => (JSON.parse(r.payload_json) as { text: string }).text)).toEqual(['while granted'])
      expect(toErrorPayload(caughtAny(() => bobBoard.postMessage(bob, { channel: 'dev', text: 'again' }))).status).toBe(403)
    } finally {
      vi.restoreAllMocks()
      ownerStore.close()
      bobStore.close()
    }
  })
})
