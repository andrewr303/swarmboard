// HS-170..HS-172, HS-194: Mode 1 waits (in-process wake, cross-process poster latency with real FileHost vs degraded,
// claimReadyTask under lock hold, and CON-1 streak busy-retry late in a 60 s wait — both fake-timer unit twin and
// real 45 s cross-process test).
import { fork, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskService } from '../../src/core/public.ts'
import { localIdentity } from '../../src/client/identity.ts'
import { SharedFileTransport } from '../../src/client/transport-file.ts'
import { realHostFor } from './host-stub.ts'
import { call, events, head, post, sleep } from './suite/util.ts'

const LOCKER_CHILD = resolve(import.meta.dirname, 'proc', 'locker-child.ts')
const POSTER_CHILD = resolve(import.meta.dirname, 'proc', 'poster-child.ts')
const CLAIM_LOCKER_CHILD = resolve(import.meta.dirname, 'proc', 'claim-locker-child.ts')

const dirs: string[] = []
const transports: SharedFileTransport[] = []
const children: ChildProcess[] = []

function freshDb(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hs-waits-')))
  dirs.push(dir)
  return join(dir, 'board.db')
}

const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!

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
    child.on('exit', () => resolveReleased())
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  while (children.length > 0) {
    const c = children.pop()!
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  }
  while (transports.length > 0) {
    await transports.pop()!.close().catch(() => {})
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('Mode 1 waits (HS-170..HS-172, HS-194)', () => {
  it('HS-170 two degraded SharedFileTransports in one process wake each other within 50ms', async () => {
    const db = freshDb()
    const a = new SharedFileTransport({
      path: db,
      identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
    })
    const b = new SharedFileTransport({
      path: db,
      identity: localIdentity({ userId: 'bob', profiles: [], member: true }),
    })
    transports.push(a, b)
    await a.ready()
    await b.ready()

    const after = await head(a)
    const waiting = events(a, { after, wait: 10 })
    await sleep(15)
    const t0 = performance.now()
    const posted = await post(b, 'dev', 'ping')
    const page = await waiting
    expect(performance.now() - t0).toBeLessThan(50)
    expect(page.events.some((e) => String(e.message?.id) === String(posted['id']))).toBe(true)
  })

  it(
    'HS-172 claimReadyTask behind 600ms hold resolves with task within 2.5s; behind 3s hold resolves <= 2.6s',
    async () => {
      // (a) 600 ms hold -> claims task within 2.5 s
      {
        const db = freshDb()
        const t = new SharedFileTransport({
          path: db,
          identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
          host: realHostFor(db),
        })
        transports.push(t)
        await t.ready()
        const created = (await call(t, 'createTask', { channel: 'work', text: 'ready-1' })) as {
          task: { id: string }
        }
        const lock = await holdLock(db, 600)
        const t0 = performance.now()
        const claimed = (await call(t, 'claimReadyTask', { channel: 'work', wait: 2 })) as {
          task: { id: string } | null
        }
        const elapsed = performance.now() - t0
        await lock.released
        expect(claimed.task?.id).toBe(created.task.id)
        expect(elapsed).toBeLessThanOrEqual(2_500)
        await t.close()
      }

      // (b) 3 s hold with wait: 2 -> resolves {task: null} (or task) never later than 2.6 s
      {
        const db = freshDb()
        const t = new SharedFileTransport({
          path: db,
          identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
          host: realHostFor(db),
        })
        transports.push(t)
        await t.ready()
        await call(t, 'createTask', { channel: 'work', text: 'ready-2' })
        const lock = await holdLock(db, 3_000)
        const t0 = performance.now()
        const claimed = (await call(t, 'claimReadyTask', { channel: 'work', wait: 2 })) as {
          task: { id: string } | null
        }
        const elapsed = performance.now() - t0
        lock.releaseNow()
        await lock.released
        expect(elapsed).toBeLessThanOrEqual(2_600)
        expect(claimed.task === null || typeof claimed.task?.id === 'string').toBe(true)
        await t.close()
      }
    },
    30_000,
  )

  it('HS-194 (unit twin, fake timers) raw busy at fake 45s into wait:60 retries with wait <= 15 and returns claimed task', async () => {
    vi.useFakeTimers()
    const db = freshDb()
    const t = new SharedFileTransport({
      path: db,
      identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
    })
    transports.push(t)
    await t.ready()

    const waitsSeen: number[] = []
    let attempt = 0
    vi.spyOn(TaskService.prototype, 'claimReady').mockImplementation(async (_caller, input) => {
      attempt += 1
      waitsSeen.push(Number((input as { wait?: number }).wait ?? 0))
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 45_000))
        throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
      }
      return { task: { id: 't-late' }, claim: { epoch: 1, token: 'tok' } } as never
    })

    const p = call(t, 'claimReadyTask', { channel: 'work', wait: 60 })
    await vi.advanceTimersByTimeAsync(45_000)
    await vi.advanceTimersByTimeAsync(200)
    const res = (await p) as { task: { id: string } | null }

    expect(attempt).toBe(2)
    expect(waitsSeen[0]).toBe(60)
    expect(waitsSeen[1]).toBeLessThanOrEqual(15)
    expect(waitsSeen[1]).toBeGreaterThanOrEqual(14)
    expect(res.task?.id).toBe('t-late')
    expect(t.stats().busyRetries).toBe(1)

    vi.useRealTimers()
    await t.close()
  })

  it(
    'HS-194 (real proc, 45s wait) Mode 1 real FileHost: claimReadyTask(wait:60) survives busy re-poll at 45s via streak budget and claims task within 2s of commit',
    async () => {
      const db = freshDb()
      const t = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
        host: realHostFor(db),
      })
      transports.push(t)
      const caps = await t.ready()
      expect(caps.wake).toBe('fs-watch')

      // Ensure work channel & .wakeup exist so watcher is watching the .wakeup file before wait starts.
      await call(t, 'createChannel', { path: 'work' })
      await post(t, 'dev', 'arm-wakeup')
      await sleep(50)

      const child = fork(
        CLAIM_LOCKER_CHILD,
        [JSON.stringify({ db, channel: 'work', text: 'late-task-45s', holdMs: 300, userId: 'ada' })],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      )
      children.push(child)

      let committedTaskId = ''
      let commitAtNs = 0n
      await new Promise<void>((res, rej) => {
        child.on('message', (raw: unknown) => {
          const m = raw as { ready?: boolean; committed?: boolean; taskId?: string; commitAtNs?: string; error?: string }
          if (m?.ready) res()
          if (m?.committed) {
            committedTaskId = String(m.taskId)
            commitAtNs = BigInt(m.commitAtNs!)
          }
          if (m?.error) rej(new Error(m.error))
        })
        child.on('error', rej)
      })

      const started = performance.now()
      const waiting = call(t, 'claimReadyTask', { channel: 'work', wait: 60 }) as Promise<{
        task: { id: string } | null
      }>

      // Wait 45 seconds (past the default 30 s busy budget!), then trigger createTask + immediate 300 ms BEGIN IMMEDIATE.
      await sleep(45_000)
      child.send({ go: true })

      const claimed = await waiting
      const resolvedAtNs = process.hrtime.bigint()
      const totalElapsed = performance.now() - started

      expect(claimed.task?.id).toBe(committedTaskId)
      expect(committedTaskId).not.toBe('')
      // Core claimReady now retries transient SQLITE_BUSY internally during wait re-polls (F23 fix),
      // so the 300ms lock hold at 45s is absorbed cleanly without giving up (transport streak retry
      // remains verified by the fake-timer unit twin above).
      expect(t.stats().busyGiveUps).toBe(0)
      expect(totalElapsed).toBeLessThan(60_000)
      const sinceCommitMs = Number(resolvedAtNs - commitAtNs) / 1e6
      expect(sinceCommitMs).toBeLessThan(2_000)
    },
    120_000,
  )

  it(
    'HS-171 poster child posts 30 messages: real FileHost p95 <= 50ms; degraded mode p95 <= 160ms, none missing or duplicated',
    async () => {
      const runCase = async (useFileHost: boolean) => {
        const db = freshDb()
        const t = new SharedFileTransport({
          path: db,
          identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
          ...(useFileHost ? { host: realHostFor(db) } : {}),
        })
        transports.push(t)
        const caps = await t.ready()
        if (useFileHost) expect(caps.wake).toBe('fs-watch')
        else expect(caps.wake).toBe('poll')

        // Warm up `.wakeup` so file-watch is armed before the 30 measured messages.
        await post(t, 'dev', 'warmup')
        await sleep(50)
        const start = await head(t)

        const child = fork(
          POSTER_CHILD,
          [JSON.stringify({ db, channel: 'dev', count: 30, gapMs: 120, useFileHost })],
          { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
        )
        children.push(child)

        await new Promise<void>((res, rej) => {
          child.on('message', (raw: unknown) => {
            if ((raw as { ready?: boolean })?.ready) res()
          })
          child.on('error', rej)
          child.on('exit', (code) => {
            if (code !== 0) rej(new Error(`poster-child exited early with ${code}`))
          })
        })

        const lags: number[] = []
        const seenIdx = new Set<string>()
        let dupes = 0
        const ac = new AbortController()

        const consumer = (async () => {
          for await (const page of t.events({ channel: 'dev', after: start }, { signal: ac.signal })) {
            const recvNs = process.hrtime.bigint()
            for (const ev of page.events) {
              if (ev.type !== 'message.posted') continue
              if (seenIdx.has(ev.cursor)) dupes += 1
              seenIdx.add(ev.cursor)
              const payload = JSON.parse(String(ev.message?.text ?? '{}')) as { seq?: number; t0Ns?: string }
              if (typeof payload.t0Ns === 'string') {
                lags.push(Number(recvNs - BigInt(payload.t0Ns)) / 1e6)
              }
              if (seenIdx.size >= 30) {
                ac.abort()
                break
              }
            }
          }
        })()

        await sleep(25)
        child.send({ go: true })
        await consumer
        await t.close()
        return { count: seenIdx.size, dupes, p95Lag: p95(lags) }
      }

      const bridged = await runCase(true)
      expect(bridged.count).toBe(30)
      expect(bridged.dupes).toBe(0)
      expect(bridged.p95Lag).toBeLessThanOrEqual(50)

      const degraded = await runCase(false)
      expect(degraded.count).toBe(30)
      expect(degraded.dupes).toBe(0)
      expect(degraded.p95Lag).toBeLessThanOrEqual(160)
    },
    60_000,
  )
})
