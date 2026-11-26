// HS-163..HS-165: per-identity FIFO write lanes under cross-process lock holds, read/wait bypass, laneMax shedding.
import { fork, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localIdentity } from '../../src/client/identity.ts'
import { Lanes } from '../../src/client/lanes.ts'
import { SharedFileTransport } from '../../src/client/transport-file.ts'
import { realHostFor } from './host-stub.ts'
import { call, events, head, post, readAll, rejection, sleep } from './suite/util.ts'

const LOCKER_CHILD = resolve(import.meta.dirname, 'proc', 'locker-child.ts')

const dirs: string[] = []
const transports: SharedFileTransport[] = []
const children: ChildProcess[] = []

function freshDb(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hs-lanes-')))
  dirs.push(dir)
  return join(dir, 'board.db')
}

async function holdLock(db: string, holdMs: number): Promise<{ released: Promise<void>; releaseNow: () => void }> {
  const child = fork(LOCKER_CHILD, [JSON.stringify({ db, holdMs })], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(child)
  let resolveReleased!: () => void
  const released = new Promise<void>((r) => {
    resolveReleased = r
  })
  await new Promise<void>((res, rej) => {
    child.on('message', (raw: unknown) => {
      const m = raw as { held?: boolean; released?: boolean }
      if (m?.held) res()
      if (m?.released) resolveReleased()
    })
    child.on('exit', () => {
      resolveReleased()
    })
    child.on('error', rej)
  })
  return {
    released,
    releaseNow: () => {
      if (child.connected) child.send({ release: true })
    },
  }
}

afterEach(async () => {
  while (children.length > 0) {
    const c = children.pop()!
    if (c.exitCode === null && c.signalCode === null) {
      c.kill('SIGKILL')
    }
  }
  while (transports.length > 0) {
    await transports.pop()!.close().catch(() => {})
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('Mode 1 per-identity write lanes (HS-163..HS-165)', () => {
  it(
    'HS-163 peer holds BEGIN IMMEDIATE 600ms; ada issues a1, a2, a3 without awaiting -> log_index ascends in issue order (×5 rounds)',
    async () => {
      const db = freshDb()
      const t = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
        host: realHostFor(db),
      })
      transports.push(t)
      await t.ready()

      for (let round = 0; round < 5; round++) {
        const start = await head(t)
        const lock = await holdLock(db, 600)
        const p1 = post(t, 'dev', `r${round}-a1`)
        const p2 = post(t, 'dev', `r${round}-a2`)
        const p3 = post(t, 'dev', `r${round}-a3`)
        const [m1, m2, m3] = await Promise.all([p1, p2, p3])
        await lock.released

        const evs = (await readAll(t, start, { channel: 'dev' })).filter((e) => e.type === 'message.posted')
        const idx = (id: unknown) => Number(evs.find((e) => String(e.message?.id) === String(id))!.cursor)
        expect(idx(m1['id'])).toBeLessThan(idx(m2['id']))
        expect(idx(m2['id'])).toBeLessThan(idx(m3['id']))
      }
    },
    60_000,
  )

  it(
    'HS-164 while ada write backs off behind 800ms lock, bob me/channelMessages and ada events(wait:0) resolve <250ms & before release & before ada post; bob events(wait:5) wakes <250ms after release',
    async () => {
      const db = freshDb()
      const ada = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
        host: realHostFor(db),
      })
      const bob = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'bob', profiles: [], member: true }),
      })
      transports.push(ada, bob)
      await ada.ready()
      await bob.ready()
      await post(ada, 'dev', 'seed-msg')

      const beforeHead = await head(bob)
      const bobWait = events(bob, { after: beforeHead, wait: 5 }).then((page) => ({
        page,
        at: performance.now(),
      }))
      await sleep(20)

      let releasedAt = 0
      let adaPostDone = false
      const lock = await holdLock(db, 800)
      const releasedP = lock.released.then(() => {
        releasedAt = performance.now()
      })

      const adaPost = post(ada, 'dev', 'ada-delayed').finally(() => {
        adaPostDone = true
      })
      await sleep(30)

      const t0 = performance.now()
      const bobMe = await call(bob, 'me', {})
      const bobMeMs = performance.now() - t0
      expect(bobMe['actor']).toBe('local:user:bob')
      expect(bobMeMs).toBeLessThan(250)
      expect(releasedAt).toBe(0)
      expect(adaPostDone).toBe(false)

      const t1 = performance.now()
      const msgs = await call(bob, 'channelMessages', { channel: 'dev' })
      const msgsMs = performance.now() - t1
      expect(msgs).toBeDefined()
      expect(msgsMs).toBeLessThan(250)
      expect(releasedAt).toBe(0)
      expect(adaPostDone).toBe(false)

      const t2 = performance.now()
      const adaEvs = await events(ada, { wait: 0 })
      const adaEvsMs = performance.now() - t2
      expect(adaEvs.cursor).toBeTypeOf('string')
      expect(adaEvsMs).toBeLessThan(250)
      expect(releasedAt).toBe(0)
      expect(adaPostDone).toBe(false)

      const [posted, waitRes] = await Promise.all([adaPost, bobWait])
      await releasedP
      const wakeAfterRelease = Math.max(0, waitRes.at - releasedAt)
      expect(waitRes.page.events.some((e) => String(e.message?.id) === String(posted['id']))).toBe(true)
      expect(wakeAfterRelease).toBeLessThan(250)
    },
    30_000,
  )

  it(
    'HS-165 laneMax:2 accepts 1 running + 2 waiting, sheds 4th immediately with 503 backpressure_shed (attempts unchanged); bob queues normally; 3 accepted writes land in order; Lanes.size() === 0',
    async () => {
      const db = freshDb()
      const ada = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
        host: realHostFor(db),
        laneMax: 2,
      })
      const bob = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'bob', profiles: [], member: true }),
      })
      transports.push(ada, bob)
      await ada.ready()
      await bob.ready()

      const start = await head(ada)
      const lock = await holdLock(db, 600)

      const p1 = post(ada, 'dev', 'ada-1')
      const p2 = post(ada, 'dev', 'ada-2')
      const p3 = post(ada, 'dev', 'ada-3')
      const attemptsBefore4th = ada.stats().attempts
      const shedErr = await rejection(post(ada, 'dev', 'ada-4-shed'))
      expect(shedErr).toMatchObject({ status: 503, code: 'backpressure_shed', retryAfter: 1 })
      // The shed write was rejected before entering the retry loop; attempts did not increase because of it.
      expect(ada.stats().attempts).toBe(attemptsBefore4th)

      // Bob's lane is completely independent and queues normally.
      const pBob = post(bob, 'dev', 'bob-1')

      const [m1, m2, m3, mBob] = await Promise.all([p1, p2, p3, pBob])
      await lock.released
      expect(mBob['text']).toBe('bob-1')

      const evs = (await readAll(ada, start, { channel: 'dev' })).filter((e) => e.type === 'message.posted')
      const idx = (id: unknown) => Number(evs.find((e) => String(e.message?.id) === String(id))!.cursor)
      expect(idx(m1['id'])).toBeLessThan(idx(m2['id']))
      expect(idx(m2['id'])).toBeLessThan(idx(m3['id']))
      expect(evs.some((e) => String(e.message?.id) === String(mBob['id']))).toBe(true)

      // Direct verification that Lanes.size() returns 0 after draining.
      const lanes = new Lanes({ max: 2 })
      let releaseFirst!: () => void
      const firstHold = new Promise<void>((r) => {
        releaseFirst = r
      })
      const l1 = lanes.run('ada', 'write', () => firstHold)
      const l2 = lanes.run('ada', 'write', async () => 'two')
      const l3 = lanes.run('ada', 'write', async () => 'three')
      await expect(lanes.run('ada', 'write', async () => 'four')).rejects.toMatchObject({
        status: 503,
        code: 'backpressure_shed',
        retryAfter: 1,
      })
      expect(lanes.size()).toBe(1)
      releaseFirst()
      await Promise.all([l1, l2, l3])
      expect(lanes.size()).toBe(0)
    },
    30_000,
  )
})
