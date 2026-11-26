// BoardClient facade (HOST123_DESIGN 5.7, designs g1 9): ergonomic original-handle API over any BoardTransport.
// Thin module: runtime imports ONLY ./ops.ts and ./errors.ts; everything else is type-only.
import type {
  AckAllNotificationsInput,
  AckNotificationInput,
  ActorsQueryInput,
  ActorView,
  AgentInboxQueryInput,
  AgentInboxView,
  Attachment,
  BoardEventView,
  ChannelMessagesQueryInput,
  ChannelsPage,
  ChannelsQueryInput,
  ChannelTreePage,
  ChannelTreeQueryInput,
  ChannelView,
  CreateChannelInput,
  CreateGroupInput,
  EventsPage,
  EventsQueryInput,
  Explanation,
  FtsSearchHit,
  FtsSearchQuery,
  GrantView,
  GroupMembersInput,
  GroupsQueryInput,
  GroupView,
  InboxEntry,
  InboxItem,
  MatchView,
  Mentioned,
  MessagesPage,
  MessageView,
  MeView,
  NotificationsPage,
  NotificationsQueryInput,
  NotificationView,
  Permission,
  PinInput,
  PinsQueryInput,
  PinView,
  PresenceQueryInput,
  PresenceView,
  PrincipalInput,
  RegisterInput,
  RegistrationView,
  SchedulesQueryInput,
  ScheduleView,
  SchemaInput,
  SchemaView,
  SetPresenceInput,
  SyncCopiesView,
  SyncedView,
  SyncFindInput,
  SyncFindView,
  SyncImportInput,
  SyncReceiptInput,
  SyncThreadView,
  TaskClaim,
  TasksPage,
  TasksQueryInput,
  ThreadQueryInput,
  ThreadsPage,
  ThreadsQueryInput,
  ThreadView,
  UnpinInput,
  UpdateChannelInput,
  UpdateGroupInput,
  WaitNotificationsQueryInput,
} from '../core/public.ts'
import { clientError, isBoardError } from './errors.ts'
import { OPS, isOpName, type OpInput, type OpName, type OpOutput } from './ops.ts'
import type { ExplainStep, Resolution } from './resolve.ts'
import type { BoardTransport, CallOptions, Capabilities, EventsFeedQuery, Selection } from './types.ts'

/** Round duration in seconds for long-polling feeds (matches dispatcher feed round). */
const FEED_ROUND_S = 30
/** Pause ceiling in milliseconds when claimReadyTask returns empty early. */
const CLAIM_AGAIN_MS = 1000
const PROFILE_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/

const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Parses an original-handle duration string (`'30s'`, `'10m'`, `'1h'`, `'200ms'`) or ms number. */
export function duration(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw clientError('invalid_request', `duration must be a non-negative finite number of milliseconds`)
    }
    return value
  }
  if (typeof value !== 'string') {
    throw clientError('invalid_request', `duration must be a string or number`)
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/)
  if (!match) {
    throw clientError('invalid_request', `${value} isn't a duration like 30s, 10m, or 1h.`)
  }
  return Number(match[1]) * UNITS[match[2] ?? 'ms']!
}

function checkProfile(profile: string | null): string | null {
  if (profile === null) return null
  if (typeof profile !== 'string' || !PROFILE_PATTERN.test(profile)) {
    throw clientError(
      'invalid_profile',
      'profiles start with a letter and use up to 32 letters, numbers, and hyphens',
    )
  }
  return profile
}

