// End-to-end integration tests for all HOST-5 social, messaging, channel, group, pin,
// presence, inbox, feedback, search, init --universal, and tasks CLI commands.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../../src/cli/index.ts'
import { createDefaultHostBridge } from '../../src/host/bin/swarmboard.ts'

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

function makeWorkspace() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cli-int-')))
  tmpDirs.push(dir)
  const db = path.join(dir, 'board.db')
  const xdgConfig = path.join(dir, 'xdg-config')
  fs.mkdirSync(xdgConfig, { recursive: true, mode: 0o700 })
  const bridge = createDefaultHostBridge()

  async function exec(
    args: string[],
    opts: {
      env?: Record<string, string | undefined>
      stdin?: string
      tty?: boolean
      omitDb?: boolean
    } = {},
  ) {
    let stdout = ''
    let stderr = ''
    const io: CliIo = {
      stdout(s) {
        stdout += s
      },
      stderr(s) {
        stderr += s
      },
      async readStdin() {
        return opts.stdin ?? ''
      },
      stdinIsTTY: opts.tty ?? false,
      stdoutIsTTY: opts.tty ?? false,
    }
    const env: Record<string, string | undefined> = {
      HOME: dir,
      XDG_CONFIG_HOME: xdgConfig,
      USER: 'tester',
      ...opts.env,
    }
    const fullArgs = opts.omitDb ? args : ['--db', db, '--mode', 'file', ...args]
    const code = await runCli(fullArgs, env, bridge, { cwd: dir, io })
    let json: unknown
    try {
      if (stdout.trim()) json = JSON.parse(stdout)
    } catch {
      json = undefined
    }
    let errorJson: unknown
    try {
      if (stderr.trim()) errorJson = JSON.parse(stderr)
    } catch {
      errorJson = undefined
    }
    return { code, stdout, stderr, json, errorJson }
  }

  return { dir, db, xdgConfig, exec }
}

describe('read --handoff', () => {
  it('attributes labeled posts, reflects edits and deletions, and keeps the selected reply window', async () => {
    const ws = makeWorkspace()
    const run = async <T = unknown>(...args: string[]) => {
      const res = await ws.exec([...args, '--as', 'codex', '--json'])
      expect(res.code, res.stderr).toBe(0)
      return res.json as T
    }
    const message = run<{ id: string; thread: string; author: { handle: string } }>
    const root = await message('post', 'general', 'Keep the existing format', '-l', 'handoff=decision')
    const followup = await message('reply', root.id, 'Publish a sample')
    await run('label', followup.id, 'handoff=todo')
    await run('edit', followup.id, 'Publish two samples')
    const result = await message('reply', root.id, 'Both samples verified', '-l', 'handoff=result')
    const ordinary = await message('reply', root.id, 'The samples are in the thread')
    const removed = await message('reply', root.id, 'Withdrawn result', '-l', 'handoff=result')
    await run('delete', removed.id)

    const report = await run('read', ordinary.id, '--handoff')
    expect(report).toMatchObject({
      rootId: root.id, channel: 'general', task: null,
      items: [
        { kind: 'decision', id: root.id, excerpt: 'Keep the existing format' },
        { kind: 'todo', id: followup.id, excerpt: 'Publish two samples' },
        { kind: 'result', id: result.id, handle: result.author.handle },
      ],
      latestReply: { id: ordinary.id },
      coverage: { limit: 50, repliesScanned: 4, limitReached: false, lastReplyId: removed.id },
    })
    expect(await run('read', root.thread, '--handoff', '--after', followup.id, '--limit', '1')).toMatchObject({
      items: [{ id: root.id }, { id: result.id }], latestReply: { id: result.id },
      coverage: { after: followup.id, repliesScanned: 1, limitReached: true, lastReplyId: result.id },
    })
    const text = await ws.exec(['read', root.id, '--handoff', '--as', 'codex'])
    expect(text.stdout).toContain(`[todo] #${followup.id} @${followup.author.handle} · Publish two samples`)
    expect(text.stdout).toContain(`Latest reply: #${ordinary.id}`)
    expect(text.stdout).not.toContain('Withdrawn result')
  })

  it('rejects channel targets and protects private messages', async () => {
    const ws = makeWorkspace()
    const dm = await ws.exec(['dm', 'codex', 'Private handoff', '--as', 'agy', '--json'])
    expect(dm.code, dm.stderr).toBe(0)
    const id = (dm.json as { message: { id: string } }).message.id
    const denied = await ws.exec(['read', id, '--handoff', '--as', 'claude', '--json'])
    expect(denied.code).not.toBe(0)
    expect(denied.stdout + denied.stderr).not.toContain('Private handoff')
    const invalid = await ws.exec(['read', 'general', '--handoff', '--as', 'codex'])
    expect(invalid.code).not.toBe(0)
  })
})

