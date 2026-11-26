// TaskNote, SentTaskNote, SentTaskHoldKind, TaskHoldKind and ChannelOrSubtree are M1's (schemas.ts),
// the original's contract/schemas.ts:157-175 and api/routes.ts:247.
// The task request bodies and queries, ported from the original's api/routes.ts:247-405 (non-strict
// z.object: unknown keys are stripped), and the local board's own limits on them (server/tasks.ts:17-54),
// with the original's messages verbatim. The verbs (slices A2..A7) parse with these.
import { z } from 'zod'
import { badRequest, batchTooLarge } from '../errors.ts'
import {
  ActorId,
  AttachmentId,
  ChannelOrSubtree,
  ChannelPath,
  EDITED_HOLD,
  LabelFilterSchema,
  Labels,
  LEASE_CAP_S,
  LEASE_MIN_S,
  NewLabels,
  Ref,
  SentTaskHoldKind,
  SentTaskNote,
  storable,
  TASK_BATCH_MAX,
  TASK_KEY_MAX,
  TASK_NEEDS_MAX,
  TASK_NOTE_MAX,
  TaskHoldKind,
  TaskState,
} from '../schemas.ts'

/** How many owners one claim takes tasks from on this board, beside its caller (original tasks.ts:21). */
export const FROM_MAX = 32
/** How many tasks a change of what a task needs walks behind the ones it adds (original tasks.ts:87). */
export const NEEDS_WALK_MAX = 500

// The query-string flag and repeated value (original api/routes.ts:43). An in-process caller may also
// pass a JSON boolean, read as its string first, so a bad value gets the original's enum error verbatim
// (invalid_value, 'Invalid option: expected one of "0"|"1"|"true"|"false"'), never a union's.
const flag = z
  .preprocess((value) => (typeof value === 'boolean' ? String(value) : value), z.enum(['true', 'false', '1', '0']))
  .transform((value) => value === 'true' || value === '1')
const repeated = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]))

/** How long a claim holds its task, in seconds: the local board takes 30 to 3600 (taskLimits.lease). */
const Lease = z.number()

/** What a claim's own writes carry: the `epoch` and `token` its claim answered. */
const Claimed = { epoch: z.number().int().positive(), token: z.string().min(1).max(128) }

/** A caller's own claim token: 32 bytes in base64url. */
const ClaimToken = {
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'a claim token is 32 bytes in base64url: 43 characters').optional(),
}

/** POST /tasks: a new thread that's a task, or the thread `re` roots made one. */
export const CreateTaskBody = z
  .object({
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    text: z.string().optional(),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).optional(),
    needs: z.array(Ref).optional(),
    for: ActorId.nullable().optional(),
    claim: z.boolean().optional(),
    lease: Lease.optional(),
    ...ClaimToken,
    id: z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate').optional(),
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), {
    message: "a task needs `channel` and `text` for a new thread, or `re` for a thread that's there",
  })
  .refine(
    (body) => body.channel === undefined || (body.text ?? '').trim().length > 0 || (body.attachments?.length ?? 0) > 0,
    { message: 'message text is empty', path: ['text'] },
  )
  .refine((body) => body.text === undefined || storable(body.text), {
    message: 'message text has a NUL character or a lone surrogate',
    path: ['text'],
  })
  .refine(
    (body) =>
      body.re === undefined ||
      (body.text === undefined &&
        body.labels === undefined &&
        body.noSync === undefined &&
        body.attachments === undefined &&
        body.id === undefined),
    { message: "`text`, `labels`, `noSync`, `attachments`, and `id` are a new thread's: `re` makes a task of a thread as it is" },
  )
  .refine((body) => body.lease === undefined || body.claim === true, { message: '`lease` goes with `claim`', path: ['lease'] })
  .refine((body) => body.token === undefined || body.claim === true, { message: '`token` goes with `claim`', path: ['token'] })
export type CreateTaskInput = z.infer<typeof CreateTaskBody>

/** A digest of what a batch asks for: what tells the same request under an `id` from another. */
const BatchRequest = z.string().min(1).max(64)

/** A task another task of the same batch waits for, by the `key` it goes by there. */
const TaskKey = z.string().min(1).refine(storable, 'key has a NUL character or a lone surrogate')

/** POST /tasks/batch: several new threads in one channel, each a task, all of them or none. */
export const CreateTasksBody = z.object({
  channel: ChannelPath,
  tasks: z
    .array(
      z
        .object({
          key: TaskKey.optional(),
          text: z.string(),
          labels: NewLabels.optional(),
          noSync: z.boolean().optional(),
          attachments: z.array(AttachmentId).optional(),
          needs: z.array(z.union([Ref, z.object({ key: TaskKey }).strict()])).optional(),
          for: ActorId.nullable().optional(),
        })
        .refine((task) => task.text.trim().length > 0 || (task.attachments?.length ?? 0) > 0, {
          message: 'message text is empty',
          path: ['text'],
        })
        .refine((task) => storable(task.text), { message: 'message text has a NUL character or a lone surrogate', path: ['text'] }),
    )
    .min(1)
    .max(TASK_BATCH_MAX),
  id: z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate').optional(),
  request: BatchRequest.optional(),
})
export type CreateTasksInput = z.infer<typeof CreateTasksBody>

