// HS-45 to HS-53 and HS-55: the operation registry, pinned against TRANSPORT_ALLOW, the original's routes, the
// core's schemas and error table. HS-54 (types) is in registry-types.test.ts.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Core from '../../src/core/public.ts'
import { TRANSPORT_ALLOW } from '../../src/core/internal.ts'
import { CLIENT_ERROR_STATUSES, isBoardError } from '../../src/client/errors.ts'
import {
  bindArgs,
  isOpName,
  laneKind,
  NOT_ROUTED,
  ORIGINAL_NOT_ROUTED,
  OP_NAMES,
  OPS,
  UNIVERSAL_ERRORS,
  validateEnvelope,
  type OpName,
} from '../../src/client/ops.ts'
import { OP_SCHEMAS } from '../../src/client/op-schemas.ts'
import { asUrl, importGraph } from '../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const ROUTES = join(ROOT, 'board', 'packages', 'board', 'src', 'api', 'routes.ts')

function deepFrozen(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return
  expect(Object.isFrozen(value), path).toBe(true)
  for (const [k, v] of Object.entries(value)) deepFrozen(v, `${path}.${k}`)
}

const serviceOf = (op: OpName): 'board' | 'tasks' => OPS[op].binds.service

describe('the operation registry', () => {
  it('HS-45 OPS and OP_NAMES are deep-frozen, sorted, 84 names of the right shape', () => {
    expect(Object.isFrozen(OPS)).toBe(true)
    deepFrozen(OPS, 'OPS')
    expect(Object.isFrozen(OP_NAMES)).toBe(true)
    expect(OP_NAMES).toHaveLength(84)
    expect([...OP_NAMES]).toEqual([...OP_NAMES].sort())
    expect(new Set(OP_NAMES).size).toBe(84)
    for (const name of OP_NAMES) expect(name).toMatch(/^[a-z][A-Za-z]*$/)
    for (const op of OP_NAMES) {
      const spec = OPS[op]
      expect(Object.isFrozen(spec.binds), op).toBe(true)
      expect(Object.isFrozen(spec.params), op).toBe(true)
      expect(Object.isFrozen(spec.errors), op).toBe(true)
      expect(Object.isFrozen(spec.gated), op).toBe(true)
      if (spec.compat !== null) expect(Object.isFrozen(spec.compat), op).toBe(true)
      for (const p of spec.params) expect(Object.isFrozen(p), `${op}.${p.name}`).toBe(true)
    }
    expect(isOpName('post')).toBe(true)
    expect(isOpName('toString')).toBe(false)
    expect(isOpName('claimReadyOnce')).toBe(false)
  })

  it('HS-46 every binding is a member of TRANSPORT_ALLOW', () => {
    for (const op of OP_NAMES) {
      const { service, method } = OPS[op].binds
      expect(Object.hasOwn(TRANSPORT_ALLOW, service), `${op} service ${service}`).toBe(true)
      expect(TRANSPORT_ALLOW[service], `${op} -> ${service}.${method}`).toContain(method)
    }
  })

  it('HS-47 each TRANSPORT_ALLOW member is bound by exactly one op or listed as not routed, never both', () => {
    expect(Object.keys(NOT_ROUTED)).toEqual(['tasks.claimReadyOnce'])
    const members = new Set<string>()
    for (const [service, list] of Object.entries(TRANSPORT_ALLOW)) for (const m of list) members.add(`${service}.${m}`)
    for (const key of Object.keys(NOT_ROUTED)) {
      expect(members.has(key), `${key} names a member`).toBe(true)
      expect(NOT_ROUTED[key]!.length).toBeGreaterThan(0)
    }
    const bound = new Map<string, string[]>()
    for (const op of OP_NAMES) {
      const key = `${OPS[op].binds.service}.${OPS[op].binds.method}`
      bound.set(key, [...(bound.get(key) ?? []), op])
    }
    for (const member of members) {
      const ops = bound.get(member) ?? []
      const routed = Object.hasOwn(NOT_ROUTED, member)
      expect(ops.length === 1 ? !routed : ops.length === 0 && routed, `${member}: bound ${JSON.stringify(ops)}, not routed ${routed}`).toBe(true)
    }
    expect(members.size).toBe(85)
  })

  it('HS-48 the op names and compat routes equal the canonical compat routes table', () => {
    const CANONICAL_COMPAT_ROUTES: Readonly<Record<string, { readonly method: string; readonly path: string }>> = {
      discovery: { method: 'GET', path: '/' },
      me: { method: 'GET', path: '/me' },
      channels: { method: 'GET', path: '/channels' },
      createChannel: { method: 'POST', path: '/channels' },
      actors: { method: 'GET', path: '/actors' },
      channelMessages: { method: 'GET', path: '/messages' },
      message: { method: 'GET', path: '/messages/:id' },
      threads: { method: 'GET', path: '/threads' },
      post: { method: 'POST', path: '/messages' },
      edit: { method: 'POST', path: '/messages/:id/edit' },
      delete: { method: 'POST', path: '/messages/:id/delete' },
      react: { method: 'POST', path: '/messages/:id/reactions' },
      label: { method: 'POST', path: '/messages/:id/labels' },
      sync: { method: 'POST', path: '/messages/:id/sync' },
      synced: { method: 'GET', path: '/messages/:id/sync' },
      linked: { method: 'GET', path: '/links' },
      typing: { method: 'POST', path: '/messages/:id/typing' },
      schedule: { method: 'POST', path: '/schedules' },
      schedules: { method: 'GET', path: '/schedules' },
      cancelSchedule: { method: 'POST', path: '/schedules/:id/cancel' },
      tasks: { method: 'GET', path: '/tasks' },
      createTask: { method: 'POST', path: '/tasks' },
      createTasks: { method: 'POST', path: '/tasks/batch' },
      createdTasks: { method: 'GET', path: '/tasks/batch/:id' },
      claimReadyTask: { method: 'POST', path: '/tasks/claim' },
      claimTask: { method: 'POST', path: '/tasks/:id/claim' },
      renewTask: { method: 'POST', path: '/tasks/:id/renew' },
      releaseTask: { method: 'POST', path: '/tasks/:id/release' },
      completeTask: { method: 'POST', path: '/tasks/:id/complete' },
      failTask: { method: 'POST', path: '/tasks/:id/fail' },
      blockTask: { method: 'POST', path: '/tasks/:id/block' },
      unblockTask: { method: 'POST', path: '/tasks/:id/unblock' },
      reopenTask: { method: 'POST', path: '/tasks/:id/reopen' },
      assignTask: { method: 'POST', path: '/tasks/:id/assign' },
      setTaskNeeds: { method: 'POST', path: '/tasks/:id/needs' },
      cancelTask: { method: 'POST', path: '/tasks/:id/cancel' },
      grants: { method: 'GET', path: '/grants' },
      createGrant: { method: 'POST', path: '/grants' },
      createGrants: { method: 'POST', path: '/grants/batch' },
      updateGrant: { method: 'PATCH', path: '/grants/:id' },
      explain: { method: 'GET', path: '/grants/explain' },
      revokeGrant: { method: 'POST', path: '/grants/:id/revoke' },
      schemas: { method: 'GET', path: '/schemas' },
      schema: { method: 'GET', path: '/schemas/:id' },
      createSchema: { method: 'POST', path: '/schemas' },
      posted: { method: 'GET', path: '/posts/:id' },
      inbox: { method: 'GET', path: '/inbox/:key' },
      inboxPush: { method: 'POST', path: '/inbox/:key' },
      inboxNext: { method: 'GET', path: '/inbox/:key/next' },
      inboxAck: { method: 'POST', path: '/inbox/:key/:id/ack' },
      syncImport: { method: 'POST', path: '/sync/imports' },
      syncReceipt: { method: 'POST', path: '/sync/receipts' },
      syncThread: { method: 'GET', path: '/sync/threads/:thread' },
      syncFind: { method: 'GET', path: '/sync/find' },
      syncCopies: { method: 'GET', path: '/sync/copies' },
      readSource: { method: 'GET', path: '/sources/:key/read' },
      joinSource: { method: 'POST', path: '/sources/:key/join' },
      webhook: { method: 'POST', path: '/webhooks/:key' },
      events: { method: 'GET', path: '/events' },
      avatar: { method: 'GET', path: '/avatars/:name' },
      upload: { method: 'POST', path: '/attachments' },
      attachment: { method: 'GET', path: '/attachments/:id' },
      uploadStart: { method: 'POST', path: '/attachments/uploads' },
      uploadFinish: { method: 'POST', path: '/attachments/uploads/:id' },
      openapi: { method: 'GET', path: '/openapi.json' },
      watchers: { method: 'GET', path: '/watchers' },
      register: { method: 'POST', path: '/watchers' },
      matches: { method: 'GET', path: '/watchers/matches' },
      ack: { method: 'POST', path: '/watchers/matches/:id/ack' },
      wake: { method: 'POST', path: '/wake' },
    }
    const parsed = new Map<string, { method: string; path: string }>(
      Object.entries(CANONICAL_COMPAT_ROUTES).map(([k, v]) => [k, { method: v.method, path: v.path }]),
    )
    if (existsSync(ROUTES)) {
      const text = readFileSync(ROUTES, 'utf8')
      const upstream = new Map<string, { method: string; path: string }>()
      for (const m of text.matchAll(/^\s+(\w+): \{ method: '(GET|POST|PATCH|DELETE|PUT)', path: '([^']+)'/gm)) {
        upstream.set(m[1]!, { method: m[2]!, path: m[3]! })
      }
      expect(upstream).toEqual(parsed)
    }
    const EXPECTED_SWARMBOARD_OPS = [
      'ackAllNotifications',
      'ackNotification',
      'addGroupMembers',
      'agentInbox',
      'channelTree',
      'createGroup',
      'deleteGroup',
      'ensureDm',
      'group',
      'groups',
      'markChannelRead',
      'notificationCount',
      'notifications',
      'pinMessage',
      'pins',
      'presence',
      'removeGroupMembers',
      'search',
      'setPresence',
      'unpinMessage',
      'updateChannel',
      'updateGroup',
      'waitNotifications',
    ] as const
    const swarmboardOps = OP_NAMES.filter((n) => OPS[n].compat === null)
    expect(swarmboardOps).toEqual([...EXPECTED_SWARMBOARD_OPS])
    const expected = [...OP_NAMES.filter((n) => OPS[n].compat !== null), ...Object.keys(ORIGINAL_NOT_ROUTED)].sort()
    expect([...parsed.keys()].sort()).toEqual(expected)
    expect(parsed.size).toBe(70)
    for (const op of OP_NAMES) {
      if (OPS[op].compat === null) {
        expect(EXPECTED_SWARMBOARD_OPS).toContain(op)
        continue
      }
      expect(OPS[op].compat, op).toEqual(parsed.get(op))
    }
    for (const reason of Object.values(ORIGINAL_NOT_ROUTED)) expect(reason.length).toBeGreaterThan(0)
  })

  it('HS-49 bindArgs is never longer than the bound method declares', () => {
    const board = Core.BoardService.prototype as unknown as Record<string, Function>
    const tasks = Core.TaskService.prototype as unknown as Record<string, Function>
    const caller = Core.createLocalCaller()
    for (const op of OP_NAMES) {
      const spec = OPS[op]
      const minimal: Record<string, unknown> = {}
      for (const p of spec.params) {
        if (p.optional === true) continue
        minimal[p.name] = p.kind === 'bytes' ? new Uint8Array(1) : p.kind === 'string' ? 'x' : 1
      }
      const fn = (spec.binds.service === 'board' ? board : tasks)[spec.binds.method]!
      const declared = declaredParams(fn)
      const args = bindArgs(op, minimal, caller, new AbortController().signal)
      expect(args.length, `${op} -> ${spec.binds.method} declares ${declared}`).toBeLessThanOrEqual(declared)
      expect(args[0]).toBe(caller)
    }
  })

  it('HS-49 createSchedule gets exactly 2 arguments even when the input carries nowMs', () => {
    const args = bindArgs('schedule', { text: 'x', nowMs: 0 }, Core.createLocalCaller(), new AbortController().signal)
    expect(args).toHaveLength(2)
    expect(args[1]).toEqual({ text: 'x', nowMs: 0 })
    expect(bindArgs('me', {}, 'c', undefined)).toEqual(['c'])
    expect(bindArgs('inbox', { key: 'k' }, 'c', undefined)).toEqual(['c', 'k', undefined, undefined])
    expect(bindArgs('events', { wait: 1 }, 'c', undefined)).toEqual(['c', { wait: 1 }, undefined])
    expect(bindArgs('edit', { id: 7, text: 't' }, 'c', undefined)).toEqual(['c', 7, { text: 't' }])
    // a __proto__ member of the body stays an own member and never reaches the prototype
    const body = bindArgs('post', JSON.parse('{"__proto__":{"x":1},"text":"t"}') as Record<string, unknown>, 'c', undefined)[1] as object
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype)
    expect(Object.hasOwn(body, '__proto__')).toBe(true)
  })

  it('HS-50 every op schema and param shape matches the design contract, every schema is an own export of public.ts, and OP_SCHEMAS holds the same objects', () => {
    // Independent contract table from DESIGN-host123-g1.md §6.3 + Swarmboard v2 launch design §1.6 (84 ops) so HS-50 is non-circular:
    // swapping any two ops' schemas (e.g. react <-> label) or altering params/body fails this check.
    type ExpectedParam = { readonly name: string; readonly kind: 'ref' | 'string' | 'int' | 'bytes'; readonly optional?: true }
    type ExpectedContract = {
      readonly schema: string | null
      readonly body: 'rest' | 'none'
      readonly params: readonly ExpectedParam[]
      readonly bytesFields?: readonly string[]
    }
    const idRef: readonly ExpectedParam[] = [{ name: 'id', kind: 'ref' }]
    const idStr: readonly ExpectedParam[] = [{ name: 'id', kind: 'string' }]
    const keyStr: readonly ExpectedParam[] = [{ name: 'key', kind: 'string' }]
    const EXPECTED_CONTRACT: Record<string, ExpectedContract> = {
      me: { schema: null, body: 'none', params: [] },
      channels: { schema: 'ChannelsQuerySchema', body: 'rest', params: [] },
      createChannel: { schema: 'CreateChannelBodySchema', body: 'rest', params: [] },
      actors: { schema: 'ActorsQuerySchema', body: 'rest', params: [] },
      channelMessages: { schema: 'ChannelMessagesQuerySchema', body: 'rest', params: [] },
      message: { schema: 'ThreadQuerySchema', body: 'rest', params: idRef },
      threads: { schema: 'ThreadsQuerySchema', body: 'rest', params: [] },
      post: { schema: 'PostBodySchema', body: 'rest', params: [] },
      edit: { schema: 'EditBodySchema', body: 'rest', params: idRef },
      delete: { schema: 'DeleteBodySchema', body: 'rest', params: idRef },
      react: { schema: 'ReactBodySchema', body: 'rest', params: idRef },
      label: { schema: 'LabelBodySchema', body: 'rest', params: idRef },
      sync: { schema: 'SyncBodySchema', body: 'rest', params: idRef },
      synced: { schema: null, body: 'none', params: idRef },
      schedule: { schema: 'ScheduleBodySchema', body: 'rest', params: [] },
      schedules: { schema: 'SchedulesQuerySchema', body: 'rest', params: [] },
      cancelSchedule: { schema: null, body: 'none', params: idStr },
      grants: { schema: null, body: 'none', params: [] },
      createGrant: { schema: 'GrantBodySchema', body: 'rest', params: [] },
      createGrants: { schema: 'CreateGrantsBodySchema', body: 'rest', params: [] },
      updateGrant: { schema: 'UpdateGrantBodySchema', body: 'rest', params: idStr },
      explain: { schema: 'ExplainQuerySchema', body: 'rest', params: [] },
      revokeGrant: { schema: 'RevokeGrantBodySchema', body: 'rest', params: idStr },
      schemas: { schema: null, body: 'none', params: [] },
      schema: { schema: null, body: 'none', params: idStr },
      createSchema: { schema: 'SchemaBodySchema', body: 'rest', params: [] },
      posted: { schema: null, body: 'none', params: idStr },
      inbox: {
        schema: null,
        body: 'none',
        params: [
          { name: 'key', kind: 'string' },
          { name: 'channel', kind: 'string', optional: true },
          { name: 'limit', kind: 'int', optional: true },
        ],
      },
      inboxPush: { schema: 'InboxPushBodySchema', body: 'rest', params: keyStr },
      inboxNext: { schema: 'InboxNextQuerySchema', body: 'rest', params: keyStr },
      inboxAck: { schema: 'InboxAckBodySchema', body: 'rest', params: [{ name: 'key', kind: 'string' }, { name: 'id', kind: 'string' }] },
      syncImport: { schema: 'SyncImportBodySchema', body: 'rest', params: [] },
      syncReceipt: { schema: 'SyncReceiptBodySchema', body: 'rest', params: [] },
      syncThread: { schema: null, body: 'none', params: [{ name: 'thread', kind: 'string' }] },
      syncFind: { schema: 'SyncFindQuerySchema', body: 'rest', params: [] },
      syncCopies: { schema: 'SyncCopiesQuerySchema', body: 'rest', params: [] },
      events: { schema: 'EventsQuerySchema', body: 'rest', params: [] },
      upload: { schema: null, body: 'rest', params: [], bytesFields: ['data'] },
      attachment: { schema: null, body: 'none', params: idStr },
      uploadStart: { schema: 'UploadStartBodySchema', body: 'rest', params: [] },
      uploadFinish: { schema: null, body: 'none', params: [{ name: 'id', kind: 'string' }, { name: 'data', kind: 'bytes' }] },
      watchers: { schema: null, body: 'none', params: [] },
      register: { schema: 'RegisterBodySchema', body: 'rest', params: [] },
      matches: { schema: 'MatchesQuerySchema', body: 'rest', params: [] },
      ack: { schema: 'AckBodySchema', body: 'rest', params: idStr },
      search: { schema: 'SearchQuerySchema', body: 'rest', params: [] },
      tasks: { schema: 'TasksQuery', body: 'rest', params: [] },
      createTask: { schema: 'CreateTaskBody', body: 'rest', params: [] },
      createTasks: { schema: 'CreateTasksBody', body: 'rest', params: [] },
      createdTasks: { schema: 'CreatedTasksQuery', body: 'rest', params: idStr },
      claimReadyTask: { schema: 'ClaimReadyTaskBody', body: 'rest', params: [] },
      claimTask: { schema: 'ClaimTaskBody', body: 'rest', params: idRef },
      renewTask: { schema: 'RenewTaskBody', body: 'rest', params: idRef },
      releaseTask: { schema: 'ReleaseTaskBody', body: 'rest', params: idRef },
      completeTask: { schema: 'CompleteTaskBody', body: 'rest', params: idRef },
      failTask: { schema: 'FailTaskBody', body: 'rest', params: idRef },
      blockTask: { schema: 'BlockTaskBody', body: 'rest', params: idRef },
      unblockTask: { schema: null, body: 'none', params: idRef },
      reopenTask: { schema: null, body: 'none', params: idRef },
      assignTask: { schema: 'AssignTaskBody', body: 'rest', params: idRef },
      setTaskNeeds: { schema: 'TaskNeedsBody', body: 'rest', params: idRef },
      cancelTask: { schema: 'CancelTaskBody', body: 'rest', params: idRef },
      channelTree: { schema: 'ChannelTreeQuerySchema', body: 'rest', params: [] },
      updateChannel: { schema: 'UpdateChannelBodySchema', body: 'rest', params: [] },
      ensureDm: { schema: 'EnsureDmBodySchema', body: 'rest', params: [] },
      groups: { schema: 'GroupsQuerySchema', body: 'rest', params: [] },
      group: { schema: null, body: 'none', params: [{ name: 'handle', kind: 'string' }] },
      createGroup: { schema: 'CreateGroupBodySchema', body: 'rest', params: [] },
      updateGroup: { schema: 'UpdateGroupBodySchema', body: 'rest', params: [{ name: 'handle', kind: 'string' }] },
      deleteGroup: { schema: null, body: 'none', params: [{ name: 'handle', kind: 'string' }] },
      addGroupMembers: { schema: 'GroupMembersBodySchema', body: 'rest', params: [{ name: 'handle', kind: 'string' }] },
      removeGroupMembers: { schema: 'GroupMembersBodySchema', body: 'rest', params: [{ name: 'handle', kind: 'string' }] },
      notifications: { schema: 'NotificationsQuerySchema', body: 'rest', params: [] },
      notificationCount: { schema: 'NotificationsQuerySchema', body: 'rest', params: [] },
      ackNotification: { schema: 'AckNotificationBodySchema', body: 'rest', params: idStr },
      ackAllNotifications: { schema: 'AckAllNotificationsBodySchema', body: 'rest', params: [] },
      waitNotifications: { schema: 'WaitNotificationsQuerySchema', body: 'rest', params: [] },
      markChannelRead: { schema: 'MarkChannelReadBodySchema', body: 'rest', params: [] },
      agentInbox: { schema: 'AgentInboxQuerySchema', body: 'rest', params: [] },
      pinMessage: { schema: 'PinBodySchema', body: 'rest', params: idRef },
      unpinMessage: { schema: 'UnpinBodySchema', body: 'rest', params: idRef },
      pins: { schema: 'PinsQuerySchema', body: 'rest', params: [] },
      setPresence: { schema: 'SetPresenceBodySchema', body: 'rest', params: [] },
      presence: { schema: 'PresenceQuerySchema', body: 'rest', params: [] },
    }
    expect(Object.keys(EXPECTED_CONTRACT).sort()).toEqual([...OP_NAMES])
    const seenSchemas = new Set<string>()
    for (const op of OP_NAMES) {
      const spec = OPS[op]
      const expected = EXPECTED_CONTRACT[op]!
      expect(spec.body, op).toBe(expected.body)
      expect(spec.params, op).toEqual(expected.params)
      expect(spec.bytesFields ?? [], op).toEqual(expected.bytesFields ?? [])
      expect(spec.schema, op).toBe(expected.schema)
      if (spec.body === 'none') expect(spec.schema, op).toBeNull()
      if (expected.schema === null) {
        expect(OP_SCHEMAS[op], op).toBeNull()
        continue
      }
      seenSchemas.add(expected.schema)
      expect(Object.hasOwn(Core, expected.schema), `${op}: ${expected.schema}`).toBe(true)
      const schema = (Core as unknown as Record<string, { safeParse?: unknown }>)[expected.schema]!
      expect(typeof schema.safeParse, expected.schema).toBe('function')
      expect(OP_SCHEMAS[op], op).toBe(schema)
    }
    expect(seenSchemas.size).toBe(65)
    expect(Object.isFrozen(OP_SCHEMAS)).toBe(true)
    expect(Object.keys(OP_SCHEMAS).sort()).toEqual([...OP_NAMES])
  })

  it('HS-51 idempotency classes, access, retry and lane kinds', () => {
    expect(OP_NAMES.filter((o) => OPS[o].idem === 'client-id')).toEqual(['createTask', 'createTasks', 'post'])
    for (const op of OP_NAMES) {
      const spec = OPS[op]
      if (spec.access === 'read') expect(spec.idem, op).toBe('read')
      else expect(spec.idem, op).not.toBe('read')
      expect(spec.retry, op).toBe('in-process')
    }
    expect(OPS.inboxNext.access).toBe('write')
    expect(OPS.matches.access).toBe('write')
    expect(OP_NAMES.filter((o) => laneKind(o) === 'wait')).toEqual([
      'claimReadyTask',
      'events',
      'matches',
      'waitNotifications',
    ])
    expect(laneKind('post')).toBe('write')
    expect(laneKind('channels')).toBe('read')
  })

  it('HS-52 wait ops and their maxima equal the schemas own', () => {
    expect(OP_NAMES.filter((o) => OPS[o].wait !== 'none')).toEqual([
      'claimReadyTask',
      'events',
      'matches',
      'waitNotifications',
    ])
    expect(OPS.events).toMatchObject({ wait: 'core', waitMaxS: 300, signal: true })
    expect(OPS.claimReadyTask).toMatchObject({ wait: 'core', waitMaxS: 300, signal: true })
    expect(OPS.matches).toMatchObject({ wait: 'repoll', waitMaxS: 25, signal: false })
    expect(OPS.waitNotifications).toMatchObject({ wait: 'core', waitMaxS: 300, signal: true })
    expect(OP_NAMES.filter((o) => OPS[o].signal)).toEqual(['claimReadyTask', 'events', 'waitNotifications'])
    const base: Record<string, Record<string, unknown>> = {
      events: {},
      claimReadyTask: { channel: 'ch' },
      matches: {},
      waitNotifications: {},
    }
    for (const op of ['events', 'claimReadyTask', 'matches', 'waitNotifications'] as const) {
      const schema = OP_SCHEMAS[op]!
      const max = OPS[op].waitMaxS!
      expect(schema.safeParse({ ...base[op], wait: max }).success, `${op} at ${max}`).toBe(true)
      expect(schema.safeParse({ ...base[op], wait: max + 0.001 }).success, `${op} above ${max}`).toBe(false)
    }
    for (const op of OP_NAMES) if (OPS[op].wait === 'none') expect(OPS[op].waitMaxS, op).toBeUndefined()
  })

  it('HS-53 every declared error code is in the core or the client table', () => {
    const known = (code: string): boolean => Object.hasOwn(Core.ERROR_STATUSES, code) || Object.hasOwn(CLIENT_ERROR_STATUSES, code)
    for (const code of UNIVERSAL_ERRORS) expect(known(code), `universal ${code}`).toBe(true)
    for (const op of OP_NAMES) for (const code of OPS[op].errors) expect(known(code), `${op}: ${code}`).toBe(true)
    expect(UNIVERSAL_ERRORS).toEqual(
      expect.arrayContaining(['not_supported', 'backpressure_shed', 'cursor_expired', 'duplicate_id']),
    )
    for (const code of ['not_supported', 'backpressure_shed', 'cursor_expired', 'duplicate_id']) {
      expect(Object.hasOwn(Core.ERROR_STATUSES, code), code).toBe(true)
    }
  })

  it('HS-55 the thin client files resolve nothing under src/core and no zod, with at most 15 edges each', async () => {
    const names = [
      'version',
      'errors',
      'types',
      'ops',
      'config',
      'resolve',
      'idempotency',
      'retry',
      'lanes',
      'conformance',
      'client',
      'format',
      'index',
    ]
    for (const future of ['transport-socket', 'transport-http']) {
      if (existsSync(join(ROOT, 'src', 'client', `${future}.ts`))) names.push(future)
    }
    const files = names.map((n) => join(ROOT, 'src', 'client', `${n}.ts`))
    const edges = await importGraph(files)
    const own = new Map<string, number>()
    for (const [parent, child] of edges) {
      if (files.some((f) => asUrl(f) === parent)) {
        own.set(parent, (own.get(parent) ?? 0) + 1)
        expect(child, `${parent} -> ${child}`).not.toContain('/src/core/')
        expect(child, `${parent} -> ${child}`).not.toMatch(/\/node_modules\/(\.pnpm\/[^/]*\/node_modules\/)?zod\//)
      }
    }
    for (const f of files) expect(own.get(asUrl(f)) ?? 0, f).toBeLessThanOrEqual(15)
    // ops.ts really is thin: its only runtime edges are errors.ts and version.ts
    const opsEdges = edges
      .filter(([p]) => p === asUrl(join(ROOT, 'src', 'client', 'ops.ts')))
      .map(([, c]) => c.slice(c.lastIndexOf('/') + 1))
      .sort()
    expect(opsEdges).toEqual(['errors.ts', 'version.ts'])
    // format.ts is pure/thin: zero runtime edges
    const formatEdges = edges.filter(([p]) => p === asUrl(join(ROOT, 'src', 'client', 'format.ts')))
    expect(formatEdges).toEqual([])
  }, 60_000)
})

