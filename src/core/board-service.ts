import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  badRequest,
  BoardError,
  conflict,
  duplicateId,
  forbidden,
  normalizeError,
  notFound,
  textTooLong,
  tooLarge,
  unauthorized,
} from './errors.ts'
import {
  AckAllNotificationsBodySchema,
  AckBodySchema,
  AckNotificationBodySchema,
  ActorsQuerySchema,
  AgentInboxQuerySchema,
  ATTACHMENT_BYTES_MAX,
  ATTACHMENTS_PER_MESSAGE_MAX,
  CAN_MAX,
  CHANNEL_PATH_MAX,
  ChannelMessagesQuerySchema,
  ChannelPath,
  ChannelsQuerySchema,
  ChannelTreeQuerySchema,
  CHANNELS_LIMIT_DEFAULT,
  CreateChannelBodySchema,
  CreateGrantsBodySchema,
  CreateGroupBodySchema,
  DeleteBodySchema,
  DIRECT_UPLOAD_BYTES_MAX,
  EditBodySchema,
  EnsureDmBodySchema,
  EventsQuerySchema,
  EVENTS_LAST_MAX,
  EVENTS_LAST_PAGES,
  EVENTS_PAGE,
  ExplainQuerySchema,
  FiltersSchema,
  GrantBodySchema,
  GroupMembersBodySchema,
  GroupsQuerySchema,
  IMPORT_BYTES_MAX,
  InboxAckBodySchema,
  InboxNextQuerySchema,
  InboxPushBodySchema,
  LabelBodySchema,
  MarkChannelReadBodySchema,
  MatchesQuerySchema,
  MESSAGE_TEXT_MAX,
  NotificationsQuerySchema,
  PinBodySchema,
  PinsQuerySchema,
  PostBodySchema,
  PresenceQuerySchema,
  ReactBodySchema,
  RegisterBodySchema,
  REGISTERED_WATCHERS_MAX,
  RemoteWatcherId,
  RESERVED_LABEL_PREFIX,
  RevokeGrantBodySchema,
  ScheduleBodySchema,
  SchedulesQuerySchema,
  SchemaBodySchema,
  SearchQuerySchema,
  SCHEMAS_MAX,
  SetPresenceBodySchema,
  SyncBodySchema,
  SyncCopiesQuerySchema,
  SyncFindQuerySchema,
  SyncImportBodySchema,
  SyncReceiptBodySchema,
  ThreadQuerySchema,
  ThreadsQuerySchema,
  THREADS_LIMIT_DEFAULT,
  CHANNEL_MESSAGES_LIMIT_DEFAULT,
  toStorable,
  UnpinBodySchema,
  UpdateChannelBodySchema,
  UpdateGrantBodySchema,
  UpdateGroupBodySchema,
  UploadStartBodySchema,
  WaitNotificationsQuerySchema,
  PERMISSIONS,
  type ActorKind,
  type ActorView,
  type AgentInboxView,
  type Assurance,
  type Attachment,
  type Author,
  type BlockView,
  type BoardEventView,
  type ChannelKind,
  type ChannelTreePage,
  type ChannelView,
  type ChannelsPage,
  type CompactTaskDigest,
  type EventsPage,
  type Explanation,
  type ExternalCopy,
  type ExternalEvent,
  type GrantView,
  type GroupMemberView,
  type GroupView,
  type InboxEntry,
  type InboxItem,
  type Labels,
  type LinkSnapshot,
  type LinkView,
  type MatchView,
  type MessagesPage,
  type MessageView,
  type NotificationPriority,
  type NotificationReason,
  type NotificationsPage,
  type NotificationView,
  type Origin,
  type ParsedFilters,
  type Permission,
  type PinScope,
  type PinView,
  type PresenceStatus,
  type PresenceView,
  type PrincipalInput,
  type PrincipalView,
  type QuoteView,
  type RegistrationView,
  type ScheduleView,
  type SchemaView,
  type SyncCopiesView,
  type SyncedView,
  type SyncFindView,
  type SyncThreadView,
  type TaskState,
  type TaskView,
  type ThreadPinBadge,
  type ThreadsPage,
  type ThreadSummaryView,
  type ThreadView,
  type UploadTicket,
  type Via,
} from './schemas.ts'
import { canonicalEmoji } from './emoji.ts'
import {
  GROUP_FANOUT_MAX,
  NOTIFICATIONS_PER_MESSAGE_MAX,
  RESERVED_GROUP_HANDLES,
  buildChannelTree,
  canonicalDmChannel,
  dmSlug,
  excerptOf,
  inferChannelKind,
  parseDmPeers,
  recipientAliases,
  recipientKeysOf,
  requireHumanVerified,
  resolveActorRow,
  resolveMessageId,
  resolveRecipient,
} from './social.ts'
import type { FtsSearchHit, FtsSearchQuery, SchemaInfo, StorageBackend, StoredEvent } from './storage.ts'
import { identityOf, type PostedRoot, type TaskHost, type TaskRootInput, type TaskRootOption } from './tasks/host.ts'
import { RESERVED_SYSTEM_IDS, SCHEDULE_ACTOR_ID, systemAuthor } from './system.ts'
import { TaskService, type TaskServiceOptions } from './tasks/task-service.ts'

export {
  GROUP_FANOUT_MAX,
  NOTIFICATIONS_PER_MESSAGE_MAX,
  RESERVED_GROUP_HANDLES,
  canonicalDmChannel,
  dmSlug,
  excerptOf,
  inferChannelKind,
  recipientKeysOf,
  requireHumanVerified,
  resolveMessageId,
} from './social.ts'

// ============================================================================
// Caller Identity & Access Control (F5)
// ============================================================================

export type CallerPrincipal = {
  id: string
  kind: 'user' | 'project' | 'github' | 'oidc' | 'app' | 'deployment' | 'external'
  handle: string
  member?: boolean
  teamProject?: boolean
  teamApp?: boolean
  userId?: string
  projectId?: string
  environment?: string
  teamId?: string
  repository?: string
  repositoryId?: string
  workflowRef?: string
  ref?: string
  event?: string
  issuer?: string
  claims?: Readonly<Record<string, unknown>>
  clientId?: string
  cap?: readonly Permission[]
  owner?: boolean
  /** C10 identity assurance level (HOST-0b / HOST-4 / HOST-8). */
  assurance?: Assurance
  /** When the token it signed in with stops working, as ISO 8601; none for a token that doesn't. */
  expiresAt?: string | null
}

/** Who the caller is on this board and what it may do (original api/routes.ts:1068-1081 Me). */
export type MeView = {
  actor: string
  principal: string
  kind: ActorKind
  handle: string
  name: string
  avatar: string | null
  profile: string | null
  via?: Via
  assurance?: Assurance
  expiresAt: string | null
  /** What it may do in each channel pattern, implications included. */
  can: AccessSummary
}

export type CallerActor = {
  id: string
  kind: ActorKind
  handle: string
  name: string
  avatar: string | null
  via?: Via
  platform?: string
  verified?: true
}

export type CallerContext = {
  principal: CallerPrincipal
  actor: CallerActor
  profile: string | null
  canHeader?: string
}

/**
 * Refuses a caller whose actor isn't its principal's: the principal itself with no profile, or
 * `<principal>+<profile>` for its profile. Whatever builds a CallerContext (the server's verifier)
 * should never make another, but the board doesn't take it on trust: a post under another actor's
 * ID would rewrite that actor's record, and every message of theirs with it. Only the board's own
 * deployment writes as others, the platform users its sync imports (original a2.ts:170-191).
 */
export function checkCallerActor(caller: CallerContext): void {
  // The board's own ids (C6): no request acts as the system or the schedule canceler, whatever its kind.
  if (RESERVED_SYSTEM_IDS.has(caller.principal.id) || RESERVED_SYSTEM_IDS.has(caller.actor.id)) {
    throw forbidden(`${caller.actor.id} is the board's own: no request acts as it`)
  }
  // C10: an agent_delegated credential can never act as a person, board owner, deployment, or profile-less principal.
  if (caller.principal.assurance === 'agent_delegated') {
    if (
      caller.actor.kind === 'person' ||
      caller.principal.owner === true ||
      caller.principal.kind === 'deployment' ||
      caller.profile === null
    ) {
      throw forbidden(
        'an agent credential cannot act as a person, board owner, or deployment',
        'agent_cannot_impersonate_human',
      )
    }
  }
  if (caller.principal.kind === 'deployment') return
  const expected = caller.profile === null ? caller.principal.id : `${caller.principal.id}+${caller.profile}`
  if (caller.actor.id !== expected) {
    throw forbidden(`this token is ${caller.principal.id}, so it can't act as ${caller.actor.id}: only as itself or a profile of its own`)
  }
}

export function createLocalCaller(options: {
  userId?: string
  handle?: string
  name?: string
  profile?: string | null
  owner?: boolean
  member?: boolean
  canHeader?: string
  cap?: readonly Permission[]
  assurance?: Assurance
  verified?: boolean
} = {}): CallerContext {
  const userId = options.userId ?? 'local'
  const handle = options.handle ?? 'local'
  const name = options.name ?? handle
  const profile = options.profile ?? null
  const principalId = `local:user:${userId}`
  const actorId = profile ? `${principalId}+${profile}` : principalId
  return {
    principal: {
      id: principalId,
      kind: 'user',
      handle,
      userId,
      member: options.member ?? true,
      owner: options.owner ?? false,
      ...(options.cap ? { cap: options.cap } : {}),
      ...(options.assurance !== undefined ? { assurance: options.assurance } : {}),
    },
    actor: {
      id: actorId,
      kind: profile ? 'agent' : 'person',
      handle: profile ? `${handle}/${profile}` : handle,
      name: profile ?? name,
      avatar: null,
      ...(profile ? { via: { name, environment: null } } : {}),
      ...(options.verified !== false ? { verified: true as const } : {}),
    },
    profile,
    ...(options.canHeader !== undefined ? { canHeader: options.canHeader } : {}),
  }
}

export const IMPLIES: Readonly<Record<Permission, readonly Permission[]>> = {
  read: [],
  post: [],
  react: ['read'],
  label: ['read'],
  sync: ['read'],
  manage: ['read', 'post', 'react', 'label', 'sync'],
}

export type ChannelPattern = string
export type GrantCanSpec = 'all' | readonly Permission[]
export type CanSpec = GrantCanSpec | Readonly<Record<ChannelPattern, GrantCanSpec>>
export type WrittenCan = Readonly<Record<ChannelPattern, 'all' | readonly Permission[]>>
export type AccessSummary = Readonly<Record<ChannelPattern, readonly Permission[]>>

type ParsedPattern =
  | { kind: 'all' }
  | { kind: 'exact'; path: string }
  | { kind: 'subtree'; path: string }

const PERM_ORDER = new Map<Permission, number>(PERMISSIONS.map((p, i) => [p, i]))
const PATTERN_SHAPE = 'write *, a channel, or a channel and its subtree (feedback/)'

export function parsePattern(pattern: string): ParsedPattern {
  if (pattern === '*') return { kind: 'all' }
  if (pattern.includes('*')) {
    const before = pattern.slice(0, pattern.indexOf('*')).replace(/\/+$/, '')
    const hint =
      before === ''
        ? 'write * for every channel'
        : ChannelPath.safeParse(before).success
          ? `write ${before}/ for ${before} and its subtree`
          : PATTERN_SHAPE
    throw badRequest(`invalid channel pattern ${pattern}: ${hint}`, 'invalid_can')
  }
  const subtree = pattern.endsWith('/')
  const path = subtree ? pattern.slice(0, -1) : pattern
  if (!ChannelPath.safeParse(path).success) {
    throw badRequest(`invalid channel pattern ${pattern || '(empty)'}: ${PATTERN_SHAPE}`, 'invalid_can')
  }
  return subtree ? { kind: 'subtree', path } : { kind: 'exact', path }
}

const patternKey = (pattern: ParsedPattern): string =>
  pattern.kind === 'all' ? '*' : pattern.kind === 'subtree' ? `${pattern.path}/` : pattern.path

export function expandPermissions(grant: GrantCanSpec): ReadonlySet<Permission> {
  const out = new Set<Permission>()
  const add = (permission: Permission): void => {
    if (!PERM_ORDER.has(permission)) {
      throw badRequest(
        `unknown permission ${String(permission)}: use ${PERMISSIONS.join(', ')}`,
        'invalid_can',
      )
    }
    if (out.has(permission)) return
    out.add(permission)
    for (const implied of IMPLIES[permission]) add(implied)
  }
  for (const permission of grant === 'all' ? PERMISSIONS : grant) add(permission)
  return out
}

const NOTHING: ReadonlySet<Permission> = new Set()

type Rules = {
  all: ReadonlySet<Permission> | null
  exact: ReadonlyMap<string, ReadonlySet<Permission>>
  subtrees: readonly (readonly [string, ReadonlySet<Permission>])[]
}

type RuleEntry = readonly [ParsedPattern, ReadonlySet<Permission>]

function compileRules(entries: Iterable<RuleEntry>): Rules {
  let all: ReadonlySet<Permission> | null = null
  const exact = new Map<string, ReadonlySet<Permission>>()
  const subtrees: [string, ReadonlySet<Permission>][] = []
  for (const [pattern, permissions] of entries) {
    if (pattern.kind === 'all') all = permissions
    else if (pattern.kind === 'exact') exact.set(pattern.path, permissions)
    else subtrees.push([pattern.path, permissions])
  }
  subtrees.sort((a, b) => b[0].length - a[0].length)
  return { all, exact, subtrees }
}

const isUnderPath = (channel: string, path: string): boolean =>
  channel === path || channel.startsWith(`${path}/`)

function resolveRule(rules: Rules, channel: string, subtreeOnly = false): ReadonlySet<Permission> {
  if (!subtreeOnly) {
    const exact = rules.exact.get(channel)
    if (exact) return exact
  }
  for (const [path, permissions] of rules.subtrees) {
    if (isUnderPath(channel, path)) return permissions
  }
  return rules.all ?? NOTHING
}

const resolveAtPattern = (rules: Rules, pattern: ParsedPattern): ReadonlySet<Permission> =>
  pattern.kind === 'all'
    ? (rules.all ?? NOTHING)
    : resolveRule(rules, pattern.path, pattern.kind === 'subtree')

const equalSets = (a: ReadonlySet<Permission>, b: ReadonlySet<Permission>): boolean =>
  a.size === b.size && [...a].every((p) => b.has(p))

function parentRule(rules: Rules, pattern: ParsedPattern): ReadonlySet<Permission> {
  if (pattern.kind === 'exact') return resolveRule(rules, pattern.path, true)
  if (pattern.kind === 'subtree') {
    for (const [path, permissions] of rules.subtrees) {
      if (path !== pattern.path && isUnderPath(pattern.path, path)) return permissions
    }
  }
  return rules.all ?? NOTHING
}

function canonicalRules(entries: RuleEntry[]): Rules {
  const rules = compileRules(entries)
  return compileRules(
    entries.filter(([pattern, permissions]) =>
      pattern.kind === 'all'
        ? permissions.size > 0
        : !equalSets(permissions, parentRule(rules, pattern)),
    ),
  )
}

function entriesOfCan(can: CanSpec): RuleEntry[] {
  if (can === 'all' || Array.isArray(can)) {
    return [[{ kind: 'all' }, expandPermissions(can as GrantCanSpec)]]
  }
  return Object.entries(can as Record<string, GrantCanSpec>).map(
    ([pattern, grant]) => [parsePattern(pattern), expandPermissions(grant)] as const,
  )
}

const entriesInRules = (rules: Rules): RuleEntry[] => [
  ...(rules.all ? [[{ kind: 'all' }, rules.all] as const] : []),
  ...rules.subtrees.map(([path, permissions]) => [{ kind: 'subtree', path }, permissions] as const),
  ...[...rules.exact].map(([path, permissions]) => [{ kind: 'exact', path }, permissions] as const),
]

export type Access = {
  can(permission: Permission, channel: string): boolean
  readable(channel: string): boolean
  readonly readsAll: boolean
  everywhere(permission: Permission): boolean
  anywhere(permission: Permission): boolean
  at(permission: Permission, pattern: ChannelPattern): boolean
  narrow(scope: CanSpec | Access): Access
  summary(): AccessSummary
}

const RULES_SYM = Symbol('swarmboard.access')
const READABLE_CACHE_MAX = 4096
type CompiledAccess = Access & { readonly [RULES_SYM]: Rules }
const isCompiledAccess = (value: CanSpec | Access): value is CompiledAccess =>
  typeof value === 'object' && value !== null && RULES_SYM in value

function accessFromRules(rules: Rules): Access {
  const entries = entriesInRules(rules)
  const everywhere = (permission: Permission): boolean =>
    (rules.all?.has(permission) ?? false) && entries.every(([, p]) => p.has(permission))
  const uniform =
    rules.exact.size === 0 && rules.subtrees.length === 0 ? (rules.all?.has('read') ?? false) : null
  const readableCache = new Map<string, boolean>()

  const compiled: CompiledAccess = {
    [RULES_SYM]: rules,
    can: (permission, channel) => resolveRule(rules, channel).has(permission),
    readable(channel) {
      if (uniform !== null) return uniform
      let hit = readableCache.get(channel)
      if (hit === undefined) {
        if (readableCache.size >= READABLE_CACHE_MAX) readableCache.clear()
        hit = resolveRule(rules, channel).has('read')
        readableCache.set(channel, hit)
      }
      return hit
    },
    readsAll: everywhere('read'),
    everywhere,
    anywhere: (permission) => entries.some(([, p]) => p.has(permission)),
    at: (permission, pattern) => resolveAtPattern(rules, parsePattern(pattern)).has(permission),
    narrow(scope) {
      const other = isCompiledAccess(scope)
        ? scope[RULES_SYM]
        : canonicalRules(entriesOfCan(scope as CanSpec))
      const patterns = new Map<string, ParsedPattern>([['*', { kind: 'all' }]])
      for (const [pattern] of [...entries, ...entriesInRules(other)]) {
        patterns.set(patternKey(pattern), pattern)
      }
      return accessFromRules(
        canonicalRules(
          [...patterns.values()].map((pattern) => {
            const theirs = resolveAtPattern(other, pattern)
            return [
              pattern,
              new Set([...resolveAtPattern(rules, pattern)].filter((p) => theirs.has(p))),
            ] as const
          }),
        ),
      )
    },
    summary() {
      const named = entries.map(([pattern, permissions]) => [patternKey(pattern), permissions] as const)
      named.sort(([a], [b]) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b)))
      const out: Record<ChannelPattern, Permission[]> = {}
      for (const [name, permissions] of named) {
        out[name] = [...permissions].sort((a, b) => PERM_ORDER.get(a)! - PERM_ORDER.get(b)!)
      }
      return out
    },
  }
  return Object.freeze(compiled)
}

export function compileAccess(can: CanSpec): Access {
  return accessFromRules(canonicalRules(entriesOfCan(can)))
}

export const FULL_ACCESS = compileAccess('all')
export const NO_ACCESS = compileAccess([])

export function parseCan(header: string, name = 'x-board-can'): CanSpec {
  if (header.length > CAN_MAX) {
    throw badRequest(`${name} is longer than ${CAN_MAX} characters`, 'invalid_can')
  }
  const out: Record<ChannelPattern, GrantCanSpec> = {}
  const entries = header.split(';').map((entry) => entry.trim())
  if (entries.every((entry) => entry === '')) {
    throw badRequest(`${name} is empty: write pattern=permissions, like dev/=read,post`, 'invalid_can')
  }
  for (const entry of entries) {
    if (entry === '') continue
    const split = entry.indexOf('=')
    if (split < 0) {
      throw badRequest(
        `${name} entry ${entry} needs =: write pattern=permissions, like dev/=read,post`,
        'invalid_can',
      )
    }
    const pattern = entry.slice(0, split).trim()
    const list = entry.slice(split + 1).trim()
    if (Object.hasOwn(out, pattern)) {
      throw badRequest(`${name} lists ${pattern} twice`, 'invalid_can')
    }
    parsePattern(pattern)
    const permissions = list === '' ? [] : list.split(',').map((p) => p.trim())
    if (permissions.length === 1 && permissions[0] === 'all') {
      out[pattern] = 'all'
      continue
    }
    for (const permission of permissions) {
      if (!PERM_ORDER.has(permission as Permission)) {
        throw badRequest(
          `${name}: unknown permission ${permission || '(empty)'}: use ${PERMISSIONS.join(', ')}, or all`,
          'invalid_can',
        )
      }
    }
    out[pattern] = permissions as Permission[]
  }
  return out
}

/**
 * A caller's `x-board-can`, read as the board reads the header: one it can't read is a 400
 * `invalid_scope` (original server/actors.ts:33-40 claimsOf, server/board.ts:318-325 canOf).
 * parseCan's own `invalid_can` stays for a `can` written anywhere else.
 */
export function headerCan(header: string): CanSpec {
  try {
    return parseCan(header)
  } catch (error) {
    if (error instanceof BoardError && error.code === 'invalid_can') throw badRequest(error.message, 'invalid_scope')
    throw error
  }
}

export function writtenCan(can: unknown, max = 64): WrittenCan {
  if (typeof can !== 'object' || can === null || Array.isArray(can)) {
    throw badRequest(
      "a grant's can is a map from channel pattern to permissions, like { 'ci/': ['read', 'post'] }",
      'invalid_can',
    )
  }
  const entries = Object.entries(can as Record<string, unknown>)
  if (entries.length === 0) {
    throw badRequest("a grant's can names at least one channel pattern, like { '*': ['read'] }", 'invalid_can')
  }
  if (entries.length > max) {
    throw badRequest(`a grant's can names at most ${max} channel patterns`, 'invalid_can')
  }
  const out: Record<ChannelPattern, 'all' | Permission[]> = {}
  for (const [pattern, grant] of entries.sort(([a], [b]) =>
    a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b),
  )) {
    parsePattern(pattern)
    if (grant === 'all') {
      out[pattern] = 'all'
      continue
    }
    if (!Array.isArray(grant)) {
      throw badRequest(
        `${pattern} takes 'all' or a list of permissions: ${PERMISSIONS.join(', ')}`,
        'invalid_can',
      )
    }
    for (const permission of grant) {
      if (!PERM_ORDER.has(permission as Permission)) {
        throw badRequest(
          `unknown permission ${String(permission)} at ${pattern}: use ${PERMISSIONS.join(', ')}, or all`,
          'invalid_can',
        )
      }
    }
    out[pattern] = [...new Set(grant as Permission[])].sort(
      (a, b) => PERM_ORDER.get(a)! - PERM_ORDER.get(b)!,
    )
  }
  return out
}

export const LEVELS = ['principal', 'group', 'everyone'] as const
export type Level = (typeof LEVELS)[number]
const LEVEL_RANK: Record<Level, number> = { principal: 0, group: 1, everyone: 2 }

export type MatchedGrant<Source = unknown> = {
  level: Level
  can: CanSpec
  source: Source
}

export type Decision<Source = unknown> = {
  pattern: ChannelPattern | null
  over: ChannelPattern[]
  level: Level | null
  sources: Source[]
  permissions: readonly Permission[]
}

function closestByPattern<Source>(matched: readonly MatchedGrant<Source>[]) {
  const byPattern = new Map<
    string,
    { pattern: ParsedPattern; level: Level; permissions: Set<Permission>; sources: Source[] }
  >()
  for (const grant of matched) {
    for (const [pattern, permissions] of entriesOfCan(grant.can)) {
      const name = patternKey(pattern)
      const found = byPattern.get(name)
      if (!found || LEVEL_RANK[grant.level] < LEVEL_RANK[found.level]) {
        byPattern.set(name, {
          pattern,
          level: grant.level,
          permissions: new Set(permissions),
          sources: [grant.source],
        })
      } else if (found.level === grant.level) {
        for (const p of permissions) found.permissions.add(p)
        if (!found.sources.includes(grant.source)) found.sources.push(grant.source)
      }
    }
  }
  return byPattern
}

export function combineGrants(matched: readonly MatchedGrant[]): Access {
  return accessFromRules(
    canonicalRules(
      [...closestByPattern(matched).values()].map(
        ({ pattern, permissions }) => [pattern, permissions] as const,
      ),
    ),
  )
}

export function decideChannel<Source>(
  matched: readonly MatchedGrant<Source>[],
  channel: string,
): Decision<Source> {
  const byPattern = closestByPattern(matched)
  const covering = [...byPattern.values()].filter(({ pattern }) =>
    pattern.kind === 'all'
      ? true
      : pattern.kind === 'exact'
        ? pattern.path === channel
        : isUnderPath(channel, pattern.path),
  )
  const specificity = ({ pattern }: { pattern: ParsedPattern }): number =>
    pattern.kind === 'exact' ? Infinity : pattern.kind === 'subtree' ? pattern.path.length : -1
  const [winner, ...beaten] = covering.sort((a, b) => specificity(b) - specificity(a))
  if (!winner) return { pattern: null, over: [], level: null, sources: [], permissions: [] }
  return {
    pattern: patternKey(winner.pattern),
    over: beaten.map(({ pattern }) => patternKey(pattern)),
    level: winner.level,
    sources: winner.sources,
    permissions: [...winner.permissions].sort((a, b) => PERM_ORDER.get(a)! - PERM_ORDER.get(b)!),
  }
}

export function subPrefix(value: string): string | null {
  if (!value.endsWith('*')) return null
  const prefix = value.slice(0, -1)
  return /.[:/]$/.test(prefix) && !prefix.includes('*') ? prefix : null
}

type StoredGrant = {
  id: string
  seq: number
  principals: PrincipalView[]
  can: WrittenCan
  by: string | null
  at: string | null
}

export function levelOfPrincipal(
  principal: PrincipalView,
  facts: { caller: CallerPrincipal },
): Level | null {
  const { caller } = facts
  switch (principal.kind) {
    case 'everyone':
      return 'everyone'
    case 'all-users':
      return caller.kind === 'user' && caller.member === true ? 'group' : null
    case 'user':
      return caller.kind === 'user' && (caller.userId ?? caller.id) === principal.userId
        ? 'principal'
        : null
    case 'all-projects':
      return caller.kind === 'project' &&
        caller.teamProject === true &&
        caller.environment !== undefined &&
        principal.environments.includes(caller.environment)
        ? 'group'
        : null
    case 'project':
      return caller.kind === 'project' &&
        caller.projectId === principal.projectId &&
        (principal.teamId === null || caller.teamId === undefined || caller.teamId === principal.teamId) &&
        caller.environment !== undefined &&
        principal.environments.includes(caller.environment)
        ? 'principal'
        : null
    case 'github': {
      if (caller.kind !== 'github') return null
      const same =
        principal.repositoryId !== null && caller.repositoryId !== undefined
          ? principal.repositoryId === caller.repositoryId
          : caller.repository === principal.repository
      const workflow =
        principal.workflow === undefined ||
        (caller.ref !== undefined &&
          caller.workflowRef === `${caller.repository}/${principal.workflow}@${caller.ref}`)
      const branch =
        principal.branch === undefined || caller.ref === `refs/heads/${principal.branch}`
      const event = principal.event === undefined || caller.event === principal.event
      return same && workflow && branch && event ? 'principal' : null
    }
    case 'app':
      return caller.kind === 'app' && caller.clientId === principal.clientId ? 'principal' : null
    case 'all-apps':
      return caller.kind === 'app' && caller.teamApp === true ? 'group' : null
    case 'oidc':
      return caller.kind === 'oidc' &&
        caller.issuer === principal.issuer &&
        Object.entries(principal.claims).every(([name, allowed]) => {
          const value = caller.claims?.[name]
          if (value === undefined) return false
          const given = String(value)
          return (typeof allowed === 'string' ? [allowed] : allowed).some((one) => {
            const prefix = name === 'sub' ? subPrefix(one) : null
            return prefix === null ? given === one : given.startsWith(prefix)
          })
        })
        ? 'principal'
        : null
  }
}

export function grantAccessForCaller(
  caller: CallerPrincipal,
  grants: readonly StoredGrant[],
  canHeader?: string,
): { caller: Access; own: Access; admits: boolean } {
  const tokenCan = canHeader !== undefined ? compileAccess(headerCan(canHeader)) : null
  const cap = caller.cap !== undefined ? compileAccess({ '*': [...caller.cap] }) : null
  const limit = (base: Access): Access => {
    let out = cap ? base.narrow(cap) : base
    if (tokenCan) out = out.narrow(tokenCan)
    return out
  }

  if (caller.kind === 'deployment' || caller.owner === true) {
    const base = limit(FULL_ACCESS)
    return { caller: base, own: base, admits: true }
  }

  const matchedAll: MatchedGrant<StoredGrant>[] = []
  const matchedOwn: MatchedGrant<StoredGrant>[] = []
  for (const grant of grants) {
    let bestAll: Level | null = null
    let bestOwn: Level | null = null
    for (const p of grant.principals) {
      const level = levelOfPrincipal(p, { caller })
      if (level !== null && (bestAll === null || LEVEL_RANK[level] < LEVEL_RANK[bestAll])) {
        bestAll = level
      }
      if (
        p.kind !== 'everyone' &&
        level !== null &&
        (bestOwn === null || LEVEL_RANK[level] < LEVEL_RANK[bestOwn])
      ) {
        bestOwn = level
      }
    }
    if (bestAll !== null) matchedAll.push({ level: bestAll, can: grant.can, source: grant })
    if (bestOwn !== null) matchedOwn.push({ level: bestOwn, can: grant.can, source: grant })
  }

  const admits =
    (caller.kind === 'user' && caller.member === true) ||
    matchedAll.some((m) => m.level !== 'everyone')
  if (!admits) {
    return { caller: NO_ACCESS, own: NO_ACCESS, admits: false }
  }
  return {
    caller: limit(combineGrants(matchedAll)),
    own: limit(combineGrants(matchedOwn)),
    admits: true,
  }
}

const isUnderPattern = (other: string, pattern: string): boolean =>
  other !== pattern &&
  (pattern === '*' ||
    (pattern.endsWith('/') &&
      (other === pattern.slice(0, -1) || other.startsWith(pattern))))

type GrantChangeRefusal =
  | { reason: 'reach'; pattern: ChannelPattern; permission: 'manage' }
  | { reason: 'admission'; pattern: ChannelPattern; permission: Permission }
  | { reason: 'lockout'; pattern: ChannelPattern; permission: 'manage' }

function checkGrantChange(change: {
  caller: Access
  own: Access
  owner?: boolean
  after: readonly { principals: readonly PrincipalView[]; can: WrittenCan }[]
  changed?: { can: WrittenCan }
  revoked?: { can: WrittenCan }
  then?: { caller: Access; own: Access }
}): GrantChangeRefusal | null {
  if (change.owner) return null
  const { caller, own, then } = change
  const everyone = change.after.filter((g) => g.principals.some((p) => p.kind === 'everyone'))
  const lifted = Object.keys(change.revoked?.can ?? {})
  const made = Object.keys(change.changed?.can ?? {})
  const touched = [...new Set([...lifted, ...made])]
  const spots = [
    ...new Set([
      ...touched,
      ...everyone.flatMap((g) => Object.keys(g.can)),
      ...Object.keys(caller.summary()),
      ...Object.keys(own.summary()),
    ]),
  ]
  for (const pattern of touched) {
    if (!caller.at('manage', pattern) || !own.at('manage', pattern)) {
      return { reason: 'reach', pattern, permission: 'manage' }
    }
    for (const spot of spots) {
      if (isUnderPattern(spot, pattern) && !own.at('manage', spot)) {
        return { reason: 'reach', pattern: spot, permission: 'manage' }
      }
    }
  }
  if (made.length > 0) {
    const gives = combineGrants(
      everyone.map((g) => ({ level: 'everyone' as const, can: g.can, source: null })),
    )
    for (const spot of spots) {
      for (const permission of PERMISSIONS) {
        if (gives.at(permission, spot) && !caller.at(permission, spot)) {
          return { reason: 'admission', pattern: spot, permission }
        }
      }
    }
  }
  if (then) {
    for (const pattern of touched) {
      if (!then.caller.at('manage', pattern) || !then.own.at('manage', pattern)) {
        return { reason: 'lockout', pattern, permission: 'manage' }
      }
    }
  }
  return null
}

const PHRASE: Record<Permission, (channel: string) => string> = {
  read: (channel) => `read ${channel}`,
  post: (channel) => `post in ${channel}`,
  react: (channel) => `react in ${channel}`,
  label: (channel) => `label in ${channel}`,
  sync: (channel) => `sync in ${channel}`,
  manage: (channel) => `manage ${channel}`,
}

function authorizeChannel(
  access: Access,
  permission: Permission,
  channel: string,
  hidden?: () => Error,
): void {
  if (hidden && !access.readable(channel)) throw hidden()
  if (!access.can(permission, channel)) {
    throw forbidden(`this token can't ${PHRASE[permission](channel)}`)
  }
}

// ============================================================================
// Data Schemas & JSON Block Validation (F2 / F5)
// ============================================================================

export const SCHEMA_BYTES_MAX = 32_768
export const SCHEMA_NODES_MAX = 512
export const SCHEMA_SUBSCHEMAS_MAX = 64
export const SCHEMA_DEPTH_MAX = 16
export const SCHEMA_NAME_MAX = 80
export const SCHEMA_DESCRIPTION_MAX = 2000

const SCHEMA_VERSION_MAX = 99_999
const SCHEMA_NAME_REGEX = new RegExp(`^[a-z][a-z0-9._-]{0,${SCHEMA_NAME_MAX - 1}}$`)
const SCHEMA_ID_REGEX = new RegExp(`^([a-z][a-z0-9._-]{0,${SCHEMA_NAME_MAX - 1}})@([1-9][0-9]{0,4})$`)

export function parseSchemaId(id: string): { name: string; version: number } | null {
  const m = SCHEMA_ID_REGEX.exec(id)
  return m ? { name: m[1]!, version: Number(m[2]) } : null
}

const commitShaDef = {
  type: 'string',
  pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$',
  description: 'Full lowercase commit SHA',
}

export const BUILT_IN_SCHEMAS: readonly {
  name: string
  version: number
  description: string
  schema: Record<string, unknown>
}[] = [
  {
    name: 'git-commit',
    version: 1,
    description: 'A Git commit, by its full SHA and the first line of its message.',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['sha', 'title'],
      properties: {
        sha: commitShaDef,
        title: { type: 'string', minLength: 1, maxLength: 1024 },
      },
    },
  },
  {
    name: 'vercel-deployment',
    version: 1,
    description: 'A Vercel deployment, by its URL and optionally the commit it was built from.',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048 },
        gitSha: commitShaDef,
      },
    },
  },
]

const isBuiltInSchemaName = (name: string): boolean =>
  BUILT_IN_SCHEMAS.some((s) => s.name === name)

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const SCHEMA_TYPES: ReadonlySet<unknown> = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
])
const SCHEMA_FORMATS = [
  'date-time',
  'date',
  'time',
  'email',
  'uri',
  'uuid',
  'hostname',
  'ipv4',
  'ipv6',
] as const
const SCHEMA_FORMAT_SET: ReadonlySet<unknown> = new Set(SCHEMA_FORMATS)
const isSubschema = (v: unknown): boolean => isPlainObject(v) || typeof v === 'boolean'
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isFiniteNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): boolean => typeof v === 'string'
const isDistinct = (arr: readonly unknown[]): boolean => new Set(arr).size === arr.length

const SCHEMA_KEYWORDS: Readonly<Record<string, { takes: string; ok: (v: unknown) => boolean }>> = {
  $schema: { takes: 'a string', ok: isStr },
  title: { takes: 'a string', ok: isStr },
  description: { takes: 'a string', ok: isStr },
  type: {
    takes: 'object, array, string, number, integer, boolean, or null, or a list of them',
    ok: (v) =>
      SCHEMA_TYPES.has(v) ||
      (Array.isArray(v) && v.length > 0 && v.every((o) => SCHEMA_TYPES.has(o)) && isDistinct(v)),
  },
  properties: {
    takes: 'an object of schemas, by property',
    ok: (v) => isPlainObject(v) && Object.values(v).every(isSubschema),
  },
  required: {
    takes: 'a list of property names, each once',
    ok: (v) => Array.isArray(v) && v.every(isStr) && isDistinct(v),
  },
  additionalProperties: { takes: 'a schema, or true or false', ok: isSubschema },
  items: { takes: 'one schema for every item', ok: isSubschema },
  minItems: { takes: 'a whole number, 0 or more', ok: isCount },
  maxItems: { takes: 'a whole number, 0 or more', ok: isCount },
  minLength: { takes: 'a whole number, 0 or more', ok: isCount },
  maxLength: { takes: 'a whole number, 0 or more', ok: isCount },
  minimum: { takes: 'a number', ok: isFiniteNum },
  maximum: { takes: 'a number', ok: isFiniteNum },
  exclusiveMinimum: { takes: 'a number', ok: isFiniteNum },
  exclusiveMaximum: { takes: 'a number', ok: isFiniteNum },
  multipleOf: { takes: 'a number above 0', ok: (v) => isFiniteNum(v) && (v as number) > 0 },
  enum: { takes: 'a list of at least one value', ok: (v) => Array.isArray(v) && v.length > 0 },
  const: { takes: 'any value', ok: () => true },
  oneOf: {
    takes: 'a list of at least one schema',
    ok: (v) => Array.isArray(v) && v.length > 0 && v.every(isSubschema),
  },
  anyOf: {
    takes: 'a list of at least one schema',
    ok: (v) => Array.isArray(v) && v.length > 0 && v.every(isSubschema),
  },
  allOf: {
    takes: 'a list of at least one schema',
    ok: (v) => Array.isArray(v) && v.length > 0 && v.every(isSubschema),
  },
  not: { takes: 'a schema', ok: isSubschema },
  format: {
    takes: `one of ${SCHEMA_FORMATS.join(', ')}`,
    ok: (v) => SCHEMA_FORMAT_SET.has(v),
  },
}

const keepableStr = (v: string): boolean => !v.includes('\u0000') && v.isWellFormed()

export function checkSchemaDefinition(schema: unknown): string | null {
  if (!isPlainObject(schema) || schema.type !== 'object') {
    return 'a schema describes a JSON object: give it "type": "object"'
  }
  if (new TextEncoder().encode(JSON.stringify(schema)).length > SCHEMA_BYTES_MAX) {
    return `a schema is at most ${SCHEMA_BYTES_MAX} bytes of JSON`
  }
  let nodes = 0
  let subschemas = 0
  const counted = (depth: number): void => {
    if (++nodes > SCHEMA_NODES_MAX || depth > SCHEMA_DEPTH_MAX) {
      throw new Error(`a schema has at most ${SCHEMA_NODES_MAX} nodes and ${SCHEMA_DEPTH_MAX} levels`)
    }
  }
  const kept = (v: unknown): void => {
    if (typeof v === 'string' && !keepableStr(v)) {
      throw new Error('a schema has a NUL character or a lone surrogate in its text')
    }
  }
  const visitData = (v: unknown, depth: number): void => {
    counted(depth)
    kept(v)
    if (typeof v !== 'object' || v === null) return
    for (const [k, child] of Object.entries(v)) {
      kept(k)
      visitData(child, depth + 1)
    }
  }
  const visit = (v: unknown, depth: number, at: string, props: boolean): void => {
    counted(depth)
    kept(v)
    if (typeof v !== 'object' || v === null) return
    if (Array.isArray(v)) {
      v.forEach((item, idx) => visit(item, depth + 1, `${at}/${idx}`, false))
      return
    }
    if (props) {
      for (const [name, child] of Object.entries(v)) {
        kept(name)
        visit(child, depth + 1, `${at}/${name}`, false)
      }
      return
    }
    if (++subschemas > SCHEMA_SUBSCHEMAS_MAX) {
      throw new Error(`a schema has at most ${SCHEMA_SUBSCHEMAS_MAX} subschemas`)
    }
    for (const [kw, child] of Object.entries(v)) {
      const rule = Object.hasOwn(SCHEMA_KEYWORDS, kw) ? SCHEMA_KEYWORDS[kw] : undefined
      if (!rule) {
        throw new Error(
          `schemas don't take "${kw}"${at ? ` (at ${at})` : ''}: no references, patterns, uniqueItems, or keywords of your own`,
        )
      }
      if (!rule.ok(child)) {
        throw new Error(`"${kw}"${at ? ` at ${at}` : ''} takes ${rule.takes}`)
      }
      if (kw === 'enum' || kw === 'const') visitData(child, depth + 1)
      else visit(child, depth + 1, `${at}/${kw}`, kw === 'properties')
    }
  }
  try {
    visit(schema, 0, '', false)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, child: unknown) =>
    isPlainObject(child)
      ? Object.fromEntries(
          Object.entries(child).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : child,
  )
}

const DATE_RE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const TIME_RE = /^(\d\d):(\d\d):(\d\d)(\.\d+)?(z|[+-]\d\d(?::?\d\d)?)?$/i
const EMAIL_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i
const HOSTNAME_RE =
  /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/
const IPV6_RE =
  /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i
const UUID_RE = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const URI_RE =
  /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i

const isDateStr = (t: string): boolean => {
  const m = DATE_RE.exec(t)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  return mo >= 1 && mo <= 12 && d >= 1 && d <= (mo === 2 && leap ? 29 : DAYS_IN_MONTH[mo]!)
}
const isTimeStr = (t: string): boolean => {
  const m = TIME_RE.exec(t)
  if (!m) return false
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return (h <= 23 && mi <= 59 && s <= 59) || (h === 23 && mi === 59 && s === 60)
}
const FORMAT_CHECKS: Readonly<Record<string, (t: string) => boolean>> = {
  date: isDateStr,
  time: isTimeStr,
  'date-time': (t) => {
    const parts = t.split(/t|\s/i)
    return parts.length === 2 && isDateStr(parts[0]!) && isTimeStr(parts[1]!)
  },
  email: (t) => EMAIL_RE.test(t),
  uri: (t) => (/\/|:/.test(t) && URI_RE.test(t)),
  uuid: (t) => UUID_RE.test(t),
  hostname: (t) => HOSTNAME_RE.test(t),
  ipv4: (t) => IPV4_RE.test(t),
  ipv6: (t) => IPV6_RE.test(t),
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]))
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]))
}

function typeOfVal(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

/** A value as a refusal shows it: its JSON, cut short (original contract/data-values.ts shown). */
const shownValue = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}

/** `a`, `a or b`, `a, b, or c`: a few values, as a sentence lists them (original data-values.ts oneOf). */
function oneOfValues(values: readonly unknown[]): string {
  const listed = values.slice(0, 6).map(shownValue)
  if (values.length > 6) return `one of ${listed.join(', ')}, …`
  if (listed.length <= 2) return listed.join(' or ')
  return `${listed.slice(0, -1).join(', ')}, or ${listed.at(-1)}`
}

/** A type, or several, as a sentence names them: `a string`, `an object or null` (original data-values.ts named). */
const namedType = (types: readonly unknown[]): string =>
  types.map((one) => (one === 'null' ? 'null' : `${/^[aeio]/.test(String(one)) ? 'an' : 'a'} ${String(one)}`)).join(' or ')

/**
 * Why `value` doesn't match `schema`, or null when it does: the first thing wrong, said of the field
 * it's wrong in, in the original's words (original contract/data-values.ts:100-181 checkValue).
 */
export function checkSchemaValue(schema: Record<string, unknown> | boolean, value: unknown): string | null {
  const problemIn = (s: unknown, val: unknown, at: string): string | null => {
    const it = at || 'it'
    if (s === true) return null
    if (s === false) return `${it} isn't allowed`
    if (!isPlainObject(s)) return null
    const within = (k: string | number): string =>
      typeof k === 'number' ? `${at}[${k}]` : at ? `${at}.${k}` : k

    if (s.type !== undefined) {
      const allowed = Array.isArray(s.type) ? s.type : [s.type]
      const actual = typeOfVal(val)
      if (!allowed.some((one) => actual === one || (one === 'number' && actual === 'integer'))) {
        return `${it} must be ${namedType(allowed)}`
      }
    }
    if ('const' in s && !sameJson(val, s.const)) return `${it} must be ${shownValue(s.const)}`
    if (Array.isArray(s.enum) && !s.enum.some((o) => sameJson(val, o))) return `${it} must be ${oneOfValues(s.enum)}`

    if (typeof val === 'string') {
      const len = [...val].length
      if (typeof s.minLength === 'number' && len < s.minLength) return `${it} must be at least ${s.minLength} characters`
      if (typeof s.maxLength === 'number' && len > s.maxLength) return `${it} must be at most ${s.maxLength} characters`
      if (typeof s.format === 'string' && FORMAT_CHECKS[s.format]?.(val) === false) return `${it} must be ${/^[aeiu]/.test(s.format) ? 'an' : 'a'} ${s.format}`
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(val)) return `${it} must match ${s.pattern}`
    }

    if (typeof val === 'number') {
      if (typeof s.minimum === 'number' && val < s.minimum) return `${it} must be at least ${s.minimum}`
      if (typeof s.maximum === 'number' && val > s.maximum) return `${it} must be at most ${s.maximum}`
      if (typeof s.exclusiveMinimum === 'number' && val <= s.exclusiveMinimum) return `${it} must be above ${s.exclusiveMinimum}`
      if (typeof s.exclusiveMaximum === 'number' && val >= s.exclusiveMaximum) return `${it} must be below ${s.exclusiveMaximum}`
      if (typeof s.multipleOf === 'number' && !Number.isInteger(val / s.multipleOf)) return `${it} must be a multiple of ${s.multipleOf}`
    }

    if (Array.isArray(val)) {
      if (typeof s.minItems === 'number' && val.length < s.minItems) return `${it} must have at least ${s.minItems} items`
      if (typeof s.maxItems === 'number' && val.length > s.maxItems) return `${it} must have at most ${s.maxItems} items`
      const places = Array.isArray(s.items) ? s.items : null
      if (s.items !== undefined) {
        const count = places ? Math.min(places.length, val.length) : val.length
        for (let i = 0; i < count; i++) {
          const p = problemIn(places ? places[i] : s.items, val[i], within(i))
          if (p !== null) return p
        }
      }
    }

    if (isPlainObject(val)) {
      const props = isPlainObject(s.properties) ? s.properties : {}
      if (Array.isArray(s.required)) {
        for (const req of s.required) {
          if (typeof req === 'string' && !Object.hasOwn(val, req)) return `${within(req)} is missing`
        }
      }
      for (const [k, child] of Object.entries(val)) {
        if (Object.hasOwn(props, k)) {
          const p = problemIn(props[k], child, within(k))
          if (p !== null) return p
        } else if (s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) return `${within(k)} isn't one of its fields`
          const p = problemIn(s.additionalProperties, child, within(k))
          if (p !== null) return p
        }
      }
    }

    if (Array.isArray(s.allOf)) {
      for (const one of s.allOf) {
        const p = problemIn(one, val, at)
        if (p !== null) return p
      }
    }
    for (const kw of ['anyOf', 'oneOf'] as const) {
      const opts = s[kw]
      if (!Array.isArray(opts)) continue
      const probs = opts.map((o) => problemIn(o, val, at))
      const matched = probs.filter((p) => p === null).length
      if (matched === 0) {
        return probs.length === 1
          ? probs[0]!
          : `${it} matches none of the ${probs.length} it can be: ${[...new Set(probs)].slice(0, 4).join('; ')}`
      }
      if (kw === 'oneOf' && matched > 1) return `${it} matches ${matched} of the ${probs.length} it can be, and must match one`
    }
    if (s.not !== undefined && problemIn(s.not, val, at) === null) return `${it} matches what it must not`
    return null
  }
  return problemIn(schema, value, '')
}

// ============================================================================
// Top-Level Markdown JSON Blocks & Mention Settling (F2)
// ============================================================================

export type FoundBlock = {
  id: string
  name?: string
  version?: number
  source: string
  data?: Record<string, unknown>
  problem?: string
  start: number
  end: number
}

const OPENING_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const BLOCK_INFO_RE = /^json#(\S*)/
const QUOTED_LINE = /^ {0,3}>[ \t]?/
const LIST_ITEM_LINE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?: {1,4}|\t|$)/
const INTERRUPTS_PARAGRAPH = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|([-*_])(?:[ \t]*\1){2,}[ \t]*$|<)/

export function findBlocks(text: string): FoundBlock[] {
  type Fence = { fence: string; info: string }
  type Open = Fence & { start: number; content: number }
  const opens = (line: string): Fence | null => {
    const found = OPENING_FENCE.exec(line)
    return found && !(found[2]![0] === '`' && found[3]!.includes('`'))
      ? { fence: found[2]!, info: found[3]!.trim() }
      : null
  }
  const closes = (line: string, open: Fence): boolean => {
    const found = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
    return found !== null && found[1]![0] === open.fence[0] && found[1]!.length >= open.fence.length
  }
  const readBlock = (id: string, source: string) => {
    const named = parseSchemaId(id)
    if (!named) return { problem: `${id || 'json#'} names no schema: one is name@version, like sandbox@1` }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      return { ...named, problem: `the ${id} block isn't JSON` }
    }
    if (!isPlainObject(parsed)) return { ...named, problem: `the ${id} block isn't a JSON object` }
    return { ...named, data: parsed }
  }

  const blocks: FoundBlock[] = []
  let open: Open | null = null
  let container: 'quote' | 'item' | null = null
  let itemIndent = 0
  let nested: Fence | null = null
  let paragraph = false
  let at = 0

  const emit = (to: Open, sourceEnd: number, end: number, unclosed = false): void => {
    const id = BLOCK_INFO_RE.exec(to.info)?.[1]
    if (id === undefined) return
    const source = text.slice(to.content, Math.max(to.content, sourceEnd))
    blocks.push({
      id,
      source,
      ...(unclosed
        ? { ...(parseSchemaId(id) ?? {}), problem: `the ${id} block's fence never closes` }
        : readBlock(id, source)),
      start: to.start,
      end,
    })
  }
  const plain = (line: string): boolean =>
    line.trim() !== '' &&
    opens(line) === null &&
    !QUOTED_LINE.test(line) &&
    !LIST_ITEM_LINE.test(line) &&
    !INTERRUPTS_PARAGRAPH.test(line)

  const within = (line: string): string | null => {
    const quoted = QUOTED_LINE.exec(line)
    if (quoted) {
      if (container !== 'quote') nested = null
      container = 'quote'
      return line.slice(quoted[0].length)
    }
    if (container === 'item' && (line.trim() === '' || line.length - line.trimStart().length >= itemIndent)) {
      return line.slice(Math.min(itemIndent, line.length))
    }
    if (container !== null && paragraph && nested === null && plain(line)) return line
    const started = LIST_ITEM_LINE.exec(line)
    nested = null
    container = started ? 'item' : null
    if (!started) return null
    itemIndent = started[0].length === line.length ? line.length + 1 : started[0].length
    return line.slice(itemIndent)
  }

  while (at <= text.length) {
    const newline = text.indexOf('\n', at)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(at, end).replace(/\r$/, '')
    if (open) {
      if (closes(line, open)) {
        emit(open, at - 1, at + line.length)
        open = null
      }
    } else {
      const inner = within(line)
      if (inner === null) {
        const found = opens(line)
        if (found) open = { ...found, start: at, content: Math.min(text.length, end + 1) }
      } else if (nested) {
        if (closes(inner, nested)) nested = null
      } else {
        nested = opens(inner)
      }
      paragraph = inner !== null && nested === null && plain(inner)
    }
    if (newline === -1) break
    at = newline + 1
  }
  if (open) emit(open, text.length, text.length, true)
  return blocks
}

export function blocksIn(text: string): BlockView[] {
  if (!text.includes('json#')) return []
  return findBlocks(text).flatMap(({ name, version, data }) =>
    name !== undefined && version !== undefined && data !== undefined
      ? [{ schema: name, version, data }]
      : [],
  )
}

const FENCED_CODE_RE = /```[\s\S]*?```/g
const INLINE_CODE_RE = /`[^`\n]*`/g
const HANDLE_NAME_PART = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?'
const MENTION_HANDLE_RE = new RegExp(
  `(?<![\\w@.-])@(${HANDLE_NAME_PART}(?:/${HANDLE_NAME_PART})?)(?!:\\S|[a-z0-9_/-]|\\.(?=[a-z0-9]))`,
  'gi',
)
const MENTION_EXACT_RE = /(?<![\w@.-])@\[([^\]\s]+)\]/g
const HOLDABLE_ACTOR_RE = /^[^\]\s]+$/

export type MentionToken = { kind: 'handle'; handle: string } | { kind: 'actor'; actor: string }
export type MentionedActor = { id: string; handle: string; name: string }
export type Mentioned = { written: string; actor: MentionedActor | null; candidates: MentionedActor[] }

function proseOnly(text: string): string {
  let prose = text
    .replace(FENCED_CODE_RE, (m) => ' '.repeat(m.length))
    .replace(INLINE_CODE_RE, (m) => ' '.repeat(m.length))
  if (text.includes('json#')) {
    for (const { start, end } of findBlocks(text)) {
      prose = `${prose.slice(0, start)}${' '.repeat(end - start)}${prose.slice(end)}`
    }
  }
  return prose
}

export const mentionTerm = (name: string): string =>
  name.includes(':') ? name : name.toLowerCase()

export function extractMentions(text: string): MentionToken[] {
  const prose = proseOnly(text)
  const found: { index: number; token: MentionToken; key: string }[] = []
  for (const m of prose.matchAll(MENTION_EXACT_RE)) {
    const actor = m[1]
    if (actor !== undefined) {
      found.push({ index: m.index, token: { kind: 'actor', actor }, key: `actor:${actor}` })
    }
  }
  for (const m of prose.replace(MENTION_EXACT_RE, (s) => ' '.repeat(s.length)).matchAll(MENTION_HANDLE_RE)) {
    const handle = m[1]?.toLowerCase()
    if (handle !== undefined) {
      found.push({ index: m.index, token: { kind: 'handle', handle }, key: `handle:${handle}` })
    }
  }
  const seen = new Set<string>()
  return found
    .sort((a, b) => a.index - b.index)
    .filter(({ key }) => !seen.has(key) && seen.add(key))
    .map(({ token }) => token)
}

export const mentionTerms = (text: string): string[] => [
  ...new Set(
    extractMentions(text).map((t) => mentionTerm(t.kind === 'handle' ? t.handle : t.actor)),
  ),
]

export function replaceMentions(
  text: string,
  replace: (token: MentionToken, written: string) => string | null,
): string {
  const prose = proseOnly(text)
  const found: { index: number; length: number; token: MentionToken }[] = []
  for (const m of prose.matchAll(MENTION_EXACT_RE)) {
    found.push({ index: m.index, length: m[0].length, token: { kind: 'actor', actor: m[1]! } })
  }
  for (const m of prose.replace(MENTION_EXACT_RE, (s) => ' '.repeat(s.length)).matchAll(MENTION_HANDLE_RE)) {
    found.push({
      index: m.index,
      length: m[0].length,
      token: { kind: 'handle', handle: m[1]!.toLowerCase() },
    })
  }
  let out = ''
  let at = 0
  for (const { index, length, token } of found.sort((a, b) => a.index - b.index)) {
    const written = text.slice(index, index + length)
    out += text.slice(at, index) + (replace(token, written) ?? written)
    at = index + length
  }
  return out + text.slice(at)
}

export function settleMentions(
  text: string,
  actors: readonly MentionedActor[],
  prefer: (candidates: readonly MentionedActor[]) => MentionedActor | null = () => null,
): { text: string; mentions: Mentioned[] } {
  const found = new Map<string, Mentioned>()
  const settled = replaceMentions(text, (token, written) => {
    if (token.kind !== 'handle') return null
    let mention = found.get(token.handle)
    if (!mention) {
      const named = (of: (h: string) => string): MentionedActor[] =>
        actors.filter((a) => of(a.handle.toLowerCase()) === token.handle && HOLDABLE_ACTOR_RE.test(a.id))
      const full = named((h) => h)
      const actor = full.length === 1 ? full[0]! : full.length > 1 ? prefer(full) : null
      const under =
        full.length > 0 || token.handle.includes('/')
          ? full
          : named((h) => h.slice(h.indexOf('/') + 1))
      mention = { written, actor, candidates: actor ? [] : under }
      found.set(token.handle, mention)
    }
    return mention.actor ? `@[${mention.actor.id}]` : null
  })
  return { text: settled, mentions: [...found.values()] }
}

/**
 * A label write under `board.`: those keys are the board's own, which only its task writes set,
 * worded as the original's (server/serve.ts:86-91 ownLabels).
 */
const reservedLabel = (key: string): BoardError =>
  badRequest(
    `${key} is the board's own label: only its task writes set labels under ${RESERVED_LABEL_PREFIX}`,
    'reserved_label',
  )

/** By UTF-16 code unit, as `sort()` orders strings: the same in every locale and runtime. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * What `watchersHash` hashes: each watcher as `[id, tail]`, by ID, then, only when there is a sync,
 * `['sync', [[key, platform], ...]]` by key. A registration with no sync hashes as older ones did
 * (original server/watchers-hash.ts:12-23 canonicalWatchers).
 */
export function canonicalWatchers(
  watch: Readonly<Record<string, { tail: string }>>,
  sync: readonly { key: string; platform: string }[] = [],
): string {
  const canonical: unknown[] = Object.keys(watch)
    .sort(byCodeUnit)
    .map((id) => [id, watch[id]!.tail])
  if (sync.length > 0) {
    canonical.push(['sync', [...sync].sort((a, b) => byCodeUnit(a.key, b.key)).map((entry) => [entry.key, entry.platform])])
  }
  return JSON.stringify(canonical)
}

/**
 * A registration's hash, the same on both ends: a v0.54.0 registrant compares it with its own to
 * tell whether its registration is current (original server/registry.ts:38-40, registrant.ts:89).
 */
export const watchersHash = (
  watch: Readonly<Record<string, { tail: string }>>,
  sync: readonly { key: string; platform: string }[] = [],
): string => createHash('sha256').update(canonicalWatchers(watch, sync)).digest('hex').slice(0, 32)

/** How often a waiting events poll looks for a commit another connection made. */
const EVENTS_WAIT_POLL_MS = 100

/**
 * Whether an error is the store's: closed or unavailable (a typed 503), or SQLite's own failure
 * (busy, locked, I/O, ...). A waiting poll answers what it has on one of these; any other error is
 * a fault in the board's own code.
 */
function isStoreFailure(error: unknown): boolean {
  if (error instanceof BoardError) return error.status === 503
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && (code.startsWith('ERR_SQLITE') || code === 'ERR_INVALID_STATE')
}

/** The queue a registrant's sync pulls: watcher IDs start with a letter, so none is this (original registered.ts:21). */
export const SYNC_QUEUE = '@sync'

/**
 * What a registrant's sync is handed, in every channel where it may sync: what it delivers to
 * platforms, and a thread's new targets (original watch.ts:55 SYNCED).
 */
const SYNCED_EVENTS: ReadonlySet<string> = new Set([
  'message.posted',
  'message.edited',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
  'labels.changed',
  'thread.synced',
])

const blindText = (text: string, ownActorId: string): string =>
  replaceMentions(text, (token) => (token.kind === 'actor' && token.actor !== ownActorId ? '@…' : null))

/**
 * A post's view for its writer. One that can't read the channel gets back the text it sent: what
 * the board made of it is for its readers (original writes.ts:536-540 shownTo).
 */
const shownTo = (shown: MessageView, access: Access, sent: string): MessageView =>
  access.readable(shown.channel) ? shown : { ...shown, text: sent }

/** A handle that would have mentioned an actor, said as one that didn't (original serve.ts:528-529 unsettled). */
const unsettled = (mention: Mentioned): Mentioned =>
  mention.actor ? { written: mention.written, actor: null, candidates: [mention.actor] } : mention

// ============================================================================
// Attachment Names & Types (original contract/files.ts, server/file-names.ts)
// ============================================================================

/** `shot.png`, as the board stores a name: no paths, no control characters, at most 255 (original contract/files.ts:50-53). */
export function fileName(name: string | null | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return base.slice(0, 255) || 'file'
}

/** Invisible formatting (bidi overrides, zero-width), and line and paragraph separators. */
const INVISIBLE_CHARS = /[\p{Cf}\u2028\u2029]/u

/** Why a stored name can't be `name`: a dotfile, or one that shows other than it reads (original contract/files.ts:58-62). */
export function fileNameProblem(name: string): string | undefined {
  if (name.startsWith('.')) return `attachment names can't start with a dot: ${JSON.stringify(name)}`
  if (INVISIBLE_CHARS.test(name)) {
    return `attachment names can't hold invisible formatting characters: ${JSON.stringify(name)}`
  }
  return undefined
}

/** The name an upload is stored under, or 400 `invalid_attachment` (original server/file-names.ts:5-9). */
function uploadName(name: string | null | undefined): string {
  const named = fileName(name)
  const problem = fileNameProblem(named)
  if (problem) throw badRequest(problem, 'invalid_attachment')
  return named
}

/** `image/png`, or `application/octet-stream` when the type isn't one (original contract/files.ts:70-73). */
export function mediaType(type: string | null | undefined): string {
  const value = (type ?? '').split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) && value.length <= 255
    ? value
    : 'application/octet-stream'
}

/** 128 random bits, base64url, drawn again when they'd start with `-` (original server/blob.ts:62-67). */
function newAttachmentId(): string {
  for (;;) {
    const id = randomBytes(16).toString('base64url')
    if (!id.startsWith('-')) return id
  }
}

/** How long a direct upload takes its bytes (original server/blob.ts:132). */
const DIRECT_UPLOAD_TTL_MS = 30 * 60 * 1000

const attachmentNotFound = (id: string): BoardError => notFound(`no attachment: ${id}`, 'attachment_not_found')

// ============================================================================
// Registrant Queues: watcher matches and sync inboxes (original server/registered.ts)
// ============================================================================

/** Tries before a match or inbox event is given up on (original registered.ts:14). */
export const MATCH_TRIES = 5
/** How long a pulled item is its puller's before someone may pull it again (original registered.ts:16). */
export const LEASE_MS = 5 * 60_000
/** After an error, an item waits 1 second, doubling to 30 (original registered.ts:18). */
export const retryDelay = (attempts: number): number => Math.min(30_000, 1000 * 2 ** (attempts - 1))

/** A queued item as the lease and ack code needs it: watcher matches and inbox events alike. */
type QueueRow = {
  id: string
  queue: string
  thread: string
  status: string
  lease: string | null
  lease_until: number | null
  attempt: number
  retry_at: number | null
}

/** Statuses an item is still queued in; anything else (acked, skipped, failed) is done. */
const QUEUED = "('pending', 'leased')"

/** A board's own derived IDs and a sync's import IDs, which no request may post with (original a2.ts:406-415 ownId). */
/**
 * `idempotentId`'s shape, a UUIDv8: the IDs the board derives for its own writes. They're
 * guessable, so no request may post with one and take it first (original a2.ts:116-120 DERIVED_ID).
 */
const DERIVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Whether `id` is exactly the shape a client's key derives for `principal`: `key:<principal>:` and
 * 32 hex digits. A prefix check isn't enough, as one principal's ID can start another's
 * (original client/ids.ts:31-36 isKeyIdOf).
 */
export const isKeyIdOf = (id: string, principal: string): boolean =>
  id.startsWith(`key:${principal}:`) && /^[0-9a-f]{32}$/.test(id.slice(`key:${principal}:`.length))

/**
 * Refuses a request's post an ID that's someone else's to post with: the board's own (a UUIDv8, or
 * a schedule's send), another principal's key-derived one, or one a sync's import lands with. So no
 * one can post with it first and make its owner's retry fail with 409 (original a2.ts:406-415 ownId).
 */
function ownId(principal: string, id: string): void {
  if (DERIVED_ID.test(id)) throw badRequest("id: UUIDv8s are the board's own, for the writes it makes itself")
  if (id.startsWith('key:') && !isKeyIdOf(id, principal)) {
    throw badRequest(`id: key:… IDs derive from a client's key, and this token's are key:${principal}:…`)
  }
  if (id.startsWith('sync:')) throw badRequest('id: sync:… IDs are what sync imports, under the principal that imports them')
  if (id.startsWith('board-schedule:')) throw badRequest("id: board-schedule:… IDs are the board's own, for the writes it makes itself")
}

/** This board's own limit on a message's files (original a2.ts:383-386 withinLimits). */
function checkAttachmentCount(ids: readonly string[] | undefined): void {
  if ((ids?.length ?? 0) > ATTACHMENTS_PER_MESSAGE_MAX) {
    throw badRequest(`attachments: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`)
  }
}

// ============================================================================
// Emoji & Watcher Tail Helpers
// ============================================================================

export { canonicalEmoji, displayEmoji, normalizeEmoji } from './emoji.ts'

function splitShellWords(expression: string): string[] {
  const out: string[] = []
  let word: string | null = null
  let quote: '"' | "'" | null = null
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < expression.length) word += expression[++i]!
      else word += ch
    } else if (/\s/.test(ch)) {
      if (word !== null) out.push(word)
      word = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      word ??= ''
    } else if (ch === '\\' && i + 1 < expression.length) {
      word = (word ?? '') + expression[++i]!
    } else {
      word = (word ?? '') + ch
    }
  }
  if (quote) throw new Error(`unterminated ${quote}`)
  if (word !== null) out.push(word)
  return out
}

/**
 * The filter flags `read`, `tail`, and `wait` share, and that a watcher's `tail` accepts, beside
 * `--all` (original api/tail.ts:6 FILTER_FLAGS). One list, so the parser and its callers agree.
 */
export const WATCH_TAIL_VALUE_FLAGS = ['re', 'by', 'mentions', 'label', 'source', 'text'] as const

/** What `--mentions` takes as its value when it's the next word: `@ada`, `ada@vercel.com`, or `me`. */
const mentionValue = (word: string | undefined): boolean =>
  word !== undefined && !word.startsWith('-') && (word === 'me' || word.includes('@'))

/**
 * `--mentions` alone means mentions of me; `--mentions @ada`, mentions of ada; `--mentions
 * ada@vercel.com`, of the user with that email. Nothing after `--` is a flag (original api/tail.ts:15-36).
 */
export function withMentions(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      out.push(...args.slice(i))
      break
    }
    if (arg !== '--mentions') out.push(arg)
    else if (mentionValue(args[i + 1])) out.push(`--mentions=${args[++i]}`)
    else out.push('--mentions=me')
  }
  return out
}

export function parseWatchTail(expression: string): { filters: ParsedFilters; all: boolean } {
  const args = withMentions(splitShellWords(expression))
  const values: {
    re?: string
    by?: string
    mentions?: string
    label?: string[]
    source?: string
    text?: string
    all?: boolean
  } = {}
  const positionals: string[] = []
  const valueFlags = new Set<string>(WATCH_TAIL_VALUE_FLAGS)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = arg.startsWith('--') ? arg.slice(2, eq === -1 ? undefined : eq) : null
    if (name === 'all') {
      if (eq !== -1) throw new Error('--all takes no value')
      values.all = true
      continue
    }
    if (name === null || !valueFlags.has(name)) {
      throw new Error(`${name !== null ? `--${name}` : arg.slice(0, 2)} isn't a filter`)
    }
    let val: string
    if (eq !== -1) {
      val = arg.slice(eq + 1)
    } else {
      const next = args[i + 1]
      if (next === undefined || (next.length > 1 && next.startsWith('-'))) {
        throw new Error(`--${name} needs a value`)
      }
      val = next
      i++
    }
    if (name === 'label') {
      values.label = [...(values.label ?? []), val]
    } else if (name === 're') values.re = val
    else if (name === 'by') values.by = val
    else if (name === 'mentions') values.mentions = val
    else if (name === 'source') values.source = val
    else if (name === 'text') values.text = val
  }

  if (positionals.length > 1) {
    throw new Error(`expected one channel, got: ${positionals.join(' ')}`)
  }
  const channel = positionals[0]
  const parsed = FiltersSchema.safeParse({
    ...(channel ? { channel } : {}),
    ...(values.re ? { re: values.re.replace(/^#/, '') } : {}),
    ...(values.by ? { by: values.by.replace(/^@/, '') } : {}),
    ...(values.mentions ? { mentions: values.mentions.replace(/^@/, '') } : {}),
    ...(values.label?.length ? { label: values.label } : {}),
    ...(values.source ? { from: values.source } : {}),
    ...(values.text ? { text: values.text } : {}),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`${issue?.path.length ? `--${String(issue.path[0])}: ` : ''}${issue?.message ?? 'invalid filters'}`)
  }
  return { filters: parsed.data, all: values.all === true }
}

// ============================================================================
// Internal Stored Message & Feed Helpers
// ============================================================================

/**
 * A message as the board stores it (board_messages.data, board_versions.data). Exported for the task
 * engine's port (tasks/host.ts) only: it is no view, and transports never answer with it.
 * @internal
 */
export type StoredMessage = {
  id: number
  eventId: string
  channel: string
  text: string
  re: number | null
  replyTo: number | null
  thread: string
  labels: Labels
  reactions: Record<string, string[]>
  by: Author
  noSync: boolean
  origin: Origin | null
  from: string | null
  createdAt: string
  editedAt: string | null
  deleted: boolean
  undelivered: Record<string, string>
  attachments: Attachment[]
  links: LinkView[]
  quote?: QuoteView
  schedule?: { id: number; n: number }
  task?: TaskView
  blind?: true
  platformText?: true
  version: number
  revision: number
}

type StoredActor = {
  id: string
  kind: ActorKind
  handle: string
  name: string
  avatar: string | null
  via?: Via
  platform?: string
  host?: true
  verified?: true
}

const HIDDEN_EVENT_TYPES = new Set([
  'actor.seen',
  'message.synced',
  'message.files_synced',
  'task.renewed',
])

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

function parseDurationMs(input: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(input)
  if (!m) throw badRequest(`invalid duration: ${input}`)
  return Math.round(Number(m[1]) * DURATION_UNITS[m[2]!]!)
}

export const MIN_EVERY_MS = 60_000
export const MAX_AHEAD_MS = 366 * 86_400_000

const STARTING_GRANTS: readonly {
  id: string
  seq: number
  principals: PrincipalView[]
  can: WrittenCan
}[] = [
  { id: 'g1', seq: 1, principals: [{ kind: 'all-users' }], can: { '*': 'all' } },
  {
    id: 'g2',
    seq: 2,
    principals: [{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }],
    can: { '*': ['read', 'post', 'react', 'label', 'sync'] },
  },
  {
    id: 'g3',
    seq: 3,
    principals: [{ kind: 'all-apps' }],
    can: { '*': ['read', 'post', 'react', 'label'] },
  },
]

// A platform user's handle as a principal's sync imported them (original contract/profiles.ts:13-57).
const HANDLE_MAX = 128

function trimmedHandle(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && '-._'.includes(value[start]!)) start++
  while (end > start && '-._'.includes(value[end - 1]!)) end--
  return value.slice(start, end)
}

const typable = (value: string): string =>
  trimmedHandle(
    value
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-'),
  )

export function underPrincipal(principal: string, part: string): string {
  const room = HANDLE_MAX - Array.from(principal).length - 1
  const chars = Array.from(part)
  return `${principal}/${chars.length <= room ? part : trimmedHandle(chars.slice(0, Math.max(room, 1)).join(''))}`
}

/** `support/malte-ubl`: the importing principal's name, then the platform user's typable handle. */
export const importedHandle = (principal: string, handle: string, userId: string): string =>
  underPrincipal(principal, typable(handle) || typable(userId))

// Grant principals, checked as a board that verifies tokens itself keeps them
// (original server/auth.ts:167-377 checkIssuer, checkClaims, checkPrincipal, checkGrant, removes, joined).

const GRANT_PRINCIPALS_MAX = 32
const GRANT_CLAIMS_MAX = 32
const GRANT_VALUES_MAX = 32
const GRANT_VALUE_MAX = 1000
export const TEAM_ENVIRONMENTS: readonly string[] = ['production', 'preview', 'development']
const PROJECT_ID = /^prj_[A-Za-z0-9]+$/
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/
const LOGIN = /^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9][a-z0-9.-]{0,127}$/
const APP_ID = USER_ID
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const VERCEL_ISSUER = /^https:\/\/oidc\.vercel\.com(?:\/[a-z0-9-]+)?$/
export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'

const invalidGrant = (message: string): BoardError => badRequest(message, 'invalid_grant')

/** Whether `host` names something on the board's own network rather than on the internet. */
export function privateHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (name.startsWith('[') || /^\d+(\.\d+){3}$/.test(name) || /^\d+$/.test(name)) return true
  if (!name.includes('.') || name === 'localhost') return true
  return /\.(localhost|local|internal|home|lan|corp|intranet)$/.test(name)
}

/** An issuer as a principal names it: `gitlab.com`, `example.com/oidc`, `ci.test%3A8443`. */
export const issuerName = (iss: string): string => {
  const url = new URL(iss)
  return `${url.host}${url.pathname.replace(/\/+$/, '')}`.replace(/[%:]/g, (char) => (char === '%' ? '%25' : '%3A'))
}

function checkIssuer(issuer: string, trusted: readonly string[]): void {
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw invalidGrant(`an oidc principal's issuer is an https URL, got ${issuer}`)
  }
  if (VERCEL_ISSUER.test(issuer)) {
    throw invalidGrant("name Vercel's deployments as a project or all-projects, not as an oidc issuer")
  }
  if (issuer === GITHUB_ISSUER) {
    throw invalidGrant('name GitHub Actions runs as a github principal, not as an oidc issuer')
  }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) {
    throw invalidGrant(`an oidc principal's issuer is an https URL with no query or credentials, got ${issuer}`)
  }
  if (privateHost(url.hostname)) {
    throw invalidGrant(`an oidc principal's issuer is on the internet, not ${url.hostname}`)
  }
  const name = issuerName(issuer)
  const other = trusted.find(
    (candidate) => candidate !== issuer && /^https:/.test(candidate) && issuerName(candidate) === name,
  )
  if (other !== undefined) {
    throw invalidGrant(`issuers ${other} and ${issuer} name the same principals, oidc:${name}:<sub>: use ${other}`)
  }
}

/**
 * An issuer's claims, keys and lists sorted. They name a `sub`, exact or a prefix `subPrefix` takes:
 * an issuer signs tokens for everyone it serves, and only `sub` says whose a token is. A removal is
 * checked for neither, so a principal stored without one can still be taken out.
 */
function checkClaims(
  issuer: string,
  given: Readonly<Record<string, string | readonly string[]>>,
  removal: boolean,
): Record<string, string | string[]> {
  const entries = typeof given === 'object' && given !== null ? Object.entries(given) : []
  if (!removal && !entries.some(([name]) => name === 'sub')) {
    throw invalidGrant(
      `name a sub for ${issuer}, like project_path:acme/api:*: it signs tokens for everyone it serves, and only a sub says whose a token is`,
    )
  }
  if (entries.length > GRANT_CLAIMS_MAX) {
    throw invalidGrant(`an oidc principal names at most ${GRANT_CLAIMS_MAX} claims`)
  }
  const claims: Record<string, string | string[]> = {}
  for (const [name, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const values: unknown[] =
      typeof value === 'string' ? [value] : Array.isArray(value) ? [...new Set(value as readonly unknown[])] : []
    if (values.length === 0 || values.some((one) => typeof one !== 'string' || one === '')) {
      throw invalidGrant(`claim ${name} has no value to match: give a string, or a list of them`)
    }
    const strings = values as string[]
    if (strings.length > GRANT_VALUES_MAX || strings.some((one) => one.length > GRANT_VALUE_MAX)) {
      throw invalidGrant(
        `claim ${name} lists at most ${GRANT_VALUES_MAX} values of up to ${GRANT_VALUE_MAX} characters`,
      )
    }
    const wild =
      name === 'sub' && !removal ? strings.find((one) => one.includes('*') && subPrefix(one) === null) : undefined
    if (wild === '*') {
      throw invalidGrant(
        `sub * is everyone ${issuer} serves: name a sub, or how one starts, like project_path:acme/api:*`,
      )
    }
    if (wild !== undefined) {
      throw invalidGrant(`a sub's * goes last, right after a : or a /, like project_path:acme/api:*, got ${wild}`)
    }
    const sorted = [...strings].sort()
    claims[name] = sorted.length === 1 ? sorted[0]! : sorted
  }
  return claims
}

/** Environments without repeats, in Vercel's order (production, preview, development), then custom ones. */
const environmentsOf = (given: readonly string[]): string[] => {
  const rank = (environment: string): number =>
    TEAM_ENVIRONMENTS.includes(environment) ? TEAM_ENVIRONMENTS.indexOf(environment) : TEAM_ENVIRONMENTS.length
  return [...new Set(given)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** `ci.yml` is `.github/workflows/ci.yml`, as GitHub names a workflow in a token's `workflow_ref`. */
export const workflowPath = (workflow: string): string =>
  workflow.includes('/') ? workflow : `.github/workflows/${workflow}`

/**
 * A principal as this board keeps it, or a 400 `invalid_grant` that says what to write. The board
 * verifies tokens itself, so it takes IDs: a user's ID (or login, where `logins`), a project's
 * `prj_…`, a repository's `owner/name`. `removal`: one to take out of a grant, which names a project
 * without its environments and an issuer's tokens without a `sub`.
 */
export function checkPrincipal(
  input: PrincipalInput,
  trusted: readonly string[],
  removal = false,
  logins = false,
): PrincipalView {
  switch (input.kind) {
    case 'user': {
      if (input.email !== undefined && input.userId !== undefined) {
        throw invalidGrant('a user is its email or its userId, not both')
      }
      if (input.email !== undefined && !logins) {
        throw invalidGrant(
          `this board can't look up ${input.email}: it verifies tokens itself, so name the user by ID, { kind: 'user', userId }`,
        )
      }
      const login = (input.email ?? (logins && input.userId?.includes('@') ? input.userId : undefined))?.toLowerCase()
      if (login !== undefined) {
        if (!LOGIN.test(login)) {
          throw invalidGrant(`a user here is the login they're known by, like ada@example.com, got ${login}`)
        }
        return { kind: 'user', userId: login, email: null }
      }
      if (input.userId === undefined || !USER_ID.test(input.userId)) {
        throw invalidGrant('a user is its userId, letters, numbers, and ._-')
      }
      return { kind: 'user', userId: input.userId, email: null }
    }
    case 'project': {
      if (!PROJECT_ID.test(input.project)) {
        throw invalidGrant(
          `this board can't look up the project ${input.project}: it verifies tokens itself, so name it by ID, prj_…`,
        )
      }
      if (removal) return { kind: 'project', projectId: input.project, name: null, environments: [], teamId: null }
      if (input.environments === undefined) {
        throw invalidGrant(`a project names the environments its deployments get in from, like ['production']`)
      }
      return {
        kind: 'project',
        projectId: input.project,
        name: null,
        environments: environmentsOf(input.environments),
        teamId: null,
      }
    }
    case 'all-projects': {
      if (removal) return { kind: 'all-projects', environments: [] }
      if (input.environments === undefined) {
        throw invalidGrant(`all-projects names the environments its deployments get in from, like ['production']`)
      }
      const custom = input.environments.filter((environment) => !TEAM_ENVIRONMENTS.includes(environment))
      if (custom.length > 0) {
        throw invalidGrant(`all-projects names production, preview, or development: ${custom[0]} is one project's`)
      }
      return { kind: 'all-projects', environments: environmentsOf(input.environments) }
    }
    case 'github':
      if (!REPOSITORY.test(input.repository)) {
        throw invalidGrant(`a github principal's repository is owner/name, got ${input.repository}`)
      }
      return {
        kind: 'github',
        repositoryId: null,
        repository: input.repository,
        ...(input.workflow !== undefined ? { workflow: workflowPath(input.workflow) } : {}),
        ...(input.branch !== undefined ? { branch: input.branch.replace(/^refs\/heads\//, '') } : {}),
        ...(input.event !== undefined ? { event: input.event } : {}),
      }
    case 'oidc':
      checkIssuer(input.issuer, trusted)
      return { kind: 'oidc', issuer: input.issuer, claims: checkClaims(input.issuer, input.claims, removal) }
    case 'app':
      if (!APP_ID.test(input.app)) {
        throw invalidGrant(`an app is its client ID, letters, numbers, and ._-, got ${input.app}`)
      }
      return { kind: 'app', clientId: input.app, name: null }
    case 'all-users':
      return { kind: 'all-users' }
    case 'all-apps':
      return { kind: 'all-apps' }
    case 'everyone':
      return { kind: 'everyone' }
  }
}

/** One principal's key: two that share it are the same principal. */
const principalKey = (principal: PrincipalView): string => canonicalJson(principal)

/** A grant's `can` as written, or a 400 `invalid_grant`. */
function checkCan(can: unknown): WrittenCan {
  try {
    return writtenCan(can)
  } catch (error) {
    throw invalidGrant((error as Error).message)
  }
}

/** Principals checked, without repeats, and a `can` kept as written. */
function checkGrantSpec(
  body: { principals: readonly PrincipalInput[]; can: unknown },
  trusted: readonly string[],
  logins: boolean,
): { principals: PrincipalView[]; can: WrittenCan } {
  if (body.principals.length === 0) throw invalidGrant('a grant names at least one principal')
  if (body.principals.length > GRANT_PRINCIPALS_MAX) {
    throw invalidGrant(`a grant names at most ${GRANT_PRINCIPALS_MAX} principals`)
  }
  const seen = [...trusted]
  const checked = body.principals.map((input) => {
    const principal = checkPrincipal(input, seen, false, logins)
    if (principal.kind === 'oidc') seen.push(principal.issuer)
    return principal
  })
  const principals = [...new Map(checked.map((principal) => [principalKey(principal), principal])).values()]
  return { principals, can: checkCan(body.can) }
}

/** The OIDC issuers grants name. */
const grantIssuers = (grants: readonly { principals: readonly PrincipalView[] }[]): string[] => [
  ...new Set(
    grants.flatMap((grant) => grant.principals.flatMap((p) => (p.kind === 'oidc' ? [p.issuer] : []))),
  ),
]

/**
 * Whether `removal` takes `principal` out of a grant: the same user, project, or issuer and claims,
 * whatever its environments; a repository's principals with the workflow, branch, and event it
 * names, any of them where it names none; a group or everyone by its kind.
 */
export function removesPrincipal(removal: PrincipalView, principal: PrincipalView): boolean {
  if (removal.kind !== principal.kind) return false
  switch (removal.kind) {
    case 'user':
      return removal.userId === (principal as typeof removal).userId
    case 'project':
      return removal.projectId === (principal as typeof removal).projectId
    case 'github': {
      const other = principal as typeof removal
      return (
        removal.repository === other.repository &&
        (removal.workflow === undefined || removal.workflow === other.workflow) &&
        (removal.branch === undefined || removal.branch === other.branch) &&
        (removal.event === undefined || removal.event === other.event)
      )
    }
    case 'oidc': {
      const other = principal as typeof removal
      return removal.issuer === other.issuer && canonicalJson(removal.claims) === canonicalJson(other.claims)
    }
    case 'app':
      return removal.clientId === (principal as typeof removal).clientId
    default:
      return true
  }
}

/**
 * `added` joined into `principal` when it's the same principal: a project's environments, or every
 * project's, together. Null when it's another principal. Adding never narrows what a grant names.
 */
export function joinedPrincipal(added: PrincipalView, principal: PrincipalView): PrincipalView | null {
  if (added.kind !== principal.kind) return null
  if (added.kind === 'project') {
    const other = principal as typeof added
    if (added.projectId !== other.projectId) return null
    return { ...other, environments: environmentsOf([...other.environments, ...added.environments]) }
  }
  if (added.kind === 'all-projects') {
    const other = principal as typeof added
    return { ...other, environments: environmentsOf([...other.environments, ...added.environments]) }
  }
  return principalKey(added) === principalKey(principal) ? principal : null
}

/** Events that belong to the board's access, schema and schedule records, which /events never serves. */
const RECORD_EVENT_TYPES = new Set([
  'grant.created',
  'grant.updated',
  'grant.revoked',
  'grant.deleted',
  'schema.created',
  'schedule.created',
  'schedule.canceled',
  'schedule.sent',
  'schedule.failed',
])

function carriedEvent(event: BoardEventView): BoardEventView | null {
  const message = event.message
  if (!message) return event
  const payload = event.payload
  switch (event.type) {
    case 'reaction.added':
    case 'reaction.removed': {
      const emoji = payload.emoji as string
      const actor = (payload.by as { actor?: string } | undefined)?.actor ?? ''
      const list = Object.hasOwn(message.reactions, emoji) ? message.reactions[emoji] : undefined
      return list?.includes(actor) ? event : null
    }
    case 'message.synced':
    case 'message.files_synced':
      return message.deleted ? null : event
    case 'message.sync_failed': {
      const target = payload.target as string
      const actual = Object.hasOwn(message.undelivered, target) ? message.undelivered[target] : undefined
      return actual === payload.error ? event : null
    }
    case 'task.failed':
      return message.task?.reason === payload.reason ? event : null
    case 'task.blocked':
      return message.task?.blocked?.reason === payload.reason ? event : null
    case 'labels.changed': {
      const rawSet = (payload.set ?? {}) as Record<string, string>
      const keptSet = Object.fromEntries(
        Object.entries(rawSet).filter(
          ([k, v]) => Object.hasOwn(message.labels, k) && message.labels[k] === v,
        ),
      )
      return { ...event, payload: { ...payload, set: keptSet } }
    }
    default:
      return event
  }
}

// ============================================================================
// BoardService
// ============================================================================

/** A post as the board answers it: `mentions` only when its text typed @handles (original serve.ts:543-550). */
export type Posted = { message: MessageView; mentions?: Mentioned[] }

/** What one scheduler tick did: the posts it sent, and the schedules it could not send this time. */
export type ScheduleRun = {
  sent: MessageView[]
  failed: { schedule: string; error: BoardError }[]
  /** C7: selected as due, but under the lock no longer this tick's send (another ticker sent it, it was canceled or moved on). Nothing was written. */
  skipped: string[]
  /** C7: `shouldContinue` said stop (or threw) before a due schedule. */
  stopped: boolean
}

/** C5 discovery data: the board's identity (null on a backend without one) and its schema position. */
export type BoardInfo = {
  readonly boardId: string | null
  readonly instanceId: string | null
  readonly schema: SchemaInfo | null
}

export type BoardServiceOptions = {
  seedDefaultGrants?: boolean
  /**
   * The standing a principal has now, as the server's verifier knows it (its owner and member
   * flags), for a write the board makes later on its behalf: a schedule's send. Null when it is no
   * longer let in, which cancels the schedule as revoked. Without one, the principal as it was when
   * it scheduled stands (original schedules.ts:259 accessNow).
   */
  principalNow?: (principal: CallerPrincipal) => CallerPrincipal | null
  /**
   * Whether the board's verifier names people by their logins (`ada@example.com`): a grant then
   * names a user by one. False by default: the board takes user IDs (original server/backend.ts:147-150).
   */
  logins?: boolean
  /**
   * The clock, in epoch milliseconds: leases, task event times and post times read it after the write
   * lock is taken. Default `Date.now`. A test seam (M2_DESIGN 2.5.1, C22).
   */
  now?: () => number
  /** Options for the task engine (CR-8): a host arms its cross-process wake and safety poll here. */
  tasks?: TaskServiceOptions
  /**
   * How often a waiting getEvents looks at the log head for commits no listener announced (another connection's,
   * when no WakeBridge dispatches them). Default 100 (M1). An integer from 10 to 60_000; anything else is a
   * RangeError from the constructor, thrown before seeding. A host whose WakeBridge runs passes the bridge's
   * safety poll (WakeBridge.serviceOptions()).
   */
  eventsWaitPollMs?: number
}

/**
 * The board's own author for the writes it makes itself (lapse holds and failures, gate completions):
 * `board:system` (HOST-0 C6, system.ts). No request may act as it; see checkCallerActor.
 */
export { SYSTEM_PRINCIPAL_ID } from './system.ts'

type GrantStanding = { caller: Access; own: Access; then?: { caller: Access; own: Access } }
type GrantNamed = { what: string; doing: string }
const THIS_GRANT: GrantNamed = { what: 'this grant', doing: 'this grant' }
const NAMING_ISSUER: GrantNamed = { what: 'naming an oidc issuer', doing: 'naming an oidc issuer' }

/** What a caller that may not list grants is told: the same for a grant out of reach as for one that isn't there. */
const unreachableGrant = (what: string): BoardError =>
  forbidden(`this token can't ${what}: it needs manage wherever that grant reaches`)

const withoutEveryone = (grants: readonly StoredGrant[]): StoredGrant[] =>
  grants.flatMap((grant) => {
    const principals = grant.principals.filter((principal) => principal.kind !== 'everyone')
    return principals.length === 0 ? [] : [{ ...grant, principals }]
  })

const grantView = (g: StoredGrant): GrantView => ({
  id: g.id,
  principals: g.principals,
  can: Object.fromEntries(Object.entries(g.can).map(([k, v]) => [k, v === 'all' ? 'all' : [...v]])),
  capped: false,
  by: g.by,
  at: g.at,
})

type GrantRow = {
  id: string
  seq: number
  principals_json: string
  can_json: string
  by_actor: string | null
  updated_at: string | null
}

/** The grants as stored, to tell whether they changed: each one's ID, sequence, principals and can. */
const grantsKey = (rows: readonly GrantRow[]): string =>
  JSON.stringify(rows.map((r) => [r.id, Number(r.seq), r.principals_json, r.can_json]))

export class BoardService {
  /** The storage it runs on: any StorageBackend, so the M2 engines share it through the interface. */
  readonly store: StorageBackend
  private readonly logins: boolean
  private readonly options: BoardServiceOptions
  private readonly eventsWaitPollMs: number
  /** The grants the last requireAdmitted of this synchronous call judged by (see tx). */
  private admittedBy: { grants: string } | null = null
  /** The grants as loadGrants last read them, as grantsKey writes them. */
  private lastGrantsKey = ''
  private taskService: TaskService | null = null
  private v2TablesPresent = false

  constructor(store: StorageBackend, options: BoardServiceOptions = {}) {
    const eventsWaitPollMs =
      options.eventsWaitPollMs === undefined ? EVENTS_WAIT_POLL_MS : options.eventsWaitPollMs
    if (!Number.isInteger(eventsWaitPollMs) || eventsWaitPollMs < 10 || eventsWaitPollMs > 60_000) {
      throw new RangeError(
        `eventsWaitPollMs must be an integer from 10 to 60000: ${String(options.eventsWaitPollMs)}`,
      )
    }
    this.store = store
    this.options = options
    this.logins = options.logins ?? false
    this.eventsWaitPollMs = eventsWaitPollMs
    // A file a newer build wrote refuses every write (its tasks_schema gate): it can still be read.
    if (!store.writeRefusal?.()) this.seedDefaults(options.seedDefaultGrants ?? true)
  }

  /**
   * The board's identity and schema position (C3, C5). It has no caller: it is discovery data, readable
   * by anyone who can open the file. A transport's capabilities take `schemaVersion` from
   * `boardInfo().schema.version`, never from `PRAGMA user_version`.
   */
  boardInfo(): BoardInfo {
    const identity = this.store.identity?.() ?? null
    return {
      boardId: identity?.boardId ?? null,
      instanceId: identity?.instanceId ?? null,
      schema: this.store.schemaInfo?.() ?? null,
    }
  }

  /** The clock (BoardServiceOptions.now), in epoch milliseconds. */
  private nowMs(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  /** The task engine (M2 slice A), on this service's port. */
  get tasks(): TaskService {
    this.taskService ??= new TaskService(this.taskHost(), this.options.tasks)
    return this.taskService
  }

  /** The narrow port the task engine reaches this service through (M2_DESIGN 2.5.2). */
  private taskHost(): TaskHost {
    return {
      store: this.store,
      now: () => this.nowMs(),
      admit: (caller) => ({ identity: identityOf(caller), access: this.requireAdmitted(caller).caller }),
      loadMessage: (id) => this.loadStoredMessage(id),
      // A task event never changes a root's text, so its save leaves fts_messages alone (decision 15:
      // full-text writes stay off the claim, renew and complete path).
      saveMessageInTx: (msg, logIndex, isNew) => this.saveMessageInTx(msg, logIndex, isNew, isNew),
      dispatchWatchersInTx: (ev, msg) => this.dispatchWatchersInTx(ev, msg),
      actorSeenInTx: (identity) => this.upsertActorInTx(identity.caller),
      view: (msg, _identity, access) => this.toMessageView(msg, this.getActorsMap(), access),
      landedFor: (caller, access, landed, asOf) => {
        const shown = this.landedFor(caller, access, landed)
        if (!shown || asOf === undefined || access.readable(landed.channel)) return shown
        const row = this.store.db
          .prepare('SELECT data FROM board_versions WHERE log_index = ? AND message_id = ?')
          .get(asOf, landed.id) as { data: string } | undefined
        if (!row) return shown
        const at = JSON.parse(row.data) as StoredMessage
        return { ...this.toMessageView(at, this.getActorsMap(), access), text: blindText(at.text, caller.actor.id) }
      },
      checkOwnId: (principalId, id) => ownId(principalId, id),
      // The original's named() (server/tasks.ts:432-435, feed.ts:156-167): the value itself, and the
      // actors it names, by ID when one has it, else by handle. A person's ID is its principal's.
      whoIs: (value) => {
        const ids = new Set<string>([value])
        if (this.store.db.prepare('SELECT 1 FROM board_actors WHERE id = ?').get(value)) return ids
        const rows = this.store.db
          .prepare('SELECT id FROM board_actors WHERE handle_lower = ?')
          .all(value.toLowerCase()) as Array<{ id: string }>
        for (const r of rows) ids.add(r.id)
        return ids
      },
      channelsWhere: (access, perm, scope) => {
        if (!scope && access.everywhere(perm)) return 'all'
        const rows = this.store.db.prepare('SELECT path FROM board_channels ORDER BY path ASC').all() as Array<{
          path: string
        }>
        return rows
          .map((r) => r.path)
          .filter((path) =>
            !scope ? true : scope.subtree ? path === scope.path || path.startsWith(`${scope.path}/`) : path === scope.path,
          )
          .filter((path) => access.can(perm, path))
      },
      systemAuthor: () => systemAuthor(),
      postRoot: (caller, input, taskRoot) => this.postRootAs(caller, input, taskRoot),
      notifyTaskAssignedInTx: (ev, msg, forActor) => this.notifyTaskAssignedInTx(ev, msg, forActor),
      tx: (fn) => this.tx(fn),
    }
  }

  /** postMessageAs with the internal taskRoot option: the root as it is after the call, and whether it was a replay. */
  private postRootAs(caller: CallerContext, input: TaskRootInput, taskRoot: TaskRootOption): PostedRoot {
    let root: StoredMessage | null = null
    let replayed = false
    const posted = this.postMessageAs(caller, input, {
      taskRoot: {
        ...(taskRoot.eventId !== undefined ? { eventId: taskRoot.eventId } : {}),
        prepare: (tx) => taskRoot.prepare(tx),
        emit: (r, postIndex) => {
          root = r
          return taskRoot.emit(r, postIndex)
        },
        replay: (landed) => {
          root = landed
          replayed = true
          taskRoot.replay(landed)
        },
      },
    })
    if (root === null) throw new BoardError(500, 'internal', 'a task root was posted without its option running')
    return { ...posted, root, replayed }
  }

  /**
   * The service's transaction. A call is judged on the grants it read before its transaction began,
   * and another connection may change them while it waits for the database's write lock. So the
   * outermost transaction of a call checks, holding that lock, that the grants are still the ones
   * it was judged by: if they changed, nothing is written and the call is a retryable 503, judged
   * again when it is sent again. The original judges a request by the access it had on arrival
   * (server/writes.ts:422 authorizePost) on one serialized session; with several connections to one
   * file, a write must not land after a revoke it raced.
   */
  private tx<T>(fn: () => T): T {
    const admitted = this.admittedBy
    this.admittedBy = null
    if (admitted === null || this.store.db.isTransaction) return this.store.transaction(fn)
    return this.store.transaction(() => {
      if (grantsKey(this.grantRows()) !== admitted.grants) {
        throw new BoardError(
          503,
          'unavailable',
          'the grants changed while this write waited for the database: send it again',
          { retryAfter: 1 },
        )
      }
      return fn()
    })
  }

  /**
   * Whether the seeds this opener wants are all marked done (C4): one read, no lock. It caches "done"
   * only: a stale "not done" costs one transaction that re-reads both flags under the lock and writes
   * nothing.
   */
  private seedsDone(seedGrants: boolean): boolean {
    const rows = this.store.db
      .prepare("SELECT key FROM board_meta WHERE key IN ('schemas_seeded', 'grants_seeded')")
      .all() as Array<{ key: string }>
    const keys = new Set(rows.map((r) => r.key))
    return keys.has('schemas_seeded') && (!seedGrants || keys.has('grants_seeded'))
  }

  /** Seeds the built-in schemas and the starting grants once per file; a seeded board takes no write lock (C4). */
  private seedDefaults(seedGrants: boolean): void {
    if (this.seedsDone(seedGrants)) return
    this.tx(() => {
      const schemasSeeded = this.store.db
        .prepare("SELECT value FROM board_meta WHERE key = 'schemas_seeded'")
        .get() as { value?: string } | undefined
      if (!schemasSeeded) {
        // The injected clock, read under the lock (rule 3).
        const now = new Date(this.nowMs()).toISOString()
        const stmt = this.store.db.prepare(
          `INSERT OR IGNORE INTO board_schemas (id, name, version, description, schema_json, canonical_json, by_actor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'board', ?)`,
        )
        for (const s of BUILT_IN_SCHEMAS) {
          const id = `${s.name}@${s.version}`
          stmt.run(
            id,
            s.name,
            s.version,
            s.description,
            JSON.stringify(s.schema),
            canonicalJson(s.schema),
            now,
          )
        }
        this.store.db
          .prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('schemas_seeded', '1')")
          .run()
      }

      if (seedGrants) {
        const grantsSeeded = this.store.db
          .prepare("SELECT value FROM board_meta WHERE key = 'grants_seeded'")
          .get() as { value?: string } | undefined
        if (!grantsSeeded) {
          const countRow = this.store.db.prepare('SELECT COUNT(*) AS c FROM board_grants').get() as {
            c: number
          }
          if (countRow.c === 0) {
            const stmt = this.store.db.prepare(
              `INSERT INTO board_grants (id, seq, principals_json, can_json, by_actor, updated_at)
               VALUES (?, ?, ?, ?, NULL, NULL)`,
            )
            for (const g of STARTING_GRANTS) {
              stmt.run(g.id, g.seq, JSON.stringify(g.principals), JSON.stringify(g.can))
            }
          }
          this.store.db
            .prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('grants_seeded', '1')")
            .run()
        }
      }
    })
  }

  private grantRows(): GrantRow[] {
    return this.store.db
      .prepare('SELECT id, seq, principals_json, can_json, by_actor, updated_at FROM board_grants ORDER BY seq ASC')
      .all() as GrantRow[]
  }

  private loadGrants(): StoredGrant[] {
    const rows = this.grantRows()
    this.lastGrantsKey = grantsKey(rows)
    return rows.map((r) => ({
      id: r.id,
      seq: Number(r.seq),
      principals: JSON.parse(r.principals_json) as PrincipalView[],
      can: JSON.parse(r.can_json) as WrittenCan,
      by: r.by_actor,
      at: r.updated_at,
    }))
  }

  private hasV2Tables(): boolean {
    if (this.v2TablesPresent) return true
    const row = this.store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_channel_meta' LIMIT 1")
      .get()
    if (row) this.v2TablesPresent = true
    return this.v2TablesPresent
  }

  /**
   * Wraps grant `Access` with `board_channel_meta.is_private` + `board_channel_members` enforcement.
   * Human owners, deployments, and non-agent callers with `manage` on the channel retain audit access;
   * agent callers (`actor.kind === 'agent'`, `owner !== true`) MUST match `board_channel_members`
   * even under local seeded `g1` (`all-users -> *: all`).
   */
  private withPrivateAcl(caller: CallerContext, baseAccess: Access): Access {
    if (!this.hasV2Tables()) return baseAccess
    if (caller.principal.owner === true || caller.principal.kind === 'deployment') return baseAccess
    if (caller.actor.kind !== 'agent' && baseAccess.everywhere('manage')) return baseAccess
    const privRows = this.store.db
      .prepare('SELECT path FROM board_channel_meta WHERE is_private = 1')
      .all() as Array<{ path: string }>
    if (privRows.length === 0) return baseAccess
    const keys = recipientKeysOf(caller)
    const memberRows = this.store.db
      .prepare('SELECT channel FROM board_channel_members WHERE actor_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(keys)) as Array<{ channel: string }>
    const memberSet = new Set(memberRows.map((r) => r.channel))
    const denied = new Set<string>()
    for (const { path } of privRows) {
      if (memberSet.has(path)) continue
      if (caller.actor.kind !== 'agent' && baseAccess.can('manage', path)) continue
      denied.add(path)
    }
    if (denied.size === 0) return baseAccess
    return Object.freeze({
      can: (permission: Permission, channel: string) => !denied.has(channel) && baseAccess.can(permission, channel),
      readable: (channel: string) => !denied.has(channel) && baseAccess.readable(channel),
      readsAll: false,
      everywhere: (_permission: Permission) => false,
      anywhere: (permission: Permission) => baseAccess.anywhere(permission),
      at: (permission: Permission, pattern: ChannelPattern) => baseAccess.at(permission, pattern),
      narrow: (scope: CanSpec | Access) => this.withPrivateAcl(caller, baseAccess.narrow(scope)),
      summary: () => baseAccess.summary(),
    })
  }

  resolveAccess(caller: CallerContext): { caller: Access; own: Access; admits: boolean } {
    const grants = this.loadGrants()
    const resolved = grantAccessForCaller(caller.principal, grants, caller.canHeader)
    if (!resolved.admits) return resolved
    return { ...resolved, caller: this.withPrivateAcl(caller, resolved.caller) }
  }

  private requireAdmitted(caller: CallerContext): { caller: Access; raw: Access; own: Access; admits: boolean } {
    checkCallerActor(caller)
    const grants = this.loadGrants()
    const resolved = grantAccessForCaller(caller.principal, grants, caller.canHeader)
    if (!resolved.admits) throw this.notGranted(caller.principal)
    // What this call's write is checked against when its transaction begins (tx). Only for this
    // synchronous call: a later one, or this one past an await, is judged again.
    const admitted = { grants: this.lastGrantsKey }
    this.admittedBy = admitted
    queueMicrotask(() => {
      if (this.admittedBy === admitted) this.admittedBy = null
    })
    return {
      caller: this.withPrivateAcl(caller, resolved.caller),
      raw: resolved.caller,
      own: resolved.own,
      admits: true,
    }
  }

  /**
   * Why a principal no grant lets in can't use the board, as the original local board answers it
   * (server/auth.ts:452-505 notGranted/byGrants): 403 `forbidden` with the grant that would, and 401
   * for an oidc issuer no grant names.
   */
  private notGranted(principal: CallerPrincipal): BoardError {
    const notLetIn = (who: string, grant: string): BoardError =>
      forbidden(`this token can't use this board: no grant lets in ${who}`, 'forbidden', {
        hint: `Grant it: vb grants create ${grant}`,
      })
    switch (principal.kind) {
      case 'oidc': {
        const issuer = principal.issuer ?? ''
        if (!grantIssuers(this.loadGrants()).includes(issuer)) {
          return unauthorized(`untrusted issuer: ${issuer}`)
        }
        return forbidden("this token can't use this board: no grant lets in its claims")
      }
      case 'github': {
        const repository = principal.repository ?? ''
        return notLetIn(repository || 'its repository', `--github ${repository || '<OWNER/REPO>'}`)
      }
      case 'project': {
        const project = principal.projectId || '<PROJECT_ID>'
        const environment = principal.environment ?? ''
        return notLetIn(
          `project ${project} in ${environment || 'no environment'}`,
          `--project ${project} --environment ${environment || '<ENVIRONMENT>'}`,
        )
      }
      case 'app': {
        const app = principal.clientId || '<CLIENT_ID>'
        return notLetIn(`app ${app}`, `--app ${app}`)
      }
      case 'user': {
        const user = principal.userId ?? principal.handle
        return notLetIn(user, `--user ${user}`)
      }
      default:
        return forbidden("this token can't use this board")
    }
  }

  private getActorsMap(): Map<string, StoredActor> {
    const rows = this.store.db.prepare('SELECT data FROM board_actors').all() as Array<{ data: string }>
    const map = new Map<string, StoredActor>()
    for (const r of rows) {
      const actor = JSON.parse(r.data) as StoredActor
      map.set(actor.id, actor)
    }
    return map
  }

  private upsertActorInTx(caller: CallerContext): void {
    const a = caller.actor
    const existing = this.store.db
      .prepare('SELECT data FROM board_actors WHERE id = ?')
      .get(a.id) as { data: string } | undefined
    // A platform user the board's own code imports is not the host's: only its own actors are.
    const host =
      (caller.principal.kind === 'deployment' && a.kind !== 'external') ||
      (existing ? (JSON.parse(existing.data) as StoredActor).host === true : false)
    const record: StoredActor = {
      id: a.id,
      kind: a.kind,
      handle: a.handle,
      name: a.name,
      avatar: a.avatar,
      ...(a.via ? { via: a.via } : {}),
      ...(a.platform ? { platform: a.platform } : {}),
      ...(host ? { host: true as const } : {}),
      ...(a.verified ? { verified: true as const } : {}),
    }
    const jsonStr = JSON.stringify(record)
    if (existing && existing.data === jsonStr) return
    this.store.db
      .prepare(
        `INSERT INTO board_actors (id, kind, handle, handle_lower, name, avatar, via_json, platform, host, verified, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, handle = excluded.handle, handle_lower = excluded.handle_lower,
           name = excluded.name, avatar = excluded.avatar, via_json = excluded.via_json,
           platform = excluded.platform, host = excluded.host, verified = excluded.verified, data = excluded.data`,
      )
      .run(
        record.id,
        record.kind,
        record.handle,
        record.handle.toLowerCase(),
        record.name,
        record.avatar,
        record.via ? JSON.stringify(record.via) : null,
        record.platform ?? null,
        record.host ? 1 : 0,
        record.verified ? 1 : 0,
        jsonStr,
      )
    this.store.appendEvent({
      type: 'actor.seen',
      createdAt: new Date(this.nowMs()).toISOString(),
      payload: {
        actor: record.id,
        kind: record.kind,
        handle: record.handle,
        name: record.name,
        avatar: record.avatar,
        ...(record.via ? { via: record.via } : {}),
        ...(record.platform ? { platform: record.platform } : {}),
        ...(record.host ? { host: true } : {}),
        ...(record.verified ? { verified: true } : {}),
      },
    })
  }

  private actorViewFor(actorId: string, actors: Map<string, StoredActor>): ActorView | null {
    const a = actors.get(actorId)
    if (!a) return null
    // An agent recorded before records said whom it acts through, `<person>/<profile>`, acts
    // through the person its handle names (original feed.ts:48-52 viewOfRecord).
    const slash = a.handle.indexOf('/')
    const via: Via | undefined = a.via
      ? { ...a.via }
      : a.id.includes('+') && slash > 0
        ? { name: a.handle.slice(0, slash), environment: null }
        : undefined
    return {
      kind: a.kind,
      handle: a.handle,
      name: a.name,
      avatar: a.avatar,
      ...(via ? { via } : {}),
      ...(a.platform ? { platform: a.platform } : {}),
      ...(a.verified ? { verified: true as const } : {}),
    }
  }

  private linkViewFor(link: LinkView, access: Access): LinkView {
    if (link.message === null || link.message === undefined) return link
    const linkedRow = this.store.db
      .prepare('SELECT channel FROM board_messages WHERE id = ?')
      .get(Number(link.message)) as { channel?: string } | undefined
    const ch = linkedRow?.channel
    if (access.readsAll || (ch !== undefined && access.readable(ch))) return link
    return { url: link.url, message: null, snapshot: null, unavailable: 'not_readable' }
  }

  private toMessageView(
    msg: StoredMessage,
    actors: Map<string, StoredActor>,
    access: Access,
  ): MessageView {
    const readableLinks: LinkView[] = msg.links.map((link) => this.linkViewFor(link, access))
    return {
      id: String(msg.id),
      channel: msg.channel,
      text: msg.text,
      re: msg.re === null ? null : String(msg.re),
      replyTo: msg.replyTo === null ? null : String(msg.replyTo),
      thread: msg.thread,
      labels: { ...msg.labels },
      reactions: Object.fromEntries(
        Object.entries(msg.reactions).map(([k, v]) => [k, [...v]]),
      ),
      by: { ...msg.by },
      noSync: msg.noSync,
      origin: msg.origin,
      from: msg.from,
      createdAt: msg.createdAt,
      editedAt: msg.editedAt,
      deleted: msg.deleted,
      undelivered: { ...msg.undelivered },
      attachments: msg.attachments,
      links: readableLinks,
      ...(msg.quote && access.readable(msg.quote.channel) ? { quote: msg.quote } : {}),
      ...(msg.schedule ? { schedule: { id: `s${msg.schedule.id}`, n: msg.schedule.n } } : {}),
      ...(msg.task ? { task: msg.task } : {}),
      ...(msg.blind ? { blind: true as const } : {}),
      version: msg.version,
      revision: msg.revision,
      author: this.actorViewFor(msg.by.actor, actors),
      blocks: msg.from === null && !msg.platformText ? blocksIn(msg.text) : [],
    }
  }

  private checkBlocks(text: string): void {
    if (!text.includes('json#')) return
    for (const found of findBlocks(text)) {
      if (found.problem !== undefined || !found.name || found.version === undefined || !found.data) {
        throw badRequest(found.problem ?? `invalid block ${found.id}`, 'invalid_block')
      }
      const schemaId = `${found.name}@${found.version}`
      const row = this.store.db
        .prepare('SELECT schema_json FROM board_schemas WHERE id = ?')
        .get(schemaId) as { schema_json?: string } | undefined
      if (!row?.schema_json) {
        throw badRequest(`the ${found.id} block names a schema this board doesn't have`, 'schema_not_found')
      }
      const schema = JSON.parse(row.schema_json) as Record<string, unknown>
      const problem = checkSchemaValue(schema, found.data)
      if (problem !== null) {
        throw badRequest(`the ${found.id} block doesn't match its schema: ${problem}`, 'invalid_block')
      }
    }
  }

  private ensureChannelInTx(path: string, createdAt: string): void {
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO board_channels (path, last_index, messages, threads, created_at, metadata_json)
         VALUES (?, 0, 0, 0, ?, '{}')`,
      )
      .run(path, createdAt)
  }

  private syncTermsInTx(msg: StoredMessage): void {
    this.store.db.prepare('DELETE FROM board_terms WHERE message_id = ?').run(msg.id)
    if (msg.deleted) return
    const stmt = this.store.db.prepare(
      'INSERT OR IGNORE INTO board_terms (message_id, term, value) VALUES (?, ?, ?)',
    )
    for (const [key, value] of Object.entries(msg.labels)) {
      stmt.run(msg.id, key, toStorable(value))
    }
    for (const term of mentionTerms(msg.text)) {
      stmt.run(msg.id, '@', toStorable(term))
    }
    for (const att of msg.attachments) {
      stmt.run(msg.id, '^', toStorable(att.id))
    }
  }

  private syncFtsMessageInTx(msg: StoredMessage, isNew = false): void {
    // Key fts_messages by SQLite rowid (= board_messages.id) so deletes/updates are O(log N)
    // B-tree lookups (INDEX 0:=) rather than full scans of the UNINDEXED message_id column.
    // A message new in this transaction skips DELETE; INSERT OR REPLACE handles insertion cleanly.
    if (!isNew) this.store.db.prepare('DELETE FROM fts_messages WHERE rowid = ?').run(msg.id)
    if (msg.deleted || msg.text.trim() === '') return
    this.store.db
      .prepare('INSERT OR REPLACE INTO fts_messages (rowid, message_id, channel, thread, body) VALUES (?, ?, ?, ?, ?)')
      .run(msg.id, String(msg.id), msg.channel, msg.thread, msg.text)
  }

  private saveMessageInTx(msg: StoredMessage, logIndex: number, isNew: boolean, syncFts = true): void {
    const json = JSON.stringify(msg)
    const createdMs = Date.parse(msg.createdAt)
    const editedMs = msg.editedAt ? Date.parse(msg.editedAt) : null
    if (isNew) {
      this.store.db
        .prepare(
          `INSERT INTO board_messages (
            id, event_id, channel, re, reply_to, thread, by_actor, by_principal, by_profile,
            from_key, no_sync, text, text_lower, deleted, created_at, edited_at, replies, at,
            version, revision, data
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          msg.id,
          msg.eventId,
          msg.channel,
          msg.re,
          msg.replyTo,
          msg.thread,
          msg.by.actor,
          msg.by.principal,
          msg.by.profile,
          msg.from,
          msg.noSync ? 1 : 0,
          msg.text,
          toStorable(msg.text.toLowerCase()),
          msg.deleted ? 1 : 0,
          createdMs,
          editedMs,
          msg.re === null ? msg.id : null,
          msg.version,
          msg.revision,
          json,
        )
    } else {
      this.store.db
        .prepare(
          `UPDATE board_messages SET
            text = ?, text_lower = ?, deleted = ?, edited_at = ?, version = ?, revision = ?, data = ?
           WHERE id = ?`,
        )
        .run(
          msg.text,
          toStorable(msg.text.toLowerCase()),
          msg.deleted ? 1 : 0,
          editedMs,
          msg.version,
          msg.revision,
          json,
          msg.id,
        )
    }

    this.store.db
      .prepare('INSERT OR REPLACE INTO board_versions (log_index, message_id, data) VALUES (?, ?, ?)')
      .run(logIndex, msg.id, json)
    this.syncTermsInTx(msg)
    if (syncFts) this.syncFtsMessageInTx(msg, isNew)
  }

  private loadStoredMessage(id: number): StoredMessage | null {
    const row = this.store.db.prepare('SELECT data FROM board_messages WHERE id = ?').get(id) as
      | { data: string }
      | undefined
    return row ? (JSON.parse(row.data) as StoredMessage) : null
  }

  private messageNotFoundError(ref: string | number): () => BoardError {
    return () => notFound(`message not found: #${ref}`, 'message_not_found')
  }

  /**
   * Whether `principal` may have a file: one it uploaded, or one a live message it can read
   * carries. A deleted message drops its files, so it no longer counts (original a2.ts:331-336).
   */
  private attachmentReadable(access: Access, principalId: string, id: string, uploadedBy: string | null): boolean {
    if (access.readsAll || (uploadedBy !== null && uploadedBy === principalId)) return true
    const carriers = this.store.db
      .prepare(
        `SELECT DISTINCT m.channel AS channel FROM board_terms t JOIN board_messages m ON m.id = t.message_id
         WHERE t.term = '^' AND t.value = ? AND m.deleted = 0`,
      )
      .all(toStorable(id)) as Array<{ channel: string }>
    return carriers.some((row) => access.readable(row.channel))
  }

  /**
   * Files a write carries, as the board stored them: each one the caller may have, or 404 as if
   * it didn't exist, once each (original a2.ts:373-380 attachmentsFor).
   */
  private attachmentsFor(access: Access, principalId: string, ids: readonly string[] | undefined): Attachment[] {
    return [...new Set(ids ?? [])].map((id) => {
      const row = this.store.db
        .prepare('SELECT id, name, type, size, uploaded_by FROM board_attachments WHERE id = ?')
        .get(id) as { id: string; name: string; type: string; size: number; uploaded_by: string | null } | undefined
      if (!row || !this.attachmentReadable(access, principalId, row.id, row.uploaded_by)) {
        throw attachmentNotFound(id)
      }
      return { id: row.id, name: row.name, type: row.type, size: Number(row.size) }
    })
  }

  // ==========================================================================
  // F1: Channels, Hierarchical Metadata, Private/DM ACLs & Channel Tree
  // ==========================================================================

  private loadChannelMeta(path: string): {
    path: string
    category: string | null
    parent: string | null
    topic: string | null
    kind: ChannelKind
    archived: number
    sort_order: number
    repo: string | null
    session_id: string | null
    is_private: number
  } | undefined {
    if (!this.hasV2Tables()) return undefined
    return this.store.db
      .prepare(
        `SELECT path, category, parent, topic, kind, archived, sort_order, repo, session_id, is_private
         FROM board_channel_meta WHERE path = ?`,
      )
      .get(path) as
      | {
          path: string
          category: string | null
          parent: string | null
          topic: string | null
          kind: ChannelKind
          archived: number
          sort_order: number
          repo: string | null
          session_id: string | null
          is_private: number
        }
      | undefined
  }

  private buildChannelView(
    base: { path: string; last_index: number; messages: number; threads: number },
    meta?: {
      category: string | null
      parent: string | null
      topic: string | null
      kind: ChannelKind
      archived: number
      sort_order: number
      repo: string | null
      session_id: string | null
      is_private: number
    },
    extra?: { includeMeta?: boolean; pinnedCount?: number; unreadCount?: number },
  ): ChannelView {
    const view: ChannelView = {
      path: base.path,
      lastIndex: Number(base.last_index),
      messages: Number(base.messages),
      threads: Number(base.threads),
    }
    if (meta || extra?.includeMeta) {
      view.category = meta?.category ?? null
      view.parent = meta?.parent ?? null
      view.topic = meta?.topic ?? null
      view.kind = meta?.kind ?? inferChannelKind(base.path)
      view.archived = meta ? meta.archived === 1 : false
      view.sortOrder = meta ? Number(meta.sort_order) : 0
      view.repo = meta?.repo ?? null
      view.sessionId = meta?.session_id ?? null
      view.private = meta ? meta.is_private === 1 : false
      if (extra?.pinnedCount !== undefined) view.pinnedCount = extra.pinnedCount
      if (extra?.unreadCount !== undefined) view.unreadCount = extra.unreadCount
    }
    return view
  }

  private unreadCountsByChannel(actorId: string): Map<string, number> {
    const counts = new Map<string, number>()
    if (!this.hasV2Tables()) return counts
    const rows = this.store.db
      .prepare(
        `SELECT m.channel, COUNT(*) AS unread
         FROM board_messages m
         LEFT JOIN board_read_cursors rc ON rc.actor_id = ? AND rc.channel = m.channel
         WHERE m.deleted = 0 AND m.id > COALESCE(rc.last_read_index, 0)
         GROUP BY m.channel`,
      )
      .all(actorId) as Array<{ channel: string; unread: number }>
    for (const r of rows) counts.set(r.channel, Number(r.unread))
    return counts
  }

  private pinCountsByChannel(): Map<string, number> {
    const counts = new Map<string, number>()
    if (!this.hasV2Tables()) return counts
    const rows = this.store.db
      .prepare('SELECT channel, COUNT(*) AS c FROM board_pins GROUP BY channel')
      .all() as Array<{ channel: string; c: number }>
    for (const r of rows) counts.set(r.channel, Number(r.c))
    return counts
  }

  private isChannelMemberOwner(channel: string, caller: CallerContext): boolean {
    if (!this.hasV2Tables()) return false
    const keys = recipientKeysOf(caller)
    const row = this.store.db
      .prepare(
        "SELECT 1 FROM board_channel_members WHERE channel = ? AND role = 'owner' AND actor_id IN (SELECT value FROM json_each(?)) LIMIT 1",
      )
      .get(channel, JSON.stringify(keys))
    return row !== undefined
  }

  private addChannelMembersInTx(channel: string, members: readonly string[], addedBy: string, now: string): void {
    const stmt = this.store.db.prepare(
      `INSERT OR IGNORE INTO board_channel_members (channel, actor_id, role, added_by, added_at)
       VALUES (?, ?, 'member', ?, ?)`,
    )
    for (const raw of members) {
      const resolved = resolveRecipient(this.store.db, raw)
      stmt.run(channel, resolved, addedBy, now)
      if (!raw.startsWith('handle:') && resolved !== `handle:${raw.toLowerCase()}` && !raw.includes(':')) {
        stmt.run(channel, `handle:${raw.toLowerCase()}`, addedBy, now)
      }
    }
  }

  private removeChannelMembersInTx(channel: string, members: readonly string[]): void {
    const del = this.store.db.prepare('DELETE FROM board_channel_members WHERE channel = ? AND actor_id = ?')
    for (const raw of members) {
      for (const alias of recipientAliases(this.store.db, raw)) {
        del.run(channel, alias)
      }
    }
  }

  listChannels(caller: CallerContext, rawQuery: unknown = {}): ChannelsPage {
    const { caller: access } = this.requireAdmitted(caller)
    const query = ChannelsQuerySchema.parse(rawQuery)
    const limit = query.limit ?? CHANNELS_LIMIT_DEFAULT
    const archivedMode =
      query.archived === undefined || query.archived === false || query.archived === 'false'
        ? 'active'
        : query.archived === true || query.archived === 'true'
          ? 'archived'
          : 'all'
    const hasV2 = this.hasV2Tables()
    const rows = hasV2
      ? (this.store.db
          .prepare(
            `SELECT c.path, c.last_index, c.messages, c.threads,
                    m.path AS has_meta, m.category, m.parent, m.topic, m.kind,
                    m.archived, m.sort_order, m.repo, m.session_id, m.is_private
             FROM board_channels c
             LEFT JOIN board_channel_meta m ON m.path = c.path
             ORDER BY c.path ASC`,
          )
          .all() as Array<{
          path: string
          last_index: number
          messages: number
          threads: number
          has_meta: string | null
          category: string | null
          parent: string | null
          topic: string | null
          kind: ChannelKind | null
          archived: number | null
          sort_order: number | null
          repo: string | null
          session_id: string | null
          is_private: number | null
        }>)
      : (this.store.db
          .prepare('SELECT path, last_index, messages, threads FROM board_channels ORDER BY path ASC')
          .all() as Array<{ path: string; last_index: number; messages: number; threads: number }>).map((r) => ({
          ...r,
          has_meta: null,
          category: null,
          parent: null,
          topic: null,
          kind: null,
          archived: null,
          sort_order: null,
          repo: null,
          session_id: null,
          is_private: null,
        }))

    const unreadMap = query.includeMeta ? this.unreadCountsByChannel(caller.actor.id) : null
    const pinMap = query.includeMeta ? this.pinCountsByChannel() : null

    const filtered: ChannelView[] = []
    for (const r of rows) {
      if (!access.readable(r.path)) continue
      if (query.prefix !== undefined && !r.path.startsWith(query.prefix)) continue
      if (query.after !== undefined && r.path <= query.after) continue
      const isArchived = r.archived === 1
      if (archivedMode === 'active' && isArchived) continue
      if (archivedMode === 'archived' && !isArchived) continue
      const effectiveKind = r.kind ?? inferChannelKind(r.path)
      if (query.kind !== undefined && effectiveKind !== query.kind) continue
      if (query.repo !== undefined && r.repo !== query.repo) continue
      if (query.sessionId !== undefined && r.session_id !== query.sessionId) continue
      const meta =
        r.has_meta !== null
          ? {
              category: r.category,
              parent: r.parent,
              topic: r.topic,
              kind: effectiveKind,
              archived: r.archived ?? 0,
              sort_order: r.sort_order ?? 0,
              repo: r.repo,
              session_id: r.session_id,
              is_private: r.is_private ?? 0,
            }
          : undefined
      filtered.push(
        this.buildChannelView(r, meta, {
          includeMeta: query.includeMeta === true,
          ...(pinMap ? { pinnedCount: pinMap.get(r.path) ?? 0 } : {}),
          ...(unreadMap ? { unreadCount: unreadMap.get(r.path) ?? 0 } : {}),
        }),
      )
    }

    const page = filtered.slice(0, limit)
    const hasMore = filtered.length > limit
    const last = page.at(-1)
    return {
      channels: page,
      cursor: String(this.store.getHeadIndex()),
      next: hasMore && last ? last.path : null,
    }
  }

  getChannelTree(caller: CallerContext, rawQuery: unknown = {}): ChannelTreePage {
    const { caller: access } = this.requireAdmitted(caller)
    const query = ChannelTreeQuerySchema.parse(rawQuery)
    const archivedMode =
      query.archived === undefined || query.archived === false || query.archived === 'false'
        ? 'active'
        : query.archived === true || query.archived === 'true'
          ? 'archived'
          : 'all'
    const hasV2 = this.hasV2Tables()
    const rows = hasV2
      ? (this.store.db
          .prepare(
            `SELECT c.path, c.last_index, c.messages, c.threads,
                    m.path AS has_meta, m.category, m.parent, m.topic, m.kind,
                    m.archived, m.sort_order, m.repo, m.session_id, m.is_private
             FROM board_channels c
             LEFT JOIN board_channel_meta m ON m.path = c.path
             ORDER BY c.path ASC`,
          )
          .all() as Array<{
          path: string
          last_index: number
          messages: number
          threads: number
          has_meta: string | null
          category: string | null
          parent: string | null
          topic: string | null
          kind: ChannelKind | null
          archived: number | null
          sort_order: number | null
          repo: string | null
          session_id: string | null
          is_private: number | null
        }>)
      : []

    const unreadMap = query.includeUnread !== false ? this.unreadCountsByChannel(caller.actor.id) : null
    const pinMap = this.pinCountsByChannel()
    const matched: ChannelView[] = []
    for (const r of rows) {
      if (!access.readable(r.path)) continue
      if (query.prefix !== undefined && !r.path.startsWith(query.prefix)) continue
      const isArchived = r.archived === 1
      if (archivedMode === 'active' && isArchived) continue
      if (archivedMode === 'archived' && !isArchived) continue
      const effectiveKind = r.kind ?? inferChannelKind(r.path)
      if (query.kind !== undefined && effectiveKind !== query.kind) continue
      const meta =
        r.has_meta !== null
          ? {
              category: r.category,
              parent: r.parent,
              topic: r.topic,
              kind: effectiveKind,
              archived: r.archived ?? 0,
              sort_order: r.sort_order ?? 0,
              repo: r.repo,
              session_id: r.session_id,
              is_private: r.is_private ?? 0,
            }
          : undefined
      matched.push(
        this.buildChannelView(r, meta, {
          includeMeta: true,
          pinnedCount: pinMap.get(r.path) ?? 0,
          unreadCount: unreadMap ? (unreadMap.get(r.path) ?? 0) : 0,
        }),
      )
    }

    return {
      tree: buildChannelTree(matched),
      cursor: String(this.store.getHeadIndex()),
    }
  }

  createChannel(
    caller: CallerContext,
    rawInput: unknown,
  ): { channel: ChannelView; created: boolean } {
    const { caller: access } = this.requireAdmitted(caller)
    const input = CreateChannelBodySchema.parse(rawInput)
    authorizeChannel(access, 'read', input.path)
    authorizeChannel(access, 'post', input.path)

    const hasMetaInput =
      input.category !== undefined ||
      input.parent !== undefined ||
      input.topic !== undefined ||
      input.kind !== undefined ||
      input.archived !== undefined ||
      input.sortOrder !== undefined ||
      input.repo !== undefined ||
      input.sessionId !== undefined ||
      input.private !== undefined ||
      input.members !== undefined

    return this.tx(() => {
      const existing = this.store.db
        .prepare('SELECT path, last_index, messages, threads FROM board_channels WHERE path = ?')
        .get(input.path) as
        | { path: string; last_index: number; messages: number; threads: number }
        | undefined
      if (existing) {
        const meta = this.loadChannelMeta(existing.path)
        return {
          channel: this.buildChannelView(existing, meta),
          created: false,
        }
      }

      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      this.ensureChannelInTx(input.path, now)

      let createdMeta:
        | {
            category: string | null
            parent: string | null
            topic: string | null
            kind: ChannelKind
            archived: number
            sort_order: number
            repo: string | null
            session_id: string | null
            is_private: number
          }
        | undefined
      if (hasMetaInput && this.hasV2Tables()) {
        createdMeta = {
          category: input.category ?? null,
          parent: input.parent ?? null,
          topic: input.topic ?? null,
          kind: input.kind ?? inferChannelKind(input.path),
          archived: input.archived ? 1 : 0,
          sort_order: input.sortOrder ?? 0,
          repo: input.repo ?? null,
          session_id: input.sessionId ?? null,
          is_private: input.private ? 1 : 0,
        }
        this.store.db
          .prepare(
            `INSERT INTO board_channel_meta (
              path, category, parent, topic, kind, archived, sort_order, repo, session_id, is_private, updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.path,
            createdMeta.category,
            createdMeta.parent,
            createdMeta.topic,
            createdMeta.kind,
            createdMeta.archived,
            createdMeta.sort_order,
            createdMeta.repo,
            createdMeta.session_id,
            createdMeta.is_private,
            now,
            caller.actor.id,
          )
        this.store.db
          .prepare('UPDATE board_channels SET metadata_json = ? WHERE path = ?')
          .run(
            JSON.stringify({
              category: createdMeta.category,
              parent: createdMeta.parent,
              topic: createdMeta.topic,
              kind: createdMeta.kind,
              archived: createdMeta.archived === 1,
              sortOrder: createdMeta.sort_order,
              repo: createdMeta.repo,
              sessionId: createdMeta.session_id,
              private: createdMeta.is_private === 1,
            }),
            input.path,
          )
        if (input.private === true || (input.members?.length ?? 0) > 0) {
          this.store.db
            .prepare(
              `INSERT OR IGNORE INTO board_channel_members (channel, actor_id, role, added_by, added_at)
               VALUES (?, ?, 'owner', ?, ?)`,
            )
            .run(input.path, caller.actor.id, caller.actor.id, now)
          if (input.members?.length) {
            this.addChannelMembersInTx(input.path, input.members, caller.actor.id, now)
          }
        }
      }

      this.store.appendEvent({
        type: 'channel.created',
        channel: input.path,
        payload: {
          channel: input.path,
          by: {
            actor: caller.actor.id,
            principal: caller.principal.id,
            profile: caller.profile,
          },
        },
        createdAt: now,
      })
      return {
        channel: this.buildChannelView(
          { path: input.path, last_index: 0, messages: 0, threads: 0 },
          createdMeta,
        ),
        created: true,
      }
    })
  }

  updateChannel(caller: CallerContext, rawInput: unknown): { channel: ChannelView } {
    const { caller: access } = this.requireAdmitted(caller)
    const input = UpdateChannelBodySchema.parse(rawInput)
    authorizeChannel(access, 'read', input.path)
    authorizeChannel(access, 'post', input.path)

    return this.tx(() => {
      const existing = this.store.db
        .prepare('SELECT path, last_index, messages, threads, metadata_json FROM board_channels WHERE path = ?')
        .get(input.path) as
        | { path: string; last_index: number; messages: number; threads: number; metadata_json: string }
        | undefined
      if (!existing) throw notFound(`channel not found: ${input.path}`, 'channel_not_found')

      const privileged =
        input.private !== undefined || input.addMembers !== undefined || input.removeMembers !== undefined
      if (privileged) {
        const mayManage =
          caller.principal.owner === true ||
          caller.principal.kind === 'deployment' ||
          access.can('manage', input.path) ||
          this.isChannelMemberOwner(input.path, caller)
        if (!mayManage) {
          throw forbidden(`this token can't change privacy or members of ${input.path}`)
        }
      }

      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      const prev = this.loadChannelMeta(input.path)
      const next = {
        category: input.category !== undefined ? input.category : (prev?.category ?? null),
        parent: input.parent !== undefined ? input.parent : (prev?.parent ?? null),
        topic: input.topic !== undefined ? input.topic : (prev?.topic ?? null),
        kind: input.kind !== undefined ? input.kind : (prev?.kind ?? inferChannelKind(input.path)),
        archived: input.archived !== undefined ? (input.archived ? 1 : 0) : (prev?.archived ?? 0),
        sort_order: input.sortOrder !== undefined ? input.sortOrder : (prev?.sort_order ?? 0),
        repo: input.repo !== undefined ? input.repo : (prev?.repo ?? null),
        session_id: input.sessionId !== undefined ? input.sessionId : (prev?.session_id ?? null),
        is_private: input.private !== undefined ? (input.private ? 1 : 0) : (prev?.is_private ?? 0),
      }
      this.store.db
        .prepare(
          `INSERT INTO board_channel_meta (
            path, category, parent, topic, kind, archived, sort_order, repo, session_id, is_private, updated_at, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            category = excluded.category,
            parent = excluded.parent,
            topic = excluded.topic,
            kind = excluded.kind,
            archived = excluded.archived,
            sort_order = excluded.sort_order,
            repo = excluded.repo,
            session_id = excluded.session_id,
            is_private = excluded.is_private,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`,
        )
        .run(
          input.path,
          next.category,
          next.parent,
          next.topic,
          next.kind,
          next.archived,
          next.sort_order,
          next.repo,
          next.session_id,
          next.is_private,
          now,
          caller.actor.id,
        )

      if (next.is_private === 1) {
        this.store.db
          .prepare(
            `INSERT OR IGNORE INTO board_channel_members (channel, actor_id, role, added_by, added_at)
             VALUES (?, ?, 'owner', ?, ?)`,
          )
          .run(input.path, caller.actor.id, caller.actor.id, now)
      }
      if (input.addMembers?.length) {
        this.addChannelMembersInTx(input.path, input.addMembers, caller.actor.id, now)
      }
      if (input.removeMembers?.length) {
        this.removeChannelMembersInTx(input.path, input.removeMembers)
      }

      let prevJson: Record<string, unknown> = {}
      try {
        prevJson = JSON.parse(existing.metadata_json) as Record<string, unknown>
      } catch {
        prevJson = {}
      }
      this.store.db
        .prepare('UPDATE board_channels SET metadata_json = ? WHERE path = ?')
        .run(
          JSON.stringify({
            ...prevJson,
            category: next.category,
            parent: next.parent,
            topic: next.topic,
            kind: next.kind,
            archived: next.archived === 1,
            sortOrder: next.sort_order,
            repo: next.repo,
            sessionId: next.session_id,
            private: next.is_private === 1,
          }),
          input.path,
        )

      this.store.appendEvent({
        type: 'channel.updated',
        channel: input.path,
        payload: {
          channel: input.path,
          by: {
            actor: caller.actor.id,
            principal: caller.principal.id,
            profile: caller.profile,
          },
        },
        createdAt: now,
      })

      return {
        channel: this.buildChannelView(existing, next),
      }
    })
  }

  ensureDm(
    caller: CallerContext,
    rawInput: unknown,
  ): { channel: ChannelView; created: boolean; peer: string } {
    const { raw: baseAccess } = this.requireAdmitted(caller)
    const input = EnsureDmBodySchema.parse(rawInput)
    const peerActor = resolveActorRow(this.store.db, input.peer)
    const callerSlug = dmSlug(caller.actor.handle)
    const peerSlug = peerActor ? dmSlug(peerActor.handle) : dmSlug(input.peer)
    const path = canonicalDmChannel(callerSlug, peerSlug)
    authorizeChannel(baseAccess, 'read', path)
    authorizeChannel(baseAccess, 'post', path)

    return this.tx(() => {
      const existing = this.store.db
        .prepare('SELECT path, last_index, messages, threads FROM board_channels WHERE path = ?')
        .get(path) as { path: string; last_index: number; messages: number; threads: number } | undefined

      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      const created = !existing
      if (created) this.ensureChannelInTx(path, now)

      const prevMeta = this.loadChannelMeta(path)
      const topic = input.topic !== undefined ? input.topic : (prevMeta?.topic ?? null)
      const meta = {
        category: 'dm',
        parent: 'dm',
        topic,
        kind: 'dm' as const,
        archived: prevMeta?.archived ?? 0,
        sort_order: prevMeta?.sort_order ?? 0,
        repo: null,
        session_id: null,
        is_private: 1,
      }
      this.store.db
        .prepare(
          `INSERT INTO board_channel_meta (
            path, category, parent, topic, kind, archived, sort_order, repo, session_id, is_private, updated_at, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            category = excluded.category,
            parent = excluded.parent,
            topic = excluded.topic,
            kind = excluded.kind,
            is_private = 1,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`,
        )
        .run(
          path,
          meta.category,
          meta.parent,
          meta.topic,
          meta.kind,
          meta.archived,
          meta.sort_order,
          meta.repo,
          meta.session_id,
          meta.is_private,
          now,
          caller.actor.id,
        )

      const peerCanonical = peerActor?.id ?? `handle:${peerSlug}`
      this.store.db
        .prepare('UPDATE board_channels SET metadata_json = ? WHERE path = ?')
        .run(
          JSON.stringify({
            category: 'dm',
            parent: 'dm',
            topic,
            kind: 'dm',
            archived: meta.archived === 1,
            sortOrder: meta.sort_order,
            private: true,
            dmPeers: [caller.actor.id, peerCanonical],
          }),
          path,
        )

      const addMember = this.store.db.prepare(
        `INSERT OR IGNORE INTO board_channel_members (channel, actor_id, role, added_by, added_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      addMember.run(path, caller.actor.id, 'owner', caller.actor.id, now)
      addMember.run(path, `handle:${callerSlug}`, 'member', caller.actor.id, now)
      if (peerActor) {
        addMember.run(path, peerActor.id, 'member', caller.actor.id, now)
      } else if (input.peer.includes(':')) {
        addMember.run(path, input.peer, 'member', caller.actor.id, now)
      }
      addMember.run(path, `handle:${peerSlug}`, 'member', caller.actor.id, now)

      if (created) {
        this.store.appendEvent({
          type: 'channel.created',
          channel: path,
          payload: {
            channel: path,
            kind: 'dm',
            private: true,
            by: {
              actor: caller.actor.id,
              principal: caller.principal.id,
              profile: caller.profile,
            },
          },
          createdAt: now,
        })
      }

      const row = existing ?? { path, last_index: 0, messages: 0, threads: 0 }
      return {
        channel: this.buildChannelView(row, meta),
        created,
        peer: peerActor?.id ?? peerSlug,
      }
    })
  }

  // ==========================================================================
  // F2: Messages, 1-Level Threads, Blocks, Mentions, Attachments
  // ==========================================================================

  /**
   * A post or reply, as a request makes it. What the board's own code adds to a write it makes
   * itself (a schedule's send, a sync's import) is `postMessageAs`'s, which no request reaches.
   */
  postMessage(caller: CallerContext, rawInput: unknown): Posted {
    return this.postMessageAs(caller, rawInput)
  }

  private postMessageAs(
    caller: CallerContext,
    rawInput: unknown,
    internalOpts?: {
      from?: string | null
      origin?: Origin | null
      schedule?: { id: number; n: number }
      links?: LinkView[]
      /** The id is the board's own (a schedule's send, a sync's import), which no request may post with. */
      trustedId?: boolean
      /**
       * A sync's import, which its caller proved it may sync where it lands: written with the
       * board's own proofs, not the importer's `post` and `label` (original writes.ts:194-197 trusted.post).
       */
      trustedSync?: boolean
      /** The task engine's root option (M2_DESIGN 2.5.2): this post makes a thread a task. */
      taskRoot?: TaskRootOption
    },
  ): Posted {
    const taskRoot = internalOpts?.taskRoot
    const { caller: granted } = this.requireAdmitted(caller)
    const proving = internalOpts?.trustedSync ? FULL_ACCESS : granted
    const access = granted
    const preText = (rawInput as { text?: unknown } | null)?.text
    if (typeof preText === 'string' && preText.length > MESSAGE_TEXT_MAX) {
      throw textTooLong()
    }
    const input = PostBodySchema.parse(rawInput)
    checkAttachmentCount(input.attachments)
    if (input.id !== undefined && !internalOpts?.trustedId) ownId(caller.principal.id, input.id)
    if (input.labels) {
      for (const k of Object.keys(input.labels)) {
        if (k.startsWith(RESERVED_LABEL_PREFIX)) {
          throw reservedLabel(k)
        }
      }
    }

    return this.tx(() => {
      let channel: string
      let re: number | null = null
      let replyTo: number | null = null
      let thread: string
      let replyTarget: StoredMessage | null = null
      let rootMsgForNotif: StoredMessage | null = null
      const clientId = input.id

      if (input.re !== undefined) {
        const targetId = resolveMessageId(this.store.db, input.re)
        const target = targetId > 0 ? this.loadStoredMessage(targetId) : null
        if (!target) throw this.messageNotFoundError(input.re)()
        authorizeChannel(proving, 'read', target.channel, this.messageNotFoundError(input.re))
        authorizeChannel(proving, 'post', target.channel)
        re = target.re ?? target.id
        replyTo = target.id === re ? null : target.id
        replyTarget = target
        rootMsgForNotif = target.re === null ? target : this.loadStoredMessage(re)
        channel = target.channel
        thread = target.thread
        if (input.sync?.length) {
          throw badRequest('sync attaches whole threads: use `board sync <id> <target>`')
        }
      } else {
        if (!input.channel) throw badRequest('a post needs a channel')
        channel = input.channel
        authorizeChannel(proving, 'post', channel)
        if (input.after !== undefined) {
          throw badRequest('`after` is for replies', 'invalid_after')
        }
        thread = clientId ?? taskRoot?.eventId ?? randomUUID()
      }

      if (input.labels && Object.keys(input.labels).length > 0) {
        authorizeChannel(proving, 'label', channel)
      }
      if (input.sync && input.sync.length > 0) {
        authorizeChannel(proving, 'sync', channel)
      }

      // Idempotency replay check BEFORE `after` CAS
      if (clientId !== undefined) {
        const existingRow = this.store.db
          .prepare('SELECT data FROM board_messages WHERE event_id = ?')
          .get(clientId) as { data: string } | undefined
        if (existingRow) {
          const landed = JSON.parse(existingRow.data) as StoredMessage
          // Only the same author's post in the same place is a retry (original writes.ts:281-291 replayOf).
          if (landed.channel !== channel || landed.re !== re || landed.replyTo !== replyTo) {
            throw duplicateId()
          }
          const shown = this.landedFor(caller, access, landed)
          if (!shown) throw duplicateId()
          // A task create sent again: its option says whether this landed post is that create's.
          taskRoot?.replay(landed)
          return { message: shownTo(shown, access, input.text) }
        }
        // An ID another write (a grant, an actor record) already took is no retry of this post:
        // the same 409 any other write's ID gets (original writes.ts:287 replayOf, errors.ts duplicateId).
        if (this.store.db.prepare('SELECT 1 FROM board_events WHERE event_id = ?').get(clientId)) {
          throw duplicateId()
        }
      }

      // `after` precondition on replies
      if (input.after !== undefined && re !== null) {
        const afterId = resolveMessageId(this.store.db, input.after)
        const afterMsg = afterId > 0 ? this.loadStoredMessage(afterId) : null
        if (!afterMsg || afterMsg.thread !== thread) {
          throw badRequest(`after names no message in #${re}'s thread`, 'invalid_after')
        }
        const newerRow = this.store.db
          .prepare('SELECT id FROM board_messages WHERE thread = ? AND id > ? ORDER BY id ASC LIMIT 1')
          .get(thread, afterId) as { id?: number } | undefined
        if (newerRow?.id !== undefined) {
          throw conflict(`#${newerRow.id} came after #${afterId}`, 'newer_message')
        }
      }

      // Resolve optional quoteMessageId (enforces read ACL -> 404 message_not_found if hidden/deleted)
      let quote: QuoteView | undefined
      let quotedMsg: StoredMessage | null = null
      if (input.quoteMessageId !== undefined) {
        const qid = resolveMessageId(this.store.db, input.quoteMessageId)
        const foundQuote = qid > 0 ? this.loadStoredMessage(qid) : null
        if (!foundQuote || foundQuote.deleted || !proving.readable(foundQuote.channel)) {
          throw this.messageNotFoundError(input.quoteMessageId)()
        }
        const qActor = this.store.db
          .prepare('SELECT handle FROM board_actors WHERE id = ?')
          .get(foundQuote.by.actor) as { handle?: string } | undefined
        quotedMsg = foundQuote
        quote = {
          id: String(foundQuote.id),
          channel: foundQuote.channel,
          by: foundQuote.by.actor,
          handle: qActor?.handle ?? null,
          excerpt: excerptOf(foundQuote.text, 240),
          createdAt: foundQuote.createdAt,
        }
      }

      // Validate blocks unless externally synced
      const fromKey = internalOpts?.from ?? null
      if (fromKey === null) {
        this.checkBlocks(input.text)
      }

      // Settle @mentions against actors visible to caller; a reply's thread breaks ties.
      const settled =
        fromKey === null
          ? this.settleFor(access, caller, input.text, re)
          : { text: input.text, mentions: [] as Mentioned[] }

      // Resolve attachments: each one the caller may have, or 404 as if it didn't exist.
      const attachments = this.attachmentsFor(access, caller.principal.id, input.attachments)

      // Resolve sync targets on root
      const syncTargets: { target: string; kind: 'channel' | 'thread' }[] = []
      if (re === null && input.sync?.length) {
        for (const item of input.sync) {
          const target =
            typeof item === 'string'
              ? {
                  target: item,
                  kind: (item.slice(item.indexOf(':') + 1).includes(':') ? 'thread' : 'channel') as
                    | 'channel'
                    | 'thread',
                }
              : item
          if (!syncTargets.some((t) => t.target === target.target)) {
            if (target.kind === 'thread') {
              const ownerRow = this.store.db
                .prepare('SELECT thread FROM board_external_threads WHERE external = ?')
                .get(target.target) as { thread?: string } | undefined
              if (ownerRow?.thread && ownerRow.thread !== thread) {
                throw conflict(`${target.target} is already synced with another thread`, 'already_synced')
              }
            }
            syncTargets.push(target)
          }
        }
      }

      // Read after the write lock is taken, so racing writers are ordered by it.
      const nowMs = this.nowMs()
      // A task root's own checks, made before anything is written: a refusal posts nothing.
      const along = taskRoot ? taskRoot.prepare({ now: nowMs }).along : 0
      this.upsertActorInTx(caller)
      const now = new Date(nowMs).toISOString()
      this.ensureChannelInTx(channel, now)
      const blind = !access.readable(channel)
      const links = internalOpts?.links ?? []
      const author: Author = {
        actor: caller.actor.id,
        principal: caller.principal.id,
        profile: caller.profile,
      }
      const eventId = clientId ?? taskRoot?.eventId ?? randomUUID()
      const plannedNotifs = this.hasV2Tables()
        ? this.planMessageNotificationsInTx(caller, access, {
            channel,
            text: settled.text,
            labels: input.labels ?? {},
            re,
            rootMsg: rootMsgForNotif,
            replyTarget,
            quotedMsg,
            isEdit: false,
            nowIso: now,
          })
        : { items: [], fanoutTruncated: false }
      const event = this.store.appendEvent({
        id: eventId,
        type: 'message.posted',
        channel,
        thread,
        createdAt: now,
        payload: {
          channel,
          text: settled.text,
          re,
          replyTo,
          thread,
          labels: input.labels ?? {},
          noSync: input.noSync ?? false,
          by: author,
          origin: internalOpts?.origin ?? null,
          from: fromKey,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(links.length > 0 ? { links } : {}),
          ...(quote ? { quote } : {}),
          ...(internalOpts?.schedule ? { schedule: internalOpts.schedule } : {}),
          ...(blind ? { blind: true } : {}),
          ...(plannedNotifs.fanoutTruncated ? { fanoutTruncated: true } : {}),
          // How many events come with it, so a replay tells its own from what was written since (original writes.ts:516-517).
          ...(along > 0 ? { along } : {}),
        },
      })

      const stored: StoredMessage = {
        id: event.index,
        eventId: event.id,
        channel,
        text: settled.text,
        re,
        replyTo,
        thread,
        labels: { ...(input.labels ?? {}) },
        reactions: {},
        by: author,
        noSync: input.noSync ?? false,
        origin: internalOpts?.origin ?? null,
        from: fromKey,
        createdAt: now,
        editedAt: null,
        deleted: false,
        undelivered: {},
        attachments,
        links,
        ...(quote ? { quote } : {}),
        ...(internalOpts?.schedule ? { schedule: internalOpts.schedule } : {}),
        ...(blind ? { blind: true as const } : {}),
        version: event.index,
        revision: event.index,
      }
      this.saveMessageInTx(stored, event.index, true)

      if (this.hasV2Tables()) {
        if (plannedNotifs.items.length > 0) {
          this.insertNotificationsInTx(plannedNotifs.items, {
            logIndex: event.index,
            channel,
            thread,
            rootId: re ?? event.index,
            messageId: event.index,
            byActor: caller.actor.id,
            excerpt: excerptOf(settled.text, 200),
            createdAt: now,
          })
        }
        this.store.db
          .prepare(
            `INSERT INTO board_read_cursors (actor_id, channel, last_read_index, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(actor_id, channel) DO UPDATE SET
               last_read_index = MAX(last_read_index, excluded.last_read_index),
               updated_at = excluded.updated_at`,
          )
          .run(caller.actor.id, channel, event.index, now)
      }

      this.store.db
        .prepare(
          `UPDATE board_channels
           SET last_index = ?, messages = messages + 1, threads = threads + ?
           WHERE path = ?`,
        )
        .run(event.index, re === null ? 1 : 0, channel)

      if (re !== null) {
        this.store.db
          .prepare('UPDATE board_messages SET replies = replies + 1, at = ? WHERE id = ?')
          .run(event.index, re)
      }

      const threadSynced: StoredEvent[] = []
      if (re === null) {
        const syncData: SyncThreadView = {
          thread,
          root: String(stored.id),
          channel,
          targets: syncTargets.map((s) => s.target),
          external: Object.fromEntries(
            syncTargets.filter((s) => s.kind === 'thread').map((s) => [s.target, s.target]),
          ),
        }
        this.store.db
          .prepare('INSERT OR REPLACE INTO board_sync_threads (thread, data) VALUES (?, ?)')
          .run(thread, JSON.stringify(syncData))
        for (const s of syncTargets) {
          if (s.kind === 'thread') {
            this.store.db
              .prepare('INSERT OR REPLACE INTO board_external_threads (external, thread) VALUES (?, ?)')
              .run(s.target, thread)
          }
          threadSynced.push(
            this.store.appendEvent({
              type: 'thread.synced',
              createdAt: new Date(this.nowMs()).toISOString(),
              channel,
              thread,
              payload: { thread, target: s.target, kind: s.kind, cause: 'request', by: author },
            }),
          )
        }
      }

      // The post's watchers see the root as it was posted; the task events that follow it are
      // dispatched by the task writer, each with the root as that event left it.
      const posted: StoredMessage = taskRoot ? structuredClone(stored) : stored
      if (taskRoot) {
        const planned = taskRoot.emit(stored, event.index)
        // The post said how many events come with it: a replay counts on that (original writes.ts:503).
        if (planned.length !== along) {
          throw new BoardError(500, 'internal', `a root's post carries the ${along} events it said, not ${planned.length}`)
        }
        this.tasks.commitRootEventsInTx(stored, planned)
      }

      this.dispatchWatchersInTx(event, posted)
      for (const synced of threadSynced) this.dispatchThreadSyncedInTx(synced, posted)

      const updatedActors = this.getActorsMap()
      // A writer that can't read the channel gets back exactly the text it sent; what the board
      // made of it (settled mentions) is for its readers (original writes.ts:409, :536-540 shownTo).
      const view = shownTo(this.toMessageView(stored, updatedActors, access), access, input.text)
      // How the board settled the text's @handles, only when it typed some (original serve.ts:543-550).
      return settled.mentions.length > 0 ? { message: view, mentions: settled.mentions } : { message: view }
    })
  }

  /**
   * A post that landed, as its author may have it back: only the same author's, and one in a channel
   * it can't read only if it posted without reading too. A caller that can't read gets back what its
   * own append made of the post (its first version), with other actors' mentions masked: never what
   * others added since. Null for anyone else (original writes.ts:293-314 landedFor).
   */
  private landedFor(caller: CallerContext, access: Access, landed: StoredMessage): MessageView | null {
    if (
      landed.by.actor !== caller.actor.id ||
      landed.by.principal !== caller.principal.id ||
      landed.by.profile !== caller.profile
    ) {
      return null
    }
    const actors = this.getActorsMap()
    if (access.readable(landed.channel)) return this.toMessageView(landed, actors, access)
    // A post written by a caller that could read isn't its to replay.
    if (!landed.blind) return null
    const initialRow = this.store.db
      .prepare('SELECT data FROM board_versions WHERE log_index = ? AND message_id = ?')
      .get(landed.id, landed.id) as { data: string } | undefined
    const initial = initialRow ? (JSON.parse(initialRow.data) as StoredMessage) : landed
    const view = this.toMessageView(initial, actors, access)
    return { ...view, text: blindText(initial.text, caller.actor.id) }
  }

  /**
   * The post the caller's own client ID landed, to recover it after a lost response (GET /posts/:id):
   * only the same author's, blind-aware as a retry is, else 404 post_not_found (original a2.ts:572-578 posted).
   */
  getPosted(caller: CallerContext, id: string): { message: MessageView } {
    const { caller: access } = this.requireAdmitted(caller)
    const row =
      typeof id === 'string' && id.length > 0
        ? (this.store.db.prepare('SELECT data FROM board_messages WHERE event_id = ?').get(id) as
            | { data: string }
            | undefined)
        : undefined
    const shown = row ? this.landedFor(caller, access, JSON.parse(row.data) as StoredMessage) : null
    if (!shown) throw notFound(`no post of yours has id ${id}`, 'post_not_found')
    return { message: shown }
  }

  /**
   * Edits the caller's own message. When the new text typed `@handle`s, the answer carries
   * `mentions`, what became of each, as a post's does (original serve.ts:1013-1024 settling, :543-550;
   * protocol.ts edit output `{ ok: true; mentions?: Mentioned[] }`).
   */
  editMessage(caller: CallerContext, id: string | number, rawInput: unknown): MessageView & { mentions?: Mentioned[] } {
    return this.editMessageAs(caller, id, rawInput)
  }

  private editMessageAs(
    caller: CallerContext,
    id: string | number,
    rawInput: unknown,
    internalOpts?: { from?: string | null; asAuthor?: boolean; trustedSync?: boolean },
  ): MessageView & { mentions?: Mentioned[] } {
    const { caller: access } = this.requireAdmitted(caller)
    const preText = (rawInput as { text?: unknown } | null)?.text
    if (typeof preText === 'string' && preText.length > MESSAGE_TEXT_MAX) {
      throw textTooLong()
    }
    const input = EditBodySchema.parse(rawInput)
    const msgId = resolveMessageId(this.store.db, id)
    const fromKey = internalOpts?.from ?? null
    const asAuthor = internalOpts?.asAuthor ?? true
    const trustedSync = internalOpts?.trustedSync ?? false

    return this.tx(() => {
      const msg = Number.isInteger(msgId) && msgId > 0 ? this.loadStoredMessage(msgId) : null
      if (!msg) throw this.messageNotFoundError(id)()
      const readable = access.readable(msg.channel)
      if (asAuthor) {
        const sameOwner =
          msg.by.principal === caller.principal.id &&
          ((caller.actor.id === caller.principal.id && caller.profile === null) ||
            msg.by.actor === caller.actor.id)
        if (!sameOwner || (!readable && !msg.blind)) {
          if (!readable) throw this.messageNotFoundError(id)()
          throw forbidden('only the author can edit a message')
        }
      }
      if (!trustedSync) {
        authorizeChannel(access, 'post', msg.channel)
      }

      if (input.revision !== undefined && input.revision !== msg.revision) {
        throw conflict(
          msg.deleted
            ? `#${msg.id} was deleted since revision ${input.revision}`
            : `#${msg.id} was edited since revision ${input.revision}: it's at ${msg.revision}`,
          'revision_conflict',
        )
      }
      if (msg.deleted) {
        throw badRequest('message was deleted', 'message_deleted')
      }

      if (fromKey === null) {
        this.checkBlocks(input.text)
      }
      const settled =
        fromKey === null
          ? this.settleFor(access, caller, input.text, msg.re ?? msg.id)
          : { text: input.text, mentions: [] as Mentioned[] }

      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      const event = this.store.appendEvent({
        type: 'message.edited',
        channel: msg.channel,
        thread: msg.thread,
        createdAt: now,
        payload: {
          id: msg.id,
          thread: msg.thread,
          text: settled.text,
          by: {
            actor: caller.actor.id,
            principal: caller.principal.id,
            profile: caller.profile,
          },
          from: fromKey,
        },
      })

      msg.text = settled.text
      msg.editedAt = now
      if (msg.from === null && fromKey !== null) {
        msg.platformText = true
      } else {
        delete msg.platformText
      }
      msg.version = event.index
      msg.revision = event.index
      this.saveMessageInTx(msg, event.index, false)
      if (this.hasV2Tables()) {
        const editNotifs = this.planMessageNotificationsInTx(caller, access, {
          channel: msg.channel,
          text: settled.text,
          labels: msg.labels,
          re: msg.re,
          rootMsg: null,
          replyTarget: null,
          quotedMsg: null,
          isEdit: true,
          existingMessageId: msg.id,
          nowIso: now,
        })
        if (editNotifs.items.length > 0) {
          this.insertNotificationsInTx(editNotifs.items, {
            logIndex: event.index,
            channel: msg.channel,
            thread: msg.thread,
            rootId: msg.re ?? msg.id,
            messageId: msg.id,
            byActor: caller.actor.id,
            excerpt: excerptOf(settled.text, 200),
            createdAt: now,
          })
        }
      }
      // `lastIndex` is the channel's latest post: edits and deletes don't move it (original contract/reducers.ts:27-45).
      this.dispatchWatchersInTx(event, msg)
      // A task's root edited by anyone but its owner holds the task, in the same write (M2_DESIGN 2.7.12).
      if (msg.task) this.tasks.rootHooks.onRootEditedInTx(msg, identityOf(caller), event)

      const view = this.toMessageView(msg, this.getActorsMap(), access)
      const shown = readable ? view : this.blindWriteView(view, msg, caller, access)
      return settled.mentions.length > 0 ? { ...shown, mentions: settled.mentions } : shown
    })
  }

  deleteMessage(caller: CallerContext, id: string | number, rawInput?: unknown): MessageView {
    return this.deleteMessageAs(caller, id, rawInput)
  }

  private deleteMessageAs(
    caller: CallerContext,
    id: string | number,
    rawInput?: unknown,
    internalOpts?: { from?: string | null; asAuthor?: boolean; trustedSync?: boolean },
  ): MessageView {
    const { caller: access } = this.requireAdmitted(caller)
    const input = DeleteBodySchema.parse(rawInput)
    const msgId = resolveMessageId(this.store.db, id)
    const fromKey = internalOpts?.from ?? null
    const asAuthor = internalOpts?.asAuthor ?? true
    const trustedSync = internalOpts?.trustedSync ?? false

    return this.tx(() => {
      const msg = Number.isInteger(msgId) && msgId > 0 ? this.loadStoredMessage(msgId) : null
      if (!msg) throw this.messageNotFoundError(id)()
      const readable = access.readable(msg.channel)
      if (asAuthor) {
        const sameOwner =
          msg.by.principal === caller.principal.id &&
          ((caller.actor.id === caller.principal.id && caller.profile === null) ||
            msg.by.actor === caller.actor.id)
        if (!sameOwner || (!readable && !msg.blind)) {
          if (!readable) throw this.messageNotFoundError(id)()
          throw forbidden('only the author can delete a message')
        }
      }
      if (!trustedSync) {
        authorizeChannel(access, 'post', msg.channel)
      }

      if (input?.revision !== undefined && input.revision !== msg.revision) {
        // Worded as the original's atRevision and writeDelete (writes.ts:744, :776).
        throw conflict(
          msg.deleted
            ? `#${msg.id} was deleted since revision ${input.revision}`
            : `#${msg.id} was edited since revision ${input.revision}: it's at ${msg.revision}`,
          'revision_conflict',
        )
      }
      if (msg.deleted) {
        const view = this.toMessageView(msg, this.getActorsMap(), access)
        return readable ? view : this.blindWriteView(view, msg, caller, access)
      }

      // A task's root deleted cancels the task first, while the root still wears its labels (M2_DESIGN 2.7.12).
      if (msg.task) this.tasks.rootHooks.onRootDeletingInTx(msg, identityOf(caller))
      const now = new Date(this.nowMs()).toISOString()
      const event = this.store.appendEvent({
        type: 'message.deleted',
        channel: msg.channel,
        thread: msg.thread,
        createdAt: now,
        payload: {
          id: msg.id,
          thread: msg.thread,
          by: {
            actor: caller.actor.id,
            principal: caller.principal.id,
            profile: caller.profile,
          },
          from: fromKey,
        },
      })

      msg.deleted = true
      msg.text = ''
      msg.labels = {}
      msg.reactions = {}
      msg.attachments = []
      msg.links = []
      delete msg.quote
      msg.version = event.index
      msg.revision = event.index
      this.saveMessageInTx(msg, event.index, false)
      if (this.hasV2Tables()) {
        this.store.db.prepare('DELETE FROM board_pins WHERE message_id = ?').run(msg.id)
      }
      // `lastIndex` is the channel's latest post: edits and deletes don't move it (original contract/reducers.ts:27-45).
      if (msg.task) this.tasks.rootHooks.onRootDeletedInTx(msg)

      if (msg.re !== null) {
        const newestRow = this.store.db
          .prepare('SELECT COALESCE(MAX(id), ?) AS at FROM board_messages WHERE re = ? AND deleted = 0')
          .get(msg.re, msg.re) as { at: number }
        this.store.db
          .prepare('UPDATE board_messages SET replies = MAX(0, replies - 1), at = ? WHERE id = ?')
          .run(Number(newestRow.at), msg.re)
      }
      this.dispatchWatchersInTx(event, msg)
      const view = this.toMessageView(msg, this.getActorsMap(), access)
      return readable ? view : this.blindWriteView(view, msg, caller, access)
    })
  }

  /**
   * What an edit or delete gives back to an author that can't read the message's channel (it posted
   * blind): what it wrote, as it landed, and never what others added since. Its text with others'
   * mentions masked, the labels, files and links it posted with, and no reactions, no labels others
   * set, no sync delivery state. The original answers such a write only `{ ok: true }` (a2.ts:582-594)
   * and gives a blind writer back only what it sent (writes.ts:293-315 landedFor).
   */
  private blindWriteView(view: MessageView, msg: StoredMessage, caller: CallerContext, access: Access): MessageView {
    const initialRow = this.store.db
      .prepare('SELECT data FROM board_versions WHERE log_index = ? AND message_id = ?')
      .get(msg.id, msg.id) as { data: string } | undefined
    const initial = initialRow ? (JSON.parse(initialRow.data) as StoredMessage) : null
    const posted = !msg.deleted && initial !== null
    return {
      ...view,
      text: blindText(msg.text, caller.actor.id),
      labels: posted ? { ...initial.labels } : {},
      reactions: {},
      undelivered: {},
      attachments: posted ? initial.attachments : [],
      links: posted ? initial.links.map((link) => this.linkViewFor(link, access)) : [],
      blocks: msg.deleted || msg.from !== null || msg.platformText ? [] : blocksIn(blindText(msg.text, caller.actor.id)),
    }
  }

  getMessageThread(caller: CallerContext, id: string | number, rawQuery: unknown = {}): ThreadView {
    const { caller: access } = this.requireAdmitted(caller)
    const query = ThreadQuerySchema.parse(rawQuery)
    const msgId = resolveMessageId(this.store.db, id)
    const msg = Number.isInteger(msgId) && msgId > 0 ? this.loadStoredMessage(msgId) : null
    if (!msg || !access.readable(msg.channel)) {
      throw this.messageNotFoundError(id)()
    }

    const rootId = msg.re ?? msg.id
    const root = msg.re === null ? msg : this.loadStoredMessage(rootId)
    if (!root) throw this.messageNotFoundError(id)()

    // `after` names one of this thread's messages, its root or a reply: the replies after it. A ref
    // that names no message is a 404, one of another thread's a 400 (original a2.ts:552-566, :90-94).
    let afterId: number | undefined
    if (query.after !== undefined) {
      afterId = resolveMessageId(this.store.db, query.after)
      if (afterId === 0) throw this.messageNotFoundError(query.after)()
      const inThread =
        afterId === rootId ||
        this.store.db.prepare('SELECT 1 FROM board_messages WHERE id = ? AND re = ?').get(afterId, rootId) !== undefined
      if (!inThread) throw badRequest(`after: ${query.after} isn't a message of this thread`)
    }

    // With no `limit`, every reply; with one, the newest `limit`, or the first `limit` after `after`
    // (original a2.ts:562-563).
    const rows =
      afterId !== undefined
        ? (this.store.db
            .prepare('SELECT data FROM board_messages WHERE re = ? AND id > ? ORDER BY id ASC LIMIT ?')
            .all(rootId, afterId, query.limit ?? -1) as Array<{ data: string }>)
        : (this.store.db
            .prepare(
              'SELECT data FROM (SELECT data, id FROM board_messages WHERE re = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
            )
            .all(rootId, query.limit ?? -1) as Array<{ data: string }>)

    const actors = this.getActorsMap()
    const replies = rows.map((r) => this.toMessageView(JSON.parse(r.data) as StoredMessage, actors, access))
    const schedRows = this.store.db
      .prepare("SELECT data FROM board_schedules WHERE re = ? AND state = 'pending' ORDER BY seq ASC")
      .all(rootId) as Array<{ data: string }>
    const schedules = schedRows.map((r) => JSON.parse(r.data) as ScheduleView)

    return {
      message: this.toMessageView(root, actors, access),
      replies,
      cursor: String(this.store.getHeadIndex()),
      // Always the list, empty or not, as the original sends it (a2.ts:568 schedules.forThread).
      schedules,
    }
  }

  listChannelMessages(caller: CallerContext, rawQuery: unknown): MessagesPage {
    const { caller: access } = this.requireAdmitted(caller)
    const query = ChannelMessagesQuerySchema.parse(rawQuery)
    const afterId = query.after !== undefined ? cursorAt(query.after) : undefined
    const limit = query.limit ?? CHANNEL_MESSAGES_LIMIT_DEFAULT
    const head = this.store.getHeadIndex()
    // A channel the caller can't read has nothing it may list: an empty page, as the original's
    // readable() filter matches nothing there (original a2.ts:521-534).
    const rows = !access.readable(query.channel)
      ? []
      : afterId !== undefined
        ? (this.store.db
            .prepare('SELECT data FROM board_messages WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT ?')
            .all(query.channel, afterId, limit) as Array<{ data: string }>)
        : // Without `after`, the newest `limit`, oldest first (original store/types.ts:33 Page).
          (this.store.db
            .prepare(
              'SELECT data FROM (SELECT data, id FROM board_messages WHERE channel = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
            )
            .all(query.channel, limit) as Array<{ data: string }>)
    const actors = this.getActorsMap()
    const messages = rows.map((r) => JSON.parse(r.data) as StoredMessage)
    // A page after a cursor that its limit cut short stops at its last message, so reading on from
    // its cursor reaches the rest; any other has all there is, up to the head (original a2.ts:531-532).
    const stopped = afterId !== undefined && messages.length === limit ? messages.at(-1)!.id : head
    return {
      messages: messages.map((m) => this.toMessageView(m, actors, access)),
      cursor: String(stopped),
    }
  }

  listThreads(caller: CallerContext, rawQuery: unknown = {}): ThreadsPage {
    const { caller: access } = this.requireAdmitted(caller)
    const query = ThreadsQuerySchema.parse(rawQuery)
    const afterNum = query.after !== undefined ? cursorAt(query.after) : undefined
    const beforePos = query.before !== undefined ? olderAt(query.before) : undefined
    const limit = query.limit ?? THREADS_LIMIT_DEFAULT
    const actors = this.getActorsMap()

    const where: string[] = []
    const params: (string | number)[] = []
    if (query.channel !== undefined) {
      if (query.channel.endsWith('/')) {
        const prefix = query.channel.slice(0, -1)
        const slashPrefix = `${prefix}/`
        params.push(prefix, slashPrefix, slashPrefix)
        where.push('(m.channel = ? OR substr(m.channel, 1, length(?)) = ?)')
      } else {
        params.push(query.channel)
        where.push('m.channel = ?')
      }
    }
    if (query.re !== undefined) {
      const resolvedRe = resolveMessageId(this.store.db, query.re)
      const reId = resolvedRe > 0 ? resolvedRe : -1
      params.push(reId, reId)
      where.push('(m.id = ? OR m.re = ?)')
    }
    if (query.from !== undefined) {
      params.push(query.from)
      where.push("COALESCE(m.from_key, 'board') = ?")
    }
    if (query.text !== undefined) {
      const escaped = query.text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)
      params.push(`%${escaped}%`)
      where.push("m.text_lower LIKE ? ESCAPE '\\'")
    }
    if (query.label) {
      for (const [key, values] of query.label) {
        if (values === null) {
          params.push(key)
          where.push('EXISTS (SELECT 1 FROM board_terms t WHERE t.message_id IN (m.id, m.re) AND t.term = ?)')
        } else {
          params.push(key, ...values)
          where.push(
            `EXISTS (SELECT 1 FROM board_terms t WHERE t.message_id IN (m.id, m.re) AND t.term = ? AND t.value IN (${values.map(() => '?').join(', ')}))`,
          )
        }
      }
    }

    const matchingRows = this.store.db
      .prepare(
        `SELECT m.id, m.re, m.channel, m.data FROM board_messages m ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.id ASC`,
      )
      .all(...params) as Array<{ id: number; re: number | null; channel: string; data: string }>

    const rootIds = new Set<number>()
    for (const r of matchingRows) {
      if (!access.readable(r.channel)) continue
      const msg = JSON.parse(r.data) as StoredMessage
      if (query.by !== undefined && !this.matchesBy(msg, query.by, caller, actors)) continue
      if (query.mentions !== undefined && !this.matchesMentions(msg, query.mentions, caller, actors, access)) {
        continue
      }
      rootIds.add(r.re ?? r.id)
    }

    if (rootIds.size === 0) {
      return {
        threads: [],
        cursor: String(this.store.getHeadIndex()),
        ...(query.after === undefined ? { older: null } : {}),
      }
    }

    const roots = [...rootIds]
      .map((rid) => {
        const row = this.store.db
          .prepare('SELECT replies, at, data FROM board_messages WHERE id = ?')
          .get(rid) as { replies: number; at: number; data: string } | undefined
        return row ? { msg: JSON.parse(row.data) as StoredMessage, replies: Number(row.replies), at: Number(row.at ?? rid) } : null
      })
      .filter((x): x is { msg: StoredMessage; replies: number; at: number } => x !== null)

    const order = query.order ?? 'chronological'
    const pinnedFirst = query.pinnedFirst ?? order === 'forum'
    const includeMeta = query.includeMeta === true

    type PinMeta = {
      scope: 'announcement' | 'channel'
      note: string | null
      pinnedBy: string
      pinnedAt: string
      sortOrder: number
      pinId: number
    }
    const pinByRoot = new Map<number, PinMeta>()
    if (this.hasV2Tables() && roots.length > 0) {
      const rootIdList = JSON.stringify(roots.map((r) => r.msg.id))
      const pinRows = this.store.db
        .prepare(
          `SELECT id, scope, root_id, pinned_by, pinned_at, note, sort_order
           FROM board_pins
           WHERE scope IN ('announcement', 'channel') AND root_id IN (SELECT value FROM json_each(?))
           ORDER BY CASE scope WHEN 'announcement' THEN 0 ELSE 1 END ASC, sort_order ASC, id DESC`,
        )
        .all(rootIdList) as Array<{
        id: number
        scope: 'announcement' | 'channel'
        root_id: number
        pinned_by: string
        pinned_at: string
        note: string | null
        sort_order: number
      }>
      for (const pr of pinRows) {
        const rid = Number(pr.root_id)
        if (!pinByRoot.has(rid)) {
          pinByRoot.set(rid, {
            scope: pr.scope,
            note: pr.note,
            pinnedBy: pr.pinned_by,
            pinnedAt: pr.pinned_at,
            sortOrder: Number(pr.sort_order),
            pinId: Number(pr.id),
          })
        }
      }
    }

    let selected: typeof roots
    let older: string | null | undefined

    if (afterNum !== undefined) {
      selected = roots
        .filter((r) => r.at > afterNum)
        .sort((a, b) => a.at - b.at || a.msg.id - b.msg.id)
        .slice(0, limit)
    } else if (order === 'forum') {
      const comparePins = (a: (typeof roots)[number], b: (typeof roots)[number]): number => {
        const pa = pinByRoot.get(a.msg.id)!
        const pb = pinByRoot.get(b.msg.id)!
        return (
          pa.sortOrder - pb.sortOrder ||
          (pb.pinnedAt < pa.pinnedAt ? -1 : pb.pinnedAt > pa.pinnedAt ? 1 : 0) ||
          pb.pinId - pa.pinId
        )
      }
      const unpinnedAll = (pinnedFirst ? roots.filter((r) => !pinByRoot.has(r.msg.id)) : roots).sort(
        (a, b) => b.at - a.at || b.msg.id - a.msg.id,
      )
      if (beforePos !== undefined) {
        const filtered = unpinnedAll.filter(
          (r) => r.at < beforePos.at || (r.at === beforePos.at && r.msg.id < beforePos.id),
        )
        const slice = filtered.slice(0, limit)
        const hasMore = filtered.length > limit
        const lastItem = slice.at(-1)
        older = hasMore && lastItem ? `${lastItem.at}.${lastItem.msg.id}` : null
        selected = slice
      } else {
        const tier0 = pinnedFirst
          ? roots.filter((r) => pinByRoot.get(r.msg.id)?.scope === 'announcement').sort(comparePins)
          : []
        const tier1 = pinnedFirst
          ? roots.filter((r) => pinByRoot.get(r.msg.id)?.scope === 'channel').sort(comparePins)
          : []
        const pinnedCombined = [...tier0, ...tier1]
        const pinnedSlice = pinnedCombined.slice(0, limit)
        const remainingSlots = Math.max(0, limit - pinnedSlice.length)
        const tier2Slice = unpinnedAll.slice(0, remainingSlots)
        selected = [...pinnedSlice, ...tier2Slice]
        if (tier2Slice.length < unpinnedAll.length) {
          const lastTier2 = tier2Slice.at(-1)
          if (lastTier2) {
            older = `${lastTier2.at}.${lastTier2.msg.id}`
          } else {
            const firstUnpinned = unpinnedAll[0]!
            older = `${firstUnpinned.at}.${firstUnpinned.msg.id + 1}`
          }
        } else {
          older = null
        }
      }
    } else {
      // Default `order === 'chronological'`: 100% v1 byte-identical ordering and cursor pagination.
      let filtered = roots.sort((a, b) => b.at - a.at || b.msg.id - a.msg.id)
      if (beforePos !== undefined) {
        filtered = filtered.filter((r) => r.at < beforePos.at || (r.at === beforePos.at && r.msg.id < beforePos.id))
      }
      const slice = filtered.slice(0, limit)
      const hasMore = filtered.length > limit
      const oldestInPage = slice.at(-1)
      older = hasMore && oldestInPage ? `${oldestInPage.at}.${oldestInPage.msg.id}` : null
      selected = slice.reverse()
    }

    const summaries: ThreadSummaryView[] = selected.map((r) => {
      const lastRow =
        r.replies > 0
          ? (this.store.db
              .prepare('SELECT data FROM board_messages WHERE re = ? AND deleted = 0 ORDER BY id DESC LIMIT 1')
              .get(r.msg.id) as { data: string } | undefined)
          : undefined
      const pinMeta = pinByRoot.get(r.msg.id)
      const pinBadge: ThreadPinBadge | undefined = pinMeta
        ? {
            scope: pinMeta.scope,
            note: pinMeta.note,
            pinnedBy: pinMeta.pinnedBy,
            pinnedAt: pinMeta.pinnedAt,
          }
        : undefined
      let participants: string[] | undefined
      if (includeMeta) {
        const pRows = this.store.db
          .prepare(
            `SELECT by_actor FROM board_messages
             WHERE (id = ? OR re = ?) AND deleted = 0
             GROUP BY by_actor
             ORDER BY MIN(id) ASC`,
          )
          .all(r.msg.id, r.msg.id) as Array<{ by_actor: string }>
        participants = pRows.map((p) => actors.get(p.by_actor)?.handle ?? p.by_actor)
      }
      return {
        message: this.toMessageView(r.msg, actors, access),
        replies: r.replies,
        last: lastRow ? this.toMessageView(JSON.parse(lastRow.data) as StoredMessage, actors, access) : null,
        ...(pinBadge ? { pin: pinBadge } : {}),
        ...(participants ? { participants } : {}),
      }
    })

    return {
      threads: summaries,
      cursor: String(this.store.getHeadIndex()),
      ...(older !== undefined ? { older } : {}),
    }
  }

  // ==========================================================================
  // F3: Reactions, Atomic Conditional Labels & Event Log
  // ==========================================================================

  reactMessage(caller: CallerContext, id: string | number, rawInput: unknown): MessageView {
    return this.reactMessageAs(caller, id, rawInput)
  }

  private reactMessageAs(
    caller: CallerContext,
    id: string | number,
    rawInput: unknown,
    internalOpts?: { from?: string | null; trustedSync?: boolean },
  ): MessageView {
    const { caller: access } = this.requireAdmitted(caller)
    const input = ReactBodySchema.parse(rawInput)
    const msgId = resolveMessageId(this.store.db, id)
    const fromKey = internalOpts?.from ?? null
    const trustedSync = internalOpts?.trustedSync ?? false

    return this.tx(() => {
      const msg = Number.isInteger(msgId) && msgId > 0 ? this.loadStoredMessage(msgId) : null
      if (!msg) throw this.messageNotFoundError(id)()
      if (!trustedSync) {
        authorizeChannel(access, 'react', msg.channel, this.messageNotFoundError(id))
      }
      if (msg.deleted) throw badRequest('message was deleted', 'message_deleted')

      const emoji = canonicalEmoji(input.emoji)
      const author: Author = {
        actor: caller.actor.id,
        principal: caller.principal.id,
        profile: caller.profile,
      }
      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()

      // The reaction is always appended, as the original's writeReaction does (writes.ts:810-828);
      // one that changes nothing (a second add, a remove of none) folds as a no-op (contract/folds.ts:158-179):
      // the message keeps its version, and only the log and the feed carry it.
      const list = Object.hasOwn(msg.reactions, emoji) ? msg.reactions[emoji] : undefined
      const had = list?.includes(caller.actor.id) ?? false
      const ev = this.store.appendEvent({
        type: input.remove ? 'reaction.removed' : 'reaction.added',
        channel: msg.channel,
        thread: msg.thread,
        createdAt: now,
        payload: { id: msg.id, thread: msg.thread, emoji, by: author, from: fromKey },
      })
      if (input.remove && had) {
        const next = list!.filter((a) => a !== caller.actor.id)
        if (next.length > 0) msg.reactions[emoji] = next
        else delete msg.reactions[emoji]
      } else if (!input.remove && !had) {
        msg.reactions[emoji] = [...(list ?? []), caller.actor.id]
      }
      if ((input.remove ?? false) === had) {
        msg.version = ev.index
        this.saveMessageInTx(msg, ev.index, false, false)
      }
      this.dispatchWatchersInTx(ev, msg)
      return this.toMessageView(msg, this.getActorsMap(), access)
    })
  }

  labelMessage(caller: CallerContext, id: string | number, rawInput: unknown): MessageView {
    return this.labelMessageAs(caller, id, rawInput)
  }

  private labelMessageAs(
    caller: CallerContext,
    id: string | number,
    rawInput: unknown,
    internalOpts?: { trustedSync?: boolean },
  ): MessageView {
    const { caller: access } = this.requireAdmitted(caller)
    const input = LabelBodySchema.parse(rawInput)
    for (const k of Object.keys(input.set ?? {})) {
      if (k.startsWith(RESERVED_LABEL_PREFIX)) {
        throw reservedLabel(k)
      }
    }
    for (const k of input.unset ?? []) {
      if (k.startsWith(RESERVED_LABEL_PREFIX)) {
        throw reservedLabel(k)
      }
    }
    const msgId = resolveMessageId(this.store.db, id)
    const trustedSync = internalOpts?.trustedSync ?? false

    return this.tx(() => {
      const msg = Number.isInteger(msgId) && msgId > 0 ? this.loadStoredMessage(msgId) : null
      if (!msg) throw this.messageNotFoundError(id)()
      if (!trustedSync) {
        authorizeChannel(access, 'label', msg.channel, this.messageNotFoundError(id))
      }
      if (msg.deleted) throw badRequest('message was deleted', 'message_deleted')

      if (input.if) {
        for (const key of Object.keys(input.if).sort()) {
          const wanted = input.if[key]
          const nowVal = Object.hasOwn(msg.labels, key) ? msg.labels[key] : undefined
          if (nowVal === wanted || (nowVal === undefined && wanted === null)) continue
          throw conflict(
            wanted === null
              ? `${key} is set`
              : nowVal === undefined
                ? `${key} isn't set`
                : `${key} isn't ${wanted}`,
            'label_conflict',
          )
        }
      }

      const beforeSnapshot = { ...msg.labels }
      for (const [k, v] of Object.entries(input.set ?? {})) {
        msg.labels[k] = v
      }
      for (const k of input.unset ?? []) {
        delete msg.labels[k]
      }

      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      const author: Author = {
        actor: caller.actor.id,
        principal: caller.principal.id,
        profile: caller.profile,
      }
      const ev = this.store.appendEvent({
        type: 'labels.changed',
        channel: msg.channel,
        thread: msg.thread,
        createdAt: now,
        payload: {
          id: msg.id,
          thread: msg.thread,
          set: input.set ?? {},
          unset: input.unset ?? [],
          by: author,
          beforeLabels: beforeSnapshot,
        },
      })
      msg.version = ev.index
      this.saveMessageInTx(msg, ev.index, false, false)
      this.dispatchWatchersInTx(ev, msg)
      return this.toMessageView(msg, this.getActorsMap(), access)
    })
  }

  private matchesBy(
    msg: StoredMessage,
    by: string,
    caller: CallerContext,
    actors: Map<string, StoredActor>,
  ): boolean {
    if (by === 'me') return msg.by.actor === caller.actor.id
    if (actors.has(by)) {
      const target = actors.get(by)!
      return msg.by.actor === by || (target.kind === 'person' && msg.by.principal === by)
    }
    const lower = by.toLowerCase()
    const matching = [...actors.values()].filter((a) => a.handle.toLowerCase() === lower)
    return matching.some(
      (a) => msg.by.actor === a.id || (a.kind === 'person' && msg.by.principal === a.id),
    )
  }

  private matchesMentions(
    msg: StoredMessage,
    mentions: string,
    caller: CallerContext,
    actors: Map<string, StoredActor>,
    access: Access,
  ): boolean {
    const terms = mentionTerms(msg.text)
    if (mentions === 'me') {
      const target = [mentionTerm(caller.actor.handle), caller.actor.id]
      return terms.some((t) => target.includes(t))
    }
    // The value as written and what's under it; a reader of every channel also gets each actor the
    // value names (by ID, else by handle) through their other name, and what's under both of them
    // (original server/feed.ts:156-157 actorSet, :182-201 mentionFilter).
    const under = (name: string): string => (name.includes(':') ? `${name}+` : `${mentionTerm(name)}/`)
    const termSet = new Set([mentionTerm(mentions)])
    const prefixSet = new Set([under(mentions)])
    if (access.readsAll) {
      const named = actors.has(mentions)
        ? [actors.get(mentions)!]
        : [...actors.values()].filter((a) => a.handle.toLowerCase() === mentions.toLowerCase())
      for (const a of named) {
        termSet.add(a.id).add(mentionTerm(a.handle))
        prefixSet.add(under(a.handle)).add(under(a.id))
      }
    }
    return terms.some((t) => termSet.has(t) || [...prefixSet].some((p) => t.startsWith(p)))
  }

  private matchesFilters(
    msg: StoredMessage | undefined,
    filters: ParsedFilters,
    caller: CallerContext,
    actors: Map<string, StoredActor>,
    access: Access,
  ): boolean {
    if (!msg || !access.readable(msg.channel)) return false
    if (filters.channel !== undefined) {
      if (filters.channel.endsWith('/')) {
        const sub = filters.channel.slice(0, -1)
        if (msg.channel !== sub && !msg.channel.startsWith(`${sub}/`)) return false
      } else if (msg.channel !== filters.channel) {
        return false
      }
    }
    if (filters.re !== undefined) {
      const resolvedRe = resolveMessageId(this.store.db, filters.re)
      const reNum = resolvedRe > 0 ? resolvedRe : -1
      if (msg.id !== reNum && msg.re !== reNum) return false
    }
    if (filters.by !== undefined && !this.matchesBy(msg, filters.by, caller, actors)) return false
    if (filters.mentions !== undefined && !this.matchesMentions(msg, filters.mentions, caller, actors, access)) {
      return false
    }
    if (filters.from !== undefined && (msg.from ?? 'board') !== filters.from) return false
    if (filters.text !== undefined && !msg.text.toLowerCase().includes(filters.text.toLowerCase())) {
      return false
    }
    if (filters.label?.length) {
      const root = msg.re !== null ? this.loadStoredMessage(msg.re) : null
      for (const [k, vals] of filters.label) {
        const hasOwn = Object.hasOwn(msg.labels, k) && (vals === null || vals.includes(msg.labels[k]!))
        const hasRoot =
          root !== null &&
          Object.hasOwn(root.labels, k) &&
          (vals === null || vals.includes(root.labels[k]!))
        if (!hasOwn && !hasRoot) return false
      }
    }
    return true
  }

  private eventToView(
    ev: StoredEvent,
    actors: Map<string, StoredActor>,
    access: Access,
    snapshotMsg?: StoredMessage,
  ): BoardEventView {
    const payload = { ...ev.payload }
    delete payload.token
    delete payload.mentions
    delete payload.along
    delete payload.beforeLabels
    for (const key of ['id', 're', 'replyTo'] as const) {
      if (typeof payload[key] === 'number') payload[key] = String(payload[key])
    }
    if (Array.isArray(payload.needs)) {
      payload.needs = (payload.needs as unknown[]).map((n) => String(n))
    }
    if (Array.isArray(payload.links)) {
      // A link's snapshot of a board message shows only to who may read it (original feed.ts:97-106 viewedBy).
      payload.links = (payload.links as LinkView[]).map((link) => this.linkViewFor(link, access))
    }
    const byActorId = (ev.payload.by as { actor?: string } | undefined)?.actor
    const actorObj = byActorId ? this.actorViewFor(byActorId, actors) : null
    return {
      cursor: String(ev.index),
      type: ev.type,
      createdAt: ev.createdAt,
      payload,
      ...(snapshotMsg ? { message: this.toMessageView(snapshotMsg, actors, access) } : {}),
      ...(actorObj && byActorId ? { actor: { ...actorObj, id: byActorId } } : {}),
    }
  }

  private projectEvent(
    ev: StoredEvent,
    caller: CallerContext,
    filters: ParsedFilters,
    all: boolean,
    actors: Map<string, StoredActor>,
    access: Access,
    includeOrg = false,
  ): BoardEventView | null {
    // Org-only facts (session 'org', M2_DESIGN 2.6) stay out of the feed unless a reader of every
    // channel asks for them with all=true&include=org.
    if (ev.sessionId !== 'board' && !(all && includeOrg && access.readsAll)) return null
    // Grants, schemas and schedules are the board's records, kept apart from the feed: their events
    // name principals and can-maps that only a lister of grants may see (original feed.ts serves
    // only board events; grants live in trust.ts ACCESS_SESSION).
    if (RECORD_EVENT_TYPES.has(ev.type)) return null
    if (HIDDEN_EVENT_TYPES.has(ev.type) && !all) return null
    const hasCriteria =
      filters.channel !== undefined ||
      filters.re !== undefined ||
      filters.by !== undefined ||
      filters.mentions !== undefined ||
      filters.from !== undefined ||
      filters.text !== undefined ||
      (filters.label?.length ?? 0) > 0

    const msgId =
      ev.type === 'message.posted'
        ? ev.index
        : typeof ev.payload.id === 'number'
          ? ev.payload.id
          : null

    if (msgId === null) {
      if (ev.channel && !access.readable(ev.channel)) return null
      if (!access.readsAll || hasCriteria || !all) return null
      return this.eventToView(ev, actors, access)
    }

    const verRow = this.store.db
      .prepare('SELECT data FROM board_versions WHERE log_index = ?')
      .get(ev.index) as { data: string } | undefined
    const afterMsg = verRow ? (JSON.parse(verRow.data) as StoredMessage) : this.loadStoredMessage(msgId) ?? undefined
    const beforeRow = this.store.db
      .prepare('SELECT data FROM board_versions WHERE message_id = ? AND log_index < ? ORDER BY log_index DESC LIMIT 1')
      .get(msgId, ev.index) as { data: string } | undefined
    const beforeMsg = beforeRow ? (JSON.parse(beforeRow.data) as StoredMessage) : undefined

    const ch = afterMsg?.channel ?? beforeMsg?.channel ?? ev.channel
    if (!ch || !access.readable(ch)) return null
    if (hasCriteria) {
      const matched =
        this.matchesFilters(beforeMsg, filters, caller, actors, access) ||
        this.matchesFilters(afterMsg, filters, caller, actors, access)
      if (!matched) return null
    }
    return this.eventToView(ev, actors, access, afterMsg)
  }

  async getEvents(
    caller: CallerContext,
    rawQuery: unknown = {},
    signal?: AbortSignal,
  ): Promise<EventsPage> {
    const { caller: access, raw: rawAccess } = this.requireAdmitted(caller)
    const query = EventsQuerySchema.parse(rawQuery)
    const all = query.all ?? false
    const includeOrg = query.include === 'org'
    const filters: ParsedFilters = {
      channel: query.channel,
      re: query.re,
      by: query.by,
      mentions: query.mentions,
      label: query.label,
      from: query.from,
      text: query.text,
    }
    const actors = this.getActorsMap()

    if (query.last !== undefined) {
      // The newest `last` matches, oldest first: it looks back a page of the log at a time until it
      // has them, through EVENTS_LAST_PAGES at most, so a filter that matches little on a busy board
      // can answer fewer (original feed.ts:494-521 lastFeed, PAGE 200, LAST_PAGES 10).
      const last = Math.min(query.last, EVENTS_LAST_MAX)
      const head = headForLast(this.store.getHeadIndex())
      let projected: BoardEventView[] = []
      for (let to = head, pages = 0; to >= 1 && projected.length < last && pages < EVENTS_LAST_PAGES; pages++) {
        const from = Math.max(1, to - EVENTS_PAGE + 1)
        const { events: stretch } = this.store.getEvents({ after: from - 1, limit: to - from + 1 })
        const found: BoardEventView[] = []
        for (const ev of stretch) {
          if (ev.index > to) break
          const view = this.projectEvent(ev, caller, filters, all, actors, access, includeOrg)
          if (view) found.push(view)
        }
        projected = [...found, ...projected]
        to = from - 1
      }
      const sliced = projected.slice(-last)
      const scrubbed: BoardEventView[] = []
      const byWords = filters.text !== undefined || filters.mentions !== undefined
      for (const ev of sliced) {
        if (!ev.message) {
          scrubbed.push(ev)
          continue
        }
        const current = this.loadStoredMessage(Number(ev.message.id))
        if (!current || !access.readable(current.channel)) continue
        const currentView = this.toMessageView(current, actors, access)
        if (byWords && (currentView.deleted || currentView.text !== ev.message.text)) continue
        const payload = { ...ev.payload }
        for (const k of ['text', 'blocks', 'attachments', 'links', 'labels'] as const) {
          if (k in payload) {
            payload[k] =
              k === 'attachments' &&
              Array.isArray(payload[k]) &&
              (payload[k] as unknown[]).every((i) => typeof i === 'string')
                ? currentView.attachments.map((a) => a.id)
                : currentView[k]
          }
        }
        const settled = carriedEvent({ ...ev, payload, message: currentView })
        if (settled) scrubbed.push(settled)
      }
      return { events: scrubbed, cursor: String(head) }
    }

    const head = this.store.getHeadIndex()
    const startAfter =
      query.after !== undefined ? Math.min(cursorAt(query.after), head) : head
    const out: BoardEventView[] = []
    let cursor = startAfter
    // One page of the log after the cursor; the cursor is the last event examined, matched or not,
    // so the next poll never rescans. A full page answers at once, matches or not, so a caller reads
    // on rather than waiting (original feed.ts:564-583 pollFeed, PAGE 200).
    const { events: backlog } = this.store.getEvents({ after: cursor, limit: EVENTS_PAGE })
    for (const ev of backlog) {
      const view = this.projectEvent(ev, caller, filters, all, actors, access, includeOrg)
      cursor = ev.index
      if (view) out.push(view)
    }

    const waitMs = Math.round((query.wait ?? 0) * 1000)
    if (out.length > 0 || backlog.length === EVENTS_PAGE || waitMs <= 0 || signal?.aborted) {
      return { events: out, cursor: String(cursor) }
    }

    // Woken by this store's own commits, and by a look at the log's head every
    // EVENTS_WAIT_POLL_MS for a commit another connection or process made to the same database,
    // which no in-process listener hears. Each look reads on from the cursor, so no event between
    // two wakes is skipped (original feed.ts:582-595 pollFeed reads the shared log).
    return new Promise<EventsPage>((resolve, reject) => {
      let done = false
      const stop = (): boolean => {
        if (done) return false
        done = true
        clearTimeout(timer)
        clearInterval(poll)
        unsub()
        signal?.removeEventListener('abort', finish)
        return true
      }
      const finish = (): void => {
        if (stop()) resolve({ events: out, cursor: String(cursor) })
      }
      const look = (): void => {
        if (done) return
        try {
          if (this.store.getHeadIndex() <= cursor) return
          const { events: next } = this.store.getEvents({ after: cursor, limit: EVENTS_PAGE })
          const latestActors = this.getActorsMap()
          const liveAccess = this.withPrivateAcl(caller, rawAccess)
          for (const ev of next) {
            // The cursor passes an event only once it has been looked at (original feed.ts:588-589).
            const view = this.projectEvent(ev, caller, filters, all, latestActors, liveAccess, includeOrg)
            cursor = ev.index
            if (view) out.push(view)
          }
          if (out.length > 0 || next.length === EVENTS_PAGE) finish()
        } catch (error) {
          // The store closed or failed under the wait: answer what there is, cursor where it got to.
          // Anything else is a fault here, not the store's, and is the caller's error, as the
          // original's pollFeed throws what its feed.step throws (feed.ts:584-592).
          if (isStoreFailure(error)) finish()
          else if (stop()) reject(error)
        }
      }
      const unsub = this.store.onEvent((ev) => {
        if (ev.index > cursor) look()
      })
      const timer = setTimeout(finish, waitMs)
      const poll = setInterval(look, this.eventsWaitPollMs)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  // ==========================================================================
  // F5: Grants, Schemas, Schedules, Attachments, Watchers, Sync
  // ==========================================================================

  /**
   * Whether `caller` may list the grants: manage at `*`, the owner included, as far as its
   * `x-board-can` allows (original server/trust.ts:189-198 lists/mayList).
   */
  private listsGrants(access: Access): boolean {
    return access.at('manage', '*')
  }

  private mayListGrants(access: Access, what: string): void {
    if (!this.listsGrants(access)) throw forbidden(`this token can't ${what}: it needs manage at *`)
  }

  /** The next grant's sequence number: monotonic, so a revoked grant's ID is never issued again (trust.ts:56-71). */
  private nextGrantSeq(existing: readonly StoredGrant[]): number {
    const row = this.store.db.prepare("SELECT value FROM board_meta WHERE key = 'next_grant'").get() as
      | { value?: string }
      | undefined
    const stored = row?.value !== undefined ? Number(row.value) : 0
    return Math.max(stored, existing.reduce((max, g) => Math.max(max, g.seq), 0) + 1)
  }

  private saveNextGrantSeq(next: number): void {
    this.store.db
      .prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('next_grant', ?)")
      .run(String(next))
  }

  /**
   * What a grant write is judged by on `before`, and where a lockout is judged, on `left`: null for an
   * owner no `x-board-can` narrows (trust.ts:220-249 changerAccess/standingOf).
   */
  private grantStanding(
    caller: CallerContext,
    before: readonly StoredGrant[],
    left?: readonly StoredGrant[],
  ): GrantStanding | null {
    const { principal } = caller
    if (principal.owner === true) {
      if (caller.canHeader === undefined) return null
      const scoped = grantAccessForCaller(principal, before, caller.canHeader).caller
      return { caller: scoped, own: scoped, ...(left !== undefined ? { then: { caller: scoped, own: scoped } } : {}) }
    }
    const now = grantAccessForCaller(principal, before, caller.canHeader)
    const own = grantAccessForCaller(principal, withoutEveryone(before), caller.canHeader)
    if (!now.admits) throw forbidden("this token can't change grants: it may do nothing on this board")
    const standing: GrantStanding = { caller: now.caller, own: own.admits ? own.caller : NO_ACCESS }
    if (left === undefined) return standing
    const thenAll = grantAccessForCaller(principal, left, caller.canHeader)
    const thenOwn = grantAccessForCaller(principal, withoutEveryone(left), caller.canHeader)
    return {
      ...standing,
      then: {
        caller: thenAll.admits ? thenAll.caller : NO_ACCESS,
        own: thenOwn.admits ? thenOwn.caller : NO_ACCESS,
      },
    }
  }

  /** A refusal unless `standing` may change grants so (trust.ts:262-282 judge). */
  private judgeGrant(
    lists: boolean,
    standing: GrantStanding | null,
    change: { changed?: { can: WrittenCan }; revoked?: { can: WrittenCan } },
    after: readonly StoredGrant[],
    { what, doing }: GrantNamed = THIS_GRANT,
  ): void {
    if (standing === null) return
    const refused = checkGrantChange({ ...standing, after, ...change })
    if (refused?.reason === 'reach') {
      if (change.revoked && !lists) throw unreachableGrant(what)
      throw forbidden(
        `${change.revoked ? `this token can't ${what}: it` : what} reaches ${refused.pattern}, where you can't manage grants`,
      )
    }
    if (refused?.reason === 'lockout') {
      const where = change.revoked && !lists ? 'where it reaches' : `in ${refused.pattern}`
      throw conflict(`${doing} would leave you unable to manage grants ${where}`, 'grant_lockout', {
        hint: 'Name yourself with manage there, in a grant made before it or in the same write. Or send lockMeOut to go ahead: only someone who still manages grants there could change it then.',
      })
    }
    if (refused) {
      throw forbidden(
        `you can't let anyone in: everyone gets ${refused.permission} in ${refused.pattern}, which you can't`,
      )
    }
  }

  listGrants(caller: CallerContext): GrantView[] {
    const { caller: access } = this.requireAdmitted(caller)
    this.mayListGrants(access, 'list grants')
    return this.loadGrants().map(grantView)
  }

  createGrant(caller: CallerContext, rawInput: unknown): GrantView {
    const body = GrantBodySchema.parse(rawInput)
    const created = this.createGrants(caller, {
      grants: [{ principals: body.principals, can: body.can }],
      ...(body.lockMeOut !== undefined ? { lockMeOut: body.lockMeOut } : {}),
    })
    return created[0]!
  }

  createGrants(caller: CallerContext, rawInput: unknown): GrantView[] {
    const { caller: access } = this.requireAdmitted(caller)
    const body = CreateGrantsBodySchema.parse(rawInput)
    const lists = this.listsGrants(access)

    return this.tx(() => {
      const existing = this.loadGrants()
      let nextSeq = this.nextGrantSeq(existing)
      const now = new Date(this.nowMs()).toISOString()
      const created: StoredGrant[] = []
      for (const spec of body.grants) {
        const checked = checkGrantSpec(spec, grantIssuers([...existing, ...created]), this.logins)
        created.push({ id: `g${nextSeq}`, seq: nextSeq++, ...checked, by: caller.actor.id, at: now })
      }

      const afterAll = [...existing, ...created]
      const standing = this.grantStanding(caller, existing, body.lockMeOut ? undefined : afterAll)
      created.forEach((g, at) => {
        const named: GrantNamed =
          created.length === 1
            ? THIS_GRANT
            : { what: `grant ${at + 1} of ${created.length}`, doing: `grant ${at + 1} of ${created.length}` }
        this.judgeGrant(lists, standing, { changed: { can: g.can } }, afterAll, named)
        // Naming an oidc issuer makes the board trust its tokens: it takes manage everywhere (trust.ts:297-299,394).
        if (g.principals.some((p) => p.kind === 'oidc')) {
          this.judgeGrant(
            lists,
            standing && { caller: standing.caller, own: standing.own },
            { changed: { can: { '*': 'all' } } },
            afterAll,
            NAMING_ISSUER,
          )
        }
      })

      const stmt = this.store.db.prepare(
        `INSERT INTO board_grants (id, seq, principals_json, can_json, by_actor, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const g of created) {
        stmt.run(g.id, g.seq, JSON.stringify(g.principals), JSON.stringify(g.can), g.by, g.at)
        this.store.appendEvent({
          type: 'grant.created',
          payload: { id: g.id, principals: g.principals, can: g.can, by: caller.actor.id },
          createdAt: now,
        })
      }
      this.saveNextGrantSeq(nextSeq)
      return created.map(grantView)
    })
  }

  updateGrant(caller: CallerContext, grantId: string, rawInput: unknown): GrantView {
    const { caller: access } = this.requireAdmitted(caller)
    const body = UpdateGrantBodySchema.parse(rawInput)
    const lists = this.listsGrants(access)

    return this.tx(() => {
      const existing = this.loadGrants()
      const idx = existing.findIndex((g) => g.id === grantId)
      if (idx < 0) {
        // One that isn't there is only news to whoever may list them (trust.ts:308-314).
        if (!lists) throw unreachableGrant(`update ${grantId}`)
        throw notFound(`grant not found: ${grantId}`, 'grant_not_found')
      }
      const target = existing[idx]!
      const others = existing.filter((g) => g.id !== grantId)
      const named: GrantNamed = { what: `update ${grantId}`, doing: `updating ${grantId}` }
      // Reach first, before any removal is checked: whom it names is only news to someone who may change it.
      this.judgeGrant(lists, this.grantStanding(caller, existing), { revoked: { can: target.can } }, others, named)

      const trusted = grantIssuers(others)
      let principals = [...target.principals]
      for (const input of body.remove ?? []) {
        const removal = checkPrincipal(input, trusted, true, this.logins)
        const kept = principals.filter((p) => !removesPrincipal(removal, p))
        if (kept.length === principals.length) {
          throw badRequest(`${grantId} doesn't name that ${removal.kind} principal`, 'not_in_grant')
        }
        principals = kept
      }
      for (const input of body.add ?? []) {
        const added = checkPrincipal(input, [...trusted, ...grantIssuers([{ principals }])], false, this.logins)
        const at = principals.findIndex((p) => joinedPrincipal(added, p) !== null)
        if (at === -1) principals.push(added)
        else principals[at] = joinedPrincipal(added, principals[at]!)!
      }
      if (principals.length === 0) {
        throw badRequest(`that leaves ${grantId} naming no one: revoke it instead`, 'grant_empty')
      }
      if (principals.length > GRANT_PRINCIPALS_MAX) {
        throw invalidGrant(`a grant names at most ${GRANT_PRINCIPALS_MAX} principals`)
      }

      const nextCan = body.can !== undefined ? checkCan(body.can) : target.can
      const now = new Date(this.nowMs()).toISOString()
      const updated: StoredGrant = { ...target, principals, can: nextCan, by: caller.actor.id, at: now }
      const afterAll = existing.map((g, i) => (i === idx ? updated : g))
      // As it was, it's lifted, so it's judged by reach; adding principals or setting `can` widens it too.
      const widens = body.add !== undefined || body.can !== undefined
      const standing = this.grantStanding(caller, existing, body.lockMeOut ? undefined : afterAll)
      this.judgeGrant(
        lists,
        standing,
        { revoked: { can: target.can }, ...(widens ? { changed: { can: nextCan } } : {}) },
        afterAll,
        named,
      )
      const before = new Set(target.principals.map(principalKey))
      if (principals.some((p) => p.kind === 'oidc' && !before.has(principalKey(p)))) {
        this.judgeGrant(
          lists,
          standing && { caller: standing.caller, own: standing.own },
          { changed: { can: { '*': 'all' } } },
          afterAll,
          NAMING_ISSUER,
        )
      }

      this.store.db
        .prepare(
          'UPDATE board_grants SET principals_json = ?, can_json = ?, by_actor = ?, updated_at = ? WHERE id = ?',
        )
        .run(JSON.stringify(principals), JSON.stringify(nextCan), caller.actor.id, now, grantId)
      this.store.appendEvent({
        type: 'grant.updated',
        payload: { id: grantId, principals, can: nextCan, by: caller.actor.id },
        createdAt: now,
      })
      return grantView(updated)
    })
  }

  revokeGrant(caller: CallerContext, grantId: string, rawInput?: unknown): { revoked: boolean } {
    const { caller: access } = this.requireAdmitted(caller)
    const body = RevokeGrantBodySchema.parse(rawInput)
    const lists = this.listsGrants(access)

    return this.tx(() => {
      const existing = this.loadGrants()
      const target = existing.find((g) => g.id === grantId)
      if (!target) {
        // One that isn't there is only news to whoever may list them (trust.ts:456-465).
        if (!lists) throw unreachableGrant(`revoke ${grantId}`)
        return { revoked: false }
      }
      const afterAll = existing.filter((g) => g.id !== grantId)
      this.judgeGrant(
        lists,
        this.grantStanding(caller, existing, body?.lockMeOut ? undefined : afterAll),
        { revoked: { can: target.can } },
        afterAll,
        { what: `revoke ${grantId}`, doing: `revoking ${grantId}` },
      )

      this.store.db.prepare('DELETE FROM board_grants WHERE id = ?').run(grantId)
      this.store.appendEvent({
        type: 'grant.deleted',
        createdAt: new Date(this.nowMs()).toISOString(),
        payload: { id: grantId, by: caller.actor.id },
      })
      return { revoked: true }
    })
  }

  /**
   * The principal an explain query names, as a token of its would make it (trust.ts:139-179): a
   * person by user ID, a project's deployment by `prj_…` in one environment (production unless it
   * says), a repository's run on a branch (main unless it says), or an issuer's token with its claims.
   */
  private explainedPrincipal(query: ReturnType<typeof ExplainQuerySchema.parse>): CallerPrincipal {
    if (query.user !== undefined) {
      let userId = query.user
      if (userId.includes('@')) {
        if (!this.logins) {
          throw badRequest(`this board can't look up ${userId}: it verifies tokens itself, so name the user by ID`)
        }
        userId = userId.toLowerCase()
      }
      return { id: `user:${userId}`, kind: 'user', handle: userId, userId, member: true }
    }
    if (query.project !== undefined) {
      if (!PROJECT_ID.test(query.project)) {
        throw badRequest(
          `this board can't look up the project ${query.project}: it verifies tokens itself, so name it by ID, prj_…`,
        )
      }
      const environment = query.environment ?? 'production'
      return {
        id: `project:${query.project}:${environment}`,
        kind: 'project',
        handle: query.project,
        projectId: query.project,
        environment,
        teamProject: true,
      }
    }
    if (query.github !== undefined) {
      const repository = query.github
      const branch = query.branch ?? 'main'
      return {
        id: `github:repo:${repository}`,
        kind: 'github',
        handle: repository,
        repository,
        ref: `refs/heads/${branch}`,
        ...(query.workflow !== undefined
          ? { workflowRef: `${repository}/${workflowPath(query.workflow)}@refs/heads/${branch}` }
          : {}),
        ...(query.event !== undefined ? { event: query.event } : {}),
      }
    }
    const issuer = query.oidc!
    const claims: Record<string, string> = {}
    for (const pair of query.claim ?? []) {
      const at = pair.indexOf('=')
      if (at <= 0) throw badRequest(`a claim is name=value, and ${pair} isn't one`)
      claims[pair.slice(0, at)] = pair.slice(at + 1)
    }
    let name: string
    try {
      name = issuerName(issuer)
    } catch {
      throw badRequest(`an oidc issuer is an https URL, got ${issuer}`)
    }
    return {
      id: `oidc:${name}:${claims.sub ?? 'explain'}`,
      kind: 'oidc',
      handle: claims.sub ?? 'oidc',
      issuer,
      claims,
    }
  }

  explainAccess(caller: CallerContext, rawQuery: unknown): Explanation {
    const { caller: access } = this.requireAdmitted(caller)
    const query = ExplainQuerySchema.parse(rawQuery)
    const named =
      query.user !== undefined ||
      query.project !== undefined ||
      query.github !== undefined ||
      query.oidc !== undefined ||
      query.app !== undefined
    const lists = this.listsGrants(access)
    // What anyone else may do shows the grants, which only those who may list them see (trust.ts:430-433).
    if (named && !lists) {
      throw forbidden("this token can't explain what another principal may do: it needs manage at *")
    }
    const nothing: Explanation = {
      channel: query.channel,
      pattern: null,
      over: [],
      level: null,
      grants: [],
      capped: null,
      can: [],
    }
    // A board that verifies tokens itself has no apps, so nothing lets one in (trust.ts:434-435).
    if (query.app !== undefined) return nothing
    const grants = this.loadGrants()
    const targetPrincipal: CallerPrincipal = named ? this.explainedPrincipal(query) : caller.principal

    const matched: MatchedGrant<StoredGrant>[] = []
    for (const grant of grants) {
      let best: Level | null = null
      for (const p of grant.principals) {
        const lv = levelOfPrincipal(p, { caller: targetPrincipal })
        if (lv !== null && (best === null || LEVEL_RANK[lv] < LEVEL_RANK[best])) best = lv
      }
      if (best !== null) matched.push({ level: best, can: grant.can, source: grant })
    }
    const admits =
      targetPrincipal.kind === 'deployment' ||
      targetPrincipal.owner === true ||
      (targetPrincipal.kind === 'user' && targetPrincipal.member === true) ||
      matched.some((m) => m.level !== 'everyone')

    if (!admits) return nothing

    const isFixedOwner = targetPrincipal.kind === 'deployment' || targetPrincipal.owner === true
    const decision = isFixedOwner
      ? { pattern: null, over: [] as string[], level: null, sources: [] as StoredGrant[], permissions: [...PERMISSIONS] }
      : decideChannel(matched, query.channel)
    const token =
      targetPrincipal === caller.principal && caller.canHeader !== undefined
        ? compileAccess(headerCan(caller.canHeader))
        : null
    const basePerms = isFixedOwner ? [...PERMISSIONS] : [...decision.permissions]
    const cap = targetPrincipal.cap ? compileAccess({ '*': [...targetPrincipal.cap] }) : null
    const cappedPerms = cap ? basePerms.filter((p) => cap.can(p, query.channel)) : basePerms
    const finalPerms = token ? cappedPerms.filter((p) => token.can(p, query.channel)) : cappedPerms

    return {
      channel: query.channel,
      pattern: decision.pattern,
      over: decision.over,
      level: decision.level,
      // A grant names whom else it lets in: only those who may list grants see which decided (trust.ts:440-441).
      grants: lists ? decision.sources.map(grantView) : [],
      // `capped` names the team role that caps a person (api/routes.ts:858,868); an x-board-can
      // narrowing is no role, and a board without roles answers null (trust.ts:451-452).
      capped: cappedPerms.length < basePerms.length ? 'role' : null,
      can: finalPerms,
    }
  }

  // Schemas (F5)
  listSchemas(caller: CallerContext): SchemaView[] {
    this.requireAdmitted(caller)
    const rows = this.store.db
      .prepare(
        'SELECT id, name, version, description, schema_json, by_actor, created_at FROM board_schemas ORDER BY name ASC, version ASC',
      )
      .all() as Array<{
      id: string
      name: string
      version: number
      description: string | null
      schema_json: string
      by_actor: string
      created_at: string
    }>
    const views = rows.map((r) => ({
      id: r.id,
      name: r.name,
      version: Number(r.version),
      description: r.description,
      schema: JSON.parse(r.schema_json) as Record<string, unknown>,
      builtIn: isBuiltInSchemaName(r.name),
      by: isBuiltInSchemaName(r.name) ? null : r.by_actor,
      at: isBuiltInSchemaName(r.name) ? null : r.created_at,
    }))
    // The built-ins, in their own order, then the board's own by name and version
    // (original server/schemas.ts:50-52 `[...builtIns, ...own]`).
    const builtInAt = (name: string): number => BUILT_IN_SCHEMAS.findIndex((s) => s.name === name)
    return [
      ...views.filter((v) => v.builtIn).sort((a, b) => builtInAt(a.name) - builtInAt(b.name) || a.version - b.version),
      ...views.filter((v) => !v.builtIn),
    ]
  }

  getSchema(caller: CallerContext, id: string): SchemaView {
    this.requireAdmitted(caller)
    if (!parseSchemaId(id)) {
      throw badRequest(`invalid schema id: ${id}`, 'invalid_schema_id')
    }
    const row = this.store.db
      .prepare(
        'SELECT id, name, version, description, schema_json, by_actor, created_at FROM board_schemas WHERE id = ?',
      )
      .get(id) as
      | {
          id: string
          name: string
          version: number
          description: string | null
          schema_json: string
          by_actor: string
          created_at: string
        }
      | undefined
    if (!row) throw notFound(`schema not found: ${id}`, 'schema_not_found')
    return {
      id: row.id,
      name: row.name,
      version: Number(row.version),
      description: row.description,
      schema: JSON.parse(row.schema_json) as Record<string, unknown>,
      builtIn: isBuiltInSchemaName(row.name),
      by: isBuiltInSchemaName(row.name) ? null : row.by_actor,
      at: isBuiltInSchemaName(row.name) ? null : row.created_at,
    }
  }

  createSchema(caller: CallerContext, rawInput: unknown): SchemaView & { created: boolean } {
    const { caller: access } = this.requireAdmitted(caller)
    // The body is the request's, checked before anything about the caller, as the original's route
    // parses it before its handler runs (original api/routes.ts:520-525 SchemaBody).
    const input = SchemaBodySchema.parse(rawInput)
    // A schema is the whole board's: registering one takes manage at * (original server/schemas.ts:62-63).
    if (!access.at('manage', '*')) {
      throw forbidden("this token can't register schemas: it needs manage at *")
    }
    // A name or version out of range is the request's, said as the original says it; `invalid_schema`
    // is for a definition checkDefinition refuses (original server/schemas.ts:63-64).
    if (!SCHEMA_NAME_REGEX.test(input.name)) {
      throw badRequest(
        `name: a schema name is up to ${SCHEMA_NAME_MAX} lowercase letters, numbers, and ._-, starting with a letter`,
      )
    }
    if (input.version > SCHEMA_VERSION_MAX) {
      throw badRequest(`version: a schema version is at most ${SCHEMA_VERSION_MAX.toLocaleString('en-US')}`)
    }
    if (input.description !== undefined && input.description.length > SCHEMA_DESCRIPTION_MAX) {
      throw badRequest(
        `description: a schema description is at most ${SCHEMA_DESCRIPTION_MAX.toLocaleString('en-US')} characters`,
      )
    }
    if (isBuiltInSchemaName(input.name)) {
      throw conflict(`${input.name} is a built-in schema: register yours under another name`, 'reserved_schema')
    }
    const problem = checkSchemaDefinition(input.schema)
    if (problem !== null) {
      throw badRequest(problem, 'invalid_schema')
    }

    const id = `${input.name}@${input.version}`
    const canon = canonicalJson(input.schema)

    return this.tx(() => {
      const existing = this.store.db
        .prepare(
          'SELECT id, name, version, description, schema_json, canonical_json, by_actor, created_at FROM board_schemas WHERE id = ?',
        )
        .get(id) as
        | {
            id: string
            name: string
            version: number
            description: string | null
            schema_json: string
            canonical_json: string
            by_actor: string
            created_at: string
          }
        | undefined
      if (existing) {
        // Which part differs, so the answer says why (original server/schemas.ts:75-86).
        const description = input.description ?? null
        const differs =
          existing.canonical_json !== canon
            ? 'definition'
            : existing.description !== description
              ? 'description'
              : null
        if (differs !== null) {
          throw conflict(
            `${id} is registered with another ${differs}, and a version never changes: register a new version`,
            'schema_immutable',
          )
        }
        return {
          id: existing.id,
          name: existing.name,
          version: Number(existing.version),
          description: existing.description,
          schema: JSON.parse(existing.schema_json) as Record<string, unknown>,
          builtIn: false,
          by: existing.by_actor,
          at: existing.created_at,
          created: false,
        }
      }

      // Every registered version counts, whoever registered it; only the built-ins don't.
      const names = this.store.db.prepare('SELECT name FROM board_schemas').all() as Array<{ name: string }>
      if (names.filter((r) => !isBuiltInSchemaName(r.name)).length >= SCHEMAS_MAX) {
        throw badRequest(`a board registers at most ${SCHEMAS_MAX} schema versions`, 'too_many_schemas')
      }

      const now = new Date(this.nowMs()).toISOString()
      this.store.db
        .prepare(
          `INSERT INTO board_schemas (id, name, version, description, schema_json, canonical_json, by_actor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.version,
          input.description ?? null,
          JSON.stringify(input.schema),
          canon,
          caller.actor.id,
          now,
        )
      this.store.appendEvent({
        type: 'schema.created',
        payload: { id, name: input.name, version: input.version, by: caller.actor.id },
        createdAt: now,
      })
      return {
        id,
        name: input.name,
        version: input.version,
        description: input.description ?? null,
        schema: input.schema,
        builtIn: false,
        by: caller.actor.id,
        at: now,
        created: true,
      }
    })
  }

  // Schedules (F5)
  /** What the board keeps beside a schedule: who sends it, and whether they could read its channel when they made it. */
  private scheduleMeta(id: string): { principal: CallerPrincipal; canHeader?: string; blind?: boolean } | null {
    const row = this.store.db
      .prepare('SELECT value FROM board_meta WHERE key = ?')
      .get(`schedule_principal:${id}`) as { value?: string } | undefined
    return row?.value ? (JSON.parse(row.value) as { principal: CallerPrincipal; canHeader?: string; blind?: boolean }) : null
  }

  /**
   * Whether the caller is the schedule's creator, as far as seeing and canceling it goes: it wrote
   * it (a profile only what was scheduled as it, its principal all of them), may post there now,
   * and reads there unless it was created without reading too (original schedules.ts:144-153 createdBy).
   */
  private scheduleCreatedBy(schedule: ScheduleView, blind: boolean, caller: CallerContext, access: Access): boolean {
    const wroteAs =
      schedule.by.principal === caller.principal.id &&
      (caller.actor.id === caller.principal.id || schedule.by.actor === caller.actor.id)
    return wroteAs && access.can('post', schedule.channel) && (blind || access.readable(schedule.channel))
  }

  /** A schedule as its creator sees it where it can't read: its text as a blind writer's message's is (original a2.ts:160-161). */
  private blindSchedule(schedule: ScheduleView, access: Access, ownActorId: string): ScheduleView {
    return access.readable(schedule.channel) ? schedule : { ...schedule, text: blindText(schedule.text, ownActorId) }
  }

  /**
   * Schedules a post as the caller: checked now, where the caller sees it, as a post is (text and
   * file limits, `post` there, `label` for its labels, no reserved labels, files it may have), and
   * again at every send. Its times stay within a year (original a2.ts:607-615, schedules.ts:409-436).
   */
  createSchedule(
    caller: CallerContext,
    rawInput: unknown,
    nowMs: number = this.nowMs(),
  ): ScheduleView & { mentions?: Mentioned[] } {
    const { caller: access } = this.requireAdmitted(caller)
    const preText = (rawInput as { text?: unknown } | null)?.text
    if (typeof preText === 'string' && preText.length > MESSAGE_TEXT_MAX) {
      throw textTooLong()
    }
    const input = ScheduleBodySchema.parse(rawInput)
    checkAttachmentCount(input.attachments)
    for (const k of Object.keys(input.labels ?? {})) {
      if (k.startsWith(RESERVED_LABEL_PREFIX)) {
        throw reservedLabel(k)
      }
    }
    this.checkBlocks(input.text)

    const everyMs = input.every ? parseDurationMs(input.every) : null
    if (everyMs !== null && everyMs < MIN_EVERY_MS) throw badRequest('`every` is at least 1m')
    if (everyMs !== null && everyMs > MAX_AHEAD_MS) throw badRequest('`every` is at most a year')
    const firstMs =
      input.at !== undefined ? Date.parse(input.at) : nowMs + parseDurationMs(input.in ?? input.every!)
    if (firstMs < nowMs - 60_000) throw badRequest('`at` is in the past')
    const untilMs =
      input.until !== undefined
        ? Date.parse(input.until)
        : input.for !== undefined
          ? firstMs + parseDurationMs(input.for)
          : null
    if (untilMs !== null && untilMs < firstMs) throw badRequest('the schedule stops before its first send')
    if (firstMs > nowMs + MAX_AHEAD_MS || (untilMs !== null && untilMs > nowMs + MAX_AHEAD_MS)) {
      throw badRequest('a schedule reaches at most a year out: its first send and its stop')
    }

    let channel: string
    let re: number | null = null
    if (input.re !== undefined) {
      const targetId = resolveMessageId(this.store.db, input.re)
      const target = targetId > 0 ? this.loadStoredMessage(targetId) : null
      if (!target) throw this.messageNotFoundError(input.re)()
      authorizeChannel(access, 'read', target.channel, this.messageNotFoundError(input.re))
      authorizeChannel(access, 'post', target.channel)
      // A reply to a deleted thread would never send.
      if (target.deleted) throw this.messageNotFoundError(input.re)()
      channel = target.channel
      re = target.re ?? target.id
    } else {
      channel = input.channel!
      authorizeChannel(access, 'post', channel)
    }
    if (Object.keys(input.labels ?? {}).length > 0) authorizeChannel(access, 'label', channel)
    const blind = !access.readable(channel)

    return this.tx(() => {
      const attachments = this.attachmentsFor(access, caller.principal.id, input.attachments)
      // Its `@handle`s are settled now, where its creator sees them, and the answer says what
      // became of each, as a post's does (original serve.ts:675-676 settling, :543-550).
      const settled = this.settleFor(access, caller, input.text, re)

      const maxSeqRow = this.store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM board_schedules').get() as {
        m: number
      }
      const seq = Number(maxSeqRow.m) + 1
      const id = `s${seq}`
      const nowIso = new Date(nowMs).toISOString()
      const view: ScheduleView = {
        id,
        channel,
        re: re === null ? null : String(re),
        text: settled.text,
        labels: { ...(input.labels ?? {}) },
        noSync: input.noSync ?? false,
        attachments,
        first: new Date(firstMs).toISOString(),
        every: everyMs,
        until: untilMs === null ? null : new Date(untilMs).toISOString(),
        times: input.times ?? null,
        sent: 0,
        next: new Date(firstMs).toISOString(),
        last: null,
        state: 'pending',
        canceled: null,
        by: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
        author: {
          kind: caller.actor.kind,
          handle: caller.actor.handle,
          name: caller.actor.name,
          avatar: caller.actor.avatar,
          ...(caller.actor.via ? { via: caller.actor.via } : {}),
        },
        createdAt: nowIso,
      }
      this.store.db
        .prepare(
          `INSERT INTO board_schedules (id, seq, channel, re, by_actor, by_principal, next_at, state, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          id,
          seq,
          channel,
          re,
          caller.actor.id,
          caller.principal.id,
          firstMs,
          JSON.stringify(view),
        )
      // Kept as it is, flags and all: what it may do is worked out again at every send (runDueSchedules).
      const storedPrincipal: CallerPrincipal = { ...caller.principal }
      this.store.db
        .prepare('INSERT OR REPLACE INTO board_meta (key, value) VALUES (?, ?)')
        .run(
          `schedule_principal:${id}`,
          JSON.stringify({
            principal: storedPrincipal,
            ...(caller.canHeader !== undefined ? { canHeader: caller.canHeader } : {}),
            ...(blind ? { blind: true } : {}),
          }),
        )
      this.store.appendEvent({
        type: 'schedule.created',
        channel,
        payload: { id, channel, re, first: view.first, ...(blind ? { blind: true } : {}) },
        createdAt: nowIso,
      })
      return settled.mentions.length > 0 ? { ...view, mentions: settled.mentions } : view
    })
  }

  /**
   * The schedules the caller may see: those in channels it reads, and its own, which it may post
   * without reading. `re` names any message of a thread it reads; `by` an actor ID, a handle (in
   * any case), or `me` (original a2.ts:616-627, schedules.ts:381-395).
   */
  listSchedules(caller: CallerContext, rawQuery: unknown = {}): ScheduleView[] {
    const { caller: access } = this.requireAdmitted(caller)
    const query = SchedulesQuerySchema.parse(rawQuery)
    let root: number | undefined
    if (query.re !== undefined) {
      const at = resolveMessageId(this.store.db, query.re)
      const found = at > 0 ? this.loadStoredMessage(at) : null
      if (!found) throw this.messageNotFoundError(query.re)()
      authorizeChannel(access, 'read', found.channel, this.messageNotFoundError(query.re))
      root = found.re ?? found.id
    }
    const by = query.by === 'me' ? caller.actor.id : query.by
    const rows = this.store.db.prepare('SELECT data FROM board_schedules ORDER BY seq ASC').all() as Array<{
      data: string
    }>
    const out: ScheduleView[] = []
    for (const r of rows) {
      const s = JSON.parse(r.data) as ScheduleView
      const blind = this.scheduleMeta(s.id)?.blind === true
      if (!access.readable(s.channel) && !this.scheduleCreatedBy(s, blind, caller, access)) continue
      if (!query.all && s.state !== 'pending') continue
      if (query.channel !== undefined && s.channel !== query.channel) continue
      if (root !== undefined && s.re !== String(root)) continue
      if (by !== undefined && s.by.actor !== by && s.author.handle.toLowerCase() !== by.toLowerCase()) continue
      out.push(this.blindSchedule(s, access, caller.actor.id))
    }
    return out
  }

  /**
   * Its creator may cancel it while they can post there, and so may `manage` in its channel.
   * Anyone else gets 403 where they can read it, and 404 where they can't. Canceling twice is a
   * no-op, which `canceled: false` says (original schedules.ts:465-483, a2.ts:628-632).
   */
  cancelSchedule(caller: CallerContext, scheduleId: string): { schedule: ScheduleView; canceled: boolean } {
    const { caller: access } = this.requireAdmitted(caller)
    // `s12`, and `12` from a client that strips the `s`, and `ss12` from an older CLI that adds one
    // to what the board hands out, all name schedule 12 (original a2.ts:102-111 scheduleAt).
    const bare = scheduleId.replace(/^s{1,2}/, '')
    const seq = indexOf(bare)
    const missing = (): BoardError => notFound(`schedule not found: s${bare}`, 'schedule_not_found')
    if (seq === null || seq === 0) throw missing()
    return this.tx(() => {
      const row = this.store.db
        .prepare('SELECT data FROM board_schedules WHERE seq = ?')
        .get(seq) as { data: string } | undefined
      if (!row) throw missing()
      const sched = JSON.parse(row.data) as ScheduleView
      const blind = this.scheduleMeta(sched.id)?.blind === true
      if (!this.scheduleCreatedBy(sched, blind, caller, access)) {
        authorizeChannel(access, 'manage', sched.channel, missing)
      }
      const canceled = sched.state === 'pending'
      if (canceled) {
        sched.state = 'canceled'
        sched.next = null
        sched.canceled = {
          by: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
          reason: 'canceled',
        }
        this.store.db
          .prepare("UPDATE board_schedules SET state = 'canceled', next_at = NULL, data = ? WHERE id = ?")
          .run(JSON.stringify(sched), sched.id)
        this.store.appendEvent({
          type: 'schedule.canceled',
          createdAt: new Date(this.nowMs()).toISOString(),
          channel: sched.channel,
          payload: { id: sched.id, reason: 'canceled' },
        })
      }
      return { schedule: this.blindSchedule(sched, access, caller.actor.id), canceled }
    })
  }

  /**
   * The board's own scheduler tick: makes each send due by `nowMs`, one schedule at a time, as its
   * creator with what it may do now. No caller makes it: the original sends schedules only from its
   * own scheduler (schedules.ts:23-26, :252-300) and has no route that fires one, so no principal
   * can send someone else's schedule early or read back what it sent. The server's timer calls it.
   *
   * A send the board refuses for good (403/404: revoked; any other 4xx, whose text and labels never
   * change: dropped) cancels its schedule instead of failing every tick. Any other failure leaves
   * the schedule pending for the next tick and holds back no other: every send that went out is in
   * `sent`, and every one that didn't is in `failed`. Each send posts with an ID of its own
   * (schedule, n), so a retry gets back the message it already posted.
   */
  runDueSchedules(nowMs: number = this.nowMs(), opts: { shouldContinue?: () => boolean } = {}): ScheduleRun {
    const dueRows = this.store.db
      .prepare(
        "SELECT id, next_at FROM board_schedules WHERE state = 'pending' AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at ASC, seq ASC",
      )
      .all(nowMs) as Array<{ id: string; next_at: number }>

    const run: ScheduleRun = { sent: [], failed: [], skipped: [], stopped: false }
    for (const r of dueRows) {
      if (opts.shouldContinue) {
        // A throwing callback must not turn the sends that already committed into an error (rule 10).
        let go = false
        try {
          go = opts.shouldContinue() === true
        } catch {
          go = false
        }
        if (!go) {
          run.stopped = true
          break
        }
      }
      try {
        const firedMsg = this.fireScheduleInTx(r.id, Number(r.next_at), nowMs)
        if (firedMsg === 'skipped') run.skipped.push(r.id)
        else if (firedMsg) run.sent.push(firedMsg)
      } catch (err) {
        run.failed.push({ schedule: r.id, error: normalizeError(err) })
      }
    }
    return run
  }

  private fireScheduleInTx(scheduleId: string, selectedNextAt: number, nowMs: number): MessageView | 'skipped' | null {
    return this.tx(() => {
      const freshRow = this.store.db
        .prepare('SELECT seq, state, next_at, data FROM board_schedules WHERE id = ?')
        .get(scheduleId) as { seq: number; state: string; next_at: number | null; data: string } | undefined
      // C7: is it still this tick's send? A ticker that sent it moved next_at on (or finished or canceled it).
      // The original's stale-timer guard (schedules.ts:248). The tick lease is not the correctness guard.
      if (!freshRow || freshRow.state !== 'pending' || freshRow.next_at === null) return 'skipped'
      if (Number(freshRow.next_at) !== selectedNextAt) return 'skipped'
      const sched = JSON.parse(freshRow.data) as ScheduleView
      if (sched.state !== 'pending') return 'skipped'

      const cancelScheduleInTx = (reason: 'thread_deleted' | 'dropped' | 'revoked'): null => {
        sched.state = 'canceled'
        sched.next = null
        sched.canceled = {
          by: { actor: SCHEDULE_ACTOR_ID, principal: SCHEDULE_ACTOR_ID, profile: null },
          reason,
        }
        this.store.db
          .prepare("UPDATE board_schedules SET state = 'canceled', next_at = NULL, data = ? WHERE id = ?")
          .run(JSON.stringify(sched), sched.id)
        this.store.appendEvent({
          type: 'schedule.canceled',
          createdAt: new Date(this.nowMs()).toISOString(),
          channel: sched.channel,
          payload: { id: sched.id, reason, by: sched.canceled.by },
        })
        return null
      }

      if (sched.re !== null) {
        const root = this.loadStoredMessage(Number(sched.re))
        if (!root || root.deleted) {
          return cancelScheduleInTx('thread_deleted')
        }
      }

      // The creator's standing now, not when it scheduled (original schedules.ts:259 accessNow,
      // auth.ts:548-558): the server's `principalNow` says what it is today, owner and member flags
      // included, or that it is gone. Without one, the principal as it was stored stands, every flag
      // the same, so an owner's schedule sends as the owner's post would.
      const parsedMeta = this.scheduleMeta(sched.id)
      const storedPrincipal: CallerPrincipal = parsedMeta
        ? parsedMeta.principal
        : {
            id: sched.by.principal,
            kind: 'user',
            handle: sched.author.handle,
            userId: sched.by.principal.replace(/^local:user:/, ''),
            member: true,
            owner: false,
          }
      const principalNow = this.options.principalNow
      const reconstructedPrincipal = principalNow ? principalNow(storedPrincipal) : storedPrincipal
      if (reconstructedPrincipal === null || reconstructedPrincipal.id !== storedPrincipal.id) {
        return cancelScheduleInTx('revoked')
      }

      const schedCaller: CallerContext = {
        principal: reconstructedPrincipal,
        actor: {
          id: sched.by.actor,
          kind: sched.author.kind,
          handle: sched.author.handle,
          name: sched.author.name,
          avatar: sched.author.avatar,
          ...(sched.author.via ? { via: sched.author.via } : {}),
        },
        profile: sched.by.profile,
        ...(parsedMeta?.canHeader !== undefined ? { canHeader: parsedMeta.canHeader } : {}),
      }

      let message: MessageView
      try {
        const res = this.postMessageAs(
          schedCaller,
          {
            ...(sched.re !== null ? { re: sched.re } : { channel: sched.channel }),
            id: `board-schedule:${Number(freshRow.seq)}:${sched.sent}`,
            text: sched.text,
            ...(Object.keys(sched.labels).length > 0 ? { labels: sched.labels } : {}),
            noSync: sched.noSync,
            ...(sched.attachments.length > 0 ? { attachments: sched.attachments.map((a) => a.id) } : {}),
          },
          { schedule: { id: Number(freshRow.seq), n: sched.sent }, trustedId: true },
        )
        message = res.message
      } catch (err) {
        if (err instanceof BoardError && (err.status === 403 || err.status === 404)) {
          return cancelScheduleInTx('revoked')
        }
        if (err instanceof BoardError && err.status >= 400 && err.status < 500) {
          return cancelScheduleInTx('dropped')
        }
        throw err
      }

      sched.sent += 1
      sched.last = message.id
      let nextAt: number | null = null
      const underTimes = sched.times === null || sched.sent < sched.times
      if (sched.every !== null && underTimes) {
        const at = Date.parse(sched.next!)
        const candidate = at + sched.every * Math.max(1, Math.floor((nowMs - at) / sched.every) + 1)
        const underUntil = sched.until === null || candidate <= Date.parse(sched.until)
        if (underUntil) nextAt = candidate
      }
      if (nextAt === null) {
        sched.state = 'done'
        sched.next = null
      } else {
        sched.next = new Date(nextAt).toISOString()
      }
      this.store.db
        .prepare('UPDATE board_schedules SET state = ?, next_at = ?, data = ? WHERE id = ?')
        .run(sched.state, nextAt, JSON.stringify(sched), sched.id)
      return message
    })
  }

  // Attachments (F2)
  /**
   * A file is no use until a post or an import carries it, so uploading needs `post` or `sync`
   * somewhere (original a2.ts:735-747).
   */
  private mayUpload(access: Access): void {
    if (!access.anywhere('post') && !access.anywhere('sync')) {
      throw forbidden("this token can't post anywhere, so it can't upload")
    }
  }

  /**
   * A request's upload: at most ATTACHMENT_BYTES_MAX, whoever sends it, the board's own deployment
   * too (original a2.ts:735-741: only `ownSync`, the in-process engine, gets more).
   */
  uploadAttachment(
    caller: CallerContext,
    input: { name: string | null; type: string | null; data: Buffer | Uint8Array },
  ): Attachment {
    return this.uploadWith(caller, input, ATTACHMENT_BYTES_MAX)
  }

  /**
   * A file the board's own sync engine fetched for an import, in this process: it has no request to
   * fit under, so it may be up to IMPORT_BYTES_MAX (original a2.ts:739-740 ownSync). Only the board's
   * deployment imports this way; a server never routes a request here.
   */
  importAttachment(
    caller: CallerContext,
    input: { name: string | null; type: string | null; data: Buffer | Uint8Array },
  ): Attachment {
    if (caller.principal.kind !== 'deployment') {
      throw forbidden("only the board's own sync fetches imports: upload this as any other file")
    }
    return this.uploadWith(caller, input, IMPORT_BYTES_MAX)
  }

  private uploadWith(
    caller: CallerContext,
    input: { name: string | null; type: string | null; data: Buffer | Uint8Array },
    max: number,
  ): Attachment {
    const { caller: access } = this.requireAdmitted(caller)
    this.mayUpload(access)
    const bytes = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data)
    if (bytes.byteLength === 0) throw badRequest('the file is empty')
    if (bytes.byteLength > max) {
      throw tooLarge(`attachments are at most ${max / 1024 / 1024} MB`)
    }
    const name = uploadName(input.name)
    const type = mediaType(input.type)
    const id = newAttachmentId()
    this.tx(() => {
      const now = new Date(this.nowMs()).toISOString()
      this.store.db
        .prepare(
          `INSERT INTO board_attachments (id, name, type, size, uploaded_by, storage_key, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        // Its uploader is the principal that sent it, which reads and attaches it before a message carries it (original blob.ts:77-101).
        .run(id, name, type, bytes.byteLength, caller.principal.id, id, bytes, now)
    })
    return { id, name, type, size: bytes.byteLength }
  }

  /**
   * A file's bytes: only to its uploader, to a reader of every channel, or to a reader of a channel
   * where a live message carries it. Anyone else gets the 404 a missing file gets (original a2.ts:752-757).
   */
  getAttachment(caller: CallerContext, id: string): { meta: Attachment; data: Buffer } {
    const { caller: access } = this.requireAdmitted(caller)
    const row = this.store.db
      .prepare('SELECT id, name, type, size, uploaded_by, data FROM board_attachments WHERE id = ?')
      .get(id) as
      | { id: string; name: string; type: string; size: number; uploaded_by: string | null; data: Uint8Array }
      | undefined
    if (!row || !this.attachmentReadable(access, caller.principal.id, row.id, row.uploaded_by)) {
      throw attachmentNotFound(id)
    }
    return {
      meta: { id: row.id, name: row.name, type: row.type, size: Number(row.size) },
      data: Buffer.from(row.data),
    }
  }

  startDirectUpload(caller: CallerContext, rawInput: unknown): UploadTicket {
    const { caller: access } = this.requireAdmitted(caller)
    this.mayUpload(access)
    const input = UploadStartBodySchema.parse(rawInput)
    if (input.size > DIRECT_UPLOAD_BYTES_MAX) {
      throw tooLarge(`direct uploads are at most ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB`)
    }
    const name = uploadName(input.name)
    const type = mediaType(input.type)
    const id = `att_${randomUUID()}`
    let expiresAt = ''
    this.tx(() => {
      expiresAt = new Date(this.nowMs() + DIRECT_UPLOAD_TTL_MS).toISOString()
      this.store.db
        .prepare(
          `INSERT INTO board_upload_tickets (id, name, type, size, uploaded_by, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, type, input.size, caller.principal.id, expiresAt)
    })
    return {
      id,
      url: `/attachments/uploads/${id}`,
      headers: { 'content-type': type },
      expiresAt,
    }
  }

  /**
   * Finishes a direct upload: only its uploader may (404 `upload_not_found` for anyone else, as for
   * one that isn't there), a second finish answers the same attachment, and a ticket stops taking
   * bytes when it expires (original blob.ts:115-120, :153-198).
   */
  finishDirectUpload(caller: CallerContext, uploadId: string, data: Buffer | Uint8Array): Attachment {
    this.requireAdmitted(caller)
    const missing = (): BoardError => notFound(`no upload: ${uploadId}`, 'upload_not_found')
    return this.tx(() => {
      const ticket = this.store.db
        .prepare('SELECT id, name, type, size, uploaded_by, expires_at FROM board_upload_tickets WHERE id = ?')
        .get(uploadId) as
        | { id: string; name: string; type: string; size: number; uploaded_by: string; expires_at: string }
        | undefined
      if (!ticket || ticket.uploaded_by !== caller.principal.id) throw missing()
      const done = this.store.db
        .prepare('SELECT id, name, type, size FROM board_attachments WHERE id = ?')
        .get(ticket.id) as { id: string; name: string; type: string; size: number } | undefined
      if (done) return { id: done.id, name: done.name, type: done.type, size: Number(done.size) }
      if (Date.parse(ticket.expires_at) <= this.nowMs()) {
        throw notFound(`no upload: ${uploadId} (it expired at ${ticket.expires_at})`, 'upload_not_found')
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (bytes.byteLength !== Number(ticket.size)) {
        throw badRequest(
          `the store has ${bytes.byteLength} bytes for ${uploadId}, but its upload said ${ticket.size}`,
          'size_mismatch',
        )
      }
      const now = new Date(this.nowMs()).toISOString()
      this.store.db
        .prepare(
          `INSERT INTO board_attachments (id, name, type, size, uploaded_by, storage_key, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ticket.id, ticket.name, ticket.type, bytes.byteLength, ticket.uploaded_by, ticket.id, bytes, now)
      return { id: ticket.id, name: ticket.name, type: ticket.type, size: bytes.byteLength }
    })
  }

  // Watchers (F5)
  /**
   * Refuses a caller narrowed with `x-board-can` (a sandboxed agent, say): its principal's watchers
   * are one registration, which its project registers and runs with the token it narrowed. A
   * narrowed pull would take matches from it, and a narrowed register replace it (original a2.ts:1236-1241).
   */
  private ownWatchers(caller: CallerContext): void {
    if (caller.canHeader !== undefined) {
      throw forbidden("this token is narrowed with x-board-can: registering and running watchers is its project's job")
    }
  }

  /**
   * Leases what's free in a registrant's queues: each (queue, thread)'s oldest item, if no one holds
   * it and its wait after an error is over, and `visible` says its registrant may still have it. A
   * lease that ran out is a try that didn't finish; after `MATCH_TRIES` the item is given up on
   * (original registered.ts:169-212). Runs in the caller's transaction, which fences two pulls.
   */
  private leaseQueue(
    table: 'board_watcher_matches' | 'board_inbox',
    queueColumn: 'watcher' | 'sync_key',
    where: string,
    params: readonly (string | number)[],
    options: { limit: number; now: number; visible: (row: Record<string, unknown>) => boolean },
  ): Array<{ row: QueueRow & Record<string, unknown>; lease: string; attempt: number }> {
    const rows = this.store.db
      .prepare(
        `SELECT *, ${queueColumn} AS queue FROM ${table}
         WHERE ${where} AND status IN ${QUEUED} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...params) as Array<QueueRow & Record<string, unknown>>
    const heads = new Map<string, QueueRow & Record<string, unknown>>()
    for (const row of rows) {
      const key = `${row.queue}\u001f${row.thread}`
      if (!heads.has(key)) heads.set(key, row)
    }
    const settle = this.store.db.prepare(
      `UPDATE ${table} SET status = ?, lease = NULL, lease_until = NULL, attempt = ?, error = COALESCE(?, error) WHERE id = ?`,
    )
    const take = this.store.db.prepare(
      `UPDATE ${table} SET status = 'leased', lease = ?, lease_until = ?, attempt = ?, retry_at = NULL WHERE id = ?`,
    )
    const out: Array<{ row: QueueRow & Record<string, unknown>; lease: string; attempt: number }> = []
    for (const head of heads.values()) {
      if (out.length >= options.limit) break
      const leaseUntil = head.lease_until === null ? null : Number(head.lease_until)
      if (head.status === 'leased' && leaseUntil !== null && leaseUntil > options.now) continue
      if (head.retry_at !== null && Number(head.retry_at) > options.now) continue
      let attempts = Number(head.attempt)
      if (head.status === 'leased') {
        // It ran out: a try that didn't finish.
        attempts += 1
        if (attempts >= MATCH_TRIES) {
          settle.run('failed', attempts, `its lease ran out ${attempts} times`, head.id)
          continue
        }
      }
      if (!options.visible(head)) {
        settle.run('skipped', attempts, "its registrant can't have it anymore", head.id)
        continue
      }
      const lease = randomBytes(16).toString('hex')
      take.run(lease, options.now + LEASE_MS, attempts, head.id)
      out.push({ row: head, lease, attempt: attempts })
    }
    return out
  }

  /** Records how a pulled item went: done, skipped, or an error that waits, then tries again (original registered.ts:215-244). */
  private ackQueue(
    table: 'board_watcher_matches' | 'board_inbox',
    id: string,
    owner: string,
    body: { lease: string; error?: string | undefined; skip?: boolean | undefined },
    now: number,
  ): 'acked' | 'stale' | 'gone' {
    const found = this.store.db
      .prepare(`SELECT id, status, lease, attempt FROM ${table} WHERE id = ? AND owner = ? AND status IN ${QUEUED}`)
      .get(id, owner) as { id: string; status: string; lease: string | null; attempt: number } | undefined
    if (!found) return 'gone'
    if (found.lease !== body.lease) return 'stale'
    const done = (status: string, error: string | null = null): 'acked' => {
      this.store.db
        .prepare(`UPDATE ${table} SET status = ?, lease = NULL, lease_until = NULL, error = COALESCE(?, error) WHERE id = ?`)
        .run(status, error, id)
      return 'acked'
    }
    if (body.skip) return done('skipped', 'its board skipped it')
    if (body.error === undefined) return done('acked')
    const attempts = Number(found.attempt) + 1
    if (attempts >= MATCH_TRIES) {
      this.store.db.prepare(`UPDATE ${table} SET attempt = ? WHERE id = ?`).run(attempts, id)
      return done('failed', body.error)
    }
    this.store.db
      .prepare(
        `UPDATE ${table} SET status = 'pending', lease = NULL, lease_until = NULL, attempt = ?, retry_at = ?, error = ? WHERE id = ?`,
      )
      .run(attempts, now + retryDelay(attempts), body.error, id)
    return 'acked'
  }

  /** An event as `access` may see it now: its links' snapshots only of what it may read (original feed.ts:82-106 viewedBy). */
  private viewedBy(event: BoardEventView, access: Access): BoardEventView {
    const shown = structuredClone(event) as BoardEventView & {
      payload?: { links?: LinkView[] }
      message?: MessageView
      before?: MessageView
    }
    if (Array.isArray(shown.payload?.links)) {
      shown.payload.links = shown.payload.links.map((link) => this.linkViewFor(link, access))
    }
    if (shown.message) shown.message.links = shown.message.links.map((link) => this.linkViewFor(link, access))
    // A sync's labels.changed match carries the message as it was: its links are read again too
    // (original feed.ts:101-104 `if (shown.before) shown.before.links = reread(...)`).
    if (Array.isArray(shown.before?.links)) {
      shown.before.links = shown.before.links.map((link) => this.linkViewFor(link, access))
    }
    return shown
  }

  registerWatchers(caller: CallerContext, rawInput: unknown): RegistrationView {
    const body = RegisterBodySchema.parse(rawInput)
    // This board wakes nothing: a registrant pulls its matches. One that named a url or a path would
    // take the registration as woken and never pull, so neither is taken (original a2.ts:764-767,
    // registrant.ts pulls only a registration with no url). Refused before anything about the caller.
    if (body.path) {
      throw new BoardError(501, 'no_wake_by_path', 'this board wakes nothing: register no path, and pull your matches')
    }
    if (body.url) {
      throw new BoardError(501, 'no_wake_by_url', 'this board wakes nothing: register no url, and pull your matches')
    }
    const { caller: access } = this.requireAdmitted(caller)
    this.ownWatchers(caller)
    // A registered watcher sees only what its registrant may read (original a2.ts:770-774).
    if (!access.anywhere('read')) {
      throw forbidden("this token can't read anywhere, so a watcher it registers would see nothing")
    }
    // A sync's entries speak for platform users: only for one that may sync.
    if ((body.sync?.length ?? 0) > 0 && !access.anywhere('sync')) {
      throw forbidden("this token can't register a sync: it needs sync somewhere")
    }
    const entries = Object.entries(body.watch)
    if (entries.length > REGISTERED_WATCHERS_MAX) {
      throw badRequest(`a registration holds at most ${REGISTERED_WATCHERS_MAX} watchers`, 'too_many_watchers')
    }
    // Worded as the original's register (a2.ts:776-780).
    for (const [id, spec] of entries) {
      const name = RemoteWatcherId.safeParse(id)
      if (!name.success) {
        throw badRequest(`watch ${id}: ${name.error.issues[0]!.message}`, 'bad_watcher')
      }
      try {
        const parsed = parseWatchTail(spec.tail)
        if (parsed.filters.mentions === 'me') {
          throw new Error('a watcher has no "me": use --mentions @handle')
        }
      } catch (err) {
        throw badRequest(`watch ${id}: ${err instanceof Error ? err.message : String(err)}`, 'bad_watcher')
      }
    }

    const syncList = body.sync ?? []
    const hash = watchersHash(body.watch, syncList)
    const owner = caller.principal.id

    this.tx(() => {
      const now = new Date(this.nowMs()).toISOString()
      this.store.db
        .prepare(
          `INSERT INTO board_watchers (owner, principal_json, url, path, branch, watch_json, sync_json, hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner) DO UPDATE SET
             principal_json = excluded.principal_json, url = excluded.url, path = excluded.path,
             branch = excluded.branch, watch_json = excluded.watch_json, sync_json = excluded.sync_json,
             hash = excluded.hash, updated_at = excluded.updated_at`,
        )
        .run(
          owner,
          JSON.stringify(caller.principal),
          // Nothing is woken here, so a registration names no url, path or branch (original a2.ts:775).
          null,
          null,
          null,
          JSON.stringify(body.watch),
          JSON.stringify(syncList),
          hash,
          now,
        )
    })

    return { owner, url: null, watch: body.watch, sync: syncList, hash }
  }

  /**
   * The registrations: each names a board's URL and tails, so all of them only for `manage` in
   * every channel, and the caller's own for anyone else (original a2.ts:758-763).
   */
  listWatchers(caller: CallerContext): RegistrationView[] {
    const { caller: access } = this.requireAdmitted(caller)
    const everyone = access.everywhere('manage')
    const rows = this.store.db
      .prepare(
        `SELECT owner, url, path, branch, watch_json, sync_json, hash FROM board_watchers
         ${everyone ? '' : 'WHERE owner = ?'} ORDER BY owner ASC`,
      )
      .all(...(everyone ? [] : [caller.principal.id])) as Array<{
      owner: string
      url: string | null
      path: string | null
      branch: string | null
      watch_json: string
      sync_json: string
      hash: string
    }>
    return rows.map((r) =>
      r.path !== null
        ? {
            owner: r.owner,
            url: null,
            path: r.path,
            ...(r.branch ? { branch: r.branch } : {}),
            watch: JSON.parse(r.watch_json) as Record<string, { tail: string }>,
            sync: JSON.parse(r.sync_json) as { key: string; platform: string }[],
            hash: r.hash,
          }
        : {
            owner: r.owner,
            url: r.url,
            watch: JSON.parse(r.watch_json) as Record<string, { tail: string }>,
            sync: JSON.parse(r.sync_json) as { key: string; platform: string }[],
            hash: r.hash,
          },
    )
  }

  /**
   * Queues a match for each registered watcher the event is for. A change is for a watcher when
   * its message matched the watcher's filters before *or* after it, so a message leaving a label's
   * view is delivered too (original feed.ts:376-434). The event is kept whole; each pull shows it
   * as its registrant may see it then.
   */
  private dispatchWatchersInTx(ev: StoredEvent, msg: StoredMessage): void {
    const regs = this.store.db
      .prepare('SELECT owner, principal_json, watch_json, sync_json FROM board_watchers')
      .all() as Array<{ owner: string; principal_json: string; watch_json: string; sync_json: string }>
    if (regs.length === 0) return

    const beforeRow = this.store.db
      .prepare('SELECT data FROM board_versions WHERE message_id = ? AND log_index < ? ORDER BY log_index DESC LIMIT 1')
      .get(msg.id, ev.index) as { data: string } | undefined
    const before = beforeRow ? (JSON.parse(beforeRow.data) as StoredMessage) : undefined
    const grants = this.loadGrants()
    const actors = this.getActorsMap()
    const nowMs = this.nowMs()
    for (const reg of regs) {
      const principal = JSON.parse(reg.principal_json) as CallerPrincipal
      const dummyCaller: CallerContext = {
        principal,
        actor: {
          id: principal.id,
          kind: principal.kind === 'user' ? 'person' : 'agent',
          handle: principal.handle,
          name: principal.handle,
          avatar: null,
        },
        profile: null,
      }
      const access = this.withPrivateAcl(dummyCaller, grantAccessForCaller(principal, grants).caller)
      let evView: BoardEventView | null = null
      this.queueSyncMatchInTx(ev, msg, before, reg, access, actors, nowMs)
      if (!access.readable(msg.channel)) continue
      const watchMap = JSON.parse(reg.watch_json) as Record<string, { tail: string }>
      for (const [watcherId, spec] of Object.entries(watchMap)) {
        const parsed = parseWatchTail(spec.tail)
        const hasCriteria =
          parsed.filters.channel !== undefined ||
          parsed.filters.re !== undefined ||
          parsed.filters.by !== undefined ||
          parsed.filters.mentions !== undefined ||
          parsed.filters.from !== undefined ||
          parsed.filters.text !== undefined ||
          (parsed.filters.label?.length ?? 0) > 0
        const matched =
          !hasCriteria ||
          this.matchesFilters(msg, parsed.filters, dummyCaller, actors, access) ||
          this.matchesFilters(before, parsed.filters, dummyCaller, actors, access)
        if (!matched) continue
        // As its registrant may see it, as the original renders each registration's (watch.ts:195-197);
        // the pull reads its links again for what it may read then (viewedBy).
        evView ??= this.eventToView(ev, actors, access, msg)
        const matchId = `wm_${ev.index}_${reg.owner}_${watcherId}`
        this.store.db
          .prepare(
            `INSERT OR IGNORE INTO board_watcher_matches (id, owner, watcher, thread, event_json, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(matchId, reg.owner, watcherId, msg.thread, JSON.stringify(evView), nowMs)
      }
    }
  }

  /**
   * A thread's new sync target, as a match of each sync's `@sync` watcher: a sync's match for a
   * thread is about its root (original watch.ts:206-208).
   */
  private dispatchThreadSyncedInTx(ev: StoredEvent, root: StoredMessage): void {
    const regs = this.store.db
      .prepare("SELECT owner, principal_json, sync_json FROM board_watchers WHERE sync_json <> '[]'")
      .all() as Array<{ owner: string; principal_json: string; sync_json: string }>
    if (regs.length === 0) return
    const grants = this.loadGrants()
    const actors = this.getActorsMap()
    const nowMs = this.nowMs()
    for (const reg of regs) {
      const principal = JSON.parse(reg.principal_json) as CallerPrincipal
      this.queueSyncMatchInTx(ev, root, undefined, reg, grantAccessForCaller(principal, grants).caller, actors, nowMs)
    }
  }

  /**
   * Queues a registrant's sync its match for an event, as its `@sync` watcher's: every message
   * change and a thread's new targets (SYNCED_EVENTS), in each channel where it may sync now, with
   * the message as it was before a label change, which sync compares to know whether a copy shows
   * something new (original watch.ts:55, :206-221; registered.ts:21 SYNC_QUEUE).
   */
  private queueSyncMatchInTx(
    ev: StoredEvent,
    about: StoredMessage,
    before: StoredMessage | undefined,
    reg: { owner: string; sync_json: string },
    access: Access,
    actors: Map<string, StoredActor>,
    nowMs: number,
  ): void {
    if (!SYNCED_EVENTS.has(ev.type)) return
    if ((JSON.parse(reg.sync_json) as unknown[]).length === 0) return
    if (!access.can('sync', about.channel)) return
    const shown: BoardEventView & { before?: MessageView } = this.eventToView(ev, actors, access, about)
    // Built with the registrant's access, as the original's (watch.ts:212-214 messageView(before, actors,
    // reader)); the pull reads its links again for what it may read then (viewedBy).
    if (ev.type === 'labels.changed' && before) shown.before = this.toMessageView(before, actors, access)
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO board_watcher_matches (id, owner, watcher, thread, event_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(`wm_${ev.index}_${reg.owner}_${SYNC_QUEUE}`, reg.owner, SYNC_QUEUE, about.thread, JSON.stringify(shown), nowMs)
  }

  /**
   * Hands the registrant its watchers' matches: each (watcher, thread)'s oldest, leased for five
   * minutes, the next waiting until it's acked. Each is checked against what the registrant may
   * read now, never what it could when it matched (original a2.ts:791-808, registered.ts:127-167).
   */
  pullWatcherMatches(caller: CallerContext, rawQuery: unknown = {}): MatchView[] {
    const { caller: access } = this.requireAdmitted(caller)
    this.ownWatchers(caller)
    const query = MatchesQuerySchema.parse(rawQuery)
    const limit = query.limit ?? 10
    const owner = caller.principal.id

    return this.tx(() => {
      const nowMs = this.nowMs()
      if (!this.store.db.prepare('SELECT 1 FROM board_watchers WHERE owner = ?').get(owner)) {
        throw notFound('this token has no watchers registered here', 'no_registration')
      }
      const leased = this.leaseQueue('board_watcher_matches', 'watcher', 'owner = ?', [owner], {
        limit,
        now: nowMs,
        // Sync's queue gets what its registrant may sync now, since it speaks for platform users
        // there; a watcher's, what it may read (original registered.ts:126-131 readable).
        visible: (row) => {
          const event = JSON.parse(String(row.event_json)) as BoardEventView
          const channel = event.message?.channel
          if (row.queue === SYNC_QUEUE) return channel === undefined ? access.everywhere('sync') : access.can('sync', channel)
          return channel === undefined ? access.readsAll : access.readable(channel)
        },
      })
      return leased.map(({ row, lease, attempt }) => ({
        id: row.id,
        watcher: row.queue,
        thread: row.thread,
        lease,
        attempt,
        event: this.viewedBy(JSON.parse(String(row.event_json)) as BoardEventView, access),
      }))
    })
  }

  ackWatcherMatch(caller: CallerContext, matchId: string, rawInput: unknown): { ok: boolean } {
    this.requireAdmitted(caller)
    this.ownWatchers(caller)
    const body = AckBodySchema.parse(rawInput)
    return this.tx(() => {
      const result = this.ackQueue('board_watcher_matches', matchId, caller.principal.id, body, this.nowMs())
      if (result === 'gone') throw notFound(`no match ${matchId} is waiting for this token`, 'no_match')
      if (result === 'stale') throw conflict('that lease ran out, and the match was pulled again', 'stale_lease')
      return { ok: true }
    })
  }

  // Sync Hooks (F5)
  attachSyncTarget(caller: CallerContext, id: string | number, rawInput: unknown): { attached: boolean } {
    const { caller: access } = this.requireAdmitted(caller)
    const input = SyncBodySchema.parse(rawInput)
    const msgId = resolveMessageId(this.store.db, id)

    return this.tx(() => {
      const msg = Number.isInteger(msgId) && msgId > 0 ? this.loadStoredMessage(msgId) : null
      if (!msg) throw this.messageNotFoundError(id)()
      authorizeChannel(access, 'sync', msg.channel, this.messageNotFoundError(id))

      const kind: 'channel' | 'thread' = input.target.slice(input.target.indexOf(':') + 1).includes(':')
        ? 'thread'
        : 'channel'
      const existingRow = this.store.db
        .prepare('SELECT data FROM board_sync_threads WHERE thread = ?')
        .get(msg.thread) as { data: string } | undefined
      const syncData: SyncThreadView = existingRow
        ? (JSON.parse(existingRow.data) as SyncThreadView)
        : { thread: msg.thread, root: String(msg.re ?? msg.id), channel: msg.channel, targets: [], external: {} }

      if (syncData.targets.includes(input.target)) {
        return { attached: false }
      }
      if (kind === 'thread') {
        const ownerRow = this.store.db
          .prepare('SELECT thread FROM board_external_threads WHERE external = ?')
          .get(input.target) as { thread?: string } | undefined
        if (ownerRow?.thread && ownerRow.thread !== msg.thread) {
          throw conflict(`${input.target} is already synced with another thread`, 'already_synced')
        }
        syncData.external[input.target] = input.target
        this.store.db
          .prepare('INSERT OR REPLACE INTO board_external_threads (external, thread) VALUES (?, ?)')
          .run(input.target, msg.thread)
      }
      syncData.targets.push(input.target)
      this.store.db
        .prepare('INSERT OR REPLACE INTO board_sync_threads (thread, data) VALUES (?, ?)')
        .run(msg.thread, JSON.stringify(syncData))
      const synced = this.store.appendEvent({
        type: 'thread.synced',
        createdAt: new Date(this.nowMs()).toISOString(),
        channel: msg.channel,
        thread: msg.thread,
        payload: {
          thread: msg.thread,
          target: input.target,
          kind,
          cause: 'request',
          by: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
        },
      })
      // A sync's match for a thread is about its root.
      const root = msg.re === null ? msg : this.loadStoredMessage(msg.re)
      if (root) this.dispatchThreadSyncedInTx(synced, root)
      return { attached: true }
    })
  }

  getSynced(caller: CallerContext, id: string | number): SyncedView {
    const { caller: access } = this.requireAdmitted(caller)
    const msgId = resolveMessageId(this.store.db, id)
    const msg = Number.isInteger(msgId) && msgId > 0 ? this.loadStoredMessage(msgId) : null
    if (!msg || !access.readable(msg.channel)) throw this.messageNotFoundError(id)()

    const row = this.store.db
      .prepare('SELECT data FROM board_sync_threads WHERE thread = ?')
      .get(msg.thread) as { data: string } | undefined
    const syncData = row ? (JSON.parse(row.data) as SyncThreadView) : null
    if (!syncData) return { targets: [] }

    const copyRows = this.store.db
      .prepare('SELECT target, data FROM board_copies WHERE message_id = ?')
      .all(msg.id) as Array<{ target: string; data: string }>
    const copies = new Map(copyRows.map((c) => [c.target, JSON.parse(c.data) as ExternalCopy]))

    return {
      targets: syncData.targets.map((target) => {
        const key = target.slice(0, target.indexOf(':'))
        const external = Object.hasOwn(syncData.external, target) ? syncData.external[target]! : null
        // A message that came from a platform thread is recorded by that thread, not by the channel it's in (original a2.ts:860-865).
        const copy = copies.get(target) ?? (external !== null ? copies.get(external) : undefined)
        return {
          target,
          key,
          thread: copy?.thread ?? external,
          message: copy?.message ?? null,
          url: null,
          undelivered: msg.undelivered[target] ?? null,
        }
      }),
    }
  }

  private resolveLinks(
    access: Access,
    links: readonly {
      url: string
      message: string | null
      snapshot: LinkSnapshot | null
      unavailable: string | null
    }[],
  ): LinkView[] {
    const actors = this.getActorsMap()
    return links.map(({ message: ref, ...rest }) => {
      const id = ref === null ? null : indexOf(ref)
      const found = id === null || id === 0 ? null : this.loadStoredMessage(id)
      if (!found || found.deleted || !access.readable(found.channel)) {
        return { ...rest, message: null }
      }
      const actor = actors.get(found.by.actor)
      const authorName = actor?.via
        ? `${actor.name} via ${actor.via.name}`
        : (actor?.name ?? found.by.actor)
      return {
        url: rest.url,
        message: String(found.id),
        snapshot: {
          author: authorName,
          text: found.text,
          createdAt: found.createdAt,
          files: found.attachments.map((file) => ({ name: file.name, url: null })),
        },
        unavailable: null,
      }
    })
  }

  /**
   * Whether an ID is someone this board signs in rather than a platform user: an ID in a scheme the
   * board authenticates, the owner of a registration, or an actor the board recorded as other than
   * a platform user, or one of their profiles (original a2.ts:1201-1235 speaksFor/signedIn, auth.ts:69).
   */
  private signsIn(id: string): boolean {
    if (/^(vercel|oidc|local|board):/.test(id) || id.startsWith('github:repo:')) return true
    const plus = id.indexOf('+')
    const candidates = plus > 0 ? [id, id.slice(0, plus)] : [id]
    const owner = this.store.db.prepare('SELECT owner FROM board_watchers WHERE owner = ?')
    const actor = this.store.db.prepare('SELECT data FROM board_actors WHERE id = ?')
    for (const known of candidates) {
      if (owner.get(known)) return true
      const row = actor.get(known) as { data: string } | undefined
      if (row) {
        const record = JSON.parse(row.data) as StoredActor
        if (record.kind !== 'external' || record.host === true) return true
      }
    }
    return false
  }

  /**
   * The identity an import writes as (original a2.ts:170-191 externalIdentity, :913-929 syncImport):
   * only a platform user of a sync key the importer registered, never anyone this board signs in.
   * The board's own code (a deployment) imports platform users as themselves; anyone else's are its
   * word, a profile of its principal (`<principal>+<platform id>`), whose record only its imports change.
   */
  private importIdentity(
    caller: CallerContext,
    access: Access,
    author: { id: string; handle: string; name: string; avatar: string | null },
    mentioned: readonly { id: string; handle: string; name: string; avatar: string | null }[],
    from: string | null,
  ): { importer: CallerContext; introduces: CallerContext[] } {
    if (!access.anywhere('sync')) throw forbidden("this token can't import: it needs sync")
    if (caller.canHeader !== undefined) {
      throw forbidden("this token is narrowed with x-board-can, so it can't import: that's its project's sync's job")
    }
    for (const { id } of [author, ...mentioned]) {
      if (this.signsIn(id)) {
        throw forbidden(`${id} is someone this board signs in, not a platform user: sync can't write as them`)
      }
    }
    const row = this.store.db
      .prepare('SELECT sync_json FROM board_watchers WHERE owner = ?')
      .get(caller.principal.id) as { sync_json: string } | undefined
    const entries = row ? (JSON.parse(row.sync_json) as { key: string; platform: string }[]) : []
    const keys = from === null ? entries : entries.filter((entry) => entry.key === from)
    if (from !== null && keys.length === 0) {
      throw forbidden(`this token doesn't sync ${from} here: its board registers its sync entries`)
    }
    const platformOf = (id: string): string => {
      const entry = keys.find(({ key }) => id.startsWith(`${key}:`))
      if (!entry) {
        throw forbidden(
          `${id} isn't a user of ${keys.length ? keys.map(({ key }) => key).join(' or ') : 'a sync key this token has'}: their ID starts with its key`,
        )
      }
      return entry.platform
    }
    const platform = platformOf(author.id)
    // The platform users its text mentions are checked as its author is, and met as who they'd be
    // had they written (original a2.ts:917-929 speaksFor, introduces).
    const introduces = mentioned.map((user) => this.externalIdentity(caller, user, platformOf(user.id)))
    return { importer: this.externalIdentity(caller, author, platform), introduces }
  }

  /**
   * A platform user, as an import names them (original a2.ts:170-191 externalIdentity). The board's
   * own code (a deployment) imports them as themselves; anyone else's are its word, a profile of its
   * principal (`<principal>+<platform id>`), whose record only its imports change.
   */
  private externalIdentity(
    caller: CallerContext,
    user: { id: string; handle: string; name: string; avatar: string | null },
    platform: string,
  ): CallerContext {
    if (caller.principal.kind === 'deployment') {
      return {
        principal: caller.principal,
        actor: { id: user.id, kind: 'external', handle: user.handle, name: user.name, avatar: user.avatar, platform },
        profile: null,
      }
    }
    const via: Via = {
      name: caller.principal.handle,
      environment: caller.principal.kind === 'project' ? (caller.principal.environment ?? null) : null,
    }
    const platformUserId = user.id.slice(user.id.indexOf(':') + 1)
    return {
      principal: caller.principal,
      actor: {
        id: `${caller.principal.id}+${user.id}`,
        kind: 'external',
        handle: importedHandle(via.name, user.handle, platformUserId),
        name: user.name,
        avatar: user.avatar,
        via,
        platform,
        // A sync elsewhere's word, checked as `via` shows; the board's own code's users are not "verified".
        ...(caller.principal.id.startsWith('board:') ? {} : { verified: true as const }),
      },
      profile: user.id,
    }
  }

  /**
   * An import's text, with each `@[<key>:…]` mention of a user of one of the importer's sync keys
   * made a mention of that user as this import names them: its own profile of them,
   * `@[<principal>+<platform id>]`. The board's own sync's users are themselves, so its text stays
   * as it came, and so does one the rewrite would take past what a message holds (original
   * a2.ts:921-928 asNamed).
   */
  private asNamed(caller: CallerContext, text: string): string {
    if (caller.principal.kind === 'deployment') return text
    const keys = this.syncEntriesOf(caller.principal.id).map(({ key }) => key)
    if (keys.length === 0) return text
    const named = replaceMentions(text, (token) =>
      token.kind === 'actor' && keys.some((key) => token.actor.startsWith(`${key}:`))
        ? `@[${caller.principal.id}+${token.actor}]`
        : null,
    )
    return named.length > MESSAGE_TEXT_MAX ? text : named
  }

  /**
   * The caller, when it may sync somewhere: what every sync route needs. `records`: what it does
   * keeps sync's records (imports, receipts, its inbox), which only an integration does, never a
   * caller narrowed with `x-board-can` (original a2.ts:1248-1262 needSync/unnarrowed).
   */
  private needSync(caller: CallerContext, access: Access, what: string, records = false): void {
    if (!access.anywhere('sync')) throw forbidden(`this token can't ${what}: it needs sync`)
    if (records && caller.canHeader !== undefined) {
      throw forbidden(`this token is narrowed with x-board-can, so it can't ${what}: that's its project's sync's job`)
    }
  }

  /** The sync entries a caller's sync registered here (original a2.ts:1176-1179 entriesOf). */
  private syncEntriesOf(principalId: string): { key: string; platform: string }[] {
    const row = this.store.db
      .prepare('SELECT sync_json FROM board_watchers WHERE owner = ?')
      .get(principalId) as { sync_json: string } | undefined
    return row ? (JSON.parse(row.sync_json) as { key: string; platform: string }[]) : []
  }

  /**
   * An import's client ID as the board keeps it. A sync elsewhere names its posts under its own
   * principal, so it can't take an ID anyone else would use (original a2.ts:1167-1169).
   */
  private importId(caller: CallerContext, id: string): string {
    if (caller.principal.kind === 'deployment') return id
    const digest = createHash('sha256').update(`board-sync\u001f${id}`).digest('hex').slice(0, 32)
    return `sync:${caller.principal.id}:${digest}`
  }

  /** The board thread a platform thread is synced with, or null. */
  private threadOfExternal(external: string): string | null {
    const row = this.store.db
      .prepare('SELECT thread FROM board_external_threads WHERE external = ?')
      .get(external) as { thread: string } | undefined
    return row?.thread ?? null
  }

  /** The board message a platform message is, or null. */
  private messageOfExternal(thread: string, message: string): number | null {
    const row = this.store.db
      .prepare('SELECT message_id FROM board_external_messages WHERE key = ?')
      .get(`${thread}|${message}`) as { message_id: number } | undefined
    return row ? Number(row.message_id) : null
  }

  private syncThreadData(thread: string): SyncThreadView | null {
    const row = this.store.db
      .prepare('SELECT data FROM board_sync_threads WHERE thread = ?')
      .get(thread) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as SyncThreadView) : null
  }

  /** The sync entry an import says it came through: one its caller syncs, or a 403 (original a2.ts:448-451). */
  private checkSource(caller: CallerContext, source: { key: string } | undefined): void {
    if (source && !this.syncEntriesOf(caller.principal.id).some((entry) => entry.key === source.key)) {
      throw forbidden(`this token doesn't sync ${source.key} here: its board registers its sync entries`)
    }
  }

  /**
   * Refuses a platform origin an import can't have. Each platform thread and message maps to one
   * board thread and message, board-wide: a new root's platform thread must be no board thread's
   * yet, a reply's must be its own thread's, and its platform message no board message's. Its
   * platform locations are under the sync key it came through (original a2.ts:1271-1287 claimable).
   */
  private claimable(origin: Origin, from: string | null, thread: string | null): void {
    if (from === null) throw badRequest('an import with an origin names the sync key it came through: pass `from`')
    for (const location of [origin.channel, origin.thread, origin.subthread]) {
      if (location !== undefined && location !== null && !location.startsWith(`${from}:`)) {
        throw badRequest(`an import's platform locations belong to its sync key: ${location} isn't ${from}'s`)
      }
    }
    if (origin.subthread != null && !origin.subthread.startsWith(`${origin.thread}:`)) {
      throw badRequest(`an import's subthread is in its thread: ${origin.subthread} isn't in ${origin.thread}`)
    }
    const owner = this.threadOfExternal(origin.thread)
    if (owner !== null && owner !== thread) {
      throw conflict(`${origin.thread} is already synced with another thread`, 'already_synced')
    }
    if (owner === null && thread !== null) {
      throw conflict(`${origin.thread} isn't synced with this thread`, 'not_synced')
    }
    const exact = origin.subthread ?? origin.thread
    if (this.messageOfExternal(exact, origin.message) !== null) {
      throw conflict(`${origin.message} in ${exact} is already on the board`, 'already_synced')
    }
  }

  /**
   * Refuses a delivery receipt a caller's sync can't have made: one for a target of another sync's,
   * or of none of its message's thread's, or one that says its message landed as a platform thread
   * or message another board thread or message syncs with (original a2.ts:1294-1306 deliverable).
   */
  private deliverable(
    caller: CallerContext,
    msg: StoredMessage,
    target: string,
    external?: { thread: string; message: string },
  ): void {
    const key = target.slice(0, target.indexOf(':'))
    if (!this.syncEntriesOf(caller.principal.id).some((entry) => entry.key === key)) {
      throw forbidden(`this token doesn't sync ${key} here: its board registers its sync entries`)
    }
    if (!this.syncThreadData(msg.thread)?.targets.includes(target)) {
      throw badRequest(`#${msg.id}'s thread doesn't sync with ${target}`, 'not_a_target')
    }
    if (!external) return
    if (!external.thread.startsWith(`${key}:`)) {
      throw badRequest(`a delivery to ${target} lands under ${key}, not in ${external.thread}`)
    }
    const owner = this.threadOfExternal(external.thread)
    if (owner !== null && owner !== msg.thread) {
      throw conflict(`${external.thread} is already synced with another thread`, 'already_synced')
    }
    const copy = this.messageOfExternal(external.thread, external.message)
    if (copy !== null && copy !== msg.id) {
      throw conflict(`${external.message} in ${external.thread} is another board message's`, 'already_synced')
    }
  }

  /**
   * Records where an imported message came from, as the original's sync fold does for a post with
   * an origin: its copy under its platform thread (the importing sync's, when a sync elsewhere
   * imported it), its platform message, and for a new thread its platform thread as a target
   * (original contract/folds.ts:407-425).
   */
  private recordImportInTx(msg: MessageView, origin: Origin, importedBy: string | null): void {
    const id = Number(msg.id)
    const precise = origin.subthread ?? origin.thread
    const copy: ExternalCopy = { thread: precise, message: origin.message, ...(importedBy ? { by: importedBy } : {}) }
    this.store.db
      .prepare('INSERT OR REPLACE INTO board_copies (message_id, target, data) VALUES (?, ?, ?)')
      .run(id, origin.thread, JSON.stringify(copy))
    const byMessage = this.store.db.prepare('INSERT OR IGNORE INTO board_external_messages (key, message_id) VALUES (?, ?)')
    byMessage.run(`${precise}|${origin.message}`, id)
    // A sub-thread's message is its thread's too: a link to it may name only the thread.
    if (precise !== origin.thread) byMessage.run(`${origin.thread}|${origin.message}`, id)
    if (msg.re !== null) return
    const thread = this.syncThreadData(msg.thread)
    if (thread) {
      if (!thread.targets.includes(origin.thread)) thread.targets.push(origin.thread)
      thread.external[origin.thread] = origin.thread
      this.store.db
        .prepare('INSERT OR REPLACE INTO board_sync_threads (thread, data) VALUES (?, ?)')
        .run(msg.thread, JSON.stringify(thread))
    }
    this.store.db
      .prepare('INSERT OR IGNORE INTO board_external_threads (external, thread) VALUES (?, ?)')
      .run(origin.thread, msg.thread)
  }

  /**
   * A sync's import: a platform user's post, or their change to a message the board has. A change
   * to a message that is missing, or that the caller can't sync, changes nothing and answers
   * `{ message: null }`, the same either way, so an idempotent platform delete or edit of a message
   * already gone succeeds (original a2.ts:973-978, client.ts:870). What landed is the message as the
   * caller may see it; the wire answer is its ref (`message.id`), which the HTTP layer sends.
   */
  /** A post always lands a message (or refuses): only a change can answer null. */
  syncImport(caller: CallerContext, rawInput: { op: 'post' } & Record<string, unknown>): { message: MessageView }
  syncImport(caller: CallerContext, rawInput: unknown): { message: MessageView | null }
  syncImport(caller: CallerContext, rawInput: unknown): { message: MessageView | null } {
    const { caller: access } = this.requireAdmitted(caller)
    const input = SyncImportBodySchema.parse(rawInput)
    const mentioned = input.op === 'post' || input.op === 'edit' ? (input.mentioned ?? []) : []
    const { importer, introduces } = this.importIdentity(caller, access, input.author, mentioned, input.from)
    const ownSync = caller.principal.kind === 'deployment'
    const introduceInTx = (): void => {
      for (const user of introduces) this.upsertActorInTx(user)
    }

    if (input.op === 'post') {
      if ((input.channel === undefined) === (input.re === undefined)) {
        throw badRequest('an import needs `channel`; a reply needs `re`')
      }
      let channel = input.channel
      let root: StoredMessage | null = null
      if (input.re !== undefined) {
        const rootId = indexOf(input.re) ?? -1
        root = rootId > 0 ? this.loadStoredMessage(rootId) : null
        if (!root || !access.readable(root.channel)) throw this.messageNotFoundError(input.re)()
        channel = root.channel
      }
      if (!access.can('sync', channel!)) {
        throw forbidden(`this token can't sync in ${channel}, so it can't import there`)
      }
      const id = input.id === undefined ? undefined : this.importId(caller, input.id)
      const resolvedLinks = input.links ? this.resolveLinks(access, input.links) : undefined
      return this.tx(() => {
        // A retry of one that landed: it stands, whatever its origin says now (original a2.ts:967-971).
        const replay =
          id !== undefined && this.store.db.prepare('SELECT 1 FROM board_messages WHERE event_id = ?').get(id) !== undefined
        if (!replay) {
          if (input.origin) this.claimable(input.origin, input.from, root?.thread ?? null)
          this.checkSource(caller, input.source)
          introduceInTx()
        }
        const res = this.postMessageAs(
          importer,
          {
            ...(input.channel ? { channel: input.channel } : {}),
            ...(input.re ? { re: input.re } : {}),
            text: this.asNamed(caller, input.text),
            labels: input.labels,
            noSync: input.noSync,
            attachments: input.attachments,
            id,
            after: input.after,
          },
          {
            from: input.from,
            origin: input.origin,
            trustedId: true,
            trustedSync: true,
            ...(resolvedLinks !== undefined ? { links: resolvedLinks } : {}),
          },
        )
        if (input.origin && !replay) {
          // Its platform message is the copy of the sync that imported it.
          this.recordImportInTx(res.message, input.origin, ownSync ? null : caller.principal.id)
        }
        return { message: res.message }
      })
    }

    if ((input.origin === undefined) === (input.message === undefined)) {
      throw badRequest('a change names its message by `origin` or by `message`, one or the other')
    }

    let msgId = -1
    if (input.message !== undefined) {
      msgId = indexOf(input.message) ?? -1
    } else if (input.origin !== undefined) {
      // A platform message, or the root of the thread a platform thread belongs to (original a2.ts:1309-1314).
      if (input.origin.message !== undefined) {
        msgId = this.messageOfExternal(input.origin.thread, input.origin.message) ?? -1
      } else {
        const thread = this.threadOfExternal(input.origin.thread)
        const syncData = thread === null ? null : this.syncThreadData(thread)
        msgId = syncData ? (indexOf(syncData.root) ?? -1) : -1
      }
    }

    // One the caller can't sync is as good as missing: both change nothing and answer a null
    // message, the same either way, so no ID walk tells which messages exist or where
    // (original a2.ts:973-978 `if (!found || !may(found.channel)) return { message: null }`).
    const msg = msgId > 0 ? this.loadStoredMessage(msgId) : null
    if (!msg || !access.can('sync', msg.channel)) return { message: null }

    // The platform user as the import names them: never the message's author, whose authorship a
    // change named by board ID must match (original a2.ts:975-990).
    const syncCaller = importer
    const asAuthor = input.origin === undefined

    if (input.op === 'edit') {
      if (!msg.deleted && !(asAuthor && msg.by.actor !== syncCaller.actor.id)) this.checkSource(caller, input.source)
      const text = this.asNamed(caller, input.text)
      return this.tx(() => {
        introduceInTx()
        const { mentions: _mentions, ...edited } = this.editMessageAs(
          syncCaller,
          msg.id,
          { text, revision: input.revision },
          { from: input.from, asAuthor, trustedSync: true },
        )
        return { message: edited }
      })
    }
    if (input.op === 'delete') {
      return {
        message: this.deleteMessageAs(
          syncCaller,
          msg.id,
          { revision: input.revision },
          { from: input.from, asAuthor, trustedSync: true },
        ),
      }
    }
    if (input.op === 'react') {
      return {
        message: this.reactMessageAs(
          syncCaller,
          msg.id,
          { emoji: input.emoji, remove: input.remove },
          { from: input.from, trustedSync: true },
        ),
      }
    }
    if (input.op === 'labels') {
      return {
        message: this.labelMessageAs(
          syncCaller,
          msg.id,
          {
            set: input.set,
            unset: input.unset,
            if: input.if,
          },
          { trustedSync: true },
        ),
      }
    }
    return this.tx(() => {
      const current = this.loadStoredMessage(msg.id)
      if (!current || current.deleted) {
        return { message: this.toMessageView(current ?? msg, this.getActorsMap(), access) }
      }
      const resolvedLinks = this.resolveLinks(access, input.links)
      this.upsertActorInTx(syncCaller)
      const now = new Date(this.nowMs()).toISOString()
      const ev = this.store.appendEvent({
        type: 'message.linked',
        channel: current.channel,
        thread: current.thread,
        createdAt: now,
        payload: {
          id: current.id,
          thread: current.thread,
          links: resolvedLinks,
          by: {
            actor: syncCaller.actor.id,
            principal: syncCaller.principal.id,
            profile: syncCaller.profile,
          },
          from: input.from,
        },
      })
      current.links = resolvedLinks
      current.version = ev.index
      this.saveMessageInTx(current, ev.index, false, false)
      this.dispatchWatchersInTx(ev, current)
      return { message: this.toMessageView(current, this.getActorsMap(), access) }
    })
  }

  /**
   * Records what a sync delivered. A message the caller can't read is missing; one it can, but
   * can't sync, is a 403. A copy is the sync's that made it: a sync elsewhere's is named, and only
   * it changes that copy's files (original a2.ts:1000-1020).
   */
  syncReceipt(caller: CallerContext, rawInput: unknown): { ok: boolean } {
    const { caller: access } = this.requireAdmitted(caller)
    if (caller.canHeader !== undefined) {
      throw forbidden(
        "this token is narrowed with x-board-can, so it can't record what it synced: that's its project's sync's job",
      )
    }
    const input = SyncReceiptBodySchema.parse(rawInput)
    const msgId = indexOf(input.message) ?? -1
    const syncedBy = caller.principal.kind === 'deployment' ? null : caller.principal.id

    return this.tx(() => {
      const msg = msgId > 0 ? this.loadStoredMessage(msgId) : null
      if (!msg) throw this.messageNotFoundError(input.message)()
      authorizeChannel(access, 'sync', msg.channel, this.messageNotFoundError(input.message))

      if (input.kind === 'thread') {
        this.attachSyncTarget(caller, msg.id, { target: input.target })
        return { ok: true }
      }
      this.deliverable(caller, msg, input.target, input.kind === 'message' ? input.external : undefined)

      if (input.kind === 'message') {
        const copy: ExternalCopy = {
          thread: input.external.thread,
          message: input.external.message,
          ...(input.files !== undefined ? { files: input.files } : {}),
          ...(syncedBy ? { by: syncedBy } : {}),
        }
        this.store.db
          .prepare('INSERT OR REPLACE INTO board_copies (message_id, target, data) VALUES (?, ?, ?)')
          .run(msg.id, input.target, JSON.stringify(copy))
        this.store.db
          .prepare('INSERT OR REPLACE INTO board_external_messages (key, message_id) VALUES (?, ?)')
          .run(`${input.external.thread}|${input.external.message}`, msg.id)
        // A root delivered to a channel target starts a platform thread there: the thread's, from now on.
        const thread = this.syncThreadData(msg.thread)
        const kind = input.target.slice(input.target.indexOf(':') + 1).includes(':') ? 'thread' : 'channel'
        if (thread && msg.re === null && kind === 'channel') {
          thread.external[input.target] = input.external.thread
          this.store.db
            .prepare('INSERT OR REPLACE INTO board_sync_threads (thread, data) VALUES (?, ?)')
            .run(msg.thread, JSON.stringify(thread))
          this.store.db
            .prepare('INSERT OR IGNORE INTO board_external_threads (external, thread) VALUES (?, ?)')
            .run(input.external.thread, msg.thread)
        }
        delete msg.undelivered[input.target]
        const ev = this.store.appendEvent({
          type: 'message.synced',
          createdAt: new Date(this.nowMs()).toISOString(),
          channel: msg.channel,
          thread: msg.thread,
          payload: {
            id: msg.id,
            thread: msg.thread,
            target: input.target,
            external: input.external,
            ...(syncedBy ? { syncedBy } : {}),
          },
        })
        msg.version = ev.index
        this.saveMessageInTx(msg, ev.index, false, false)
      } else if (input.kind === 'failed') {
        msg.undelivered[input.target] = input.error
        const ev = this.store.appendEvent({
          type: 'message.sync_failed',
          createdAt: new Date(this.nowMs()).toISOString(),
          channel: msg.channel,
          thread: msg.thread,
          payload: { id: msg.id, thread: msg.thread, target: input.target, error: input.error },
        })
        msg.version = ev.index
        this.saveMessageInTx(msg, ev.index, false, false)
      } else {
        const existing = this.store.db
          .prepare('SELECT data FROM board_copies WHERE message_id = ? AND target = ?')
          .get(msg.id, input.target) as { data: string } | undefined
        if (existing) {
          const copy = JSON.parse(existing.data) as ExternalCopy
          // Only the sync whose copy it is says what its files are there.
          if ((copy.by ?? null) === syncedBy) {
            copy.files = input.files
            this.store.db
              .prepare('UPDATE board_copies SET data = ? WHERE message_id = ? AND target = ?')
              .run(JSON.stringify(copy), msg.id, input.target)
          }
        }
        this.store.appendEvent({
          type: 'message.files_synced',
          createdAt: new Date(this.nowMs()).toISOString(),
          channel: msg.channel,
          thread: msg.thread,
          payload: { id: msg.id, target: input.target, files: input.files, ...(syncedBy ? { syncedBy } : {}) },
        })
      }
      return { ok: true }
    })
  }

  /** A thread's sync, to a caller that may sync in its channel; 404 for anyone else (original a2.ts:1022-1028). */
  syncThread(caller: CallerContext, threadKey: string): SyncThreadView {
    const { caller: access } = this.requireAdmitted(caller)
    this.needSync(caller, access, 'look up a sync')
    const data = this.syncThreadData(threadKey)
    if (!data || !access.can('sync', data.channel)) {
      throw notFound(`no thread ${threadKey} on this board`, 'thread_not_found')
    }
    return data
  }

  /**
   * What a platform ID is on the board, only where the caller may sync: an import its own sync
   * made (by the ID it sent), the board thread a platform thread belongs to, and the board message
   * a platform message is (original a2.ts:1030-1056).
   */
  syncFind(caller: CallerContext, rawQuery: unknown): SyncFindView {
    const { caller: access } = this.requireAdmitted(caller)
    this.needSync(caller, access, 'look up a sync')
    const q = SyncFindQuerySchema.parse(rawQuery)
    let thread: string | null = null
    let message: string | null = null
    if (q.post !== undefined) {
      const row = this.store.db
        .prepare('SELECT id, channel FROM board_messages WHERE event_id = ?')
        .get(this.importId(caller, q.post)) as { id: number; channel: string } | undefined
      if (row && access.can('sync', row.channel)) message = String(row.id)
    }
    if (q.thread !== undefined) {
      const key = this.threadOfExternal(q.thread)
      const synced = key === null ? null : this.syncThreadData(key)
      if (synced && access.can('sync', synced.channel)) thread = key
      if (q.message !== undefined) {
        const id = this.messageOfExternal(q.thread, q.message)
        const found = id === null ? null : this.loadStoredMessage(id)
        if (found && access.can('sync', found.channel)) message = String(found.id)
      }
    }
    return { thread, message }
  }

  /**
   * A message's copies, only of the messages the caller may sync, and of those only its own sync's
   * copies: a sync changes what it posted, never another's under a key they share (original a2.ts:1058-1079).
   */
  syncCopies(caller: CallerContext, rawQuery: unknown): SyncCopiesView {
    const { caller: access } = this.requireAdmitted(caller)
    this.needSync(caller, access, 'look up a sync')
    const q = SyncCopiesQuerySchema.parse(rawQuery)
    const ownSync = caller.principal.kind === 'deployment'
    const mine = (copy: ExternalCopy): boolean => (ownSync ? copy.by === undefined : copy.by === caller.principal.id)
    // Only the messages the caller may sync, which for one that syncs everywhere is every ID it
    // names, found or not: each gets an entry, empty when there's no copy (original a2.ts:1058-1076).
    const everywhere = access.everywhere('sync')
    const ids = [...new Set(q.message.map(indexOf).filter((id): id is number => id !== null && id > 0))]
    const copies: Record<string, Record<string, ExternalCopy>> = {}
    for (const id of ids) {
      if (!everywhere) {
        const msg = this.loadStoredMessage(id)
        if (!msg || !access.can('sync', msg.channel)) continue
      }
      const rows = this.store.db
        .prepare('SELECT target, data FROM board_copies WHERE message_id = ?')
        .all(id) as Array<{ target: string; data: string }>
      const map: Record<string, ExternalCopy> = {}
      for (const r of rows) {
        const copy = JSON.parse(r.data) as ExternalCopy
        if (!mine(copy)) continue
        const { by: _by, ...shown } = copy
        map[r.target] = shown
      }
      copies[String(id)] = map
    }
    return { copies }
  }

  /** An inbox event's ID in the board's table: one per registrant, sync key, and event ID. */
  private inboxRowId(owner: string, syncKey: string, eventId: string): string {
    return `ib_${createHash('sha256').update(`${owner}\u001f${syncKey}\u001f${eventId}`).digest('hex').slice(0, 32)}`
  }

  /**
   * A sync's platform events, into its own queue: each registrant pushes to and pulls from its own,
   * never another's. Its platform locations belong to the key it pushes under (original a2.ts:1081-1114).
   */
  inboxPush(caller: CallerContext, syncKey: string, rawInput: unknown): { accepted: number } {
    const { caller: access } = this.requireAdmitted(caller)
    this.needSync(caller, access, 'push to an inbox', true)
    const body = InboxPushBodySchema.parse(rawInput)
    for (const { event } of body.events) {
      const subthread = 'subthread' in event ? (event.subthread as string | null | undefined) : null
      for (const location of [event.channel, event.thread, subthread ?? null]) {
        if (location !== null && !location.startsWith(`${syncKey}:`)) {
          throw badRequest(`an inbox's platform locations belong to its sync key: ${location} isn't ${syncKey}'s`)
        }
      }
    }
    const owner = caller.principal.id
    return this.tx(() => {
      const stmt = this.store.db.prepare(
        `INSERT OR IGNORE INTO board_inbox (id, owner, sync_key, channel, thread, event_json, raw_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      const nowMs = this.nowMs()
      let accepted = 0
      for (const item of body.events) {
        const res = stmt.run(
          this.inboxRowId(owner, syncKey, item.id),
          owner,
          syncKey,
          item.event.channel,
          item.event.thread,
          JSON.stringify(item.event),
          JSON.stringify(item.raw ?? null),
          nowMs,
        )
        accepted += Number(res.changes)
      }
      return { accepted }
    })
  }

  /**
   * The platform events the caller pushed for `syncKey`: each platform thread's oldest, leased for
   * five minutes, the next waiting until it's acked (original a2.ts:1116-1127, registered.ts:161-164).
   */
  inboxNext(caller: CallerContext, syncKey: string, rawQuery: unknown = {}): InboxItem[] {
    const { caller: access } = this.requireAdmitted(caller)
    this.needSync(caller, access, 'pull from an inbox', true)
    const query = InboxNextQuerySchema.parse(rawQuery)
    const limit = query.limit ?? 10
    return this.tx(() => {
      const nowMs = this.nowMs()
      const leased = this.leaseQueue('board_inbox', 'sync_key', 'owner = ? AND sync_key = ?', [caller.principal.id, syncKey], {
        limit,
        now: nowMs,
        visible: () => access.anywhere('sync'),
      })
      return leased.map(({ row, lease, attempt }) => ({
        id: row.id,
        key: syncKey,
        thread: row.thread,
        lease,
        attempt,
        event: JSON.parse(String(row.event_json)) as ExternalEvent,
        raw: JSON.parse(String(row.raw_json)) as unknown,
      }))
    })
  }

  inboxAck(caller: CallerContext, syncKey: string, itemId: string, rawInput: unknown): { ok: boolean } {
    const { caller: access } = this.requireAdmitted(caller)
    this.needSync(caller, access, 'ack an inbox event', true)
    const body = InboxAckBodySchema.parse(rawInput)
    return this.tx(() => {
      const row = this.store.db
        .prepare('SELECT sync_key FROM board_inbox WHERE id = ? AND owner = ?')
        .get(itemId, caller.principal.id) as { sync_key: string } | undefined
      const result =
        row && row.sync_key === syncKey ? this.ackQueue('board_inbox', itemId, caller.principal.id, body, this.nowMs()) : 'gone'
      if (result === 'gone') throw notFound(`no inbox event ${itemId} is waiting for this token`, 'no_item')
      if (result === 'stale') throw conflict('that lease ran out, and the event was pulled again', 'stale_lease')
      return { ok: true }
    })
  }

  /**
   * Raw platform payloads, newest first: a caller's own pushes, and for one that syncs everywhere
   * every registrant's. Sync's records, which no caller narrowed with x-board-can reads (original a2.ts:1137-1160).
   */
  listInbox(caller: CallerContext, syncKey: string, channel?: string, limit = 50): InboxEntry[] {
    const { caller: access } = this.requireAdmitted(caller)
    this.needSync(caller, access, 'read an inbox', true)
    const everyone = access.everywhere('sync')
    const rows = this.store.db
      .prepare(
        `SELECT id, sync_key, channel, event_json, raw_json, created_at FROM board_inbox
         WHERE sync_key = ? ${everyone ? '' : 'AND owner = ?'} ${channel !== undefined ? 'AND channel = ?' : ''}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(
        syncKey,
        ...(everyone ? [] : [caller.principal.id]),
        ...(channel !== undefined ? [channel] : []),
        Math.max(1, Math.min(limit, 500)),
      ) as Array<{
      id: string
      sync_key: string
      channel: string
      event_json: string
      raw_json: string
      created_at: number
    }>
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      createdAt: new Date(Number(r.created_at)).toISOString(),
      sync: r.sync_key,
      event: JSON.parse(r.event_json) as { kind: string; thread: string; [field: string]: unknown },
      raw: JSON.parse(r.raw_json) as unknown,
    }))
  }

  /**
   * Which actors `access` may see: null for a reader of every channel, who sees everyone; anyone
   * else sees who wrote, was mentioned by actor ID (`@[actor-id]`), or reacted in the channels it
   * reads, and itself (original a2.ts:350-364 actorsIn, :500-512 actors).
   */
  private visibleActorIds(access: Access, self: string): ReadonlySet<string> | null {
    if (access.readsAll) return null
    const ids = new Set<string>([self])
    const rows = this.store.db.prepare('SELECT channel, data FROM board_messages').all() as Array<{
      channel: string
      data: string
    }>
    for (const row of rows) {
      if (!access.readable(row.channel)) continue
      const msg = JSON.parse(row.data) as StoredMessage
      ids.add(msg.by.actor)
      for (const token of extractMentions(msg.text)) {
        if (token.kind === 'actor' && !/^[^\s@:]+@[^\s@:]+$/.test(token.actor)) ids.add(token.actor)
      }
      for (const reactors of Object.values(msg.reactions)) for (const id of reactors) ids.add(id)
    }
    return ids
  }

  /**
   * Settles the `@handle`s of a caller's text (original server/serve.ts:470-529 settler): a handle
   * that names exactly one actor the caller can see becomes `@[id]`. Of several, one on the board
   * wins over platform (external) users, and else the single one of them who wrote in the thread of
   * `root`, when the caller can read it. Where settling would take a text past MESSAGE_TEXT_MAX, it
   * stays as typed, each handle's actor a candidate: a writer is never refused for a length it didn't type.
   */
  private settleFor(
    access: Access,
    caller: CallerContext,
    text: string,
    root: number | null,
  ): { text: string; mentions: Mentioned[] } {
    if (!extractMentions(text).some((token) => token.kind === 'handle')) return { text, mentions: [] }
    const visible = this.mentionableActors(access, caller.actor.id)
    const fitting = (settled: { text: string; mentions: Mentioned[] }): { text: string; mentions: Mentioned[] } =>
      settled.text.length <= MESSAGE_TEXT_MAX || text.length > MESSAGE_TEXT_MAX
        ? settled
        : { text, mentions: settled.mentions.map(unsettled) }
    const settled = settleMentions(text, visible)
    if (!settled.mentions.some((mention) => mention.candidates.length > 1)) return fitting(settled)
    const actors = this.getActorsMap()
    const writers = new Set<string>()
    const rootMsg = root !== null ? this.loadStoredMessage(root) : null
    if (rootMsg && access.readable(rootMsg.channel)) {
      const rows = this.store.db
        .prepare('SELECT data FROM board_messages WHERE id = ? OR re = ?')
        .all(rootMsg.id, rootMsg.id) as Array<{ data: string }>
      for (const row of rows) writers.add((JSON.parse(row.data) as StoredMessage).by.actor)
    }
    return fitting(
      settleMentions(text, visible, (candidates) => {
        const board = candidates.filter((actor) => actors.get(actor.id)?.kind !== 'external')
        const among = board.length > 0 ? board : candidates
        if (among.length === 1) return among[0]!
        const wrote = among.filter((actor) => writers.has(actor.id))
        return wrote.length === 1 ? wrote[0]! : null
      }),
    )
  }

  /** The actors `access` may mention: what `@handle` settles against. */
  private mentionableActors(access: Access, self: string): MentionedActor[] {
    const seen = this.visibleActorIds(access, self)
    return [...this.getActorsMap().values()]
      .filter((a) => seen === null || seen.has(a.id))
      .map((a) => ({ id: a.id, handle: a.handle, name: a.name }))
  }

  listActors(caller: CallerContext, rawQuery: unknown = {}): (ActorView & { id: string })[] {
    const { caller: access } = this.requireAdmitted(caller)
    const q = ActorsQuerySchema.parse(rawQuery)
    const actors = this.getActorsMap()
    const seen = this.visibleActorIds(access, caller.actor.id)
    const wanted = q.id ? q.id.filter((id) => actors.has(id)) : [...actors.keys()]
    return wanted
      .filter((id) => seen === null || seen.has(id))
      .map((id) => ({ ...this.actorViewFor(id, actors)!, id }))
      .sort((a, b) => a.handle.localeCompare(b.handle))
  }

  /**
   * The caller as the board sees it: its actor, principal and profile, and what it may do, as far
   * as its `x-board-can` allows (original a2.ts:471-486 me).
   */
  me(caller: CallerContext): MeView {
    const { caller: access } = this.requireAdmitted(caller)
    return {
      actor: caller.actor.id,
      principal: caller.principal.id,
      kind: caller.actor.kind,
      handle: caller.actor.handle,
      name: caller.actor.name,
      avatar: caller.actor.avatar,
      profile: caller.profile,
      ...(caller.actor.via ? { via: { ...caller.actor.via } } : {}),
      ...(caller.principal.assurance !== undefined ? { assurance: caller.principal.assurance } : {}),
      expiresAt: caller.principal.expiresAt ?? null,
      can: access.summary(),
    }
  }

  // ==========================================================================
  // F14: Hybrid FTS5 Search (ACL-Filtered)
  // ==========================================================================

  search(caller: CallerContext, rawQuery: FtsSearchQuery): FtsSearchHit[] {
    const { caller: access } = this.requireAdmitted(caller)
    const parsed = SearchQuerySchema.parse(rawQuery)
    const query = parsed as FtsSearchQuery
    const callerFilter = query.filter
    return this.store.ftsSearch({
      ...query,
      filter: (hit) => {
        const readable = hit.channel !== null ? access.readable(hit.channel) : access.readsAll
        if (!readable) return false
        return callerFilter ? callerFilter(hit) : true
      },
    })
  }

  // ==========================================================================
  // V2 Social: Internal Notification Expansion & Insertion Helpers
  // ==========================================================================

  private planMessageNotificationsInTx(
    caller: CallerContext,
    access: Access,
    ctx: {
      channel: string
      text: string
      labels: Labels
      re: number | null
      rootMsg: StoredMessage | null
      replyTarget: StoredMessage | null
      quotedMsg: StoredMessage | null
      isEdit: boolean
      existingMessageId?: number
      nowIso: string
    },
  ): {
    items: Array<{
      recipient: string
      reason: NotificationReason
      priority: NotificationPriority
      sourceGroup: string | null
    }>
    fanoutTruncated: boolean
  } {
    const db = this.store.db
    const callerKeys = new Set(recipientKeysOf(caller))
    callerKeys.add(`handle:${dmSlug(caller.actor.handle)}`)

    const isSelf = (recipient: string): boolean => {
      if (callerKeys.has(recipient)) return true
      for (const alias of recipientAliases(db, recipient)) {
        if (callerKeys.has(alias)) return true
      }
      return false
    }

    const alreadyNotified = new Set<string>()
    if (ctx.isEdit && ctx.existingMessageId !== undefined) {
      const existingRows = db
        .prepare('SELECT recipient FROM board_notifications WHERE message_id = ?')
        .all(ctx.existingMessageId) as Array<{ recipient: string }>
      for (const r of existingRows) {
        for (const alias of recipientAliases(db, r.recipient)) alreadyNotified.add(alias)
      }
    }

    const markNotified = (recipient: string): boolean => {
      if (isSelf(recipient)) return false
      const aliases = recipientAliases(db, recipient)
      for (const a of aliases) {
        if (alreadyNotified.has(a)) return false
      }
      for (const a of aliases) alreadyNotified.add(a)
      return true
    }

    const isDecisionsChannel = ctx.channel === 'decisions' || ctx.channel.endsWith('/decisions')
    const isUrgent =
      (ctx.re === null && isDecisionsChannel) ||
      ctx.labels.attention === 'required' ||
      ctx.labels.priority === 'urgent'
    const priority: NotificationPriority = isUrgent ? 'urgent' : 'normal'

    const items: Array<{
      recipient: string
      reason: NotificationReason
      priority: NotificationPriority
      sourceGroup: string | null
    }> = []
    let fanoutTruncated = false

    const pushItem = (
      recipient: string,
      reason: NotificationReason,
      sourceGroup: string | null,
      prio: NotificationPriority = priority,
    ): void => {
      if (items.length >= NOTIFICATIONS_PER_MESSAGE_MAX) {
        fanoutTruncated = true
        return
      }
      items.push({ recipient, reason, priority: prio, sourceGroup })
    }

    const expandBounded = (rawTargets: readonly string[], sourceGroup: string): void => {
      const expanded: string[] = []
      const seenLocal = new Set<string>()
      for (const raw of rawTargets) {
        const resolved = resolveRecipient(db, raw)
        if (isSelf(resolved)) continue
        const aliases = recipientAliases(db, resolved)
        let dup = false
        for (const a of aliases) {
          if (seenLocal.has(a)) {
            dup = true
            break
          }
        }
        if (dup) continue
        for (const a of aliases) seenLocal.add(a)
        expanded.push(resolved)
      }
      if (expanded.length > GROUP_FANOUT_MAX) {
        fanoutTruncated = true
      }
      for (const recipient of expanded.slice(0, GROUP_FANOUT_MAX)) {
        if (markNotified(recipient)) {
          pushItem(recipient, 'group_mention', sourceGroup)
        }
      }
    }

    // 1. Direct @mentions & @group / @channel / @here / @all expansions
    const tokens = extractMentions(ctx.text)
    const directTargets: string[] = []
    const groupTokens: string[] = []

    for (const token of tokens) {
      if (token.kind === 'actor') {
        directTargets.push(token.actor)
        continue
      }
      const handle = token.handle.toLowerCase()
      if (handle === 'me' || handle === 'system' || handle === 'board') continue
      if (
        handle === 'channel' ||
        handle === 'here' ||
        handle === 'all' ||
        handle === 'all-agents' ||
        handle === 'everyone'
      ) {
        groupTokens.push(handle)
        continue
      }
      const groupRow = db
        .prepare('SELECT handle, channel FROM board_groups WHERE handle = ?')
        .get(handle) as { handle: string; channel: string | null } | undefined
      if (groupRow && (groupRow.channel === null || access.readable(groupRow.channel))) {
        groupTokens.push(handle)
      } else {
        directTargets.push(handle)
      }
    }

    // Direct mentions take precedence over group mentions/DM/reply on the same message
    for (const raw of directTargets) {
      const resolved = resolveRecipient(db, raw)
      if (markNotified(resolved)) {
        pushItem(resolved, 'mention', null)
      }
    }

    for (const handle of groupTokens) {
      if (handle === 'channel') {
        const recentActors = (
          db
            .prepare(
              `SELECT DISTINCT by_actor FROM (
                 SELECT by_actor FROM board_messages
                 WHERE channel = ? AND deleted = 0
                 ORDER BY id DESC LIMIT 200
               )`,
            )
            .all(ctx.channel) as Array<{ by_actor: string }>
        ).map((r) => r.by_actor)
        const presentActors = (
          db
            .prepare(
              `SELECT agent FROM board_presence
               WHERE channel = ? AND status IN ('active', 'busy') AND expires_at > ?`,
            )
            .all(ctx.channel, ctx.nowIso) as Array<{ agent: string }>
        ).map((r) => r.agent)
        expandBounded([...recentActors, ...presentActors], 'channel')
      } else if (handle === 'here') {
        const hereActors = (
          db
            .prepare(
              `SELECT agent FROM board_presence
               WHERE expires_at > ? AND status IN ('active', 'busy')
                 AND (channel = ? OR agent IN (
                   SELECT DISTINCT by_actor FROM (
                     SELECT by_actor FROM board_messages
                     WHERE channel = ? AND deleted = 0
                     ORDER BY id DESC LIMIT 200
                   )
                 ))`,
            )
            .all(ctx.nowIso, ctx.channel, ctx.channel) as Array<{ agent: string }>
        ).map((r) => r.agent)
        expandBounded(hereActors, 'here')
      } else if (handle === 'all' || handle === 'all-agents' || handle === 'everyone') {
        const groupMembers = (
          db
            .prepare("SELECT member_id FROM board_group_members WHERE group_handle = 'all-agents' ORDER BY member_id ASC")
            .all() as Array<{ member_id: string }>
        ).map((r) => r.member_id)
        const onlineAgents = (
          db
            .prepare("SELECT agent FROM board_presence WHERE expires_at > ? AND status != 'offline' ORDER BY agent ASC")
            .all(ctx.nowIso) as Array<{ agent: string }>
        ).map((r) => r.agent)
        expandBounded([...groupMembers, ...onlineAgents], handle)
      } else {
        const members = (
          db
            .prepare('SELECT member_id FROM board_group_members WHERE group_handle = ? ORDER BY member_id ASC')
            .all(handle) as Array<{ member_id: string }>
        ).map((r) => r.member_id)
        expandBounded(members, handle)
      }
    }

    if (!ctx.isEdit) {
      // 2. DM peer notification (dm/<a>--<b>), suppressed for self-DMs
      if (ctx.channel.startsWith('dm/')) {
        const parsed = parseDmPeers(ctx.channel)
        if (parsed) {
          const [a, b] = parsed
          if (a !== b) {
            const mySlug = dmSlug(caller.actor.handle)
            const peerSlugs = a === mySlug ? [b] : b === mySlug ? [a] : [a, b]
            for (const ps of peerSlugs) {
              const resolved = resolveRecipient(db, ps)
              if (markNotified(resolved)) {
                pushItem(resolved, 'dm', null)
              }
            }
          }
        } else {
          const members = db
            .prepare('SELECT actor_id FROM board_channel_members WHERE channel = ?')
            .all(ctx.channel) as Array<{ actor_id: string }>
          for (const m of members) {
            const resolved = resolveRecipient(db, m.actor_id)
            if (markNotified(resolved)) {
              pushItem(resolved, 'dm', null)
            }
          }
        }
      }

      // 3. Reply / quoted-message author notifications
      const replyCandidates: string[] = []
      if (ctx.re !== null) {
        if (ctx.rootMsg) replyCandidates.push(ctx.rootMsg.by.actor)
        if (ctx.replyTarget && ctx.replyTarget.by.actor !== ctx.rootMsg?.by.actor) {
          replyCandidates.push(ctx.replyTarget.by.actor)
        }
      }
      if (ctx.quotedMsg) replyCandidates.push(ctx.quotedMsg.by.actor)
      for (const candidate of replyCandidates) {
        if (markNotified(candidate)) {
          pushItem(candidate, 'reply', null)
        }
      }

      // 4. Decisions root post by an agent -> urgent attention notification to principal person
      if (ctx.re === null && isDecisionsChannel && caller.actor.kind === 'agent') {
        const principalId = caller.principal.id
        if (!isSelf(principalId)) {
          pushItem(principalId, 'attention', null, 'urgent')
        }
      }
    }

    return { items, fanoutTruncated }
  }

  private insertNotificationsInTx(
    items: readonly {
      recipient: string
      reason: NotificationReason
      priority: NotificationPriority
      sourceGroup: string | null
    }[],
    meta: {
      logIndex: number
      channel: string
      thread: string
      rootId: number
      messageId: number
      byActor: string
      excerpt: string
      createdAt: string
    },
  ): void {
    const stmt = this.store.db.prepare(
      `INSERT OR IGNORE INTO board_notifications (
        log_index, recipient, reason, priority, source_group,
        channel, thread, root_id, message_id, by_actor, excerpt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const item of items) {
      stmt.run(
        meta.logIndex,
        item.recipient,
        item.reason,
        item.priority,
        item.sourceGroup,
        meta.channel,
        meta.thread,
        meta.rootId,
        meta.messageId,
        meta.byActor,
        meta.excerpt,
        meta.createdAt,
      )
    }
  }

  private notifyTaskAssignedInTx(ev: StoredEvent, msg: StoredMessage, forActor: string | null): void {
    if (!this.hasV2Tables() || !forActor) return
    const byActor = (ev.payload.by as { actor?: string } | undefined)?.actor ?? msg.by.actor
    if (forActor === byActor) return
    const priority: NotificationPriority =
      msg.labels.priority === 'urgent' || msg.labels.attention === 'required' ? 'urgent' : 'normal'
    this.insertNotificationsInTx([{ recipient: forActor, reason: 'task_assigned', priority, sourceGroup: null }], {
      logIndex: ev.index,
      channel: msg.channel,
      thread: msg.thread,
      rootId: msg.id,
      messageId: msg.id,
      byActor,
      excerpt: excerptOf(msg.text, 200),
      createdAt: ev.createdAt,
    })
  }

  // ==========================================================================
  // V2 Social: @group Management (7 ops)
  // ==========================================================================

  private buildGroupView(row: {
    handle: string
    name: string
    description: string
    kind: string
    channel: string | null
    by_actor: string
    created_at: string
    updated_at: string
  }): GroupView {
    const members = (
      this.store.db
        .prepare(
          `SELECT member_id, role, added_by, added_at
           FROM board_group_members
           WHERE group_handle = ?
           ORDER BY CASE role WHEN 'lead' THEN 0 ELSE 1 END ASC, member_id ASC`,
        )
        .all(row.handle) as Array<{
        member_id: string
        role: 'member' | 'lead'
        added_by: string
        added_at: string
      }>
    ).map(
      (m): GroupMemberView => ({
        memberId: m.member_id,
        role: m.role,
        addedBy: m.added_by,
        addedAt: m.added_at,
      }),
    )
    return {
      handle: row.handle,
      name: row.name,
      description: row.description,
      kind: row.kind as GroupView['kind'],
      channel: row.channel,
      members,
      byActor: row.by_actor,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private authorizeGroupMutation(
    caller: CallerContext,
    access: Access,
    group: { handle: string; kind: string; channel: string | null; by_actor: string },
    isDelete: boolean,
  ): void {
    if (group.channel !== null && !access.readable(group.channel)) {
      throw notFound(`group not found: @${group.handle}`, 'group_not_found')
    }
    if (group.channel !== null) {
      authorizeChannel(access, 'post', group.channel)
    }
    const isAdmin = caller.principal.owner === true || access.everywhere('manage')
    if (isDelete && group.kind === 'system') {
      if (!isAdmin) throw forbidden(`only an owner or board admin can delete system group @${group.handle}`)
      return
    }
    if (isAdmin || group.by_actor === caller.actor.id) return
    const leadKeys = new Set(recipientKeysOf(caller))
    leadKeys.add(caller.actor.handle.toLowerCase())
    if (caller.profile !== null) leadKeys.add(caller.profile.toLowerCase())
    const leadRow = this.store.db
      .prepare(
        "SELECT 1 FROM board_group_members WHERE group_handle = ? AND role = 'lead' AND lower(member_id) IN (SELECT lower(value) FROM json_each(?)) LIMIT 1",
      )
      .get(group.handle, JSON.stringify([...leadKeys]))
    if (!leadRow) {
      throw forbidden(`this token can't modify group @${group.handle}`)
    }
  }

  listGroups(caller: CallerContext, rawQuery: unknown = {}): GroupView[] {
    const { caller: access } = this.requireAdmitted(caller)
    const query = GroupsQuerySchema.parse(rawQuery)
    if (!this.hasV2Tables()) return []
    const limit = query.limit ?? 100
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.kind !== undefined) {
      where.push('g.kind = ?')
      params.push(query.kind)
    }
    if (query.channel !== undefined) {
      if (query.channel.endsWith('/')) {
        const sub = query.channel.slice(0, -1)
        const slashPrefix = `${sub}/`
        where.push('(g.channel = ? OR substr(g.channel, 1, length(?)) = ?)')
        params.push(sub, slashPrefix, slashPrefix)
      } else {
        where.push('g.channel = ?')
        params.push(query.channel)
      }
    }
    if (query.member !== undefined) {
      const aliases = [...recipientAliases(this.store.db, query.member)]
      aliases.push(query.member.toLowerCase())
      where.push(
        'EXISTS (SELECT 1 FROM board_group_members m WHERE m.group_handle = g.handle AND lower(m.member_id) IN (SELECT lower(value) FROM json_each(?)))',
      )
      params.push(JSON.stringify([...new Set(aliases)]))
    }
    const rows = this.store.db
      .prepare(
        `SELECT g.handle, g.name, g.description, g.kind, g.channel, g.by_actor, g.created_at, g.updated_at
         FROM board_groups g ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY g.handle ASC`,
      )
      .all(...params) as Array<{
      handle: string
      name: string
      description: string
      kind: string
      channel: string | null
      by_actor: string
      created_at: string
      updated_at: string
    }>
    const out: GroupView[] = []
    for (const r of rows) {
      if (r.channel !== null && !access.readable(r.channel)) continue
      out.push(this.buildGroupView(r))
      if (out.length >= limit) break
    }
    return out
  }

  getGroup(caller: CallerContext, handle: string): GroupView {
    const { caller: access } = this.requireAdmitted(caller)
    const normalized = handle.replace(/^@/, '').toLowerCase()
    if (!this.hasV2Tables()) throw notFound(`group not found: @${normalized}`, 'group_not_found')
    const row = this.store.db
      .prepare(
        'SELECT handle, name, description, kind, channel, by_actor, created_at, updated_at FROM board_groups WHERE handle = ?',
      )
      .get(normalized) as
      | {
          handle: string
          name: string
          description: string
          kind: string
          channel: string | null
          by_actor: string
          created_at: string
          updated_at: string
        }
      | undefined
    if (!row || (row.channel !== null && !access.readable(row.channel))) {
      throw notFound(`group not found: @${normalized}`, 'group_not_found')
    }
    return this.buildGroupView(row)
  }

  createGroup(caller: CallerContext, rawInput: unknown): GroupView {
    const { caller: access } = this.requireAdmitted(caller)
    const input = CreateGroupBodySchema.parse(rawInput)
    if (RESERVED_GROUP_HANDLES.has(input.handle)) {
      throw badRequest(`@${input.handle} is a reserved group handle`, 'group_reserved')
    }
    if (!access.anywhere('post')) {
      throw forbidden("this token can't post anywhere, so it can't create a group")
    }
    if (input.channel !== undefined && input.channel !== null) {
      authorizeChannel(access, 'read', input.channel)
      authorizeChannel(access, 'post', input.channel)
    }
    const kind = input.kind ?? 'team'
    if (kind === 'system' && caller.principal.owner !== true && !access.everywhere('manage')) {
      throw forbidden('only an owner or board admin can create a system group')
    }

    return this.tx(() => {
      const existing = this.store.db
        .prepare('SELECT 1 FROM board_groups WHERE handle = ?')
        .get(input.handle)
      if (existing) {
        throw conflict(`group @${input.handle} already exists`, 'group_exists')
      }
      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      const description = input.description ?? ''
      const channel = input.channel ?? null
      this.store.db
        .prepare(
          `INSERT INTO board_groups (handle, name, description, kind, channel, by_actor, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.handle, input.name, description, kind, channel, caller.actor.id, now, now)
      if (input.members?.length) {
        const stmt = this.store.db.prepare(
          `INSERT OR IGNORE INTO board_group_members (group_handle, member_id, role, added_by, added_at)
           VALUES (?, ?, 'member', ?, ?)`,
        )
        for (const m of new Set(input.members)) {
          stmt.run(input.handle, m, caller.actor.id, now)
        }
      }
      this.store.appendEvent({
        type: 'group.created',
        ...(channel !== null ? { channel } : {}),
        payload: {
          handle: input.handle,
          name: input.name,
          kind,
          channel,
          by: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
        },
        createdAt: now,
      })
      return this.buildGroupView({
        handle: input.handle,
        name: input.name,
        description,
        kind,
        channel,
        by_actor: caller.actor.id,
        created_at: now,
        updated_at: now,
      })
    })
  }

  updateGroup(caller: CallerContext, handle: string, rawInput: unknown): GroupView {
    const { caller: access } = this.requireAdmitted(caller)
    const input = UpdateGroupBodySchema.parse(rawInput)
    const normalized = handle.replace(/^@/, '').toLowerCase()

    return this.tx(() => {
      const existing = this.store.db
        .prepare(
          'SELECT handle, name, description, kind, channel, by_actor, created_at, updated_at FROM board_groups WHERE handle = ?',
        )
        .get(normalized) as
        | {
            handle: string
            name: string
            description: string
            kind: string
            channel: string | null
            by_actor: string
            created_at: string
            updated_at: string
          }
        | undefined
      if (!existing) throw notFound(`group not found: @${normalized}`, 'group_not_found')
      this.authorizeGroupMutation(caller, access, existing, false)
      if (input.kind === 'system' && existing.kind !== 'system') {
        if (caller.principal.owner !== true && !access.everywhere('manage')) {
          throw forbidden('only an owner or board admin can set group kind to system')
        }
      }
      if (input.channel !== undefined && input.channel !== null) {
        authorizeChannel(access, 'read', input.channel)
        authorizeChannel(access, 'post', input.channel)
      }

      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      const next = {
        ...existing,
        name: input.name !== undefined ? input.name : existing.name,
        description: input.description !== undefined ? input.description : existing.description,
        kind: input.kind !== undefined ? input.kind : existing.kind,
        channel: input.channel !== undefined ? input.channel : existing.channel,
        updated_at: now,
      }
      this.store.db
        .prepare(
          'UPDATE board_groups SET name = ?, description = ?, kind = ?, channel = ?, updated_at = ? WHERE handle = ?',
        )
        .run(next.name, next.description, next.kind, next.channel, now, normalized)
      this.store.appendEvent({
        type: 'group.updated',
        ...(next.channel !== null ? { channel: next.channel } : {}),
        payload: {
          handle: normalized,
          name: next.name,
          kind: next.kind,
          channel: next.channel,
          by: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
        },
        createdAt: now,
      })
      return this.buildGroupView(next)
    })
  }

  deleteGroup(caller: CallerContext, handle: string): { deleted: boolean } {
    const { caller: access } = this.requireAdmitted(caller)
    const normalized = handle.replace(/^@/, '').toLowerCase()

    return this.tx(() => {
      const existing = this.store.db
        .prepare('SELECT handle, kind, channel, by_actor FROM board_groups WHERE handle = ?')
        .get(normalized) as
        | { handle: string; kind: string; channel: string | null; by_actor: string }
        | undefined
      if (!existing) throw notFound(`group not found: @${normalized}`, 'group_not_found')
      this.authorizeGroupMutation(caller, access, existing, true)
      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      this.store.db.prepare('DELETE FROM board_group_members WHERE group_handle = ?').run(normalized)
      this.store.db.prepare('DELETE FROM board_groups WHERE handle = ?').run(normalized)
      this.store.appendEvent({
        type: 'group.deleted',
        ...(existing.channel !== null ? { channel: existing.channel } : {}),
        payload: {
          handle: normalized,
          by: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
        },
        createdAt: now,
      })
      return { deleted: true }
    })
  }

  addGroupMembers(caller: CallerContext, handle: string, rawInput: unknown): GroupView {
    const { caller: access } = this.requireAdmitted(caller)
    const input = GroupMembersBodySchema.parse(rawInput)
    const normalized = handle.replace(/^@/, '').toLowerCase()
    const role = input.role ?? 'member'

    return this.tx(() => {
      const existing = this.store.db
        .prepare(
          'SELECT handle, name, description, kind, channel, by_actor, created_at, updated_at FROM board_groups WHERE handle = ?',
        )
        .get(normalized) as
        | {
            handle: string
            name: string
            description: string
            kind: string
            channel: string | null
            by_actor: string
            created_at: string
            updated_at: string
          }
        | undefined
      if (!existing) throw notFound(`group not found: @${normalized}`, 'group_not_found')
      this.authorizeGroupMutation(caller, access, existing, false)
      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      const stmt = this.store.db.prepare(
        `INSERT INTO board_group_members (group_handle, member_id, role, added_by, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(group_handle, member_id) DO UPDATE SET role = excluded.role`,
      )
      for (const member of new Set(input.members)) {
        stmt.run(normalized, member, role, caller.actor.id, now)
      }
      this.store.db.prepare('UPDATE board_groups SET updated_at = ? WHERE handle = ?').run(now, normalized)
      this.store.appendEvent({
        type: 'group.members_added',
        ...(existing.channel !== null ? { channel: existing.channel } : {}),
        payload: {
          handle: normalized,
          members: input.members,
          role,
          by: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
        },
        createdAt: now,
      })
      return this.buildGroupView({ ...existing, updated_at: now })
    })
  }

  removeGroupMembers(caller: CallerContext, handle: string, rawInput: unknown): GroupView {
    const { caller: access } = this.requireAdmitted(caller)
    const input = GroupMembersBodySchema.parse(rawInput)
    const normalized = handle.replace(/^@/, '').toLowerCase()

    return this.tx(() => {
      const existing = this.store.db
        .prepare(
          'SELECT handle, name, description, kind, channel, by_actor, created_at, updated_at FROM board_groups WHERE handle = ?',
        )
        .get(normalized) as
        | {
            handle: string
            name: string
            description: string
            kind: string
            channel: string | null
            by_actor: string
            created_at: string
            updated_at: string
          }
        | undefined
      if (!existing) throw notFound(`group not found: @${normalized}`, 'group_not_found')
      this.authorizeGroupMutation(caller, access, existing, false)
      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      const stmt = this.store.db.prepare(
        'DELETE FROM board_group_members WHERE group_handle = ? AND member_id = ?',
      )
      for (const member of new Set(input.members)) {
        stmt.run(normalized, member)
      }
      this.store.db.prepare('UPDATE board_groups SET updated_at = ? WHERE handle = ?').run(now, normalized)
      this.store.appendEvent({
        type: 'group.members_removed',
        ...(existing.channel !== null ? { channel: existing.channel } : {}),
        payload: {
          handle: normalized,
          members: input.members,
          by: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
        },
        createdAt: now,
      })
      return this.buildGroupView({ ...existing, updated_at: now })
    })
  }

  // ==========================================================================
  // V2 Social: Notifications, Read Cursors, Wait & Agent Inbox (7 ops)
  // ==========================================================================

  private queryNotifications(
    caller: CallerContext,
    access: Access,
    query: {
      unreadOnly?: boolean
      reason?: NotificationReason
      priority?: NotificationPriority
      channel?: string
      after?: string
      limit?: number
    },
  ): NotificationsPage {
    const head = this.store.getHeadIndex()
    if (!this.hasV2Tables()) {
      return { notifications: [], cursor: String(head), unread: 0, urgent: 0 }
    }
    const keysJson = JSON.stringify(recipientKeysOf(caller))
    const unreadOnly = query.unreadOnly ?? true
    const limit = query.limit ?? 50
    const afterIndex = query.after !== undefined ? cursorAt(query.after) : undefined

    const where: string[] = ['recipient IN (SELECT value FROM json_each(?))']
    const params: (string | number)[] = [keysJson]
    if (unreadOnly) where.push('acked_at IS NULL')
    if (query.reason !== undefined) {
      where.push('reason = ?')
      params.push(query.reason)
    }
    if (query.priority !== undefined) {
      where.push('priority = ?')
      params.push(query.priority)
    }
    if (query.channel !== undefined) {
      if (query.channel.endsWith('/')) {
        const sub = query.channel.slice(0, -1)
        const slashPrefix = `${sub}/`
        where.push('(channel = ? OR substr(channel, 1, length(?)) = ?)')
        params.push(sub, slashPrefix, slashPrefix)
      } else {
        where.push('channel = ?')
        params.push(query.channel)
      }
    }
    if (afterIndex !== undefined) {
      where.push('log_index > ?')
      params.push(afterIndex)
    }
    const orderSql = afterIndex !== undefined ? 'ORDER BY log_index ASC, id ASC' : 'ORDER BY log_index DESC, id DESC'

    const rows = this.store.db
      .prepare(
        `SELECT id, log_index, recipient, reason, priority, source_group,
                channel, thread, root_id, message_id, by_actor, excerpt,
                created_at, read_at, acked_at
         FROM board_notifications
         WHERE ${where.join(' AND ')}
         ${orderSql}`,
      )
      .all(...params) as Array<{
      id: number
      log_index: number
      recipient: string
      reason: NotificationReason
      priority: NotificationPriority
      source_group: string | null
      channel: string
      thread: string
      root_id: number
      message_id: number
      by_actor: string
      excerpt: string
      created_at: string
      read_at: string | null
      acked_at: string | null
    }>

    const actors = this.getActorsMap()
    const notifications: NotificationView[] = []
    for (const r of rows) {
      if (!access.readable(r.channel)) continue
      notifications.push({
        id: String(r.id),
        logIndex: Number(r.log_index),
        recipient: r.recipient,
        reason: r.reason,
        priority: r.priority,
        sourceGroup: r.source_group,
        channel: r.channel,
        thread: r.thread,
        rootId: String(r.root_id),
        messageId: String(r.message_id),
        byActor: r.by_actor,
        byHandle: actors.get(r.by_actor)?.handle ?? null,
        excerpt: r.excerpt,
        createdAt: r.created_at,
        readAt: r.read_at,
        ackedAt: r.acked_at,
      })
      if (notifications.length >= limit) break
    }

    const unreadRows = this.store.db
      .prepare(
        `SELECT channel, priority FROM board_notifications
         WHERE recipient IN (SELECT value FROM json_each(?)) AND acked_at IS NULL`,
      )
      .all(keysJson) as Array<{ channel: string; priority: NotificationPriority }>
    let unread = 0
    let urgent = 0
    for (const r of unreadRows) {
      if (!access.readable(r.channel)) continue
      unread += 1
      if (r.priority === 'urgent') urgent += 1
    }

    return {
      notifications,
      cursor: String(head),
      unread,
      urgent,
    }
  }

  listNotifications(caller: CallerContext, rawQuery: unknown = {}): NotificationsPage {
    const { caller: access } = this.requireAdmitted(caller)
    const query = NotificationsQuerySchema.parse(rawQuery)
    return this.queryNotifications(caller, access, query)
  }

  countNotifications(
    caller: CallerContext,
    rawQuery: unknown = {},
  ): { total: number; unread: number; urgent: number; byReason: Record<string, number> } {
    const { caller: access } = this.requireAdmitted(caller)
    const query = NotificationsQuerySchema.parse(rawQuery)
    if (!this.hasV2Tables()) return { total: 0, unread: 0, urgent: 0, byReason: {} }
    const keysJson = JSON.stringify(recipientKeysOf(caller))
    const unreadOnly = query.unreadOnly ?? true
    const afterIndex = query.after !== undefined ? cursorAt(query.after) : undefined

    const where: string[] = ['recipient IN (SELECT value FROM json_each(?))']
    const params: (string | number)[] = [keysJson]
    if (unreadOnly) where.push('acked_at IS NULL')
    if (query.reason !== undefined) {
      where.push('reason = ?')
      params.push(query.reason)
    }
    if (query.priority !== undefined) {
      where.push('priority = ?')
      params.push(query.priority)
    }
    if (query.channel !== undefined) {
      if (query.channel.endsWith('/')) {
        const sub = query.channel.slice(0, -1)
        const slashPrefix = `${sub}/`
        where.push('(channel = ? OR substr(channel, 1, length(?)) = ?)')
        params.push(sub, slashPrefix, slashPrefix)
      } else {
        where.push('channel = ?')
        params.push(query.channel)
      }
    }
    if (afterIndex !== undefined) {
      where.push('log_index > ?')
      params.push(afterIndex)
    }

    const rows = this.store.db
      .prepare(`SELECT channel, reason, priority, acked_at FROM board_notifications WHERE ${where.join(' AND ')}`)
      .all(...params) as Array<{
      channel: string
      reason: NotificationReason
      priority: NotificationPriority
      acked_at: string | null
    }>

    let total = 0
    let unread = 0
    let urgent = 0
    const byReason: Record<string, number> = {}
    for (const r of rows) {
      if (!access.readable(r.channel)) continue
      total += 1
      if (r.acked_at === null) unread += 1
      if (r.priority === 'urgent') urgent += 1
      byReason[r.reason] = (byReason[r.reason] ?? 0) + 1
    }
    return { total, unread, urgent, byReason }
  }

  ackNotification(
    caller: CallerContext,
    id: string,
    rawInput: unknown = {},
  ): { ok: boolean; notification: NotificationView } {
    const { caller: access } = this.requireAdmitted(caller)
    const input = AckNotificationBodySchema.parse(rawInput)
    const notifId = indexOf(id)
    const missing = (): BoardError => notFound(`notification not found: ${id}`, 'notification_not_found')
    if (notifId === null || notifId <= 0) throw missing()
    const keys = new Set(recipientKeysOf(caller))

    return this.tx(() => {
      const row = this.store.db
        .prepare(
          `SELECT id, log_index, recipient, reason, priority, source_group,
                  channel, thread, root_id, message_id, by_actor, excerpt,
                  created_at, read_at, acked_at
           FROM board_notifications WHERE id = ?`,
        )
        .get(notifId) as
        | {
            id: number
            log_index: number
            recipient: string
            reason: NotificationReason
            priority: NotificationPriority
            source_group: string | null
            channel: string
            thread: string
            root_id: number
            message_id: number
            by_actor: string
            excerpt: string
            created_at: string
            read_at: string | null
            acked_at: string | null
          }
        | undefined
      if (!row || !keys.has(row.recipient) || !access.readable(row.channel)) throw missing()

      const now = new Date(this.nowMs()).toISOString()
      const readAt = row.read_at ?? now
      const ackedAt = input.readOnly === true ? row.acked_at : (row.acked_at ?? now)
      if (input.readOnly === true) {
        this.store.db
          .prepare('UPDATE board_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?')
          .run(now, notifId)
      } else {
        this.store.db
          .prepare(
            'UPDATE board_notifications SET read_at = COALESCE(read_at, ?), acked_at = COALESCE(acked_at, ?) WHERE id = ?',
          )
          .run(now, now, notifId)
      }
      const actors = this.getActorsMap()
      return {
        ok: true,
        notification: {
          id: String(row.id),
          logIndex: Number(row.log_index),
          recipient: row.recipient,
          reason: row.reason,
          priority: row.priority,
          sourceGroup: row.source_group,
          channel: row.channel,
          thread: row.thread,
          rootId: String(row.root_id),
          messageId: String(row.message_id),
          byActor: row.by_actor,
          byHandle: actors.get(row.by_actor)?.handle ?? null,
          excerpt: row.excerpt,
          createdAt: row.created_at,
          readAt,
          ackedAt,
        },
      }
    })
  }

  ackAllNotifications(
    caller: CallerContext,
    rawInput: unknown = {},
  ): { acked: number; cursor: string } {
    const { caller: access } = this.requireAdmitted(caller)
    const input = AckAllNotificationsBodySchema.parse(rawInput)
    const beforeCursor = input.beforeCursor !== undefined ? cursorAt(input.beforeCursor) : undefined
    const keysJson = JSON.stringify(recipientKeysOf(caller))

    return this.tx(() => {
      const where: string[] = ['recipient IN (SELECT value FROM json_each(?))', 'acked_at IS NULL']
      const params: (string | number)[] = [keysJson]
      if (input.reason !== undefined) {
        where.push('reason = ?')
        params.push(input.reason)
      }
      if (beforeCursor !== undefined) {
        where.push('log_index <= ?')
        params.push(beforeCursor)
      }
      if (input.channel !== undefined) {
        if (input.channel.endsWith('/')) {
          const sub = input.channel.slice(0, -1)
          const slashPrefix = `${sub}/`
          where.push('(channel = ? OR substr(channel, 1, length(?)) = ?)')
          params.push(sub, slashPrefix, slashPrefix)
        } else {
          where.push('channel = ?')
          params.push(input.channel)
        }
      }

      const candidates = this.store.db
        .prepare(`SELECT id, channel FROM board_notifications WHERE ${where.join(' AND ')}`)
        .all(...params) as Array<{ id: number; channel: string }>
      const readableIds = candidates.filter((r) => access.readable(r.channel)).map((r) => Number(r.id))
      const now = new Date(this.nowMs()).toISOString()

      if (readableIds.length > 0) {
        this.store.db
          .prepare(
            `UPDATE board_notifications
             SET read_at = COALESCE(read_at, ?), acked_at = ?
             WHERE id IN (SELECT value FROM json_each(?))`,
          )
          .run(now, now, JSON.stringify(readableIds))
      }

      if (input.markChannelRead === true) {
        const chRows = this.store.db
          .prepare('SELECT path, last_index FROM board_channels')
          .all() as Array<{ path: string; last_index: number }>
        const upsertCursor = this.store.db.prepare(
          `INSERT INTO board_read_cursors (actor_id, channel, last_read_index, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(actor_id, channel) DO UPDATE SET
             last_read_index = MAX(last_read_index, excluded.last_read_index),
             updated_at = excluded.updated_at`,
        )
        for (const ch of chRows) {
          if (!access.readable(ch.path)) continue
          if (input.channel !== undefined) {
            if (input.channel.endsWith('/')) {
              const sub = input.channel.slice(0, -1)
              if (ch.path !== sub && !ch.path.startsWith(`${sub}/`)) continue
            } else if (ch.path !== input.channel) {
              continue
            }
          }
          const targetIdx = beforeCursor !== undefined ? Math.min(beforeCursor, Number(ch.last_index)) : Number(ch.last_index)
          upsertCursor.run(caller.actor.id, ch.path, targetIdx, now)
        }
      }

      return {
        acked: readableIds.length,
        cursor: String(this.store.getHeadIndex()),
      }
    })
  }

  markChannelRead(
    caller: CallerContext,
    rawInput: unknown,
  ): { channel: string; cursor: string } {
    const { caller: access } = this.requireAdmitted(caller)
    const input = MarkChannelReadBodySchema.parse(rawInput)
    if (!access.readable(input.channel)) {
      throw notFound(`channel not found: ${input.channel}`, 'channel_not_found')
    }
    const explicitCursor = input.cursor !== undefined ? cursorAt(input.cursor) : undefined

    return this.tx(() => {
      const chRow = this.store.db
        .prepare('SELECT last_index FROM board_channels WHERE path = ?')
        .get(input.channel) as { last_index: number } | undefined
      const targetIndex =
        explicitCursor !== undefined
          ? explicitCursor
          : chRow
            ? Number(chRow.last_index)
            : this.store.getHeadIndex()
      const now = new Date(this.nowMs()).toISOString()
      this.store.db
        .prepare(
          `INSERT INTO board_read_cursors (actor_id, channel, last_read_index, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(actor_id, channel) DO UPDATE SET
             last_read_index = excluded.last_read_index,
             updated_at = excluded.updated_at`,
        )
        .run(caller.actor.id, input.channel, targetIndex, now)
      return {
        channel: input.channel,
        cursor: String(targetIndex),
      }
    })
  }

  async waitNotifications(
    caller: CallerContext,
    rawQuery: unknown = {},
    signal?: AbortSignal,
  ): Promise<NotificationsPage> {
    const { caller: access, raw: rawAccess } = this.requireAdmitted(caller)
    const query = WaitNotificationsQuerySchema.parse(rawQuery)
    const initial = this.queryNotifications(caller, access, query)
    const waitMs = Math.round((query.wait ?? 0) * 1000)
    if (initial.notifications.length > 0 || waitMs <= 0 || signal?.aborted) {
      return initial
    }

    let lastCheckedHead = Number(initial.cursor)
    return new Promise<NotificationsPage>((resolve, reject) => {
      let done = false
      const stop = (): boolean => {
        if (done) return false
        done = true
        clearTimeout(timer)
        clearInterval(poll)
        unsub()
        signal?.removeEventListener('abort', finish)
        return true
      }
      const finish = (): void => {
        if (!stop()) return
        try {
          const liveAccess = this.withPrivateAcl(caller, rawAccess)
          resolve(this.queryNotifications(caller, liveAccess, query))
        } catch {
          resolve({ notifications: [], cursor: String(lastCheckedHead), unread: initial.unread, urgent: initial.urgent })
        }
      }
      const look = (): void => {
        if (done) return
        try {
          const head = this.store.getHeadIndex()
          if (head <= lastCheckedHead) return
          lastCheckedHead = head
          const liveAccess = this.withPrivateAcl(caller, rawAccess)
          const page = this.queryNotifications(caller, liveAccess, query)
          if (page.notifications.length > 0 && stop()) {
            resolve(page)
          }
        } catch (error) {
          if (isStoreFailure(error)) finish()
          else if (stop()) reject(error)
        }
      }
      const unsub = this.store.onEvent((ev) => {
        if (ev.index > lastCheckedHead) look()
      })
      const timer = setTimeout(finish, waitMs)
      const poll = setInterval(look, this.eventsWaitPollMs)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  getAgentInbox(caller: CallerContext, rawQuery: unknown = {}): AgentInboxView {
    const { caller: access } = this.requireAdmitted(caller)
    const query = AgentInboxQuerySchema.parse(rawQuery)
    const notificationsLimit = query.notificationsLimit ?? 20
    const tasksLimit = query.tasksLimit ?? 10
    const includeReadyPool = query.includeReadyPool ?? true
    const urgentOnly = query.urgentOnly ?? false

    const notifPage = this.queryNotifications(caller, access, {
      unreadOnly: true,
      limit: notificationsLimit,
      ...(urgentOnly ? { priority: 'urgent' as const } : {}),
      ...(query.channel !== undefined ? { channel: query.channel } : {}),
    })

    const actors = this.getActorsMap()
    const nowMs = this.nowMs()
    const nowIso = new Date(nowMs).toISOString()

    const channelMatches = (ch: string): boolean => {
      if (query.channel === undefined) return true
      if (query.channel.endsWith('/')) {
        const sub = query.channel.slice(0, -1)
        return ch === sub || ch.startsWith(`${sub}/`)
      }
      return ch === query.channel
    }

    const toTaskDigest = (r: {
      task_id: number
      state: TaskState
      owner: string
      for_actor: string | null
      claim_until_ms: number | null
      data: string
      replies: number
      at: number | null
    }): CompactTaskDigest => {
      const msg = JSON.parse(r.data) as StoredMessage
      const effectiveState: TaskState =
        r.state === 'claimed' && r.claim_until_ms !== null && Number(r.claim_until_ms) <= nowMs
          ? 'ready'
          : r.state
      let latestMsg: StoredMessage | null = null
      const at = r.at === null ? null : Number(r.at)
      if (at !== null && at !== Number(r.task_id)) {
        const loaded = this.loadStoredMessage(at)
        if (loaded && !loaded.deleted) {
          latestMsg = loaded
        } else {
          const liveRow = this.store.db
            .prepare('SELECT data FROM board_messages WHERE re = ? AND deleted = 0 ORDER BY id DESC LIMIT 1')
            .get(Number(r.task_id)) as { data: string } | undefined
          if (liveRow) latestMsg = JSON.parse(liveRow.data) as StoredMessage
        }
      }
      return {
        id: String(msg.id),
        channel: msg.channel,
        thread: msg.thread,
        state: effectiveState,
        for: r.for_actor,
        owner: r.owner,
        text: excerptOf(msg.text, 200),
        replies: Number(r.replies),
        createdAt: msg.createdAt,
        latestReply: latestMsg
          ? {
              id: String(latestMsg.id),
              by: latestMsg.by.actor,
              handle: actors.get(latestMsg.by.actor)?.handle ?? null,
              excerpt: excerptOf(latestMsg.text, 160),
              createdAt: latestMsg.createdAt,
            }
          : null,
      }
    }

    const assignedRows = this.store.db
      .prepare(
        `SELECT t.task_id, t.state, t.owner, t.for_actor, t.claim_until_ms, m.data, m.replies, m.at
         FROM board_tasks t JOIN board_messages m ON m.id = t.task_id
         WHERE t.root_deleted = 0 AND m.deleted = 0 AND m.re IS NULL
           AND t.state IN ('waiting', 'ready', 'claimed', 'blocked')
           AND ((t.for_actor = ? AND t.owner = ?) OR (t.state = 'claimed' AND t.claim_actor = ? AND t.claim_until_ms > ?))
         ORDER BY t.priority DESC, t.task_id ASC`,
      )
      .all(caller.actor.id, caller.principal.id, caller.actor.id, nowMs) as Array<{
      task_id: number
      state: TaskState
      owner: string
      for_actor: string | null
      claim_until_ms: number | null
      data: string
      replies: number
      at: number | null
    }>
    const assigned: CompactTaskDigest[] = []
    for (const r of assignedRows) {
      const msg = JSON.parse(r.data) as StoredMessage
      if (!access.readable(msg.channel) || !channelMatches(msg.channel)) continue
      assigned.push(toTaskDigest(r))
      if (assigned.length >= tasksLimit) break
    }

    const ready: CompactTaskDigest[] = []
    if (includeReadyPool) {
      const readyRows = this.store.db
        .prepare(
          `SELECT t.task_id, t.state, t.owner, t.for_actor, t.claim_until_ms, m.data, m.replies, m.at
           FROM board_tasks t JOIN board_messages m ON m.id = t.task_id
           WHERE t.root_deleted = 0 AND m.deleted = 0 AND m.re IS NULL
             AND t.for_actor IS NULL AND t.owner = ?
             AND (t.state = 'ready' OR (t.state = 'claimed' AND t.claim_until_ms <= ?))
           ORDER BY t.priority DESC, t.task_id ASC`,
        )
        .all(caller.principal.id, nowMs) as Array<{
        task_id: number
        state: TaskState
        owner: string
        for_actor: string | null
        claim_until_ms: number | null
        data: string
        replies: number
        at: number | null
      }>
      for (const r of readyRows) {
        const msg = JSON.parse(r.data) as StoredMessage
        if (!access.readable(msg.channel) || !channelMatches(msg.channel)) continue
        ready.push(toTaskDigest(r))
        if (ready.length >= tasksLimit) break
      }
    }

    // Unread channels & unread DMs
    const unreadMap = this.unreadCountsByChannel(caller.actor.id)
    const unreadChannels: Array<{ channel: string; kind: ChannelKind; unread: number; lastIndex: number }> = []
    const unreadDms: Array<{
      channel: string
      peer: string
      unread: number
      lastExcerpt: string
      lastIndex: number
    }> = []

    if (unreadMap.size > 0) {
      const chRows = this.store.db
        .prepare(
          `SELECT c.path, c.last_index, m.kind, m.archived
           FROM board_channels c
           LEFT JOIN board_channel_meta m ON m.path = c.path
           ORDER BY c.last_index DESC`,
        )
        .all() as Array<{ path: string; last_index: number; kind: ChannelKind | null; archived: number | null }>
      const mySlug = dmSlug(caller.actor.handle)
      for (const c of chRows) {
        const unread = unreadMap.get(c.path) ?? 0
        if (unread <= 0) continue
        if (c.archived === 1) continue
        if (!access.readable(c.path) || !channelMatches(c.path)) continue
        const kind = c.kind ?? inferChannelKind(c.path)
        if (kind === 'dm' || c.path.startsWith('dm/')) {
          const peers = parseDmPeers(c.path)
          const peer = peers ? (peers[0] === mySlug ? peers[1] : peers[0]) : c.path.slice(3)
          const latest = this.store.db
            .prepare('SELECT text FROM board_messages WHERE channel = ? AND deleted = 0 ORDER BY id DESC LIMIT 1')
            .get(c.path) as { text: string } | undefined
          unreadDms.push({
            channel: c.path,
            peer,
            unread,
            lastExcerpt: latest ? excerptOf(latest.text, 160) : '',
            lastIndex: Number(c.last_index),
          })
        } else {
          unreadChannels.push({
            channel: c.path,
            kind,
            unread,
            lastIndex: Number(c.last_index),
          })
        }
      }
    }

    let onlinePeers = 0
    if (this.hasV2Tables()) {
      const onlineRow = this.store.db
        .prepare(
          "SELECT COUNT(*) AS c FROM board_presence WHERE expires_at > ? AND status != 'offline' AND agent != ?",
        )
        .get(nowIso, caller.actor.id) as { c: number }
      onlinePeers = Number(onlineRow.c)
    }

    return {
      actor: caller.actor.id,
      profile: caller.profile,
      cursor: String(this.store.getHeadIndex()),
      unreadNotifications: notifPage.unread,
      urgentCount: notifPage.urgent,
      notifications: notifPage.notifications,
      tasks: { assigned, ready },
      unreadChannels,
      unreadDms,
      onlinePeers,
    }
  }

  // ==========================================================================
  // V2 Social: Pinned Posts, Sticky Threads & Announcements (3 ops)
  // ==========================================================================

  pinMessage(
    caller: CallerContext,
    id: string | number,
    rawInput: unknown = {},
  ): { pin: PinView; created: boolean } {
    const { caller: access } = this.requireAdmitted(caller)
    const input = PinBodySchema.parse(rawInput)
    const msgId = resolveMessageId(this.store.db, id)

    return this.tx(() => {
      const msg = msgId > 0 ? this.loadStoredMessage(msgId) : null
      if (!msg || !access.readable(msg.channel)) throw this.messageNotFoundError(id)()
      authorizeChannel(access, 'label', msg.channel, this.messageNotFoundError(id))
      if (msg.deleted) throw badRequest('message was deleted', 'message_deleted')

      const rootId = msg.re ?? msg.id
      const targetId = input.scope === 'thread' ? msg.id : rootId
      const targetMsg = targetId === msg.id ? msg : this.loadStoredMessage(targetId)
      if (!targetMsg || targetMsg.deleted) {
        throw badRequest('message was deleted', 'message_deleted')
      }

      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      const existing = this.store.db
        .prepare(
          `SELECT id, scope, channel, root_id, thread, message_id, pinned_by, pinned_at, note, sort_order
           FROM board_pins WHERE scope = ? AND channel = ? AND message_id = ?`,
        )
        .get(input.scope, msg.channel, targetId) as
        | {
            id: number
            scope: PinScope
            channel: string
            root_id: number
            thread: string
            message_id: number
            pinned_by: string
            pinned_at: string
            note: string | null
            sort_order: number
          }
        | undefined

      let pinRowId: number
      let pinnedBy: string
      let pinnedAt: string
      let note: string | null
      let sortOrder: number
      let created: boolean

      if (existing) {
        created = false
        pinRowId = Number(existing.id)
        pinnedBy = existing.pinned_by
        pinnedAt = existing.pinned_at
        note = input.note !== undefined ? input.note : existing.note
        sortOrder = input.sortOrder !== undefined ? input.sortOrder : Number(existing.sort_order)
        this.store.db
          .prepare('UPDATE board_pins SET note = ?, sort_order = ? WHERE id = ?')
          .run(note, sortOrder, pinRowId)
      } else {
        created = true
        pinnedBy = caller.actor.id
        pinnedAt = now
        note = input.note ?? null
        sortOrder = input.sortOrder ?? 0
        const res = this.store.db
          .prepare(
            `INSERT INTO board_pins (scope, channel, root_id, thread, message_id, pinned_by, pinned_at, note, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(input.scope, msg.channel, rootId, msg.thread, targetId, pinnedBy, pinnedAt, note, sortOrder)
        pinRowId = Number(res.lastInsertRowid)
      }

      const ev = this.store.appendEvent({
        type: 'message.pinned',
        channel: msg.channel,
        thread: msg.thread,
        createdAt: now,
        payload: {
          id: targetId,
          thread: msg.thread,
          rootId,
          scope: input.scope,
          channel: msg.channel,
          note,
          by: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
        },
      })

      if (created && (input.scope === 'announcement' || input.notify === true)) {
        const callerKeys = new Set(recipientKeysOf(caller))
        if (!callerKeys.has(targetMsg.by.actor)) {
          this.insertNotificationsInTx(
            [
              {
                recipient: targetMsg.by.actor,
                reason: 'pin',
                priority: input.scope === 'announcement' ? 'urgent' : 'normal',
                sourceGroup: null,
              },
            ],
            {
              logIndex: ev.index,
              channel: msg.channel,
              thread: msg.thread,
              rootId,
              messageId: targetId,
              byActor: caller.actor.id,
              excerpt: excerptOf(targetMsg.text, 200),
              createdAt: now,
            },
          )
        }
      }

      const actors = this.getActorsMap()
      return {
        pin: {
          id: String(pinRowId),
          scope: input.scope,
          channel: msg.channel,
          rootId: String(rootId),
          thread: msg.thread,
          messageId: String(targetId),
          pinnedBy,
          pinnedAt,
          note,
          sortOrder,
          message: this.toMessageView(targetMsg, actors, access),
        },
        created,
      }
    })
  }

  unpinMessage(
    caller: CallerContext,
    id: string | number,
    rawInput: unknown = {},
  ): { unpinned: number } {
    const { caller: access } = this.requireAdmitted(caller)
    const input = UnpinBodySchema.parse(rawInput)
    const msgId = resolveMessageId(this.store.db, id)

    return this.tx(() => {
      const msg = msgId > 0 ? this.loadStoredMessage(msgId) : null
      if (!msg || !access.readable(msg.channel)) throw this.messageNotFoundError(id)()
      authorizeChannel(access, 'label', msg.channel, this.messageNotFoundError(id))

      const rootId = msg.re ?? msg.id
      let rows: Array<{ id: number; scope: PinScope; message_id: number; root_id: number }>
      if (input.scope !== undefined) {
        const targetId = input.scope === 'thread' ? msg.id : rootId
        rows = this.store.db
          .prepare(
            'SELECT id, scope, message_id, root_id FROM board_pins WHERE scope = ? AND channel = ? AND message_id = ?',
          )
          .all(input.scope, msg.channel, targetId) as Array<{
          id: number
          scope: PinScope
          message_id: number
          root_id: number
        }>
      } else {
        rows = this.store.db
          .prepare('SELECT id, scope, message_id, root_id FROM board_pins WHERE channel = ? AND message_id = ?')
          .all(msg.channel, msg.id) as Array<{
          id: number
          scope: PinScope
          message_id: number
          root_id: number
        }>
      }

      if (rows.length === 0) return { unpinned: 0 }
      this.upsertActorInTx(caller)
      const now = new Date(this.nowMs()).toISOString()
      const del = this.store.db.prepare('DELETE FROM board_pins WHERE id = ?')
      for (const r of rows) {
        del.run(Number(r.id))
        this.store.appendEvent({
          type: 'message.unpinned',
          channel: msg.channel,
          thread: msg.thread,
          createdAt: now,
          payload: {
            id: Number(r.message_id),
            thread: msg.thread,
            rootId: Number(r.root_id),
            scope: r.scope,
            channel: msg.channel,
            note: null,
            by: { actor: caller.actor.id, principal: caller.principal.id, profile: caller.profile },
          },
        })
      }
      return { unpinned: rows.length }
    })
  }

  listPins(caller: CallerContext, rawQuery: unknown = {}): PinView[] {
    const { caller: access } = this.requireAdmitted(caller)
    const query = PinsQuerySchema.parse(rawQuery)
    if (!this.hasV2Tables()) return []
    const limit = query.limit ?? 50
    const where: string[] = []
    const params: (string | number)[] = []

    if (query.scope !== undefined) {
      where.push('scope = ?')
      params.push(query.scope)
    }
    if (query.thread !== undefined) {
      const tid = resolveMessageId(this.store.db, query.thread)
      if (tid > 0) {
        const tMsg = this.loadStoredMessage(tid)
        const rootId = tMsg ? (tMsg.re ?? tMsg.id) : tid
        where.push('root_id = ?')
        params.push(rootId)
      } else {
        where.push('thread = ?')
        params.push(query.thread)
      }
    }
    if (query.channel !== undefined) {
      if (query.channel.endsWith('/')) {
        const sub = query.channel.slice(0, -1)
        const slashPrefix = `${sub}/`
        if (query.includeGlobal === true) {
          where.push("(channel = ? OR substr(channel, 1, length(?)) = ? OR scope = 'announcement')")
        } else {
          where.push('(channel = ? OR substr(channel, 1, length(?)) = ?)')
        }
        params.push(sub, slashPrefix, slashPrefix)
      } else if (query.includeGlobal === true) {
        where.push("(channel = ? OR scope = 'announcement')")
        params.push(query.channel)
      } else {
        where.push('channel = ?')
        params.push(query.channel)
      }
    }

    const rows = this.store.db
      .prepare(
        `SELECT id, scope, channel, root_id, thread, message_id, pinned_by, pinned_at, note, sort_order
         FROM board_pins
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY CASE scope WHEN 'announcement' THEN 0 WHEN 'channel' THEN 1 ELSE 2 END ASC, sort_order ASC, id DESC`,
      )
      .all(...params) as Array<{
      id: number
      scope: PinScope
      channel: string
      root_id: number
      thread: string
      message_id: number
      pinned_by: string
      pinned_at: string
      note: string | null
      sort_order: number
    }>

    const actors = this.getActorsMap()
    const out: PinView[] = []
    for (const r of rows) {
      if (!access.readable(r.channel)) continue
      const msg = this.loadStoredMessage(Number(r.message_id))
      out.push({
        id: String(r.id),
        scope: r.scope,
        channel: r.channel,
        rootId: String(r.root_id),
        thread: r.thread,
        messageId: String(r.message_id),
        pinnedBy: r.pinned_by,
        pinnedAt: r.pinned_at,
        note: r.note,
        sortOrder: Number(r.sort_order),
        ...(msg && !msg.deleted ? { message: this.toMessageView(msg, actors, access) } : {}),
      })
      if (out.length >= limit) break
    }
    return out
  }

  // ==========================================================================
  // V2 Social: Agent Presence ("Who is Online") (2 ops)
  // ==========================================================================

  setPresence(caller: CallerContext, rawInput: unknown = {}): PresenceView {
    const { caller: access } = this.requireAdmitted(caller)
    const input = SetPresenceBodySchema.parse(rawInput)
    if (input.channel !== undefined && input.channel !== null && !access.readable(input.channel)) {
      throw forbidden(`this token can't read ${input.channel}`)
    }

    return this.tx(() => {
      const prev = this.store.db
        .prepare(
          'SELECT status, channel, task_id, note, harness, model FROM board_presence WHERE agent = ?',
        )
        .get(caller.actor.id) as
        | {
            status: PresenceStatus
            channel: string | null
            task_id: string | null
            note: string | null
            harness: string | null
            model: string | null
          }
        | undefined

      this.upsertActorInTx(caller)
      const nowMs = this.nowMs()
      const nowIso = new Date(nowMs).toISOString()
      const expiresIso = new Date(nowMs + input.ttlS * 1000).toISOString()
      const channel = input.channel === undefined ? null : input.channel
      let taskId: string | null = null
      if (input.taskId !== undefined && input.taskId !== null) {
        const resolved = resolveMessageId(this.store.db, input.taskId)
        taskId = resolved > 0 ? String(resolved) : input.taskId
      }
      const note = input.note === undefined ? null : input.note
      const harness = input.harness !== undefined ? input.harness : (prev?.harness ?? null)
      const model = input.model !== undefined ? input.model : (prev?.model ?? null)

      this.store.db
        .prepare(
          `INSERT INTO board_presence (
            agent, principal, profile, handle, harness, model, status, channel, task_id, note, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent) DO UPDATE SET
            principal = excluded.principal,
            profile = excluded.profile,
            handle = excluded.handle,
            harness = excluded.harness,
            model = excluded.model,
            status = excluded.status,
            channel = excluded.channel,
            task_id = excluded.task_id,
            note = excluded.note,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at`,
        )
        .run(
          caller.actor.id,
          caller.principal.id,
          caller.profile,
          caller.actor.handle,
          harness,
          model,
          input.status,
          channel,
          taskId,
          note,
          nowIso,
          expiresIso,
        )

      const changed =
        !prev ||
        prev.status !== input.status ||
        prev.channel !== channel ||
        prev.task_id !== taskId ||
        prev.note !== note

      if (changed) {
        this.store.appendEvent({
          type: 'presence.updated',
          ...(channel !== null ? { channel } : {}),
          payload: {
            agent: caller.actor.id,
            handle: caller.actor.handle,
            status: input.status,
            channel,
            taskId,
            note,
            harness,
            model,
            expiresAt: expiresIso,
          },
          createdAt: nowIso,
        })
      }

      return {
        agent: caller.actor.id,
        principal: caller.principal.id,
        profile: caller.profile,
        handle: caller.actor.handle,
        harness,
        model,
        status: input.status,
        channel,
        taskId,
        note,
        updatedAt: nowIso,
        expiresAt: expiresIso,
      }
    })
  }

  listPresence(caller: CallerContext, rawQuery: unknown = {}): PresenceView[] {
    const { caller: access } = this.requireAdmitted(caller)
    const query = PresenceQuerySchema.parse(rawQuery)
    if (!this.hasV2Tables()) return []
    if (query.channel !== undefined && !query.channel.endsWith('/') && !access.readable(query.channel)) {
      return []
    }
    const includeOffline = query.includeOffline === true
    const limit = query.limit ?? 100
    const nowIso = new Date(this.nowMs()).toISOString()

    const rows = this.store.db
      .prepare(
        `SELECT agent, principal, profile, handle, harness, model, status, channel, task_id, note, updated_at, expires_at
         FROM board_presence
         ORDER BY updated_at DESC, agent ASC`,
      )
      .all() as Array<{
      agent: string
      principal: string
      profile: string | null
      handle: string
      harness: string | null
      model: string | null
      status: PresenceStatus
      channel: string | null
      task_id: string | null
      note: string | null
      updated_at: string
      expires_at: string
    }>

    const out: PresenceView[] = []
    for (const r of rows) {
      const effectiveStatus: PresenceStatus = r.expires_at <= nowIso ? 'offline' : r.status
      if (!includeOffline && effectiveStatus === 'offline') continue
      if (query.status !== undefined && effectiveStatus !== query.status) continue
      const chReadable = r.channel === null || access.readable(r.channel)
      if (query.channel !== undefined) {
        if (r.channel === null || !chReadable) continue
        if (query.channel.endsWith('/')) {
          const sub = query.channel.slice(0, -1)
          if (r.channel !== sub && !r.channel.startsWith(`${sub}/`)) continue
        } else if (r.channel !== query.channel) {
          continue
        }
      }
      out.push({
        agent: r.agent,
        principal: r.principal,
        profile: r.profile,
        handle: r.handle,
        harness: r.harness,
        model: r.model,
        status: effectiveStatus,
        channel: chReadable ? r.channel : null,
        taskId: chReadable ? r.task_id : null,
        note: r.note,
        updatedAt: r.updated_at,
        expiresAt: r.expires_at,
      })
      if (out.length >= limit) break
    }
    return out
  }
}

const indexOf = (value: string): number | null =>
  /^(0|[1-9]\d{0,15})$/.test(value) ? Number(value) : null

function cursorAt(value: string): number {
  const index = indexOf(value)
  if (index === null) {
    throw badRequest(`${value} isn't a cursor or a message ID on this board`, 'invalid_cursor')
  }
  return index
}

function olderAt(value: string): { at: number; id: number } {
  const match = /^(\d{1,15})\.(\d{1,15})$/.exec(value)
  if (!match) {
    throw badRequest(`${value} isn't a page of threads on this board`, 'invalid_cursor')
  }
  return { at: Number(match[1]), id: Number(match[2]) }
}

function headForLast(head: number): number {
  return Math.max(0, head)
}

export { CHANNEL_PATH_MAX }
