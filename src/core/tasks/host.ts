// The narrow port the task engine uses to reach BoardService (M2_DESIGN 2.5.2): BoardService builds one
// from its private helpers, so the engine never reaches into the 6,000-line service directly.
import type {
  Access,
  CallerActor,
  CallerContext,
  CallerPrincipal,
  Mentioned,
  StoredMessage,
} from '../board-service.ts'
import type { Author, Labels, MessageView, Permission } from '../schemas.ts'
import type { StorageBackend, StoredEvent } from '../storage.ts'
import type { TaskEventType } from './fold.ts'

/** Who a call is by, once admitted: its caller, and the author its writes carry. */
export type Identity = {
  readonly caller: CallerContext
  readonly principal: CallerPrincipal
  readonly actor: CallerActor
  readonly author: Author
}

/** The Identity of an admitted caller: who it is, and the author its writes carry. */
export const identityOf = (caller: CallerContext): Identity => ({
  caller,
  principal: caller.principal,
  actor: caller.actor,
  author: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
})

/** One task event a verb plans to append, before the single writer folds and appends it. */
export type PlannedTaskEvent = {
  type: TaskEventType
  taskId: number
  payload: Record<string, unknown>
  /** An explicit event ID: batch creates only (2.7.4). */
  eventId?: string
}

/** What postMessageAs is asked to post: the subset of a post body a task root takes. */
export type TaskRootInput = {
  channel: string
  text: string
  labels?: Labels
  noSync?: boolean
  attachments?: string[]
  id?: string
}

/**
 * Internal option on postMessageAs. Never reachable from a transport. The three callbacks run inside
 * the post's one transaction.
 */
export interface TaskRootOption {
  /**
   * The event ID (and thread key) of the root's message.posted, for a batch root (2.7.4). A post
   * with a client `id` keeps that id; this is for roots that carry none.
   */
  readonly eventId?: string
  /**
   * Runs inside the post's transaction after M1's clientId replay check and before message.posted is
   * appended. Throws a 4xx to refuse, in which case nothing is posted. Returns the post's `along`.
   */
  prepare(tx: { now: number }): { along: 1 | 2 | 3 }
  /**
   * Runs after message.posted is saved, before its watchers are dispatched. Returns the task events,
   * which postMessageAs passes to TaskService's single writer in the same transaction.
   */
  emit(root: StoredMessage, postIndex: number): PlannedTaskEvent[]
  /** Called instead of both when M1's replay check finds an earlier post with this id by this author. */
  replay(landed: StoredMessage): void
}

/** What postRoot answers: the post's answer, the root as it is now, and whether it was a replay. */
export type PostedRoot = {
  message: MessageView
  mentions?: Mentioned[]
  root: StoredMessage
  replayed: boolean
}

export interface TaskHost {
  readonly store: StorageBackend
  /** BoardServiceOptions.now ?? Date.now. Read it after the write lock is taken. */
  now(): number
  /** requireAdmitted: resolves the caller's grants and records them for the write's re-check. */
  admit(caller: CallerContext): { identity: Identity; access: Access }
  loadMessage(id: number): StoredMessage | null
  saveMessageInTx(msg: StoredMessage, logIndex: number, isNew: boolean): void
  dispatchWatchersInTx(ev: StoredEvent, msg: StoredMessage): void
  /** upsertActorInTx; may append actor.seen. */
  actorSeenInTx(identity: Identity): void
  view(msg: StoredMessage, identity: Identity, access: Access): MessageView
  /**
   * A post as its author may have it back (M1 landedFor): null for anyone else's, or a post written
   * by a caller that could read. A blind writer gets the root as it stood at `asOf` (the last event
   * its own append wrote), its other actors' mentions masked; never what others added since.
   */
  landedFor(caller: CallerContext, access: Access, landed: StoredMessage, asOf?: number): MessageView | null
  /** ownId: refuses an id that is a UUIDv8, another principal's `key:` id, or a `sync:` id. */
  checkOwnId(principalId: string, id: string): void
  /** A handle or an ID -> the actor and principal IDs it names. */
  whoIs(value: string): Set<string>
  /** The channels where `access` has `perm`, under `scope` if given; 'all' when it has it everywhere and no scope narrows. */
  channelsWhere(access: Access, perm: Permission, scope?: { path: string; subtree: boolean }): string[] | 'all'
  systemAuthor(): Author
  /** postMessageAs with the internal taskRoot option. */
  postRoot(caller: CallerContext, input: TaskRootInput, taskRoot: TaskRootOption): PostedRoot
  /** Optional notification hook called inside commitTaskEventsInTx on task.created / task.assigned. */
  notifyTaskAssignedInTx?(ev: StoredEvent, msg: StoredMessage, forActor: string | null): void
  /**
   * Runs `fn` in the service's transaction (BoardService.tx): the outermost one re-checks, holding
   * the write lock, the grants the last admit judged by.
   */
  tx<T>(fn: () => T): T
}
