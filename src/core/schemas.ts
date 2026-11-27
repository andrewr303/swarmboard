import { z } from 'zod'

// ============================================================================
// Baseline @vercel/board v0.54.0 Constants & Primitives
// ============================================================================

export const CHANNEL_PATH_MAX = 2048
export const CHANNEL_PATTERN_MAX = CHANNEL_PATH_MAX + 1
export const MESSAGE_TEXT_MAX = 10_000
export const CAN_MAX = 4000
export const ATTACHMENTS_PER_MESSAGE_MAX = 10
export const LINKS_PER_MESSAGE_MAX = 10
export const MENTIONED_PER_MESSAGE_MAX = 50
export const RESERVED_LABEL_PREFIX = 'board.'
export const TASK_LABEL = 'board.task'
export const EDITED_HOLD = 'edited'
export const TASK_NEEDS_MAX = 20
export const TASK_BATCH_MAX = 100
export const TASK_KEY_MAX = 64
export const TASK_NOTE_MAX = 1000
export const LABEL_KEY_MAX = 64
export const LABEL_VALUE_MAX = 256
export const LABEL_CONDITIONS_MAX = 16
/**
 * The values one search label condition may offer (`state=a|b|...`). Each is an SQL variable, so
 * 16 conditions of this many stay far below SQLite's limit on them, and a filter too large is the
 * request's 400 rather than a store failure.
 */
export const LABEL_FILTER_VALUES_MAX = 64
export const LEASE_MIN_S = 30
export const LEASE_DEFAULT_S = 900
export const LEASE_CAP_S = 3600
export const GRANT_BATCH_MAX = 16
export const REGISTERED_WATCHERS_MAX = 64
export const SCHEMAS_MAX = 500
export const CHANNELS_LIMIT_DEFAULT = 100
export const CHANNELS_LIMIT_MAX = 500
export const THREADS_LIMIT_DEFAULT = 50
export const THREADS_LIMIT_MAX = 500
/** A channel's messages a read lists when it names no limit (original a2.ts:524). */
export const CHANNEL_MESSAGES_LIMIT_DEFAULT = 50
export const EVENTS_LAST_MAX = 100
/** Events a feed read examines per page of the log (original server/feed.ts:494 PAGE). */
export const EVENTS_PAGE = 200
/** Pages of the log a `last` read looks back through at most (original server/feed.ts:496 LAST_PAGES). */
export const EVENTS_LAST_PAGES = 10
export const INBOX_EVENT_ID_MAX = 300
export const ACTORS_BY_ID_MAX = 100

export const ATTACHMENT_BYTES_MAX = 4 * 1024 * 1024
export const IMPORT_BYTES_MAX = 25 * 1024 * 1024
export const DIRECT_UPLOAD_BYTES_MAX = 100 * 1024 * 1024

export const PERMISSIONS = ['read', 'post', 'react', 'label', 'sync', 'manage'] as const
export const PermissionSchema = z.enum(PERMISSIONS)
export type Permission = z.infer<typeof PermissionSchema>

const segment = '[a-z0-9][a-z0-9_-]*'

export const ChannelPath = z
  .string()
  .max(CHANNEL_PATH_MAX)
  .regex(new RegExp(`^${segment}(?:/${segment})*$`), 'invalid channel path')
export type ChannelPath = z.infer<typeof ChannelPath>

export const ChannelOrSubtree = z
  .string()
  .max(CHANNEL_PATTERN_MAX)
  .regex(
    new RegExp(`^${segment}(?:/${segment})*/?$`),
    'name a channel, or a channel and its subtree (work/)',
  )

export const storable = (value: string): boolean => !value.includes('\u0000') && value.isWellFormed()
export const toStorable = (value: string): string => value.replaceAll('\u0000', '').toWellFormed()

export const SentText = z
  .string()
  .refine((text) => text.trim().length > 0, 'message text is empty')
  .refine(storable, 'message text has a NUL character or a lone surrogate')

export const MessageText = z
  .string()
  .max(MESSAGE_TEXT_MAX)
  .refine((text) => text.trim().length > 0, 'message text is empty')
  .refine(storable, 'message text has a NUL character or a lone surrogate')

export const Ref = z.string().min(1).max(128)
export const Revision = z.number().int().positive()
export const MessageId = z.number().int().positive()
export type MessageId = z.infer<typeof MessageId>

const INHERITED = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype', '__proto__'])
const notInherited = (name: string): boolean => !INHERITED.has(name)

/**
 * Whether a record has a key that names something every object inherits and that its own key
 * schema would let through. `__proto__` always counts: z.record drops it without a word (the
 * original's v0.54.0 answers `{}` for it), so it is refused here instead. Any other inherited name
 * the key schema refuses by itself (`toString` as a label key) is left to z.record, which answers
 * it in the key's own words, as the original does.
 */
function hasForbiddenRecordKey(value: unknown, keySchema: z.ZodType): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) return true
  for (const name of Object.getOwnPropertyNames(value)) {
    if (INHERITED.has(name) && keySchema.safeParse(name).success) return true
  }
  return false
}

/** What a label record with a key like `__proto__` is told: the label key's own words (original contract/schemas.ts:80). */
const LABEL_KEY_RESERVED = 'label key is a reserved name'

function safeRecord<K extends z.core.$ZodRecordKey, V extends z.core.$ZodType>(
  keySchema: K,
  valueSchema: V,
  reserved = 'record key is a reserved prototype name',
): z.ZodType<z.infer<z.ZodRecord<K, V>>, z.input<z.ZodRecord<K, V>>> {
  return z.preprocess((value, ctx) => {
    if (hasForbiddenRecordKey(value, keySchema as unknown as z.ZodType)) {
      ctx.addIssue({
        code: 'custom',
        message: reserved,
      })
      return z.NEVER
    }
    return value
  }, z.record(keySchema, valueSchema)) as unknown as z.ZodType<
    z.infer<z.ZodRecord<K, V>>,
    z.input<z.ZodRecord<K, V>>
  >
}

const notALabelKey = (issue: { input?: unknown }): string =>
  `${JSON.stringify(String(issue.input))} isn't a label key: one is 1 to ${LABEL_KEY_MAX} lowercase letters, numbers, ., _, and -, starting with a letter or number`

export const LabelKey = z
  .string()
  .max(LABEL_KEY_MAX, { error: notALabelKey })
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, { error: notALabelKey })
  .refine(notInherited, 'label key is a reserved name')

export const LabelValue = z
  .string()
  .max(LABEL_VALUE_MAX, {
    error: (issue) =>
      `a label value is at most ${LABEL_VALUE_MAX} characters, and this one has ${String(issue.input).length}`,
  })
  .refine(storable, 'label value has a NUL character or a lone surrogate')

export const Labels = safeRecord(LabelKey, LabelValue, LABEL_KEY_RESERVED)
export type Labels = z.infer<typeof Labels>

export const NewLabelValue = LabelValue.refine(
  (value) => !/\p{Cc}/u.test(value),
  'label value has a control character',
)
export const NewLabels = safeRecord(LabelKey, NewLabelValue, LABEL_KEY_RESERVED)

export const Emoji = z
  .string()
  .max(64)
  .regex(/^[a-z0-9_+-]+$/, 'invalid emoji name')
  .refine(notInherited, 'emoji name is a reserved name')

export const ActorId = z.string().min(1).max(256)
export type ActorId = z.infer<typeof ActorId>

export const ActorKind = z.enum(['person', 'agent', 'deployment', 'workflow', 'external'])
export type ActorKind = z.infer<typeof ActorKind>

export const SeenActorKind = z.union([ActorKind, z.literal('profile')])
export const actorKind = (kind: z.infer<typeof SeenActorKind>): ActorKind =>
  kind === 'profile' ? 'agent' : kind

export const Handle = z
  .string()
  .min(1)
  .max(128)
  .refine(storable, 'handle has a NUL character or a lone surrogate')

export function platformAvatar(avatar: string | null): string | null {
  if (avatar === null) return null
  try {
    return new URL(avatar).protocol === 'https:' ? avatar : null
  } catch {
    return null
  }
}

export const AuthorSchema = z.object({
  actor: ActorId,
  principal: z.string().min(1),
  profile: z.string().nullable(),
})
export type Author = z.infer<typeof AuthorSchema>
export const Author = AuthorSchema

export const AttachmentId = z
  .string()
  .regex(
    /^(?:[A-Za-z0-9_-]{22}|att_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    'invalid attachment id',
  )

export const AttachmentSchema = z.object({
  id: AttachmentId,
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
})
export type Attachment = z.infer<typeof AttachmentSchema>
export const Attachment = AttachmentSchema

export const UploadTicketSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string().min(1),
})
export type UploadTicket = z.infer<typeof UploadTicketSchema>

export const TaskStateSchema = z.enum([
  'waiting',
  'ready',
  'claimed',
  'blocked',
  'completed',
  'failed',
  'canceled',
])
export type TaskState = z.infer<typeof TaskStateSchema>
export const TaskState = TaskStateSchema

