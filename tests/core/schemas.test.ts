import { describe, expect, it } from 'vitest'
import {
  AgentCardSchema,
  toErrorPayload,
  AttachmentId,
  BridgeRfcSchema,
  BudgetPolicySchema,
  ChannelPath,
  ChannelViewSchema,
  CommunicationFlowSchema,
  DecisionBundleSchema,
  DeliveryRowSchema,
  DepartmentSchema,
  EnvelopeV2Schema,
  EscalationTicketSchema,
  EventsPageSchema,
  GrantCanInputSchema,
  GrantViewSchema,
  LabelBodySchema,
  LabelKey,
  Labels,
  NewLabelValue,
  NewLabels,
  OrgNodeSchema,
  PostBodySchema,
  ReservationLeaseSchema,
  BuildSlotSchema,
  SquadSchema,
  SyncImportBodySchema,
  TaskViewSchema,
  ThreadViewSchema,
  WakeupPacketSchema,
  MessageViewSchema,
} from '../../src/core/index.ts'

const NOW = '2026-11-22T23:00:00.000Z'
const SHA256 = 'a'.repeat(64)

describe('Core Zod v4 Schemas (Baseline + Swarmboard v2)', () => {
  it('validates ChannelPath, LabelKey prototype guards, NewLabelValue control chars, and AttachmentId', () => {
    expect(ChannelPath.safeParse('work/agent-mesh/m1_core').success).toBe(true)
    expect(ChannelPath.safeParse('Bad/Channel').success).toBe(false)
    expect(ChannelPath.safeParse('work//nested').success).toBe(false)

    expect(LabelKey.safeParse('status').success).toBe(true)
    expect(LabelKey.safeParse('__proto__').success).toBe(false)
    expect(LabelKey.safeParse('constructor').success).toBe(false)
    expect(LabelKey.safeParse('prototype').success).toBe(false)

    expect(NewLabelValue.safeParse('ready').success).toBe(true)
    expect(NewLabelValue.safeParse('bad\nline').success).toBe(false)

    expect(AttachmentId.safeParse('abcdefghijklmnopqrstuv').success).toBe(true)
    expect(AttachmentId.safeParse('att_12345678-1234-1234-1234-1234567890ab').success).toBe(true)
    expect(AttachmentId.safeParse('bad').success).toBe(false)

    expect(PostBodySchema.safeParse({ channel: 'dev', text: 'hello' }).success).toBe(true)
    expect(PostBodySchema.safeParse({ channel: 'dev', re: '1', text: 'hello' }).success).toBe(false)
    expect(PostBodySchema.safeParse({ channel: 'dev', text: '   ' }).success).toBe(false)
  })

  it('validates all 6 baseline @vercel/board wire entity schemas', () => {
    expect(ChannelViewSchema.parse({ path: 'work/corp', lastIndex: 5, messages: 3, threads: 1 }).path).toBe('work/corp')
    const task = TaskViewSchema.parse({
      state: 'claimed',
      owner: 'local:user:alice',
      by: 'local:user:alice+codex',
      for: 'local:user:alice+codex',
      needs: ['1'],
      epoch: 1,
      claim: { actor: 'local:user:alice+codex', until: NOW },
      blocked: null,
      result: null,
      reason: null,
    })
    expect(task.state).toBe('claimed')

    const msg = MessageViewSchema.parse({
      id: '10',
      channel: 'work/corp',
      text: 'Task root',
      re: null,
      replyTo: null,
      thread: 'thr-10',
      labels: { 'board.task': 'claimed' },
      reactions: { check: ['local:user:alice'] },
      by: { actor: 'local:user:alice', principal: 'local:user:alice', profile: null },
      noSync: false,
      origin: null,
      from: null,
      createdAt: NOW,
      editedAt: null,
      deleted: false,
      undelivered: {},
      attachments: [],
      links: [],
      task,
      version: 10,
      revision: 10,
      author: { kind: 'person', handle: 'alice', name: 'Alice', avatar: null, verified: true },
      blocks: [],
    })
    expect(ThreadViewSchema.parse({ message: msg, replies: [], cursor: '10' }).message.id).toBe('10')

    expect(
      GrantViewSchema.parse({
        id: 'g1',
        principals: [{ kind: 'all-users' }],
        can: { '*': 'all' },
        capped: false,
        by: null,
        at: null,
      }).id,
    ).toBe('g1')

    expect(
      EventsPageSchema.parse({
        events: [{ cursor: '10', type: 'message.posted', createdAt: NOW, payload: { id: '10' }, message: msg }],
        cursor: '10',
      }).cursor,
    ).toBe('10')
  })

  it('validates all 14 Swarmboard v2 schemas strictly', () => {
    const orgNode = OrgNodeSchema.parse({
      id: 'node-1',
      orgId: 'org-1',
      kind: 'department',
      name: 'Backend Engineering',
      slug: 'backend',
      parentId: 'org-1',
      lineage: 'acme/backend',
      depth: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(orgNode.maxDepth).toBe(4)

    const dept = DepartmentSchema.parse({
      id: 'dept-be',
      orgId: 'org-1',
      slug: 'backend',
      name: 'Backend',
      channelNamespace: 'dept/backend',
      createdAt: NOW,
    })
    expect(dept.isolationMode).toBe('captain_bridge')

    const squad = SquadSchema.parse({
      id: 'sq-auth',
      orgId: 'org-1',
      deptId: 'dept-be',
      slug: 'auth',
      name: 'Auth Squad',
      channelPath: 'dept/backend/auth',
      createdAt: NOW,
    })
    expect(squad.maxConcurrentWorkers).toBe(8)

    const card = AgentCardSchema.parse({
      id: 'cap-be',
      handle: 'cap-be',
      displayName: 'Backend Captain',
      orgId: 'org-1',
      deptId: 'dept-be',
      role: 'captain',
      lineage: 'acme/backend/cap-be',
      principalKind: 'agent_delegated',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      modelFamily: 'claude',
      correlationGroup: 'claude',
      harness: 'claude-code',
      lastHeartbeatAt: NOW,
      registeredAt: NOW,
    })
    expect(card.status).toBe('online')

    const flow = CommunicationFlowSchema.parse({
      id: 'flow-1',
      orgId: 'org-1',
      sourceSelector: { kind: 'dept', value: 'dept-be' },
      targetSelector: { kind: 'dept', value: 'dept-fe' },
      mode: 'captain_bridge',
      allowedPurposes: ['rfc', 'handoff'],
      createdAt: NOW,
    })
    expect(flow.enabled).toBe(true)

    const rfc = BridgeRfcSchema.parse({
      id: 'rfc-1',
      channel: 'bridge/backend/frontend',
      threadId: 't-1',
      fromCaptainId: 'cap-be',
      toCaptainIds: ['cap-fe'],
      title: 'Auth Token Contract',
      interfaceContract: { endpoint: '/api/v2/auth' },
      contractDigestSha256: SHA256,
      createdAt: NOW,
    })
    expect(rfc.status).toBe('proposed')

    const env = EnvelopeV2Schema.parse({
      schemaVersion: 2,
      runId: 'run-1',
      traceId: 'trace-1',
      purpose: 'assignment',
      summary: 'Implement M2 service',
      requestedAction: 'Write src/org/task-service.ts',
    })
    expect(env.maxAttempts).toBe(3)

    const deliv = DeliveryRowSchema.parse({
      messageId: '42',
      recipientId: 'worker-1',
      createdAt: NOW,
    })
    expect(deliv.state).toBe('pending')

    const esc = EscalationTicketSchema.parse({
      id: 'esc-1',
      orgId: 'org-1',
      fromAgentId: 'worker-1',
      targetAgentId: 'cap-be',
      severity: 'P1_HIGH',
      category: 'blocked',
      summary: 'Waiting on schema RFC',
      routeTrace: ['worker-1', 'cap-be'],
      createdAt: NOW,
    })
    expect(esc.staleThresholdSeconds).toBe(900)

    const lease = ReservationLeaseSchema.parse({
      id: 'res-1',
      workspace: '/workspace/example-repo',
      pattern: 'src/core/*',
      isGlob: true,
      agentId: 'worker-1',
      expiresAt: NOW,
      createdAt: NOW,
    })
    expect(lease.exclusive).toBe(true)

    const slot = BuildSlotSchema.parse({
      id: 'slot-1',
      workspace: '/workspace/example-repo',
      slotName: 'typecheck',
      holderAgentId: 'worker-1',
      leaseTokenHash: SHA256,
      expiresAt: NOW,
      acquiredAt: NOW,
    })
    expect(slot.maxConcurrency).toBe(1)

    const decision = DecisionBundleSchema.parse({
      id: 'dec-1',
      orgId: 'org-1',
      channel: 'decisions',
      requestedByAgentId: 'cap-be',
      title: 'Approve Production Migration',
      summary: 'Migrate SQLite WAL schema to v2',
      gateKind: 'deploy',
      options: [{ id: 'approve', label: 'Approve', recommended: true }],
      createdAt: NOW,
    })
    expect(decision.status).toBe('pending')
    expect(
      DecisionBundleSchema.safeParse({
        ...decision,
        resolvedPrincipalKind: 'agent_delegated',
      }).success,
    ).toBe(false)

    const budget = BudgetPolicySchema.parse({
      id: 'bud-1',
      scopeType: 'dept',
      scopeId: 'dept-be',
      budgetCents: 5000,
      updatedAt: NOW,
    })
    expect(budget.hardStopEnabled).toBe(true)

    const wakeup = WakeupPacketSchema.parse({
      id: 'wk-1',
      agentId: 'worker-1',
      scopeKey: 'inbox:worker-1',
      cursorFrom: '1',
      cursorTo: '12',
      summary: '12 new events in inbox',
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(wakeup.coalescedCount).toBe(1)
  })

  it('rejects JSON.parse __proto__ and prototype keys in z.record schemas (Labels, NewLabels, LabelBodySchema.if, GrantCanInputSchema)', () => {
    expect(Labels.safeParse(JSON.parse('{"__proto__":"evil"}')).success).toBe(false)
    expect(NewLabels.safeParse(JSON.parse('{"__proto__":"evil"}')).success).toBe(false)
    expect(LabelBodySchema.safeParse(JSON.parse('{"set":{"__proto__":"evil"}}')).success).toBe(false)
    expect(LabelBodySchema.safeParse(JSON.parse('{"set":{"ok":"1"},"if":{"__proto__":null}}')).success).toBe(false)
    expect(LabelBodySchema.safeParse(JSON.parse('{"set":{"ok":"1"},"if":{"constructor":"x"}}')).success).toBe(false)
    expect(GrantCanInputSchema.safeParse(JSON.parse('{"__proto__":"all"}')).success).toBe(false)
    expect(
      SyncImportBodySchema.safeParse(
        JSON.parse(
          '{"op":"labels","author":{"id":"slack:u1","handle":"u1","name":"U1","avatar":null,"isBot":false},"from":"slack","message":"1","if":{"__proto__":null}}',
        ),
      ).success,
    ).toBe(false)

    // Valid records still parse with Object.prototype intact
    const valid = LabelBodySchema.parse(JSON.parse('{"set":{"status":"open"},"if":{"prev":null}}'))
    expect(valid.set).toEqual({ status: 'open' })
    expect(Object.getPrototypeOf(valid.if)).toBe(Object.prototype)
  })
})

// M1 gate iteration 4 (WIRE-N1): an inherited name a label key refuses by its own rule is worded as the original words it.
describe('a record key that names an inherited property', () => {
  const message = (result: { success: boolean; error?: unknown }) => toErrorPayload(result.error).payload.error.message

  it('words a key the key rule refuses as the original does, and still refuses __proto__ and constructor', () => {
    const toStr = LabelBodySchema.safeParse({ set: { toString: 'x' } })
    expect(message(toStr)).toBe(
      'set: "toString" isn\'t a label key: one is 1 to 64 lowercase letters, numbers, ., _, and -, starting with a letter or number',
    )
    expect(message(LabelBodySchema.safeParse({ set: { hasOwnProperty: 'x' } }))).toContain('"hasOwnProperty" isn\'t a label key')
    expect(message(LabelBodySchema.safeParse(JSON.parse('{"set":{"__proto__":"x"}}')))).toBe('set: label key is a reserved name')
    expect(message(LabelBodySchema.safeParse({ set: { constructor: 'x' } }))).toContain('label key is a reserved name')
    expect(GrantCanInputSchema.safeParse({ toString: 'all' }).success).toBe(false)
  })
})
