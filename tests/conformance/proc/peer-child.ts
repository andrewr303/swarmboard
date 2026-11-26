// Cross-process peer child for Mode 1 conformance & stress tests (HOST123_DESIGN 8 Stage B9).
// Communicates over Node IPC (`fork(..., { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })`).
// Supports multiple identities on one SharedFileTransport process registry, `call`, `ready`,
// `crash-after-commit`, raw `hold(ms)` (BEGIN IMMEDIATE), `tight-post`, `keyed-posts`,
// `wait-feed`, `claim-loop`, and clean `close`.
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type IdentitySpec } from '../../../src/client/conformance.ts'
import { isBoardError } from '../../../src/client/errors.ts'
import { normalizeThrown } from '../../../src/client/normalize.ts'
import type { OpName } from '../../../src/client/ops.ts'
import { SharedFileTransport, type FileHost } from '../../../src/client/transport-file.ts'
import type { CallOptions } from '../../../src/client/types.ts'
import { createFileHost } from '../../../src/host/file-host.ts'
import { providerFor } from '../fixtures.ts'

export interface PeerChildInit {
  readonly db: string
  readonly ids: Record<string, IdentitySpec>
  readonly defaultAs: string
  readonly host: 'real' | 'none'
  readonly busyTimeoutMs?: number
  readonly busyBudgetMs?: number
  readonly laneMax?: number
  readonly safetyPollMs?: number
}

type Msg =
  | { id: number; kind: 'ready'; as?: string }
  | { id: number; kind: 'call'; as?: string; op: OpName; input: unknown; opts?: Omit<CallOptions, 'signal'> }
  | { id: number; kind: 'crash-after-commit' }
  | { id: number; kind: 'hold'; ms: number }
  | { id: number; kind: 'tight-post'; as?: string; channel: string; count: number; prefix: string }
  | {
      id: number
      kind: 'keyed-posts'
      db?: string
      as?: string
      channel: string
      items: ReadonlyArray<{ readonly key: string; readonly text: string }>
      crashAfterIndex?: number
      crashKillIndex?: number
    }
  | {
      id: number
      kind: 'multi-keyed-posts'
      dbs: readonly string[]
      as?: string
      channel: string
      itemsByBoard: ReadonlyArray<ReadonlyArray<{ readonly key: string; readonly text: string }>>
      crashAfter?: { readonly board: number; readonly index: number }
      crashKill?: { readonly board: number; readonly index: number }
    }
  | { id: number; kind: 'start-feed'; as?: string; channel: string; after?: string }
  | { id: number; kind: 'stop-feed' }
  | { id: number; kind: 'claim-loop'; as?: string; channel: string }
  | { id: number; kind: 'stats'; as?: string }
  | { id: number; kind: 'close' }

const init = JSON.parse(process.argv[2] ?? '{}') as PeerChildInit

let crashArmed = false
const transports = new Map<string, SharedFileTransport>()
const holdTimers = new Set<ReturnType<typeof setTimeout>>()
const holdDbs = new Set<DatabaseSync>()

let feedAbort: AbortController | null = null
let feedDone: Promise<{ readonly seen: string[]; readonly lastCursor: string; readonly dupes: number }> | null = null

function makeHost(dbPath: string): FileHost | undefined {
  if (init.host !== 'real') return undefined
  return createFileHost({
    target: { kind: 'file', db: dbPath, dir: dirname(dbPath), defaultDir: false },
    allowUnsafeFs: false,
    wake: { watch: true, safetyPollMs: init.safetyPollMs ?? 1500 },
    tick: 'off',
  })
}

function getTransport(asName?: string, dbOverride?: string): SharedFileTransport {
  const name = asName ?? init.defaultAs
  const dbPath = dbOverride ?? init.db
  const cacheKey = `${dbPath}\u0000${name}`
  let t = transports.get(cacheKey)
  if (t !== undefined) return t
  const spec = init.ids[name]
  if (spec === undefined) {
    throw new Error(`peer-child: unknown identity ${name}`)
  }
  const host = makeHost(dbPath)
  t = new SharedFileTransport({
    path: dbPath,
    identity: providerFor(spec),
    ...(host !== undefined ? { host } : {}),
    ...(init.busyTimeoutMs !== undefined ? { busyTimeoutMs: init.busyTimeoutMs } : {}),
    ...(init.busyBudgetMs !== undefined ? { busyBudgetMs: init.busyBudgetMs } : {}),
    ...(init.laneMax !== undefined ? { laneMax: init.laneMax } : {}),
    testStoreOptions: {
      testHooks: {
        afterCommit: () => {
          if (crashArmed) {
            process.kill(process.pid, 'SIGKILL')
          }
        },
      },
    },
  })
  transports.set(cacheKey, t)
  return t
}

function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) {
    return { __cbBytes: Buffer.from(v).toString('base64') }
  }
  if (Array.isArray(v)) return v.map(encodeValue)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = encodeValue(val)
    }
    return out
  }
  return v
}

function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue)
  if (v !== null && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    if (typeof rec['__cbBytes'] === 'string' && Object.keys(rec).length === 1) {
      return new Uint8Array(Buffer.from(rec['__cbBytes'], 'base64'))
    }
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(rec)) {
      out[k] = decodeValue(val)
    }
    return out
  }
  return v
}

function releaseHold(db: DatabaseSync): void {
  if (!holdDbs.delete(db)) return
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
}