export const OPEN_TASK_STATES = [
  'waiting',
  'ready',
  'claimed',
  'blocked',
] as const satisfies readonly TaskState[]

export const TaskNote = z
  .string()
  .max(TASK_NOTE_MAX)
  .refine((text) => text.trim().length > 0, 'it is empty')
  .refine(storable, 'it has a NUL character or a lone surrogate')

export const SentTaskNote = z
  .string()
  .refine((text) => text.trim().length > 0, 'it is empty')
  .refine(storable, 'it has a NUL character or a lone surrogate')

export const SentTaskHoldKind = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, 'a kind is lowercase letters, numbers, and _.-')

export const TaskHoldKind = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'a kind is up to 64 lowercase letters, numbers, and _.-')

export const RemoteWatcherId = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9-]{0,31}$/,
    'ids start with a letter and use up to 32 letters, numbers, and hyphens',
  )

// ============================================================================
// External / Sync Wire Types
// ============================================================================

export const ExternalTarget = z.string().min(3).max(300)

export const OriginSchema = z.object({
  channel: ExternalTarget.optional(),
  thread: ExternalTarget,
  subthread: ExternalTarget.nullable(),
  message: z.string().min(1).max(300),
  context: z.string().max(300).nullable(),
})
export type Origin = z.infer<typeof OriginSchema>

export const LinkSnapshotSchema = z.object({
  author: z.string().min(1).max(256),
  text: z.string().max(MESSAGE_TEXT_MAX),
  createdAt: z.string().max(64).nullable(),
  files: z
    .array(z.object({ name: z.string().min(1).max(1000), url: z.string().max(4000).nullable() }))
    .max(20),
})
export type LinkSnapshot = z.infer<typeof LinkSnapshotSchema>

export const LinkViewSchema = z.object({
  url: z.string().min(1).max(4000),
  message: Ref.nullable(),
  snapshot: LinkSnapshotSchema.nullable(),
  unavailable: z.string().max(300).nullable(),
})
export type LinkView = z.infer<typeof LinkViewSchema>

export const ExternalCopySchema = z.object({
  thread: z.string(),
  message: z.string(),
  files: z.array(z.string()).nullable().optional(),
  by: z.string().optional(),
})
export type ExternalCopy = z.infer<typeof ExternalCopySchema>

export const ExternalAuthorSchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  name: z.string().min(1),
  avatar: z.string().nullable(),
  isBot: z.boolean(),
})
export type ExternalAuthor = z.infer<typeof ExternalAuthorSchema>

export const ExternalFileSchema = z.object({
  type: z.enum(['image', 'file', 'video', 'audio']),
  name: z.string().max(1000).optional(),
  mimeType: z.string().max(255).optional(),
  size: z.number().int().nonnegative().optional(),
  url: z.string().max(4000).optional(),
  fetchMetadata: z.record(z.string(), z.string().max(4000)).optional(),
})

export const ExternalLinkSchema = z.object({
  url: z.string().min(1).max(4000),
  thread: ExternalTarget,
  message: z.string().min(1).max(300),
  snapshot: LinkSnapshotSchema.nullable(),
})

const ExternalLocationShape = {
  channel: ExternalTarget,
  thread: ExternalTarget,
  subthread: ExternalTarget.nullable(),
}

export const ExternalEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    ...ExternalLocationShape,
    message: z.string(),
    isRoot: z.boolean(),
    text: z.string(),
    context: z.string().nullable(),
    author: ExternalAuthorSchema,
    files: z.array(ExternalFileSchema).max(20).optional(),
    links: z.array(ExternalLinkSchema).max(LINKS_PER_MESSAGE_MAX).optional(),
    mentioned: z.array(ExternalAuthorSchema).max(MENTIONED_PER_MESSAGE_MAX).optional(),
  }),
  z.object({
    kind: z.literal('edited'),
    ...ExternalLocationShape,
    message: z.string(),
    text: z.string(),
    author: ExternalAuthorSchema,
    links: z.array(ExternalLinkSchema).max(LINKS_PER_MESSAGE_MAX).optional(),
    linksOnly: z.boolean().optional(),
    mentioned: z.array(ExternalAuthorSchema).max(MENTIONED_PER_MESSAGE_MAX).optional(),
  }),
  z.object({
    kind: z.literal('deleted'),
    ...ExternalLocationShape,
    message: z.string(),
  }),
  z.object({
    kind: z.literal('reaction'),
    ...ExternalLocationShape,
    message: z.string(),
    emoji: z.string(),
    added: z.boolean(),
    author: ExternalAuthorSchema,
  }),
  z.object({
    kind: z.literal('lifecycle'),
    channel: ExternalTarget,
    thread: ExternalTarget,
    type: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    body: z.string().nullable().optional(),
    labels: z.record(z.string(), z.string()),
    unset: z.array(z.string()),
    owns: z.array(z.string()).optional(),
    reply: z.string().nullable(),
    createRoot: z.boolean(),
    retitled: z.boolean().optional(),
    author: ExternalAuthorSchema,
  }),
])
export type ExternalEvent = z.infer<typeof ExternalEventSchema>

// ============================================================================
// Baseline @vercel/board v0.54.0 Wire Entity Schemas
// ============================================================================

export const CHANNEL_KINDS = ['chat', 'forum', 'tasks', 'dm', 'announcements'] as const
export const ChannelKindSchema = z.enum(CHANNEL_KINDS)
export type ChannelKind = z.infer<typeof ChannelKindSchema>

export const ASSURANCE_LEVELS = ['human_verified', 'agent_delegated', 'local_unverified'] as const
export const AssuranceSchema = z.enum(ASSURANCE_LEVELS)
export type Assurance = z.infer<typeof AssuranceSchema>

export const ChannelViewSchema = z.object({
  path: ChannelPath,
  lastIndex: z.number().int().nonnegative().optional(),
  messages: z.number().int().nonnegative().optional(),
  threads: z.number().int().nonnegative().optional(),
  // v2 additive metadata fields (omitted on untouched v1 channels unless includeMeta=true)
  category: z.string().nullable().optional(),
  parent: ChannelPath.nullable().optional(),
  topic: z.string().nullable().optional(),
  kind: ChannelKindSchema.optional(),
  archived: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  repo: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  private: z.boolean().optional(),
  pinnedCount: z.number().int().nonnegative().optional(),
  unreadCount: z.number().int().nonnegative().optional(),
})
export type ChannelView = z.infer<typeof ChannelViewSchema>

export const ChannelsPageSchema = z.object({
  channels: z.array(ChannelViewSchema),
  cursor: z.string(),
  next: z.string().nullable(),
})
export type ChannelsPage = z.infer<typeof ChannelsPageSchema>

export const ViaSchema = z.object({
  name: z.string().min(1),
  environment: z.string().nullable().optional(),
})
export type Via = z.infer<typeof ViaSchema>

export const ActorViewSchema = z.object({
  kind: ActorKind,
  handle: z.string().min(1),
  name: z.string().min(1),
  avatar: z.string().nullable(),
  via: ViaSchema.optional(),
  platform: z.string().optional(),
  verified: z.literal(true).optional(),
})
export type ActorView = z.infer<typeof ActorViewSchema>

export const BlockViewSchema = z.object({
  schema: z.string().min(1),
  version: z.number().int().positive(),
  data: z.record(z.string(), z.unknown()),
})
export type BlockView = z.infer<typeof BlockViewSchema>

export const TaskClaimSchema = z.object({
  epoch: z.number().int().positive(),
  token: z.string().min(1),
  until: z.string().min(1),
})
export type TaskClaim = z.infer<typeof TaskClaimSchema>

export const TaskViewSchema = z.object({
  state: TaskStateSchema,
  owner: z.string().min(1),
  by: z.string().min(1),
  for: z.string().nullable(),
  needs: z.array(Ref),
  epoch: z.number().int().nonnegative(),
  claim: z.object({ actor: z.string().min(1), until: z.string().min(1) }).nullable(),
  blocked: z.object({ kind: z.string().nullable(), reason: z.string() }).nullable(),
  result: z.string().nullable(),
  reason: z.string().nullable(),
})
export type TaskView = z.infer<typeof TaskViewSchema>

export const QuoteViewSchema = z.object({
  id: Ref,
  channel: ChannelPath,
  by: ActorId,
  handle: z.string().nullable(),
  excerpt: z.string(),
  createdAt: z.string(),
})
export type QuoteView = z.infer<typeof QuoteViewSchema>

