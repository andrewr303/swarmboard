// Recording FileHost stub + SharedFileTransport conformance targets (`shared-file` and `shared-file-degraded`)
// + IPC PeerClient / cross-process BoardTransport helper over `proc/peer-child.ts`.
import { fork, type ChildProcess } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import {
  BoardError,
  SqliteUnifiedStore,
  type BoardIdentity,
  type BoardService,
  type BoardServiceOptions,
  type EventsPage,
  type SqliteStoreOptions,
} from '../../src/core/public.ts'
import type {
  ConformanceBoard,
  ConformanceTarget,
  IdentitySpec,
  PeerClient,
} from '../../src/client/conformance.ts'
import { ClientError, type BoardErrorLike } from '../../src/client/errors.ts'
import type { OpName } from '../../src/client/ops.ts'
import {
  SharedFileTransport,
  type FileHost,
  type FileHostAttachment,
} from '../../src/client/transport-file.ts'
import type { BoardTransport, CallOptions, Capabilities, EventsFeedQuery } from '../../src/client/types.ts'
import { createFileHost } from '../../src/host/file-host.ts'
import { providerFor, recorded } from './fixtures.ts'
import type { PeerChildInit } from './proc/peer-child.ts'

const PEER_CHILD = resolve(import.meta.dirname, 'proc', 'peer-child.ts')

// ---------------------------------------------------------------------------------------------------------------
// Recording FileHost stub (HS-161, HS-176a)

export interface RecordingFileHost {
  readonly host: FileHost
  readonly events: string[]
  readonly openCalls: string[]
  readonly stores: SqliteUnifiedStore[]
  readonly boards: BoardService[]
  readonly serviceOptionsReturned: Readonly<Pick<BoardServiceOptions, 'eventsWaitPollMs' | 'tasks'>>[]
  readonly closeCount: () => number
  triggerReset(reset: {
    readonly epoch: number
    readonly reason: 'restored' | 'rewound'
    readonly identity: BoardIdentity | null
    readonly cursor: number
  }): void
  triggerStop(stop: {
    readonly reason: 'replaced' | 'closed' | 'stopped'
    readonly error: BoardErrorLike | null
  }): void
}

