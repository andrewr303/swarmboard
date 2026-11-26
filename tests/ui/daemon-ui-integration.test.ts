// Live HTTP Daemon Integration Tests for HOST-12 Command Center Web UI (V2-21).
// Boots real `runDaemonServer` instances with ephemeral loopback TCP ports and verifies:
// - Default UI serving at /, /assets/app.js, /assets/app.css, /assets/favicon.svg with strict CSP & ETag 304
// - Loopback CSRF enforcement + human owner posting (actor.kind === 'person')
// - Cookie login flow under auth.enforce=true (POST /_swarm/v1/login & GET /_swarm/v1/login?code=...)
// - Channel tree, Forum Index (Announcements -> Sticky -> Active), Thread View + Quote + Reactions + Flagging + Pin/Unpin
// - @agent & @group (@swarmteam3) mentions + Inbox/Notifications + Ack
// - Canonical private DMs, Needs You (Decisions + blocked tasks unblock/claim/complete)
// - Who Is Online presence, Beta Feedback (meta/feedback) triage & promote-to-task, FTS5 Search
// - Live SSE push (/api/v2/stream) delivering real-time message, notification, presence, and pin events
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDaemonServer, type DaemonHandle } from '../../src/host/daemon/index.ts'
import { UI_CSP_HEADER } from '../../src/server/ui.ts'
import { excerptText, firstLineTitle, tokenizeInlineRichText } from '../../src/ui/dom.ts'
import { canReopenTaskState, resolveEventRootId } from '../../src/ui/state.ts'
import type { UiBoardEventView } from '../../src/ui/types.ts'

const handles: DaemonHandle[] = []
const tmpDirs: string[] = []

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()!
    await h.close().catch(() => {})
  }
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

async function startLiveDaemon(opts: { authEnforce?: boolean } = {}): Promise<{
  daemon: DaemonHandle
  baseUrl: string
}> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-ui-test-')))
  tmpDirs.push(dir)
  const db = join(dir, 'board.db')
  const runDir = join(dir, 'run')
  const daemon = await runDaemonServer({
    db,
    runDir,
    tcp: { host: '127.0.0.1', port: 0 },
    idleExitMs: 0,
    tick: 'off',
    authEnforce: opts.authEnforce ?? false,
    ownerUserId: 'alice',
    ownerHandle: 'alice',
    ownerName: 'Alice',
    wake: { watch: false, safetyPollMs: 50 },
  })
  handles.push(daemon)
  expect(daemon.tcp).not.toBeNull()
  return { daemon, baseUrl: daemon.tcp!.url }
}

async function jsonReq<T>(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  const method = init.method ?? 'GET'
  const isRead = method === 'GET' || method === 'HEAD'
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(isRead ? {} : { 'Content-Type': 'application/json' }),
    ...(init.headers ?? {}),
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(isRead ? {} : { body: JSON.stringify(init.body ?? {}) }),
  })
  const text = await res.text()
  const data = text.length > 0 ? (JSON.parse(text) as T) : (null as T)
  return { status: res.status, data, headers: res.headers }
}

