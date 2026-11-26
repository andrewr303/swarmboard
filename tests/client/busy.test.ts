// HOST123_DESIGN Stage B6 (HS-101, HS-102, HS-106, HS-107, HS-109, HS-110): busy classification,
// closed-store error pinning, replacedError, setBusyTimeout, grants-race retry, remaining-wait retry,
// and twin-board regression parity.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  normalizeError,
  SCHEMA_VERSION,
  SqliteUnifiedStore,
  toErrorPayload,
} from '../../src/core/public.ts'
import {
  isRetryableBusy,
  isStoreClosedError,
  LONG_LIVED_BUSY_TIMEOUT_MS,
  replacedError,
  setBusyTimeout,
  withBusyRetry,
} from '../../src/client/busy.ts'
import { clientError } from '../../src/client/errors.ts'
import { replacedError as normalizeReplacedError } from '../../src/client/normalize.ts'
import { idSequence, manualClock, openTestBoard, placeholders } from '../conformance/fixtures.ts'
import { makeLegacyFile } from '../core/host0/legacy.ts'

const owner = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function tempDir(prefix = 'cb-busy-'): string {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function track<T extends SqliteUnifiedStore>(store: T): T {
  stores.push(store)
  return store
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const s of stores.splice(0)) {
    try {
      s.close()
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('busy classification and closed-store pinning (HS-101, HS-102)', () => {
  it('HS-101 isRetryableBusy classifies every retryable busy form as true and every non-retryable failure as false', () => {
    expect(LONG_LIVED_BUSY_TIMEOUT_MS).toBe(50)

    // TRUE: raw node:sqlite busy/locked errors (primary & extended), errstr match, grants-race 503, normalized busy.
    const raw5 = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
    const raw6 = Object.assign(new Error('database table is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 6 })
    const raw261 = Object.assign(new Error('SQLITE_BUSY_RECOVERY'), { code: 'ERR_SQLITE_ERROR', errcode: 261 })
    const raw517 = Object.assign(new Error('SQLITE_BUSY_SNAPSHOT'), { code: 'ERR_SQLITE_ERROR', errcode: 517 })
    const rawErrstr = Object.assign(new Error('locked'), { code: 'ERR_SQLITE_ERROR', errstr: 'database is locked' })
    const grantsRace = new BoardError(
      503,
      'unavailable',
      'the grants changed while this write waited for the database: send it again',
      { retryAfter: 1 },
    )
    const normalizedBusy = normalizeError(raw5)

    for (const err of [raw5, raw6, raw261, raw517, rawErrstr, grantsRace, normalizedBusy]) {
      expect(isRetryableBusy(err), String(err)).toBe(true)
    }

    // FALSE: real closed store error.
    const closedStore = track(new SqliteUnifiedStore({ path: ':memory:' }))
    closedStore.close()
    let closedErr: unknown
    try {
      closedStore.getHeadIndex()
    } catch (e) {
      closedErr = e
    }
    expect(isRetryableBusy(closedErr)).toBe(false)

    // FALSE: "storage ended the transaction before it could commit".
    const endedTxErr = new BoardError(503, 'unavailable', 'storage ended the transaction before it could commit')
    expect(isRetryableBusy(endedTxErr)).toBe(false)

    // FALSE: real store replaced refusal via testHooks.statFile AND replacedError(path).
    const repDir = tempDir('cb-busy-rep-')
    const repPath = join(repDir, 'board.db')
    let fakeIno = 100n
    const repStore = track(
      new SqliteUnifiedStore({
        path: repPath,
        testHooks: { statFile: () => ({ dev: 1n, ino: fakeIno }) },
      }),
    )
    const repBoard = new BoardService(repStore)
    fakeIno = 200n
    let storeReplacedErr: unknown
    try {
      repBoard.createChannel(owner, { path: 'dev' })
    } catch (e) {
      storeReplacedErr = e
    }
    expect(storeReplacedErr).toBeInstanceOf(BoardError)
    expect((storeReplacedErr as BoardError).status).toBe(503)
    expect(isRetryableBusy(storeReplacedErr)).toBe(false)
    expect(isRetryableBusy(replacedError(repPath))).toBe(false)

    // FALSE: real newer tasks_schema refusal (legacy sliceA file with tasks_schema = 99).
    const tasksDir = tempDir('cb-busy-tasks-')
    const tasksPath = join(tasksDir, 'board.db')
    makeLegacyFile(tasksPath, 'sliceA')
    const rawTasksDb = new DatabaseSync(tasksPath)
    rawTasksDb.exec("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('tasks_schema', '99')")
    rawTasksDb.close()
    const tasksStore = track(new SqliteUnifiedStore({ path: tasksPath }))
    const tasksRefusal = tasksStore.writeRefusal()
    expect(tasksRefusal).not.toBeNull()
    expect(tasksRefusal!.status).toBe(503)
    expect(isRetryableBusy(tasksRefusal)).toBe(false)

    // FALSE: real schema_too_new refusal (raised write floor).
    const floorDir = tempDir('cb-busy-floor-')
    const floorPath = join(floorDir, 'board.db')
    const initFloor = new SqliteUnifiedStore({ path: floorPath })
    initFloor.close()
    const rawFloorDb = new DatabaseSync(floorPath)
    rawFloorDb.exec(
      `INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.schema_write_min', '${SCHEMA_VERSION + 1}')`,
    )
    rawFloorDb.close()
    const floorStore = track(new SqliteUnifiedStore({ path: floorPath }))
    const floorRefusal = floorStore.writeRefusal()
    expect(floorRefusal).not.toBeNull()
    expect(floorRefusal!.code).toBe('schema_too_new')
    expect(isRetryableBusy(floorRefusal)).toBe(false)

    // FALSE: backpressure_shed (503 with retryAfter 1 but code !== 'unavailable'), other statuses, raw JS errors, undefined.
    const nonRetryable: unknown[] = [
      clientError('backpressure_shed', 'too many queued writes', { retryAfter: 1 }),
      clientError('unavailable', 'this transport is closed'),
      new BoardError(500, 'internal', 'internal error'),
      new BoardError(409, 'duplicate_id', 'duplicate'),
      new BoardError(404, 'not_found', 'missing'),
      new BoardError(410, 'cursor_expired', 'rewound'),
      new TypeError('bad type'),
      undefined,
      null,
    ]
    for (const err of nonRetryable) {
      expect(isRetryableBusy(err), String(err)).toBe(false)
    }
  })

  it('HS-102 pins isStoreClosedError against a real closed store and distinguishes every other 503', () => {
    const store = track(new SqliteUnifiedStore({ path: ':memory:' }))
    store.close()
    let closedErr: unknown
    try {
      store.getHeadIndex()
    } catch (e) {
      closedErr = e
    }
    expect(isStoreClosedError(closedErr)).toBe(true)

    // Replaced refusal from real store and from replacedError(path) must be false.
    const repDir = tempDir('cb-closed-rep-')
    const repPath = join(repDir, 'board.db')
    let fakeIno = 1n
    const repStore = track(
      new SqliteUnifiedStore({
        path: repPath,
        testHooks: { statFile: () => ({ dev: 1n, ino: fakeIno }) },
      }),
    )
    const repBoard = new BoardService(repStore)
    fakeIno = 2n
    let storeReplacedErr: unknown
    try {
      repBoard.createChannel(owner, { path: 'dev' })
    } catch (e) {
      storeReplacedErr = e
    }

    const rep = replacedError(repPath)
    expect(rep).toBeInstanceOf(BoardError)
    expect(rep.status).toBe(503)
    expect(rep.code).toBe('unavailable')
    expect(rep.origin).toBe('board')
    expect(rep.retryAfter).toBeUndefined()
    expect(rep.message).toContain(repPath)
    expect(rep.hint).toBeTruthy()
    expect(rep.details).toEqual({ reason: 'replaced', path: repPath })
    expect(rep.message).toBe(normalizeReplacedError(repPath).message)

    const notClosed: unknown[] = [
      storeReplacedErr,
      rep,
      new BoardError(503, 'unavailable', 'storage is busy: try again', { retryAfter: 1 }),
      Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }),
      new BoardError(503, 'schema_too_new', 'newer schema'),
      new BoardError(503, 'unavailable', 'storage ended the transaction before it could commit'),
      new BoardError(503, 'unavailable', 'this board was written by a newer Swarmboard (tasks_schema 99)'),
      clientError('backpressure_shed', 'shed', { retryAfter: 1 }),
      clientError('unavailable', 'this transport is closed'),
      new BoardError(500, 'internal', 'internal error'),
      new BoardError(404, 'not_found', 'missing'),
      new TypeError('boom'),
      undefined,
    ]
    for (const err of notClosed) {
      expect(isStoreClosedError(err), String(err)).toBe(false)
    }
  })
})

describe('setBusyTimeout (HS-107)', () => {
  it('HS-107 sets PRAGMA busy_timeout per connection, validates 0..60_000 with RangeError, and throws 503 when closed', () => {
    const dir = tempDir('cb-busy-to-')
    const db = join(dir, 'board.db')
    const storeA = track(new SqliteUnifiedStore({ path: db }))
    const storeB = track(new SqliteUnifiedStore({ path: db }))

    const readTimeout = (s: SqliteUnifiedStore): number =>
      Number((s.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number; busy_timeout?: number }).timeout)

    const defaultB = readTimeout(storeB)
    expect(defaultB).toBe(5000)

    setBusyTimeout(storeA, 25)
    expect(readTimeout(storeA)).toBe(25)
    expect(readTimeout(storeB)).toBe(defaultB)

    // Boundaries 0, 50, 60_000 succeed.
    setBusyTimeout(storeA, 0)
    expect(readTimeout(storeA)).toBe(0)
    setBusyTimeout(storeA, LONG_LIVED_BUSY_TIMEOUT_MS)
    expect(readTimeout(storeA)).toBe(50)
    setBusyTimeout(storeA, 60_000)
    expect(readTimeout(storeA)).toBe(60_000)

    // Invalid values throw RangeError and leave PRAGMA untouched.
    for (const bad of [-1, 60_001, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '25' as unknown as number]) {
      expect(() => setBusyTimeout(storeA, bad), `ms=${String(bad)}`).toThrow(RangeError)
    }
    expect(readTimeout(storeA)).toBe(60_000)

    // Closed store throws 503 (store closed error).
    storeA.close()
    let closedErr: unknown
    try {
      setBusyTimeout(storeA, 50)
    } catch (e) {
      closedErr = e
    }
    expect(closedErr).toBeInstanceOf(BoardError)
    expect((closedErr as BoardError).status).toBe(503)
    expect(isStoreClosedError(closedErr)).toBe(true)
    // Invalid ms on a closed store still fails fast with RangeError.
    expect(() => setBusyTimeout(storeA, -1)).toThrow(RangeError)
  })
})

describe('grants race, async wait remaining time, and regression parity (HS-106, HS-109, HS-110)', () => {
  it('HS-106 grants race: attempt 1 fails 503 retryAfter 1, attempt 2 is re-judged and rejects 403 forbidden with 0 posts written', async () => {
    const dir = tempDir('cb-grants-race-')
    const db = join(dir, 'board.db')

    const storeB = track(new SqliteUnifiedStore({ path: db }))
    const boardB = new BoardService(storeB)
    boardB.createChannel(owner, { path: 'dev' })

    // Give a non-member caller an explicit grant for dev so revoking it removes their only post grant.
    const writer = createLocalCaller({ userId: 'carol', handle: 'carol', member: false })
    const createdGrant = boardB.createGrant(owner, {
      principals: [{ kind: 'user', userId: 'carol' }],
      can: { dev: ['read', 'post'] },
    })

    let hookFired = false
    const storeA = track(
      new SqliteUnifiedStore({
        path: db,
        testHooks: {
          onBeginImmediate: () => {
            if (hookFired) return
            hookFired = true
            // Revoke carol's only post grant from connection B right before A takes BEGIN IMMEDIATE.
            boardB.revokeGrant(owner, createdGrant.id)
          },
        },
      }),
    )
    const boardA = new BoardService(storeA)

    let attempts = 0
    const retryErrors: unknown[] = []
    let caught: unknown
    try {
      await withBusyRetry(
        () => {
          attempts += 1
          return boardA.postMessage(writer, { channel: 'dev', text: 'must-not-land' })
        },
        {
          onRetry: ({ error }) => retryErrors.push(error),
          sleep: async () => {},
        },
      )
    } catch (e) {
      caught = e
    }

    expect(hookFired).toBe(true)
    expect(attempts).toBe(2)
    expect(retryErrors).toHaveLength(1)
    expect(retryErrors[0]).toBeInstanceOf(BoardError)
    expect((retryErrors[0] as BoardError).status).toBe(503)
    expect((retryErrors[0] as BoardError).retryAfter).toBe(1)

    expect(caught).toBeInstanceOf(BoardError)
    expect((caught as BoardError).status).toBe(403)
    expect((caught as BoardError).code).toBe('forbidden')

    const msgs = boardB.listChannelMessages(owner, { channel: 'dev' }).messages
    expect(msgs).toHaveLength(0)
  })

  it('HS-109 claimReady recomputes remaining wait from elapsedMs and resolves {task: null} by fake time 5.2 s', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(1_700_000_000_000)

    const store = track(new SqliteUnifiedStore({ path: ':memory:' }))
    const board = new BoardService(store)
    board.createChannel(owner, { path: 'work' })

    const origClaimReady = board.tasks.claimReady.bind(board.tasks)
    const receivedWaits: number[] = []
    let calls = 0

    vi.spyOn(board.tasks, 'claimReady').mockImplementation(async (caller, body, signal) => {
      calls += 1
      const waitVal = (body as { wait?: number }).wait ?? 0
      receivedWaits.push(waitVal)
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 2_000))
        throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
      }
      return origClaimReady(caller, body, signal)
    })

    const startFake = Date.now()
    let settledAt = 0
    const resultP = withBusyRetry(
      ({ elapsedMs }) =>
        board.tasks.claimReady(owner, { channel: 'work', wait: Math.max(0, 5 - elapsedMs / 1000) }),
      {
        now: () => Date.now(),
        random: () => 0.5,
      },
    ).then((res) => {
      settledAt = Date.now() - startFake
      return res
    })

    await vi.advanceTimersByTimeAsync(5_500)
    const result = await resultP

    expect(calls).toBe(2)
    expect(receivedWaits[0]).toBe(5)
    expect(receivedWaits[1]).toBeLessThanOrEqual(3)
    expect(receivedWaits[1]).toBeGreaterThan(2.5)
    expect(result).toEqual({ task: null })
    expect(settledAt).toBeLessThanOrEqual(5_200)
  })

  it('HS-110 wrapping changes nothing on 10 successful calls (twin board parity) or on non-retryable failures', async () => {
    const clockA = manualClock()
    const clockB = manualClock()
    const twinA = openTestBoard(':memory:', { now: clockA.now, newId: idSequence('twin') })
    const twinB = openTestBoard(':memory:', { now: clockB.now, newId: idSequence('twin') })
    track(twinA.store)
    track(twinB.store)

    const token = 'A'.repeat(43)
    const msgId = new Map<BoardService, string>()
    const ops: Array<{ name: string; run: (b: BoardService) => unknown | Promise<unknown> }> = [
      { name: 'me', run: (b) => b.me(owner) },
      { name: 'createChannel', run: (b) => b.createChannel(owner, { path: 'dev' }) },
      { name: 'listChannels', run: (b) => b.listChannels(owner, {}) },
      {
        name: 'postMessage',
        run: (b) => {
          const res = b.postMessage(owner, { channel: 'dev', text: 'first post', id: 'm-1' })
          msgId.set(b, res.message.id)
          return res
        },
      },
      { name: 'editMessage', run: (b) => b.editMessage(owner, msgId.get(b)!, { text: 'edited post' }) },
      { name: 'reactMessage', run: (b) => b.reactMessage(owner, msgId.get(b)!, { emoji: 'rocket' }) },
      { name: 'labelMessage', run: (b) => b.labelMessage(owner, msgId.get(b)!, { set: { kind: 'note' } }) },
      { name: 'listChannelMessages', run: (b) => b.listChannelMessages(owner, { channel: 'dev' }) },
      {
        name: 'createTask',
        run: (b) => b.tasks.createTask(owner, { channel: 'dev', text: 'do work', id: 't-1', claim: true, token }),
      },
      { name: 'getEvents', run: (b) => b.getEvents(owner, { after: '0' }) },
    ]
    expect(ops).toHaveLength(10)

    for (const op of ops) {
      clockA.advance(1000)
      clockB.advance(1000)
      const unwrapped = await op.run(twinA.board)
      const wrapped = await withBusyRetry(() => op.run(twinB.board))
      expect(placeholders(wrapped), op.name).toEqual(placeholders(unwrapped))
    }

    // Non-retryable error is rejected with the exact identical object, so toErrorPayload is unchanged.
    const notFoundErr = new BoardError(404, 'message_not_found', 'no message 999', { details: { id: 999 } })
    let caught: unknown
    try {
      await withBusyRetry(() => {
        throw notFoundErr
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(notFoundErr)
    expect(toErrorPayload(caught)).toEqual(toErrorPayload(notFoundErr))

    // Real non-retryable core error (404) passes through unchanged.
    let directErr: unknown
    try {
      twinA.board.getMessageThread(owner, 999_999)
    } catch (e) {
      directErr = e
    }
    let wrappedErr: unknown
    try {
      await withBusyRetry(() => twinB.board.getMessageThread(owner, 999_999))
    } catch (e) {
      wrappedErr = e
    }
    expect(wrappedErr).toBeInstanceOf(BoardError)
    expect(toErrorPayload(wrappedErr)).toEqual(toErrorPayload(directErr))
  })
})
