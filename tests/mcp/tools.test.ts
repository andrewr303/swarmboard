import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { clientErrorPayload } from '../../src/client/normalize.ts'
import type { BoardClient } from '../../src/client/client.ts'
import { BoardService, SqliteUnifiedStore } from '../../src/core/public.ts'
import { resolveLocalIdentity } from '../../src/host/auth/local.ts'
import { connect } from '../../src/host/connect.ts'
import {
  createMcpServer,
  encodeFrame,
  FrameParser,
  JSONRPC_ERRORS,
  MCP_TOOLS,
  WAIT_CAP_S,
  type JsonRpcFailure,
  type JsonRpcSuccess,
  type McpHostBridge,
} from '../../src/mcp/index.ts'
import { importGraph, transportFiles } from '../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const EXPECTED_22_TOOLS = [
  'board_inbox',
  'board_me',
  'board_channels',
  'board_channel_manage',
  'board_read',
  'board_post',
  'board_edit',
  'board_react',
  'board_label',
  'board_dm',
  'board_mentions',
  'board_ack',
  'board_pin',
  'board_group',
  'board_presence',
  'board_wait',
  'board_search',
  'board_tasks_list',
  'board_task_create',
  'board_task_claim',
  'board_task_update',
  'board_feedback',
] as const

const tmpDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cb-mcp-tools-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

interface Harness {
  readonly service: BoardService
  readonly store: SqliteUnifiedStore
  readonly claimsDir: string
  readonly bridge: McpHostBridge
  readonly server: ReturnType<typeof createMcpServer>
  readonly logs: string[]
  readonly peerClient: (profile: string) => Promise<BoardClient>
  readonly cleanup: () => Promise<void>
}

async function createHarness(opts: {
  profile?: string
  harnessEnv?: string
  modelEnv?: string
  heartbeatIntervalMs?: number
  waitCapS?: number
  autoPresence?: boolean
} = {}): Promise<Harness> {
  const dir = makeTempDir()
  const claimsDir = join(dir, 'claims')
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  const service = new BoardService(store)
  const profile = opts.profile ?? 'agy'
  const logs: string[] = []
  const openedClients: BoardClient[] = []

  const id = resolveLocalIdentity({
    userId: 'alice',
    as: profile,
    isTTY: false,
    env: {},
  })

  const bridge: McpHostBridge = {
    env: {
      ...(opts.harnessEnv ? { SWARMBOARD_HARNESS: opts.harnessEnv } : {}),
      ...(opts.modelEnv ? { SWARMBOARD_MODEL: opts.modelEnv } : {}),
    },
    claimsDir,
    formatError: clientErrorPayload,
    log: (line) => logs.push(line),
    async connect() {
      const client = await connect({ service, identity: id.provider })
      openedClients.push(client)
      return client
    },
  }

  const server = createMcpServer({
    bridge,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    waitCapS: opts.waitCapS,
    autoPresence: opts.autoPresence,
  })

  const peerClient = async (peerProfile: string): Promise<BoardClient> => {
    const peerId = resolveLocalIdentity({
      userId: 'alice',
      as: peerProfile,
      isTTY: false,
      env: {},
    })
    const client = await connect({ service, identity: peerId.provider })
    openedClients.push(client)
    return client
  }

  return {
    service,
    store,
    claimsDir,
    bridge,
    server,
    logs,
    peerClient,
    async cleanup() {
      await server.shutdown()
      for (const c of openedClients) {
        await c.close().catch(() => {})
      }
      store.close()
    },
  }
}

async function rpcCall<T = Record<string, unknown>>(
  server: ReturnType<typeof createMcpServer>,
  toolName: string,
  args: Record<string, unknown> = {},
  id: number | string = 1,
): Promise<{ readonly data: T; readonly isError: boolean }> {
  const resp = (await server.handleMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  })) as JsonRpcSuccess
  expect(resp).toBeDefined()
  expect('result' in resp).toBe(true)
  const result = resp.result as { isError?: boolean; content: [{ type: 'text'; text: string }] }
  expect(result.content).toHaveLength(1)
  expect(result.content[0].type).toBe('text')
  return {
    data: JSON.parse(result.content[0].text) as T,
    isError: result.isError === true,
  }
}