describe('insights', () => {
  it('reads blockers from the selected channel', async () => {
    const ws = makeWorkspace()
    const opts = ['--as', 'codex', '--json']
    const created = await ws.exec(['tasks', 'create', 'general', 'Publish build', ...opts])
    expect(created.code, created.stderr).toBe(0)
    const { task } = created.json as { task: { id: string } }
    const hold = await ws.exec(['tasks', 'block', task.id, 'Awaiting sign-off', ...opts])
    expect(hold.code, hold.stderr).toBe(0)
    const report = await ws.exec(['insights', 'blockers', 'general', ...opts])
    expect(report.code, report.stderr).toBe(0)
    expect(report.json).toMatchObject({ rows: [{ id: task.id, kind: null, reason: 'Awaiting sign-off', waitingDependents: 0 }] })
  })

  it('finds an unanswered thread on the requested channel', async () => {
    const ws = makeWorkspace()
    const opts = ['--as', 'codex', '--json']
    const post = await ws.exec(['post', 'general', 'Can someone verify the output?', ...opts])
    expect(post.code, post.stderr).toBe(0)
    const report = await ws.exec(['insights', 'unanswered', 'general', '--limit', '1', ...opts])
    expect(report.code, report.stderr).toBe(0)
    expect(report.json).toMatchObject({ rows: [{ text: 'Can someone verify the output?' }] })
    expect((await ws.exec(['insights', 'unknown', 'general', ...opts])).code).not.toBe(0)
  })
})

describe('HOST-5 CLI: init --universal seed contract & idempotency', () => {
  it('seeds universal channels, repo channels, board-feedback@1, default @groups, and pinned charters idempotently', async () => {
    const ws = makeWorkspace()

    const first = await ws.exec(['init', '--universal', '--repo', 'agent-board', '--json'])
    expect(first.code, first.stderr).toBe(0)
    const data1 = first.json as {
      ok: boolean
      created: boolean
      boardId: string
      schemaVersion: number
      seed: {
        channelsCreated: string[]
        channelsExisting: string[]
        schema: { id: string; created: boolean }
        groupsCreated: string[]
        charter: { announcements: { id: string; pinned: boolean }; general: { id: string; pinned: boolean } }
      }
    }
    expect(data1.ok).toBe(true)
    expect(data1.created).toBe(true)
    expect(data1.boardId).toBeTruthy()
    expect(data1.schemaVersion).toBeGreaterThanOrEqual(5)
    expect(data1.seed.channelsCreated).toEqual(
      expect.arrayContaining([
        'general',
        'announcements',
        'decisions',
        'work/swarmboard',
        'meta/feedback',
        'ops/health',
        'repos/agent-board/general',
        'repos/agent-board/dev',
        'repos/agent-board/work',
        'repos/agent-board/decisions',
        'repos/agent-board/notes',
      ]),
    )
    expect(data1.seed.schema).toEqual({ id: 'board-feedback@1', created: true })
    expect(data1.seed.groupsCreated).toEqual(
      expect.arrayContaining([
        'all-agents',
        'reviewers',
        'claude-team',
        'codex-team',
        'agy-team',
        'opencode-team',
        'cursor-team',
        'copilot-team',
        'pi-team',
        'andrewcode-team',
      ]),
    )
    expect(data1.seed.charter.announcements.pinned).toBe(true)
    expect(data1.seed.charter.general.pinned).toBe(true)

    // Repeat run MUST be idempotent: zero duplicate charter posts, groups, or schema errors!
    const second = await ws.exec(['init', '--universal', '--repo', 'agent-board', '--json'])
    expect(second.code, second.stderr).toBe(0)
    const data2 = second.json as typeof data1
    expect(data2.created).toBe(false)
    expect(data2.seed.channelsCreated).toEqual([])
    expect(data2.seed.groupsCreated).toEqual([])
    expect(data2.seed.schema.created).toBe(false)
    expect(data2.seed.charter.announcements.id).toBe(data1.seed.charter.announcements.id)
    expect(data2.seed.charter.general.id).toBe(data1.seed.charter.general.id)

    // Verify channel tree & compact output
    const tree = await ws.exec(['channels', '--tree', '--as', 'agy'])
    expect(tree.code, tree.stderr).toBe(0)
    expect(tree.stdout).toContain('repos/')
    expect(tree.stdout).toContain('#general')
    expect(tree.stdout).toContain('#feedback')
  })
})

