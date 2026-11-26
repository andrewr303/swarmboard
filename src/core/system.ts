// HOST-0 C6 (HOST0_DESIGN 3.9): the board's own caller and author. Internal: reached through internal.ts (and
// the one constant through board-service.ts), never through public.ts.
import type { BoardService, CallerContext, ScheduleRun } from './board-service.ts'
import type { Author } from './schemas.ts'
import { frozenSet } from './frozen-set.ts'
import type { ExpireRun } from './tasks/sweep.ts'

/** The board's own principal and actor: the author of what the tick writes. Reserved. */
export const SYSTEM_PRINCIPAL_ID = 'board:system'
/** The original's schedule actor (server/schedules.ts:184): the author of a schedule the board cancels. Reserved. */
export const SCHEDULE_ACTOR_ID = 'board:schedule'
/** IDs no request may act as: `checkCallerActor` refuses them as a principal or an actor. Immutable at run time too. */
export const RESERVED_SYSTEM_IDS: ReadonlySet<string> = frozenSet([SYSTEM_PRINCIPAL_ID, SCHEDULE_ACTOR_ID])

declare const systemBrand: unique symbol
/** The board's own caller. Only `createSystemCaller` makes one; a copy or a look-alike is not one. */
export type SystemCaller = Readonly<CallerContext> & { readonly [systemBrand]: true }

const genuine = new WeakSet<object>()
let theSystemCaller: SystemCaller | null = null

/** The process's one system caller: deep-frozen, no profile, no `canHeader`. The same object on every call. */
export function createSystemCaller(): SystemCaller {
  if (theSystemCaller) return theSystemCaller
  const caller = Object.freeze({
    principal: Object.freeze({ id: SYSTEM_PRINCIPAL_ID, kind: 'deployment' as const, handle: 'system' }),
    actor: Object.freeze({
      id: SYSTEM_PRINCIPAL_ID,
      kind: 'deployment' as const,
      handle: 'system',
      name: 'system',
      avatar: null,
    }),
    profile: null,
  }) as unknown as SystemCaller
  genuine.add(caller)
  theSystemCaller = caller
  return caller
}

/** True only for the object `createSystemCaller` returns: WeakSet membership, never shape. */
export function isSystemCaller(value: unknown): value is SystemCaller {
  return typeof value === 'object' && value !== null && genuine.has(value)
}

/** `{ actor: 'board:system', principal: 'board:system', profile: null }`, a fresh object on each call. */
export function systemAuthor(): Author {
  return { actor: SYSTEM_PRINCIPAL_ID, principal: SYSTEM_PRINCIPAL_ID, profile: null }
}

/** What the tick may do. Nothing else takes a `SystemCaller`. */
export interface SystemOps {
  readonly caller: SystemCaller
  readonly author: Author
  /** `board.runDueSchedules` (C7: `next_at` compare-and-set, `skipped`, `stopped`). */
  runDueSchedules(nowMs?: number, opts?: { shouldContinue?: () => boolean }): ScheduleRun
  /** `board.tasks.expireDueClaims`: never early, in chunks. */
  expireDueClaims(nowMs?: number, opts?: { limit?: number; chunk?: number }): ExpireRun
  /** `board.tasks.nextLeaseDueMs`. */
  nextLeaseDueMs(): number | null
  /** `MIN(next_at)` of the pending schedules, or null: lets a tick sleep exactly. Not a BoardService method. */
  nextScheduleDueMs(): number | null
  /** `board.tasks.rebuildIndex`. */
  rebuildTaskIndex(): { tasks: number; edges: number }
}

/** Throws `TypeError` unless `system` is the genuine system caller. Returns a frozen object. */
export function systemOps(board: BoardService, system: SystemCaller): SystemOps {
  if (!isSystemCaller(system)) {
    throw new TypeError("systemOps takes the board's own system caller (createSystemCaller())")
  }
  return Object.freeze({
    caller: system,
    author: Object.freeze(systemAuthor()),
    runDueSchedules: (nowMs?: number, opts?: { shouldContinue?: () => boolean }) =>
      board.runDueSchedules(nowMs, opts ?? {}),
    expireDueClaims: (nowMs?: number, opts?: { limit?: number; chunk?: number }) =>
      board.tasks.expireDueClaims(nowMs, opts),
    nextLeaseDueMs: () => board.tasks.nextLeaseDueMs(),
    nextScheduleDueMs: () => {
      const row = board.store.db
        .prepare("SELECT MIN(next_at) AS at FROM board_schedules WHERE state = 'pending' AND next_at IS NOT NULL")
        .get() as { at: number | null } | undefined
      return row?.at === null || row?.at === undefined ? null : Number(row.at)
    },
    rebuildTaskIndex: () => board.tasks.rebuildIndex(),
  })
}
