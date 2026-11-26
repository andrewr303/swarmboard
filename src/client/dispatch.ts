// The shared in-process dispatcher (HOST123_DESIGN 5.4, 5.5): the call order every in-process transport runs, the
// board identity watch, the events feed and the signal linker. Thick: it calls the core through its public surface.
//
// InProcessTransport (Mode 0) and SharedFileTransport (Mode 1) differ only in what they wrap around runPrepared (the
// lane and the busy retry). The order of prepareCall is normative: nothing reaches the core on a refusal, the
// identity is resolved once per call, the idempotency key is mapped after it, and the key guard is settled exactly
// once when the call settles. A claim token in an input is never logged, copied into an error or kept: the
// dispatcher logs nothing at all.
//
// Identity is self-asserted in Modes 0 and 1: the refusal of a deployment-kind caller is accident protection (it
// keeps the system caller off a transport by mistake), not a security boundary.
import {
  BoardError,
  type BoardIdentity,
  type BoardService,
  type CallerContext,
  type EventsPage,
  type SqliteUnifiedStore,
} from '../core/public.ts'
import { ClientError, clientError, type BoardErrorLike } from './errors.ts'
import { applyIdempotencyKey, bodyDigest, KeyBodyGuard } from './idempotency.ts'
import type { IdentityProvider } from './identity.ts'
import { normalizeThrown, replacedError } from './normalize.ts'
import { bindArgs, isOpName, laneKind, OPS, validateEnvelope, type OpName, type OpSpec } from './ops.ts'
import type { CallOptions, EventsFeedQuery } from './types.ts'

// ---- Signals

/**
 * Links signals (CON-2, F24): `signal` aborts when any source aborts, with that source's reason. The caller MUST call
 * dispose() when the call (or feed round) settles, in a finally block: it removes every listener this added to the
 * sources. Never AbortSignal.any, never a listener left on a long-lived signal. dispose() is idempotent.
 */
export function linkSignals(...signals: (AbortSignal | undefined)[]): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const hooked: { source: AbortSignal; listener: () => void }[] = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const { source, listener } of hooked) source.removeEventListener('abort', listener)
    hooked.length = 0
  }
  for (const source of signals) {
    if (source === undefined) continue
    if (source.aborted) {
      controller.abort(source.reason)
      dispose()
      break
    }
    const listener = (): void => {
      controller.abort(source.reason)
      dispose()
    }
    source.addEventListener('abort', listener, { once: true })
    hooked.push({ source, listener })
  }
  return { signal: controller.signal, dispose }
}

/** An abortable sleep that leaves no timer and no listener behind; it resolves (never rejects) on abort. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

// ---- The board identity watch

/** One per OWNED store (null for a borrowed BoardService): the board identity fence (HOST0 6.4). */
export interface BoardWatch {
  /** +1 per restore or rewind seen. */
  readonly epoch: number
  readonly baseline: BoardIdentity | null
  /** The sticky replaced error, once seen. */
  readonly stopped: BoardErrorLike | null
  /** Aborted on each reset; a fresh one afterwards. */
  readonly epochSignal: AbortSignal
  /** Aborted once, on stop. */
  readonly stopSignal: AbortSignal
  /** The reason of the latest reset that changed the epoch; null before the first. */
  readonly lastReset: 'restored' | 'rewound' | null
  /** store.checkIdentity(baseline): 'replaced' → stop(replacedError(path)) and throw it; 'restored' → reset('restored'). */
  check(): void
  /** From check() or from a FileHost onReset. Increments epoch only when the instanceId differs from the baseline or reason is 'rewound'. */
  reset(reason: 'restored' | 'rewound', identity: BoardIdentity | null): void
  /** Idempotent. */
  stop(error: BoardErrorLike): void
  onStop(listener: (error: BoardErrorLike) => void): () => void
}