export const MessageViewSchema = z.object({
  id: Ref,
  channel: ChannelPath,
  text: z.string(),
  re: Ref.nullable(),
  replyTo: Ref.nullable(),
  thread: z.string().min(1),
  labels: Labels,
  reactions: safeRecord(Emoji, z.array(z.string()), 'emoji name is a reserved name'),
  by: AuthorSchema,
  noSync: z.boolean(),
  origin: OriginSchema.nullable(),
  from: z.string().nullable(),
  createdAt: z.string().min(1),
  editedAt: z.string().nullable(),
  deleted: z.boolean(),
  undelivered: safeRecord(z.string(), z.string()),
  attachments: z.array(AttachmentSchema),
  links: z.array(LinkViewSchema),
  quote: QuoteViewSchema.optional(),
  schedule: z.object({ id: Ref, n: z.number().int().nonnegative() }).optional(),
  task: TaskViewSchema.optional(),
  blind: z.literal(true).optional(),
  version: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  author: ActorViewSchema.nullable(),
  blocks: z.array(BlockViewSchema),
})
export type MessageView = z.infer<typeof MessageViewSchema>

export const MessagesPageSchema = z.object({
  messages: z.array(MessageViewSchema),
  cursor: z.string(),
})
export type MessagesPage = z.infer<typeof MessagesPageSchema>

export const ScheduleViewSchema = z.object({
  id: Ref,
  channel: ChannelPath,
  re: Ref.nullable(),
  text: z.string(),
  labels: Labels,
  noSync: z.boolean(),
  attachments: z.array(AttachmentSchema),
  first: z.string(),
  every: z.number().int().positive().nullable(),
  until: z.string().nullable(),
  times: z.number().int().positive().nullable(),
  sent: z.number().int().nonnegative(),
  next: z.string().nullable(),
  last: Ref.nullable(),
  state: z.enum(['pending', 'done', 'canceled']),
  canceled: z
    .object({
      by: AuthorSchema,
      reason: z.enum(['canceled', 'thread_deleted', 'dropped', 'revoked']),
    })
    .nullable(),
  by: AuthorSchema,
  author: ActorViewSchema,
  createdAt: z.string(),
})
export type ScheduleView = z.infer<typeof ScheduleViewSchema>

export const ThreadViewSchema = z.object({
  message: MessageViewSchema,
  replies: z.array(MessageViewSchema),
  cursor: z.string(),
  schedules: z.array(ScheduleViewSchema).optional(),
})
export type ThreadView = z.infer<typeof ThreadViewSchema>

export const ThreadPinBadgeSchema = z.object({
  scope: z.enum(['announcement', 'channel']),
  note: z.string().nullable(),
  pinnedBy: z.string(),
  pinnedAt: z.string(),
})
export type ThreadPinBadge = z.infer<typeof ThreadPinBadgeSchema>

export const ThreadSummaryViewSchema = z.object({
  message: MessageViewSchema,
  replies: z.number().int().nonnegative(),
  last: MessageViewSchema.nullable(),
  pin: ThreadPinBadgeSchema.optional(),
  participants: z.array(z.string()).optional(),
})
export type ThreadSummaryView = z.infer<typeof ThreadSummaryViewSchema>

export const ThreadsPageSchema = z.object({
  threads: z.array(ThreadSummaryViewSchema),
  cursor: z.string(),
  older: z.string().nullable().optional(),
  scanned: z.number().int().nonnegative().optional(),
})
export type ThreadsPage = z.infer<typeof ThreadsPageSchema>

export const TasksPageSchema = z.object({
  tasks: z.array(ThreadSummaryViewSchema),
  cursor: z.string(),
})
export type TasksPage = z.infer<typeof TasksPageSchema>

// Grants & Access Views
const ClaimValue = z.string().min(1).max(1000)
const Environments = z.array(z.string().min(1).max(100)).min(1).max(16)

export const PrincipalInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('user'),
    email: z.string().min(3).max(320).optional(),
    userId: z.string().min(1).max(200).optional(),
  }),
  z.strictObject({
    kind: z.literal('project'),
    project: z.string().min(1).max(200),
    environments: Environments.optional(),
  }),
  z.strictObject({
    kind: z.literal('github'),
    repository: z.string().min(3).max(200),
    workflow: z.string().min(1).max(300).optional(),
    branch: z.string().min(1).max(255).optional(),
    event: z.string().min(1).max(64).optional(),
  }),
  z.strictObject({
    kind: z.literal('oidc'),
    issuer: z.string().min(1).max(1000),
    claims: safeRecord(
      z.string().min(1).max(200),
      z.union([ClaimValue, z.array(ClaimValue).min(1).max(32)]),
    ),
  }),
  z.strictObject({ kind: z.literal('all-users') }),
  z.strictObject({ kind: z.literal('all-projects'), environments: Environments.optional() }),
  z.strictObject({ kind: z.literal('app'), app: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal('all-apps') }),
  z.strictObject({ kind: z.literal('everyone') }),
])
export type PrincipalInput = z.input<typeof PrincipalInputSchema>

export const PrincipalViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string(), email: z.string().nullable() }),
  z.object({
    kind: z.literal('project'),
    projectId: z.string(),
    name: z.string().nullable(),
    environments: z.array(z.string()),
    teamId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('github'),
    repositoryId: z.string().nullable(),
    repository: z.string(),
    workflow: z.string().optional(),
    branch: z.string().optional(),
    event: z.string().optional(),
  }),
  z.object({
    kind: z.literal('oidc'),
    issuer: z.string(),
    claims: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),
  z.object({ kind: z.literal('all-users') }),
  z.object({ kind: z.literal('all-projects'), environments: z.array(z.string()) }),
  z.object({ kind: z.literal('app'), clientId: z.string(), name: z.string().nullable() }),
  z.object({ kind: z.literal('all-apps') }),
  z.object({ kind: z.literal('everyone') }),
])
export type PrincipalView = z.infer<typeof PrincipalViewSchema>

export const CanGrantInputSchema = z.union([
  z.literal('all'),
  z.array(z.string().min(1).max(16)).max(8),
])
export const GrantCanInputSchema = safeRecord(
  z.string().min(1).max(CHANNEL_PATTERN_MAX),
  CanGrantInputSchema,
)

export const GrantCanViewSchema = safeRecord(
  z.string(),
  z.union([z.literal('all'), z.array(PermissionSchema)]),
)
export type GrantCan = z.infer<typeof GrantCanViewSchema>

export const GrantViewSchema = z.object({
  id: z.string().min(1),
  principals: z.array(PrincipalViewSchema),
  can: GrantCanViewSchema,
  capped: z.boolean(),
  by: z.string().nullable(),
  at: z.string().nullable(),
})
export type GrantView = z.infer<typeof GrantViewSchema>

export const ExplanationSchema = z.object({
  channel: z.string().min(1),
  pattern: z.string().nullable(),
  over: z.array(z.string()),
  level: z.enum(['principal', 'group', 'everyone']).nullable(),
  grants: z.array(GrantViewSchema),
  capped: z.string().nullable(),
  can: z.array(PermissionSchema),
})
export type Explanation = z.infer<typeof ExplanationSchema>

// Events Views
export const BoardEventViewSchema = z.object({
  cursor: Ref,
  type: z.string().min(1),
  createdAt: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  message: MessageViewSchema.optional(),
  actor: ActorViewSchema.extend({ id: z.string().min(1) }).optional(),
})
export type BoardEventView = z.infer<typeof BoardEventViewSchema>

export const EventsPageSchema = z.object({
  events: z.array(BoardEventViewSchema),
  cursor: z.string(),
})
export type EventsPage = z.infer<typeof EventsPageSchema>

// Data Schemas Views
export const SchemaViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().nullable(),
  schema: z.record(z.string(), z.unknown()),
  builtIn: z.boolean(),
  by: z.string().nullable(),
  at: z.string().nullable(),
})
export type SchemaView = z.infer<typeof SchemaViewSchema>

// Watchers Views
const RegistrationBaseSchema = z.object({
  owner: z.string().min(1),
  watch: z.record(z.string(), z.object({ tail: z.string() })),
  sync: z.array(z.object({ key: z.string(), platform: z.string() })),
  hash: z.string().min(1),
})

export const RegistrationViewSchema = z.union([
  RegistrationBaseSchema.extend({
    url: z.string().nullable(),
    path: z.undefined().optional(),
    branch: z.undefined().optional(),
  }),
  RegistrationBaseSchema.extend({
    url: z.null(),
    path: z.string().min(1),
    branch: z.string().optional(),
  }),
])
export type RegistrationView = z.infer<typeof RegistrationViewSchema>

export const MatchViewSchema = z.object({
  id: z.string().min(1),
  watcher: z.string().min(1),
  thread: z.string().min(1),
  lease: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  event: BoardEventViewSchema,
})
export type MatchView = z.infer<typeof MatchViewSchema>

// Sync Views
export const SyncedViewSchema = z.object({
  targets: z.array(
    z.object({
      target: z.string(),
      key: z.string(),
      thread: z.string().nullable(),
      message: z.string().nullable(),
      url: z.string().nullable(),
      undelivered: z.string().nullable(),
    }),
  ),
})
export type SyncedView = z.infer<typeof SyncedViewSchema>

export const SyncThreadViewSchema = z.object({
  thread: z.string(),
  root: z.string(),
  channel: z.string(),
  targets: z.array(z.string()),
  external: z.record(z.string(), z.string()),
})
export type SyncThreadView = z.infer<typeof SyncThreadViewSchema>