describe('the envelope', () => {
  const refuse = (op: OpName, input: unknown, message: RegExp): void => {
    try {
      validateEnvelope(op, input)
      expect.unreachable(`${op} accepted ${JSON.stringify(input)}`)
    } catch (e) {
      expect(isBoardError(e), String(e)).toBe(true)
      if (!isBoardError(e)) return
      expect(e).toMatchObject({ status: 400, code: 'invalid_request', origin: 'handle' })
      expect(e.message).toMatch(message)
    }
  }

  it('HS-49 validateEnvelope refuses what the wire refuses and accepts valid input', () => {
    validateEnvelope('me', undefined)
    validateEnvelope('me', {})
    validateEnvelope('message', { id: 5 })
    validateEnvelope('message', { id: 'abc', limit: 3 })
    validateEnvelope('inbox', { key: 'k', limit: 10 })
    validateEnvelope('upload', { name: 'a', type: null, data: new Uint8Array(3) })
    validateEnvelope('uploadFinish', { id: 'u', data: Buffer.from('x') })
    validateEnvelope('post', { channel: 'a', text: 't', extra: undefined })
    refuse('me', 'nope', /input must be an object/)
    refuse('me', [], /input must be an object/)
    refuse('me', new Map(), /input must be an object/)
    refuse('me', { x: 1 }, /x: not a field of me/)
    refuse('message', {}, /id: required/)
    refuse('message', { id: -1 }, /id:/)
    refuse('message', { id: 1.5 }, /id:/)
    refuse('message', { id: '' }, /id:/)
    refuse('message', { id: 'x'.repeat(201) }, /id:/)
    refuse('posted', { id: 5 }, /id:/)
    refuse('inbox', { key: 'k', limit: 1.5 }, /limit: must be an integer/)
    refuse('uploadFinish', { id: 'u', data: 'text' }, /data: must be bytes/)
    refuse('upload', { name: 'a', type: null, data: 'text' }, /data: must be bytes/)
    refuse('post', { text: new Date() }, /text: not a JSON value/)
    refuse('post', { text: 1n }, /text: not a JSON value/)
    refuse('post', { text: Number.NaN }, /text: not a JSON value/)
    refuse('post', { text: Infinity }, /text: not a JSON value/)
    refuse('post', { labels: [() => 1] }, /labels\[0\]: not a JSON value/)
    refuse('post', { a: { b: new Map() } }, /a\.b: not a JSON value/)
    refuse('search', { query: 'q', filter: () => true }, /filter: not a JSON value/)
    class Thing {}
    refuse('post', { text: new Thing() }, /text: not a JSON value/)
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    refuse('post', { x: cyclic }, /not a JSON value/)
    let deep: unknown = 1
    for (let i = 0; i < 70; i++) deep = { d: deep }
    refuse('post', { x: deep }, /not a JSON value/)
    expect(() => validateEnvelope('nope' as OpName, {})).toThrow(/not an operation/)
  })
})

/** The number of declared parameters of a function, from its source (a default value or a rest parameter counts). */
function declaredParams(fn: Function): number {
  const src = Function.prototype.toString.call(fn)
  const open = src.indexOf('(')
  let depth = 0
  let count = 0
  let sawToken = false
  let quote: string | null = null
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i]!
    if (quote !== null) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      sawToken = true
    } else if (c === '(' || c === '[' || c === '{') {
      depth++
      sawToken = true
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break
      depth--
    } else if (c === ',' && depth === 0) {
      if (sawToken) count++
      sawToken = false
    } else if (!/\s/.test(c)) sawToken = true
  }
  return sawToken ? count + 1 : count
}
