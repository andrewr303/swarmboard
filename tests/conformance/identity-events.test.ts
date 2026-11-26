// HS-173..HS-177: schema write/read floors, legacy tasks_schema=99 read-only, replaced (per-call & bridge
// detection + process-level poisoning), and restored (rotateInstanceId, 410 cursor_expired, expectInstance,
// single epoch increment).
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, SCHEMA_VERSION, SqliteUnifiedStore } from '../../src/core/public.ts'
import { localIdentity } from '../../src/client/identity.ts'
import { openedBoards, SharedFileTransport } from '../../src/client/transport-file.ts'
import { makeLegacyFile } from '../core/host0/legacy.ts'
import { createRecordingFileHost, realHostFor } from './host-stub.ts'
import { call, events, head, post, rejection, sleep } from './suite/util.ts'

const dirs: string[] = []
const transports: SharedFileTransport[] = []

function freshDb(tag = 'hs-id-ev-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), tag)))
  dirs.push(dir)
  return join(dir, 'board.db')
}

afterEach(async () => {
  while (transports.length > 0) {
    await transports.pop()!.close().catch(() => {})
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('Mode 1 schema floors, replaced, and restored (HS-173..HS-177)', () => {
  it('HS-173 write floor raised to SCHEMA_VERSION + 1: ready() resolves, reads work, post rejects 503 schema_too_new with details.build === SCHEMA_VERSION', async () => {
    const db = freshDb()
    const init = new SqliteUnifiedStore({ path: db })
    new BoardService(init)
    const beforeCount = Number(
      (init.db.prepare('SELECT COUNT(*) AS n FROM board_events').get() as { n: number }).n,
    )
    init.db
      .prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.schema_write_min', ?)")
      .run(String(SCHEMA_VERSION + 1))
    init.close()

    const t = new SharedFileTransport({
      path: db,
      identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
      host: realHostFor(db),
    })
    transports.push(t)
    const caps = await t.ready()
    expect(caps.schemaVersion).toBe(SCHEMA_VERSION)
    expect(caps.writable).toBe(false)

    expect((await call(t, 'me', {}))['actor']).toBe('local:user:ada')
    await expect(call(t, 'channelMessages', { channel: 'dev' })).resolves.toBeDefined()

    const err = await rejection(post(t, 'dev', 'blocked'))
    expect(err).toMatchObject({ status: 503, code: 'schema_too_new', details: { build: SCHEMA_VERSION } })

    await t.close()
    const check = new DatabaseSync(db, { readOnly: true })
    try {
      const afterCount = Number(
        (check.prepare('SELECT COUNT(*) AS n FROM board_events').get() as { n: number }).n,
      )
      expect(afterCount).toBe(beforeCount)
    } finally {
      check.close()
    }
  })

  it('HS-174 read floor raised to SCHEMA_VERSION + 1: ready() & call("me") reject 503 schema_too_new, openedBoards empty, db/wal unchanged', async () => {
    const db = freshDb()
    const init = new SqliteUnifiedStore({ path: db })
    new BoardService(init)
    init.db
      .prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('core.schema_read_min', ?)")
      .run(String(SCHEMA_VERSION + 1))
    init.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    init.close()

    const stBefore = fs.statSync(db)
    const walBefore = fs.existsSync(`${db}-wal`) ? fs.statSync(`${db}-wal`).size : 0

    const t = new SharedFileTransport({
      path: db,
      identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
    })
    transports.push(t)

    expect(await rejection(t.ready())).toMatchObject({ status: 503, code: 'schema_too_new' })
    expect(await rejection(call(t, 'me', {}))).toMatchObject({ status: 503, code: 'schema_too_new' })
    expect(openedBoards().some((b) => b.key === db)).toBe(false)

    const stAfter = fs.statSync(db)
    const walAfter = fs.existsSync(`${db}-wal`) ? fs.statSync(`${db}-wal`).size : 0
    expect(stAfter.size).toBe(stBefore.size)
    expect(stAfter.mtimeMs).toBe(stBefore.mtimeMs)
    expect(walAfter).toBeLessThanOrEqual(walBefore)
  })

  it('HS-175 legacy slice-A with tasks_schema=99 opens read-only via SharedFileTransport + real FileHost with null ids, manifest-unverified warning, and 0 busyRetries', async () => {
    const db = freshDb()
    makeLegacyFile(db, 'sliceA')
    const raw = new DatabaseSync(db)
    raw.prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('tasks_schema', '99')").run()
    raw.close()

    const t = new SharedFileTransport({
      path: db,
      identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
      host: realHostFor(db),
    })
    transports.push(t)
    const caps = await t.ready()
    expect(caps.writable).toBe(false)
    expect(caps.boardId).toBeNull()
    expect(caps.instanceId).toBeNull()
    expect(fs.existsSync(`${db}.manifest.json`)).toBe(false)
    expect(t.warnings.some((w) => w.note.includes('manifest-unverified'))).toBe(true)

    const err = await rejection(post(t, 'dev', 'no'))
    expect(err).toMatchObject({
      status: 503,
      code: 'unavailable',
      message: 'this board was written by a newer Swarmboard (tasks_schema 99)',
    })
    expect(err.retryAfter).toBeUndefined()
    expect(t.stats().busyRetries).toBe(0)
  })

  it(
    'HS-176 replaced (VACUUM INTO rename-over): (a) stub FileHost per-call detection & (b) real FileHost bridge detection; both sticky, poisoned, 1 store open, attachment closed before store',
    async () => {
      // (a) Recording stub FileHost (no bridge; per-call check detects replacement)
      {
        const db = freshDb('hs176a-')
        const rec = createRecordingFileHost({ closeDelayMs: 15 })
        const t = new SharedFileTransport({
          path: db,
          identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
          host: rec.host,
        })
        transports.push(t)
        await t.ready()
        expect(rec.openCalls).toHaveLength(1)

        const pendingWait = events(t, { wait: 30 })
        const feedErrP = (async () => {
          try {
            for await (const _ of t.events({})) {
              // waiting
            }
            return null
          } catch (e) {
            return e
          }
        })()
        await sleep(30)

        const copy = `${db}.copy`
        const vac = new DatabaseSync(db)
        vac.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`)
        vac.close()
        fs.renameSync(copy, db)

        const t0 = performance.now()
        const meErr = await rejection(call(t, 'me', {}))
        expect(meErr).toMatchObject({
          status: 503,
          code: 'unavailable',
          details: { reason: 'replaced' },
        })
        expect(meErr.retryAfter).toBeUndefined()

        await pendingWait
        expect(performance.now() - t0).toBeLessThan(200)

        const feedErr = await feedErrP
        expect(feedErr).toMatchObject({
          status: 503,
          code: 'unavailable',
          details: { reason: 'replaced' },
        })

        expect(rec.closeCount()).toBe(1)
        const idxAttachDone = rec.events.indexOf('attachment.close:done')
        const idxStoreClose = rec.events.indexOf('store.close')
        expect(idxAttachDone).toBeGreaterThan(-1)
        expect(idxStoreClose).toBeGreaterThan(idxAttachDone)

        // Poisoned: a brand-new transport on the same path in the same process rejects ready() without opening a store
        const rec2 = createRecordingFileHost()
        const t2 = new SharedFileTransport({
          path: db,
          identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
          host: rec2.host,
        })
        transports.push(t2)
        const err2 = await rejection(t2.ready())
        expect(err2).toMatchObject({
          status: 503,
          code: 'unavailable',
          details: { reason: 'replaced' },
        })
        expect(rec2.openCalls).toHaveLength(0)
        expect(rec.openCalls).toHaveLength(1)
        expect(openedBoards().find((b) => b.key === db)?.state).toBe('stopped')
      }

      // (b) Real FileHost (safetyPollMs: 300; bridge detects replacement on its own turn)
      {
        const db = freshDb('hs176b-')
        const real = realHostFor(db, { safetyPollMs: 300 })
        let hostOpenCount = 0
        let attachCloseCount = 0
        const wrappedHost = {
          open(path: string, storeOpts?: Parameters<typeof real.open>[1]) {
            hostOpenCount += 1
            return real.open(path, storeOpts)
          },
          attach(store: SqliteUnifiedStore) {
            const att = real.attach(store)
            const origClose = att.close.bind(att)
            return {
              ...att,
              get wake() {
                return att.wake
              },
              get safetyPollMs() {
                return att.safetyPollMs
              },
              get ticking() {
                return att.ticking
              },
              async close() {
                attachCloseCount += 1
                await origClose()
              },
            }
          },
        }

        const t = new SharedFileTransport({
          path: db,
          identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
          host: wrappedHost,
        })
        transports.push(t)
        await t.ready()

        const pendingWait = events(t, { wait: 30 })
        const feedErrP = (async () => {
          try {
            for await (const _ of t.events({})) {
              // waiting
            }
            return null
          } catch (e) {
            return e
          }
        })()
        await sleep(30)

        const copy = `${db}.copy`
        const vac = new DatabaseSync(db)
        vac.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`)
        vac.close()
        fs.renameSync(copy, db)

        const t0 = performance.now()
        const feedErr = await feedErrP
        expect(performance.now() - t0).toBeLessThan(1_000)
        expect(feedErr).toMatchObject({
          status: 503,
          code: 'unavailable',
          details: { reason: 'replaced' },
        })
        await expect(pendingWait).resolves.toBeDefined()

        const meErr = await rejection(call(t, 'me', {}))
        expect(meErr).toMatchObject({ status: 503, code: 'unavailable', details: { reason: 'replaced' } })
        expect(attachCloseCount).toBe(1)

        // Poisoned: new transport rejects without calling host.open
        const t2 = new SharedFileTransport({
          path: db,
          identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
          host: wrappedHost,
        })
        transports.push(t2)
        const err2 = await rejection(t2.ready())
        expect(err2).toMatchObject({ status: 503, code: 'unavailable', details: { reason: 'replaced' } })
        expect(hostOpenCount).toBe(1)
        expect(openedBoards().find((b) => b.key === db)?.state).toBe('stopped')
      }
    },
    30_000,
  )

  it(
    'HS-177 rotateInstanceId(): updates capabilities.instanceId, breaks open events() with 410, honors expectInstance, aborts bridged events->410 & claimReadyTask->{task:null}, increments epoch once',
    async () => {
      const db = freshDb()
      const safetyPollMs = 300
      const real = realHostFor(db, { safetyPollMs })
      let resetCount = 0
      const host = {
        open: real.open.bind(real),
        attach(store: SqliteUnifiedStore) {
          const att = real.attach(store)
          att.onReset(() => {
            resetCount += 1
          })
          return att
        },
      }
      const t = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
        host,
      })
      transports.push(t)
      const capsBefore = await t.ready()
      const oldId = capsBefore.instanceId!
      const cursor = await head(t)

      const pendingEvents = events(t, { after: cursor, wait: 30 })
      const pendingClaim = call(t, 'claimReadyTask', { channel: 'work', wait: 30 })
      const feedErrP = (async () => {
        try {
          for await (const _ of t.events({ after: cursor })) {
            // waiting
          }
          return null
        } catch (e) {
          return e
        }
      })()
      await sleep(40)

      const t0 = performance.now()
      const other = new SqliteUnifiedStore({ path: db })
      const rotated = other.rotateInstanceId()
      other.close()

      const pendingEventsErr = await rejection(pendingEvents)
      expect(performance.now() - t0).toBeLessThan(safetyPollMs + 500)
      expect(pendingEventsErr).toMatchObject({
        status: 410,
        code: 'cursor_expired',
        details: { reason: 'instance_changed', instanceId: rotated.instanceId },
      })

      expect(await pendingClaim).toEqual({ task: null })
      const feedErr = await feedErrP
      expect(feedErr).toMatchObject({
        status: 410,
        code: 'cursor_expired',
        details: { instanceId: rotated.instanceId },
      })

      // Subsequent call('me') resolves and capabilities snapshot updates once (same ref before & after call('me'))
      const capsAfterBridge = t.capabilities
      expect(capsAfterBridge).not.toBe(capsBefore)
      expect(capsAfterBridge.instanceId).toBe(rotated.instanceId)

      await expect(call(t, 'me', {})).resolves.toBeDefined()
      // Epoch did NOT double-increment when per-call check ran after the bridge already saw the restore!
      expect(t.capabilities).toBe(capsAfterBridge)
      expect(resetCount).toBe(1)

      // expectInstance check
      expect(await rejection(events(t, { after: cursor }, { expectInstance: oldId }))).toMatchObject({
        status: 410,
        code: 'cursor_expired',
      })
      await expect(events(t, { after: cursor }, { expectInstance: rotated.instanceId })).resolves.toBeDefined()
    },
    30_000,
  )
})
