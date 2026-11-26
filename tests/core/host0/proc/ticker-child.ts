// A ticker in a process of its own, for HOST-0 stage 3 (HT-78, HT-92 to HT-94). The parent forks this file with
// one JSON argument, {path, gate?: {ready, go}}, and drives it over IPC: each message {id, op, ...} gets one
// reply {id, ok, value} or {id, ok: false, error: {status, code, message}}.
//   tick nowMs                         -> runDueSchedules(nowMs), as {sent: threads[], failed, skipped}
//   acquire holder ttlMs nowMs [start] -> acquireTickLease; with `start`, waits for that file first
//   arm what                           -> 'gate': the next outermost BEGIN IMMEDIATE writes `ready` (the pid), then
//                                         blocks until `go` exists; 'crash': SIGKILL in the next beforeCommit
// The event loop is blocked while gated, so the parent watches files, not IPC.
import * as fs from 'node:fs'
import { BoardService, normalizeError, SqliteUnifiedStore } from '../../../../src/core/index.ts'
import { acquireTickLease } from '../../../../src/core/tick-lease.ts'

type Request = { id: number; op: string; [key: string]: unknown }

const options = JSON.parse(process.argv[2] ?? '{}') as { path: string; gate?: { ready: string; go: string } }
let gateArmed = false
let crashArmed = false

function blockUntil(file: string, timeoutMs: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`)
    Atomics.wait(cell, 0, 0, 2)
  }
}

const store = new SqliteUnifiedStore({
  path: options.path,
  testHooks: {
    onBeginImmediate: () => {
      if (!gateArmed || !options.gate) return
      gateArmed = false
      fs.writeFileSync(options.gate.ready, String(process.pid))
      blockUntil(options.gate.go, 10_000)
    },
    beforeCommit: () => {
      if (crashArmed) process.kill(process.pid, 'SIGKILL')
    },
  },
})
const board = new BoardService(store)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function retrying<T>(fn: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn()
    } catch (error) {
      if (attempt < 50 && normalizeError(error).status === 503) {
        await sleep(5 + Math.random() * 20)
        continue
      }
      throw error
    }
  }
}

async function handle(m: Request): Promise<unknown> {
  switch (m.op) {
    case 'tick': {
      const run = await retrying(() => board.runDueSchedules(m.nowMs as number))
      return { sent: run.sent.map((x) => x.thread), failed: run.failed.length, skipped: run.skipped, stopped: run.stopped }
    }
    case 'acquire': {
      if (typeof m.start === 'string') blockUntil(m.start, 20_000)
      return await retrying(() =>
        acquireTickLease(store, { holder: String(m.holder), ttlMs: m.ttlMs as number, now: () => m.nowMs as number }),
      )
    }
    case 'arm':
      if (m.what === 'gate') gateArmed = true
      else crashArmed = true
      return true
    case 'exit':
      store.close()
      setImmediate(() => process.exit(0))
      return null
    default:
      throw new Error(`unknown op ${m.op}`)
  }
}

process.on('message', (raw) => {
  const m = raw as Request
  handle(m).then(
    (value) => process.send?.({ id: m.id, ok: true, value }),
    (error: unknown) => {
      const e = normalizeError(error)
      process.send?.({ id: m.id, ok: false, error: { status: e.status, code: e.code, message: e.message } })
    },
  )
})
process.send?.({ ready: true, pid: process.pid })
