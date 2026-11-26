// The operation registry (HOST123_DESIGN 5.1, designs g1 6): pure data, one row per operation, bound to the members
// of TRANSPORT_ALLOW and named by the original protocol's route keys. Thin: the only runtime imports are
// ./errors.ts and ./version.ts, so a later socket transport can reuse it without the core or zod. The types
// (OpInput, OpOutput) come from type-only imports and cost nothing at run time.
import type * as Core from '../core/public.ts'
import type { BoardService, TaskService } from '../core/public.ts'
import type { z } from 'zod'
import { clientError } from './errors.ts'
import { PROTOCOL_VERSION } from './version.ts'

export type ServiceName = 'board' | 'tasks' // grows: 'org' (M2 slice C), 'reviews', ...
export type ParamKind = 'ref' | 'string' | 'int' | 'bytes'
export interface ParamSpec {
  readonly name: string
  readonly kind: ParamKind
  readonly optional?: true
}
/** What a blind repeat does (probe F5). */
export type IdemClass =
  | 'read' // no effect
  | 'client-id' // carries a client id: a repeat with the same id answers the first write (lookup inside the tx)
  | 'natural' // a repeat leaves the same state and answers success (it may append another event)
  | 'fenced' // a repeat never repeats the effect; it may answer 409 (task_claimed, claim_lost, task_finished)
  | 'unsafe' // a repeat may repeat the effect (another grant, schedule, attachment, revision, claim)
/** Whether a transport may retry a retryable 503 without a key: 'in-process' only for ops of one outermost tx at most. */
export type RetryClass = 'in-process' | 'keyed' | 'never'
export type WaitKind = 'none' | 'core' | 'repoll'
export type CapabilityFlag = 'conditionalNeeds' | 'priorityNative' | 'defer' | 'resume' | 'subtreeRead'
/** The named schemas of the table: each an own export of public.ts. */
export type SchemaName =
  | 'ChannelsQuerySchema'
  | 'CreateChannelBodySchema'
  | 'ActorsQuerySchema'
  | 'ChannelMessagesQuerySchema'
  | 'ThreadQuerySchema'
  | 'ThreadsQuerySchema'
  | 'PostBodySchema'
  | 'EditBodySchema'
  | 'DeleteBodySchema'
  | 'ReactBodySchema'
  | 'LabelBodySchema'
  | 'SyncBodySchema'
  | 'ScheduleBodySchema'
  | 'SchedulesQuerySchema'
  | 'GrantBodySchema'
  | 'CreateGrantsBodySchema'
  | 'UpdateGrantBodySchema'
  | 'ExplainQuerySchema'
  | 'RevokeGrantBodySchema'
  | 'SchemaBodySchema'
  | 'InboxPushBodySchema'
  | 'InboxNextQuerySchema'
  | 'InboxAckBodySchema'
  | 'SyncImportBodySchema'
  | 'SyncReceiptBodySchema'
  | 'SyncFindQuerySchema'
  | 'SyncCopiesQuerySchema'
  | 'EventsQuerySchema'
  | 'UploadStartBodySchema'
  | 'RegisterBodySchema'
  | 'MatchesQuerySchema'
  | 'AckBodySchema'
  | 'SearchQuerySchema'
  | 'TasksQuery'
  | 'CreateTaskBody'
  | 'CreateTasksBody'
  | 'CreatedTasksQuery'
  | 'ClaimReadyTaskBody'
  | 'ClaimTaskBody'
  | 'RenewTaskBody'
  | 'ReleaseTaskBody'
  | 'CompleteTaskBody'
  | 'FailTaskBody'
  | 'BlockTaskBody'
  | 'AssignTaskBody'
  | 'TaskNeedsBody'
  | 'CancelTaskBody'
  | 'ChannelTreeQuerySchema'
  | 'UpdateChannelBodySchema'
  | 'EnsureDmBodySchema'
  | 'GroupsQuerySchema'
  | 'CreateGroupBodySchema'
  | 'UpdateGroupBodySchema'
  | 'GroupMembersBodySchema'
  | 'NotificationsQuerySchema'
  | 'AckNotificationBodySchema'
  | 'AckAllNotificationsBodySchema'
  | 'WaitNotificationsQuerySchema'
  | 'MarkChannelReadBodySchema'
  | 'AgentInboxQuerySchema'
  | 'PinBodySchema'
  | 'UnpinBodySchema'
  | 'PinsQuerySchema'
  | 'SetPresenceBodySchema'
  | 'PresenceQuerySchema'