export const SyncFindViewSchema = z.object({
  thread: z.string().nullable(),
  message: z.string().nullable(),
})
export type SyncFindView = z.infer<typeof SyncFindViewSchema>

export const SyncCopiesViewSchema = z.object({
  copies: z.record(z.string(), z.record(z.string(), ExternalCopySchema)),
})
export type SyncCopiesView = z.infer<typeof SyncCopiesViewSchema>

export const InboxItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  thread: z.string(),
  lease: z.string(),
  attempt: z.number().int().nonnegative(),
  event: ExternalEventSchema,
  raw: z.unknown(),
})
export type InboxItem = z.infer<typeof InboxItemSchema>

export const InboxEntrySchema = z.object({
  id: z.string(),
  channel: z.string(),
  createdAt: z.string(),
  sync: z.string(),
  event: z.object({ kind: z.string(), thread: z.string() }).passthrough(),
  raw: z.unknown(),
})
export type InboxEntry = z.infer<typeof InboxEntrySchema>

// ============================================================================
// Baseline @vercel/board Input & Query Schemas
// ============================================================================

// The query-string option first: a value neither takes is reported as the original's flag reports
// it, `Invalid option: expected one of ...` (original api/routes.ts:43). A boolean is taken too, for
// in-process callers.
const flag = z
  .union([z.enum(['true', 'false', '1', '0']), z.boolean()])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true' || value === '1'))

const repeated = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]))

export const LabelFilterSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]*(=.*)?$/, 'label filters look like key, key=value, or key=a|b')
  .transform((value) => {
    const at = value.indexOf('=')
    return at === -1
      ? ([value, null] as readonly [string, readonly string[] | null])
      : ([value.slice(0, at), value.slice(at + 1).split('|')] as readonly [
          string,
          readonly string[] | null,
        ])
  })

export const ResolvedSyncTargetSchema = z.object({
  target: ExternalTarget,
  kind: z.enum(['channel', 'thread']),
})

export const FiltersSchema = z.object({
  channel: z.string().optional(),
  re: Ref.optional(),
  by: z.string().optional(),
  mentions: z.string().optional(),
  // Bounded like the search filter (LABEL_CONDITIONS_MAX conditions, LABEL_FILTER_VALUES_MAX values each):
  // a filter too large for SQLite is the request's 400, never SQLite's own 500.
  label: repeated
    .pipe(z.array(LabelFilterSchema).max(LABEL_CONDITIONS_MAX))
    .refine(
      (filters) => filters.every(([, values]) => values === null || values.length <= LABEL_FILTER_VALUES_MAX),
      `a label filter offers at most ${LABEL_FILTER_VALUES_MAX} values`,
    )
    .optional(),
  from: z.string().min(1).max(165).optional(),
  text: z.string().min(1).max(200).optional(),
})
export type ParsedFilters = z.output<typeof FiltersSchema>

const ChannelMetaInputShape = {
  category: z.string().min(1).max(200).nullable().optional(),
  parent: ChannelPath.nullable().optional(),
  topic: z.string().max(500).refine(storable).nullable().optional(),
  kind: ChannelKindSchema.optional(),
  archived: z.boolean().optional(),
  sortOrder: z.number().int().min(-10000).max(10000).optional(),
  repo: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i).nullable().optional(),
  sessionId: z.string().min(1).max(128).nullable().optional(),
  private: z.boolean().optional(),
}

// Additive on CreateChannelBodySchema: when NO metadata fields are sent, response stays byte-identical to v1.
export const CreateChannelBodySchema = z.strictObject({
  path: ChannelPath,
  ...ChannelMetaInputShape,
  members: z.array(z.string().min(1).max(256)).max(64).optional(),
})
export type CreateChannelInput = z.input<typeof CreateChannelBodySchema>

export const UpdateChannelBodySchema = z
  .strictObject({
    path: ChannelPath,
    ...ChannelMetaInputShape,
    addMembers: z.array(z.string().min(1).max(256)).max(64).optional(),
    removeMembers: z.array(z.string().min(1).max(256)).max(64).optional(),
  })
  .refine(
    (b) => Object.entries(b).some(([k, v]) => k !== 'path' && v !== undefined),
    'provide at least one channel metadata field to update',
  )
export type UpdateChannelInput = z.input<typeof UpdateChannelBodySchema>

export const ChannelsQuerySchema = z.strictObject({
  prefix: z.string().min(1).max(501).optional(),
  after: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(CHANNELS_LIMIT_MAX).optional(),
  kind: ChannelKindSchema.optional(),
  archived: z.union([z.boolean(), z.enum(['true', 'false', 'all'])]).optional(),
  repo: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  includeMeta: flag.optional(),
})
export type ChannelsQueryInput = z.input<typeof ChannelsQuerySchema>

export const ChannelTreeQuerySchema = z.strictObject({
  prefix: z.string().min(1).max(501).optional(),
  kind: ChannelKindSchema.optional(),
  archived: z.union([z.boolean(), z.enum(['true', 'false', 'all'])]).optional(),
  includeUnread: flag.optional(),
})
export type ChannelTreeQueryInput = z.input<typeof ChannelTreeQuerySchema>

export const EnsureDmBodySchema = z.strictObject({
  peer: z.string().min(1).max(256),
  topic: z.string().max(500).refine(storable).optional(),
})
export type EnsureDmInput = z.input<typeof EnsureDmBodySchema>

export interface ChannelTreeNode {
  readonly path: string
  readonly segment: string
  readonly virtual: boolean
  readonly channel: ChannelView | null
  readonly unreadCount: number
  readonly totalMessages: number
  readonly children: readonly ChannelTreeNode[]
}

export interface ChannelTreePage {
  readonly tree: readonly ChannelTreeNode[]
  readonly cursor: string
}

