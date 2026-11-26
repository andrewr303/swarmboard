// HOST-0 closeout (HOST0_GATE_REPORT carry-over): the service-side items. F1 (slice A org events on the injected
// clock), S3V-2 (the sync events' createdAt stamps), F3 / S3V-3 (the tick lease's in-lock re-check and
// never-early comparison, deterministically), F4 (`shouldContinue` stops on anything but `true`) and SEC-R1-2
// (the reserved sets cannot be changed at run time).
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardService,
  checkCallerActor,
  createLocalCaller,
  SqliteUnifiedStore,
  type CallerContext,
  type SqliteStoreOptions,
} from '../../../src/core/index.ts'
import { META_READABLE_LEGACY, RESERVED_META_KEYS } from '../../../src/core/meta-keys.ts'
import { RESERVED_SYSTEM_IDS } from '../../../src/core/system.ts'
import { acquireTickLease, readTickLease, type AcquireResult } from '../../../src/core/tick-lease.ts'

/** Far enough ahead that no wall-clock stamp can equal it. */
const TF = Date.UTC(2099, 0, 1)
const ISO = new Date(TF).toISOString()
const T = Date.UTC(2026, 10, 24, 12, 0, 0)
const T0 = Date.parse('2026-11-22T12:00:00.000Z')
const alice = createLocalCaller({ userId: 'alice', handle: 'alice', member: true })
const owner = createLocalCaller({ userId: 'owner', handle: 'owner', owner: true })

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function tempPath(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-closeout-b-'))
  dirs.push(dir)
  return join(dir, 'board.db')
}
function open(path: string, extra: Partial<SqliteStoreOptions> = {}): SqliteUnifiedStore {
  const s = new SqliteUnifiedStore({ path, ...extra })
  stores.push(s)
  return s
}
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close()
    } catch {
      // Closed already.
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const stampsOf = (s: SqliteUnifiedStore, type: string): string[] =>
  (s.db.prepare('SELECT created_at FROM board_events WHERE type = ? ORDER BY log_index').all(type) as Array<{ created_at: string }>).map(
    (r) => r.created_at,
  )

describe('HOST-0 closeout: the injected clock', () => {
  it('closeout F1 slice A org events appended by a task hook are stamped by the injected clock', () => {
    const store = open(tempPath())
    const board = new BoardService(store, { now: () => TF })
    const seen: string[] = []
    board.tasks.use({
      name: 'org-probe',
      applied: (result, tx) => {
        seen.push(tx.appendOrgEvent('org.probe', { op: result.op }, 'dev').createdAt)
      },
    })
    board.tasks.createTask(alice, { channel: 'dev', text: 'stamp me' })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((at) => at === ISO)).toBe(true)
    const rows = store.db.prepare("SELECT session_id, created_at FROM board_events WHERE type = 'org.probe'").all() as Array<{
      session_id: string
      created_at: string
    }>
    expect(rows.length).toBe(seen.length)
    expect(rows.every((r) => r.session_id === 'org' && r.created_at === ISO)).toBe(true)
  })

  it('closeout S3V-2 every sync event (message.synced, sync_failed, files_synced, both thread.synced) is stamped by the injected clock', () => {
    const store = open(tempPath())
    const board = new BoardService(store, { now: () => TF })
    board.registerWatchers(owner, { url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    // thread.synced (1): a root posted with a sync target.
    const { message } = board.postMessage(owner, { channel: 'dev', text: 'root', sync: ['slack:C1'] })
    // thread.synced (2): a target attached later.
    expect(board.attachSyncTarget(owner, message.id, { target: 'slack:C2:1.1' }).attached).toBe(true)
    board.syncReceipt(owner, { kind: 'message', message: message.id, target: 'slack:C1', external: { thread: 'slack:C1:1.0', message: '1.0' } })
    board.syncReceipt(owner, { kind: 'failed', message: message.id, target: 'slack:C2:1.1', error: 'rate limited' })
    board.syncReceipt(owner, { kind: 'files', message: message.id, target: 'slack:C1', files: ['F1'] })
    const threadSynced = stampsOf(store, 'thread.synced')
    expect(threadSynced).toEqual([ISO, ISO])
    expect(stampsOf(store, 'message.synced')).toEqual([ISO])
    expect(stampsOf(store, 'message.sync_failed')).toEqual([ISO])
    expect(stampsOf(store, 'message.files_synced')).toEqual([ISO])
    // The two thread.synced events come from the two code paths (the post, then the attach).
    const targets = (store.db.prepare("SELECT payload_json FROM board_events WHERE type = 'thread.synced' ORDER BY log_index").all() as Array<{
      payload_json: string
    }>).map((r) => (JSON.parse(r.payload_json) as { target: string }).target)
    expect(targets).toEqual(['slack:C1', 'slack:C2:1.1'])
  })
})

describe('HOST-0 closeout: the tick lease under the lock (F3, S3V-3)', () => {
  /** Two connections on one file; `arm(fn)` runs `fn` once, just before A's next BEGIN IMMEDIATE (after its unlocked pre-read). */
  function twoHolders(): { a: SqliteUnifiedStore; b: SqliteUnifiedStore; arm(fn: () => void): void; fired(): boolean } {
    const path = tempPath()
    let armed: (() => void) | null = null
    let fired = false
    const b = open(path)
    const a = open(path, {
      testHooks: {
        onBeginImmediate: () => {
          const fn = armed
          armed = null
          if (fn) {
            fired = true
            fn()
          }
        },
      },
    })
    return { a, b, arm: (fn) => (armed = fn), fired: () => fired }
  }
  const acquired = (r: AcquireResult): Extract<AcquireResult, { acquired: true }> => {
    expect(r.acquired).toBe(true)
    return r as Extract<AcquireResult, { acquired: true }>
  }

  it('closeout F3 a holder that takes the lease between the unlocked pre-read and the lock wins; the first fails to acquire', () => {
    const { a, b, arm, fired } = twoHolders()
    expect(readTickLease(a)).toBeNull()
    arm(() => {
      acquired(acquireTickLease(b, { holder: 'h2', ttlMs: 30_000, now: () => T }))
    })
    const r = acquireTickLease(a, { holder: 'h1', ttlMs: 30_000, now: () => T })
    expect(fired()).toBe(true)
    expect(r).toEqual({ acquired: false, holder: 'h2', fence: 1, until: T + 30_000 })
    expect(readTickLease(a)).toEqual({ v: 1, holder: 'h2', fence: 1, until: T + 30_000, at: T })
  })

  it('closeout S3V-3 the in-lock comparison alone decides at until - 1 (live) and at until (taken over)', () => {
    const until = T + 30_000
    for (const [t, takes] of [
      [until - 1, false],
      [until, true],
    ] as const) {
      const { a, b, arm, fired } = twoHolders()
      const clock = { now: T - 1 }
      // A's pre-read finds no lease; then h2 takes it and the clock advances to t before A's locked read.
      arm(() => {
        acquired(acquireTickLease(b, { holder: 'h2', ttlMs: 30_000, now: () => T }))
        clock.now = t
      })
      const r = acquireTickLease(a, { holder: 'h1', ttlMs: 30_000, now: () => clock.now })
      expect(fired(), String(t)).toBe(true)
      if (takes) {
        const won = acquired(r)
        expect(won.takeover).toBe(true)
        expect(won.lease).toEqual({ key: 'host.tick.lease', holder: 'h1', fence: 2, until: t + 30_000 })
        expect(readTickLease(a)).toMatchObject({ holder: 'h1', fence: 2, at: t })
      } else {
        expect(r).toEqual({ acquired: false, holder: 'h2', fence: 1, until })
        expect(readTickLease(a)).toMatchObject({ holder: 'h2', fence: 1, until })
      }
    }
  })
})

describe('HOST-0 closeout: shouldContinue (F4)', () => {
  it('closeout F4 a truthy shouldContinue answer that is not true stops the run', () => {
    for (const answer of [1, 'yes', {}, [true]] as unknown[]) {
      const store = open(tempPath())
      const board = new BoardService(store)
      for (const t of ['a', 'b']) board.createSchedule(alice, { channel: 'dev', text: t, in: '1m' }, T0)
      let calls = 0
      const run = board.runDueSchedules(T0 + 60_000, {
        shouldContinue: () => {
          calls += 1
          return answer as boolean
        },
      })
      expect(run.sent, String(answer)).toEqual([])
      expect(run.stopped, String(answer)).toBe(true)
      expect(calls).toBe(1)
    }
    // Control: true goes on.
    const store = open(tempPath())
    const board = new BoardService(store)
    for (const t of ['a', 'b']) board.createSchedule(alice, { channel: 'dev', text: t, in: '1m' }, T0)
    const run = board.runDueSchedules(T0 + 60_000, { shouldContinue: () => true })
    expect(run.sent).toHaveLength(2)
    expect(run.stopped).toBe(false)
  })
})

describe('HOST-0 closeout: the reserved sets are immutable (SEC-R1-2)', () => {
  const tryAll = (set: ReadonlySet<string>, value: string, existing: string): void => {
    const mutable = set as unknown as Set<string>
    expect(() => mutable.add(value)).toThrow(TypeError)
    expect(() => mutable.delete(existing)).toThrow(TypeError)
    expect(() => mutable.clear()).toThrow(TypeError)
    expect(() => Set.prototype.add.call(set, value)).toThrow(TypeError)
    expect(() => Set.prototype.delete.call(set, existing)).toThrow(TypeError)
    expect(() => Set.prototype.clear.call(set)).toThrow(TypeError)
    expect(() => Object.defineProperty(set, 'has', { value: () => false })).toThrow(TypeError)
    expect(() => {
      ;(set as { has: unknown }).has = () => false
    }).toThrow(TypeError)
    expect(Object.isFrozen(set)).toBe(true)
    expect(set.has(existing)).toBe(true)
    expect(set.has(value)).toBe(false)
  }

  it('closeout SEC-R1-2 RESERVED_SYSTEM_IDS, RESERVED_META_KEYS and META_READABLE_LEGACY refuse every change, and the refusals still hold', () => {
    const before = {
      system: [...RESERVED_SYSTEM_IDS],
      meta: [...RESERVED_META_KEYS],
      legacy: [...META_READABLE_LEGACY],
    }
    tryAll(RESERVED_SYSTEM_IDS, 'local:user:x', 'board:system')
    tryAll(RESERVED_META_KEYS, 'host.x', 'core.board_id')
    tryAll(META_READABLE_LEGACY, 'schemas_seeded', 'tasks_schema')
    expect({ system: [...RESERVED_SYSTEM_IDS], meta: [...RESERVED_META_KEYS], legacy: [...META_READABLE_LEGACY] }).toEqual(before)
    expect(before.system.sort()).toEqual(['board:schedule', 'board:system'])
    expect(RESERVED_SYSTEM_IDS.size).toBe(2)
    const viaForEach: string[] = []
    RESERVED_META_KEYS.forEach((v, k, s) => {
      expect(k).toBe(v)
      expect(s).toBe(RESERVED_META_KEYS)
      viaForEach.push(v)
    })
    expect(viaForEach).toEqual(before.meta)
    expect([...RESERVED_META_KEYS.entries()].every(([k, v]) => k === v)).toBe(true)
    expect([...RESERVED_META_KEYS.keys()]).toEqual([...RESERVED_META_KEYS.values()])

    // The refusals the sets drive still hold.
    const forged: CallerContext = {
      principal: { id: 'board:deployment', kind: 'deployment', handle: 'board' },
      actor: { id: 'board:system', kind: 'deployment', handle: 'system', name: 'system', avatar: null },
      profile: null,
    }
    expect(() => checkCallerActor(forged)).toThrow(/board's own/)
    const store = open(tempPath())
    const board = new BoardService(store)
    expect(() => board.postMessage(forged, { channel: 'dev', text: 'x' })).toThrow(/board's own/)
    expect(store.getMeta('tasks_schema')).toBe('1')
    expect(() => store.getMeta('wakeup_generation')).not.toThrow()
    expect(() => store.getMeta('schemas_seeded')).toThrow(TypeError)
    expect(() => store.casMeta('tasks_schema', '1', '2')).toThrow(TypeError)
    expect(store.getMeta('tasks_schema')).toBe('1')
  })
})