export interface OpSpec {
  readonly binds: { readonly service: ServiceName; readonly method: string }
  /** Positional arguments after `caller`, taken from the input by name, in order. */
  readonly params: readonly ParamSpec[]
  /** 'rest': the input minus params is passed as the next argument; 'none': no body argument (extra keys are 400). */
  readonly body: 'rest' | 'none'
  /** Body fields that carry bytes (Uint8Array), exempt from the JSON-shape rule. */
  readonly bytesFields?: readonly string[]
  /** Pass CallOptions.signal as the last argument (only the async core verbs). */
  readonly signal: boolean
  readonly schema: SchemaName | null
  readonly access: 'read' | 'write'
  readonly idem: IdemClass
  readonly retry: RetryClass
  readonly wait: WaitKind
  readonly waitMaxS?: number
  /** Codes beyond UNIVERSAL_ERRORS. */
  readonly errors: readonly string[]
  /** The original's route (orig api/routes.ts); null for Swarmboard extensions. */
  readonly compat: { readonly method: 'GET' | 'POST' | 'PATCH'; readonly path: string } | null
  readonly since: number
  readonly stability: 'stable' | 'experimental' | 'deprecated'
  /** Input fields a board must advertise before a client may send them. */
  readonly gated?: Readonly<Record<string, CapabilityFlag>>
}

