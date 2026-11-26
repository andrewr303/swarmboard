// A board opener in a process of its own, for the HOST-0 stage 2 [proc] and fault tests (HOST0_DESIGN 5,
// S2 harness). The parent spawns this file with one JSON argument and reads one JSON line from stdout:
//   {path, startAt?, busyTimeoutMs?, seedDefaultGrants?, killAtStep?, notifyBegin?, writer?, storeOnly?}
// It busy-waits until `startAt` (a shared wall-clock barrier), opens SqliteUnifiedStore recording the ladder
// steps it ran (`onSchemaStep`; it SIGKILLs itself at `killAtStep`) and counting its BEGIN IMMEDIATEs (with
// `notifyBegin`, a directory, it writes `<pid>-<n>.begin` there just before each one, synchronously, so the
// parent sees it even while this process blocks in the BEGIN), then builds a BoardService (unless
// `storeOnly`) and prints `{ok, steps, begins, boardInfo, error?}`. With `writer: ms` it instead appends
// one event about every millisecond for that long, and prints how many.
import * as fs from 'node:fs'
import { join } from 'node:path'
import { BoardService, normalizeError, SqliteUnifiedStore } from '../../../src/core/index.ts'

type Options = {
  path: string
  startAt?: number
  busyTimeoutMs?: number
  seedDefaultGrants?: boolean
  killAtStep?: number
  notifyBegin?: string
  writer?: number
  storeOnly?: boolean
}

const o = JSON.parse(process.argv[2] ?? '{}') as Options
const pause = new Int32Array(new SharedArrayBuffer(4))
if (o.startAt !== undefined) while (Date.now() < o.startAt) {}

const steps: number[] = []
let begins = 0
let store: SqliteUnifiedStore | null = null
let out: Record<string, unknown>
try {
  store = new SqliteUnifiedStore({
    path: o.path,
    ...(o.busyTimeoutMs !== undefined ? { busyTimeoutMs: o.busyTimeoutMs } : {}),
    testHooks: {
      onSchemaStep: (version) => {
        steps.push(version)
        if (version === o.killAtStep) process.kill(process.pid, 'SIGKILL')
      },
      onBeginImmediate: () => {
        begins += 1
        if (o.notifyBegin) fs.writeFileSync(join(o.notifyBegin, `${process.pid}-${begins}.begin`), '')
      },
    },
  })
  if (o.writer !== undefined) {
    const end = Date.now() + o.writer
    let appended = 0
    while (Date.now() < end) {
      store.appendEvent({ type: 'x.write', payload: { n: appended } })
      appended += 1
      Atomics.wait(pause, 0, 0, 1)
    }
    out = { ok: true, appended }
  } else {
    const board = o.storeOnly
      ? null
      : new BoardService(store, o.seedDefaultGrants !== undefined ? { seedDefaultGrants: o.seedDefaultGrants } : {})
    const id = store.identity()
    out = {
      ok: true,
      steps,
      begins,
      boardInfo: board ? board.boardInfo() : { boardId: id?.boardId ?? null, instanceId: id?.instanceId ?? null },
    }
  }
} catch (error) {
  const e = normalizeError(error)
  out = { ok: false, steps, begins, error: { status: e.status, code: e.code, message: e.message, raw: String(error) } }
}
try {
  store?.close()
} catch {
  // Reported above if it mattered.
}
console.log(JSON.stringify(out))