export const ChannelMessagesQuerySchema = z.strictObject({
  channel: ChannelPath,
  after: Ref.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
export type ChannelMessagesQueryInput = z.input<typeof ChannelMessagesQuerySchema>

export const ActorsQuerySchema = z.strictObject({
  id: repeated.pipe(z.array(z.string().min(1).max(300)).min(1).max(ACTORS_BY_ID_MAX)).optional(),
})
export type ActorsQueryInput = z.input<typeof ActorsQuerySchema>

export const ThreadQuerySchema = z.strictObject({
  after: Ref.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
export type ThreadQueryInput = z.input<typeof ThreadQuerySchema>

export const ThreadsQuerySchema = FiltersSchema.extend({
  after: Ref.optional(),
  before: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(THREADS_LIMIT_MAX).optional(),
  order: z.enum(['chronological', 'forum']).optional(),
  pinnedFirst: flag.optional(),
  includeMeta: flag.optional(),
}).refine((query) => query.before === undefined || query.after === undefined, {
  message: "`before` pages back from a page's `older`, and `after` reads forward: pass one",
  path: ['before'],
})
export type ThreadsQueryInput = z.input<typeof ThreadsQuerySchema>

export const EventsQuerySchema = FiltersSchema.extend({
  after: Ref.optional(),
  wait: z.coerce.number().min(0).max(300).optional(),
  all: flag.optional(),
  last: z.coerce.number().int().min(1).max(EVENTS_LAST_MAX).optional(),
  /** `org` adds org-session events (M2_DESIGN 2.6), with `all` and for a reader of every channel only. */
  include: z.enum(['org']).optional(),
}).refine((query) => query.last === undefined || (query.after === undefined && query.wait === undefined), {
  message: '`last` reads the newest events at once: it takes no `after` or `wait`',
  path: ['last'],
})
export type EventsQueryInput = z.input<typeof EventsQuerySchema>

export const PostBodySchema = z
  .object({
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    // Storable, as the text of the message.posted it appends is (original contract/events.ts:48, schemas.ts:36-62).
    text: z.string().refine(storable, 'message text has a NUL character or a lone surrogate').default(''),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    sync: z.array(z.union([z.string().min(3).max(300), ResolvedSyncTargetSchema])).max(10).optional(),
    id: z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate').optional(),
    attachments: z.array(AttachmentId).optional(),
    after: Ref.optional(),
    quoteMessageId: Ref.optional(),
  })
  .refine((body) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: 'message text is empty',
    path: ['text'],
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), {
    message: 'a post needs `channel`; a reply needs `re`',
  })
  .refine((body) => !(body.noSync && body.sync?.length), {
    message: '`noSync` and `sync` contradict each other',
  })
  .refine((body) => body.after === undefined || body.re !== undefined, {
    message: "`after` is for replies: it names the newest message in `re`'s thread",
    path: ['after'],
  })
export type PostInput = z.input<typeof PostBodySchema>

export const EditBodySchema = z.object({
  text: SentText,
  revision: Revision.optional(),
})
export const DeleteBodySchema = z.object({ revision: Revision.optional() }).optional()
export const ReactBodySchema = z.object({ emoji: Emoji, remove: z.boolean().optional() })

export const LabelBodySchema = z
  .object({
    set: NewLabels.optional(),
    unset: z.array(LabelKey).optional(),
    if: safeRecord(LabelKey, LabelValue.nullable(), LABEL_KEY_RESERVED)
      .refine(
        (expected) => Object.keys(expected).length <= LABEL_CONDITIONS_MAX,
        `at most ${LABEL_CONDITIONS_MAX} labels`,
      )
      .optional(),
  })
  .refine((body) => body.set !== undefined || body.unset !== undefined, {
    message: 'nothing to change: pass `set` or `unset`',
  })

const Duration = z
  .string()
  .regex(/^\d+(\.\d+)?(s|m|h|d)$/, 'durations look like 30s, 30m, 12h, or 1d')
const Instant = z.iso.datetime({ offset: true })

export const ScheduleBodySchema = z
  .object({
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    // Storable, as the text of the message.posted it appends is (original contract/events.ts:48, schemas.ts:36-62).
    text: z.string().refine(storable, 'message text has a NUL character or a lone surrogate').default(''),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).optional(),
    in: Duration.optional(),
    at: Instant.optional(),
    every: Duration.optional(),
    until: Instant.optional(),
    for: Duration.optional(),
    times: z.number().int().positive().optional(),
  })
  .refine((body) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: 'message text is empty',
    path: ['text'],
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), {
    message: 'a schedule needs `channel` for a new thread, or `re` for a reply',
  })
  .refine((body) => body.in !== undefined || body.at !== undefined || body.every !== undefined, {
    message: 'say when: `in`, `at`, or `every`',
  })
  .refine((body) => !(body.in !== undefined && body.at !== undefined), {
    message: '`in` and `at` contradict each other',
  })
  .refine(
    (body) => [body.until, body.for, body.times].filter((v) => v !== undefined).length <= 1,
    { message: 'pick one stop: `until`, `for`, or `times`' },
  )
  .refine(
    (body) =>
      body.every !== undefined ||
      (body.until === undefined && body.for === undefined && body.times === undefined),
    { message: '`until`, `for`, and `times` stop a repeat: add `every`' },
  )
export type ScheduleInput = z.input<typeof ScheduleBodySchema>

export const SchedulesQuerySchema = z.object({
  re: Ref.optional(),
  channel: z.string().optional(),
  by: z.string().optional(),
  all: flag.optional(),
})
export type SchedulesQueryInput = z.input<typeof SchedulesQuerySchema>

const LockMeOut = z.boolean().optional()
const GrantSpecSchema = z.strictObject({
  principals: z.array(PrincipalInputSchema).min(1).max(32),
  can: GrantCanInputSchema,
})

export const GrantBodySchema = GrantSpecSchema.extend({ lockMeOut: LockMeOut })
export const CreateGrantsBodySchema = z.strictObject({
  grants: z.array(GrantSpecSchema).min(1).max(GRANT_BATCH_MAX),
  lockMeOut: LockMeOut,
})
export const UpdateGrantBodySchema = z
  .strictObject({
    add: z.array(PrincipalInputSchema).min(1).max(32).optional(),
    remove: z.array(PrincipalInputSchema).min(1).max(32).optional(),
    can: GrantCanInputSchema.optional(),
    lockMeOut: LockMeOut,
  })
  .refine(
    (body) => body.add !== undefined || body.remove !== undefined || body.can !== undefined,
    'name principals to add or remove, or a can',
  )
export const RevokeGrantBodySchema = z.strictObject({ lockMeOut: LockMeOut }).optional()

export const ExplainQuerySchema = z
  .object({
    channel: ChannelPath,
    user: z.string().min(1).max(320).optional(),
    project: z.string().min(1).max(200).optional(),
    environment: z.string().min(1).max(100).optional(),
    github: z.string().min(3).max(200).optional(),
    workflow: z.string().min(1).max(300).optional(),
    branch: z.string().min(1).max(255).optional(),
    event: z.string().min(1).max(64).optional(),
    oidc: z.string().min(1).max(1000).optional(),
    claim: repeated.optional(),
    app: z.string().min(1).max(200).optional(),
  })
  .refine(
    (query) =>
      [query.user, query.project, query.github, query.oidc, query.app].filter(
        (v) => v !== undefined,
      ).length <= 1,
    'name one principal: user, project, github, oidc, or app',
  )
  .refine(
    (query) => query.environment === undefined || query.project !== undefined,
    'environment goes with project',
  )
  .refine(
    (query) =>
      (query.workflow === undefined && query.branch === undefined && query.event === undefined) ||
      query.github !== undefined,
    'workflow, branch, and event go with github',
  )
  .refine(
    (query) => query.claim === undefined || query.oidc !== undefined,
    'claim goes with oidc',
  )

export const SchemaBodySchema = z.strictObject({
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9._-]*$/,
      'a schema name is lowercase letters, numbers, and ._-, starting with a letter',
    ),
  version: z.number().int().min(1),
  description: z
    .string()
    .min(1)
    .refine(storable, 'a description has a NUL character or a lone surrogate')
    .optional(),
  schema: z.record(z.string(), z.unknown()),
})
export type SchemaInput = z.input<typeof SchemaBodySchema>

const RegisteringSchema = z.object({
  watch: safeRecord(z.string().max(100), z.object({ tail: z.string().max(1000) })),
  sync: z
    .array(z.object({ key: z.string().min(1).max(64), platform: z.string().min(1).max(64) }))
    .max(32)
    .optional(),
})

export const RegisterBodySchema = z.union([
  RegisteringSchema.extend({
    url: z
      .string()
      .url()
      .max(500)
      .refine((url) => /^https:\/\//.test(url), 'wake-ups go over https')
      .transform((url) => url.replace(/\/+$/, ''))
      .nullable()
      .optional(),
    path: z.null({ error: 'register a url or a path, not both' }).optional(),
    branch: z.null({ error: 'a branch goes with a path' }).optional(),
  }),
  RegisteringSchema.extend({
    url: z.null({ error: 'register a url or a path, not both' }).optional(),
    path: z
      .string()
      .max(300)
      .regex(/^\/[^?#]*$/, 'a path starts with / and has no query or fragment')
      .transform((path) => path.replace(/(.)\/+$/, '$1')),
    branch: z.string().min(1).max(255).nullable().optional(),
  }),
])
export type RegisterInput = z.input<typeof RegisterBodySchema>

export const MatchesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  wait: z.coerce.number().min(0).max(25).optional(),
})

export const AckBodySchema = z.object({
  lease: z.string().min(1).max(64),
  error: z.string().min(1).max(500).optional(),
  skip: z.boolean().optional(),
})

export const UploadStartBodySchema = z.object({
  name: z.string().max(1024).nullable().optional(),
  type: z.string().max(1024).nullable().optional(),
  size: z
    .number()
    .int()
    .positive()
    .max(
      DIRECT_UPLOAD_BYTES_MAX,
      `direct uploads are at most ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB`,
    ),
  sha256: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, 'sha256 is the base64 SHA-256 of the bytes')
    .optional(),
})

export const SyncBodySchema = z.object({ target: z.string().min(3).max(300) })

const SyncKey = z.string().min(1).max(64)
const ImportOriginSchema = z.object({
  thread: ExternalTarget,
  message: z.string().min(1).max(300).optional(),
})
const ImportLinkSchema = LinkViewSchema.extend({ message: Ref.nullable() })
const PlatformUserSchema = ExternalAuthorSchema.extend({
  avatar: z.string().nullable().transform(platformAvatar),
})
const ImportedShape = { author: PlatformUserSchema, from: SyncKey.nullable() }
const MentionedShape = z.array(PlatformUserSchema).max(MENTIONED_PER_MESSAGE_MAX).optional()
const ImportSourceSchema = z.object({
  key: SyncKey,
  channel: ExternalTarget,
  thread: ExternalTarget,
})
const ChangedShape = { origin: ImportOriginSchema.optional(), message: Ref.optional() }

export const SyncImportBodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('post'),
    ...ImportedShape,
    origin: OriginSchema.nullable().default(null),
    source: ImportSourceSchema.optional(),
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    text: z.string().max(MESSAGE_TEXT_MAX).default(''),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).max(ATTACHMENTS_PER_MESSAGE_MAX).optional(),
    links: z.array(ImportLinkSchema).max(LINKS_PER_MESSAGE_MAX).optional(),
    mentioned: MentionedShape,
    id: z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate').optional(),
    after: Ref.optional(),
  }),
  z.object({
    op: z.literal('edit'),
    ...ImportedShape,
    ...ChangedShape,
    text: MessageText,
    source: ImportSourceSchema.optional(),
    revision: Revision.optional(),
    mentioned: MentionedShape,
  }),
  z.object({
    op: z.literal('delete'),
    ...ImportedShape,
    ...ChangedShape,
    revision: Revision.optional(),
  }),
  z.object({
    op: z.literal('react'),
    ...ImportedShape,
    ...ChangedShape,
    emoji: Emoji,
    remove: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('labels'),
    ...ImportedShape,
    ...ChangedShape,
    set: NewLabels.optional(),
    unset: z.array(LabelKey).optional(),
    if: safeRecord(LabelKey, LabelValue.nullable(), LABEL_KEY_RESERVED).optional(),
  }),
  z.object({
    op: z.literal('links'),
    ...ImportedShape,
    ...ChangedShape,
    links: z.array(ImportLinkSchema).max(LINKS_PER_MESSAGE_MAX),
  }),
])
export type SyncImportInput = z.input<typeof SyncImportBodySchema>

