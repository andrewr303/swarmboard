// The adapter AT-39 runs the original's task tests through (M2_DESIGN 2.11): the original drives its
// board over HTTP, `call(method, path, body)` answering `{status, body}`; this maps each route those
// tests use onto BoardService and TaskService, answers a refusal as the original's error body
// ({error: {code, message, hint}}) with its status, and gives the callers the original's harness gives,
// as local callers:
//   person(board, 'ada')                       -> local:user:u_ada, a member who manages (handle u_ada)
//   person(board, 'ada', {x-board-profile: p}) -> the same principal as its profile p
//   person(board, 'ada', {x-board-can: c})     -> the same, its token narrowed to c
//   web(board)                                 -> local:user:web: reads, posts and labels everywhere, manages nothing
//   grantCi(board, can) + ci(board)            -> local:user:ci, its token narrowed to exactly `can`
// The clock is vitest's faked Date (the original's `vi.useFakeTimers({toFake: ['Date']})`), and the
// board's own timers are its sweep: `advance` moves the clock and runs expireDueClaims, as the
// original's queue delivers the timers that came due.
import { vi } from 'vitest'
import {
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  toErrorPayload,
  type CallerContext,
  type TaskHook,
  type TaskPlan,
} from '../../../../src/core/index.ts'

export type Answer = { status: number; body: any }
export type Call = (method: string, path: string, body?: unknown) => Promise<Answer>

/** The registry variant a suite runs with: AT-39 empty, AT-41 a pass-through hook in every phase. */
export type Variant = 'empty' | 'pass-through'

export const passThrough = (): TaskHook => ({
  name: 'pass-through',
  plan: (plan: TaskPlan) => plan,
  applied: () => {},
  committed: () => {},
  candidates: (q) => q,
  lapse: () => ({ action: 'expire' }),
})

export const principalOf = (user: string): string => `local:user:u_${user}`
export const ADA = principalOf('ada')
export const BO = principalOf('bo')
/** The original's deployment on the board's team: it reads, posts, and labels everywhere, and manages nothing. */
export const WEB = 'local:user:web'
/** The original's workflows: let in only where a test grants them. */
export const CI = 'local:user:ci'

export type Team = {
  board: BoardService
  store: SqliteUnifiedStore
  /** What grantCi gave the workflows: a narrowing of their token, as the original's grant is all they have. */
  ciCan: string
  callers: Map<string, CallerContext>
}

/** The query string of a path, as the original's routes read it: a repeated key is a list. */
function queryOf(search: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of search) {
    const had = out[key]
    out[key] = had === undefined ? value : Array.isArray(had) ? [...had, value] : [had, value]
  }
  return out
}

async function route(team: Team, caller: CallerContext, method: string, path: string, body: unknown): Promise<Answer> {
  const { board } = team
  const url = new URL(path, 'http://board.test')
  const query = queryOf(url.searchParams)
  const parts = url.pathname.split('/').filter(Boolean)
  const tasks = board.tasks
  const raw = body ?? {}
  const ok = (value: unknown, status = 200): Answer => ({ status, body: JSON.parse(JSON.stringify(value ?? null)) })
  if (parts[0] === 'tasks') {
    if (parts.length === 1 && method === 'POST') return ok(tasks.createTask(caller, raw), 201)
    if (parts.length === 1 && method === 'GET') return ok(tasks.listTasks(caller, query))
    if (parts[1] === 'batch' && parts.length === 2 && method === 'POST') return ok(tasks.createTasks(caller, raw), 201)
    if (parts[1] === 'batch' && parts.length === 3 && method === 'GET') return ok(tasks.getBatch(caller, parts[2]!, query))
    if (parts[1] === 'claim' && parts.length === 2 && method === 'POST') return ok(await tasks.claimReady(caller, raw))
    if (parts.length === 3 && method === 'POST') {
      const id = parts[1]!
      switch (parts[2]) {
        case 'claim':
          return ok(tasks.claimTask(caller, id, raw))
        case 'renew':
          return ok(tasks.renewTask(caller, id, raw))
        case 'release':
          return ok(tasks.releaseTask(caller, id, raw))
        case 'complete':
          return ok(tasks.completeTask(caller, id, raw))
        case 'fail':
          return ok(tasks.failTask(caller, id, raw))
        case 'block':
          return ok(tasks.blockTask(caller, id, raw))
        case 'unblock':
          return ok(tasks.unblockTask(caller, id))
        case 'reopen':
          return ok(tasks.reopenTask(caller, id))
        case 'assign':
          return ok(tasks.assignTask(caller, id, raw))
        case 'needs':
          return ok(tasks.setTaskNeeds(caller, id, raw))
        case 'cancel':
          return ok(tasks.cancelTask(caller, id, raw))
      }
    }
  }
  if (parts[0] === 'messages') {
    if (parts.length === 1 && method === 'POST') return ok(board.postMessage(caller, raw), 201)
    if (parts.length === 1 && method === 'GET') return ok(board.listChannelMessages(caller, query))
    if (parts.length === 2 && method === 'GET') return ok(board.getMessageThread(caller, parts[1]!, query))
    if (parts.length === 3 && method === 'POST') {
      const id = parts[1]!
      switch (parts[2]) {
        case 'edit':
          return ok({ message: board.editMessage(caller, id, raw) })
        case 'delete':
          return ok({ message: board.deleteMessage(caller, id, raw) })
        case 'labels':
          return ok({ message: board.labelMessage(caller, id, raw) })
      }
    }
  }
  if (parts[0] === 'threads' && method === 'GET') return ok(board.listThreads(caller, query))
  if (parts[0] === 'events' && method === 'GET') return ok(await board.getEvents(caller, query))
  if (parts[0] === 'me' && method === 'GET') return ok(board.me(caller))
  if (parts[0] === 'channels' && method === 'GET') return ok(board.listChannels(caller, query))
  throw new Error(`the adapter has no route ${method} ${path}`)
}