describe('HOST-6 MCP Server — protocol, all 22 tools, caps, claim cache, auto-presence', () => {
  it('negotiates MCP protocol versions, handles ping/notifications, and lists exact 22 tools', async () => {
    const h = await createHarness()
    try {
      const init2025 = (await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'claude-code', version: '1.0.0' },
        },
      })) as JsonRpcSuccess
      expect(init2025.result).toMatchObject({
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'swarmboard-mcp' },
      })

      // Also supports 2024-11-05 and falls back to 2025-03-26 for unknown versions
      const init2024 = (await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      })) as JsonRpcSuccess
      expect((init2024.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05')

      const initFuture = (await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: { protocolVersion: '2099-01-01', capabilities: {} },
      })) as JsonRpcSuccess
      expect((initFuture.result as { protocolVersion: string }).protocolVersion).toBe('2025-03-26')

      // Notifications never emit a response
      expect(
        await h.server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      ).toBeNull()

      // Ping
      expect(await h.server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'ping' })).toEqual({
        jsonrpc: '2.0',
        id: 4,
        result: {},
      })

      // tools/list returns exact 22 tools from design §3.3
      const listResp = (await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/list',
      })) as JsonRpcSuccess
      const tools = (listResp.result as { tools: typeof MCP_TOOLS }).tools
      expect(tools).toHaveLength(22)
      expect(tools.map((t) => t.name)).toEqual([...EXPECTED_22_TOOLS])
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(10)
        expect(tool.inputSchema['type']).toBe('object')
      }

      // Unknown method -> -32601; unknown tool -> -32602; invalid request -> -32600
      const badMethod = (await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 6,
        method: 'prompts/list',
      })) as JsonRpcFailure
      expect(badMethod.error.code).toBe(JSONRPC_ERRORS.METHOD_NOT_FOUND)

      const badTool = (await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'board_nonexistent', arguments: {} },
      })) as JsonRpcFailure
      expect(badTool.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS)

      const emptyBatch = (await h.server.handleMessage([])) as JsonRpcFailure
      expect(emptyBatch.error.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST)
    } finally {
      await h.cleanup()
    }
  })

  it('exercises all 22 tools end-to-end: social, channels, pins, groups, DMs, tasks + claim cache, search, feedback', async () => {
    const h = await createHarness({ profile: 'agy', harnessEnv: 'agy', modelEnv: 'gemini-3-pro' })
    const codex = await h.peerClient('codex')
    const claude = await h.peerClient('claude')

    try {
      await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', clientInfo: { name: 'agy-cli' } },
      })

      // 1. board_me (compact & verbose)
      const meCompact = await rpcCall<Record<string, unknown>>(h.server, 'board_me')
      expect(meCompact.isError).toBe(false)
      expect(meCompact.data).toMatchObject({
        actor: 'local:user:alice+agy',
        assurance: 'agent_delegated',
        mode: 'in-process',
        maxWaitS: WAIT_CAP_S,
        harness: 'agy',
        model: 'gemini-3-pro',
      })
      const meVerbose = await rpcCall<Record<string, unknown>>(h.server, 'board_me', { verbose: true })
      expect(meVerbose.data['capabilities']).toBeDefined()

      // 2. board_channel_manage (create + update) & 3. board_channels (flat + tree)
      const createdCh = await rpcCall<{ channel: { path: string; kind: string; topic?: string }; created: boolean }>(
        h.server,
        'board_channel_manage',
        { action: 'create', path: 'repos/app/dev', kind: 'chat', topic: 'App dev', repo: 'app' },
      )
      expect(createdCh.isError).toBe(false)
      expect(createdCh.data.created).toBe(true)
      expect(createdCh.data.channel.path).toBe('repos/app/dev')

      const updatedCh = await rpcCall<{ channel: { path: string; topic?: string } }>(
        h.server,
        'board_channel_manage',
        { action: 'update', path: 'repos/app/dev', topic: 'Updated dev topic' },
      )
      expect(updatedCh.isError).toBe(false)
      expect(updatedCh.data.channel.topic).toBe('Updated dev topic')

      await rpcCall(h.server, 'board_channel_manage', {
        action: 'create',
        path: 'repos/app/work',
        kind: 'tasks',
        repo: 'app',
      })

      const flatChannels = await rpcCall<{ channels: Array<{ path: string }> }>(h.server, 'board_channels', {
        prefix: 'repos/app',
        includeMeta: true,
      })
      expect(flatChannels.data.channels.map((c) => c.path)).toEqual(['repos/app/dev', 'repos/app/work'])

      const treeChannels = await rpcCall<{ tree: Array<{ segment: string; children?: unknown[] }> }>(
        h.server,
        'board_channels',
        { prefix: 'repos', tree: true, includeUnread: true },
      )
      expect(treeChannels.data.tree[0]?.segment).toBe('repos')

      // 4. board_post (root + reply + quote + idempotencyKey) & 5. board_edit & 6. board_react & 7. board_label
      const post1 = await rpcCall<{ message: { id: string; thread: string; text: string; labels?: Record<string, string> } }>(
        h.server,
        'board_post',
        {
          channel: 'repos/app/dev',
          text: 'Initial launch thread',
          labels: { stage: 'alpha' },
        },
      )
      expect(post1.isError).toBe(false)
      const rootId = post1.data.message.id
      const rootThread = post1.data.message.thread
      // Compact output strips empty collections (reactions/attachments)
      expect((post1.data.message as Record<string, unknown>)['reactions']).toBeUndefined()

      // Idempotent replay with identical key returns same message ID
      const idem1 = await rpcCall<{ message: { id: string } }>(h.server, 'board_post', {
        channel: 'repos/app/dev',
        text: 'Idempotent check',
        idempotencyKey: 'mcp-post-idem-1',
      })
      const idem2 = await rpcCall<{ message: { id: string } }>(h.server, 'board_post', {
        channel: 'repos/app/dev',
        text: 'Idempotent check',
        idempotencyKey: 'mcp-post-idem-1',
      })
      expect(idem1.isError).toBe(false)
      expect(idem2.data.message.id).toBe(idem1.data.message.id)

      const edited = await rpcCall<{ ok: true; message: { text: string; revision?: number } }>(
        h.server,
        'board_edit',
        { id: `#${rootId}`, text: 'Edited launch thread' },
      )
      expect(edited.isError).toBe(false)
      expect(edited.data.message.text).toBe('Edited launch thread')
      expect(typeof edited.data.message.revision).toBe('number')
      expect(edited.data.message.revision!).toBeGreaterThan(1)

      // Stale revision triggers structured revision_conflict error
      const staleEdit = await rpcCall<{ error: { status: number; code: string } }>(h.server, 'board_edit', {
        id: rootId,
        text: 'Stale write',
        revision: 1,
      })
      expect(staleEdit.isError).toBe(true)
      expect(staleEdit.data.error.code).toBe('revision_conflict')

      const reply1 = await rpcCall<{ message: { id: string; re?: string; quote?: { id: string } } }>(
        h.server,
        'board_post',
        { re: rootThread, text: 'Quoting root post', quoteMessageId: Number(rootId) },
      )
      expect(reply1.isError).toBe(false)
      expect(reply1.data.message.re).toBe(rootId)
      expect(reply1.data.message.quote?.id).toBe(rootId)

      // Numeric re is also accepted seamlessly
      const reply2 = await rpcCall<{ message: { id: string; re?: string } }>(h.server, 'board_post', {
        re: Number(rootId),
        text: 'Numeric ref reply',
      })
      expect(reply2.isError).toBe(false)
      expect(reply2.data.message.re).toBe(rootId)

      const reacted = await rpcCall<{ ok: true; message: { reactions?: Record<string, string[]> } }>(
        h.server,
        'board_react',
        { id: rootId, emoji: 'thumbsup' },
      )
      expect(reacted.isError).toBe(false)
      expect(reacted.data.message.reactions?.['thumbs_up']).toContain('local:user:alice+agy')
      const unreacted = await rpcCall<{ ok: true; message: { reactions?: Record<string, string[]> } }>(
        h.server,
        'board_react',
        { id: rootId, emoji: 'thumbsup', remove: true },
      )
      expect(unreacted.data.message.reactions).toBeUndefined()

      const labeled = await rpcCall<{ ok: true; message: { labels?: Record<string, string> } }>(
        h.server,
        'board_label',
        { id: rootId, set: { priority: 'high' }, unset: ['stage'] },
      )
      expect(labeled.data.message.labels).toEqual({ priority: 'high' })

      // 8. board_pin (pin + list + unpin)
      const pinned = await rpcCall<{ pin: { id: string; scope: string; note?: string }; created: boolean }>(
        h.server,
        'board_pin',
        { action: 'pin', id: rootId, scope: 'channel', note: 'Pinned launch thread' },
      )
      expect(pinned.isError).toBe(false)
      expect(pinned.data.created).toBe(true)
      expect(pinned.data.pin.scope).toBe('channel')

      const pinList = await rpcCall<{ pins: Array<{ messageId: string }> }>(h.server, 'board_pin', {
        action: 'list',
        channel: 'repos/app/dev',
      })
      expect(pinList.data.pins.map((p) => p.messageId)).toContain(rootId)

      // 9. board_read (forum-ordered channel threads + flat messages + thread by thr_ ref)
      const chThreads = await rpcCall<{ threads: Array<{ message: { id: string }; replies: number; pin?: { scope: string }; latestReply?: { id: string } }> }>(
        h.server,
        'board_read',
        { target: 'repos/app/dev' },
      )
      expect(chThreads.data.threads[0]?.message.id).toBe(rootId)
      expect(chThreads.data.threads[0]?.pin?.scope).toBe('channel')
      expect(chThreads.data.threads[0]?.latestReply?.id).toBe(reply2.data.message.id)

      const chFlat = await rpcCall<{ messages: Array<{ id: string }> }>(h.server, 'board_read', {
        target: 'repos/app/dev',
        flat: true,
      })
      expect(chFlat.data.messages.length).toBeGreaterThanOrEqual(2)

      const singleThread = await rpcCall<{ message: { id: string }; replies: Array<{ id: string }> }>(
        h.server,
        'board_read',
        { target: rootThread },
      )
      expect(singleThread.data.message.id).toBe(rootId)
      expect(singleThread.data.replies.map((r) => r.id)).toContain(reply1.data.message.id)

      const unpinned = await rpcCall<{ unpinned: number }>(h.server, 'board_pin', {
        action: 'unpin',
        id: rootId,
        scope: 'channel',
      })
      expect(unpinned.data.unpinned).toBe(1)

      // 10. board_group (create, get, list, update, add, remove, delete)
      const grp = await rpcCall<{ handle: string; members?: Array<{ memberId: string }> }>(
        h.server,
        'board_group',
        { action: 'create', handle: 'reviewers', name: 'Code Reviewers', kind: 'role', members: ['agy', 'codex'] },
      )
      expect(grp.isError).toBe(false)
      expect(grp.data.handle).toBe('reviewers')

      const grpUpdated = await rpcCall<{ name: string }>(h.server, 'board_group', {
        action: 'update',
        handle: 'reviewers',
        name: 'Senior Reviewers',
      })
      expect(grpUpdated.data.name).toBe('Senior Reviewers')

      const grpAdded = await rpcCall<{ members?: Array<{ memberId: string }> }>(h.server, 'board_group', {
        action: 'add',
        handle: 'reviewers',
        members: ['claude'],
      })
      expect(grpAdded.data.members?.length).toBe(3)

      const grpRemoved = await rpcCall<{ members?: Array<{ memberId: string }> }>(h.server, 'board_group', {
        action: 'remove',
        handle: 'reviewers',
        members: ['claude'],
      })
      expect(grpRemoved.data.members?.length).toBe(2)

      const grpGet = await rpcCall<{ handle: string }>(h.server, 'board_group', {
        action: 'get',
        handle: 'reviewers',
      })
      expect(grpGet.data.handle).toBe('reviewers')

      const grpList = await rpcCall<{ groups: Array<{ handle: string }> }>(h.server, 'board_group', {
        action: 'list',
      })
      expect(grpList.data.groups.map((g) => g.handle)).toContain('reviewers')

      // 11. board_dm (send + read + private ACL isolation)
      const dmSent = await rpcCall<{ channel: { path: string }; message: { id: string; text: string } }>(
        h.server,
        'board_dm',
        { peer: 'codex', text: 'Private sync check' },
      )
      expect(dmSent.isError).toBe(false)
      expect(dmSent.data.channel.path).toBe('dm/agy--codex')

      const dmRead = await rpcCall<{ messages: Array<{ text: string }> }>(h.server, 'board_dm', {
        peer: 'codex',
        limit: 10,
      })
      expect(dmRead.data.messages.map((m) => m.text)).toContain('Private sync check')

      // Third agent (claude) cannot see dm/agy--codex messages (CF-15 hidden = empty/missing)
      expect((await claude.channel('dm/agy--codex').messages()).messages).toEqual([])
      await expect(claude.thread(dmSent.data.message.id)).rejects.toMatchObject({
        status: 404,
        code: 'message_not_found',
      })

      // 12. board_mentions & 13. board_inbox & 14. board_ack
      await codex.post('repos/app/dev', 'Hey @reviewers please check the PR!')
      await codex.dm('agy', 'Urgent DM follow-up')

      const mentions = await rpcCall<{ notifications: Array<{ id: string; reason: string; sourceGroup?: string }>; unread: number }>(
        h.server,
        'board_mentions',
        { unreadOnly: true },
      )
      expect(mentions.data.unread).toBeGreaterThanOrEqual(2)
      expect(mentions.data.notifications.some((n) => n.reason === 'group_mention' && n.sourceGroup === 'reviewers')).toBe(true)
      expect(mentions.data.notifications.some((n) => n.reason === 'dm')).toBe(true)

      const inbox = await rpcCall<{ actor: string; unreadNotifications: number; notifications?: unknown[] }>(
        h.server,
        'board_inbox',
      )
      expect(inbox.data.actor).toBe('local:user:alice+agy')
      expect(inbox.data.unreadNotifications).toBeGreaterThanOrEqual(2)

      const firstNotifId = mentions.data.notifications[0]!.id
      const ackOne = await rpcCall<{ ok: boolean }>(h.server, 'board_ack', { id: firstNotifId })
      expect(ackOne.data.ok).toBe(true)

      const ackAll = await rpcCall<{ acked: number }>(h.server, 'board_ack', {
        all: true,
        markChannelRead: true,
        channel: 'repos/app/dev',
      })
      expect(ackAll.data.acked).toBeGreaterThanOrEqual(1)

      const markRead = await rpcCall<{ channel: string; cursor: string }>(h.server, 'board_ack', {
        channel: 'repos/app/dev',
      })
      expect(markRead.data.channel).toBe('repos/app/dev')

      // 15. board_presence (set + list)
      const presSet = await rpcCall<{ status: string; channel?: string; note?: string }>(
        h.server,
        'board_presence',
        { action: 'set', status: 'busy', channel: 'repos/app/dev', note: 'Testing MCP tools' },
      )
      expect(presSet.data.status).toBe('busy')
      expect(presSet.data.channel).toBe('repos/app/dev')

      const presList = await rpcCall<{ presence: Array<{ handle: string; status: string }> }>(
        h.server,
        'board_presence',
        { action: 'list' },
      )
      expect(presList.data.presence.some((p) => p.status === 'busy')).toBe(true)

      // 16. board_search (FTS5)
      const searchRes = await rpcCall<{ hits: Array<{ id: string }> }>(h.server, 'board_search', {
        query: 'Edited launch thread',
        channel: 'repos/app/dev',
      })
      expect(searchRes.data.hits.some((hit) => hit.id === rootId)).toBe(true)

      // 17. board_task_create (single + batch + claim: true) & 18. board_tasks_list & 19. board_task_claim & 20. board_task_update
      const task1 = await rpcCall<{ task: { id: string; thread: string }; claim?: { epoch: number; cached: boolean; token?: string } }>(
        h.server,
        'board_task_create',
        { channel: 'repos/app/work', text: 'Ship HOST-6 MCP server', claim: true, lease: 60 },
      )
      expect(task1.isError).toBe(false)
      expect(task1.data.claim?.cached).toBe(true)
      // Compact mode omits 43-char claim token from tool output
      expect(task1.data.claim?.token).toBeUndefined()

      // Renew & complete WITHOUT passing epoch/token (uses ClaimCache automatically, even via thr_ thread ref!)
      const renewed = await rpcCall<{ ok: true; claim: { epoch: number; cached: boolean } }>(
        h.server,
        'board_task_update',
        { action: 'renew', id: task1.data.task.thread, lease: 120 },
      )
      expect(renewed.isError).toBe(false)
      expect(renewed.data.claim.cached).toBe(true)

      await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: { name: 'board_post', arguments: { re: task1.data.task.id, text: 'Milestone: all 22 tools green' } },
      })

      const listedTasks = await rpcCall<{ tasks: Array<{ message: { id: string }; latestReply?: { excerpt: string } }> }>(
        h.server,
        'board_tasks_list',
        { channel: 'repos/app/work', state: 'claimed' },
      )
      expect(listedTasks.data.tasks[0]?.message.id).toBe(task1.data.task.id)
      expect(listedTasks.data.tasks[0]?.latestReply?.excerpt).toContain('Milestone')

      const completed = await rpcCall<{ ok: true; task: { task?: { state: string; result?: string } } }>(
        h.server,
        'board_task_update',
        { action: 'complete', id: `#${task1.data.task.id}`, result: 'Verified 22/22 tools' },
      )
      expect(completed.isError).toBe(false)
      expect(completed.data.task.task?.state).toBe('completed')
      expect(completed.data.task.task?.result).toBe('Verified 22/22 tools')

      // Batch create + claim ready by channel + release + claim by id + block/unblock + fail + reopen + assign + needs + cancel
      const batch = await rpcCall<{ tasks: Array<{ id: string }> }>(h.server, 'board_task_create', {
        channel: 'repos/app/work',
        tasks: [
          { key: 'a', text: 'Batch step A' },
          { key: 'b', text: 'Batch step B', needs: [{ key: 'a' }] },
        ],
      })
      expect(batch.data.tasks).toHaveLength(2)
      const idA = batch.data.tasks[0]!.id
      const idB = batch.data.tasks[1]!.id

      const claimedReady = await rpcCall<{ claimed: boolean; task: { id: string }; claim: { epoch: number; token?: string } }>(
        h.server,
        'board_task_claim',
        { channel: 'repos/app/work', verbose: true },
      )
      expect(claimedReady.data.claimed).toBe(true)
      expect(claimedReady.data.task.id).toBe(idA)
      // Verbose mode includes token
      expect(typeof claimedReady.data.claim.token).toBe('string')

      const released = await rpcCall<{ ok: true; task: { task?: { state: string } } }>(
        h.server,
        'board_task_update',
        { action: 'release', id: idA },
      )
      expect(released.data.task.task?.state).toBe('ready')

      const claimedById = await rpcCall<{ claimed: boolean; task: { id: string } }>(h.server, 'board_task_claim', {
        id: idA,
      })
      expect(claimedById.data.claimed).toBe(true)

      const failed = await rpcCall<{ ok: true; task: { task?: { state: string } } }>(
        h.server,
        'board_task_update',
        { action: 'fail', id: idA, reason: 'Transient flake' },
      )
      expect(failed.data.task.task?.state).toBe('failed')

      const reopened = await rpcCall<{ ok: true; task: { task?: { state: string } } }>(
        h.server,
        'board_task_update',
        { action: 'reopen', id: idA },
      )
      expect(reopened.data.task.task?.state).toBe('ready')

      const blocked = await rpcCall<{ ok: true; task: { task?: { state: string } } }>(
        h.server,
        'board_task_update',
        { action: 'block', id: idA, reason: 'Waiting on review', kind: 'review' },
      )
      expect(blocked.data.task.task?.state).toBe('blocked')

      const unblocked = await rpcCall<{ ok: true; task: { task?: { state: string } } }>(
        h.server,
        'board_task_update',
        { action: 'unblock', id: idA },
      )
      expect(unblocked.data.task.task?.state).toBe('ready')

      const assigned = await rpcCall<{ ok: true; task: { task?: { for?: string } } }>(
        h.server,
        'board_task_update',
        { action: 'assign', id: idA, for: 'local:user:alice+codex' },
      )
      expect(assigned.data.task.task?.for).toBe('local:user:alice+codex')

      const updatedNeeds = await rpcCall<{ ok: true; task: { task?: { needs?: string[] } } }>(
        h.server,
        'board_task_update',
        { action: 'needs', id: idB, needs: [] },
      )
      expect(updatedNeeds.data.task.task?.needs).toBeUndefined()

      const canceled = await rpcCall<{ ok: true; task: { task?: { state: string } } }>(
        h.server,
        'board_task_update',
        { action: 'cancel', id: idB, reason: 'Superseded' },
      )
      expect(canceled.data.task.task?.state).toBe('canceled')

      // 21. board_wait (events mode quiet timeout + real @group notification wake in inbox mode!)
      const quietWait = await rpcCall<{ woke: boolean; reason?: string; cursor: string }>(
        h.server,
        'board_wait',
        { mode: 'events', channel: 'repos/app/dev', timeoutS: 0 },
      )
      expect(quietWait.isError).toBe(false)
      expect(quietWait.data.woke).toBe(false)
      expect(quietWait.data.reason).toBe('timeout')
      expect(typeof quietWait.data.cursor).toBe('string')

      const wakePromise = rpcCall<{
        woke: boolean
        mode: string
        notifications: Array<{ reason: string; sourceGroup?: string; excerpt: string }>
      }>(h.server, 'board_wait', { mode: 'inbox', timeoutS: 5 })

      // Give waitNotifications a tick to subscribe, then post @reviewers from codex
      await new Promise((r) => setTimeout(r, 30))
      await codex.post('repos/app/dev', 'Wake up @reviewers — live MCP test!')

      const wokeRes = await wakePromise
      expect(wokeRes.isError).toBe(false)
      expect(wokeRes.data.woke).toBe(true)
      expect(wokeRes.data.mode).toBe('inbox')
      expect(
        wokeRes.data.notifications.some(
          (n) => n.reason === 'group_mention' && n.sourceGroup === 'reviewers' && n.excerpt.includes('Wake up'),
        ),
      ).toBe(true)

      // Clean up group via delete action
      const grpDel = await rpcCall<{ deleted: boolean }>(h.server, 'board_group', {
        action: 'delete',
        handle: 'reviewers',
      })
      expect(grpDel.data.deleted).toBe(true)

      // 22. board_feedback into meta/feedback (with auto-filled harness/model + triage labels)
      const fb = await rpcCall<{ ok: true; message: { channel: string; labels?: Record<string, string>; text: string } }>(
        h.server,
        'board_feedback',
        {
          summary: 'board_wait worked smoothly for @group wake',
          kind: 'ux',
          severity: 'low',
          tool: 'board_wait',
          suggestion: 'Keep compact digest default',
        },
      )
      expect(fb.isError).toBe(false)
      expect(fb.data.message.channel).toBe('meta/feedback')
      expect(fb.data.message.labels).toMatchObject({
        status: 'new',
        kind: 'ux',
        severity: 'low',
        harness: 'agy',
      })
      expect(fb.data.message.text).toContain('gemini-3-pro')
    } finally {
      await h.cleanup()
    }
  })

  it('hard-clamps board_wait and board_task_claim waits to WAIT_CAP_S = 20 s', async () => {
    const seenNotificationWaits: number[] = []
    const seenEventTimeouts: number[] = []
    const seenTaskClaimWaits: number[] = []

    const fakeClient = {
      caps: { maxWaitS: 300, boardId: 'b_test' },
      resolution: null,
      raw: { closed: false },
      notifications: {
        async wait(q: { wait?: number }) {
          seenNotificationWaits.push(q.wait ?? -1)
          return { notifications: [], cursor: '42', unread: 0, urgent: 0 }
        },
      },
      async waitPage(q: { timeoutS: number }) {
        seenEventTimeouts.push(q.timeoutS)
        return { events: [], cursor: '42' }
      },
      tasks: {
        async claim(target: { wait?: number }) {
          seenTaskClaimWaits.push(target.wait ?? -1)
          return null
        },
        async list() {
          return { tasks: [], cursor: '42' }
        },
      },
      presence: {
        async set() {
          return {
            agent: 'a',
            principal: 'p',
            profile: 'agy',
            handle: 'agy',
            harness: null,
            model: null,
            status: 'active',
            channel: null,
            taskId: null,
            note: null,
            updatedAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
          }
        },
      },
      async close() {},
    } as unknown as BoardClient

    const server = createMcpServer({
      bridge: {
        claimsDir: null,
        async connect() {
          return fakeClient
        },
      },
      autoPresence: false,
    })

    try {
      const wInbox = await rpcCall<{ woke: boolean; reason: string; cursor: string; cappedToS?: number }>(
        server,
        'board_wait',
        { mode: 'inbox', timeoutS: 300 },
      )
      expect(seenNotificationWaits).toEqual([20])
      expect(wInbox.data).toMatchObject({ woke: false, reason: 'timeout', cursor: '42', cappedToS: 20 })

      const wEvents = await rpcCall<{ woke: boolean; reason: string; cursor: string; cappedToS?: number }>(
        server,
        'board_wait',
        { mode: 'events', wait: 999 },
      )
      expect(seenEventTimeouts).toEqual([20])
      expect(wEvents.data).toMatchObject({ woke: false, reason: 'timeout', cursor: '42', cappedToS: 20 })

      const wClaim = await rpcCall<{ claimed: boolean; woke: boolean; reason: string; cursor: string; cappedToS?: number }>(
        server,
        'board_task_claim',
        { channel: 'work', wait: 180 },
      )
      expect(seenTaskClaimWaits).toEqual([20])
      expect(wClaim.data).toMatchObject({ claimed: false, woke: false, reason: 'timeout', cursor: '42', cappedToS: 20 })
    } finally {
      await server.shutdown()
    }
  })

  it('auto-sets presence active on initialize, refreshes heartbeats, preserves explicit updates, and sets offline on shutdown', async () => {
    const h = await createHarness({ profile: 'agy', heartbeatIntervalMs: 80 })
    const peer = await h.peerClient('observer')
    try {
      await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          clientInfo: { name: 'codex-harness', version: '0.9' },
        },
      })

      const activeList = await peer.presence.list()
      const row1 = activeList.find((p) => p.agent === 'local:user:alice+agy')
      expect(row1).toMatchObject({ status: 'active', harness: 'codex-harness' })

      // Explicit update to busy persists across heartbeat ticks
      await rpcCall(h.server, 'board_presence', { action: 'set', status: 'busy', note: 'Working' })
      await new Promise((r) => setTimeout(r, 140))
      const afterBeat = (await peer.presence.list()).find((p) => p.agent === 'local:user:alice+agy')
      expect(afterBeat).toMatchObject({ status: 'busy', note: 'Working', harness: 'codex-harness' })

      // Shutdown sets status to offline cleanly before closing
      await h.server.shutdown()
      const afterStop = (await peer.presence.list({ includeOffline: true })).find(
        (p) => p.agent === 'local:user:alice+agy',
      )
      expect(afterStop?.status).toBe('offline')
    } finally {
      await h.cleanup()
    }
  })

  it('cancels an in-flight board_wait via notifications/cancelled and maps board/client errors cleanly', async () => {
    const h = await createHarness({ profile: 'agy' })
    const input = new PassThrough()
    const output = new PassThrough()
    const parser = new FrameParser()
    const received: unknown[] = []
    output.on('data', (chunk: Buffer) => {
      for (const f of parser.push(chunk)) {
        if (f.kind === 'message') received.push(f.value)
      }
    })

    const server = createMcpServer({ bridge: h.bridge, input, output })
    const runPromise = server.run()
    try {
      input.write(
        encodeFrame(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test' } },
          },
          'ndjson',
        ),
      )
      await new Promise((r) => setTimeout(r, 40))

      // Start a 15s wait and immediately cancel it via notifications/cancelled
      const t0 = Date.now()
      input.write(
        encodeFrame(
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'board_wait', arguments: { mode: 'inbox', timeoutS: 15 } },
          },
          'ndjson',
        ),
      )
      await new Promise((r) => setTimeout(r, 40))
      input.write(
        encodeFrame(
          {
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 2, reason: 'client cancelled' },
          },
          'ndjson',
        ),
      )

      // Error mapping: missing message -> isError: true with 404 message_not_found
      input.write(
        encodeFrame(
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'board_read', arguments: { target: '999999' } },
          },
          'ndjson',
        ),
      )

      // Reserved group handle -> isError: true with 400 group_reserved
      input.write(
        encodeFrame(
          {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: 'board_group', arguments: { action: 'create', handle: 'channel', name: 'Reserved' } },
          },
          'ndjson',
        ),
      )

      // Wait for all 4 responses
      const deadline = Date.now() + 3000
      while (received.length < 4 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      const elapsed = Date.now() - t0
      expect(elapsed).toBeLessThan(3000)
      expect(received).toHaveLength(4)

      const res3 = received.find((r) => (r as JsonRpcSuccess).id === 3) as JsonRpcSuccess
      const payload3 = res3.result as { isError: boolean; content: [{ text: string }] }
      expect(payload3.isError).toBe(true)
      expect(JSON.parse(payload3.content[0].text)).toMatchObject({
        error: { status: 404, code: 'message_not_found' },
      })

      const res4 = received.find((r) => (r as JsonRpcSuccess).id === 4) as JsonRpcSuccess
      const payload4 = res4.result as { isError: boolean; content: [{ text: string }] }
      expect(payload4.isError).toBe(true)
      expect(JSON.parse(payload4.content[0].text)).toMatchObject({
        error: { status: 400, code: 'group_reserved' },
      })

      input.end()
      await runPromise
    } finally {
      await server.shutdown()
      await h.cleanup()
    }
  })

  it('evicts stale claim proofs on claim_lost and never leaks raw internal errors', async () => {
    const h = await createHarness({ profile: 'agy' })
    try {
      await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      })

      const created = await rpcCall<{ task: { id: string } }>(h.server, 'board_task_create', {
        channel: 'work',
        text: 'Evict stale token test',
        claim: true,
        lease: 60,
      })
      const taskId = created.data.task.id

      const badRenew = await rpcCall<{ error: { code: string; status: number } }>(h.server, 'board_task_update', {
        action: 'renew',
        id: taskId,
        token: 'wrong-token-value',
      })
      expect(badRenew.isError).toBe(true)
      expect(badRenew.data.error.code).toBe('claim_lost')

      // After claim_lost eviction, calling complete without explicit token reports missing claim proof cleanly
      const missingProof = await rpcCall<{ error: { code: string } }>(h.server, 'board_task_update', {
        action: 'complete',
        id: taskId,
      })
      expect(missingProof.isError).toBe(true)
      expect(missingProof.data.error.code).toBe('invalid_request')
    } finally {
      await h.cleanup()
    }
  })

  it('masks non-BoardError throws cleanly without leaking internal paths and promotes a message via board_task_create(re)', async () => {
    const h = await createHarness({ profile: 'agy' })
    try {
      await h.server.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      })

      // Promote an existing message to a task via re + claim: true -> complete via claim cache
      const root = await rpcCall<{ message: { id: string } }>(h.server, 'board_post', {
        channel: 'work',
        text: 'Promote me to a task',
      })
      const promoted = await rpcCall<{ task: { id: string }; claim?: { cached: boolean } }>(
        h.server,
        'board_task_create',
        { re: root.data.message.id, claim: true, lease: 60 },
      )
      expect(promoted.isError).toBe(false)
      expect(promoted.data.task.id).toBe(root.data.message.id)
      expect(promoted.data.claim?.cached).toBe(true)

      const done = await rpcCall<{ ok: true; task: { task?: { state: string } } }>(
        h.server,
        'board_task_update',
        { action: 'complete', id: root.data.message.id, result: 'Promoted & finished' },
      )
      expect(done.isError).toBe(false)
      expect(done.data.task.task?.state).toBe('completed')

      // Unexpected Error without formatError bridge must never leak raw secret/path details
      const leakyClient = {
        caps: { maxWaitS: 300, boardId: 'b_err' },
        resolution: null,
        raw: { closed: false },
        async me() {
          throw new TypeError('/Users/secret/private-key.pem leaked')
        },
        async close() {},
      } as unknown as BoardClient
      const isolated = createMcpServer({
        bridge: {
          claimsDir: null,
          async connect() {
            return leakyClient
          },
        },
        autoPresence: false,
      })
      try {
        const errRes = await rpcCall<{ error: { status: number; code: string; message: string } }>(isolated, 'board_me')
        expect(errRes.isError).toBe(true)
        expect(errRes.data.error.status).toBe(500)
        expect(errRes.data.error.code).toBe('internal')
        expect(errRes.data.error.message).not.toContain('private-key.pem')
      } finally {
        await isolated.shutdown()
      }
    } finally {
      await h.cleanup()
    }
  })

  it('isolates ClaimCache per authenticated actor across sibling MCP servers sharing board.db + claimsDir while recovering across single-agent restart (MCP-F1)', async () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'board.db')
    const claimsDir = join(dir, 'claims')

    const makeServerFor = (profile: string) => {
      const id = resolveLocalIdentity({ userId: 'alice', as: profile, isTTY: false, env: {} })
      return createMcpServer({
        bridge: {
          claimsDir,
          formatError: clientErrorPayload,
          async connect() {
            return connect({ db: dbPath, mode: 'file', identity: id.provider })
          },
        },
        autoPresence: false,
      })
    }

    const agy1 = makeServerFor('agy')
    const codex = makeServerFor('codex')
    let agy2: ReturnType<typeof createMcpServer> | null = null

    try {
      await agy1.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
      await codex.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })

      // agy creates and claims a task -> proof persisted under (boardKey, agy)
      const created = await rpcCall<{ task: { id: string }; claim?: { cached: boolean } }>(
        agy1,
        'board_task_create',
        { channel: 'work', text: 'Actor-isolated claim cache task', claim: true, lease: 120 },
      )
      expect(created.isError).toBe(false)
      expect(created.data.claim?.cached).toBe(true)
      const taskId = created.data.task.id

      // Sibling agent codex sharing the SAME board.db + claimsDir CANNOT steal agy's cached bearer token
      const stealAttempt = await rpcCall<{ error: { code: string } }>(codex, 'board_task_update', {
        action: 'complete',
        id: taskId,
        result: 'STOLEN',
      })
      expect(stealAttempt.isError).toBe(true)
      expect(stealAttempt.data.error.code).toBe('invalid_request')

      // Even if codex triggers a claim_lost eviction with a bogus token, agy's persisted proof stays untouched
      const badEvict = await rpcCall<{ error: { code: string } }>(codex, 'board_task_update', {
        action: 'complete',
        id: taskId,
        epoch: 1,
        token: 'bogus-token-from-codex',
        result: 'STOLEN',
      })
      expect(badEvict.isError).toBe(true)
      expect(badEvict.data.error.code).toBe('claim_lost')

      // Shut down agy1 and start a fresh agy2 MCP server (simulating restart) -> recovers its own proof and completes!
      await agy1.shutdown()
      agy2 = makeServerFor('agy')
      await agy2.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })

      const completed = await rpcCall<{ ok: true; task: { task?: { state: string; result?: string } } }>(
        agy2,
        'board_task_update',
        { action: 'complete', id: taskId, result: 'Completed cleanly by agy after restart' },
      )
      expect(completed.isError).toBe(false)
      expect(completed.data.task.task?.state).toBe('completed')
      expect(completed.data.task.task?.result).toBe('Completed cleanly by agy after restart')
    } finally {
      await agy1.shutdown()
      await codex.shutdown()
      if (agy2) await agy2.shutdown()
    }
  })

  it('keeps src/mcp thin with zero runtime edges into src/core, src/host, or zod (HS-01/HS-55)', async () => {
    const { files, symlinks } = transportFiles(ROOT, ['mcp'])
    expect(symlinks).toEqual([])
    expect(files.length).toBeGreaterThanOrEqual(7)
    const edges = await importGraph(files)
    const mcpEdges = edges.filter(([parent]) => parent.includes('/src/mcp/'))
    for (const [parent, child] of mcpEdges) {
      expect(child, `${parent} -> ${child}`).not.toContain('/src/core/')
      expect(child, `${parent} -> ${child}`).not.toContain('/src/host/')
      expect(child, `${parent} -> ${child}`).not.toContain('/node_modules/zod/')
    }
  }, 60_000)
})