const PlatformFilesSchema = z
  .array(z.string().min(1).max(300))
  .max(ATTACHMENTS_PER_MESSAGE_MAX)
  .nullable()

export const SyncReceiptBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    message: Ref,
    target: ExternalTarget,
    external: z.object({ thread: ExternalTarget, message: z.string().min(1).max(300) }),
    files: PlatformFilesSchema.optional(),
  }),
  z.object({
    kind: z.literal('files'),
    message: Ref,
    target: ExternalTarget,
    files: PlatformFilesSchema,
  }),
  z.object({
    kind: z.literal('failed'),
    message: Ref,
    target: ExternalTarget,
    error: z.string().min(1).max(500),
  }),
  z.object({
    kind: z.literal('thread'),
    message: Ref,
    target: ExternalTarget,
    targetKind: z.enum(['channel', 'thread']),
    cause: z.enum(['config', 'request']),
  }),
])
export type SyncReceiptInput = z.input<typeof SyncReceiptBodySchema>

export const SyncFindQuerySchema = z.object({
  post: z.string().min(1).max(200).optional(),
  thread: ExternalTarget.optional(),
  message: z.string().min(1).max(300).optional(),
})
export type SyncFindInput = z.input<typeof SyncFindQuerySchema>

export const SyncCopiesQuerySchema = z.object({
  message: repeated.pipe(z.array(Ref).min(1).max(100)),
})

export const InboxPushBodySchema = z.object({
  events: z
    .array(
      z.object({
        id: z.string().min(1).max(INBOX_EVENT_ID_MAX),
        event: ExternalEventSchema,
        raw: z.unknown(),
      }),
    )
    .min(1)
    .max(50),
})
export const InboxNextQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
})
export const InboxAckBodySchema = z.object({
  lease: z.string().min(1).max(64),
  error: z.string().min(1).max(500).optional(),
})

// ============================================================================
// Swarmboard v2 Entity Schemas (14 Core Corporate Swarm Entities)
// ============================================================================

export const AgentRoleSchema = z.enum([
  'overseer',
  'architect',
  'operator',
  'dept_head',
  'captain',
  'witness',
  'refinery',
  'worker',
])
export type AgentRole = z.infer<typeof AgentRoleSchema>

export const PrincipalKindSchema = z.enum(['human_verified', 'agent_delegated'])
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>

export const EnvelopePurposeSchema = z.enum([
  'assignment',
  'rfc',
  'handoff',
  'question',
  'answer',
  'finding',
  'blocker',
  'decision',
  'verdict',
  'steer',
  'heartbeat',
])
export type EnvelopePurpose = z.infer<typeof EnvelopePurposeSchema>

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
const slugRegex = /^[a-z0-9][a-z0-9_-]{0,63}$/

// 1. OrgNode
export const OrgNodeSchema = z.strictObject({
  id: z.string().min(1).max(128),
  orgId: z.string().min(1).max(128),
  kind: z.enum(['org', 'division', 'department', 'squad', 'agent']),
  name: z.string().min(1).max(200),
  slug: z.string().regex(slugRegex),
  parentId: z.string().min(1).max(128).nullable(),
  deptId: z.string().min(1).max(128).nullable().default(null),
  squadId: z.string().min(1).max(128).nullable().default(null),
  reportsTo: z.string().min(1).max(128).nullable().default(null),
  role: AgentRoleSchema.nullable().default(null),
  lineage: z.string().max(1024),
  depth: z.number().int().nonnegative(),
  maxDepth: z.number().int().nonnegative().default(4),
  spawnBudget: z.number().int().nonnegative().default(0),
  defaultChannelPrefix: z.string().max(512).nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type OrgNode = z.infer<typeof OrgNodeSchema>

// 2. Department
export const DepartmentSchema = z.strictObject({
  id: z.string().min(1).max(128),
  orgId: z.string().min(1).max(128),
  divisionId: z.string().min(1).max(128).nullable().default(null),
  slug: z.string().regex(slugRegex),
  name: z.string().min(1).max(200),
  headAgentId: z.string().min(1).max(128).nullable().default(null),
  channelNamespace: z.string().min(1).max(512),
  isolationMode: z
    .enum(['open', 'dept_only', 'captain_bridge', 'need_to_know'])
    .default('captain_bridge'),
  budgetPolicyId: z.string().min(1).max(128).nullable().default(null),
  paused: z.boolean().default(false),
  createdAt: z.iso.datetime(),
})
export type Department = z.infer<typeof DepartmentSchema>

// 3. Squad
export const SquadSchema = z.strictObject({
  id: z.string().min(1).max(128),
  orgId: z.string().min(1).max(128),
  deptId: z.string().min(1).max(128),
  slug: z.string().regex(slugRegex),
  name: z.string().min(1).max(200),
  captainId: z.string().min(1).max(128).nullable().default(null),
  witnessId: z.string().min(1).max(128).nullable().default(null),
  refineryId: z.string().min(1).max(128).nullable().default(null),
  channelPath: z.string().min(1).max(512),
  maxConcurrentWorkers: z.number().int().positive().default(8),
  createdAt: z.iso.datetime(),
})
export type Squad = z.infer<typeof SquadSchema>

// 4. AgentCard
export const AgentCardSchema = z.strictObject({
  id: z.string().min(1).max(128),
  handle: z.string().min(1).max(128),
  displayName: z.string().min(1).max(200),
  orgId: z.string().min(1).max(128),
  deptId: z.string().min(1).max(128).nullable().default(null),
  squadId: z.string().min(1).max(128).nullable().default(null),
  reportsTo: z.string().min(1).max(128).nullable().default(null),
  role: AgentRoleSchema,
  lineage: z.string().max(1024),
  depth: z.number().int().nonnegative().default(0),
  maxDepth: z.number().int().nonnegative().default(2),
  spawnBudget: z.number().int().nonnegative().default(0),
  principalKind: PrincipalKindSchema,
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  modelFamily: z.string().min(1).max(64),
  correlationGroup: z.string().min(1).max(64),
  harness: z.string().min(1).max(64),
  capabilities: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        tags: z.array(z.string().max(64)).default([]),
      }),
    )
    .default([]),
  a2aEndpoint: z.url().nullable().default(null),
  status: z
    .enum(['online', 'busy', 'idle', 'paused', 'blocked', 'offline', 'dead'])
    .default('online'),
  contextPct: z.number().min(0).max(100).nullable().default(null),
  costUsd: z.number().nonnegative().default(0),
  lastHeartbeatAt: z.iso.datetime(),
  registeredAt: z.iso.datetime(),
})
export type AgentCard = z.infer<typeof AgentCardSchema>

// 5. CommunicationFlow
const FlowSelectorSchema = z.strictObject({
  kind: z.enum(['org', 'dept', 'squad', 'role', 'agent', 'all']),
  value: z.string().max(256),
})

export const CommunicationFlowSchema = z.strictObject({
  id: z.string().min(1).max(128),
  orgId: z.string().min(1).max(128),
  sourceSelector: FlowSelectorSchema,
  targetSelector: FlowSelectorSchema,
  mode: z.enum(['open', 'org_tree', 'dept_only', 'captain_bridge', 'allowlist']),
  allowedPurposes: z.array(EnvelopePurposeSchema).min(1),
  channelPattern: z.string().max(CHANNEL_PATTERN_MAX).default('*'),
  requireContactApproval: z.boolean().default(false),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  createdAt: z.iso.datetime(),
})
export type CommunicationFlow = z.infer<typeof CommunicationFlowSchema>

// 6. BridgeRfc
export const BridgeRfcSchema = z.strictObject({
  id: z.string().min(1).max(128),
  channel: z.string().min(1).max(CHANNEL_PATH_MAX),
  threadId: z.string().min(1).max(128),
  fromCaptainId: z.string().min(1).max(128),
  toCaptainIds: z.array(z.string().min(1).max(128)).min(1),
  title: z.string().min(1).max(300),
  interfaceContract: z.record(z.string(), z.unknown()),
  contractDigestSha256: sha256Hex,
  affectedPaths: z.array(z.string().max(1024)).default([]),
  status: z
    .enum(['proposed', 'partial_ack', 'accepted', 'rejected', 'superseded', 'timed_out'])
    .default('proposed'),
  acks: z
    .array(
      z.strictObject({
        captainId: z.string().min(1).max(128),
        status: z.enum(['accepted', 'rejected']),
        signedDigestSha256: sha256Hex,
        note: z.string().max(2000).optional(),
        ackedAt: z.iso.datetime(),
      }),
    )
    .default([]),
  deadline: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
})
export type BridgeRfc = z.infer<typeof BridgeRfcSchema>

