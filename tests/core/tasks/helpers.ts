// Shared setup for the task engine tests: an in-memory board on an injected clock, and the planned
// events a system transition takes.
import {
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  type PlannedTaskEvent,
  type SqliteStoreOptions,
  type StoredMessage,
} from '../../../src/core/index.ts'

export const T0 = Date.UTC(2026, 10, 23, 12, 0, 0)

export type Board = {
  store: SqliteUnifiedStore
  board: BoardService
  clock: { now: number }
  close(): void
}

export function makeBoard(options: Partial<SqliteStoreOptions> = {}): Board {
  const store = new SqliteUnifiedStore({ path: ':memory:', ...options })
  const clock = { now: T0 }
  const board = new BoardService(store, { now: () => clock.now })
  return { store, board, clock, close: () => store.close() }
}

export const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
export const AUTHOR = { actor: alice.actor.id, principal: alice.principal.id, profile: null }

export function post(b: Board, text: string, channel = 'dev'): StoredMessage {
  const { message } = b.board.postMessage(alice, { channel, text })
  return message_(b, Number(message.id))
}

export function reply(b: Board, re: number, text: string): StoredMessage {
  const { message } = b.board.postMessage(alice, { re: String(re), text })
  return message_(b, Number(message.id))
}

export function message_(b: Board, id: number): StoredMessage {
  const row = b.store.db.prepare('SELECT data FROM board_messages WHERE id = ?').get(id) as { data: string }
  return JSON.parse(row.data) as StoredMessage
}

export const eventCount = (b: Board): number =>
  Number((b.store.db.prepare('SELECT COUNT(*) AS c FROM board_events').get() as { c: number }).c)

export function created(root: StoredMessage, needs: number[] = [], assignee: string | null = null): PlannedTaskEvent {
  return { type: 'task.created', taskId: root.id, payload: { id: root.id, thread: root.thread, needs, for: assignee, by: AUTHOR } }
}

export function ev(root: StoredMessage, type: PlannedTaskEvent['type'], extra: Record<string, unknown> = {}): PlannedTaskEvent {
  return { type, taskId: root.id, payload: { id: root.id, thread: root.thread, ...extra } }
}

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)
