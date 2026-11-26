// IPC child process for HOST123_DESIGN Stage B8 multi-process Ticker tests (HS-153..HS-155).
// Supports:
//   mode 'loop': starts a Ticker with an optional 8-byte LE virtual clock file, forwards each TickReport
//                over IPC, and handles IPC commands {id, op: 'stop' | 'status' | 'exit'}.
//   mode 'once': runs a single Ticker.runOnce() + Ticker.stop(), counting BEGIN IMMEDIATE calls,
//                prints JSON result to stdout (and IPC if connected), and exits 0.
import * as fs from 'node:fs'
import { BoardService, SqliteUnifiedStore } from '../../../src/core/public.ts'
import { Ticker, type TickReport } from '../../../src/host/tick.ts'

interface ChildConfig {
  mode: 'loop' | 'once'
  path: string
  clockFile?: string
  intervalMs?: number
  ttlMs?: number
  jitter?: number
}

const config = JSON.parse(process.argv[2] ?? '{}') as ChildConfig

const clockFd = config.clockFile ? fs.openSync(config.clockFile, 'r') : null
const clockBuf = Buffer.alloc(8)
const now = (): number => {
  if (clockFd === null) return Date.now()
  const n = fs.readSync(clockFd, clockBuf, 0, 8, 0)
  if (n !== 8) throw new Error(`short virtual clock read: ${n}`)
  return Number(clockBuf.readBigInt64LE(0))
}

let begins = 0
const store = new SqliteUnifiedStore({
  path: config.path,
  testHooks: {
    onBeginImmediate: () => {
      begins += 1
    },
  },
})
const board = new BoardService(store, { now })

if (config.mode === 'once') {
  // Reset counter after BoardService construction/seeding so only the tick run itself is measured.
  begins = 0
  const ticker = new Ticker(board, {
    intervalMs: config.intervalMs,
    ttlMs: config.ttlMs,
    jitter: config.jitter,
    now,
  })
  const report = ticker.runOnce()
  const runBegins = begins
  ticker.stop()
  const status = ticker.status()
  store.close()
  if (clockFd !== null) fs.closeSync(clockFd)
  process.stdout.write(JSON.stringify({ pid: process.pid, holder: ticker.holder, report, begins: runBegins, status }) + '\n')
  process.exit(0)
}

const ticker = new Ticker(board, {
  intervalMs: config.intervalMs,
  ttlMs: config.ttlMs,
  jitter: config.jitter,
  now,
  onReport: (report: TickReport) => {
    if (process.connected) {
      process.send?.({ type: 'report', pid: process.pid, holder: ticker.holder, report })
    }
  },
})

// Keep the process alive while IPC is open even though Ticker timers are unref()'d.
const keepAlive = setInterval(() => {}, 60_000)

type Request = { id: number; op: 'start' | 'stop' | 'status' | 'exit' }

process.on('message', (raw) => {
  const m = raw as Request
  try {
    switch (m.op) {
      case 'start':
        ticker.start()
        process.send?.({ id: m.id, ok: true, value: ticker.status() })
        break
      case 'stop':
        ticker.stop()
        process.send?.({ id: m.id, ok: true, value: ticker.status() })
        break
      case 'status':
        process.send?.({ id: m.id, ok: true, value: ticker.status() })
        break
      case 'exit':
        ticker.stop()
        clearInterval(keepAlive)
        store.close()
        if (clockFd !== null) fs.closeSync(clockFd)
        process.send?.({ id: m.id, ok: true, value: null })
        setImmediate(() => process.exit(0))
        break
      default:
        process.send?.({ id: m.id, ok: false, error: `unknown op ${String((m as { op?: unknown }).op)}` })
    }
  } catch (error) {
    process.send?.({ id: m.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

ticker.start()
process.send?.({ type: 'ready', pid: process.pid, holder: ticker.holder })