// 7. EnvelopeV2
export const EnvelopeV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  messageId: z.string().min(1).max(128).optional(),
  runId: z.string().min(1).max(128),
  traceId: z.string().min(1).max(128),
  purpose: EnvelopePurposeSchema,
  summary: z.string().min(1).max(4000),
  requestedAction: z.string().max(2000).default(''),
  taskId: z.string().max(128).default(''),
  attempt: z.number().int().nonnegative().default(0),
  replyTo: z.string().min(1).max(128).nullable().default(null),
  progressKey: z.string().max(256).default(''),
  artifacts: z
    .array(
      z.strictObject({
        kind: z.string().min(1).max(64),
        uri: z.string().min(1).max(2048),
        sha256: sha256Hex.optional(),
        label: z.string().max(256).optional(),
      }),
    )
    .default([]),
  deadline: z.iso.datetime().nullable().default(null),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  sourceTrustLevel: z
    .enum(['human_verified', 'internal_agent', 'external_sync'])
    .default('internal_agent'),
  untrusted: z.boolean().default(false),
})
export type EnvelopeV2 = z.infer<typeof EnvelopeV2Schema>

// 8. DeliveryRow
export const DeliveryRowSchema = z.strictObject({
  messageId: z.string().min(1).max(128),
  recipientId: z.string().min(1).max(128),
  state: z.enum(['pending', 'leased', 'acked', 'nacked', 'dead', 'superseded']).default('pending'),
  priority: z.enum(['low', 'normal', 'urgent']).default('normal'),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  leaseTokenHash: sha256Hex.nullable().default(null),
  leaseUntil: z.iso.datetime().nullable().default(null),
  deadline: z.iso.datetime().nullable().default(null),
  readAt: z.iso.datetime().nullable().default(null),
  ackedAt: z.iso.datetime().nullable().default(null),
  lastError: z.string().max(1000).nullable().default(null),
  createdAt: z.iso.datetime(),
})
export type DeliveryRow = z.infer<typeof DeliveryRowSchema>

// 9. EscalationTicket
export const EscalationTicketSchema = z.strictObject({
  id: z.string().min(1).max(128),
  orgId: z.string().min(1).max(128),
  deptId: z.string().min(1).max(128).nullable().default(null),
  taskId: z.string().min(1).max(128).nullable().default(null),
  fromAgentId: z.string().min(1).max(128),
  targetAgentId: z.string().min(1).max(128),
  severity: z.enum(['P2_MEDIUM', 'P1_HIGH', 'P0_CRITICAL']),
  category: z.enum([
    'decision',
    'blocked',
    'failed',
    'emergency',
    'gate_timeout',
    'zombie_worker',
  ]),
  summary: z.string().min(1).max(2000),
  tried: z.string().max(4000).default(''),
  status: z.enum(['open', 'acked', 'resolved', 'exhausted']).default('open'),
  staleThresholdSeconds: z.number().int().positive().default(900),
  reescalationCount: z.number().int().nonnegative().default(0),
  maxReescalations: z.number().int().min(1).max(10).default(3),
  routeTrace: z.array(z.string().min(1).max(128)).min(1),
  nextEscalateAt: z.iso.datetime().nullable().default(null),
  ackedAt: z.iso.datetime().nullable().default(null),
  resolvedAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
})
export type EscalationTicket = z.infer<typeof EscalationTicketSchema>

// 10. ReservationLease
export const ReservationLeaseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  workspace: z.string().min(1).max(1024),
  pattern: z.string().min(1).max(1024),
  isGlob: z.boolean().default(false),
  exclusive: z.boolean().default(true),
  agentId: z.string().min(1).max(128),
  taskId: z.string().max(128).default(''),
  deptId: z.string().max(128).nullable().default(null),
  reason: z.string().max(500).default(''),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
})
export type ReservationLease = z.infer<typeof ReservationLeaseSchema>

// 11. BuildSlot
export const BuildSlotSchema = z.strictObject({
  id: z.string().min(1).max(128),
  workspace: z.string().min(1).max(1024),
  slotName: z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/),
  maxConcurrency: z.number().int().positive().default(1),
  holderAgentId: z.string().min(1).max(128),
  holderTaskId: z.string().max(128).default(''),
  leaseTokenHash: sha256Hex,
  expiresAt: z.iso.datetime(),
  acquiredAt: z.iso.datetime(),
})
export type BuildSlot = z.infer<typeof BuildSlotSchema>

// 12. DecisionBundle
export const DecisionBundleSchema = z.strictObject({
  id: z.string().min(1).max(128),
  orgId: z.string().min(1).max(128),
  deptId: z.string().min(1).max(128).nullable().default(null),
  taskId: z.string().min(1).max(128).nullable().default(null),
  channel: z.string().min(1).max(CHANNEL_PATH_MAX),
  requestedByAgentId: z.string().min(1).max(128),
  title: z.string().min(1).max(300),
  summary: z.string().min(1).max(4000),
  gateKind: z.enum(['merge', 'deploy', 'spend', 'architecture', 'override', 'escalation']),
  options: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        recommended: z.boolean().default(false),
      }),
    )
    .min(1),
  artifacts: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(200),
        uri: z.string().min(1).max(2048),
        sha256: sha256Hex.optional(),
      }),
    )
    .default([]),
  continuationPolicy: z.enum(['resume_task', 'abort_task', 'manual']).default('resume_task'),
  snapshotDigestSha256: sha256Hex.nullable().default(null),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'superseded']).default('pending'),
  chosenOptionId: z.string().max(64).nullable().default(null),
  resolvedByPrincipal: z.string().max(256).nullable().default(null),
  resolvedPrincipalKind: z.literal('human_verified').nullable().default(null),
  overrideNote: z.string().max(2000).nullable().default(null),
  expiresAt: z.iso.datetime().nullable().default(null),
  resolvedAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
})
export type DecisionBundle = z.infer<typeof DecisionBundleSchema>

// 13. BudgetPolicy
export const BudgetPolicySchema = z.strictObject({
  id: z.string().min(1).max(128),
  scopeType: z.enum(['org', 'dept', 'squad', 'agent', 'run']),
  scopeId: z.string().min(1).max(128),
  budgetCents: z.number().int().nonnegative(),
  spentCents: z.number().nonnegative().default(0),
  warnPercent: z.number().min(1).max(100).default(80),
  hardStopEnabled: z.boolean().default(true),
  unpricedUsagePolicy: z.enum(['block', 'allow_warn', 'estimate']).default('allow_warn'),
  warnTriggeredAt: z.iso.datetime().nullable().default(null),
  hardStoppedAt: z.iso.datetime().nullable().default(null),
  updatedAt: z.iso.datetime(),
})
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>

