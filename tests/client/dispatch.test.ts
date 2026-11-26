// Targeted dispatcher regressions (HOST123_DESIGN 5.4, 5.5, 7.5):
// - eventsFeed on an idle-restored owned board runs watch.check() before capturing startEpoch
// - cursorIndex only treats decimal log-index strings as cursors (untyped numeric `after` reaches core for 400)
import { mkdtempSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, SqliteUnifiedStore, type EventsPage } from '../../src/core/public.ts'
import { isBoardError, type BoardErrorLike } from '../../src/client/errors.ts'
import { localIdentity } from '../../src/client/identity.ts'
import { InProcessTransport } from '../../src/client/transport-inproc.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

function ownedFileBoard() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hs-dispatch-')))
  const dbPath = join(dir, 'board.db')
  const store = new SqliteUnifiedStore({ path: dbPath })
  const board = new BoardService(store)
  const identity = localIdentity({
    userId: 'ada',
    handle: 'ada',
    name: 'Ada',
    member: true,
    owner: true,
    profiles: ['w1'],
    defaultProfile: 'w1',
  })
  const transport = new InProcessTransport({
    board,
    identity,
    owned: { store, close: () => store.close() },
  })
  cleanups.push(async () => {
    await transport.close()
    try {
      store.close()
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, dbPath, store, board, identity, transport }
}

async function expectBoardError(p: Promise<unknown>): Promise<BoardErrorLike> {
  try {
    await p
  } catch (error) {
    expect(isBoardError(error), String(error)).toBe(true)
    return error as BoardErrorLike
  }
  expect.unreachable('expected a rejection')
}

describe('dispatch eventsFeed idle-restore semantics (§7.5)', () => {
  it('starting a brand-new events() after an idle restore (no prior call()) succeeds and refreshes instanceId', async () => {
    const { dbPath, identity, transport } = ownedFileBoard()
    const oldInstanceId = transport.capabilities.instanceId!
    expect(oldInstanceId).toBeTypeOf('string')

    // Rotate instanceId + post on another connection while transport is completely idle (no prior call()).
    const other = new SqliteUnifiedStore({ path: dbPath })
    const otherBoard = new BoardService(other)
    let newInstanceId: string
    try {
      newInstanceId = other.rotateInstanceId().instanceId
      otherBoard.postMessage(identity.callerFor(undefined), { channel: 'dev', text: 'after-idle-restore' })
    } finally {
      other.close()
    }
    expect(newInstanceId).not.toBe(oldInstanceId)

    // 1. Brand-new feed with `last: 1` (no after, no expectInstance) succeeds without spurious 410.
    const pagesLast: EventsPage[] = []
    for await (const page of transport.events({ channel: 'dev', last: 1 })) {
      pagesLast.push(page)
      break
    }
    expect(pagesLast).toHaveLength(1)
    expect(pagesLast[0]!.events.some((e) => e.message?.text === 'after-idle-restore')).toBe(true)
    expect(transport.capabilities.instanceId).toBe(newInstanceId)

    // 2. Rotate again while idle and start a live feed without `last` (enters `for (;;)` directly).
    const other2 = new SqliteUnifiedStore({ path: dbPath })
    let thirdInstanceId: string
    try {
      thirdInstanceId = other2.rotateInstanceId().instanceId
    } finally {
      other2.close()
    }
    expect(thirdInstanceId).not.toBe(newInstanceId)

    const ac = new AbortController()
    const livePages: EventsPage[] = []
    const reader = (async () => {
      for await (const page of transport.events({ channel: 'dev' }, { signal: ac.signal })) {
        livePages.push(page)
        break
      }
    })()
    await new Promise((r) => setTimeout(r, 30))
    await transport.call('post', { channel: 'dev', text: 'live-after-restore' })
    await reader
    expect(livePages).toHaveLength(1)
    expect(livePages[0]!.events.some((e) => e.message?.text === 'live-after-restore')).toBe(true)
    expect(transport.capabilities.instanceId).toBe(thirdInstanceId)
  })

  it('idle restore with stale expectInstance still rejects 410 instance_changed; idle replacement rejects sticky 503 replaced', async () => {
    const { dbPath, transport } = ownedFileBoard()
    const oldInstanceId = transport.capabilities.instanceId!

    const other = new SqliteUnifiedStore({ path: dbPath })
    try {
      other.rotateInstanceId()
    } finally {
      other.close()
    }

    const staleIter = transport.events({}, { expectInstance: oldInstanceId })[Symbol.asyncIterator]()
    const err410 = await expectBoardError(staleIter.next())
    expect(err410).toMatchObject({
      status: 410,
      code: 'cursor_expired',
      details: { reason: 'instance_changed' },
    })

    // Unlink file while idle -> brand-new events() rejects with sticky 503 replaced.
    const replaced = ownedFileBoard()
    unlinkSync(replaced.dbPath)
    const replacedIter = replaced.transport.events({})[Symbol.asyncIterator]()
    const err503 = await expectBoardError(replacedIter.next())
    expect(err503).toMatchObject({
      status: 503,
      code: 'unavailable',
      details: { reason: 'replaced', path: replaced.dbPath },
    })
    expect(err503.retryAfter).toBeUndefined()
  })
})

describe('dispatch cursorIndex type safety (§5.4 step 10)', () => {
  it('untyped numeric `after` (0 or 999999) reaches the core and rejects 400 invalid_request; string above head still gives 410 log_rewound', async () => {
    const { transport } = ownedFileBoard()

    const numZero = await expectBoardError(transport.call('events', { after: 0 } as never))
    expect(numZero).toMatchObject({ status: 400, code: 'invalid_request' })

    const numHigh = await expectBoardError(transport.call('events', { after: 999999 } as never))
    expect(numHigh).toMatchObject({ status: 400, code: 'invalid_request' })

    const strHigh = await expectBoardError(transport.call('events', { after: '999999' }))
    expect(strHigh).toMatchObject({
      status: 410,
      code: 'cursor_expired',
      details: { reason: 'log_rewound' },
    })
  })
})