function caller(team: Team, user: string, headers: Record<string, string> = {}): CallerContext {
  const profile = headers['x-board-profile'] ?? null
  const can = headers['x-board-can']
  const key = JSON.stringify([user, profile, can ?? null])
  let found = team.callers.get(key)
  if (!found) {
    found =
      user === 'web'
        ? createLocalCaller({ userId: 'web', handle: 'web', profile, canHeader: can ?? '*=read,post,react,label' })
        : user === 'ci'
          ? createLocalCaller({ userId: 'ci', handle: 'ci', profile, canHeader: can ?? team.ciCan })
          : createLocalCaller({ userId: `u_${user}`, handle: `u_${user}`, owner: true, profile, ...(can !== undefined ? { canHeader: can } : {}) })
    team.callers.set(key, found)
  }
  return found
}

function callAs(team: Team, user: string, headers: Record<string, string> = {}): Call {
  return async (method, path, body) => {
    // As the original's harness, a fresh token each call: a caller made now sees grants given since.
    team.callers.delete(JSON.stringify([user, headers['x-board-profile'] ?? null, headers['x-board-can'] ?? null]))
    try {
      return await route(team, caller(team, user, headers), method, path, body)
    } catch (error) {
      const { status, payload } = toErrorPayload(error)
      return { status, body: payload }
    }
  }
}

export const person = (team: Team, user: string, headers: Record<string, string> = {}): Call => callAs(team, user, headers)
export const web = (team: Team, headers: Record<string, string> = {}): Call => callAs(team, 'web', headers)
export const ci = (team: Team, headers: Record<string, string> = {}): Call => callAs(team, 'ci', headers)

type Can = Record<string, string[]> | string[] | string
/** Lets the workflows do what `can` says, and nothing else (the original's grantCi). */
export function grantCi(team: Team, can: Can): void {
  const map: Record<string, string[]> =
    typeof can === 'object' && !Array.isArray(can) ? can : { '*': Array.isArray(can) ? can : [can] }
  team.ciCan = Object.entries(map)
    .map(([channel, perms]) => `${channel}=${perms.join(',')}`)
    .join(';')
}

export function setup(variant: Variant): { board: Team; advance(ms: number): Promise<void>; ada: Call; bo: Call; close(): void } {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  const board = new BoardService(store, { now: () => Date.now() })
  if (variant === 'pass-through') board.tasks.use(passThrough())
  // A workflow is let in nowhere until a test grants it something.
  const team: Team = { board, store, ciCan: 'none=read', callers: new Map() }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
  const advance = async (ms: number): Promise<void> => {
    await settle()
    vi.setSystemTime(Date.now() + ms)
    board.tasks.expireDueClaims()
    await settle()
  }
  return { board: team, advance, ada: person(team, 'ada'), bo: person(team, 'bo'), close: () => store.close() }
}