export function createBoardWatch(store: SqliteUnifiedStore): BoardWatch {
  let epoch = 0
  let baseline: BoardIdentity | null = store.openedIdentity
  let stopped: BoardErrorLike | null = null
  let lastReset: 'restored' | 'rewound' | null = null
  let epochController = new AbortController()
  const stopController = new AbortController()
  const listeners = new Set<(error: BoardErrorLike) => void>()
  const watch: BoardWatch = {
    get epoch() {
      return epoch
    },
    get baseline() {
      return baseline
    },
    get stopped() {
      return stopped
    },
    get epochSignal() {
      return epochController.signal
    },
    get stopSignal() {
      return stopController.signal
    },
    get lastReset() {
      return lastReset
    },
    check() {
      if (stopped !== null) throw stopped
      const seen = store.checkIdentity(baseline)
      if (seen.status === 'replaced') {
        watch.stop(replacedError(store.path))
        throw stopped
      }
      if (seen.status === 'restored') watch.reset('restored', seen.identity)
    },
    reset(reason, identity) {
      if (stopped !== null) return
      const changed = reason === 'rewound' || (identity?.instanceId ?? null) !== (baseline?.instanceId ?? null)
      if (identity !== null) baseline = identity
      if (!changed) return
      epoch += 1
      lastReset = reason
      const old = epochController
      epochController = new AbortController()
      old.abort(cursorExpired(reason === 'rewound' ? 'log_rewound' : 'instance_changed', { boardId: baseline?.boardId ?? null, instanceId: baseline?.instanceId ?? null }))
    },
    stop(error) {
      if (stopped !== null) return
      stopped = error
      stopController.abort(error)
      for (const listener of [...listeners]) {
        try {
          listener(error)
        } catch {
          // A listener's failure never stops the others.
        }
      }
    },
    onStop(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return watch
}

/** 410 cursor_expired, the existing code, with `details.reason` (HOST123_DESIGN 7.5). A core BoardError: it describes the board's state. */
function cursorExpired(reason: 'instance_changed' | 'log_rewound', details: Readonly<Record<string, unknown>>): BoardError {
  const message =
    reason === 'log_rewound'
      ? 'this cursor is past the end of the log: the board was rewound or the cursor came from another board instance'
      : 'the board was restored since this cursor was read: it names a position in another instance of the log'
  return new BoardError(410, 'cursor_expired', message, {
    hint: 'read again from the head (omit after), or keep cursors with the instanceId they came from',
    details: { reason, ...details },
  })
}

function headOf(board: BoardService): number | null {
  try {
    return board.store.getHeadIndex()
  } catch {
    return null
  }
}

/** The 410 of an epoch change, as a feed or a cut events call reports it. */
function epochExpired(board: BoardService, watch: BoardWatch): BoardError {
  return cursorExpired(watch.lastReset === 'rewound' ? 'log_rewound' : 'instance_changed', {
    boardId: watch.baseline?.boardId ?? null,
    instanceId: watch.baseline?.instanceId ?? null,
    head: headOf(board),
  })
}

// ---- Dispatch

export interface DispatchContext {
  readonly board: BoardService
  readonly identity: IdentityProvider
  /** guardFor(board): one per BoardService per process. */
  readonly guard: KeyBodyGuard
  readonly watch: BoardWatch | null
}

const guards = new WeakMap<BoardService, KeyBodyGuard>()

/** The key guard of a BoardService: one per service per process, shared by every transport on it. */
export function guardFor(board: BoardService): KeyBodyGuard {
  let guard = guards.get(board)
  if (guard === undefined) {
    guard = new KeyBodyGuard()
    guards.set(board, guard)
  }
  return guard
}

export interface PreparedCall {
  readonly op: OpName
  readonly spec: OpSpec
  readonly caller: CallerContext
  /** After the key mapping; reused unchanged by every retry. */
  readonly input: Record<string, unknown>
  readonly lane: string
  readonly laneKind: 'read' | 'write' | 'wait'
  /** Watch epoch at prepare time. */
  readonly epoch: number
  /** The watch's epoch signal at prepare time (aborted if the board resets before the call runs). */
  readonly epochSignal: AbortSignal | undefined
  /** CallOptions.signal. */
  readonly signal: AbortSignal | undefined
  /** Step 9's KeyBodyGuard handle (null when no native id was set); runPrepared settles it exactly once. */
  readonly guardHandle: { commit(): void; abort(): void } | null
  /** One core invocation. A 'core' wait gets wait = max(0, wait0 - elapsedMs / 1000). Throws raw (unnormalized). */
  invokeOnce(signal: AbortSignal | undefined, elapsedMs: number): Promise<unknown>
}

const LOG_INDEX = /^(0|[1-9]\d{0,15})$/

/** A cursor as the core reads it (decimal log index string), or null for anything else (the core answers that itself). */
function cursorIndex(value: unknown): number | null {
  if (typeof value === 'string' && LOG_INDEX.test(value)) return Number(value)
  return null
}

type Method = (...args: unknown[]) => unknown

/**
 * Call steps 1-10 of HOST123_DESIGN 5.4 (synchronous, throws a BoardErrorLike, or the signal's reason for an aborted
 * non-wait call; never reaches the core on a refusal; a refusal after step 9 aborts the guard handle before throwing).
 */
export function prepareCall(
  ctx: DispatchContext,
  op: string,
  input: unknown,
  opts: CallOptions | undefined,
  state: { readonly closed: boolean; readonly ops?: readonly string[] },
): PreparedCall {
  // 1. closed
  if (state.closed) throw clientError('unavailable', 'this transport is closed', { hint: 'open a new client' })
  // 2. stopped (replaced)
  const watch = ctx.watch
  if (watch?.stopped) throw watch.stopped
  // 3. op
  if (typeof op !== 'string' || !isOpName(op) || (state.ops !== undefined && !state.ops.includes(op))) {
    throw clientError('not_supported', `no operation named ${String(op)}`, { hint: 'the capabilities list the operations this board serves' })
  }
  const spec: OpSpec = OPS[op]
  const kind = laneKind(op)
  // 4. an aborted non-wait call rejects with the signal's reason, as fetch does; a wait passes it to the core
  const signal = opts?.signal
  if (signal?.aborted === true && kind !== 'wait') throw signal.reason
  try {
    // 5. the board identity fence (owned stores only)
    watch?.check()
    // 6. expectInstance
    if (opts?.expectInstance !== undefined) {
      const live = watch !== null ? (watch.baseline?.instanceId ?? null) : ctx.board.boardInfo().instanceId
      if (live !== opts.expectInstance) {
        throw cursorExpired('instance_changed', {
          boardId: watch !== null ? (watch.baseline?.boardId ?? null) : ctx.board.boardInfo().boardId,
          instanceId: live,
        })
      }
    }
    // 7. envelope
    validateEnvelope(op, input)
    // 8. caller
    const caller = ctx.identity.callerFor(opts?.as)
    if (caller.principal.kind === 'deployment') {
      throw new ClientError(403, 'forbidden', "a transport never acts as the board's deployment", {
        hint: 'call BoardService directly for the board-level work a deployment does',
      })
    }
    // 9. idempotency key, then the key guard
    const given = (input ?? {}) as Record<string, unknown>
    const { input: mapped, nativeId } = applyIdempotencyKey(
      op,
      given,
      { principalId: caller.principal.id, profile: caller.profile },
      opts?.idempotencyKey,
    )
    const guardHandle = nativeId !== null ? ctx.guard.begin(nativeId, bodyDigest(op, mapped)) : null
    try {
      // 10. an events cursor above the head can only come from another instance or a rewound log
      if (op === 'events' && mapped['after'] !== undefined) {
        const after = cursorIndex(mapped['after'])
        if (after !== null) {
          const head = ctx.board.store.getHeadIndex()
          if (after > head) throw cursorExpired('log_rewound', { head })
        }
      }
    } catch (error) {
      guardHandle?.abort()
      throw error
    }
    const board = ctx.board
    return {
      op,
      spec,
      caller,
      input: mapped,
      lane: `${caller.principal.id}\u001f${caller.profile ?? ''}`,
      laneKind: kind,
      epoch: watch?.epoch ?? 0,
      epochSignal: watch?.epochSignal,
      signal,
      guardHandle,
      async invokeOnce(callSignal, elapsedMs) {
        let args = mapped
        if (spec.wait === 'core' && elapsedMs > 0 && mapped['wait'] !== undefined) {
          const wait0 = Number(mapped['wait'])
          if (Number.isFinite(wait0)) args = { ...mapped, wait: Math.max(0, wait0 - elapsedMs / 1000) }
        }
        const service = (spec.binds.service === 'board' ? board : board.tasks) as unknown as Record<string, Method>
        const method = service[spec.binds.method]!
        return await method.apply(service, bindArgs(op, args, caller, callSignal))
      },
    }
  } catch (error) {
    throw normalizeThrown(error)
  }
}

/** The longest sleep between two looks of a 'repoll' op (HOST123_DESIGN 5.4 step 12; designs g1 6.2). */
const REPOLL_MS = 250

/**
 * Runs a prepared call: links the call's signals for its lifetime (one link per call, its listeners removed in a
 * finally block when the call settles: CON-2), loops 'repoll' ops (≤ 250 ms abortable sleeps) around `attempt`, maps
 * an epoch change during an events call to 410, normalizes every rejection and settles the key guard (commit on
 * resolve, abort on reject). `attempt` also gets the linked signal (a wrapper's retry sleeps end on it).
 */
export async function runPrepared(
  p: PreparedCall,
  ctx: DispatchContext,
  signal: AbortSignal,
  attempt: (once: (elapsedMs: number) => Promise<unknown>, signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> {
  const link = linkSignals(p.signal, signal, ctx.watch?.stopSignal, p.epochSignal)
  try {
    // Only ops whose spec takes a signal hand it to the core (bindArgs drops it for the rest).
    const once = (elapsedMs: number): Promise<unknown> => p.invokeOnce(link.signal, elapsedMs)
    let result: unknown
    if (p.spec.wait === 'repoll') {
      const wait0 = Number(p.input['wait'] ?? 0)
      const waitMs = Number.isFinite(wait0) && wait0 > 0 ? wait0 * 1000 : 0
      const started = Date.now()
      for (;;) {
        result = await attempt(once, link.signal)
        if (!Array.isArray(result) || result.length > 0 || waitMs <= 0 || link.signal.aborted) break
        const left = started + waitMs - Date.now()
        if (left <= 0) break
        await sleep(Math.min(REPOLL_MS, left), link.signal)
        if (link.signal.aborted) break
      }
    } else {
      result = await attempt(once, link.signal)
    }
    const watch = ctx.watch
    if (p.op === 'events' && watch !== null && watch.epoch !== p.epoch) throw epochExpired(ctx.board, watch)
    p.guardHandle?.commit()
    return result
  } catch (error) {
    p.guardHandle?.abort()
    if (p.signal?.aborted === true && p.laneKind !== 'wait') throw p.signal.reason
    throw normalizeThrown(error)
  } finally {
    link.dispose()
  }
}

// ---- The events feed

/** A feed round's wait (SEC-5): a revoke reaches an idle feed within this many seconds (the core captures the caller's access once per getEvents call). */
export const FEED_ROUND_S = 30

/**
 * The events() page loop of every in-process transport (HOST123_DESIGN 5.5). With `last`, one call without a wait
 * is yielded first; then rounds of `wait: FEED_ROUND_S` after the last cursor, each yielded when it has events or its
 * cursor moved. Before each round it ends on abort or close, throws the sticky stop error, or throws 410 when the
 * board was restored or rewound since the loop started. It never drops an event: each round reads after the last
 * cursor it yielded, and the core's cursor covers every examined event.
 */
export function eventsFeed(
  ctx: DispatchContext,
  query: EventsFeedQuery,
  opts: CallOptions | undefined,
  call: (input: Record<string, unknown>, signal: AbortSignal) => Promise<EventsPage>,
  closeSignal: AbortSignal,
): AsyncIterable<EventsPage> {
  const watch = ctx.watch
  const ended = (): boolean => closeSignal.aborted || opts?.signal?.aborted === true
  const round = async (input: Record<string, unknown>): Promise<EventsPage> => {
    const link = linkSignals(opts?.signal, closeSignal)
    try {
      return await call(input, link.signal)
    } finally {
      link.dispose()
    }
  }
  async function* feed(): AsyncGenerator<EventsPage, void, undefined> {
    if (ended()) return
    try {
      if (watch?.stopped) throw watch.stopped
      watch?.check()
    } catch (error) {
      throw normalizeThrown(error)
    }
    const startEpoch = watch?.epoch ?? 0
    const fence = (): void => {
      try {
        if (watch?.stopped) throw watch.stopped
        watch?.check()
        if (watch !== null && watch.epoch !== startEpoch) throw epochExpired(ctx.board, watch)
      } catch (error) {
        throw normalizeThrown(error)
      }
    }
    // A feed sets its own wait: a caller's `wait` is not part of EventsFeedQuery and is dropped.
    const rest: Record<string, unknown> = { ...query }
    delete rest['wait']
    let after = rest['after'] as string | undefined
    if (rest['last'] !== undefined) {
      const page = await round({ ...rest })
      yield page
      after = page.cursor
    }
    let firstRound = rest['last'] === undefined
    for (;;) {
      if (ended()) return
      if (!firstRound) fence()
      firstRound = false
      const input: Record<string, unknown> = { ...rest, wait: FEED_ROUND_S }
      delete input['last']
      if (after !== undefined) input['after'] = after
      else delete input['after']
      const page = await round(input)
      if (page.events.length > 0 || page.cursor !== after) yield page
      after = page.cursor
    }
  }
  return feed()
}