const RAW_OPS = {
  me: {
    binds: { service: 'board', method: 'me' },
    params: [],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'GET', path: '/me' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  channels: {
    binds: { service: 'board', method: 'listChannels' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'ChannelsQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_cursor'],
    compat: { method: 'GET', path: '/channels' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  createChannel: {
    binds: { service: 'board', method: 'createChannel' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'CreateChannelBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'POST', path: '/channels' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  actors: {
    binds: { service: 'board', method: 'listActors' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'ActorsQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'GET', path: '/actors' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  channelMessages: {
    binds: { service: 'board', method: 'listChannelMessages' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'ChannelMessagesQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_cursor'],
    compat: { method: 'GET', path: '/messages' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  message: {
    binds: { service: 'board', method: 'getMessageThread' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'ThreadQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found'],
    compat: { method: 'GET', path: '/messages/:id' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  threads: {
    binds: { service: 'board', method: 'listThreads' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'ThreadsQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_cursor'],
    compat: { method: 'GET', path: '/threads' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  post: {
    binds: { service: 'board', method: 'postMessage' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'PostBodySchema',
    access: 'write',
    idem: 'client-id',
    retry: 'in-process',
    wait: 'none',
    errors: ['text_too_long', 'reserved_label', 'invalid_block', 'schema_not_found', 'invalid_after', 'newer_message', 'duplicate_id', 'message_not_found', 'message_deleted', 'attachment_not_found', 'invalid_attachment', 'not_a_target'],
    compat: { method: 'POST', path: '/messages' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  edit: {
    binds: { service: 'board', method: 'editMessage' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'EditBodySchema',
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'none',
    errors: ['text_too_long', 'message_not_found', 'message_deleted', 'revision_conflict', 'invalid_block', 'schema_not_found'],
    compat: { method: 'POST', path: '/messages/:id/edit' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  delete: {
    binds: { service: 'board', method: 'deleteMessage' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'DeleteBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'revision_conflict'],
    compat: { method: 'POST', path: '/messages/:id/delete' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  react: {
    binds: { service: 'board', method: 'reactMessage' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'ReactBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'message_deleted'],
    compat: { method: 'POST', path: '/messages/:id/reactions' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  label: {
    binds: { service: 'board', method: 'labelMessage' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'LabelBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'message_deleted', 'reserved_label', 'label_conflict'],
    compat: { method: 'POST', path: '/messages/:id/labels' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  sync: {
    binds: { service: 'board', method: 'attachSyncTarget' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'SyncBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_target', 'already_synced'],
    compat: { method: 'POST', path: '/messages/:id/sync' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  synced: {
    binds: { service: 'board', method: 'getSynced' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found'],
    compat: { method: 'GET', path: '/messages/:id/sync' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  schedule: {
    binds: { service: 'board', method: 'createSchedule' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'ScheduleBodySchema',
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'none',
    errors: ['text_too_long', 'reserved_label', 'invalid_block', 'message_not_found', 'attachment_not_found'],
    compat: { method: 'POST', path: '/schedules' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  schedules: {
    binds: { service: 'board', method: 'listSchedules' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'SchedulesQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found'],
    compat: { method: 'GET', path: '/schedules' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  cancelSchedule: {
    binds: { service: 'board', method: 'cancelSchedule' },
    params: [{ name: 'id', kind: 'string' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['schedule_not_found'],
    compat: { method: 'POST', path: '/schedules/:id/cancel' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  grants: {
    binds: { service: 'board', method: 'listGrants' },
    params: [],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'GET', path: '/grants' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  createGrant: {
    binds: { service: 'board', method: 'createGrant' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'GrantBodySchema',
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_grant', 'grant_empty', 'invalid_can', 'grant_lockout', 'not_in_grant'],
    compat: { method: 'POST', path: '/grants' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  createGrants: {
    binds: { service: 'board', method: 'createGrants' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'CreateGrantsBodySchema',
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_grant', 'grant_empty', 'invalid_can', 'grant_lockout', 'not_in_grant'],
    compat: { method: 'POST', path: '/grants/batch' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  updateGrant: {
    binds: { service: 'board', method: 'updateGrant' },
    params: [{ name: 'id', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'UpdateGrantBodySchema',
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'none',
    errors: ['grant_not_found', 'invalid_grant', 'grant_empty', 'invalid_can', 'grant_lockout', 'not_in_grant'],
    compat: { method: 'PATCH', path: '/grants/:id' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  explain: {
    binds: { service: 'board', method: 'explainAccess' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'ExplainQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'GET', path: '/grants/explain' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  revokeGrant: {
    binds: { service: 'board', method: 'revokeGrant' },
    params: [{ name: 'id', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'RevokeGrantBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['grant_not_found', 'grant_lockout'],
    compat: { method: 'POST', path: '/grants/:id/revoke' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  schemas: {
    binds: { service: 'board', method: 'listSchemas' },
    params: [],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'GET', path: '/schemas' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  schema: {
    binds: { service: 'board', method: 'getSchema' },
    params: [{ name: 'id', kind: 'string' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['schema_not_found', 'invalid_schema_id'],
    compat: { method: 'GET', path: '/schemas/:id' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  createSchema: {
    binds: { service: 'board', method: 'createSchema' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'SchemaBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_schema', 'invalid_schema_id', 'schema_immutable', 'reserved_schema', 'too_many_schemas'],
    compat: { method: 'POST', path: '/schemas' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  posted: {
    binds: { service: 'board', method: 'getPosted' },
    params: [{ name: 'id', kind: 'string' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['post_not_found'],
    compat: { method: 'GET', path: '/posts/:id' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  inbox: {
    binds: { service: 'board', method: 'listInbox' },
    params: [{ name: 'key', kind: 'string' }, { name: 'channel', kind: 'string', optional: true }, { name: 'limit', kind: 'int', optional: true }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'GET', path: '/inbox/:key' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  inboxPush: {
    binds: { service: 'board', method: 'inboxPush' },
    params: [{ name: 'key', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'InboxPushBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'POST', path: '/inbox/:key' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  inboxNext: {
    binds: { service: 'board', method: 'inboxNext' },
    params: [{ name: 'key', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'InboxNextQuerySchema',
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'GET', path: '/inbox/:key/next' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  inboxAck: {
    binds: { service: 'board', method: 'inboxAck' },
    params: [{ name: 'key', kind: 'string' }, { name: 'id', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'InboxAckBodySchema',
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['no_item', 'stale_lease'],
    compat: { method: 'POST', path: '/inbox/:key/:id/ack' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  syncImport: {
    binds: { service: 'board', method: 'syncImport' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'SyncImportBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'POST', path: '/sync/imports' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  syncReceipt: {
    binds: { service: 'board', method: 'syncReceipt' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'SyncReceiptBodySchema',
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found'],
    compat: { method: 'POST', path: '/sync/receipts' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  syncThread: {
    binds: { service: 'board', method: 'syncThread' },
    params: [{ name: 'thread', kind: 'string' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['thread_not_found'],
    compat: { method: 'GET', path: '/sync/threads/:thread' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  syncFind: {
    binds: { service: 'board', method: 'syncFind' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'SyncFindQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'GET', path: '/sync/find' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  syncCopies: {
    binds: { service: 'board', method: 'syncCopies' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'SyncCopiesQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'GET', path: '/sync/copies' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  events: {
    binds: { service: 'board', method: 'getEvents' },
    params: [],
    body: 'rest',
    signal: true,
    schema: 'EventsQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'core',
    waitMaxS: 300,
    errors: ['invalid_cursor'],
    compat: { method: 'GET', path: '/events' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  upload: {
    binds: { service: 'board', method: 'uploadAttachment' },
    params: [],
    body: 'rest',
    bytesFields: ['data'],
    signal: false,
    schema: null,
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'none',
    errors: ['too_large', 'invalid_attachment'],
    compat: { method: 'POST', path: '/attachments' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  attachment: {
    binds: { service: 'board', method: 'getAttachment' },
    params: [{ name: 'id', kind: 'string' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['attachment_not_found'],
    compat: { method: 'GET', path: '/attachments/:id' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  uploadStart: {
    binds: { service: 'board', method: 'startDirectUpload' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'UploadStartBodySchema',
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'none',
    errors: ['no_direct_uploads', 'too_large'],
    compat: { method: 'POST', path: '/attachments/uploads' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  uploadFinish: {
    binds: { service: 'board', method: 'finishDirectUpload' },
    params: [{ name: 'id', kind: 'string' }, { name: 'data', kind: 'bytes' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['upload_not_found', 'size_mismatch', 'not_uploaded'],
    compat: { method: 'POST', path: '/attachments/uploads/:id' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  watchers: {
    binds: { service: 'board', method: 'listWatchers' },
    params: [],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: { method: 'GET', path: '/watchers' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  register: {
    binds: { service: 'board', method: 'registerWatchers' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'RegisterBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['too_many_watchers', 'bad_watcher', 'no_wake_by_url', 'no_wake_by_path'],
    compat: { method: 'POST', path: '/watchers' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  matches: {
    binds: { service: 'board', method: 'pullWatcherMatches' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'MatchesQuerySchema',
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'repoll',
    waitMaxS: 25,
    errors: ['no_registration'],
    compat: { method: 'GET', path: '/watchers/matches' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  ack: {
    binds: { service: 'board', method: 'ackWatcherMatch' },
    params: [{ name: 'id', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'AckBodySchema',
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['no_registration', 'no_match', 'stale_lease'],
    compat: { method: 'POST', path: '/watchers/matches/:id/ack' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  search: {
    binds: { service: 'board', method: 'search' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'SearchQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_fts_query'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'experimental',
    gated: {},
  },
  tasks: {
    binds: { service: 'tasks', method: 'listTasks' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'TasksQuery',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_cursor'],
    compat: { method: 'GET', path: '/tasks' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  createTask: {
    binds: { service: 'tasks', method: 'createTask' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'CreateTaskBody',
    access: 'write',
    idem: 'client-id',
    retry: 'in-process',
    wait: 'none',
    errors: ['text_too_long', 'reserved_label', 'invalid_needs', 'message_not_found', 'message_deleted', 'already_a_task', 'task_waiting', 'task_assigned', 'duplicate_id'],
    compat: { method: 'POST', path: '/tasks' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  createTasks: {
    binds: { service: 'tasks', method: 'createTasks' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'CreateTasksBody',
    access: 'write',
    idem: 'client-id',
    retry: 'in-process',
    wait: 'none',
    errors: ['batch_too_large', 'text_too_long', 'reserved_label', 'invalid_needs', 'duplicate_id'],
    compat: { method: 'POST', path: '/tasks/batch' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  createdTasks: {
    binds: { service: 'tasks', method: 'getBatch' },
    params: [{ name: 'id', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'CreatedTasksQuery',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['batch_not_found'],
    compat: { method: 'GET', path: '/tasks/batch/:id' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  claimReadyTask: {
    binds: { service: 'tasks', method: 'claimReady' },
    params: [],
    body: 'rest',
    signal: true,
    schema: 'ClaimReadyTaskBody',
    access: 'write',
    idem: 'unsafe',
    retry: 'in-process',
    wait: 'core',
    waitMaxS: 300,
    errors: ['invalid_from'],
    compat: { method: 'POST', path: '/tasks/claim' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  claimTask: {
    binds: { service: 'tasks', method: 'claimTask' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'ClaimTaskBody',
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'task_claimed', 'task_waiting', 'task_blocked', 'task_finished', 'task_assigned'],
    compat: { method: 'POST', path: '/tasks/:id/claim' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  renewTask: {
    binds: { service: 'tasks', method: 'renewTask' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'RenewTaskBody',
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'claim_lost'],
    compat: { method: 'POST', path: '/tasks/:id/renew' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  releaseTask: {
    binds: { service: 'tasks', method: 'releaseTask' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'ReleaseTaskBody',
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'claim_lost'],
    compat: { method: 'POST', path: '/tasks/:id/release' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  completeTask: {
    binds: { service: 'tasks', method: 'completeTask' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'CompleteTaskBody',
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'claim_lost'],
    compat: { method: 'POST', path: '/tasks/:id/complete' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  failTask: {
    binds: { service: 'tasks', method: 'failTask' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'FailTaskBody',
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'claim_lost'],
    compat: { method: 'POST', path: '/tasks/:id/fail' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  blockTask: {
    binds: { service: 'tasks', method: 'blockTask' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'BlockTaskBody',
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'claim_lost', 'task_blocked', 'task_claimed', 'task_finished', 'task_not_owned'],
    compat: { method: 'POST', path: '/tasks/:id/block' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  unblockTask: {
    binds: { service: 'tasks', method: 'unblockTask' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'task_blocked', 'task_finished', 'task_not_owned'],
    compat: { method: 'POST', path: '/tasks/:id/unblock' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  reopenTask: {
    binds: { service: 'tasks', method: 'reopenTask' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'task_finished', 'task_not_owned'],
    compat: { method: 'POST', path: '/tasks/:id/reopen' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  assignTask: {
    binds: { service: 'tasks', method: 'assignTask' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'AssignTaskBody',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'task_finished', 'task_not_owned', 'task_assigned'],
    compat: { method: 'POST', path: '/tasks/:id/assign' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  setTaskNeeds: {
    binds: { service: 'tasks', method: 'setTaskNeeds' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'TaskNeedsBody',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'invalid_needs', 'task_claimed', 'task_finished', 'task_not_owned'],
    compat: { method: 'POST', path: '/tasks/:id/needs' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  cancelTask: {
    binds: { service: 'tasks', method: 'cancelTask' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'CancelTaskBody',
    access: 'write',
    idem: 'fenced',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'not_a_task', 'task_finished', 'task_not_owned'],
    compat: { method: 'POST', path: '/tasks/:id/cancel' },
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  channelTree: {
    binds: { service: 'board', method: 'getChannelTree' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'ChannelTreeQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  updateChannel: {
    binds: { service: 'board', method: 'updateChannel' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'UpdateChannelBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['channel_not_found'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  ensureDm: {
    binds: { service: 'board', method: 'ensureDm' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'EnsureDmBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  groups: {
    binds: { service: 'board', method: 'listGroups' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'GroupsQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  group: {
    binds: { service: 'board', method: 'getGroup' },
    params: [{ name: 'handle', kind: 'string' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['group_not_found'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  createGroup: {
    binds: { service: 'board', method: 'createGroup' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'CreateGroupBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['group_reserved', 'group_exists'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  updateGroup: {
    binds: { service: 'board', method: 'updateGroup' },
    params: [{ name: 'handle', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'UpdateGroupBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['group_not_found'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  deleteGroup: {
    binds: { service: 'board', method: 'deleteGroup' },
    params: [{ name: 'handle', kind: 'string' }],
    body: 'none',
    signal: false,
    schema: null,
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['group_not_found'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  addGroupMembers: {
    binds: { service: 'board', method: 'addGroupMembers' },
    params: [{ name: 'handle', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'GroupMembersBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['group_not_found'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  removeGroupMembers: {
    binds: { service: 'board', method: 'removeGroupMembers' },
    params: [{ name: 'handle', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'GroupMembersBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['group_not_found'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  notifications: {
    binds: { service: 'board', method: 'listNotifications' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'NotificationsQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_cursor'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  notificationCount: {
    binds: { service: 'board', method: 'countNotifications' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'NotificationsQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_cursor'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  ackNotification: {
    binds: { service: 'board', method: 'ackNotification' },
    params: [{ name: 'id', kind: 'string' }],
    body: 'rest',
    signal: false,
    schema: 'AckNotificationBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['notification_not_found'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  ackAllNotifications: {
    binds: { service: 'board', method: 'ackAllNotifications' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'AckAllNotificationsBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['invalid_cursor'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  waitNotifications: {
    binds: { service: 'board', method: 'waitNotifications' },
    params: [],
    body: 'rest',
    signal: true,
    schema: 'WaitNotificationsQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'core',
    waitMaxS: 300,
    errors: ['invalid_cursor'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  markChannelRead: {
    binds: { service: 'board', method: 'markChannelRead' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'MarkChannelReadBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['channel_not_found', 'invalid_cursor'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  agentInbox: {
    binds: { service: 'board', method: 'getAgentInbox' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'AgentInboxQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  pinMessage: {
    binds: { service: 'board', method: 'pinMessage' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'PinBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found', 'message_deleted'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  unpinMessage: {
    binds: { service: 'board', method: 'unpinMessage' },
    params: [{ name: 'id', kind: 'ref' }],
    body: 'rest',
    signal: false,
    schema: 'UnpinBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: ['message_not_found'],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  pins: {
    binds: { service: 'board', method: 'listPins' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'PinsQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  setPresence: {
    binds: { service: 'board', method: 'setPresence' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'SetPresenceBodySchema',
    access: 'write',
    idem: 'natural',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
  presence: {
    binds: { service: 'board', method: 'listPresence' },
    params: [],
    body: 'rest',
    signal: false,
    schema: 'PresenceQuerySchema',
    access: 'read',
    idem: 'read',
    retry: 'in-process',
    wait: 'none',
    errors: [],
    compat: null,
    since: PROTOCOL_VERSION,
    stability: 'stable',
    gated: {},
  },
} as const satisfies Record<string, OpSpec>

export type OpName = keyof typeof RAW_OPS

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

/** Deep-frozen. */
export const OPS: { readonly [K in OpName]: OpSpec & (typeof RAW_OPS)[K] } = deepFreeze(RAW_OPS)

/** Sorted; 84 names. */
export const OP_NAMES: readonly OpName[] = Object.freeze((Object.keys(OPS) as OpName[]).sort())

/** Codes any op may answer, beyond its own list; includes transport-level and identity-level refusals. */
export const UNIVERSAL_ERRORS: readonly string[] = Object.freeze([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'internal',
  'unavailable',
  'schema_too_new',
  'not_supported',
  'backpressure_shed',
  'cursor_expired',
  'duplicate_id',
  // Review note (B4, HS-71 dynamic check): the identity provider resolves `as` before any op runs, so every op
  // can answer its refusals.
  'invalid_profile',
  'profile_mismatch',
  'agent_identity_required',
  'agent_cannot_impersonate_human',
  'daemon_unavailable',
])

/** TRANSPORT_ALLOW members deliberately bound to no op: `${service}.${method}` to the reason. */
export const NOT_ROUTED: Readonly<Record<string, string>> = Object.freeze({
  'tasks.claimReadyOnce':
    'claimReadyTask without wait is the same single attempt; one op per verb family keeps the CLI and MCP surfaces small',
})

/** Route keys of the original protocol (orig api/routes.ts) that have no op here, with the reason. */
export const ORIGINAL_NOT_ROUTED: Readonly<Record<string, string>> = Object.freeze({
  discovery: 'served by the host from boardInfo() and the capabilities, never an op',
  linked: 'no platform link index in Swarmboard: 501',
  typing: 'no live platform sync: 501',
  readSource: 'no platform sources: 501',
  joinSource: 'no platform sources: 501',
  webhook: 'platform ingress belongs to the daemon and sync work (HOST-9)',
  avatar: 'no avatar store',
  openapi: 'HOST-9 generates it from this table',
  wake: 'no wake endpoint; a watcher registration with a url or path is refused (no_wake_by_url, no_wake_by_path)',
})

export function isOpName(name: string): name is OpName {
  return Object.hasOwn(OPS, name)
}

// ---- Types derived from the table and the core (type-only imports: zero run-time cost)
type Spec<O extends OpName> = (typeof OPS)[O]
type Services = { board: BoardService; tasks: TaskService }
type MethodOf<O extends OpName> = Services[Spec<O>['binds']['service']][Spec<O>['binds']['method'] &
  keyof Services[Spec<O>['binds']['service']]]
type ParamValue<K> = K extends 'ref' ? string | number : K extends 'int' ? number : K extends 'bytes' ? Uint8Array : string
type ParamsInput<O extends OpName> = {
  [P in Spec<O>['params'][number] as P extends { optional: true } ? never : P['name']]: ParamValue<P['kind']>
} & {
  [P in Spec<O>['params'][number] as P extends { optional: true } ? P['name'] : never]?: ParamValue<P['kind']>
}
type BodyInput<O extends OpName> =
  Spec<O>['schema'] extends infer S extends SchemaName
    ? z.input<(typeof Core)[S]>
    : MethodOf<O> extends (caller: never, ...rest: infer A) => unknown
      ? A[Spec<O>['params']['length']]
      : never
/** What a call takes: the positional params by name, plus the body fields. An op with neither takes `{}` only. */
export type OpInput<O extends OpName> = Spec<O>['body'] extends 'none'
  ? Spec<O>['params'] extends readonly []
    ? Record<string, never>
    : ParamsInput<O>
  : ParamsInput<O> & BodyInput<O>
export type OpOutput<O extends OpName> = MethodOf<O> extends (...a: never[]) => infer R ? Awaited<R> : never

/** Lane kind: 'wait' when the op holds the call (events, claimReadyTask, matches), else its access. */
export function laneKind(op: OpName): 'read' | 'write' | 'wait' {
  const spec = OPS[op]
  return spec.wait !== 'none' ? 'wait' : spec.access
}

// ---- Envelope

const MAX_DEPTH = 64
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function bad(message: string): never {
  throw clientError('invalid_request', message)
}

/** The first value that is not JSON (Date, Map, function, NaN, bigint, class instance, cycle), as a path. */
function jsonViolation(value: unknown, path: string, depth: number, ancestors: unknown[]): string | null {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return null
  if (typeof value === 'number') return Number.isFinite(value) ? null : path
  if (typeof value !== 'object') return path
  if (depth > MAX_DEPTH || ancestors.includes(value)) return path
  ancestors.push(value)
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item: unknown = value[i]
        if (item === undefined) return `${path}[${i}]`
        const found = jsonViolation(item, `${path}[${i}]`, depth + 1, ancestors)
        if (found !== null) return found
      }
      return null
    }
    if (!isPlainObject(value)) return path
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      const found = jsonViolation(v, path === '' ? k : `${path}.${k}`, depth + 1, ancestors)
      if (found !== null) return found
    }
    return null
  } finally {
    ancestors.pop()
  }
}

const REF_MAX = 200
const STRING_MAX = 300

/** Transport-level validation shared by every transport: Mode 0 refuses what the wire refuses. Throws ClientError 400. */
export function validateEnvelope(op: OpName, input: unknown): void {
  if (!isOpName(op)) throw clientError('not_supported', `${String(op)} is not an operation of this board`)
  const spec = OPS[op]
  if (input !== undefined && !isPlainObject(input)) bad('input must be an object')
  const obj: Record<string, unknown> = input ?? {}
  const names = new Set<string>()
  for (const p of spec.params) {
    names.add(p.name)
    const v = obj[p.name]
    if (v === undefined) {
      if (p.optional === true) continue
      bad(`${p.name}: required`)
    }
    switch (p.kind) {
      case 'ref':
        if (typeof v === 'string') {
          if (v.length < 1 || v.length > REF_MAX) bad(`${p.name}: must be 1 to ${REF_MAX} characters`)
        } else if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
          bad(`${p.name}: must be a message id or a non-negative integer`)
        }
        break
      case 'string':
        if (typeof v !== 'string' || v.length < 1 || v.length > STRING_MAX) bad(`${p.name}: must be a string of 1 to ${STRING_MAX} characters`)
        break
      case 'int':
        if (typeof v !== 'number' || !Number.isSafeInteger(v)) bad(`${p.name}: must be an integer`)
        break
      case 'bytes':
        if (!(v instanceof Uint8Array)) bad(`${p.name}: must be bytes`)
        break
    }
  }
  if (spec.body === 'none') {
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined && !names.has(k)) bad(`${k}: not a field of ${op}`)
    }
  }
  const exempt = new Set<string>([...(spec.bytesFields ?? []), ...spec.params.filter((p) => p.kind === 'bytes').map((p) => p.name)])
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || exempt.has(k)) continue
    const found = jsonViolation(v, k, 1, [])
    if (found !== null) bad(`${found}: not a JSON value`)
  }
  for (const k of spec.bytesFields ?? []) {
    const v = obj[k]
    if (v !== undefined && !(v instanceof Uint8Array)) bad(`${k}: must be bytes`)
  }
}

/** [caller, ...params, body?, signal?] and never longer, so createSchedule always gets 2 arguments (no nowMs). */
export function bindArgs(
  op: OpName,
  input: Record<string, unknown>,
  caller: unknown,
  signal: AbortSignal | undefined,
): unknown[] {
  const spec = OPS[op]
  const args: unknown[] = [caller]
  const names = new Set<string>()
  for (const p of spec.params) {
    names.add(p.name)
    args.push(input[p.name])
  }
  if (spec.body === 'rest') {
    // fromEntries defines own data properties, so a `__proto__` key cannot reach the prototype.
    args.push(Object.fromEntries(Object.entries(input).filter(([k]) => !names.has(k))))
  }
  if (spec.signal) args.push(signal)
  return args
}
