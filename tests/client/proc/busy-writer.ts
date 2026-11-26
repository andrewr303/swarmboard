// Child helper for Stage B6 multi-process busy tests (HS-105, HS-108).
// Modes (JSON argv[2]):
//   - { mode: 'holdLock', db, ready, holdMs }: takes BEGIN IMMEDIATE on raw DatabaseSync, writes `ready`,
//     holds for `holdMs` ms (blocking via Atomics.wait), commits, and exits.
//   - { mode: 'writer', db, id, posts, barrier, ready, busyTimeoutMs }: opens SqliteUnifiedStore +
//     BoardService, calls setBusyTimeout(store, busyTimeoutMs), touches `ready`, waits for `barrier`
//     (async polling so event-loop heartbeat starts cleanly on release), posts `posts` messages with
//     withBusyRetry while measuring event-loop lag via a 5 ms setInterval, and writes one JSON summary line.
import * as fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../../src/core/public.ts'
import { LONG_LIVED_BUSY_TIMEOUT_MS, setBusyTimeout, withBusyRetry } from '../../../src/client/busy.ts'

type Args =
  | { mode: 'holdLock'; db: string; ready: string; holdMs: number }
  | {
      mode: 'writer'
      db: string
      id: number
      posts: number
      barrier: string
      ready: string
      busyTimeoutMs?: number
    }

const args = JSON.parse(process.argv[2] ?? '{}') as Args
const sleepBuf = new Int32Array(new SharedArrayBuffer(4))

async function main(): Promise<void> {
  if (args.mode === 'holdLock') {
    const db = new DatabaseSync(args.db)
    try {
      db.exec('PRAGMA busy_timeout = 10000;')
      db.exec('BEGIN IMMEDIATE')
      fs.writeFileSync(args.ready, String(process.pid))
      Atomics.wait(sleepBuf, 0, 0, args.holdMs)
      db.exec('COMMIT')
    } finally {
      db.close()
    }
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`)
    return
  }

  if (args.mode === 'writer') {
    const store = new SqliteUnifiedStore({ path: args.db })
    const board = new BoardService(store)
    setBusyTimeout(store, args.busyTimeoutMs ?? LONG_LIVED_BUSY_TIMEOUT_MS)
    const caller = createLocalCaller({ userId: `w${args.id}`, handle: `w${args.id}`, member: true })

    // Signal parent that this writer is open and ready for the shared start barrier.
    fs.writeFileSync(args.ready, String(process.pid))
    const waitDeadline = Date.now() + 60_000
    while (!fs.existsSync(args.barrier)) {
      if (Date.now() > waitDeadline) throw new Error(`writer ${args.id}: timed out waiting for barrier`)
      await new Promise((r) => setTimeout(r, 5))
    }

    let lastTick = performance.now()
    let maxGapMs = 0
    const heartbeat = setInterval(() => {
      const now = performance.now()
      const gap = now - lastTick
      if (gap > maxGapMs) maxGapMs = gap
      lastTick = now
    }, 5)

    let retries = 0
    const errors: string[] = []
    try {
      for (let i = 0; i < args.posts; i++) {
        await withBusyRetry(
          () => board.postMessage(caller, { channel: 'dev', text: `w${args.id}-m${i}` }),
          {
            onRetry: () => {
              retries += 1
            },
          },
        )
        // Yield a macrotask turn between distinct posts so consecutive synchronous successes
        // do not stack multiple 50 ms busy_timeout waits into a single microtask drain.
        await new Promise<void>((r) => setImmediate(r))
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    } finally {
      clearInterval(heartbeat)
      // Capture final gap since the last heartbeat tick.
      const finalGap = performance.now() - lastTick
      if (finalGap > maxGapMs) maxGapMs = finalGap
      store.close()
    }

    process.stdout.write(
      `${JSON.stringify({ id: args.id, posts: args.posts, retries, maxGapMs, errors })}\n`,
    )
    if (errors.length > 0) process.exitCode = 1
    return
  }

  throw new Error(`unknown mode: ${String((args as { mode?: unknown }).mode)}`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
