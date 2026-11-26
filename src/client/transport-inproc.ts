// InProcessTransport (Mode 0, HOST123_DESIGN 5.6): the board in this process, through the shared dispatcher. Thick:
// it holds a BoardService.
//
// With `owned`, the transport owns the store: it creates a BoardWatch for it (the board identity fence on every call;
// on `replaced` it closes the store and every later call rejects with the sticky error) and closes the store on
// close(). A borrowed BoardService gets no watch: the embedder owns the store and its identity.
import type { BoardService, EventsPage, SqliteUnifiedStore } from '../core/public.ts'
import { clientError } from './errors.ts'
import type { IdentityProvider } from './identity.ts'
import { createBoardWatch, eventsFeed, guardFor, prepareCall, runPrepared, type DispatchContext } from './dispatch.ts'
import { OP_NAMES, type OpInput, type OpName, type OpOutput } from './ops.ts'
import type { BoardTransport, CallOptions, Capabilities, EventsFeedQuery } from './types.ts'
import { CLIENT_VERSION, PROTOCOL_VERSION } from './version.ts'

export interface InProcessTransportOptions {
  readonly board: BoardService
  readonly identity: IdentityProvider
  /** Closed by close() when given; its store gets a BoardWatch. Omit for a borrowed BoardService (no watch). */
  readonly owned?: { readonly store: SqliteUnifiedStore; close(): void }
}

const OS_USER = Object.freeze(['os-user'] as const)
const NONE = Object.freeze([] as const)

/** Capabilities computed from a BoardService (HOST123_DESIGN 5.3), frozen; exported for composing transports. */
export function baseCapabilities(board: BoardService, overrides?: Partial<Capabilities>): Capabilities {
  const info = board.boardInfo()
  const tasks = board.tasks.capabilities()
  const path = (board.store as { readonly path?: unknown }).path
  // A file board's waits also wake on other connections' commits: the core looks at the log head every 100 ms.
  const file = typeof path === 'string' && path !== ':memory:'
  return Object.freeze({
    protocol: PROTOCOL_VERSION,
    mode: 'in-process',
    transport: 'direct',
    coreVersion: CLIENT_VERSION,
    schemaVersion: info.schema?.version ?? 0,
    schemaBuild: info.schema?.build ?? 0,
    writable: info.schema?.refused == null,
    boardId: info.boardId,
    instanceId: info.instanceId,
    wake: file ? 'poll' : 'in-process',
    crossProcessWake: file,
    wakePollMs: file ? 100 : null,
    maxWaitS: 300,
    leaseMinS: tasks.lease_min_s,
    leaseCapS: tasks.lease_cap_s,
    leaseDefaultS: tasks.lease_default_s,
    batchMax: tasks.batch_max,
    schedules: 'none',
    auth: OS_USER,
    assurances: NONE,
    conditionalNeeds: tasks.conditional_needs,
    priorityNative: tasks.priority_native,
    defer: tasks.defer,
    resume: tasks.resume,
    subtreeRead: true,
    ops: OP_NAMES,
    ...overrides,
  } satisfies Capabilities)
}

export class InProcessTransport implements BoardTransport {
  readonly board: BoardService
  readonly identity: IdentityProvider
  readonly #ctx: DispatchContext
  readonly #owned: NonNullable<InProcessTransportOptions['owned']> | null
  readonly #close = new AbortController()
  #closed = false
  #caps: Capabilities
  #capsEpoch = 0

  constructor(options: InProcessTransportOptions) {
    if (options === null || typeof options !== 'object' || options.board === undefined || options.identity === undefined) {
      throw new TypeError('InProcessTransport needs a board and an identity')
    }
    this.board = options.board
    this.identity = options.identity
    this.#owned = options.owned ?? null
    const watch = this.#owned !== null ? createBoardWatch(this.#owned.store) : null
    this.#ctx = { board: this.board, identity: this.identity, guard: guardFor(this.board), watch }
    const owned = this.#owned
    if (watch !== null && owned !== null) {
      // replaced: close the store at once (prompt end of reads on the old inode); every later call gets the sticky error
      watch.onStop(() => {
        try {
          owned.close()
        } catch {
          // already closed
        }
      })
    }
    this.#caps = baseCapabilities(this.board)
  }

  /** The current frozen snapshot; a new one after a restore (new instanceId). */
  get capabilities(): Capabilities {
    const watch = this.#ctx.watch
    if (watch !== null && watch.epoch !== this.#capsEpoch) {
      this.#capsEpoch = watch.epoch
      this.#caps = Object.freeze({
        ...this.#caps,
        boardId: watch.baseline?.boardId ?? this.#caps.boardId,
        instanceId: watch.baseline?.instanceId ?? this.#caps.instanceId,
      })
    }
    return this.#caps
  }

  get closed(): boolean {
    return this.#closed
  }

  call<O extends OpName>(op: O, input: OpInput<O>, opts?: CallOptions): Promise<OpOutput<O>> {
    return this.#call(op, input, opts) as Promise<OpOutput<O>>
  }

  async #call(op: string, input: unknown, opts: CallOptions | undefined): Promise<unknown> {
    const prepared = prepareCall(this.#ctx, op, input, opts, { closed: this.#closed, ops: this.#caps.ops })
    return runPrepared(prepared, this.#ctx, this.#close.signal, (once) => once(0))
  }

  events(query: EventsFeedQuery, opts?: CallOptions): AsyncIterable<EventsPage> {
    return eventsFeed(
      this.#ctx,
      query ?? {},
      opts,
      (input, signal) => this.#call('events', input, { ...opts, signal }) as Promise<EventsPage>,
      this.#close.signal,
    )
  }

  /** Aborts in-flight waits (they resolve with what they have), then closes an owned store. Idempotent; never throws. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#close.abort(clientError('unavailable', 'this transport is closed'))
    if (this.#owned !== null) {
      try {
        this.#owned.close()
      } catch {
        // already closed
      }
    }
  }
}
