// HOST-0 stage 3, the clock sweep (HOST0_DESIGN 3.11, decision D1): every clock read inside BoardService goes
// through the injected clock (HT-96 to HT-99).
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  LEASE_MS,
  SqliteUnifiedStore,
} from '../../../src/core/index.ts'

const TF = Date.UTC(2031, 0, 1)
const alice = createLocalCaller({ userId: 'alice', handle: 'alice', member: true })
const owner = createLocalCaller({ userId: 'owner', handle: 'owner', owner: true })

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function make(clock: { now: number }): { store: SqliteUnifiedStore; board: BoardService } {
  const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-clock-'))
  dirs.push(dir)
  const store = new SqliteUnifiedStore({ path: join(dir, 'board.db') })
  stores.push(store)
  return { store, board: new BoardService(store, { now: () => clock.now }) }
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

const matchTimes = (s: SqliteUnifiedStore): number[] =>
  (s.db.prepare('SELECT created_at FROM board_watcher_matches').all() as Array<{ created_at: number }>).map((r) =>
    Number(r.created_at),
  )

describe('the injected clock reaches every BoardService stamp', () => {
  it('HT-96 watcher matches are stamped by the injected clock', () => {
    const { store, board } = make({ now: TF })
    board.registerWatchers(alice, { url: null, watch: { w: { tail: 'dev' } }, sync: [] })
    board.postMessage(alice, { channel: 'dev', text: 'x' })
    const times = matchTimes(store)
    expect(times.length).toBeGreaterThan(0)
    expect(times.every((t) => t === TF)).toBe(true)
  })

  it('HT-97 a sync match for a new thread target is stamped by the injected clock', () => {
    const { store, board } = make({ now: TF })
    board.registerWatchers(owner, { url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'x' })
    board.attachSyncTarget(owner, message.id, { target: 'slack:C1' })
    const rows = store.db.prepare("SELECT created_at, event_json FROM board_watcher_matches").all() as Array<{
      created_at: number
      event_json: string
    }>
    const synced = rows.filter((r) => (JSON.parse(r.event_json) as { type: string }).type === 'thread.synced')
    expect(synced.length).toBe(1)
    expect(Number(synced[0]!.created_at)).toBe(TF)
    expect(matchTimes(store).every((t) => t === TF)).toBe(true)
  })

  it('HT-98 events, upload tickets and queue leases run on the injected clock', () => {
    const clock = { now: TF }
    const { store, board } = make(clock)
    const iso = new Date(TF).toISOString()
    board.createChannel(owner, { path: 'work' })
    const { message } = board.postMessage(alice, { channel: 'dev', text: 'x' })
    board.reactMessage(alice, message.id, { emoji: '+1' })
    board.labelMessage(alice, message.id, { set: { state: 'open' } })
    const g = board.createGrant(owner, { principals: [{ kind: 'user', userId: 'bob' }], can: { read: 'all' } })
    board.revokeGrant(owner, g.id)
    const s = board.createSchedule(alice, { channel: 'dev', text: 's', in: '1m' })
    board.cancelSchedule(alice, s.id)
    board.createSchedule(alice, { channel: 'dev', text: 'dropped', in: '1m' })
    const types = ['channel.created', 'reaction.added', 'labels.changed', 'grant.created', 'grant.deleted', 'actor.seen', 'schedule.canceled']
    for (const type of types) {
      const rows = store.db.prepare('SELECT created_at FROM board_events WHERE type = ?').all(type) as Array<{ created_at: string }>
      expect(rows.length, type).toBeGreaterThan(0)
      expect(
        rows.every((r) => r.created_at === iso),
        type,
      ).toBe(true)
    }

    const ticket = board.startDirectUpload(alice, { name: 'a.bin', type: 'application/octet-stream', size: 4 })
    expect(ticket.expiresAt).toBe(new Date(TF + 1_800_000).toISOString())
    clock.now = TF + 1_800_000
    let thrown: unknown
    try {
      board.finishDirectUpload(alice, ticket.id, Buffer.from([1, 2, 3, 4]))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(BoardError)
    expect((thrown as BoardError).status).toBe(404)
    expect((thrown as BoardError).code).toBe('upload_not_found')

    clock.now = TF
    board.registerWatchers(alice, { url: null, watch: { w: { tail: 'dev' } }, sync: [] })
    board.postMessage(alice, { channel: 'dev', text: 'y' })
    expect(board.pullWatcherMatches(alice, { limit: 10 }).length).toBeGreaterThan(0)
    const again = (): number => board.pullWatcherMatches(alice, { limit: 10 }).length
    const first = store.db.prepare('SELECT COUNT(*) AS n FROM board_watcher_matches').get() as { n: number }
    expect(first.n).toBe(1)
    clock.now = TF + LEASE_MS - 1
    expect(again()).toBe(0)
    clock.now = TF + LEASE_MS
    expect(again()).toBe(1)
  })

  it('HT-99 the wall clock is read in exactly the places the design lists', () => {
    const root = fileURLToPathSrc()
    const counts: Record<string, number> = {}
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          const n = (fs.readFileSync(full, 'utf8').match(/Date\.now\(\)|new Date\(\)/g) ?? []).length
          if (n > 0) counts[full.slice(root.length + 1)] = n
        }
      }
    }
    walk(root)
    expect(counts).toEqual({ 'board-service.ts': 1, 'tasks/claim-ready.ts': 2, 'sqlite-store.ts': 7 })
  })
})

function fileURLToPathSrc(): string {
  return join(import.meta.dirname, '..', '..', '..', 'src', 'core')
}
