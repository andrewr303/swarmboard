// HOST123_DESIGN Stage B6 multi-process busy tests (HS-105, HS-108).
// Multi-process tests are sleep-sensitive (H0 errata): re-run this file alone before debugging a timeout.
import { fork } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../../src/core/public.ts'
import { LONG_LIVED_BUSY_TIMEOUT_MS, setBusyTimeout, withBusyRetry } from '../../../src/client/busy.ts'

const CHILD = fileURLToPath(new URL('./busy-writer.ts', import.meta.url))
const owner = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const dirs: string[] = []

function tmpDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cb-busy-proc-')))
  dirs.push(d)
  return d
}

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

interface ChildResult<T = Record<string, unknown>> {
  code: number | null
  out: T | null
  stderr: string
}

function spawnChild<T = Record<string, unknown>>(args: Record<string, unknown>): Promise<ChildResult<T>> {
  const proc = fork(CHILD, [JSON.stringify(args)], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stdout = ''
  let stderr = ''
  proc.stdout!.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
  proc.stderr!.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
  return new Promise((resolve) => {
    proc.once('exit', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).at(-1)
      resolve({ code, out: line ? (JSON.parse(line) as T) : null, stderr })
    })
  })
}

async function waitForFile(path: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

function readWakeupFileGen(wakeupPath: string): number {
  const fd = fs.openSync(wakeupPath, 'r')
  try {
    const buf = Buffer.alloc(8)
    return fs.readSync(fd, buf, 0, 8, 0) === 8 ? Number(buf.readBigUInt64LE(0)) : 0
  } finally {
    fs.closeSync(fd)
  }
}

describe('busy retry under real SQLite contention (HS-105, HS-108)', () => {
  it('HS-105 300 ms foreign BEGIN IMMEDIATE: default busy_timeout stalls >= 250 ms; 50 ms + withBusyRetry stays < 150 ms', async () => {
    const dir = tmpDir()
    const db = join(dir, 'board.db')

    // Seed the board and channel before the lock tests.
    {
      const initStore = new SqliteUnifiedStore({ path: db })
      const initBoard = new BoardService(initStore)
      initBoard.createChannel(owner, { path: 'dev' })
      initStore.close()
    }

    // (a) Default busy_timeout (5000 ms), plain postMessage: 1 ms heartbeat observes gap >= 250 ms.
    {
      const store = new SqliteUnifiedStore({ path: db })
      const board = new BoardService(store)
      const ready = join(dir, 'lock-a-ready')
      const locker = spawnChild({ mode: 'holdLock', db, ready, holdMs: 300 })
      try {
        await waitForFile(ready, 'lock-a')
        let last = performance.now()
        let maxGap = 0
        const timer = setInterval(() => {
          const now = performance.now()
          const gap = now - last
          if (gap > maxGap) maxGap = gap
          last = now
        }, 1)
        try {
          // Let one heartbeat tick run, then invoke synchronous postMessage while child holds the lock.
          await new Promise((r) => setTimeout(r, 5))
          const posted = board.postMessage(owner, { channel: 'dev', text: 'sync-5000' })
          expect(posted.message.text).toBe('sync-5000')
          await new Promise((r) => setTimeout(r, 5))
        } finally {
          clearInterval(timer)
        }
        const lockRes = await locker
        expect(lockRes.code, lockRes.stderr).toBe(0)
        expect(maxGap).toBeGreaterThanOrEqual(250)
      } finally {
        store.close()
      }
    }

    // (b) setBusyTimeout(store, 50) + withBusyRetry: post succeeds, max gap < 150 ms, exactly one message.posted.
    {
      const store = new SqliteUnifiedStore({ path: db })
      const board = new BoardService(store)
      setBusyTimeout(store, LONG_LIVED_BUSY_TIMEOUT_MS)
      const ready = join(dir, 'lock-b-ready')
      const locker = spawnChild({ mode: 'holdLock', db, ready, holdMs: 300 })
      try {
        await waitForFile(ready, 'lock-b')
        let last = performance.now()
        let maxGap = 0
        const timer = setInterval(() => {
          const now = performance.now()
          const gap = now - last
          if (gap > maxGap) maxGap = gap
          last = now
        }, 1)
        let postedId = ''
        let retryCount = 0
        try {
          await new Promise((r) => setTimeout(r, 5))
          const posted = await withBusyRetry(
            () => board.postMessage(owner, { channel: 'dev', text: 'async-50' }),
            {
              onRetry: () => {
                retryCount += 1
              },
            },
          )
          postedId = posted.message.id
          await new Promise((r) => setTimeout(r, 5))
        } finally {
          clearInterval(timer)
        }
        const lockRes = await locker
        expect(lockRes.code, lockRes.stderr).toBe(0)
        expect(retryCount).toBeGreaterThanOrEqual(1)
        expect(maxGap).toBeLessThan(150)

        const rows = store.db
          .prepare("SELECT event_id, payload_json FROM board_events WHERE type = 'message.posted'")
          .all() as Array<{ event_id: string; payload_json: string }>
        const matches = rows.filter((r) => {
          const parsed = JSON.parse(r.payload_json) as { id?: string | number; text?: string; message?: { id?: string; text?: string } }
          return String(parsed.id ?? parsed.message?.id ?? '') === postedId || parsed.text === 'async-50' || parsed.message?.text === 'async-50'
        })
        expect(matches).toHaveLength(1)
      } finally {
        store.close()
      }
    }
  }, 60_000)

  it('HS-108 32 writers x 40 posts at 50 ms + withBusyRetry: 0 errors, 1280 posts, head = count, wakeup gen synced, max gap < 250 ms', async () => {
    const dir = tmpDir()
    const db = join(dir, 'board.db')
    const barrier = join(dir, 'go')
    const writers = 32
    const postsPerWriter = 40

    // Initialize and seed the board and channel before releasing the 32 writers.
    {
      const initStore = new SqliteUnifiedStore({ path: db })
      const initBoard = new BoardService(initStore)
      initBoard.createChannel(owner, { path: 'dev' })
      initStore.close()
    }

    type WriterOut = { id: number; posts: number; retries: number; maxGapMs: number; errors: string[] }
    const readyPaths = Array.from({ length: writers }, (_, i) => join(dir, `ready-${i}`))
    const procs = readyPaths.map((ready, i) =>
      spawnChild<WriterOut>({
        mode: 'writer',
        db,
        id: i,
        posts: postsPerWriter,
        barrier,
        ready,
        busyTimeoutMs: LONG_LIVED_BUSY_TIMEOUT_MS,
      }),
    )

    await Promise.all(readyPaths.map((p, i) => waitForFile(p, `writer-${i}`, 60_000)))
    fs.writeFileSync(barrier, '')

    const results = await Promise.all(procs)
    for (const r of results) {
      expect(r.code, r.stderr).toBe(0)
      expect(r.out).not.toBeNull()
      expect(r.out!.errors).toEqual([])
      expect(r.out!.maxGapMs, `writer ${r.out!.id} maxGapMs`).toBeLessThan(250)
    }

    const verifyStore = new SqliteUnifiedStore({ path: db })
    try {
      const postedCount = (
        verifyStore.db
          .prepare("SELECT COUNT(*) AS n FROM board_events WHERE type = 'message.posted'")
          .get() as { n: number }
      ).n
      expect(postedCount).toBe(writers * postsPerWriter)

      const totalEvents = (
        verifyStore.db.prepare('SELECT COUNT(*) AS n FROM board_events').get() as { n: number }
      ).n
      expect(verifyStore.getHeadIndex()).toBe(totalEvents)

      const dbGenRow = verifyStore.db
        .prepare("SELECT COALESCE(CAST(value AS INTEGER), 0) AS gen FROM board_meta WHERE key = 'wakeup_generation'")
        .get() as { gen: number }
      const fileGen = readWakeupFileGen(`${db}.wakeup`)
      expect(fileGen).toBeGreaterThanOrEqual(dbGenRow.gen)
      expect(dbGenRow.gen).toBeGreaterThanOrEqual(writers * postsPerWriter)
    } finally {
      verifyStore.close()
    }
  }, 120_000)
})