// 14. WakeupPacket
export const WakeupPacketSchema = z.strictObject({
  id: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
  scopeKey: z.string().min(1).max(256),
  idempotencyKey: z.string().min(1).max(200).nullable().default(null),
  coalescedCount: z.number().int().positive().default(1),
  cursorFrom: z.string().min(1).max(128),
  cursorTo: z.string().min(1).max(128),
  summary: z.string().min(1).max(4000),
  eventTypes: z.array(z.string().max(64)).default([]),
  status: z.enum(['queued', 'dispatched', 'acked']).default('queued'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type WakeupPacket = z.infer<typeof WakeupPacketSchema>

// 15. Search (F14): BoardService.search's query, checked as every other entry's input is, so a
// malformed one is a 400 invalid_request rather than a TypeError's 500 or a silent empty answer.
export const SearchQuerySchema = z.object({
  query: z.string(),
  scope: z.enum(['all', 'messages', 'tasks', 'knowledge']).optional(),
  channel: z.string().min(1).max(CHANNEL_PATH_MAX).optional(),
  subtree: z.boolean().optional(),
  deptId: z.string().min(1).max(128).optional(),
  labels: z
    .array(
      z.object({
        key: z.string().min(1).max(LABEL_KEY_MAX),
        values: z.array(z.string().max(LABEL_VALUE_MAX)).max(LABEL_FILTER_VALUES_MAX).nullable(),
      }),
    )
    .max(LABEL_CONDITIONS_MAX)
    .optional(),
  /** Taken up to 200; more is answered as 200. */
  limit: z.number().int().positive().optional(),
  /** An in-process caller's own filter on the hits it may see. */
  filter: z.custom<(hit: never) => boolean>((value) => typeof value === 'function', 'filter: a function').optional(),
})

// ============================================================================
// Swarmboard v2 A2A Social Primitives (Notifications, Groups, Pins, Presence)
// ============================================================================

export const NotificationReasonSchema = z.enum([
  'mention',
  'group_mention',
  'dm',
  'reply',
  'pin',
  'task_assigned',
  'attention',
])
export type NotificationReason = z.infer<typeof NotificationReasonSchema>

export const NotificationPrioritySchema = z.enum(['normal', 'urgent'])
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>

export const NotificationViewSchema = z.object({
  id: z.string(),
  logIndex: z.number().int().nonnegative(),
  recipient: z.string(),
  reason: NotificationReasonSchema,
  priority: NotificationPrioritySchema,
  sourceGroup: z.string().nullable(),
  channel: ChannelPath,
  thread: z.string(),
  rootId: z.string(),
  messageId: z.string(),
  byActor: z.string(),
  byHandle: z.string().nullable(),
  excerpt: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  ackedAt: z.string().nullable(),
})
export type NotificationView = z.infer<typeof NotificationViewSchema>

export const NotificationsPageSchema = z.object({
  notifications: z.array(NotificationViewSchema),
  cursor: z.string(),
  unread: z.number().int().nonnegative(),
  urgent: z.number().int().nonnegative(),
})
export type NotificationsPage = z.infer<typeof NotificationsPageSchema>

export const NotificationsQuerySchema = z.strictObject({
  unreadOnly: flag.optional(),
  reason: NotificationReasonSchema.optional(),
  priority: NotificationPrioritySchema.optional(),
  channel: ChannelOrSubtree.optional(),
  after: Ref.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type NotificationsQueryInput = z.input<typeof NotificationsQuerySchema>

export const WaitNotificationsQuerySchema = NotificationsQuerySchema.extend({
  wait: z.coerce.number().min(0).max(300).optional(),
})
export type WaitNotificationsQueryInput = z.input<typeof WaitNotificationsQuerySchema>

// Plain z.strictObject (never outer .optional(), avoiding OpInput union distribution in ops.ts)
export const AckNotificationBodySchema = z.strictObject({
  readOnly: z.boolean().optional(),
})
export type AckNotificationInput = z.input<typeof AckNotificationBodySchema>

export const AckAllNotificationsBodySchema = z.strictObject({
  channel: ChannelOrSubtree.optional(),
  beforeCursor: Ref.optional(),
  reason: NotificationReasonSchema.optional(),
  markChannelRead: z.boolean().optional(),
})
export type AckAllNotificationsInput = z.input<typeof AckAllNotificationsBodySchema>

export const MarkChannelReadBodySchema = z.strictObject({
  channel: ChannelPath,
  cursor: Ref.optional(),
})
export type MarkChannelReadInput = z.input<typeof MarkChannelReadBodySchema>

export const AgentInboxQuerySchema = z.strictObject({
  notificationsLimit: z.coerce.number().int().min(1).max(100).optional(),
  tasksLimit: z.coerce.number().int().min(1).max(100).optional(),
  channel: ChannelOrSubtree.optional(),
  includeReadyPool: flag.optional(),
  urgentOnly: flag.optional(),
})
export type AgentInboxQueryInput = z.input<typeof AgentInboxQuerySchema>

export interface CompactTaskDigest {
  readonly id: string
  readonly channel: string
  readonly thread: string
  readonly state: TaskState
  readonly for: string | null
  readonly owner: string
  readonly text: string
  readonly replies: number
  readonly createdAt: string
  readonly latestReply: {
    readonly id: string
    readonly by: string
    readonly handle: string | null
    readonly excerpt: string
    readonly createdAt: string
  } | null
}

export interface AgentInboxView {
  readonly actor: string
  readonly profile: string | null
  readonly cursor: string
  readonly unreadNotifications: number
  readonly urgentCount: number
  readonly notifications: readonly NotificationView[]
  readonly tasks: {
    readonly assigned: readonly CompactTaskDigest[]
    readonly ready: readonly CompactTaskDigest[]
  }
  readonly unreadChannels: readonly {
    readonly channel: string
    readonly kind: ChannelKind
    readonly unread: number
    readonly lastIndex: number
  }[]
  readonly unreadDms: readonly {
    readonly channel: string
    readonly peer: string
    readonly unread: number
    readonly lastExcerpt: string
    readonly lastIndex: number
  }[]
  readonly onlinePeers: number
  /** Up to eight current peers. Older servers return only the count. */
  readonly peers?: readonly Pick<PresenceView, 'handle' | 'status'>[]
}

export const GroupKindSchema = z.enum(['team', 'swarm', 'role', 'harness', 'system'])
export type GroupKind = z.infer<typeof GroupKindSchema>

export const GroupHandleSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,46}[a-z0-9]$/)

export const GroupsQuerySchema = z.strictObject({
  kind: GroupKindSchema.optional(),
  member: z.string().min(1).max(256).optional(),
  channel: ChannelOrSubtree.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type GroupsQueryInput = z.input<typeof GroupsQuerySchema>

export const GroupMemberViewSchema = z.object({
  memberId: z.string(),
  role: z.enum(['member', 'lead']),
  addedBy: z.string(),
  addedAt: z.string(),
})
export type GroupMemberView = z.infer<typeof GroupMemberViewSchema>

export const GroupViewSchema = z.object({
  handle: GroupHandleSchema,
  name: z.string(),
  description: z.string(),
  kind: GroupKindSchema,
  channel: ChannelPath.nullable(),
  members: z.array(GroupMemberViewSchema),
  byActor: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type GroupView = z.infer<typeof GroupViewSchema>

export const CreateGroupBodySchema = z.strictObject({
  handle: GroupHandleSchema,
  name: z.string().min(1).max(120).refine(storable),
  description: z.string().max(500).refine(storable).optional(),
  kind: GroupKindSchema.optional(),
  channel: ChannelPath.nullable().optional(),
  members: z.array(z.string().min(1).max(256)).max(64).optional(),
})
export type CreateGroupInput = z.input<typeof CreateGroupBodySchema>

export const UpdateGroupBodySchema = z
  .strictObject({
    name: z.string().min(1).max(120).refine(storable).optional(),
    description: z.string().max(500).refine(storable).optional(),
    kind: GroupKindSchema.optional(),
    channel: ChannelPath.nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'provide at least one field to update')
export type UpdateGroupInput = z.input<typeof UpdateGroupBodySchema>

export const GroupMembersBodySchema = z.strictObject({
  members: z.array(z.string().min(1).max(256)).min(1).max(64),
  role: z.enum(['member', 'lead']).optional(),
})
export type GroupMembersInput = z.input<typeof GroupMembersBodySchema>

export const PinScopeSchema = z.enum(['thread', 'channel', 'announcement'])
export type PinScope = z.infer<typeof PinScopeSchema>

export const PinViewSchema = z.object({
  id: z.string(),
  scope: PinScopeSchema,
  channel: ChannelPath,
  rootId: Ref,
  thread: z.string(),
  messageId: Ref,
  pinnedBy: z.string(),
  pinnedAt: z.string(),
  note: z.string().nullable(),
  sortOrder: z.number().int(),
  message: MessageViewSchema.optional(),
})
export type PinView = z.infer<typeof PinViewSchema>

export const PinBodySchema = z.strictObject({
  scope: PinScopeSchema.default('channel'),
  note: z.string().max(240).refine(storable).nullable().optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
  notify: z.boolean().optional(),
})
export type PinInput = z.input<typeof PinBodySchema>

export const UnpinBodySchema = z.strictObject({
  scope: PinScopeSchema.optional(),
})
export type UnpinInput = z.input<typeof UnpinBodySchema>

export const PinsQuerySchema = z.strictObject({
  channel: ChannelOrSubtree.optional(),
  thread: Ref.optional(),
  scope: PinScopeSchema.optional(),
  includeGlobal: flag.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type PinsQueryInput = z.input<typeof PinsQuerySchema>

export const PresenceStatusSchema = z.enum(['active', 'busy', 'idle', 'offline'])
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>

export const PresenceViewSchema = z.object({
  agent: z.string(),
  principal: z.string(),
  profile: z.string().nullable(),
  handle: z.string(),
  harness: z.string().nullable(),
  model: z.string().nullable(),
  status: PresenceStatusSchema,
  channel: ChannelPath.nullable(),
  taskId: Ref.nullable(),
  note: z.string().nullable(),
  updatedAt: z.string(),
  expiresAt: z.string(),
})
export type PresenceView = z.infer<typeof PresenceViewSchema>

export const SetPresenceBodySchema = z.strictObject({
  status: PresenceStatusSchema.default('active'),
  channel: ChannelPath.nullable().optional(),
  taskId: Ref.nullable().optional(),
  note: z.string().max(200).refine(storable).nullable().optional(),
  harness: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  ttlS: z.number().int().min(15).max(3600).default(120),
})
export type SetPresenceInput = z.input<typeof SetPresenceBodySchema>

export const PresenceQuerySchema = z.strictObject({
  channel: ChannelOrSubtree.optional(),
  status: PresenceStatusSchema.optional(),
  includeOffline: flag.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type PresenceQueryInput = z.input<typeof PresenceQuerySchema>