export function createRecordingFileHost(
  opts: {
    readonly wake?: 'fs-watch' | 'poll'
    readonly safetyPollMs?: number
    readonly ticking?: boolean
    readonly closeDelayMs?: number
    readonly onStoreClose?: () => void
  } = {},
): RecordingFileHost {
  const events: string[] = []
  const openCalls: string[] = []
  const stores: SqliteUnifiedStore[] = []
  const boards: BoardService[] = []
  const serviceOptionsReturned: Readonly<Pick<BoardServiceOptions, 'eventsWaitPollMs' | 'tasks'>>[] = []
  let closes = 0
  let wakeMode: 'fs-watch' | 'poll' = opts.wake ?? 'fs-watch'
  const safetyPollMs = opts.safetyPollMs ?? 1500
  let ticking = false
  const resetListeners = new Set<
    (reset: {
      readonly epoch: number
      readonly reason: 'restored' | 'rewound'
      readonly identity: BoardIdentity | null
      readonly cursor: number
    }) => void
  >()
  const stopListeners = new Set<
    (stop: { readonly reason: 'replaced' | 'closed' | 'stopped'; readonly error: BoardErrorLike | null }) => void
  >()

  const host: FileHost = {
    open(path: string, storeOptions?: Pick<SqliteStoreOptions, 'testHooks'>) {
      events.push(`open:${path}`)
      openCalls.push(path)
      const store = new SqliteUnifiedStore({
        path,
        ...(storeOptions?.testHooks !== undefined ? { testHooks: storeOptions.testHooks } : {}),
      })
      const origClose = store.close.bind(store)
      store.close = () => {
        events.push('store.close')
        opts.onStoreClose?.()
        origClose()
      }
      stores.push(store)
      return { store, warnings: [] }
    },
    attach(store: SqliteUnifiedStore): FileHostAttachment {
      events.push('attach')
      const svcOpts = Object.freeze({
        eventsWaitPollMs: safetyPollMs,
        tasks: Object.freeze({
          wake: (listener: (ev: Parameters<Parameters<SqliteUnifiedStore['onEvent']>[0]>[0]) => void) =>
            store.onEvent(listener),
          armedSafetyPollMs: safetyPollMs,
        }),
      })
      const attachment: FileHostAttachment = {
        get wake() {
          return wakeMode
        },
        get safetyPollMs() {
          return safetyPollMs
        },
        get ticking() {
          return ticking
        },
        serviceOptions() {
          events.push('serviceOptions')
          serviceOptionsReturned.push(svcOpts)
          return svcOpts
        },
        bindBoard(board: BoardService) {
          events.push('bindBoard')
          boards.push(board)
          ticking = opts.ticking ?? false
        },
        onReset(listener) {
          resetListeners.add(listener)
          return () => {
            resetListeners.delete(listener)
          }
        },
        onStop(listener) {
          stopListeners.add(listener)
          return () => {
            stopListeners.delete(listener)
          }
        },
        status() {
          return Object.freeze({ stub: true, wake: wakeMode, ticking })
        },
        async close() {
          events.push('attachment.close:start')
          closes += 1
          if (opts.closeDelayMs && opts.closeDelayMs > 0) {
            await new Promise((r) => setTimeout(r, opts.closeDelayMs))
          }
          ticking = false
          events.push('attachment.close:done')
        },
      }
      return attachment
    },
  }

  return {
    host,
    events,
    openCalls,
    stores,
    boards,
    serviceOptionsReturned,
    closeCount: () => closes,
    triggerReset(reset) {
      for (const l of [...resetListeners]) l(reset)
    },
    triggerStop(stop) {
      for (const l of [...stopListeners]) l(stop)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// IPC peer-child handle (implements PeerClient + extended helpers for stress & conformance)

interface SerializedError {
  status: number
  code: string
  message: string
  hint?: string
  details?: unknown
  origin?: 'board' | 'handle'
  retryAfter?: number
}

function reviveError(e: SerializedError): BoardErrorLike {
  if (e.origin === 'handle') {
    return new ClientError(e.status, e.code, e.message, {
      ...(e.hint !== undefined ? { hint: e.hint } : {}),
      ...(e.details !== undefined ? { details: e.details } : {}),
      ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}),
    })
  }
  return new BoardError(e.status, e.code, e.message, {
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
    ...(e.details !== undefined ? { details: e.details } : {}),
    ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}),
  })
}

function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return { __cbBytes: Buffer.from(v).toString('base64') }
  if (Array.isArray(v)) return v.map(encodeValue)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = encodeValue(val)
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
    for (const [k, val] of Object.entries(rec)) out[k] = decodeValue(val)
    return out
  }
  return v
}

export interface PeerChildHandle extends PeerClient {
  readonly pid: number
  readonly child: ChildProcess
  ready(as?: string): Promise<Capabilities>
  callAs(as: string, op: OpName, input: unknown, opts?: Omit<CallOptions, 'signal'>): Promise<unknown>
  tightPost(channel: string, count: number, prefix: string, as?: string): Promise<{ posted: number; maxLagMs: number; stats: unknown }>
  keyedPosts(
    channel: string,
    items: ReadonlyArray<{ readonly key: string; readonly text: string }>,
    opts?: { db?: string; as?: string; crashAfterIndex?: number; crashKillIndex?: number },
  ): Promise<{ ids: string[] }>
  multiKeyedPosts(
    dbs: readonly string[],
    channel: string,
    itemsByBoard: ReadonlyArray<ReadonlyArray<{ readonly key: string; readonly text: string }>>,
    opts?: {
      as?: string
      crashAfter?: { readonly board: number; readonly index: number }
      crashKill?: { readonly board: number; readonly index: number }
    },
  ): Promise<{ idsByBoard: string[][] }>
  startFeed(channel: string, after?: string, as?: string): Promise<void>
  stopFeed(): Promise<{ seen: string[]; lastCursor: string; dupes: number }>
  claimLoop(channel: string, as?: string): Promise<{ claimed: string[] }>
  kill(): void
  transportFor(as: string): Promise<BoardTransport>
}