function linkSignal(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): { readonly signal: AbortSignal | undefined; dispose(): void } {
  if (a === undefined && b === undefined) return { signal: undefined, dispose: () => {} }
  if (a !== undefined && b === undefined) return { signal: a, dispose: () => {} }
  if (a === undefined && b !== undefined) return { signal: b, dispose: () => {} }
  const ctrl = new AbortController()
  if (a!.aborted) {
    ctrl.abort(a!.reason)
    return { signal: ctrl.signal, dispose: () => {} }
  }
  if (b!.aborted) {
    ctrl.abort(b!.reason)
    return { signal: ctrl.signal, dispose: () => {} }
  }
  const onA = () => ctrl.abort(a!.reason)
  const onB = () => ctrl.abort(b!.reason)
  a!.addEventListener('abort', onA, { once: true })
  b!.addEventListener('abort', onB, { once: true })
  let disposed = false
  return {
    signal: ctrl.signal,
    dispose() {
      if (disposed) return
      disposed = true
      a!.removeEventListener('abort', onA)
      b!.removeEventListener('abort', onB)
    },
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---- Handle option & result types (compatible with original @vercel/board client)

export type Written<T> = T & { mentions?: Mentioned[] }

export type PostOptions = {
  text: string
  labels?: Record<string, string>
  noSync?: boolean
  sync?: (string | { target: string; kind: 'channel' | 'thread' })[]
  id?: string
  attachments?: (Attachment | string)[]
  quoteMessageId?: string | number
}

export type ReplyOptions = Omit<PostOptions, 'sync'> & {
  after?: string
}

export type CreateChannelMetaOpts = Omit<CreateChannelInput, 'path'>

export type DmPostOptions = Omit<PostOptions, 'sync'> & {
  topic?: string
}

export type DmReadOptions = {
  topic?: string
  limit?: number
  after?: string
}

export type DmPostResult = {
  readonly channel: ChannelView
  readonly created: boolean
  readonly peer: string
  readonly message: Written<MessageView>
}

export type DmReadResult = {
  readonly channel: ChannelView
  readonly created: boolean
  readonly peer: string
  readonly messages: MessageView[]
  readonly cursor: string
}

export interface GroupOps {
  list(q?: GroupsQueryInput, o?: CallOptions): Promise<GroupView[]>
  get(handle: string, o?: CallOptions): Promise<GroupView>
  create(input: CreateGroupInput, o?: CallOptions): Promise<GroupView>
  update(handle: string, patch: UpdateGroupInput, o?: CallOptions): Promise<GroupView>
  delete(handle: string, o?: CallOptions): Promise<{ deleted: boolean }>
  addMembers(
    handle: string,
    members: readonly string[] | GroupMembersInput,
    opts?: { role?: 'member' | 'lead' } & CallOptions,
    o?: CallOptions,
  ): Promise<GroupView>
  removeMembers(
    handle: string,
    members: readonly string[] | GroupMembersInput,
    o?: CallOptions,
  ): Promise<GroupView>
}

export interface NotificationOps {
  list(q?: NotificationsQueryInput, o?: CallOptions): Promise<NotificationsPage>
  count(q?: NotificationsQueryInput, o?: CallOptions): Promise<{
    total: number
    unread: number
    urgent: number
    byReason: Record<string, number>
  }>
  ack(
    id: string | number,
    opts?: AckNotificationInput & CallOptions,
    o?: CallOptions,
  ): Promise<{ ok: boolean; notification: NotificationView }>
  ackAll(input?: AckAllNotificationsInput, o?: CallOptions): Promise<{ acked: number; cursor: string }>
  wait(
    q?: WaitNotificationsQueryInput & { timeout?: string | number },
    o?: WaitOptions,
  ): Promise<NotificationsPage>
}

export interface PinOps {
  pin(
    id: string | number,
    opts?: PinInput & CallOptions,
    o?: CallOptions,
  ): Promise<{ pin: PinView; created: boolean }>
  unpin(
    id: string | number,
    opts?: UnpinInput & CallOptions,
    o?: CallOptions,
  ): Promise<{ unpinned: number }>
  list(q?: PinsQueryInput, o?: CallOptions): Promise<PinView[]>
}

export interface PresenceOps {
  set(input?: SetPresenceInput, o?: CallOptions): Promise<PresenceView>
  list(q?: PresenceQueryInput, o?: CallOptions): Promise<PresenceView[]>
}

export type FlagOptions = {
  feedback?: boolean
  crossPostFeedback?: boolean
  resolve?: boolean
}

export type FlagResult = {
  readonly ok: true
  readonly message: MessageView
  readonly feedback?: Written<MessageView>
}

export interface FeedbackInput {
  readonly summary: string
  readonly kind?: string
  readonly severity?: string
  readonly harness?: string
  readonly model?: string
  readonly tool?: string
  readonly repro?: string
  readonly expected?: string
  readonly actual?: string
  readonly suggestion?: string
  readonly details?: string
  readonly channel?: string
  readonly [extra: string]: unknown
}

export type ScheduleTiming = {
  in?: string
  at?: Date | string
  every?: string
  until?: Date | string
  for?: string
  times?: number
}

export type ScheduleOptions = Omit<PostOptions, 'sync' | 'id'> & ScheduleTiming

export type TaskOptions = {
  needs?: string[]
  for?: string | null
  claim?: boolean
  lease?: number
  token?: string
}

export type NewTaskOptions = TaskOptions & Pick<PostOptions, 'text' | 'labels' | 'noSync' | 'attachments' | 'id'>

export type TaskInBatch = Required<Pick<PostOptions, 'text'>> &
  Pick<PostOptions, 'labels' | 'noSync' | 'attachments'> & {
    key?: string
    needs?: (string | { key: string })[]
    for?: string | null
  }

export type HeldTask = {
  renew(lease?: number, o?: CallOptions): Promise<ClaimedTask>
  release(o?: CallOptions): Promise<MessageView>
  complete(result?: string, o?: CallOptions): Promise<MessageView>
  fail(reason: string, o?: CallOptions): Promise<MessageView>
  block(reason: string, opts?: { kind?: string } & CallOptions): Promise<MessageView>
}

export type ClaimedTask = HeldTask & TaskClaim & { task: MessageView }

export type LabelChange = {
  set?: Record<string, string>
  unset?: string[]
  if?: Record<string, string | null>
}

export type ExplainPrincipal = {
  user?: string
  project?: string
  environment?: string
  github?: string
  workflow?: string
  branch?: string
  event?: string
  oidc?: string
  claims?: Record<string, string>
  app?: string
}

export type CanAt = 'all' | 'none' | readonly Permission[]
export type GrantCan = Readonly<Record<string, CanAt>>
export type GrantInput = { principals: readonly PrincipalInput[]; can: GrantCan }
export type GrantWriteOptions = { lockMeOut?: boolean }
export type UpdateGrantInput = { add?: readonly PrincipalInput[]; remove?: readonly PrincipalInput[]; can?: GrantCan }

export type WaitOptions = {
  timeout?: string | number
  signal?: AbortSignal
} & CallOptions

export type Filters = {
  channel?: string
  re?: string
  by?: string
  mentions?: string
  label?: Record<string, string> | string | string[]
  from?: string
  text?: string
}

export type ClientFiltersQuery = Omit<EventsFeedQuery, 'label'> & {
  label?: Record<string, string> | string | string[]
}

export type SearchQueryInput = FtsSearchQuery

export interface ClientInit {
  readonly selection: Selection
  readonly profile?: string | null
  readonly resolution?: Resolution | null
  readonly warnings?: readonly ExplainStep[]
  /** Test-only overlay for OPS (gated-field capability tests). */
  readonly opsOverride?: typeof OPS
}

export interface TaskOps {
  list(
    q?: Omit<TasksQueryInput, 'label'> & { label?: Record<string, string> | string | string[] },
    o?: CallOptions,
  ): Promise<TasksPage>
  create(
    target: string,
    input: string | NewTaskOptions,
    o?: CallOptions,
  ): Promise<{ task: MessageView; claim?: ClaimedTask; mentions?: Mentioned[] }>
  create(
    target: { re: string | number },
    input?: TaskOptions,
    o?: CallOptions,
  ): Promise<{ task: MessageView; claim?: ClaimedTask; mentions?: Mentioned[] }>
  createMany(channel: string, tasks: TaskInBatch[], opts?: { id?: string } & CallOptions): Promise<MessageView[]>
  batch(id: string, q?: { request?: string }, o?: CallOptions): Promise<MessageView[]>
  claim(target: string, opts?: { lease?: number; token?: string } & CallOptions): Promise<ClaimedTask>
  claim(
    target: {
      channel: string
      label?: Record<string, string>
      from?: string[]
      wait?: number
      lease?: number
      token?: string
    },
    o?: CallOptions,
  ): Promise<ClaimedTask | null>
  held(id: string, proof: { epoch: number; token: string }): HeldTask
  block(id: string | number, reason: string, opts?: { kind?: string } & CallOptions): Promise<MessageView>
  unblock(id: string | number, o?: CallOptions): Promise<MessageView>
  reopen(id: string | number, o?: CallOptions): Promise<MessageView>
  assign(id: string | number, actor: string | null, o?: CallOptions): Promise<MessageView>
  needs(id: string | number, needs: string[], o?: CallOptions): Promise<MessageView>
  cancel(id: string | number, reason: string, o?: CallOptions): Promise<MessageView>
}

export interface BoardClient {
  readonly caps: Capabilities
  readonly selection: Selection
  readonly profile: string | null | undefined
  readonly resolution: Resolution | null
  readonly warnings: readonly ExplainStep[]
  readonly raw: BoardTransport
  as(profile: string | null): BoardClient
  call<O extends OpName>(op: O, input: OpInput<O>, opts?: CallOptions): Promise<OpOutput<O>>
  me(o?: CallOptions): Promise<MeView>
  channels(q?: ChannelsQueryInput, o?: CallOptions): Promise<ChannelsPage>
  channelTree(q?: ChannelTreeQueryInput, o?: CallOptions): Promise<ChannelTreePage>
  createChannel(
    path: string,
    opts?: CreateChannelMetaOpts & CallOptions,
  ): Promise<{ channel: ChannelView; created: boolean }>
  updateChannel(
    path: string,
    patch: Omit<UpdateChannelInput, 'path'>,
    o?: CallOptions,
  ): Promise<{ channel: ChannelView }>
  dm(peer: string, input: string | (DmPostOptions & CallOptions), o?: CallOptions): Promise<DmPostResult>
  dm(peer: string, opts?: DmReadOptions & CallOptions, o?: CallOptions): Promise<DmReadResult>
  dm(
    peer: string,
    opts?: string | (Partial<DmPostOptions> & DmReadOptions & CallOptions),
    o?: CallOptions,
  ): Promise<DmPostResult | DmReadResult>
  readonly groups: GroupOps
  readonly notifications: NotificationOps
  markChannelRead(channel: string, cursor?: string, o?: CallOptions): Promise<{ channel: string; cursor: string }>
  agentInbox(q?: AgentInboxQueryInput, o?: CallOptions): Promise<AgentInboxView>
  readonly pins: PinOps
  readonly presence: PresenceOps
  flag(id: string | number, reason: string, opts?: FlagOptions & CallOptions, o?: CallOptions): Promise<FlagResult>
  feedback(input: FeedbackInput, o?: CallOptions): Promise<Written<MessageView>>
  actors(q?: ActorsQueryInput, o?: CallOptions): Promise<(ActorView & { id: string })[]>
  channel(name: string): {
    messages(q?: Omit<ChannelMessagesQueryInput, 'channel'>, o?: CallOptions): Promise<MessagesPage>
  }
  thread(id: string | number, q?: ThreadQueryInput, o?: CallOptions): Promise<ThreadView>
  posted(id: string, o?: CallOptions): Promise<MessageView>
  threads(
    q?: Omit<ThreadsQueryInput, 'label'> & { label?: Record<string, string> | string | string[] },
    o?: CallOptions,
  ): Promise<ThreadsPage>
  post(channel: string, input: string | PostOptions, o?: CallOptions): Promise<Written<MessageView>>
  reply(id: string | number, input: string | ReplyOptions, o?: CallOptions): Promise<Written<MessageView>>
  edit(
    id: string | number,
    text: string,
    opts?: { revision?: number } & CallOptions,
  ): Promise<{ ok: true; message: MessageView; mentions?: Mentioned[] }>
  delete(id: string | number, opts?: { revision?: number } & CallOptions): Promise<{ ok: true; message: MessageView }>
  react(
    id: string | number,
    emoji: string,
    opts?: { remove?: boolean } & CallOptions,
  ): Promise<{ ok: true; message: MessageView }>
  label(id: string | number, change: LabelChange, o?: CallOptions): Promise<{ ok: true; message: MessageView }>
  schedule(
    target: string | { re: string | number },
    input: ScheduleOptions,
    o?: CallOptions,
  ): Promise<ScheduleView & { mentions?: Mentioned[] }>
  schedules(q?: SchedulesQueryInput, o?: CallOptions): Promise<ScheduleView[]>
  cancelSchedule(id: string, o?: CallOptions): Promise<{ schedule: ScheduleView; canceled: boolean }>
  readonly tasks: TaskOps
  grants(o?: CallOptions): Promise<GrantView[]>
  createGrant(input: GrantInput, o?: GrantWriteOptions & CallOptions): Promise<{ grant: GrantView }>
  createGrants(inputs: readonly GrantInput[], o?: GrantWriteOptions & CallOptions): Promise<{ grants: GrantView[] }>
  updateGrant(
    id: string,
    change: UpdateGrantInput,
    o?: GrantWriteOptions & CallOptions,
  ): Promise<{ grant: GrantView }>
  explain(channel: string, principal?: ExplainPrincipal, o?: CallOptions): Promise<Explanation>
  revokeGrant(id: string, o?: GrantWriteOptions & CallOptions): Promise<{ revoked: boolean }>
  schemas(o?: CallOptions): Promise<SchemaView[]>
  schema(id: string, o?: CallOptions): Promise<SchemaView>
  createSchema(input: SchemaInput, o?: CallOptions): Promise<{ schema: SchemaView; created: boolean }>
  upload(input: { data: Uint8Array; name: string; type?: string }, o?: CallOptions): Promise<Attachment>
  attachment(id: string, o?: CallOptions): Promise<{ meta: Attachment; data: Uint8Array }>
  sync(id: string | number, o?: CallOptions): Promise<SyncedView>
  sync(id: string | number, target: string, o?: CallOptions): Promise<{ target: string; attached: boolean }>
  inbox(key: string, opts?: { channel?: string; limit?: number } & CallOptions, o?: CallOptions): Promise<InboxEntry[]>
  inboxPush(
    key: string,
    events: { id: string; event: InboxItem['event']; raw: unknown }[],
    o?: CallOptions,
  ): Promise<{ ok: true; accepted: number }>
  inboxNext(key: string, opts?: { limit?: number } & CallOptions, o?: CallOptions): Promise<InboxItem[]>
  inboxAck(key: string, id: string, body: { lease: string; error?: string }, o?: CallOptions): Promise<{ ok: boolean }>
  syncImport(body: SyncImportInput, o?: CallOptions): Promise<OpOutput<'syncImport'>>
  syncReceipt(body: SyncReceiptInput, o?: CallOptions): Promise<{ ok: boolean; attached?: boolean }>
  syncThread(thread: string, o?: CallOptions): Promise<SyncThreadView>
  syncFind(query: SyncFindInput, o?: CallOptions): Promise<SyncFindView>
  syncCopies(messages: string[], o?: CallOptions): Promise<SyncCopiesView['copies']>
  register(input: RegisterInput, o?: CallOptions): Promise<RegistrationView>
  watchers(o?: CallOptions): Promise<RegistrationView[]>
  matches(opts?: { limit?: number; wait?: number } & CallOptions, o?: CallOptions): Promise<MatchView[]>
  ack(
    id: string,
    body: { lease: string; error?: string; skip?: boolean },
    o?: CallOptions,
  ): Promise<{ ok: boolean }>
  search(q: FtsSearchQuery | OpInput<'search'>, o?: CallOptions): Promise<FtsSearchHit[]>
  poll(
    q?: ClientFiltersQuery & { after?: string; wait?: number; all?: boolean; last?: number },
    o?: CallOptions,
  ): Promise<EventsPage>
  pages(
    q?: ClientFiltersQuery & { after?: string; all?: boolean; last?: number },
    o?: CallOptions,
  ): AsyncIterable<EventsPage>
  events(
    q?: ClientFiltersQuery & { after?: string; all?: boolean; last?: number },
    o?: CallOptions,
  ): AsyncIterable<BoardEventView>
  wait(q?: ClientFiltersQuery & { after?: string }, o?: WaitOptions): Promise<BoardEventView | null>
  waitPage(q: ClientFiltersQuery & { timeoutS: number; after?: string }, o?: CallOptions): Promise<EventsPage>
  close(): Promise<void>
}

// ---- Wire/body helpers

function messageBody(input: string | PostOptions | ReplyOptions | NewTaskOptions | TaskOptions): Record<string, unknown> {
  if (typeof input === 'string') return { text: input }
  const out: Record<string, unknown> = { ...input }
  if ('attachments' in out) {
    const attachments = out['attachments'] as (Attachment | string)[] | undefined
    delete out['attachments']
    if (attachments?.length) {
      out['attachments'] = attachments.map((a) => (typeof a === 'string' ? a : a.id))
    }
  }
  if ('quoteMessageId' in out && typeof out['quoteMessageId'] === 'number') {
    out['quoteMessageId'] = String(out['quoteMessageId'])
  }
  return out
}

function splitCallOptions<T extends object>(
  opts: (T & CallOptions) | undefined,
): { readonly rest: Partial<Omit<T, keyof CallOptions>>; readonly inlineOpts: CallOptions } {
  if (!opts) return { rest: {}, inlineOpts: {} }
  const { signal, idempotencyKey, as, expectInstance, ...rest } = opts
  const inlineOpts: CallOptions = {
    ...(signal !== undefined ? { signal } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(as !== undefined ? { as } : {}),
    ...(expectInstance !== undefined ? { expectInstance } : {}),
  }
  return { rest: rest as Partial<Omit<T, keyof CallOptions>>, inlineOpts }
}

function sanitizeLabelValue(value: string, maxLen = 256): string {
  const cleaned = value.replace(/\p{Cc}+/gu, ' ').trim()
  const chars = Array.from(cleaned)
  return chars.length <= maxLen ? cleaned : chars.slice(0, maxLen).join('')
}

function safeJsonFence(json: string): string {
  let maxTicks = 2
  for (const m of json.matchAll(/`+/g)) {
    if (m[0].length > maxTicks) maxTicks = m[0].length
  }
  return '`'.repeat(maxTicks + 1)
}

function formatInstant(field: 'at' | 'until', value: unknown): unknown {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw clientError('invalid_request', `${field}: invalid Date`)
    }
    return value.toISOString()
  }
  return value
}

function scheduleBody(input: ScheduleOptions): Record<string, unknown> {
  const { at, until, ...rest } = messageBody(input) as ScheduleOptions & Record<string, unknown>
  return {
    ...rest,
    ...(at !== undefined ? { at: formatInstant('at', at) } : {}),
    ...(until !== undefined ? { until: formatInstant('until', until) } : {}),
  }
}

function normalizeFilters<T extends { label?: unknown }>(q: T | undefined): Record<string, unknown> {
  if (!q) return {}
  const { label, ...rest } = q
  if (label !== undefined && label !== null && typeof label === 'object' && !Array.isArray(label)) {
    return {
      ...rest,
      label: Object.entries(label as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`),
    }
  }
  return label !== undefined ? { ...rest, label } : { ...rest }
}

function wireCan<T>(can: T): T {
  if (can === null || typeof can !== 'object' || Array.isArray(can)) return can
  return Object.fromEntries(Object.entries(can).map(([pattern, grant]) => [pattern, grant === 'none' ? [] : grant])) as T
}

function withEnvironments(principal: PrincipalInput): PrincipalInput {
  return (principal.kind === 'project' || principal.kind === 'all-projects') && principal.environments === undefined
    ? { ...principal, environments: ['production'] }
    : principal
}

function wireGrant(input: GrantInput): { principals: PrincipalInput[]; can: Record<string, 'all' | readonly Permission[]> } {
  return {
    principals: input.principals.map(withEnvironments),
    can: wireCan(input.can) as Record<string, 'all' | readonly Permission[]>,
  }
}

function mergeCallOptions(inline: CallOptions, extra: CallOptions | undefined): CallOptions | undefined {
  const hasInline =
    inline.signal !== undefined ||
    inline.idempotencyKey !== undefined ||
    inline.as !== undefined ||
    inline.expectInstance !== undefined
  if (!hasInline) return extra
  if (!extra) return inline
  return { ...inline, ...extra }
}

// ---- Factory

export function createBoardClient(transport: BoardTransport, init: ClientInit): BoardClient {
  if (init.profile !== undefined && init.profile !== null) {
    checkProfile(init.profile)
  }
  const defaultProfile = init.profile
  const resolution = init.resolution ?? null
  const warnings: readonly ExplainStep[] = Object.freeze([...(init.warnings ?? [])])
  const opsTable = init.opsOverride ?? OPS

  const mergeOpts = (opts?: CallOptions): CallOptions | undefined => {
    if (defaultProfile === undefined || opts?.as !== undefined) return opts
    return { ...(opts ?? {}), as: defaultProfile }
  }

  const checkOpSupport = (op: OpName, input: unknown): void => {
    const caps = transport.capabilities
    if (!isOpName(op) && !Object.hasOwn(opsTable, op)) {
      throw clientError('not_supported', `operation ${String(op)} is not supported by this board`)
    }
    if (!caps.ops.includes(op)) {
      throw clientError('not_supported', `operation ${op} is not supported by this transport`)
    }
    const spec = opsTable[op]
    if (spec?.gated && input !== null && typeof input === 'object') {
      const rec = input as Record<string, unknown>
      for (const [field, flag] of Object.entries(spec.gated)) {
        if (rec[field] !== undefined && !caps[flag]) {
          throw clientError(
            'not_supported',
            `${op}: field '${field}' requires capability '${flag}' which is not supported by this transport`,
          )
        }
      }
    }
  }

  const call = async <O extends OpName>(op: O, input: OpInput<O>, opts?: CallOptions): Promise<OpOutput<O>> => {
    checkOpSupport(op, input)
    return transport.call(op, input, mergeOpts(opts))
  }

  const held = (id: string, proof: { epoch: number; token: string }): HeldTask => {
    const { epoch, token } = proof
    return {
      async renew(lease?: number, o?: CallOptions): Promise<ClaimedTask> {
        const { task, until } = await call(
          'renewTask',
          { id, epoch, token, ...(lease !== undefined ? { lease } : {}) },
          o,
        )
        return claimed(task, { epoch, token, until })
      },
      release: async (o?: CallOptions): Promise<MessageView> =>
        (await call('releaseTask', { id, epoch, token }, o)).task,
      complete: async (result?: string, o?: CallOptions): Promise<MessageView> =>
        (await call('completeTask', { id, epoch, token, ...(result !== undefined ? { result } : {}) }, o)).task,
      fail: async (reason: string, o?: CallOptions): Promise<MessageView> =>
        (await call('failTask', { id, epoch, token, reason }, o)).task,
      block: async (reason: string, opts?: { kind?: string } & CallOptions): Promise<MessageView> => {
        const { kind, ...callOpts } = opts ?? {}
        return (
          await call('blockTask', { id, epoch, token, reason, ...(kind !== undefined ? { kind } : {}) }, callOpts)
        ).task
      },
    }
  }

  const claimed = (task: MessageView, claim: TaskClaim): ClaimedTask => ({
    task,
    ...claim,
    ...held(task.id, claim),
  })

  async function createTask(
    target: string,
    input: string | NewTaskOptions,
    o?: CallOptions,
  ): Promise<{ task: MessageView; claim?: ClaimedTask; mentions?: Mentioned[] }>
  async function createTask(
    target: { re: string | number },
    input?: TaskOptions,
    o?: CallOptions,
  ): Promise<{ task: MessageView; claim?: ClaimedTask; mentions?: Mentioned[] }>
  async function createTask(
    target: string | { re: string | number },
    input: string | NewTaskOptions | TaskOptions = {},
    o?: CallOptions,
  ): Promise<{ task: MessageView; claim?: ClaimedTask; mentions?: Mentioned[] }> {
    const where = typeof target === 'string' ? { channel: target } : { re: target.re }
    const made = messageBody(input)
    const { task, claim, mentions } = await call(
      'createTask',
      { ...where, ...made } as OpInput<'createTask'>,
      o,
    )
    return {
      task,
      ...(claim ? { claim: claimed(task, claim) } : {}),
      ...(mentions ? { mentions } : {}),
    }
  }

  async function claimTask(
    target: string,
    opts?: { lease?: number; token?: string } & CallOptions,
  ): Promise<ClaimedTask>
  async function claimTask(
    target: {
      channel: string
      label?: Record<string, string>
      from?: string[]
      wait?: number
      lease?: number
      token?: string
    },
    o?: CallOptions,
  ): Promise<ClaimedTask | null>
  async function claimTask(
    target:
      | string
      | {
          channel: string
          label?: Record<string, string>
          from?: string[]
          wait?: number
          lease?: number
          token?: string
        },
    opts?: ({ lease?: number; token?: string } & CallOptions) | CallOptions,
  ): Promise<ClaimedTask | null> {
    if (typeof target === 'string') {
      const { lease, token, ...callOpts } = (opts ?? {}) as { lease?: number; token?: string } & CallOptions
      const { task, claim } = await call(
        'claimTask',
        {
          id: target,
          ...(lease !== undefined ? { lease } : {}),
          ...(token !== undefined ? { token } : {}),
        },
        callOpts,
      )
      return claimed(task, claim)
    }
    const { wait, ...ready } = target
    if (wait !== undefined && (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0)) {
      throw clientError('invalid_request', 'wait must be a non-negative finite number of seconds')
    }
    const callOpts = opts as CallOptions | undefined
    const signal = callOpts?.signal
    if (signal?.aborted) {
      checkOpSupport('claimReadyTask', ready)
      return null
    }
    const deadline = Date.now() + Math.max(0, (wait ?? 0) * 1000)
    for (;;) {
      const asked = Date.now()
      const maxWaitS = transport.capabilities.maxWaitS
      const hold = Math.max(0, Math.min(maxWaitS, (deadline - asked) / 1000))
      const answer = await call(
        'claimReadyTask',
        { ...ready, ...(hold > 0 ? { wait: hold } : {}) },
        callOpts,
      )
      if (answer.task) return claimed(answer.task, answer.claim)
      const now = Date.now()
      if (now >= deadline || signal?.aborted || transport.closed) return null
      const pause = Math.min(CLAIM_AGAIN_MS - (now - asked), deadline - now)
      if (pause > 0) await abortableSleep(pause, signal)
      if (signal?.aborted || transport.closed) return null
    }
  }

  const tasks: TaskOps = Object.freeze({
    list: (
      q?: Omit<TasksQueryInput, 'label'> & { label?: Record<string, string> | string | string[] },
      o?: CallOptions,
    ) => call('tasks', normalizeFilters(q) as OpInput<'tasks'>, o),
    create: createTask,
    createMany: async (channel: string, batch: TaskInBatch[], opts?: { id?: string } & CallOptions) => {
      const { id, ...callOpts } = opts ?? {}
      const sent = batch.map((t) =>
        t.attachments?.length
          ? { ...t, attachments: t.attachments.map((f) => (typeof f === 'string' ? f : f.id)) }
          : t,
      )
      return (
        await call(
          'createTasks',
          { channel, tasks: sent, ...(id !== undefined ? { id } : {}) } as OpInput<'createTasks'>,
          callOpts,
        )
      ).tasks
    },
    batch: async (id: string, q?: { request?: string }, o?: CallOptions) =>
      (await call('createdTasks', { id, ...(q ?? {}) }, o)).tasks,
    claim: claimTask,
    held,
    block: async (id: string | number, reason: string, opts?: { kind?: string } & CallOptions) => {
      const { kind, ...callOpts } = opts ?? {}
      return (await call('blockTask', { id, reason, ...(kind !== undefined ? { kind } : {}) }, callOpts)).task
    },
    unblock: async (id: string | number, o?: CallOptions) => (await call('unblockTask', { id }, o)).task,
    reopen: async (id: string | number, o?: CallOptions) => (await call('reopenTask', { id }, o)).task,
    assign: async (id: string | number, actor: string | null, o?: CallOptions) =>
      (await call('assignTask', { id, for: actor }, o)).task,
    needs: async (id: string | number, needs: string[], o?: CallOptions) =>
      (await call('setTaskNeeds', { id, needs }, o)).task,
    cancel: async (id: string | number, reason: string, o?: CallOptions) =>
      (await call('cancelTask', { id, reason }, o)).task,
  })

  async function* pages(
    q?: ClientFiltersQuery & { after?: string; all?: boolean; last?: number },
    o?: CallOptions,
  ): AsyncIterable<EventsPage> {
    const normQ = normalizeFilters(q) as EventsFeedQuery
    checkOpSupport('events', normQ)
    const stopCtrl = new AbortController()
    const linked = linkSignal(o?.signal, stopCtrl.signal)
    const firstOpts = mergeOpts(linked.signal !== undefined ? { ...(o ?? {}), signal: linked.signal } : o)
    let iter: AsyncIterator<EventsPage> | null = transport.events(normQ, firstOpts)[Symbol.asyncIterator]()
    try {
      const first = await iter.next()
      if (first.done) return
      const inst = o?.expectInstance ?? transport.capabilities.instanceId
      yield first.value
      if (inst !== null && inst !== undefined && o?.expectInstance === undefined) {
        const prev = iter
        iter = null
        await prev.return?.()
        const { last: _last, ...rest } = normQ as Record<string, unknown>
        const nextQuery = { ...rest, after: first.value.cursor } as EventsFeedQuery
        const nextOpts: CallOptions = { ...(firstOpts ?? {}), expectInstance: inst }
        iter = transport.events(nextQuery, nextOpts)[Symbol.asyncIterator]()
      }
      for (;;) {
        const next = await iter.next()
        if (next.done) return
        yield next.value
      }
    } finally {
      stopCtrl.abort()
      if (iter !== null) await iter.return?.()
      linked.dispose()
    }
  }

  async function* events(
    q?: ClientFiltersQuery & { after?: string; all?: boolean; last?: number },
    o?: CallOptions,
  ): AsyncIterable<BoardEventView> {
    for await (const page of pages(q, o)) {
      for (const ev of page.events) yield ev
    }
  }

  async function runWaitLoop(
    baseFilter: Record<string, unknown>,
    deadlineMs: number,
    o: CallOptions | undefined,
  ): Promise<EventsPage> {
    let after = baseFilter['after'] as string | undefined
    let expectedInstance = o?.expectInstance
    let lastCursor = after ?? '0'
    for (;;) {
      const now = Date.now()
      const remainingS = Math.max(0, (deadlineMs - now) / 1000)
      const roundWait = Math.min(remainingS, FEED_ROUND_S, transport.capabilities.maxWaitS)
      const input: Record<string, unknown> = { ...baseFilter, wait: roundWait }
      if (after !== undefined) input['after'] = after
      else delete input['after']
      const roundOpts: CallOptions | undefined =
        expectedInstance !== undefined ? { ...(o ?? {}), expectInstance: expectedInstance } : o
      const page = await call('events', input as OpInput<'events'>, roundOpts)
      lastCursor = page.cursor
      if (expectedInstance === undefined) {
        const inst = transport.capabilities.instanceId
        if (inst !== null) expectedInstance = inst
      }
      if (page.events.length > 0) return page
      after = page.cursor
      if (Date.now() >= deadlineMs || o?.signal?.aborted || transport.closed) {
        return { events: [], cursor: lastCursor }
      }
    }
  }

  async function waitPage(
    q: ClientFiltersQuery & { timeoutS: number; after?: string },
    o?: CallOptions,
  ): Promise<EventsPage> {
    if (typeof q.timeoutS !== 'number' || !Number.isFinite(q.timeoutS) || q.timeoutS < 0) {
      throw clientError('invalid_request', 'timeoutS must be a non-negative finite number of seconds')
    }
    const { timeoutS, last: _last, ...rawFilter } = q as ClientFiltersQuery & {
      timeoutS: number
      after?: string
      last?: unknown
    }
    const baseFilter = normalizeFilters(rawFilter)
    checkOpSupport('events', baseFilter)
    const deadlineMs = Date.now() + timeoutS * 1000
    return runWaitLoop(baseFilter, deadlineMs, o)
  }

  async function wait(
    q: ClientFiltersQuery & { after?: string } = {},
    o: WaitOptions = {},
  ): Promise<BoardEventView | null> {
    const { timeout, ...callOpts } = o
    const timeoutMs = duration(timeout ?? '30m')
    const { last: _last, ...rawFilter } = q as ClientFiltersQuery & { after?: string; last?: unknown }
    const baseFilter = normalizeFilters(rawFilter)
    checkOpSupport('events', baseFilter)
    if (callOpts.signal?.aborted) return null
    const page = await runWaitLoop(baseFilter, Date.now() + timeoutMs, callOpts)
    return page.events[0] ?? null
  }

  const groups: GroupOps = Object.freeze({
    list: (q?: GroupsQueryInput, o?: CallOptions) => call('groups', q ?? {}, o),
    get: (handle: string, o?: CallOptions) => call('group', { handle }, o),
    create: (input: CreateGroupInput, o?: CallOptions) => call('createGroup', input, o),
    update: (handle: string, patch: UpdateGroupInput, o?: CallOptions) => call('updateGroup', { handle, ...patch }, o),
    delete: (handle: string, o?: CallOptions) => call('deleteGroup', { handle }, o),
    addMembers: (
      handle: string,
      membersOrInput: readonly string[] | GroupMembersInput,
      opts?: { role?: 'member' | 'lead' } & CallOptions,
      o?: CallOptions,
    ) => {
      if (Array.isArray(membersOrInput)) {
        const { rest, inlineOpts } = splitCallOptions(opts)
        return call(
          'addGroupMembers',
          { handle, members: [...membersOrInput], ...(rest.role !== undefined ? { role: rest.role } : {}) },
          mergeCallOptions(inlineOpts, o),
        )
      }
      const input = membersOrInput as GroupMembersInput
      const { inlineOpts } = splitCallOptions(opts)
      return call(
        'addGroupMembers',
        { handle, members: [...input.members], ...(input.role !== undefined ? { role: input.role } : {}) },
        mergeCallOptions(inlineOpts, o),
      )
    },
    removeMembers: (
      handle: string,
      membersOrInput: readonly string[] | GroupMembersInput,
      o?: CallOptions,
    ) => {
      const members = Array.isArray(membersOrInput) ? [...membersOrInput] : [...(membersOrInput as GroupMembersInput).members]
      return call('removeGroupMembers', { handle, members }, o)
    },
  })

  async function waitNotifications(
    q: (WaitNotificationsQueryInput & { timeout?: string | number }) = {},
    o: WaitOptions = {},
  ): Promise<NotificationsPage> {
    const { wait: waitS, timeout: qTimeout, ...baseQuery } = q
    const { timeout: oTimeout, ...callOpts } = o
    let timeoutMs: number
    if (waitS !== undefined) {
      const numeric = typeof waitS === 'string' ? Number(waitS) : waitS
      if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric < 0) {
        throw clientError('invalid_request', 'wait must be a non-negative finite number of seconds')
      }
      timeoutMs = numeric * 1000
    } else if (oTimeout !== undefined) {
      timeoutMs = duration(oTimeout)
    } else if (qTimeout !== undefined) {
      timeoutMs = duration(qTimeout)
    } else {
      timeoutMs = 20_000
    }
    checkOpSupport('waitNotifications', baseQuery)
    const deadlineMs = Date.now() + timeoutMs
    let expectedInstance = callOpts.expectInstance
    let lastPage: NotificationsPage | null = null
    for (;;) {
      const remainingS = Math.max(0, (deadlineMs - Date.now()) / 1000)
      const roundWait =
        timeoutMs === 0 || callOpts.signal?.aborted
          ? 0
          : Math.min(remainingS, FEED_ROUND_S, transport.capabilities.maxWaitS)
      const roundOpts: CallOptions | undefined =
        expectedInstance !== undefined ? { ...callOpts, expectInstance: expectedInstance } : callOpts
      const page = await call(
        'waitNotifications',
        { ...baseQuery, wait: roundWait } as OpInput<'waitNotifications'>,
        roundOpts,
      )
      lastPage = page
      if (expectedInstance === undefined) {
        const inst = transport.capabilities.instanceId
        if (inst !== null) expectedInstance = inst
      }
      if (
        page.notifications.length > 0 ||
        timeoutMs === 0 ||
        Date.now() >= deadlineMs ||
        callOpts.signal?.aborted ||
        transport.closed
      ) {
        return lastPage
      }
    }
  }

  const notifications: NotificationOps = Object.freeze({
    list: (q?: NotificationsQueryInput, o?: CallOptions) => call('notifications', q ?? {}, o),
    count: (q?: NotificationsQueryInput, o?: CallOptions) => call('notificationCount', q ?? {}, o),
    ack: (id: string | number, opts?: AckNotificationInput & CallOptions, o?: CallOptions) => {
      const { rest, inlineOpts } = splitCallOptions(opts)
      return call(
        'ackNotification',
        { id: String(id), ...(rest.readOnly !== undefined ? { readOnly: rest.readOnly } : {}) },
        mergeCallOptions(inlineOpts, o),
      )
    },
    ackAll: (input?: AckAllNotificationsInput, o?: CallOptions) => call('ackAllNotifications', input ?? {}, o),
    wait: waitNotifications,
  })

  const pins: PinOps = Object.freeze({
    pin: (id: string | number, opts?: PinInput & CallOptions, o?: CallOptions) => {
      const { rest, inlineOpts } = splitCallOptions(opts)
      return call('pinMessage', { id, ...rest } as OpInput<'pinMessage'>, mergeCallOptions(inlineOpts, o))
    },
    unpin: (id: string | number, opts?: UnpinInput & CallOptions, o?: CallOptions) => {
      const { rest, inlineOpts } = splitCallOptions(opts)
      return call('unpinMessage', { id, ...rest } as OpInput<'unpinMessage'>, mergeCallOptions(inlineOpts, o))
    },
    list: (q?: PinsQueryInput, o?: CallOptions) => call('pins', q ?? {}, o),
  })

  const presence: PresenceOps = Object.freeze({
    set: (input?: SetPresenceInput, o?: CallOptions) => call('setPresence', input ?? {}, o),
    list: (q?: PresenceQueryInput, o?: CallOptions) => call('presence', q ?? {}, o),
  })

  async function dm(peer: string, input: string | (DmPostOptions & CallOptions), o?: CallOptions): Promise<DmPostResult>
  async function dm(peer: string, opts?: DmReadOptions & CallOptions, o?: CallOptions): Promise<DmReadResult>
  async function dm(
    peer: string,
    opts?: string | (Partial<DmPostOptions> & DmReadOptions & CallOptions),
    o?: CallOptions,
  ): Promise<DmPostResult | DmReadResult> {
    if (typeof opts === 'string') {
      const ensureOpts = o?.idempotencyKey !== undefined ? { ...o, idempotencyKey: undefined } : o
      const ensured = await call('ensureDm', { peer }, ensureOpts)
      const { message, mentions } = await call('post', { channel: ensured.channel.path, text: opts }, o)
      return {
        channel: ensured.channel,
        created: ensured.created,
        peer: ensured.peer,
        message: mentions ? { ...message, mentions } : message,
      }
    }
    const { rest, inlineOpts } = splitCallOptions(opts)
    const mergedOpts = mergeCallOptions(inlineOpts, o)
    const { topic, limit, after, ...postFields } = rest
    const ensureOpts =
      mergedOpts?.idempotencyKey !== undefined ? { ...mergedOpts, idempotencyKey: undefined } : mergedOpts
    const ensured = await call(
      'ensureDm',
      { peer, ...(topic !== undefined ? { topic } : {}) },
      ensureOpts,
    )
    if (postFields.text !== undefined) {
      const { message, mentions } = await call(
        'post',
        { channel: ensured.channel.path, ...messageBody(postFields as PostOptions) } as OpInput<'post'>,
        mergedOpts,
      )
      return {
        channel: ensured.channel,
        created: ensured.created,
        peer: ensured.peer,
        message: mentions ? { ...message, mentions } : message,
      }
    }
    const page = await call(
      'channelMessages',
      {
        channel: ensured.channel.path,
        ...(limit !== undefined ? { limit } : {}),
        ...(after !== undefined ? { after } : {}),
      },
      mergedOpts,
    )
    return {
      channel: ensured.channel,
      created: ensured.created,
      peer: ensured.peer,
      messages: page.messages,
      cursor: page.cursor,
    }
  }

  async function flag(
    id: string | number,
    reason: string,
    opts?: FlagOptions & CallOptions,
    o?: CallOptions,
  ): Promise<FlagResult> {
    const cleanReason = sanitizeLabelValue(reason)
    if (cleanReason.length === 0) {
      throw clientError('invalid_request', 'flag reason must not be empty')
    }
    const { rest, inlineOpts } = splitCallOptions(opts)
    const mergedOpts = mergeCallOptions(inlineOpts, o)
    const secondaryOpts: CallOptions | undefined = mergedOpts
      ? {
          ...(mergedOpts.signal !== undefined ? { signal: mergedOpts.signal } : {}),
          ...(mergedOpts.as !== undefined ? { as: mergedOpts.as } : {}),
          ...(mergedOpts.expectInstance !== undefined ? { expectInstance: mergedOpts.expectInstance } : {}),
        }
      : undefined
    const self = await call('me', {}, secondaryOpts)
    const status = rest.resolve === true ? 'resolved' : 'open'
    const message = await call(
      'label',
      {
        id,
        set: {
          'flag.status': status,
          'flag.reason': cleanReason,
          'flag.by': sanitizeLabelValue(self.actor),
        },
      },
      mergedOpts,
    )
    if (rest.feedback === true || rest.crossPostFeedback === true) {
      const { message: fbMsg, mentions } = await call(
        'post',
        {
          channel: 'meta/feedback',
          text: `Flagged message #${message.id} in #${message.channel} (${status}): ${cleanReason}`,
          labels: {
            kind: 'other',
            severity: 'med',
            status: 'new',
            'flag.target': message.id,
          },
        },
        secondaryOpts,
      )
      return {
        ok: true,
        message,
        feedback: mentions ? { ...fbMsg, mentions } : fbMsg,
      }
    }
    return { ok: true, message }
  }

  async function feedback(input: FeedbackInput, o?: CallOptions): Promise<Written<MessageView>> {
    const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
    if (summary.length === 0) {
      throw clientError('invalid_request', 'feedback summary must not be empty')
    }
    const { channel: targetChannel, ...rawPayload } = input
    const payload: Record<string, unknown> = { summary }
    for (const [k, v] of Object.entries(rawPayload)) {
      if (k === 'summary' || v === undefined) continue
      payload[k] = v
    }
    const channel = targetChannel ?? 'meta/feedback'
    const labels: Record<string, string> = { status: 'new' }
    if (typeof input.kind === 'string') {
      const v = sanitizeLabelValue(input.kind)
      if (v.length > 0) labels['kind'] = v
    }
    if (typeof input.severity === 'string') {
      const v = sanitizeLabelValue(input.severity)
      if (v.length > 0) labels['severity'] = v
    }
    if (typeof input.harness === 'string') {
      const v = sanitizeLabelValue(input.harness)
      if (v.length > 0) labels['harness'] = v
    }
    const json = JSON.stringify(payload, null, 2)
    const fence = safeJsonFence(json)
    const structuredText = `${summary}\n\n${fence}json#board-feedback@1\n${json}\n${fence}`
    try {
      const { message, mentions } = await call('post', { channel, text: structuredText, labels }, o)
      return mentions ? { ...message, mentions } : message
    } catch (error) {
      if (!isBoardError(error) || error.code !== 'schema_not_found') throw error
      const fallbackText = `${summary}\n\n${fence}json\n${json}\n${fence}`
      const { message, mentions } = await call('post', { channel, text: fallbackText, labels }, o)
      return mentions ? { ...message, mentions } : message
    }
  }

  async function sync(id: string | number, o?: CallOptions): Promise<SyncedView>
  async function sync(
    id: string | number,
    target: string,
    o?: CallOptions,
  ): Promise<{ target: string; attached: boolean }>
  async function sync(
    id: string | number,
    targetOrOpts?: string | CallOptions,
    o?: CallOptions,
  ): Promise<SyncedView | { target: string; attached: boolean }> {
    if (typeof targetOrOpts === 'string') {
      const { attached } = await call('sync', { id, target: targetOrOpts }, o)
      return { target: targetOrOpts, attached }
    }
    return call('synced', { id }, targetOrOpts)
  }

  const client: BoardClient = {
    get caps(): Capabilities {
      return transport.capabilities
    },
    selection: init.selection,
    profile: defaultProfile,
    resolution,
    warnings,
    raw: transport,
    as(profile: string | null): BoardClient {
      checkProfile(profile)
      return createBoardClient(transport, {
        selection: init.selection,
        profile,
        resolution,
        warnings,
        opsOverride: init.opsOverride,
      })
    },
    call,
    me: (o?: CallOptions) => call('me', {}, o),
    channels: async (q?: ChannelsQueryInput, o?: CallOptions) => {
      const page = await call('channels', q ?? {}, o)
      return { ...page, next: page.next ?? null }
    },
    channelTree: (q?: ChannelTreeQueryInput, o?: CallOptions) => call('channelTree', q ?? {}, o),
    createChannel: (path: string, opts?: CreateChannelMetaOpts & CallOptions) => {
      const { rest, inlineOpts } = splitCallOptions(opts)
      const body: Record<string, unknown> = { path }
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) body[k] = v
      }
      return call('createChannel', body as OpInput<'createChannel'>, inlineOpts)
    },
    updateChannel: (path: string, patch: Omit<UpdateChannelInput, 'path'>, o?: CallOptions) =>
      call('updateChannel', { path, ...patch } as OpInput<'updateChannel'>, o),
    dm,
    groups,
    notifications,
    markChannelRead: (channel: string, cursor?: string, o?: CallOptions) =>
      call('markChannelRead', { channel, ...(cursor !== undefined ? { cursor } : {}) }, o),
    agentInbox: (q?: AgentInboxQueryInput, o?: CallOptions) => call('agentInbox', q ?? {}, o),
    pins,
    presence,
    flag,
    feedback,
    actors: (q?: ActorsQueryInput, o?: CallOptions) => call('actors', q ?? {}, o),
    channel: (name: string) => ({
      messages: (q?: Omit<ChannelMessagesQueryInput, 'channel'>, o?: CallOptions) =>
        call('channelMessages', { channel: name, ...(q ?? {}) }, o),
    }),
    thread: (id: string | number, q?: ThreadQueryInput, o?: CallOptions) =>
      call('message', { id, ...(q ?? {}) }, o),
    posted: async (id: string, o?: CallOptions) => (await call('posted', { id }, o)).message,
    threads: (
      q?: Omit<ThreadsQueryInput, 'label'> & { label?: Record<string, string> | string | string[] },
      o?: CallOptions,
    ) => call('threads', normalizeFilters(q) as OpInput<'threads'>, o),
    post: async (channel: string, input: string | PostOptions, o?: CallOptions) => {
      const { message, mentions } = await call(
        'post',
        { channel, ...messageBody(input) } as OpInput<'post'>,
        o,
      )
      return mentions ? { ...message, mentions } : message
    },
    reply: async (id: string | number, input: string | ReplyOptions, o?: CallOptions) => {
      const { message, mentions } = await call(
        'post',
        { re: id, ...messageBody(input) } as OpInput<'post'>,
        o,
      )
      return mentions ? { ...message, mentions } : message
    },
    edit: async (id: string | number, text: string, opts?: { revision?: number } & CallOptions) => {
      const { revision, ...callOpts } = opts ?? {}
      const res = await call('edit', { id, text, ...(revision !== undefined ? { revision } : {}) }, callOpts)
      const { mentions, ...message } = res
      return { ok: true, message, ...(mentions !== undefined ? { mentions } : {}) }
    },
    delete: async (id: string | number, opts?: { revision?: number } & CallOptions) => {
      const { revision, ...callOpts } = opts ?? {}
      const message = await call('delete', { id, ...(revision !== undefined ? { revision } : {}) }, callOpts)
      return { ok: true, message }
    },
    react: async (id: string | number, emoji: string, opts?: { remove?: boolean } & CallOptions) => {
      const { remove, ...callOpts } = opts ?? {}
      const message = await call('react', { id, emoji, ...(remove !== undefined ? { remove } : {}) }, callOpts)
      return { ok: true, message }
    },
    label: async (id: string | number, change: LabelChange, o?: CallOptions) => {
      const message = await call('label', { id, ...change }, o)
      return { ok: true, message }
    },
    schedule: async (target: string | { re: string | number }, input: ScheduleOptions, o?: CallOptions) => {
      const where = typeof target === 'string' ? { channel: target } : { re: target.re }
      return call('schedule', { ...where, ...scheduleBody(input) } as OpInput<'schedule'>, o)
    },
    schedules: (q?: SchedulesQueryInput, o?: CallOptions) => call('schedules', q ?? {}, o),
    cancelSchedule: (id: string, o?: CallOptions) => call('cancelSchedule', { id }, o),
    tasks,
    grants: (o?: CallOptions) => call('grants', {}, o),
    createGrant: async (input: GrantInput, o?: GrantWriteOptions & CallOptions) => {
      const { lockMeOut, ...callOpts } = o ?? {}
      const grant = await call(
        'createGrant',
        { ...wireGrant(input), ...(lockMeOut ? { lockMeOut: true } : {}) } as OpInput<'createGrant'>,
        callOpts,
      )
      return { grant }
    },
    createGrants: async (inputs: readonly GrantInput[], o?: GrantWriteOptions & CallOptions) => {
      const { lockMeOut, ...callOpts } = o ?? {}
      const grants = await call(
        'createGrants',
        { grants: inputs.map(wireGrant), ...(lockMeOut ? { lockMeOut: true } : {}) } as OpInput<'createGrants'>,
        callOpts,
      )
      return { grants }
    },
    updateGrant: async (id: string, change: UpdateGrantInput, o?: GrantWriteOptions & CallOptions) => {
      const { lockMeOut, ...callOpts } = o ?? {}
      const { add, remove, can } = change
      const grant = await call(
        'updateGrant',
        {
          id,
          ...(add !== undefined ? { add: add.map(withEnvironments) } : {}),
          ...(remove !== undefined ? { remove } : {}),
          ...(can !== undefined ? { can: wireCan(can) } : {}),
          ...(lockMeOut ? { lockMeOut: true } : {}),
        } as OpInput<'updateGrant'>,
        callOpts,
      )
      return { grant }
    },
    explain: (channel: string, principal?: ExplainPrincipal, o?: CallOptions) => {
      const { claims, ...rest } = principal ?? {}
      const claimList = claims ? Object.entries(claims).map(([k, v]) => `${k}=${v}`) : undefined
      return call(
        'explain',
        { channel, ...rest, ...(claimList && claimList.length > 0 ? { claim: claimList } : {}) },
        o,
      )
    },
    revokeGrant: (id: string, o?: GrantWriteOptions & CallOptions) => {
      const { lockMeOut, ...callOpts } = o ?? {}
      return call('revokeGrant', { id, ...(lockMeOut ? { lockMeOut: true } : {}) }, callOpts)
    },
    schemas: (o?: CallOptions) => call('schemas', {}, o),
    schema: (id: string, o?: CallOptions) => call('schema', { id }, o),
    createSchema: async (input: SchemaInput, o?: CallOptions) => {
      const { created, ...schema } = await call('createSchema', input, o)
      return { schema, created }
    },
    upload: (input: { data: Uint8Array; name: string; type?: string }, o?: CallOptions) =>
      call('upload', { name: input.name, type: input.type ?? null, data: input.data }, o),
    attachment: (id: string, o?: CallOptions) => call('attachment', { id }, o),
    sync,
    inbox: (key: string, opts?: { channel?: string; limit?: number } & CallOptions, o?: CallOptions) => {
      const { channel, limit, ...inlineOpts } = opts ?? {}
      return call(
        'inbox',
        {
          key,
          ...(channel !== undefined ? { channel } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        mergeCallOptions(inlineOpts, o),
      )
    },
    inboxPush: async (
      key: string,
      eventsInput: { id: string; event: InboxItem['event']; raw: unknown }[],
      o?: CallOptions,
    ) => {
      const { accepted } = await call('inboxPush', { key, events: eventsInput }, o)
      return { ok: true, accepted }
    },
    inboxNext: (key: string, opts?: { limit?: number } & CallOptions, o?: CallOptions) => {
      const { limit, ...inlineOpts } = opts ?? {}
      return call(
        'inboxNext',
        { key, ...(limit !== undefined ? { limit } : {}) },
        mergeCallOptions(inlineOpts, o),
      )
    },
    inboxAck: (key: string, id: string, body: { lease: string; error?: string }, o?: CallOptions) =>
      call('inboxAck', { key, id, ...body }, o),
    syncImport: (body: SyncImportInput, o?: CallOptions) => call('syncImport', body, o),
    syncReceipt: (body: SyncReceiptInput, o?: CallOptions) => call('syncReceipt', body, o),
    syncThread: (thread: string, o?: CallOptions) => call('syncThread', { thread }, o),
    syncFind: (query: SyncFindInput, o?: CallOptions) => call('syncFind', query, o),
    syncCopies: async (messages: string[], o?: CallOptions) =>
      (await call('syncCopies', { message: messages }, o)).copies,
    register: (input: RegisterInput, o?: CallOptions) => call('register', input, o),
    watchers: (o?: CallOptions) => call('watchers', {}, o),
    matches: (opts?: { limit?: number; wait?: number } & CallOptions, o?: CallOptions) => {
      const { limit, wait: w, ...inlineOpts } = opts ?? {}
      return call(
        'matches',
        { ...(limit !== undefined ? { limit } : {}), ...(w !== undefined ? { wait: w } : {}) },
        mergeCallOptions(inlineOpts, o),
      )
    },
    ack: (id: string, body: { lease: string; error?: string; skip?: boolean }, o?: CallOptions) =>
      call('ack', { id, ...body }, o),
    search: (q: FtsSearchQuery | OpInput<'search'>, o?: CallOptions) => call('search', q as OpInput<'search'>, o),
    poll: (
      q?: ClientFiltersQuery & { after?: string; wait?: number; all?: boolean; last?: number },
      o?: CallOptions,
    ) => call('events', normalizeFilters(q) as OpInput<'events'>, o),
    pages,
    events,
    wait,
    waitPage,
    close: () => transport.close(),
  }

  return Object.freeze(client)
}
