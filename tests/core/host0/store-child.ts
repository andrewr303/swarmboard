// A store in a process of its own, for the HOST-0 stage 1 multi-process tests (HT-09, HT-18, HT-21,
// HT-26..HT-28). The parent forks this file with one JSON argument, {path, busyTimeoutMs?}, and drives it
// over the IPC channel: each message {id, op, ...} gets one reply {id, ok, value} or
// {id, ok: false, error: {status, code, message}}. The parent has created the board file already.
import {
  BoardService,
  createLocalCaller,
  normalizeError,
  SqliteUnifiedStore,
} from '../../../src/core/index.ts'

type Request = { id: number; op: string; [key: string]: unknown }

const options = JSON.parse(process.argv[2] ?? '{}') as { path: string; busyTimeoutMs?: number }
let crashAfterCommit = false
const store = new SqliteUnifiedStore({
  path: options.path,
  ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}),
  testHooks: {
    // Dies the way a power cut does between COMMIT and the sidecars.
    afterCommit: () => {
      if (crashAfterCommit) process.kill(process.pid, 'SIGKILL')
    },
  },
})
const heard: number[] = []
store.onEvent((e) => heard.push(e.index))
let board: BoardService | null = null
const owner = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `fn`, retrying a 503 (busy past busy_timeout) the way a client is told to. */
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
    case 'append': {
      for (let i = 0; i < (m.n as number); i++) {
        await retrying(() => store.appendEvent({ type: 'x', payload: { tag: m.tag ?? process.pid, i } }))
      }
      return store.getHeadIndex()
    }
    case 'crashAppend':
      crashAfterCommit = true
      store.appendEvent({ type: 'x', payload: { tag: m.tag ?? 'crash' } })
      return null
    case 'arm':
      return store.armExternalDispatch()
    case 'pump':
      return store.pumpExternal(m.limit as number | undefined)
    case 'heard':
      return heard
    case 'post': {
      board ??= new BoardService(store)
      const posted = await retrying(() => board!.postMessage(owner, { channel: 'dev', text: String(m.text) }))
      return posted.message.id
    }
    case 'getMeta':
      return store.getMeta(String(m.key)) ?? null
    case 'casMeta':
      return await retrying(() => store.casMeta(String(m.key), (m.expected as string | null) ?? undefined, String(m.next)))
    case 'casIncrement': {
      let successes = 0
      for (let i = 0; i < (m.rounds as number); i++) {
        for (;;) {
          const cur = store.getMeta(String(m.key))
          const next = String(Number(cur ?? '0') + 1)
          if (await retrying(() => store.casMeta(String(m.key), cur, next))) {
            successes += 1
            break
          }
        }
      }
      return successes
    }
    case 'hold': {
      // Takes the write lock now, answers, and rolls back after `ms`.
      store.db.exec('BEGIN IMMEDIATE')
      setTimeout(() => store.db.exec('ROLLBACK'), m.ms as number)
      return { held: true }
    }
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
