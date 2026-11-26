// Fault-injection crash child (HS-179, HS-180): opens SharedFileTransport with `testHooks.afterCommit`
// sending SIGKILL to itself, then issues one keyed op (`post` or `createTask`). Exits via SIGKILL with
// empty stdout immediately after SQLite COMMIT.
import { dirname } from 'node:path'
import { localIdentity } from '../../../src/client/identity.ts'
import type { OpName } from '../../../src/client/ops.ts'
import { SharedFileTransport } from '../../../src/client/transport-file.ts'
import { createFileHost } from '../../../src/host/file-host.ts'

interface CrashArgs {
  readonly db: string
  readonly op: OpName
  readonly input: Record<string, unknown>
  readonly idempotencyKey: string
  readonly userId?: string
  readonly profile?: string | null
  readonly useFileHost?: boolean
}

const args = JSON.parse(process.argv[2] ?? '{}') as CrashArgs

const host =
  args.useFileHost === true
    ? createFileHost({
        target: { kind: 'file', db: args.db, dir: dirname(args.db), defaultDir: false },
        allowUnsafeFs: false,
        wake: { watch: true, safetyPollMs: 1500 },
        tick: 'off',
      })
    : undefined

const profile = args.profile ?? null
const transport = new SharedFileTransport({
  path: args.db,
  identity: localIdentity({
    userId: args.userId ?? 'ada',
    profiles: profile !== null ? [profile] : [],
    defaultProfile: profile,
    member: true,
  }),
  ...(host !== undefined ? { host } : {}),
  testStoreOptions: {
    testHooks: {
      afterCommit: () => {
        process.kill(process.pid, 'SIGKILL')
      },
    },
  },
})

await transport.ready()
await transport.call(args.op, args.input as never, {
  idempotencyKey: args.idempotencyKey,
  ...(profile !== null ? { as: profile } : {}),
})
await transport.close()