export async function spawnPeerChild(init: PeerChildInit): Promise<PeerChildHandle> {
  const child = fork(PEER_CHILD, [JSON.stringify(init)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })

  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let exited = false
  let exitInfo = ''

  await new Promise<void>((resolveReady, rejectReady) => {
    const onMsg = (raw: unknown) => {
      const m = raw as { ready?: boolean }
      if (m?.ready) {
        child.off('message', onMsg)
        child.off('exit', onEarlyExit)
        resolveReady()
      }
    }
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      rejectReady(new Error(`peer-child exited before ready (code=${code} signal=${signal}): ${stderr}`))
    }
    child.on('message', onMsg)
    child.on('exit', onEarlyExit)
  })

  child.on('message', (raw: unknown) => {
    const m = raw as { id?: number; ok?: boolean; value?: unknown; error?: SerializedError }
    if (typeof m?.id !== 'number') return
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok) p.resolve(decodeValue(m.value))
    else p.reject(reviveError(m.error!))
  })

  const rejectAll = (reason: Error) => {
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(reason)
    }
  }

  const exitPromise = new Promise<void>((res) => {
    child.on('exit', (code, signal) => {
      exited = true
      exitInfo = `code=${code} signal=${signal}`
      rejectAll(new Error(`peer-child exited (${exitInfo})${stderr ? `: ${stderr}` : ''}`))
      res()
    })
  })

  function send<T>(payload: Record<string, unknown>): Promise<T> {
    if (exited || !child.connected) {
      return Promise.reject(new Error(`peer-child already exited (${exitInfo})`))
    }
    const id = nextId++
    return new Promise<T>((res, rej) => {
      pending.set(id, { resolve: res as (v: unknown) => void, reject: rej })
      child.send({ id, ...payload }, (err) => {
        if (err) {
          pending.delete(id)
          rej(err)
        }
      })
    })
  }

  const handle: PeerChildHandle = {
    pid: child.pid ?? 0,
    child,
    ready: (as) => send<Capabilities>({ kind: 'ready', ...(as !== undefined ? { as } : {}) }),
    call: (op, input, opts) =>
      send({ kind: 'call', op, input: encodeValue(input), ...(opts !== undefined ? { opts } : {}) }),
    callAs: (as, op, input, opts) =>
      send({ kind: 'call', as, op, input: encodeValue(input), ...(opts !== undefined ? { opts } : {}) }),
    crashAfterNextCommit: async () => {
      await send({ kind: 'crash-after-commit' })
    },
    hold: async (ms) => {
      await send({ kind: 'hold', ms })
    },
    tightPost: (channel, count, prefix, as) =>
      send({ kind: 'tight-post', channel, count, prefix, ...(as !== undefined ? { as } : {}) }),
    keyedPosts: (channel, items, opts) =>
      send({ kind: 'keyed-posts', channel, items, ...(opts ?? {}) }),
    multiKeyedPosts: (dbs, channel, itemsByBoard, opts) =>
      send({ kind: 'multi-keyed-posts', dbs, channel, itemsByBoard, ...(opts ?? {}) }),
    startFeed: async (channel, after, as) => {
      await send({ kind: 'start-feed', channel, ...(after !== undefined ? { after } : {}), ...(as !== undefined ? { as } : {}) })
    },
    stopFeed: () => send({ kind: 'stop-feed' }),
    claimLoop: (channel, as) => send({ kind: 'claim-loop', channel, ...(as !== undefined ? { as } : {}) }),
    kill() {
      if (!exited) child.kill('SIGKILL')
    },
    async close() {
      if (exited) return
      try {
        await send({ kind: 'close' })
      } catch {
        if (!exited) child.kill('SIGKILL')
      }
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 2000))])
      if (!exited) {
        child.kill('SIGKILL')
        await exitPromise
      }
    },
    async transportFor(as: string): Promise<BoardTransport> {
      const caps = await handle.ready(as)
      let closed = false
      const t: BoardTransport = {
        get capabilities() {
          return caps
        },
        get closed() {
          return closed
        },
        call(op, input, opts) {
          const forwardOpts: Omit<CallOptions, 'signal'> | undefined = opts
            ? {
                ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
                ...(opts.as !== undefined ? { as: opts.as } : {}),
                ...(opts.expectInstance !== undefined ? { expectInstance: opts.expectInstance } : {}),
              }
            : undefined
          return handle.callAs(as, op, input, forwardOpts) as Promise<never>
        },
        events(_query: EventsFeedQuery, _opts?: CallOptions): AsyncIterable<EventsPage> {
          throw new Error('peer transport adapter does not implement events()')
        },
        async close() {
          closed = true
        },
      }
      return recorded(t)
    },
  }

  return handle
}