describe('HOST-5 CLI: social, messaging, mentions, DMs, pins, groups, presence, feedback, search', () => {
  it('exercises full messaging, thr_ IDs, quotes, attachments, flags, forum pins, and bare --mentions warning', async () => {
    const ws = makeWorkspace()
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)

    // Non-TTY without --as is rejected with 401 agent_identity_required
    const anon = await ws.exec(['me', '--json'])
    expect(anon.code).toBe(1)
    expect((anon.errorJson as { error: { code: string } }).error.code).toBe('agent_identity_required')

    // Identity check with --as agy
    const me = await ws.exec(['whoami', '--as', 'agy', '--json'])
    expect(me.code, me.stderr).toBe(0)
    expect((me.json as { profile: string; assurance: string; mode: string }).profile).toBe('agy')
    expect((me.json as { assurance: string }).assurance).toBe('agent_delegated')

    // Upload attachment + post with label and idempotency key
    const sampleFile = path.join(ws.dir, 'notes.txt')
    fs.writeFileSync(sampleFile, 'attachment body content')
    const posted = await ws.exec([
      'post',
      'dev',
      'Initial design ready @codex',
      '-l',
      'area=cli',
      '--attach',
      sampleFile,
      '--id',
      'thr_post_key_1',
      '--as',
      'agy',
      '--json',
    ])
    expect(posted.code, posted.stderr).toBe(0)
    const rootMsg = posted.json as { id: string; thread: string; labels: Record<string, string>; attachments: { id: string }[] }
    expect(rootMsg.labels['area']).toBe('cli')
    expect(rootMsg.attachments).toHaveLength(1)

    // Reply using thr_ thread ID and --quote
    const replied = await ws.exec([
      'reply',
      rootMsg.thread,
      'Looks great @agy!',
      '--quote',
      `#${rootMsg.id}`,
      '--as',
      'codex',
      '--json',
    ])
    expect(replied.code, replied.stderr).toBe(0)
    const replyMsg = replied.json as { id: string; re: string; revision: number; quote: { id: string } }
    expect(replyMsg.re).toBe(rootMsg.id)
    expect(replyMsg.quote.id).toBe(rootMsg.id)

    // Edit with exact CAS revision, react, label, flag
    const edited = await ws.exec([
      'edit',
      replyMsg.id,
      'Looks great @agy! (updated)',
      '--rev',
      String(replyMsg.revision),
      '--as',
      'codex',
      '--json',
    ])
    expect(edited.code, edited.stderr).toBe(0)
    expect((edited.json as { message: { revision: number } }).message.revision).toBeGreaterThan(replyMsg.revision)

    // Stale revision fails cleanly with revision_conflict
    const staleEdit = await ws.exec(['edit', replyMsg.id, 'stale edit', '--rev', '1', '--as', 'codex', '--json'])
    expect(staleEdit.code).toBe(1)
    expect((staleEdit.errorJson as { error: { code: string } }).error.code).toBe('revision_conflict')

    const reacted = await ws.exec(['react', rootMsg.id, 'thumbsup', '--as', 'codex', '--json'])
    expect(reacted.code, reacted.stderr).toBe(0)
    expect((await ws.exec(['react', rootMsg.id, 'thumbsup', '--remove', '--as', 'codex', '--json'])).code).toBe(0)

    const labeled = await ws.exec(['label', rootMsg.id, '--set', 'stage=review', '--if', 'area=cli', '--as', 'agy', '--json'])
    expect(labeled.code, labeled.stderr).toBe(0)
    expect((labeled.json as { message: { labels: Record<string, string> } }).message.labels['stage']).toBe('review')

    const flagged = await ws.exec(['flag', replyMsg.id, 'needs follow-up', '--feedback', '--as', 'agy', '--json'])
    expect(flagged.code, flagged.stderr).toBe(0)
    const flagRes = flagged.json as { ok: boolean; message: { labels: Record<string, string> }; feedback?: { channel: string } }
    expect(flagRes.message.labels['flag.status']).toBe('open')
    expect(flagRes.feedback?.channel).toBe('meta/feedback')

    // Read by thr_ ID in compact mode and TTY mode
    const readThr = await ws.exec(['read', rootMsg.thread, '--as', 'agy', '--compact'])
    expect(readThr.code, readThr.stderr).toBe(0)
    expect(readThr.stdout).toContain('Initial design ready')
    expect(readThr.stdout).toContain('Looks great @agy! (updated)')

    const readFlat = await ws.exec(['read', 'dev', '--flat', '--as', 'agy', '--json'])
    expect(readFlat.code, readFlat.stderr).toBe(0)
    expect((readFlat.json as { messages: unknown[] }).messages.length).toBeGreaterThanOrEqual(2)

    // Pin & forum thread ordering (sticky pinned thread comes before newer unpinned thread!)
    const newer = await ws.exec(['post', 'dev', 'Newer unpinned thread', '--as', 'agy', '--json'])
    expect(newer.code).toBe(0)
    const pinRes = await ws.exec(['pin', rootMsg.id, '--scope', 'channel', '--note', 'Sticky design', '--as', 'agy', '--json'])
    expect(pinRes.code, pinRes.stderr).toBe(0)

    const forumThreads = await ws.exec(['threads', 'dev', '--order', 'forum', '--as', 'agy', '--json'])
    expect(forumThreads.code, forumThreads.stderr).toBe(0)
    const thrList = (forumThreads.json as { threads: { message: { id: string }; pin?: { scope: string } }[] }).threads
    expect(thrList[0]!.message.id).toBe(rootMsg.id)
    expect(thrList[0]!.pin?.scope).toBe('channel')

    const pinsList = await ws.exec(['pins', 'dev', '--as', 'agy', '--json'])
    expect(pinsList.code).toBe(0)
    expect((pinsList.json as { pins: unknown[] }).pins.length).toBe(1)

    expect((await ws.exec(['unpin', rootMsg.id, '--as', 'agy', '--json'])).code).toBe(0)

    // Bare --mentions warning on threads
    const bareWarn = await ws.exec(['threads', '--mentions', 'dev', '--as', 'codex'])
    expect(bareWarn.code, bareWarn.stderr).toBe(0)
    expect(bareWarn.stderr).toMatch(/bare "--mentions" without "@"/)

    // Delete own message
    expect((await ws.exec(['delete', (newer.json as { id: string }).id, '--as', 'agy', '--json'])).code).toBe(0)
  })

  it('exercises groups, DMs, inbox, mentions, ack, presence/who, channels create/update, feedback, and search', async () => {
    const ws = makeWorkspace()
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)

    // Group management + @group notification fanout
    const grpCreate = await ws.exec([
      'group',
      'create',
      'cli-squad',
      '--name',
      'CLI Squad',
      '--members',
      'agy,codex',
      '--as',
      'agy',
      '--json',
    ])
    expect(grpCreate.code, grpCreate.stderr).toBe(0)
    expect((grpCreate.json as { handle: string }).handle).toBe('cli-squad')

    expect((await ws.exec(['group', 'add', 'cli-squad', 'claude', '--role', 'lead', '--as', 'agy', '--json'])).code).toBe(0)
    const grpShow = await ws.exec(['group', 'show', 'cli-squad', '--as', 'agy', '--json'])
    expect(grpShow.code).toBe(0)
    expect((grpShow.json as { members: unknown[] }).members).toHaveLength(3)

    expect((await ws.exec(['group', 'update', 'cli-squad', '--description', 'Updated squad', '--as', 'agy', '--json'])).code).toBe(0)
    expect((await ws.exec(['group', 'remove', 'cli-squad', 'claude', '--as', 'agy', '--json'])).code).toBe(0)
    expect((await ws.exec(['group', 'list', '--as', 'agy', '--compact'])).stdout).toContain('@cli-squad')

    // Post mentioning @cli-squad -> notifies codex!
    expect((await ws.exec(['post', 'general', 'Heads up @cli-squad: check release', '--as', 'agy', '--json'])).code).toBe(0)

    // DM between agy and codex (canonical dm/agy--codex)
    const dmSend = await ws.exec(['dm', 'codex', 'Private xyzzy99 for codex', '--as', 'agy', '--json'])
    expect(dmSend.code, dmSend.stderr).toBe(0)
    expect((dmSend.json as { channel: { path: string } }).channel.path).toBe('dm/agy--codex')

    const dmRead = await ws.exec(['dm', 'agy', '--as', 'codex', '--json'])
    expect(dmRead.code, dmRead.stderr).toBe(0)
    expect((dmRead.json as { messages: { text: string }[] }).messages[0]!.text).toContain('Private xyzzy99 for codex')

    // Third-party agent cannot see, read by ID, or search private DM between agy and codex (CF-15)
    const dmMsgId = (dmSend.json as { message: { id: string } }).message.id
    const thirdFlat = await ws.exec(['read', 'dm/agy--codex', '--flat', '--as', 'claude', '--json'])
    expect(thirdFlat.code, thirdFlat.stderr).toBe(0)
    expect((thirdFlat.json as { messages: unknown[] }).messages).toHaveLength(0)
    const thirdById = await ws.exec(['read', dmMsgId, '--as', 'claude', '--json'])
    expect(thirdById.code).toBe(1)
    expect((thirdById.errorJson as { error: { code: string } }).error.code).toBe('message_not_found')
    const thirdSearch = await ws.exec(['search', 'xyzzy99', '--as', 'claude', '--json'])
    expect(thirdSearch.code, thirdSearch.stderr).toBe(0)
    expect((thirdSearch.json as { hits: unknown[] }).hits).toHaveLength(0)
    // DM member CAN search the DM
    const memberSearch = await ws.exec(['search', 'xyzzy99', '--as', 'codex', '--json'])
    expect(memberSearch.code, memberSearch.stderr).toBe(0)
    expect((memberSearch.json as { hits: unknown[] }).hits.length).toBeGreaterThanOrEqual(1)

    // Presence set & who
    const pres = await ws.exec([
      'presence',
      'set',
      'active',
      '--channel',
      'general',
      '--note',
      'building cli',
      '--harness',
      'agy',
      '--ttl',
      '120s',
      '--as',
      'agy',
      '--json',
    ])
    expect(pres.code, pres.stderr).toBe(0)
    const who = await ws.exec(['who', '--as', 'codex', '--compact'])
    expect(who.code, who.stderr).toBe(0)
    expect(who.stdout).toMatch(/@[a-z0-9._-]+\/agy\b/)
    expect(who.stdout).toContain('building cli')

    // Inbox (1-call composite digest) + mentions + ack
    const inboxCompact = await ws.exec(['inbox', '--as', 'codex', '--compact'])
    expect(inboxCompact.code, inboxCompact.stderr).toBe(0)
    expect(inboxCompact.stdout).toContain('inbox @codex')
    expect(inboxCompact.stdout).toContain('Private xyzzy99 for codex')

    const mentions = await ws.exec(['mentions', '--as', 'codex', '--json'])
    expect(mentions.code, mentions.stderr).toBe(0)
    const notifList = (mentions.json as { notifications: { id: string; reason: string }[] }).notifications
    expect(notifList.length).toBeGreaterThanOrEqual(2)
    expect(notifList.some((n) => n.reason === 'group_mention')).toBe(true)
    expect(notifList.some((n) => n.reason === 'dm')).toBe(true)

    // Ack one notification, then ack all
    expect((await ws.exec(['ack', notifList[0]!.id, '--as', 'codex', '--json'])).code).toBe(0)
    const ackAll = await ws.exec(['ack', '--all', '--as', 'codex', '--json'])
    expect(ackAll.code, ackAll.stderr).toBe(0)
    const afterCount = await ws.exec(['mentions', '--count', '--as', 'codex', '--json'])
    expect((afterCount.json as { unread: number }).unread).toBe(0)

    // Channels create & update
    const chCreate = await ws.exec([
      'channels',
      'create',
      'custom/alerts',
      '--kind',
      'announcements',
      '--topic',
      'Alert feed',
      '--as',
      'agy',
      '--json',
    ])
    expect(chCreate.code, chCreate.stderr).toBe(0)
    expect((await ws.exec(['channels', 'update', 'custom/alerts', '--topic', 'Updated alerts', '--as', 'agy', '--json'])).code).toBe(0)

    // Feedback into meta/feedback (board-feedback@1)
    const fb = await ws.exec([
      'feedback',
      'CLI compact output feels snappy',
      '--kind',
      'ux',
      '--severity',
      'low',
      '--details',
      'Tested on macOS',
      '--as',
      'codex',
      '--json',
    ])
    expect(fb.code, fb.stderr).toBe(0)
    const fbMsg = fb.json as {
      channel: string
      labels: Record<string, string>
      blocks: { schema: string; version: number; data: Record<string, unknown> }[]
    }
    expect(fbMsg.channel).toBe('meta/feedback')
    expect(fbMsg.labels['kind']).toBe('ux')
    expect(fbMsg.labels['severity']).toBe('low')
    expect(fbMsg.labels['status']).toBe('new')
    expect(fbMsg.blocks.some((b) => b.schema === 'board-feedback' && b.version === 1)).toBe(true)

    // Stdin post with `-` + TTY color vs --no-color check
    const stdinPost = await ws.exec(['post', 'dev', '-', '--as', 'agy', '--json'], { stdin: 'from stdin pipe' })
    expect(stdinPost.code, stdinPost.stderr).toBe(0)
    expect((stdinPost.json as { text: string }).text).toBe('from stdin pipe')

    const ttyColored = await ws.exec(['read', 'dev', '--as', 'agy'], { tty: true })
    expect(ttyColored.code).toBe(0)
    expect(ttyColored.stdout).toContain('\x1b[')
    const ttyPlain = await ws.exec(['read', 'dev', '--as', 'agy', '--no-color'], { tty: true })
    expect(ttyPlain.code).toBe(0)
    expect(ttyPlain.stdout).not.toContain('\x1b[')

    // FTS5 search
    const search = await ws.exec(['search', 'snappy', '--channel', 'meta/feedback', '--as', 'agy', '--json'])
    expect(search.code, search.stderr).toBe(0)
    expect((search.json as { hits: unknown[] }).hits.length).toBeGreaterThanOrEqual(1)

    // Cleanup custom group
    expect((await ws.exec(['group', 'delete', 'cli-squad', '--as', 'agy', '--json'])).code).toBe(0)
  })
})

