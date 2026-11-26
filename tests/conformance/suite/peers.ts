// Conformance cases requiring cross-process peers, busy retry, lanes, identity events, or crash injection:
// CF-16 (lanes), CF-17 (busy policy), CF-18 (identity events), CF-19 (crash replay).
// Skipped automatically for targets whose features are off (e.g. `in-process`); all 4 run on `shared-file` and
// `shared-file-degraded`.
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect } from 'vitest'
import { BoardService, SCHEMA_VERSION, SqliteUnifiedStore } from '../../../src/core/public.ts'
import { keyedId } from '../../../src/client/idempotency.ts'
import type { Suite } from '../contract.ts'
import { IDS, tempDir } from '../fixtures.ts'
import { call, events, head, messageOf, post, readAll, rejection, sleep } from './util.ts'

export const PEER_SUITE: Suite = {
  'CF-16': [
    {
      name: "HS-163 CF-16 one identity's writes keep issue order behind a peer hold; reads/waits never queue; laneMax sheds",
      timeoutMs: 60_000,
      async run(ctx) {
        const { dir, board } = await ctx.openWithDir(IDS)
        const { transport } = board
        const peer = await ctx.target.spawnPeer!(dir, IDS, 'bob')
        try {
          // 1. Issue order preserved while backing off behind a peer hold
          const start = await head(transport)
          await peer.hold(400)
          const p1 = post(transport, 'dev', 'order-1')
          const p2 = post(transport, 'dev', 'order-2')
          const p3 = post(transport, 'dev', 'order-3')
          const [m1, m2, m3] = await Promise.all([p1, p2, p3])
          const evs = (await readAll(transport, start, { channel: 'dev' })).filter((e) => e.type === 'message.posted')
          const idxOf = (id: unknown) => Number(evs.find((e) => String(e.message?.id) === String(id))!.cursor)
          expect(idxOf(m1['id'])).toBeLessThan(idxOf(m2['id']))
          expect(idxOf(m2['id'])).toBeLessThan(idxOf(m3['id']))

          // 2. Reads and waits bypass write lanes
          const bob = await board.peer('bob')
          let writeDone = false
          await peer.hold(500)
          const writeP = post(transport, 'dev', 'blocked-write').finally(() => {
            writeDone = true
          })
          const t0 = performance.now()
          const [bobMe, adaEvs] = await Promise.all([call(bob, 'me', {}), events(transport, { wait: 0 })])
          const readMs = performance.now() - t0
          expect(bobMe['actor']).toBe('local:user:bob')
          expect(adaEvs.cursor).toBeTypeOf('string')
          expect(readMs).toBeLessThan(250)
          expect(writeDone).toBe(false)
          await writeP

          // 3. Default laneMax (64): 1 running + 64 waiting = 65 accepted, 66th sheds 503 backpressure_shed
          await peer.hold(350)
          const qAbort = new AbortController()
          const running = post(transport, 'dev', 'lane-run')
          const queued: Promise<unknown>[] = []
          for (let i = 0; i < 64; i++) {
            queued.push(post(transport, 'dev', `lane-q-${i}`, {}, { signal: qAbort.signal }).catch(() => 'aborted'))
          }
          const shed = await rejection(post(transport, 'dev', 'lane-shed'))
          expect(shed).toMatchObject({ status: 503, code: 'backpressure_shed', retryAfter: 1 })
          qAbort.abort()
          await Promise.all(queued)
          await running
        } finally {
          await peer.close()
        }
      },
    },
  ],
  'CF-17': [
    {
      name: 'HS-166..HS-169 CF-17 busy retry budget/give-up, abort, and schema floor never retried',
      timeoutMs: 60_000,
      async run(ctx) {
        // 1. Budget give-up
        {
          const { dir, board } = await ctx.openWithDir(IDS, { busyBudgetMs: 350 })
          const { transport } = board
          const peer = await ctx.target.spawnPeer!(dir, IDS, 'bob')
          try {
            const before = await head(transport)
            await peer.hold(1200)
            const t0 = performance.now()
            const err = await rejection(post(transport, 'dev', 'should-timeout'))
            const elapsed = performance.now() - t0
            expect(err).toMatchObject({ status: 503, code: 'unavailable', retryAfter: 1 })
            // Pre-sleep budget check (`elapsed + delay > 350`) with capMs 100 gives exact lower bound 250 ms.
            expect(elapsed).toBeGreaterThanOrEqual(250)
            expect(elapsed).toBeLessThan(1000)
            await sleep(900)
            expect(await head(transport)).toBe(before)
          } finally {
            await peer.close()
          }
        }

        // 2. Abort during busy retry
        {
          const { dir, board } = await ctx.openWithDir(IDS)
          const { transport } = board
          const peer = await ctx.target.spawnPeer!(dir, IDS, 'bob')
          try {
            const before = await head(transport)
            await peer.hold(800)
            const ac = new AbortController()
            setTimeout(() => ac.abort(), 100)
            const t0 = performance.now()
            let thrown: unknown
            try {
              await post(transport, 'dev', 'aborted-busy', {}, { signal: ac.signal })
            } catch (e) {
              thrown = e
            }
            const elapsed = performance.now() - t0
            expect(thrown).toBe(ac.signal.reason)
            expect((thrown as Error).name).toBe('AbortError')
            expect(elapsed).toBeLessThan(400)
            await sleep(750)
            expect(await head(transport)).toBe(before)
          } finally {
            await peer.close()
          }
        }

        // 3. Schema write floor never retried
        {
          const dir = tempDir('cb-cf-floor-')
          const db = join(dir, 'board.db')
          const init = new SqliteUnifiedStore({ path: db })
          new BoardService(init)
          init.db
            .prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.schema_write_min', ?)")
            .run(String(SCHEMA_VERSION + 1))
          init.close()
          const board = await ctx.target.open(dir, IDS)
          try {
            const t0 = performance.now()
            const err = await rejection(post(board.transport, 'dev', 'floor-refused'))
            expect(err).toMatchObject({ status: 503, code: 'schema_too_new' })
            expect(err.retryAfter).toBeUndefined()
            expect(performance.now() - t0).toBeLessThan(150)
          } finally {
            await board.close()
          }
        }
      },
    },
  ],
  'CF-18': [
    {
      name: 'HS-173..HS-177 CF-18 write/read floors, restored (410 + expectInstance), and replaced (sticky + poisoned)',
      timeoutMs: 60_000,
      async run(ctx) {
        // 1. Write floor: reads work, writes refuse 503 schema_too_new
        {
          const dir = tempDir('cb-cf-wfloor-')
          const db = join(dir, 'board.db')
          const init = new SqliteUnifiedStore({ path: db })
          new BoardService(init)
          init.db
            .prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.schema_write_min', ?)")
            .run(String(SCHEMA_VERSION + 1))
          init.close()
          const board = await ctx.target.open(dir, IDS)
          try {
            expect(board.transport.capabilities.writable).toBe(false)
            const me = await call(board.transport, 'me', {})
            expect(me['actor']).toBe('local:user:ada')
            const err = await rejection(post(board.transport, 'dev', 'no'))
            expect(err).toMatchObject({ status: 503, code: 'schema_too_new' })
          } finally {
            await board.close()
          }
        }

        // 2. Read floor: open rejects 503 schema_too_new
        {
          const dir = tempDir('cb-cf-rfloor-')
          const db = join(dir, 'board.db')
          const init = new SqliteUnifiedStore({ path: db })
          init.db
            .prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.schema_read_min', ?)")
            .run(String(SCHEMA_VERSION + 1))
          init.close()
          const err = await rejection(ctx.target.open(dir, IDS))
          expect(err).toMatchObject({ status: 503, code: 'schema_too_new' })
        }

        // 3. Restored: rotateInstanceId updates capabilities.instanceId, breaks open events() with 410, honors expectInstance
        {
          const { dir, board } = await ctx.openWithDir(IDS)
          const { transport } = board
          const oldId = transport.capabilities.instanceId!
          const cursor = await head(transport)
          const feedErrP = (async () => {
            try {
              for await (const _ of transport.events({ after: cursor })) {
                // waiting
              }
              return null
            } catch (e) {
              return e
            }
          })()
          await sleep(30)
          const other = new SqliteUnifiedStore({ path: join(dir, 'board.db') })
          const rotated = other.rotateInstanceId()
          other.close()

          await call(transport, 'me', {})
          expect(transport.capabilities.instanceId).toBe(rotated.instanceId)
          expect(rotated.instanceId).not.toBe(oldId)
          const oldExpect = await rejection(events(transport, { after: cursor }, { expectInstance: oldId }))
          expect(oldExpect).toMatchObject({ status: 410, code: 'cursor_expired' })
          await expect(events(transport, { after: cursor }, { expectInstance: rotated.instanceId })).resolves.toBeDefined()
          const feedErr = await feedErrP
          expect(feedErr).toMatchObject({ status: 410, code: 'cursor_expired' })
        }

        // 4. Replaced: sticky 503 details.reason='replaced' and poisoned in same process
        {
          const { dir, board } = await ctx.openWithDir(IDS)
          const { transport } = board
          const db = join(dir, 'board.db')
          const copy = join(dir, 'copy.db')
          const pendingWait = events(transport, { wait: 30 })
          const feedErrP = (async () => {
            try {
              for await (const _ of transport.events({})) {
                // waiting
              }
              return null
            } catch (e) {
              return e
            }
          })()
          await sleep(30)
          const vac = new DatabaseSync(db)
          vac.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`)
          vac.close()
          renameSync(copy, db)

          const err = await rejection(call(transport, 'me', {}))
          expect(err).toMatchObject({ status: 503, code: 'unavailable', details: { reason: 'replaced' } })
          expect(err.retryAfter).toBeUndefined()
          await expect(pendingWait).resolves.toBeDefined()
          expect(await feedErrP).toMatchObject({ status: 503, code: 'unavailable', details: { reason: 'replaced' } })

          // Poisoned: reopening the same path in this process rejects with the sticky replaced error
          const reopenErr = await rejection(ctx.target.open(dir, IDS))
          expect(reopenErr).toMatchObject({ status: 503, code: 'unavailable', details: { reason: 'replaced' } })
        }
      },
    },
  ],
  'CF-19': [
    {
      name: 'HS-179 CF-19 a keyed write that crashed after COMMIT replays once from another process',
      timeoutMs: 60_000,
      async run(ctx) {
        const { dir, board } = await ctx.openWithDir(IDS)
        const { transport } = board
        const peer = await ctx.target.spawnPeer!(dir, IDS, 'ada')
        try {
          const start = await head(transport)
          await peer.crashAfterNextCommit()
          await expect(
            peer.call('post', { channel: 'dev', text: 'crash-replay' }, { idempotencyKey: 'K-cf19' }),
          ).rejects.toThrow()

          const replayed = await post(transport, 'dev', 'crash-replay', {}, { idempotencyKey: 'K-cf19' })
          const found = messageOf(await call(transport, 'posted', { id: keyedId('local:user:ada', null, 'post', 'K-cf19') }))
          expect(found['id']).toBe(replayed['id'])
          const evs = (await readAll(transport, start)).filter(
            (e) => e.type === 'message.posted' && String(e.message?.id) === String(replayed['id']),
          )
          expect(evs).toHaveLength(1)
        } finally {
          await peer.close().catch(() => {})
        }
      },
    },
  ],
}