// ---------------------------------------------------------------------------------------------------------------
// SharedFileTransport conformance targets (`shared-file` and `shared-file-degraded`)

export function sharedFileTarget(
  mode: 'real' | 'degraded',
  name = mode === 'real' ? 'shared-file' : 'shared-file-degraded',
): ConformanceTarget {
  return {
    name,
    features: {
      crossProcess: true,
      busyRetry: true,
      lanes: true,
      identityEvents: true,
      crashInjection: true,
      clock: false,
    },
    async open(dir, ids, opts): Promise<ConformanceBoard> {
      const db = join(dir, 'board.db')
      const host =
        mode === 'real'
          ? createFileHost({
              target: { kind: 'file', db, dir, defaultDir: false },
              allowUnsafeFs: false,
              wake: { watch: true, safetyPollMs: 1500 },
              tick: 'off',
            })
          : undefined
      const adaSpec = ids['ada']
      if (!adaSpec) throw new Error('sharedFileTarget requires ada identity')
      const transport = new SharedFileTransport({
        path: db,
        identity: providerFor(adaSpec),
        ...(host !== undefined ? { host } : {}),
        ...(opts?.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}),
        ...(opts?.busyBudgetMs !== undefined ? { busyBudgetMs: opts.busyBudgetMs } : {}),
      })
      await transport.ready()

      let childPeer: PeerChildHandle | null = null
      const ensureChild = async (): Promise<PeerChildHandle> => {
        if (childPeer !== null) return childPeer
        childPeer = await spawnPeerChild({
          db,
          ids: { ...ids, ext: { userId: 'ext', member: true } },
          defaultAs: 'bob',
          host: mode === 'real' ? 'real' : 'none',
        })
        return childPeer
      }

      const wrapped = recorded(transport)

      return {
        transport: wrapped,
        async peer(as = 'bob') {
          const c = await ensureChild()
          return c.transportFor(as)
        },
        async externalPost(channel, text) {
          const c = await ensureChild()
          const res = (await c.callAs('ext', 'post', { channel, text })) as {
            message: { id: string }
          }
          const page = (await c.callAs('ext', 'events', {})) as EventsPage
          return { id: String(res.message.id), index: Number(page.cursor) }
        },
        clock: null,
        async close() {
          if (childPeer !== null) {
            await childPeer.close()
            childPeer = null
          }
          await transport.close()
        },
      }
    },
    async spawnPeer(dir, ids, as): Promise<PeerClient> {
      const db = join(dir, 'board.db')
      const child = await spawnPeerChild({
        db,
        ids,
        defaultAs: as,
        host: mode === 'real' ? 'real' : 'none',
      })
      await child.ready(as)
      return child
    },
  }
}

export function realHostFor(
  db: string,
  opts: {
    readonly safetyPollMs?: number
    readonly watch?: boolean
    readonly tick?: 'lease' | 'owner-only' | 'off'
    readonly allowUnsafeFs?: boolean
    readonly onError?: (err: unknown, site: string) => void
  } = {},
): FileHost {
  return createFileHost({
    target: { kind: 'file', db, dir: dirname(db), defaultDir: false },
    allowUnsafeFs: opts.allowUnsafeFs ?? false,
    wake: { watch: opts.watch ?? true, safetyPollMs: opts.safetyPollMs ?? 1500 },
    tick: opts.tick ?? 'off',
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  })
}
