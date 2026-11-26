// HS-186 + FileHost lifecycle unit tests (HOST123_DESIGN 3, 6.6, 7.3, 7.4).
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Internal from '../../src/core/internal.ts'
import { isSystemCaller, readTickLease } from '../../src/core/internal.ts'
import { BoardService, type SqliteUnifiedStore } from '../../src/core/public.ts'
import { isBoardError } from '../../src/client/errors.ts'
import { createFileHost } from '../../src/host/file-host.ts'
import type { TickReport } from '../../src/host/tick.ts'

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []
const attachments: Array<{ close(): Promise<void> }> = []

function freshDb(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hs-file-host-')))
  dirs.push(dir)
  return join(dir, 'b', 'board.db')
}

afterEach(async () => {
  while (attachments.length > 0) {
    await attachments.pop()!.close()
  }
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

/** Deeply walks own keys, getters, arrays, Maps, and Sets and asserts no value satisfies isSystemCaller. */
function assertNoSystemCaller(root: unknown, label: string): void {
  const seen = new Set<unknown>()
  const walk = (v: unknown, path: string): void => {
    if (v === null || v === undefined || (typeof v !== 'object' && typeof v !== 'function')) return
    if (seen.has(v)) return
    seen.add(v)
    expect(isSystemCaller(v), `${label}: found SystemCaller at ${path}`).toBe(false)
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`)
      return
    }
    if (v instanceof Map) {
      for (const [k, val] of v.entries()) {
        walk(k, `${path}.MapKey`)
        walk(val, `${path}.MapVal`)
      }
      return
    }
    if (v instanceof Set) {
      for (const val of v.values()) walk(val, `${path}.SetVal`)
      return
    }
    for (const key of Reflect.ownKeys(v)) {
      const desc = Object.getOwnPropertyDescriptor(v, key)
      if (!desc) continue
      const keyName = typeof key === 'symbol' ? key.toString() : key
      if ('value' in desc) {
        walk(desc.value, `${path}.${keyName}`)
      } else if (typeof desc.get === 'function') {
        try {
          walk(desc.get.call(v), `${path}.${keyName}`)
        } catch {
          // getter threw on prototype or closed state
        }
      }
    }
  }
  walk(root, label)
}

describe('FileHost lifecycle and HS-186 confinement', () => {
  it('open() asserts exact path match, attach() builds bridge without starting, bindBoard() starts bridge + ticker, close() releases lease before stopping bridge and never closes store', async () => {
    const db = freshDb()
    const reports: TickReport[] = []
    let resolveRan!: () => void
    const firstRan = new Promise<void>((r) => {
      resolveRan = r
    })

    const host = createFileHost({
      target: { kind: 'file', db, dir: dirname(db), defaultDir: false },
      allowUnsafeFs: false,
      wake: { watch: true, safetyPollMs: 500 },
      tick: 'lease',
      ticker: {
        intervalMs: 50,
        ttlMs: 1_000,
        onReport: (r) => {
          reports.push(r)
          if (r.outcome === 'ran') resolveRan()
        },
      },
    })

    // Wrong path refused with BoardErrorLike 400 invalid_db_path
    try {
      host.open(join(dirname(db), 'other.db'))
      expect.unreachable('expected path assertion failure')
    } catch (e) {
      expect(isBoardError(e)).toBe(true)
      if (isBoardError(e)) {
        expect(e.status).toBe(400)
        expect(e.code).toBe('invalid_db_path')
      }
    }

    const { store, warnings } = host.open(db)
    stores.push(store)
    expect(Array.isArray(warnings)).toBe(true)

    const att = host.attach(store)
    attachments.push(att)
    expect(att.safetyPollMs).toBe(500)
    expect(att.ticking).toBe(false)
    expect(store.sidecarHealth().external.armed).toBe(false)

    const svcOpts = att.serviceOptions()
    expect(Object.isFrozen(svcOpts)).toBe(true)
    expect(svcOpts.eventsWaitPollMs).toBe(500)
    expect(svcOpts.tasks?.armedSafetyPollMs).toBe(500)

    const board = new BoardService(store, svcOpts)
    att.bindBoard(board)

    expect(att.ticking).toBe(true)
    expect(att.wake).toBe('fs-watch')
    expect(store.sidecarHealth().external.armed).toBe(true)

    // Calling bindBoard twice throws TypeError
    expect(() => att.bindBoard(board)).toThrow(TypeError)

    await firstRan
    const heldLease = readTickLease(store)
    expect(heldLease).not.toBeNull()
    expect(heldLease!.until).toBeGreaterThan(0)

    // close() releases tick lease (until === 0) while store is still open, disarms bridge, NEVER closes store
    await att.close()
    expect(att.ticking).toBe(false)
    expect(store.sidecarHealth().external.armed).toBe(false)
    expect(() => store.getHeadIndex()).not.toThrow()
    const releasedLease = readTickLease(store)
    expect(releasedLease).toMatchObject({ holder: heldLease!.holder, fence: heldLease!.fence, until: 0 })

    // Idempotent close
    await expect(att.close()).resolves.toBeUndefined()
  })

  it('tick: owner-only and tick: off do not start a Ticker', async () => {
    for (const tickMode of ['owner-only', 'off'] as const) {
      const db = freshDb()
      const host = createFileHost({
        target: { kind: 'file', db, dir: dirname(db), defaultDir: false },
        allowUnsafeFs: false,
        wake: { watch: true, safetyPollMs: 500 },
        tick: tickMode,
      })
      const { store } = host.open(db)
      stores.push(store)
      const att = host.attach(store)
      attachments.push(att)
      const board = new BoardService(store, att.serviceOptions())
      att.bindBoard(board)
      expect(att.ticking).toBe(false)
      expect(att.status()['tick']).toBeNull()
      await att.close()
    }
  })

  it('HS-186 attachment, status(), and TickReports hold no SystemCaller; file-host.ts and connect.ts export no internal.ts value', async () => {
    const db = freshDb()
    const reports: TickReport[] = []
    let resolveRan!: () => void
    const firstRan = new Promise<void>((r) => {
      resolveRan = r
    })

    const host = createFileHost({
      target: { kind: 'file', db, dir: dirname(db), defaultDir: false },
      allowUnsafeFs: false,
      wake: { watch: true, safetyPollMs: 500 },
      tick: 'lease',
      ticker: {
        intervalMs: 50,
        ttlMs: 1_000,
        onReport: (r) => {
          reports.push(r)
          if (r.outcome === 'ran') resolveRan()
        },
      },
    })
    const { store } = host.open(db)
    stores.push(store)
    const att = host.attach(store)
    attachments.push(att)
    const board = new BoardService(store, att.serviceOptions())
    att.bindBoard(board)
    await firstRan

    assertNoSystemCaller(att, 'FileHostAttachment')
    assertNoSystemCaller(att.status(), 'FileHostAttachment.status()')
    expect(reports.length).toBeGreaterThanOrEqual(1)
    for (let i = 0; i < reports.length; i++) {
      assertNoSystemCaller(reports[i], `TickReport[${i}]`)
    }

    const internalValues = new Set<unknown>(
      Object.values(Internal).filter((v) => v !== null && (typeof v === 'function' || typeof v === 'object')),
    )
    const fileHostMod = await import('../../src/host/file-host.ts')
    const connectMod = await import('../../src/host/connect.ts')
    for (const [modName, mod] of [
      ['src/host/file-host.ts', fileHostMod],
      ['src/host/connect.ts', connectMod],
    ] as const) {
      for (const [k, v] of Object.entries(mod)) {
        expect(internalValues.has(v), `${modName} exports internal value ${k}`).toBe(false)
      }
    }

    await att.close()
  })
})