async function handle(m: Msg): Promise<unknown> {
  switch (m.kind) {
    case 'ready': {
      const caps = await getTransport(m.as).ready()
      return caps
    }
    case 'call': {
      const t = getTransport(m.as)
      const res = await t.call(m.op, decodeValue(m.input) as never, m.opts)
      return encodeValue(res)
    }
    case 'crash-after-commit': {
      // Ensure store is opened with our afterCommit hook before arming.
      await getTransport().ready()
      crashArmed = true
      return true
    }
    case 'hold': {
      const db = new DatabaseSync(init.db, { timeout: 10_000 })
      holdDbs.add(db)
      db.exec('BEGIN IMMEDIATE')
      const timer = setTimeout(() => {
        holdTimers.delete(timer)
        releaseHold(db)
      }, Math.max(1, m.ms))
      holdTimers.add(timer)
      return { held: true }
    }
    case 'tight-post': {
      const t = getTransport(m.as)
      await t.ready()
      let maxLagMs = 0
      let expected = performance.now() + 10
      const interval = setInterval(() => {
        const now = performance.now()
        const lag = Math.max(0, now - expected)
        if (lag > maxLagMs) maxLagMs = lag
        expected = now + 10
      }, 10)
      try {
        for (let i = 0; i < m.count; i++) {
          await t.call('post', { channel: m.channel, text: `${m.prefix}-${i}` })
        }
      } finally {
        clearInterval(interval)
      }
      return { posted: m.count, maxLagMs, stats: t.stats() }
    }
    case 'keyed-posts': {
      const t = getTransport(m.as, m.db)
      await t.ready()
      const ids: string[] = []
      for (let i = 0; i < m.items.length; i++) {
        const item = m.items[i]!
        if (m.crashKillIndex === i) {
          process.kill(process.pid, 'SIGKILL')
        }
        if (m.crashAfterIndex === i) {
          crashArmed = true
        }
        const res = (await t.call(
          'post',
          { channel: m.channel, text: item.text },
          { idempotencyKey: item.key },
        )) as { message: { id: string } }
        ids.push(res.message.id)
      }
      return { ids }
    }
    case 'multi-keyed-posts': {
      const ts = m.dbs.map((dbPath) => getTransport(m.as, dbPath))
      await Promise.all(ts.map((t) => t.ready()))
      const idsByBoard: string[][] = m.dbs.map(() => [])
      await Promise.all(
        ts.map(async (t, bIdx) => {
          const items = m.itemsByBoard[bIdx]!
          for (let i = 0; i < items.length; i++) {
            const item = items[i]!
            if (m.crashKill?.board === bIdx && m.crashKill.index === i) {
              process.kill(process.pid, 'SIGKILL')
            }
            if (m.crashAfter?.board === bIdx && m.crashAfter.index === i) {
              crashArmed = true
            }
            const res = (await t.call(
              'post',
              { channel: m.channel, text: item.text },
              { idempotencyKey: item.key },
            )) as { message: { id: string } }
            idsByBoard[bIdx]!.push(res.message.id)
          }
        }),
      )
      return { idsByBoard }
    }
    case 'start-feed': {
      const t = getTransport(m.as)
      await t.ready()
      const ac = new AbortController()
      feedAbort = ac
      const seen: string[] = []
      const seenIdx = new Set<string>()
      let dupes = 0
      let lastCursor = m.after ?? '0'
      feedDone = (async () => {
        for await (const page of t.events(
          { channel: m.channel, ...(m.after !== undefined ? { after: m.after } : {}) },
          { signal: ac.signal },
        )) {
          lastCursor = page.cursor
          for (const ev of page.events) {
            if (seenIdx.has(ev.cursor)) dupes += 1
            seenIdx.add(ev.cursor)
            if (ev.type === 'message.posted' && ev.message?.id !== undefined) {
              seen.push(String(ev.message.id))
            }
          }
        }
        return { seen, lastCursor, dupes }
      })()
      return { started: true }
    }
    case 'stop-feed': {
      feedAbort?.abort()
      const result = feedDone ? await feedDone : { seen: [], lastCursor: '0', dupes: 0 }
      feedAbort = null
      feedDone = null
      return result
    }
    case 'claim-loop': {
      const t = getTransport(m.as)
      await t.ready()
      const claimed: string[] = []
      for (;;) {
        const res = (await t.call('claimReadyTask', { channel: m.channel })) as {
          task: { id: string } | null
        }
        if (res.task === null) break
        claimed.push(String(res.task.id))
      }
      return { claimed }
    }
    case 'stats': {
      return getTransport(m.as).stats()
    }
    case 'close': {
      feedAbort?.abort()
      for (const timer of holdTimers) clearTimeout(timer)
      holdTimers.clear()
      for (const db of [...holdDbs]) releaseHold(db)
      for (const t of transports.values()) {
        await t.close()
      }
      transports.clear()
      setImmediate(() => process.exit(0))
      return { closed: true }
    }
  }
}

process.on('message', (raw) => {
  const m = raw as Msg
  handle(m).then(
    (value) => process.send?.({ id: m.id, ok: true, value }),
    (error: unknown) => {
      const e = isBoardError(error) ? error : normalizeThrown(error)
      process.send?.({
        id: m.id,
        ok: false,
        error: {
          status: e.status,
          code: e.code,
          message: e.message,
          hint: e.hint,
          details: e.details,
          origin: e.origin,
          retryAfter: e.retryAfter,
        },
      })
    },
  )
})

process.on('disconnect', () => {
  for (const timer of holdTimers) clearTimeout(timer)
  for (const db of [...holdDbs]) releaseHold(db)
  process.exit(0)
})

process.send?.({ ready: true, pid: process.pid })
