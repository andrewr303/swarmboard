// HS-194 child: commits createTask in `work` and synchronously after that commit acquires BEGIN IMMEDIATE
// and holds it for `holdMs` (300 ms), so a parent's wake-up re-poll (~3 ms after commit) hits SQLITE_BUSY
// late in a long claimReadyTask wait (> 30 s default budget).
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../../src/core/public.ts'

interface ClaimLockerArgs {
  readonly db: string
  readonly channel: string
  readonly text: string
  readonly holdMs: number
  readonly userId?: string
}

const args = JSON.parse(process.argv[2] ?? '{}') as ClaimLockerArgs
const store = new SqliteUnifiedStore({ path: args.db })
const board = new BoardService(store)
const caller = createLocalCaller({ userId: args.userId ?? 'creator', handle: args.userId ?? 'creator', member: true })

let releasing = false
function cleanup(exitCode: number): void {
  if (releasing) return
  releasing = true
  try {
    if (store.db.isTransaction) store.db.exec('COMMIT')
  } catch {
    try {
      store.db.exec('ROLLBACK')
    } catch {
      // ignore
    }
  }
  try {
    store.close()
  } catch {
    // ignore
  }
  setImmediate(() => process.exit(exitCode))
}

process.on('message', (msg) => {
  if (!(msg as { go?: boolean } | null)?.go) return
  try {
    const commitAtNs = process.hrtime.bigint().toString()
    const created = board.tasks.createTask(caller, { channel: args.channel, text: args.text })
    // Synchronously take BEGIN IMMEDIATE immediately after createTask committed & flushed .wakeup.
    store.db.exec('BEGIN IMMEDIATE')
    process.send?.({ committed: true, taskId: created.task.id, commitAtNs })
    setTimeout(() => {
      try {
        store.db.exec('COMMIT')
      } catch {
        // ignore
      }
      process.send?.({ released: true })
      cleanup(0)
    }, Math.max(1, args.holdMs))
  } catch (err) {
    process.send?.({ error: String(err) })
    cleanup(1)
  }
})

process.on('disconnect', () => cleanup(0))
process.send?.({ ready: true, pid: process.pid })
