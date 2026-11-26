// HS-182, HS-183, HS-184, HS-188: multi-process contention, fault-injection crash/replay stress (16 peers × 3 boards),
// 32-peer tight-loop lag stress, and HS-01..HS-194 acceptance ID coverage check.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { IdentitySpec } from '../../../src/client/conformance.ts'
import { keyedId } from '../../../src/client/idempotency.ts'
import { localIdentity } from '../../../src/client/identity.ts'
import { SharedFileTransport } from '../../../src/client/transport-file.ts'
import { realHostFor, spawnPeerChild, type PeerChildHandle } from '../host-stub.ts'
import { call, sleep } from '../suite/util.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const dirs: string[] = []
const transports: SharedFileTransport[] = []
const peers: PeerChildHandle[] = []

function freshDir(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), tag)))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(peers.splice(0).map((p) => p.close().catch(() => {})))
  while (transports.length > 0) {
    await transports.pop()!.close().catch(() => {})
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('Mode 1 multi-process stress and HS-188 acceptance ID gate (HS-182..HS-184, HS-188)', () => {
  it(
    'HS-182 two peers race claimTask × 20 (1 claim, 1 409 each round); 8 peers claimReadyTask over 40 tasks (40 distinct)',
    async () => {
      const dir = freshDir('hs182-')
      const db = join(dir, 'board.db')
      const ids: Record<string, IdentitySpec> = {
        ada: { userId: 'ada', member: true },
        ...Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [`w${i}`, { userId: 'ada', profile: `w${i}`, member: true }]),
        ),
      }

      const parent = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
        host: realHostFor(db),
      })
      transports.push(parent)
      await parent.ready()

      // (a) 2 peers race claimTask on same task 20 times
      const pA = await spawnPeerChild({ db, ids, defaultAs: 'w0', host: 'real' })
      const pB = await spawnPeerChild({ db, ids, defaultAs: 'w1', host: 'real' })
      peers.push(pA, pB)
      await Promise.all([pA.ready('w0'), pB.ready('w1')])

      for (let round = 0; round < 20; round++) {
        const created = (await call(parent, 'createTask', { channel: 'work', text: `race-${round}` })) as {
          task: { id: string }
        }
        const [rA, rB] = await Promise.allSettled([
          pA.call('claimTask', { id: created.task.id }),
          pB.call('claimTask', { id: created.task.id }),
        ])
        const wins = [rA, rB].filter((r) => r.status === 'fulfilled')
        const losses = [rA, rB].filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        expect(wins).toHaveLength(1)
        expect(losses).toHaveLength(1)
        expect(losses[0]!.reason).toMatchObject({ status: 409, code: 'task_claimed' })
      }
      await Promise.all([pA.close(), pB.close()])

      // (b) 8 peers claimReadyTask over 40 tasks -> 40 distinct claims, no duplicates
      const expectedIds = new Set<string>()
      for (let i = 0; i < 40; i++) {
        const created = (await call(parent, 'createTask', { channel: 'work', text: `pool-${i}` })) as {
          task: { id: string }
        }
        expectedIds.add(String(created.task.id))
      }

      const workers = await Promise.all(
        Array.from({ length: 8 }, (_, i) => spawnPeerChild({ db, ids, defaultAs: `w${i}`, host: 'real' })),
      )
      peers.push(...workers)
      await Promise.all(workers.map((w, i) => w.ready(`w${i}`)))

      const results = await Promise.all(workers.map((w, i) => w.claimLoop('work', `w${i}`)))
      const allClaimed = results.flatMap((r) => r.claimed)
      expect(allClaimed).toHaveLength(40)
      expect(new Set(allClaimed)).toEqual(expectedIds)
    },
    120_000,
  )

  it(
    'HS-183 16 peers × 3 fresh boards × 30 keyed posts (1,440 keys total), 4 peers SIGKILLed (incl. crash-after-commit) + restarted & resent, 1 waiter/board via events()',
    async () => {
      const root = freshDir('hs183-')
      const dbs = [0, 1, 2].map((b) => join(root, `b${b}`, 'board.db'))
      const PEER_COUNT = 16
      const PER_BOARD = 30
      const ids: Record<string, IdentitySpec> = {
        waiter: { userId: 'waiter', member: true },
        ...Object.fromEntries(
          Array.from({ length: PEER_COUNT }, (_, i) => [`p${i}`, { userId: `p${i}`, member: true }]),
        ),
      }

      // Start one waiter per board from the very beginning (after: '0')
      const waiters = await Promise.all(
        dbs.map((db) => spawnPeerChild({ db, ids, defaultAs: 'waiter', host: 'real' })),
      )
      peers.push(...waiters)
      await Promise.all(waiters.map((w) => w.startFeed('dev', '0', 'waiter')))

      // Spawn 16 peers concurrently; pick 4 distinct random peers to kill (2 crash-after-commit, 2 mid-stream SIGKILL)
      const order = Array.from({ length: PEER_COUNT }, (_, i) => i).sort(() => Math.random() - 0.5)
      const crashAfterSet = new Set(order.slice(0, 2))
      const crashKillSet = new Set(order.slice(2, 4))

      const itemsForPeer = (pIdx: number) =>
        dbs.map((_, bIdx) =>
          Array.from({ length: PER_BOARD }, (__, i) => ({
            key: `p${pIdx}-b${bIdx}-${i}`,
            text: `msg p${pIdx} b${bIdx} #${i}`,
          })),
        )

      const initialPeers: PeerChildHandle[] = []
      for (let i = 0; i < PEER_COUNT; i += 4) {
        const wave = await Promise.all(
          Array.from({ length: Math.min(4, PEER_COUNT - i) }, (_, j) =>
            spawnPeerChild({ db: dbs[0]!, ids, defaultAs: `p${i + j}`, host: 'real' }),
          ),
        )
        initialPeers.push(...wave)
      }
      peers.push(...initialPeers)

      const runs = await Promise.allSettled(
        initialPeers.map((peer, pIdx) => {
          const itemsByBoard = itemsForPeer(pIdx)
          if (crashAfterSet.has(pIdx)) {
            return peer.multiKeyedPosts(dbs, 'dev', itemsByBoard, {
              as: `p${pIdx}`,
              crashAfter: { board: pIdx % 3, index: 5 + (pIdx % 15) },
            })
          }
          if (crashKillSet.has(pIdx)) {
            return peer.multiKeyedPosts(dbs, 'dev', itemsByBoard, {
              as: `p${pIdx}`,
              crashKill: { board: pIdx % 3, index: 5 + (pIdx % 15) },
            })
          }
          return peer.multiKeyedPosts(dbs, 'dev', itemsByBoard, { as: `p${pIdx}` })
        }),
      )

      const killedIndices = [...crashAfterSet, ...crashKillSet]
      for (const pIdx of killedIndices) {
        expect(runs[pIdx]!.status).toBe('rejected')
      }
      for (let pIdx = 0; pIdx < PEER_COUNT; pIdx++) {
        if (!crashAfterSet.has(pIdx) && !crashKillSet.has(pIdx)) {
          expect(runs[pIdx]!.status).toBe('fulfilled')
        }
      }

      // Restart the 4 killed peers and resend ALL their keys across all 3 boards
      const restarted = await Promise.all(
        killedIndices.map((pIdx) => spawnPeerChild({ db: dbs[0]!, ids, defaultAs: `p${pIdx}`, host: 'real' })),
      )
      peers.push(...restarted)
      await Promise.all(
        restarted.map((peer, idx) => {
          const pIdx = killedIndices[idx]!
          return peer.multiKeyedPosts(dbs, 'dev', itemsForPeer(pIdx), { as: `p${pIdx}` })
        }),
      )

      await Promise.all([...initialPeers, ...restarted].map((p) => p.close().catch(() => {})))

      // Give waiters a moment to receive final tail commits over fs.watch
      await sleep(300)
      const feedResults = await Promise.all(waiters.map((w) => w.stopFeed()))
      await Promise.all(waiters.map((w) => w.close()))

      let totalKeysVerified = 0
      for (let bIdx = 0; bIdx < dbs.length; bIdx++) {
        const db = dbs[bIdx]!
        const raw = new DatabaseSync(db, { readOnly: true })
        try {
          const integrity = (raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
          expect(integrity).toBe('ok')

          const logRows = raw.prepare('SELECT log_index FROM board_events ORDER BY log_index ASC').all() as {
            log_index: number
          }[]
          const headIdx = logRows.length
          expect(headIdx).toBeGreaterThanOrEqual(PEER_COUNT * PER_BOARD)
          for (let i = 0; i < logRows.length; i++) {
            expect(logRows[i]!.log_index).toBe(i + 1)
          }

          const countStmt = raw.prepare('SELECT COUNT(*) AS n FROM board_events WHERE event_id = ?')
          for (let pIdx = 0; pIdx < PEER_COUNT; pIdx++) {
            for (let i = 0; i < PER_BOARD; i++) {
              const eid = keyedId(`local:user:p${pIdx}`, null, 'post', `p${pIdx}-b${bIdx}-${i}`)
              const row = countStmt.get(eid) as { n: number }
              expect(row.n, `board ${bIdx} key ${eid}`).toBe(1)
              totalKeysVerified += 1
            }
          }

          const feed = feedResults[bIdx]!
          expect(feed.dupes).toBe(0)
          expect(feed.lastCursor).toBe(String(headIdx))
          expect(feed.seen).toHaveLength(PEER_COUNT * PER_BOARD)
          expect(new Set(feed.seen).size).toBe(PEER_COUNT * PER_BOARD)
        } finally {
          raw.close()
        }
      }
      expect(totalKeysVerified).toBe(PEER_COUNT * PER_BOARD * dbs.length)
      expect(totalKeysVerified).toBe(1_440)
    },
    180_000,
  )

  it(
    'HS-184 32 peers × 40 unkeyed posts in tight loops through SharedFileTransport (default policy): 1,280 land, 0 errors, max lag < 1,000ms',
    async () => {
      const dir = freshDir('hs184-')
      const db = join(dir, 'board.db')
      const N = 32
      const M = 40
      const ids: Record<string, IdentitySpec> = Object.fromEntries(
        Array.from({ length: N }, (_, i) => [`u${i}`, { userId: `u${i}`, member: true }]),
      )

      const workers: PeerChildHandle[] = []
      for (let i = 0; i < N; i += 4) {
        const wave = await Promise.all(
          Array.from({ length: Math.min(4, N - i) }, (_, j) =>
            spawnPeerChild({ db, ids, defaultAs: `u${i + j}`, host: 'real' }),
          ),
        )
        workers.push(...wave)
      }
      peers.push(...workers)
      await Promise.all(workers.map((w, i) => w.ready(`u${i}`)))

      const results = await Promise.all(workers.map((w, i) => w.tightPost('dev', M, `u${i}`, `u${i}`)))
      await Promise.all(workers.map((w) => w.close()))

      expect(results).toHaveLength(N)
      for (const r of results) {
        expect(r.posted).toBe(M)
        expect(r.maxLagMs).toBeLessThan(1_000)
      }

      const raw = new DatabaseSync(db, { readOnly: true })
      try {
        const row = raw
          .prepare("SELECT COUNT(*) AS n FROM board_events WHERE type = 'message.posted'")
          .get() as { n: number }
        expect(row.n).toBe(N * M)
        const integrity = (raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
        expect(integrity).toBe('ok')
      } finally {
        raw.close()
      }
    },
    180_000,
  )

  it('HS-188 every acceptance test ID HS-01..HS-194 is covered across tests/', () => {
    const found = new Set<number>()
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.isFile() && /\.(?:ts|mts|cts|js|mjs|json)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8')
          for (const m of text.matchAll(/\bHS-(\d{2,3})\b/g)) {
            found.add(Number(m[1]))
          }
        }
      }
    }
    walk(join(ROOT, 'tests'))

    const missing: string[] = []
    for (let i = 1; i <= 194; i++) {
      if (!found.has(i)) {
        missing.push(`HS-${String(i).padStart(2, '0')}`)
      }
    }
    expect(missing).toEqual([])
  })
})
