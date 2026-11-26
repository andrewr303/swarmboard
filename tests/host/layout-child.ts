// One process opening a board through the layout (HOST123_DESIGN B2), for layout-proc.test.ts. The parent forks
// this file with one JSON argument and reads one JSON line from stdout.
//   {db, barrier?, hook?, umask?, repo?, clock?, afterTmpWritePause?: {ready, go}, holdLock?: {ready, ms}}
// - barrier: a path; the child waits for it to exist before opening (a shared start for N children).
// - hook: 'beforeManifest' | 'afterTmpWrite': the child exits with code 9 at that crash point.
// - umask: set before anything is created (process.umask works in a child's main thread).
// - repo: a git repository to create (mkdir under the umask, plus .git); the board is then the default one there,
//   resolved by resolveBoard, and `db` is ignored.
// - clock: ISO timestamp returned by `opts.clock`.
// - afterTmpWritePause: writes `ready`, then blocks until `go` exists before continuing to `linkSync`.
// - holdLock: holds PRAGMA locking_mode=EXCLUSIVE on `db` for `ms` ms after touching `ready`, then commits & exits.
import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { processContext, resolveBoard, type BoardTarget } from '../../src/client/resolve.ts'
import { openBoard } from '../../src/host/layout.ts'

const args = JSON.parse(process.argv[2] ?? '{}') as {
  db?: string
  barrier?: string
  hook?: 'beforeManifest' | 'afterTmpWrite'
  umask?: number
  repo?: string
  clock?: string
  afterTmpWritePause?: { ready: string; go: string }
  holdLock?: { ready: string; ms: number }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4))
function waitForFile(path: string, label: string): void {
  const deadline = Date.now() + 60_000
  while (!fs.existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${label} never opened`)
    Atomics.wait(sleeper, 0, 0, 2)
  }
}

if (args.holdLock) {
  const db = new DatabaseSync(args.db!)
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE')
    db.exec('BEGIN IMMEDIATE')
    db.exec("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('_test_lock', '1')")
    fs.writeFileSync(args.holdLock.ready, '')
    Atomics.wait(sleeper, 0, 0, args.holdLock.ms)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  process.stdout.write(`${JSON.stringify({ locked: true })}\n`)
  process.exit(0)
}

if (args.umask !== undefined) process.umask(args.umask)
if (args.barrier) waitForFile(args.barrier, 'the start barrier')

let target: Extract<BoardTarget, { kind: 'file' }>
if (args.repo) {
  fs.mkdirSync(args.repo, { recursive: true })
  fs.mkdirSync(join(args.repo, '.git'))
  const res = resolveBoard({}, processContext({ cwd: args.repo, env: {}, home: args.repo }))
  if (res.target.kind !== 'file') throw new Error('expected a file board')
  target = res.target
} else {
  const db = args.db!
  target = { kind: 'file', db, dir: dirname(db), defaultDir: false }
}

const crash = (): never => process.exit(9)
const afterTmpWrite = args.hook === 'afterTmpWrite'
  ? crash
  : args.afterTmpWritePause
    ? () => {
        fs.writeFileSync(args.afterTmpWritePause!.ready, '')
        waitForFile(args.afterTmpWritePause!.go, 'the afterTmpWrite go signal')
      }
    : undefined

const opened = openBoard(target, {
  ...(args.clock ? { clock: () => new Date(args.clock!) } : {}),
  testHooks: {
    ...(args.hook === 'beforeManifest' ? { beforeManifest: crash } : {}),
    ...(afterTmpWrite ? { afterTmpWrite } : {}),
  },
})
const modes: Record<string, number> = {}
for (const p of [opened.paths!.dir, opened.paths!.db, opened.paths!.wal, opened.paths!.shm, opened.paths!.wakeup, opened.paths!.jsonl, opened.paths!.manifest]) {
  modes[p] = fs.statSync(p).mode & 0o777
}
const out = {
  boardId: opened.board.boardInfo().boardId,
  created: opened.created,
  db: opened.paths!.db,
  manifestCreatedAt: opened.manifest?.createdAt ?? null,
  manifestIno: fs.statSync(opened.paths!.manifest, { bigint: true }).ino.toString(),
  modes,
  warnings: opened.warnings.map((w) => ({ note: w.note, value: w.value ?? null })),
}
opened.close()
process.stdout.write(`${JSON.stringify(out)}\n`)