describe('V2-21 Command Center Web UI live daemon HTTP & SSE integration', () => {
  it('V2-21 serves full Command Center SPA on / and /assets/* by default with strict CSP, ETag 304, and instance headers', async () => {
    const { daemon, baseUrl } = await startLiveDaemon()
    const info = daemon.board.boardInfo()

    const root = await fetch(`${baseUrl}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toContain('text/html')
    expect(root.headers.get('content-security-policy')).toBe(UI_CSP_HEADER)
    expect(root.headers.get('x-content-type-options')).toBe('nosniff')
    expect(root.headers.get('x-swarmboard-instance')).toBe(info.instanceId)
    const html = await root.text()
    expect(html).toContain('Swarmboard Command Center')
    expect(html).toContain('/assets/app.js')
    expect(html).toContain('/assets/app.css')

    // Conditional ETag 304
    const etag = root.headers.get('etag')!
    const cached = await fetch(`${baseUrl}/`, { headers: { 'If-None-Match': etag } })
    expect(cached.status).toBe(304)

    // JS & CSS bundles served cleanly
    const jsRes = await fetch(`${baseUrl}/assets/app.js`)
    expect(jsRes.status).toBe(200)
    expect(jsRes.headers.get('content-type')).toContain('text/javascript')
    const js = await jsRes.text()
    expect(js).toContain('/api/v2/stream')
    expect(js).toContain('mountCommandCenter')

    const cssRes = await fetch(`${baseUrl}/assets/app.css`)
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('content-type')).toContain('text/css')
    expect(await cssRes.text()).toContain('.cb-space-rail')

    // Unknown asset returns 404
    const missing = await fetch(`${baseUrl}/assets/does-not-exist.js`)
    expect(missing.status).toBe(404)
  })

  it('V2-21 enforces loopback CSRF guards and supports cookie login flow under auth.enforce=true', async () => {
    const { daemon, baseUrl } = await startLiveDaemon({ authEnforce: true })

    // SPA HTML shell still loads on loopback so Login Modal can render
    const shell = await fetch(`${baseUrl}/`)
    expect(shell.status).toBe(200)

    // Unauthenticated API call returns 401 -> UI opens Login Modal
    const unauth = await jsonReq<{ error: { code: string } }>(baseUrl, '/api/board/me')
    expect(unauth.status).toBe(401)

    // Mint 60s login code (human owner) and exchange via POST /_swarm/v1/login
    const minted = daemon.authenticator.mintLoginCode({ assurance: 'human_verified' })
    const loginRes = await jsonReq<{ ok: boolean; expiresAt: string }>(baseUrl, '/_swarm/v1/login', {
      method: 'POST',
      body: { code: minted.code },
    })
    expect(loginRes.status).toBe(200)
    expect(loginRes.data.ok).toBe(true)
    const setCookie = loginRes.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('sb_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    const cookieHeader = setCookie.split(';')[0]!

    // Authenticated UI calls succeed as human person
    const me = await jsonReq<{ actor: string; kind: string; handle: string; assurance: string }>(
      baseUrl,
      '/api/board/me',
      { headers: { Cookie: cookieHeader } },
    )
    expect(me.status).toBe(200)
    expect(me.data.kind).toBe('person')
    expect(me.data.handle).toBe('alice')
    expect(me.data.assurance).toBe('human_verified')

    // Loopback CSRF still rejects text/plain even with valid session cookie
    const csrfBad = await fetch(`${baseUrl}/api/board/messages`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ channel: 'general', text: 'csrf attempt' }),
    })
    expect(csrfBad.status).toBe(403)

    // Valid same-origin JSON write with cookie posts as person
    const posted = await jsonReq<{ message: { id: string; author: { kind: string } } }>(
      baseUrl,
      '/api/board/messages',
      {
        method: 'POST',
        headers: { Cookie: cookieHeader },
        body: { channel: 'general', text: 'Human drop-in via cookie session' },
      },
    )
    expect(posted.status).toBe(200)
    expect(posted.data.message.author.kind).toBe('person')

    // Also verify GET /_swarm/v1/login?code=... redirect flow (used by `swarmboard open`)
    const minted2 = daemon.authenticator.mintLoginCode()
    const redir = await fetch(`${baseUrl}/_swarm/v1/login?code=${encodeURIComponent(minted2.code)}`, {
      redirect: 'manual',
    })
    expect(redir.status).toBe(302)
    expect(redir.headers.get('location')).toBe('/')
    expect(redir.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('V2-21 drives all Command Center data paths: tree, forum tiers, quotes/flags/pins, @groups, DMs, Decisions/Tasks, Presence, Feedback & Search', async () => {
    const { baseUrl } = await startLiveDaemon()

    // 1. Seed channels across spaces + private channel
    for (const ch of [
      { path: 'general', kind: 'chat', topic: 'Global coordination' },
      { path: 'decisions', kind: 'forum', topic: 'Human sign-offs' },
      { path: 'repos/agent-board/dev', kind: 'forum', topic: 'Active implementation' },
      { path: 'swarms/w4/general', kind: 'chat', topic: 'Wave 4 room' },
      { path: 'work/agent-board', kind: 'tasks', topic: 'Engineering backlog' },
      { path: 'meta/feedback', kind: 'forum', topic: 'Beta feedback' },
      { path: 'repos/agent-board/secret', kind: 'chat', private: true, members: ['codex'] },
    ]) {
      const r = await jsonReq(baseUrl, '/api/board/channels', { method: 'POST', body: ch })
      expect(r.status).toBe(200)
    }

    const tree = await jsonReq<{ tree: unknown[] }>(baseUrl, '/api/v2/channels/tree?includeUnread=true')
    expect(tree.status).toBe(200)
    expect(tree.data.tree.length).toBeGreaterThanOrEqual(5)

    // 2. Forum Index ordering: Announcements -> Sticky -> Active
    const tNormal = await jsonReq<{ message: { id: string } }>(baseUrl, '/api/board/messages', {
      method: 'POST',
      body: { channel: 'repos/agent-board/dev', text: 'Regular topic discussion' },
    })
    const tSticky = await jsonReq<{ message: { id: string } }>(baseUrl, '/api/board/messages', {
      method: 'POST',
      body: { channel: 'repos/agent-board/dev', text: 'Sticky Wave 4 checklist' },
    })
    const tAnnounce = await jsonReq<{ message: { id: string } }>(baseUrl, '/api/board/messages', {
      method: 'POST',
      body: { channel: 'repos/agent-board/dev', text: 'ANNOUNCEMENT: Launch freeze at 18:00' },
    })
    await jsonReq(baseUrl, `/api/v2/messages/${tAnnounce.data.message.id}/pin`, {
      method: 'POST',
      body: { scope: 'announcement', note: 'Must read' },
    })
    await jsonReq(baseUrl, `/api/v2/messages/${tSticky.data.message.id}/pin`, {
      method: 'POST',
      body: { scope: 'channel', note: 'Active checklist' },
    })

    const forum = await jsonReq<{
      threads: Array<{ message: { id: string }; pin?: { scope: string } }>
    }>(baseUrl, '/api/board/threads?channel=repos/agent-board/dev&order=forum&includeMeta=true')
    expect(forum.status).toBe(200)
    expect(forum.data.threads.map((t) => t.message.id)).toEqual([
      tAnnounce.data.message.id,
      tSticky.data.message.id,
      tNormal.data.message.id,
    ])
    expect(forum.data.threads[0]!.pin?.scope).toBe('announcement')
    expect(forum.data.threads[1]!.pin?.scope).toBe('channel')
    expect(forum.data.threads[2]!.pin).toBeUndefined()

    // 3. Thread View: Quote reply, reaction shortcode, flag/report + resolve, unpin
    const reply = await jsonReq<{ message: { id: string; quote?: { id: string; excerpt: string }; author: { kind: string } } }>(
      baseUrl,
      '/api/board/messages',
      {
        method: 'POST',
        body: {
          re: tNormal.data.message.id,
          quoteMessageId: tNormal.data.message.id,
          text: 'Quoting root post and pinging @codex in #work/agent-board',
        },
      },
    )
    expect(reply.status).toBe(200)
    expect(reply.data.message.quote?.id).toBe(tNormal.data.message.id)
    expect(reply.data.message.author.kind).toBe('person')

    const reacted = await jsonReq<{ reactions: Record<string, string[]> }>(
      baseUrl,
      `/api/board/messages/${reply.data.message.id}/reactions`,
      { method: 'POST', body: { emoji: 'thumbs_up' } },
    )
    expect(reacted.status).toBe(200)
    expect(reacted.data.reactions['thumbs_up']?.length).toBe(1)

    const flagged = await jsonReq<{ labels: Record<string, string> }>(
      baseUrl,
      `/api/board/messages/${reply.data.message.id}/labels`,
      {
        method: 'POST',
        body: { set: { 'flag.status': 'open', 'flag.reason': 'Needs verification', 'flag.by': 'alice' } },
      },
    )
    expect(flagged.data.labels['flag.status']).toBe('open')

    const resolved = await jsonReq<{ labels: Record<string, string> }>(
      baseUrl,
      `/api/board/messages/${reply.data.message.id}/labels`,
      { method: 'POST', body: { set: { 'flag.status': 'resolved' } } },
    )
    expect(resolved.data.labels['flag.status']).toBe('resolved')

    // 4. Groups (@swarmteam3) + @group mention fanout + Notifications + Ack
    const grp = await jsonReq<{ handle: string; members: Array<{ memberId: string }> }>(baseUrl, '/api/v2/groups', {
      method: 'POST',
      body: { handle: 'swarmteam3', name: 'Swarm Team 3', kind: 'swarm', members: ['codex', 'claude'] },
    })
    expect(grp.status).toBe(200)
    expect(grp.data.members.length).toBe(2)

    await jsonReq(baseUrl, '/api/v2/groups/swarmteam3/members', {
      method: 'POST',
      body: { members: ['agy'] },
    })
    await jsonReq(baseUrl, '/api/v2/groups/swarmteam3/members/remove', {
      method: 'POST',
      body: { members: ['claude'] },
    })

    // Agent posts mentioning @alice -> triggers human notification
    await jsonReq(baseUrl, '/api/board/messages', {
      method: 'POST',
      headers: { 'X-Board-Profile': 'codex' },
      body: { channel: 'general', text: 'Hey @alice and @swarmteam3, review ready!' },
    })
    const inbox = await jsonReq<{ unreadNotifications: number; notifications: Array<{ id: string; reason: string }> }>(
      baseUrl,
      '/api/v2/inbox',
    )
    expect(inbox.status).toBe(200)
    expect(inbox.data.unreadNotifications).toBeGreaterThanOrEqual(1)
    await jsonReq(baseUrl, `/api/v2/notifications/${inbox.data.notifications[0]!.id}/ack`, { method: 'POST', body: {} })

    // 5. Canonical private DM
    const dm = await jsonReq<{ channel: { path: string; private?: boolean; kind?: string } }>(baseUrl, '/api/v2/dm', {
      method: 'POST',
      body: { peer: 'codex' },
    })
    expect(dm.status).toBe(200)
    expect(dm.data.channel.path).toBe('dm/alice--codex')
    await jsonReq(baseUrl, '/api/board/messages', {
      method: 'POST',
      body: { channel: dm.data.channel.path, text: 'Direct message to codex' },
    })
    const dmMsgs = await jsonReq<{ messages: Array<{ text: string }> }>(
      baseUrl,
      `/api/board/messages?channel=${encodeURIComponent(dm.data.channel.path)}`,
    )
    expect(dmMsgs.data.messages.some((m) => m.text === 'Direct message to codex')).toBe(true)

    // 6. Needs You: Decisions urgent post + Task block -> 1-click unblock -> claim -> complete
    await jsonReq(baseUrl, '/api/board/messages', {
      method: 'POST',
      headers: { 'X-Board-Profile': 'claude' },
      body: { channel: 'decisions', text: 'Approve shipping Command Center UI?' },
    })
    const createdTask = await jsonReq<{ task: { id: string; task: { state: string } } }>(baseUrl, '/api/board/tasks', {
      method: 'POST',
      body: { channel: 'work/agent-board', text: 'Verify V2-21 Command Center UI' },
    })
    expect(createdTask.status).toBe(200)
    const tid = createdTask.data.task.id
    const blocked = await jsonReq<{ task: { task: { state: string } } }>(baseUrl, `/api/board/tasks/${tid}/block`, {
      method: 'POST',
      body: { reason: 'Awaiting human approval' },
    })
    expect(blocked.data.task.task.state).toBe('blocked')

    const unblocked = await jsonReq<{ task: { task: { state: string } } }>(
      baseUrl,
      `/api/board/tasks/${tid}/unblock`,
      { method: 'POST', body: {} },
    )
    expect(unblocked.data.task.task.state).toBe('ready')

    const claimed = await jsonReq<{ claim: { epoch: number; token: string } }>(
      baseUrl,
      `/api/board/tasks/${tid}/claim`,
      { method: 'POST', body: {} },
    )
    const completed = await jsonReq<{ task: { task: { state: string } } }>(
      baseUrl,
      `/api/board/tasks/${tid}/complete`,
      {
        method: 'POST',
        body: { epoch: claimed.data.claim.epoch, token: claimed.data.claim.token, result: 'Verified green' },
      },
    )
    expect(completed.data.task.task.state).toBe('completed')

    // 7. Who Is Online (Presence)
    await jsonReq(baseUrl, '/api/v2/presence', {
      method: 'PUT',
      headers: { 'X-Board-Profile': 'codex' },
      body: { status: 'active', channel: 'repos/agent-board/dev', harness: 'codex', model: 'gpt-5', ttlS: 120 },
    })
    await jsonReq(baseUrl, '/api/v2/presence', {
      method: 'PUT',
      body: { status: 'active', channel: 'general', harness: 'command-center-ui', ttlS: 120 },
    })
    const presence = await jsonReq<Array<{ handle: string; status: string; model: string | null }>>(
      baseUrl,
      '/api/v2/presence',
    )
    expect(presence.data.some((p) => p.handle.includes('codex') && p.model === 'gpt-5')).toBe(true)

    // 8. Beta Feedback (meta/feedback) triage & promote to task
    const fb = await jsonReq<{ message: { id: string; channel: string; labels: Record<string, string> } }>(
      baseUrl,
      '/api/v2/feedback',
      {
        method: 'POST',
        body: { summary: 'Add Cmd+K quick channel jump', kind: 'ux', severity: 'low' },
      },
    )
    expect(fb.status).toBe(201)
    expect(fb.data.message.channel).toBe('meta/feedback')
    await jsonReq(baseUrl, `/api/board/messages/${fb.data.message.id}/labels`, {
      method: 'POST',
      body: { set: { status: 'triaged' } },
    })
    const promoted = await jsonReq<{ task: { id: string; task: { state: string } } }>(baseUrl, '/api/board/tasks', {
      method: 'POST',
      body: { re: fb.data.message.id },
    })
    expect(promoted.status).toBe(200)
    expect(promoted.data.task.task.state).toBe('ready')

    // 9. FTS5 Search & Mark Read
    const hits = await jsonReq<Array<{ id: string }>>(baseUrl, '/api/v2/search?query=Launch+freeze')
    expect(hits.status).toBe(200)
    expect(hits.data.some((h) => h.id === tAnnounce.data.message.id)).toBe(true)

    const marked = await jsonReq(baseUrl, '/api/v2/channels/read', {
      method: 'POST',
      body: { channel: 'repos/agent-board/dev' },
    })
    expect(marked.status).toBe(200)

    // Cleanup group delete with Content-Type: application/json
    const delGrp = await jsonReq<{ deleted: boolean }>(baseUrl, '/api/v2/groups/swarmteam3', {
      method: 'DELETE',
      body: {},
    })
    expect(delGrp.status).toBe(200)
    expect(delGrp.data.deleted).toBe(true)
  })

  it('V2-21 pushes live message, notification, presence, and pin updates over SSE /api/v2/stream', async () => {
    const { baseUrl } = await startLiveDaemon()
    const abort = new AbortController()

    const sseRes = await fetch(`${baseUrl}/api/v2/stream`, {
      headers: { Accept: 'text/event-stream' },
      signal: abort.signal,
    })
    expect(sseRes.status).toBe(200)
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream')
    const reader = sseRes.body!.getReader()
    const dec = new TextDecoder()

    const received: Array<{ event: string; data: string }> = []
    let buf = ''
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let sep = buf.indexOf('\n\n')
          while (sep !== -1) {
            const frame = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            let evName = 'message'
            const dataLines: string[] = []
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) evName = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            }
            if (dataLines.length > 0) {
              received.push({ event: evName, data: dataLines.join('\n') })
            }
            sep = buf.indexOf('\n\n')
          }
        }
      } catch {
        // aborted on cleanup
      }
    })()

    // Trigger external agent post mentioning @alice, presence update, and pin
    const post = await jsonReq<{ message: { id: string } }>(baseUrl, '/api/board/messages', {
      method: 'POST',
      headers: { 'X-Board-Profile': 'claude' },
      body: { channel: 'general', text: 'Live SSE check for @alice!' },
    })
    await jsonReq(baseUrl, '/api/v2/presence', {
      method: 'PUT',
      headers: { 'X-Board-Profile': 'claude' },
      body: { status: 'busy', channel: 'general', harness: 'claude-code', ttlS: 120 },
    })
    await jsonReq(baseUrl, `/api/v2/messages/${post.data.message.id}/pin`, {
      method: 'POST',
      body: { scope: 'channel' },
    })

    // Wait up to 2s for all 4 SSE categories to arrive
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const names = new Set(received.map((r) => r.event))
      if (names.has('message') && names.has('notification') && names.has('presence') && names.has('pin')) {
        break
      }
      await new Promise((r) => setTimeout(r, 25))
    }

    abort.abort()
    await pump

    const events = new Set(received.map((r) => r.event))
    expect(events.has('message')).toBe(true)
    expect(events.has('notification')).toBe(true)
    expect(events.has('presence')).toBe(true)
    expect(events.has('pin')).toBe(true)
  })

  it('UI-F1..UI-F3 live regression: canonical @[actor] mentions, failed-only Reopen + claim_lost, and live SSE decisions rootId', async () => {
    const { baseUrl } = await startLiveDaemon()

    // Ensure actors exist so core canonicalizes @alice and @codex to @[local:user:...]
    await jsonReq(baseUrl, '/api/board/messages', {
      method: 'POST',
      body: { channel: 'general', text: 'Owner hello' },
    })
    const agentPost = await jsonReq<{ message: { id: string; text: string } }>(baseUrl, '/api/board/messages', {
      method: 'POST',
      headers: { 'X-Board-Profile': 'codex' },
      body: { channel: 'general', text: 'Ping @alice from codex' },
    })
    expect(agentPost.status).toBe(200)
    // Core stores canonical @[local:user:alice] — verify UI tokenizer + title/excerpt format it cleanly
    expect(agentPost.data.message.text).toContain('@[local:user:alice]')
    const tokens = tokenizeInlineRichText(agentPost.data.message.text)
    expect(tokens.some((t) => t.kind === 'mention' && t.raw === '@alice' && t.value === 'alice')).toBe(true)
    expect(firstLineTitle(agentPost.data.message.text)).toBe('Ping @alice from codex')
    expect(excerptText(agentPost.data.message.text)).toBe('Ping @alice from codex')

    // UI-F2: completed task cannot be reopened (409 task_finished); failed task CAN be reopened (200); stale claim returns 409 claim_lost
    const tDone = await jsonReq<{ task: { id: string } }>(baseUrl, '/api/board/tasks', {
      method: 'POST',
      body: { channel: 'work', text: 'Task to complete' },
    })
    const c1 = await jsonReq<{ claim: { epoch: number; token: string } }>(
      baseUrl,
      `/api/board/tasks/${tDone.data.task.id}/claim`,
      { method: 'POST', body: {} },
    )
    await jsonReq(baseUrl, `/api/board/tasks/${tDone.data.task.id}/complete`, {
      method: 'POST',
      body: { epoch: c1.data.claim.epoch, token: c1.data.claim.token, result: 'done' },
    })
    const reopenCompleted = await jsonReq<{ error: { code: string } }>(
      baseUrl,
      `/api/board/tasks/${tDone.data.task.id}/reopen`,
      { method: 'POST', body: {} },
    )
    expect(reopenCompleted.status).toBe(409)
    expect(reopenCompleted.data.error.code).toBe('task_finished')
    expect(canReopenTaskState('completed')).toBe(false)

    const tFail = await jsonReq<{ task: { id: string } }>(baseUrl, '/api/board/tasks', {
      method: 'POST',
      body: { channel: 'work', text: 'Task to fail and reopen' },
    })
    const c2 = await jsonReq<{ claim: { epoch: number; token: string } }>(
      baseUrl,
      `/api/board/tasks/${tFail.data.task.id}/claim`,
      { method: 'POST', body: {} },
    )
    // Stale/wrong token triggers 409 claim_lost (what app.ts evicts from claimCache)
    const staleComplete = await jsonReq<{ error: { code: string } }>(
      baseUrl,
      `/api/board/tasks/${tFail.data.task.id}/complete`,
      { method: 'POST', body: { epoch: c2.data.claim.epoch, token: 'wrong-stale-token' } },
    )
    expect(staleComplete.status).toBe(409)
    expect(staleComplete.data.error.code).toBe('claim_lost')

    await jsonReq(baseUrl, `/api/board/tasks/${tFail.data.task.id}/fail`, {
      method: 'POST',
      body: { epoch: c2.data.claim.epoch, token: c2.data.claim.token, reason: 'retry needed' },
    })
    expect(canReopenTaskState('failed')).toBe(true)
    const reopenFailed = await jsonReq<{ task: { task: { state: string } } }>(
      baseUrl,
      `/api/board/tasks/${tFail.data.task.id}/reopen`,
      { method: 'POST', body: {} },
    )
    expect(reopenFailed.status).toBe(200)
    expect(reopenFailed.data.task.task.state).toBe('ready')

    // UI-F3: Real SSE message.posted on decisions resolves valid thread rootId even without payload.id
    const abort = new AbortController()
    const sseRes = await fetch(`${baseUrl}/api/v2/stream`, {
      headers: { Accept: 'text/event-stream' },
      signal: abort.signal,
    })
    const reader = sseRes.body!.getReader()
    const dec = new TextDecoder()
    let decisionEv: UiBoardEventView | null = null
    let buf = ''
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let sep = buf.indexOf('\n\n')
          while (sep !== -1) {
            const frame = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            let evName = 'message'
            const dataLines: string[] = []
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) evName = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            }
            if (evName === 'message' && dataLines.length > 0) {
              const parsed = JSON.parse(dataLines.join('\n')) as UiBoardEventView
              if (parsed.type === 'message.posted' && parsed.payload.channel === 'decisions') {
                decisionEv = parsed
              }
            }
            sep = buf.indexOf('\n\n')
          }
        }
      } catch {
        // aborted
      }
    })()

    const decPosted = await jsonReq<{ message: { id: string } }>(baseUrl, '/api/board/messages', {
      method: 'POST',
      headers: { 'X-Board-Profile': 'claude' },
      body: { channel: 'decisions', text: 'Ship v2 launch?' },
    })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && decisionEv === null) {
      await new Promise((r) => setTimeout(r, 20))
    }
    abort.abort()
    await pump

    expect(decisionEv).not.toBeNull()
    const resolvedRootId = resolveEventRootId(decisionEv!)
    expect(resolvedRootId).not.toBe('')
    const loadedThread = await jsonReq<{ message: { id: string; channel: string } }>(
      baseUrl,
      `/api/board/messages/${encodeURIComponent(resolvedRootId)}`,
    )
    expect(loadedThread.status).toBe(200)
    expect(loadedThread.data.message.id).toBe(decPosted.data.message.id)
    expect(loadedThread.data.message.channel).toBe('decisions')
  })
})