describe('HOST-5 CLI: tasks lifecycle, idempotent claim, and latestReply preview', () => {
  it('supports create, list with latestReply, idempotent claim, renew, release, claim --next, complete, fail, reopen, block, unblock, assign, needs, cancel', async () => {
    const ws = makeWorkspace()
    expect((await ws.exec(['init', '--universal', '--json'])).code).toBe(0)

    // Create task 1 and post a progress reply so `tasks list` shows latestReply!
    const t1Res = await ws.exec([
      'tasks',
      'create',
      'work/swarmboard',
      'Implement CLI parser',
      '-l',
      'wave=3',
      '--as',
      'agy',
      '--json',
    ])
    expect(t1Res.code, t1Res.stderr).toBe(0)
    const t1Id = (t1Res.json as { task: { id: string } }).task.id

    expect((await ws.exec(['reply', t1Id, 'Parser skeleton landed', '--as', 'agy', '--json'])).code).toBe(0)

    // `tasks list` in compact mode displays latestReply preview!
    const listed = await ws.exec(['tasks', 'list', 'work/swarmboard', '--as', 'agy', '--compact'])
    expect(listed.code, listed.stderr).toBe(0)
    expect(listed.stdout).toContain('Implement CLI parser')
    expect(listed.stdout).toContain('Parser skeleton landed')

    // Idempotent `tasks claim <id>`: claiming twice returns the exact same live claim proof!
    const claim1 = await ws.exec(['tasks', 'claim', t1Id, '--lease', '120s', '--as', 'codex', '--json'])
    expect(claim1.code, claim1.stderr).toBe(0)
    const c1 = claim1.json as { claim: { epoch: number; token: string } }

    const claim2 = await ws.exec(['tasks', 'claim', t1Id, '--as', 'codex', '--json'])
    expect(claim2.code, claim2.stderr).toBe(0)
    const c2 = claim2.json as { claim: { epoch: number; token: string } }
    expect(c2.claim.epoch).toBe(c1.claim.epoch)
    expect(c2.claim.token).toBe(c1.claim.token)

    // Cross-agent claim cache isolation: sibling agent `agy` MUST NOT read or use `codex`'s cached bearer token!
    const stealAttempt = await ws.exec(['tasks', 'complete', t1Id, 'STOLEN', '--as', 'agy', '--json'])
    expect(stealAttempt.code).toBe(1)
    expect((stealAttempt.errorJson as { error: { code: string } }).error.code).toBe('claim_not_held')

    // Renew & complete WITHOUT explicitly passing --epoch/--token (loaded from codex's isolated claim cache!)
    expect((await ws.exec(['tasks', 'renew', t1Id, '--lease', '180s', '--as', 'codex', '--json'])).code).toBe(0)
    const comp = await ws.exec(['tasks', 'complete', t1Id, 'all parser tests green', '--as', 'codex', '--json'])
    expect(comp.code, comp.stderr).toBe(0)
    expect((comp.json as { task: { task: { state: string } } }).task.task.state).toBe('completed')

    // Create task 2 -> claim --next -> fail -> reopen -> block -> unblock -> assign -> release -> cancel
    const t2Res = await ws.exec(['tasks', 'create', 'work/swarmboard', 'Verify docs', '--as', 'agy', '--json'])
    expect(t2Res.code).toBe(0)
    const t2Id = (t2Res.json as { task: { id: string } }).task.id

    const claimNext = await ws.exec(['tasks', 'claim', '--next', 'work/swarmboard', '--as', 'codex', '--json'])
    expect(claimNext.code, claimNext.stderr).toBe(0)
    expect((claimNext.json as { task: { id: string } }).task.id).toBe(t2Id)

    expect((await ws.exec(['tasks', 'fail', t2Id, 'transient flake', '--as', 'codex', '--json'])).code).toBe(0)
    expect((await ws.exec(['tasks', 'reopen', t2Id, '--as', 'agy', '--json'])).code).toBe(0)
    expect((await ws.exec(['tasks', 'block', t2Id, 'waiting for human', '--kind', 'review', '--as', 'agy', '--json'])).code).toBe(0)
    expect((await ws.exec(['tasks', 'unblock', t2Id, '--as', 'agy', '--json'])).code).toBe(0)
    const meAgy = await ws.exec(['me', '--as', 'codex', '--json'])
    const codexActorId = (meAgy.json as { actor: string }).actor
    expect((await ws.exec(['tasks', 'assign', t2Id, codexActorId, '--as', 'agy', '--json'])).code).toBe(0)
    expect((await ws.exec(['tasks', 'assign', t2Id, '--pool', '--as', 'agy', '--json'])).code).toBe(0)

    // Needs + batch creation
    const t3Res = await ws.exec(['tasks', 'create', 'work/swarmboard', 'Dependent task', '--as', 'agy', '--json'])
    const t3Id = (t3Res.json as { task: { id: string } }).task.id
    expect((await ws.exec(['tasks', 'needs', t3Id, t2Id, '--as', 'agy', '--json'])).code).toBe(0)
    expect((await ws.exec(['tasks', 'needs', t3Id, '--none', '--as', 'agy', '--json'])).code).toBe(0)

    // Claim + release + cancel
    expect((await ws.exec(['tasks', 'claim', t2Id, '--as', 'codex', '--json'])).code).toBe(0)
    expect((await ws.exec(['tasks', 'release', t2Id, '--as', 'codex', '--json'])).code).toBe(0)
    expect((await ws.exec(['tasks', 'cancel', t2Id, 'superseded', '--as', 'agy', '--json'])).code).toBe(0)
    expect((await ws.exec(['tasks', 'get', t2Id, '--as', 'agy', '--compact'])).stdout).toContain('Verify docs')

    // Promote an existing thread to a task via `--re` and create a batch via `--file`
    const plain = await ws.exec(['post', 'work/swarmboard', 'Promote me to task', '--as', 'agy', '--json'])
    const plainId = (plain.json as { id: string }).id
    const promoted = await ws.exec(['tasks', 'create', '--re', plainId, '--as', 'agy', '--json'])
    expect(promoted.code, promoted.stderr).toBe(0)
    expect((promoted.json as { task: { task: { state: string } } }).task.task.state).toBe('ready')

    const batchFile = path.join(ws.dir, 'batch.json')
    fs.writeFileSync(batchFile, JSON.stringify([{ key: 'a', text: 'Batch A' }, { key: 'b', text: 'Batch B', needs: [{ key: 'a' }] }]))
    const batchRes = await ws.exec(['tasks', 'create', 'work/swarmboard', '--file', batchFile, '--as', 'agy', '--json'])
    expect(batchRes.code, batchRes.stderr).toBe(0)
    expect((batchRes.json as { tasks: unknown[] }).tasks).toHaveLength(2)

    // CLI-F2 regression: `tasks claim <thread-uuid>` -> idempotent claim -> `renew` -> `complete <thread-uuid>`
    // uses thread-UUID reverse lookup in claim cache, AND `claim_lost` evicts stale proof!
    const tUuidRes = await ws.exec(['tasks', 'create', 'work/swarmboard', 'Thread UUID task', '--as', 'agy', '--json'])
    expect(tUuidRes.code, tUuidRes.stderr).toBe(0)
    const { id: tUuidId, thread: tUuid } = (tUuidRes.json as { task: { id: string; thread: string } }).task

    const claimUuid1 = await ws.exec(['tasks', 'claim', tUuid, '--as', 'codex', '--json'])
    expect(claimUuid1.code, claimUuid1.stderr).toBe(0)
    const claimUuid2 = await ws.exec(['tasks', 'claim', tUuid, '--as', 'codex', '--json'])
    expect(claimUuid2.code, claimUuid2.stderr).toBe(0)
    expect((claimUuid2.json as { claim: { token: string } }).claim.token).toBe(
      (claimUuid1.json as { claim: { token: string } }).claim.token,
    )
    expect((await ws.exec(['tasks', 'renew', tUuid, '--lease', '180s', '--as', 'codex', '--json'])).code).toBe(0)
    const compUuid = await ws.exec(['tasks', 'complete', tUuid, 'done via uuid', '--as', 'codex', '--json'])
    expect(compUuid.code, compUuid.stderr).toBe(0)
    expect((compUuid.json as { task: { id: string; task: { state: string } } }).task.id).toBe(tUuidId)
    expect((compUuid.json as { task: { task: { state: string } } }).task.task.state).toBe('completed')

    // Stale cached proof eviction on `409 claim_lost` (task canceled by owner while worker still holds cached proof)
    const tEvictRes = await ws.exec(['tasks', 'create', 'work/swarmboard', 'Stale proof task', '--as', 'agy', '--json'])
    const tEvictId = (tEvictRes.json as { task: { id: string } }).task.id
    expect((await ws.exec(['tasks', 'claim', tEvictId, '--as', 'codex', '--json'])).code).toBe(0)
    expect((await ws.exec(['tasks', 'cancel', tEvictId, 'aborted by owner', '--as', 'agy', '--json'])).code).toBe(0)
    const staleComplete = await ws.exec(['tasks', 'complete', tEvictId, 'late', '--as', 'codex', '--json'])
    expect(staleComplete.code).toBe(1)
    expect((staleComplete.errorJson as { error: { code: string } }).error.code).toBe('claim_lost')
    // Second attempt sees the proof was evicted -> `claim_not_held`
    const afterEvict = await ws.exec(['tasks', 'complete', tEvictId, 'late2', '--as', 'codex', '--json'])
    expect(afterEvict.code).toBe(1)
    expect((afterEvict.errorJson as { error: { code: string } }).error.code).toBe('claim_not_held')
  })
})
