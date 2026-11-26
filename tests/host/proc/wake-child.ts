// IPC child for HOST123_DESIGN Stage B7 multi-process WakeBridge tests (HS-123, HS-129..HS-131, HS-133, HS-134).
// Forked with one JSON argument describing the mode and store/bridge options:
// - mode: 'idleExit' -> opens store, starts WakeBridge, does nothing else (proves HS-134: exits on its own with code 0)
// - default (IPC) -> opens store (counting dbOpens), optionally builds & starts WakeBridge and BoardService with
//   bridge.serviceOptions(), and handles IPC requests {id, op, ...}:
//   post | postSlow | wait | claimReady | createTask | status | exit.
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../../src/core/public.ts'
import { withBusyRetry } from '../../../src/client/busy.ts'
import { normalizeThrown } from '../../../src/client/normalize.ts'
import { WakeBridge } from '../../../src/host/wake-bridge.ts'

interface ChildArgs {
  path: string
  mode?: 'ipc' | 'idleExit'
  bridge?: boolean
  safetyPollMs?: number
  watch?: boolean
  pageSize?: number
  userId?: string
}

type Request = { id: number; op: string; [key: string]: unknown }

const args = JSON.parse(process.argv[2] ?? '{}') as ChildArgs
const caller = createLocalCaller({
  userId: args.userId ?? 'worker',
  handle: args.userId ?? 'worker',
  owner: true,
})

let dbOpens = 0
function openStore(path: string): SqliteUnifiedStore {
  dbOpens += 1
  return new SqliteUnifiedStore({ path })
}

if (args.mode === 'idleExit') {
  const store = openStore(args.path)
  const bridge = new WakeBridge(store, {
    ...(args.safetyPollMs !== undefined ? { safetyPollMs: args.safetyPollMs } : {}),
    ...(args.watch !== undefined ? { watch: args.watch } : {}),
  })
  bridge.start()
  // Do nothing else: Node must exit naturally with code 0 (watcher and poll timer are unref'd).
} else {
  const store = openStore(args.path)
  const useBridge = args.bridge !== false
  const bridge = useBridge
    ? new WakeBridge(store, {
        ...(args.safetyPollMs !== undefined ? { safetyPollMs: args.safetyPollMs } : {}),
        ...(args.watch !== undefined ? { watch: args.watch } : {}),
        ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
      })
    : null
  const board = new BoardService(store, bridge ? bridge.serviceOptions() : {})
  bridge?.start()

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  async function handle(m: Request): Promise<unknown> {
    switch (m.op) {
      case 'post': {
        const channel = String(m.channel ?? 'dev')
        const text = String(m.text ?? '')
        let t0 = ''
        const posted = await withBusyRetry(() => {
          t0 = process.hrtime.bigint().toString()
          return board.postMessage(caller, { channel, text })
        })
        return { id: posted.message.id, t0 }
      }
      case 'postSlow': {
        const channel = String(m.channel ?? 'dev')
        const count = Number(m.count ?? 1)
        const minGapMs = Number(m.minGapMs ?? 0)
        const maxGapMs = Number(m.maxGapMs ?? 0)
        const tag = String(m.tag ?? 'w')
        const ids: string[] = []
        for (let i = 0; i < count; i++) {
          if (maxGapMs > 0) {
            const gap = minGapMs + Math.floor(Math.random() * (maxGapMs - minGapMs + 1))
            if (gap > 0) await sleep(gap)
          }
          const posted = await withBusyRetry(() => {
            const t0 = process.hrtime.bigint().toString()
            return board.postMessage(caller, {
              channel,
              text: JSON.stringify({ tag, seq: i, t0 }),
            })
          })
          ids.push(posted.message.id)
        }
        return { count: ids.length, ids }
      }
      case 'wait': {
        const after = m.after !== undefined ? String(m.after) : String(store.getHeadIndex())
        const wait = Number(m.wait ?? 5)
        const page = await board.getEvents(caller, { after, wait })
        return { events: page.events.length, cursor: page.cursor }
      }
      case 'claimReady': {
        const channel = String(m.channel ?? 'jobs')
        const wait = Number(m.wait ?? 5)
        const claimed = await board.tasks.claimReady(caller, { channel, wait })
        return { taskId: claimed.task?.id ?? null }
      }
      case 'createTask': {
        const channel = String(m.channel ?? 'jobs')
        const text = String(m.text ?? 'task')
        const created = await withBusyRetry(() => board.tasks.createTask(caller, { channel, text }))
        return { taskId: created.task.id }
      }
      case 'status': {
        const st = bridge?.status() ?? null
        return {
          dbOpens,
          bridge: st
            ? {
                ...st,
                stopped: st.stopped
                  ? {
                      reason: st.stopped.reason,
                      error: st.stopped.error
                        ? {
                            status: st.stopped.error.status,
                            code: st.stopped.error.code,
                            message: st.stopped.error.message,
                            details: st.stopped.error.details,
                            retryAfter: st.stopped.error.retryAfter,
                          }
                        : null,
                    }
                  : null,
              }
            : null,
        }
      }
      case 'exit': {
        bridge?.stop()
        store.close()
        setImmediate(() => process.exit(0))
        return null
      }
      default:
        throw new Error(`unknown op ${m.op}`)
    }
  }

  process.on('message', (raw) => {
    const m = raw as Request
    handle(m).then(
      (value) => process.send?.({ id: m.id, ok: true, value }),
      (error: unknown) => {
        const e = normalizeThrown(error)
        process.send?.({ id: m.id, ok: false, error: { status: e.status, code: e.code, message: e.message } })
      },
    )
  })
  process.send?.({ ready: true, pid: process.pid })
}
