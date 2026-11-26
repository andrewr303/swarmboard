// Cross-process poster child for Mode 1 wake latency tests (HS-171).
// Opens a SharedFileTransport (with real FileHost or bare mode), waits for `{ go: true }`, posts `count`
// messages spaced by `gapMs` with an hrtime timestamp in each text, then closes cleanly.
import { dirname } from 'node:path'
import { localIdentity } from '../../../src/client/identity.ts'
import { SharedFileTransport } from '../../../src/client/transport-file.ts'
import { createFileHost } from '../../../src/host/file-host.ts'

interface PosterArgs {
  readonly db: string
  readonly channel: string
  readonly count: number
  readonly gapMs: number
  readonly useFileHost?: boolean
  readonly userId?: string
}

const args = JSON.parse(process.argv[2] ?? '{}') as PosterArgs
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const host =
  args.useFileHost === true
    ? createFileHost({
        target: { kind: 'file', db: args.db, dir: dirname(args.db), defaultDir: false },
        allowUnsafeFs: false,
        wake: { watch: true, safetyPollMs: 1500 },
        tick: 'off',
      })
    : undefined

const transport = new SharedFileTransport({
  path: args.db,
  identity: localIdentity({ userId: args.userId ?? 'poster', profiles: [], member: true }),
  ...(host !== undefined ? { host } : {}),
})

await transport.ready()

async function run(): Promise<void> {
  const posted: Array<{ readonly seq: number; readonly id: string; readonly t0Ns: string }> = []
  for (let i = 0; i < args.count; i++) {
    if (i > 0 && args.gapMs > 0) await sleep(args.gapMs)
    const t0Ns = process.hrtime.bigint().toString()
    const res = (await transport.call('post', {
      channel: args.channel,
      text: JSON.stringify({ seq: i, t0Ns }),
    })) as { message: { id: string } }
    posted.push({ seq: i, id: res.message.id, t0Ns })
  }
  await transport.close()
  process.send?.({ done: true, posted })
  setImmediate(() => process.exit(0))
}

process.on('message', (msg) => {
  if ((msg as { go?: boolean } | null)?.go) {
    run().catch((err) => {
      process.send?.({ error: String(err) })
      process.exit(1)
    })
  }
})

process.send?.({ ready: true, pid: process.pid })
