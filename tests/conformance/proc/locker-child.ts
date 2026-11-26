// Raw SQLite BEGIN IMMEDIATE locker child for Mode 1 busy & lane tests (HS-163..HS-169, HS-172).
// Acquires BEGIN IMMEDIATE on `db`, signals `{ held: true }` over IPC (and prints `held` if non-IPC),
// holds the lock for `holdMs` (or until `{ release: true }`), then commits and exits 0.
import { DatabaseSync } from 'node:sqlite'

interface LockerArgs {
  readonly db: string
  readonly holdMs: number
}

const args = JSON.parse(process.argv[2] ?? '{}') as LockerArgs
const db = new DatabaseSync(args.db, { timeout: 10_000 })
db.exec('BEGIN IMMEDIATE')

let done = false
const finish = (): void => {
  if (done) return
  done = true
  clearTimeout(timer)
  try {
    db.exec('COMMIT')
  } catch {
    try {
      db.exec('ROLLBACK')
    } catch {
      // ignore
    }
  }
  try {
    db.close()
  } catch {
    // ignore
  }
  if (process.send) {
    process.send({ released: true })
    setImmediate(() => process.exit(0))
  } else {
    process.exit(0)
  }
}

const timer = setTimeout(finish, Math.max(1, args.holdMs))

process.on('message', (msg) => {
  if ((msg as { release?: boolean } | null)?.release) {
    finish()
  }
})
process.on('disconnect', finish)

if (process.send) {
  process.send({ held: true, pid: process.pid })
} else {
  process.stdout.write('held\n')
}
