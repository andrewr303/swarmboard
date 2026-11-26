// A board in a process of its own, for the multi-process acceptance tests (M2_DESIGN 2.11 [proc]).
// The parent forks this file with one JSON argument, {path}, and drives it over the IPC channel: each
// message {id, op, ...} gets one reply {id, ok, value} or {id, ok: false, error: {status, code, message}}.
// It opens its own connection to the same WAL file, on its own clock, and counts its BEGIN IMMEDIATEs.
import {
  BoardService,
  createLocalCaller,
  normalizeError,
  SqliteUnifiedStore,
  type CallerContext,
} from '../../../../src/core/index.ts'
import { candidateQuery, parseClaimReady, probe } from '../../../../src/core/tasks/claim-ready.ts'

type Request = { id: number; op: string; [key: string]: unknown }
type Failure = { status: number; code: string; message: string }

const options = JSON.parse(process.argv[2] ?? '{}') as { path: string; busyTimeoutMs?: number; beginDelayMs?: number }
const pauseBlock = new Int32Array(new SharedArrayBuffer(4))

let begins = 0
let crashBeforeCommit = false
const store = new SqliteUnifiedStore({
  path: options.path,
  ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}),
  testHooks: {
    onBeginImmediate: () => {
      begins++
      // AT-17: holds a sweeper back before each chunk's BEGIN IMMEDIATE, so a renew in another process
      // lands between its select and its chunk.
      if (options.beginDelayMs) Atomics.wait(pauseBlock, 0, 0, options.beginDelayMs)
    },
    // AT-37: dies the way a power cut or an OOM kill does, with the write's statements run and no COMMIT.
    beforeCommit: () => {
      if (crashBeforeCommit) process.kill(process.pid, 'SIGKILL')
    },
  },
})
const clock: { fixed: number | null; offset: number } = { fixed: null, offset: 0 }
const board = new BoardService(store, { now: () => clock.fixed ?? Date.now() + clock.offset })

const callers = new Map<string, CallerContext>()
function callerOf(name: string): CallerContext {
  let caller = callers.get(name)
  if (!caller) {
    // `alice` is the board's owner; `alice+w1` one of her profiles; any other name a member of its own.
    const [user = name, profile = null] = name.split('+')
    caller =
      user === 'alice'
        ? createLocalCaller({ userId: 'alice', handle: 'alice', owner: true, profile })
        : createLocalCaller({ userId: user, handle: user, profile })
    callers.set(name, caller)
  }
  return caller
}

const failure = (error: unknown): Failure => {
  const e = normalizeError(error)
  return { status: e.status, code: e.code, message: e.message }
}

/** Runs `fn`, retrying a 503 (busy past busy_timeout) the way a client is told to. */
async function retrying<T>(fn: () => T | Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt < 20 && normalizeError(error).status === 503) {
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20))
        continue
      }
      throw error
    }
  }
}

type TaskMethod = (caller: CallerContext, ...args: unknown[]) => unknown
const method = (name: string): TaskMethod => {
  const fn = (board.tasks as unknown as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`no task method ${name}`)
  return (fn as TaskMethod).bind(board.tasks)
}

let held: { end(): void } | null = null

async function handle(m: Request): Promise<unknown> {
  switch (m.op) {
    case 'call': {
      const args = (m.args as unknown[] | undefined) ?? []
      const fn = method(String(m.method))
      return m.retry ? await retrying(() => fn(callerOf(String(m.caller)), ...args)) : await fn(callerOf(String(m.caller)), ...args)
    }
    case 'clock':
      clock.fixed = (m.fixed as number | null | undefined) ?? null
      clock.offset = (m.offset as number | undefined) ?? 0
      return null
    case 'armCrash':
      crashBeforeCommit = true
      return null
    case 'begins': {
      const n = begins
      if (m.reset) begins = 0
      return n
    }
    case 'expire': {
      const run = await retrying(() => board.tasks.expireDueClaims(m.now as number | undefined, (m.opts as { limit?: number; chunk?: number }) ?? {}))
      return { expired: run.expired, failed: run.failed.map((f) => ({ task: f.task, error: failure(f.error) })) }
    }
    case 'drain': {
      // AT-12: claim next and complete, until nothing is left to claim.
      const caller = callerOf(String(m.caller))
      const body = m.body as Record<string, unknown>
      const done: Array<[string, number]> = []
      for (;;) {
        const next = await retrying(() => board.tasks.claimReady(caller, body))
        if (!next.task) return done
        const claim = next.claim
        await retrying(() => board.tasks.completeTask(caller, next.task.id, { epoch: claim.epoch, token: claim.token }))
        done.push([next.task.id, claim.epoch])
      }
    }
    case 'renewEach': {
      // AT-17: renews each held claim once; what each answered.
      const caller = callerOf(String(m.caller))
      const out: Array<[string, number, string]> = []
      for (const [id, epoch, token] of m.claims as Array<[string, number, string]>) {
        try {
          await retrying(() => board.tasks.renewTask(caller, id, { epoch, token, lease: (m.lease as number | undefined) ?? 30 }))
          out.push([id, epoch, 'renewed'])
        } catch (error) {
          out.push([id, epoch, failure(error).code])
        }
      }
      return out
    }
    case 'holdRead': {
      // AT-25: a claim-next pre-probe that keeps its read transaction open.
      const caller = callerOf(String(m.caller))
      const { identity, access } = board.tasks.host.admit(caller)
      const q = candidateQuery(board.tasks.host, identity, access, parseClaimReady(m.body))
      if (!q) throw new Error('no scope to probe')
      store.db.exec('BEGIN')
      const found = probe(store.db, q, Date.now())
      held = { end: () => store.db.exec('COMMIT') }
      return found
    }
    case 'endRead':
      held?.end()
      held = null
      return null
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
    (error: unknown) => process.send?.({ id: m.id, ok: false, error: failure(error) }),
  )
})
process.send?.({ ready: true, pid: process.pid })