/** GET /tasks/batch/:id: `request` answers only that request under the `id`. */
export const CreatedTasksQuery = z.object({ request: BatchRequest.optional() })

/** GET /tasks: open ones unless `state` says `all` or names one. A lapsed claim counts as `ready`. */
export const TasksQuery = z
  .object({
    channel: z.string().optional(),
    state: z.union([z.enum(['open', 'all']), TaskState]).optional(),
    label: repeated.pipe(z.array(LabelFilterSchema)).optional(),
    by: z.string().optional(),
    owner: z.string().optional(),
    for: z.string().optional(),
    needs: Ref.optional(),
    after: Ref.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    latest: flag.optional(),
  })
  .refine((query) => !query.latest || query.after === undefined, {
    message: '`latest` reads every task to find the last active: it takes no `after`',
    path: ['latest'],
  })
export type TasksQueryInput = z.infer<typeof TasksQuery>

/** POST /tasks/:id/claim. */
export const ClaimTaskBody = z.object({ lease: Lease.optional(), ...ClaimToken }).optional()

/** POST /tasks/claim: the oldest ready task in `channel` that has every label in `label`. */
export const ClaimReadyTaskBody = z.object({
  channel: ChannelOrSubtree,
  label: Labels.optional(),
  from: z.array(z.string().min(1).max(256)).optional(),
  lease: Lease.optional(),
  wait: z.number().min(0).max(300).optional(),
  ...ClaimToken,
})

export const RenewTaskBody = z.object({ ...Claimed, lease: Lease.optional() })
export const ReleaseTaskBody = z.object(Claimed)
export const CompleteTaskBody = z.object({ ...Claimed, result: SentTaskNote.optional() })
export const FailTaskBody = z.object({ ...Claimed, reason: SentTaskNote })
/** A hold for a person; a claimed task's comes from its claim. Kind `edited` is the board's own. */
export const BlockTaskBody = z
  .object({
    reason: SentTaskNote,
    kind: SentTaskHoldKind.refine(
      (kind) => kind !== EDITED_HOLD,
      "`edited` is the board's own kind, for a task whose root someone else edited: name another",
    ).optional(),
    epoch: Claimed.epoch.optional(),
    token: Claimed.token.optional(),
  })
  .refine((body) => (body.epoch === undefined) === (body.token === undefined), {
    message: 'a claim is its `epoch` and its `token`: pass both, or neither',
  })
export const AssignTaskBody = z.object({ for: ActorId.nullable() })
export const TaskNeedsBody = z.object({ needs: z.array(Ref) })
export const CancelTaskBody = z.object({ reason: SentTaskNote })

/**
 * This board's own limits on a task (original server/tasks.ts:24-54): what's over one is refused as a
 * misshapen request is, 400 `invalid_request`, before anything is read or written.
 */
export const taskLimits = {
  lease(seconds: number | undefined): void {
    if (seconds !== undefined && !(seconds >= LEASE_MIN_S && seconds <= LEASE_CAP_S)) {
      throw badRequest(`lease: a lease is ${LEASE_MIN_S} to ${LEASE_CAP_S} seconds`)
    }
  },
  needs(refs: readonly string[] | undefined): void {
    if (new Set(refs).size > TASK_NEEDS_MAX) throw badRequest(`needs: a task waits for at most ${TASK_NEEDS_MAX} tasks`)
  },
  note(what: 'result' | 'reason', note: string | null | undefined): void {
    if (typeof note === 'string' && note.length > TASK_NOTE_MAX) {
      throw badRequest(`${what}: a task's ${what} is at most ${TASK_NOTE_MAX.toLocaleString('en-US')} characters`)
    }
  },
  kind(kind: string | undefined): void {
    if (kind !== undefined && !TaskHoldKind.safeParse(kind).success) {
      throw badRequest('kind: a kind is up to 64 lowercase letters, numbers, and _.-')
    }
  },
  from(owners: readonly string[] | undefined): void {
    if ((owners?.length ?? 0) > FROM_MAX) throw badRequest(`from: a claim takes tasks from at most ${FROM_MAX} owners`)
  },
  /** A batch: how many tasks this board makes in one write, and of each what one task holds. */
  batch(tasks: readonly { key?: string | undefined; needs?: readonly (string | { key: string })[] | undefined }[]): void {
    if (tasks.length > TASK_BATCH_MAX) throw batchTooLarge(tasks.length, TASK_BATCH_MAX)
    for (const [at, task] of tasks.entries()) {
      if (task.key !== undefined && task.key.length > TASK_KEY_MAX) {
        throw badRequest(`tasks.${at}.key: a task's key is at most ${TASK_KEY_MAX} characters`)
      }
      const waits = new Set(task.needs?.map((need) => (typeof need === 'string' ? `id ${need}` : `key ${need.key}`)))
      if (waits.size > TASK_NEEDS_MAX) throw badRequest(`tasks.${at}.needs: a task waits for at most ${TASK_NEEDS_MAX} tasks`)
    }
  },
}
