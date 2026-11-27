// Multi-harness lifecycle hook CLI commands: `swarmboard hook <brief|rewake|snippet>`.
// Boundary: thin CLI layer — imports only `../../client/**`, `../args.ts`, `../bridge.ts`, `../output.ts`, Node stdlib.
import type { BoardClient } from '../../client/client.ts'
import { clientError, isBoardError } from '../../client/errors.ts'
import {
  buildHookBriefSummary,
  buildHookSnippet,
  buildRewakeNotificationsMessage,
  buildRewakeReadyTasksMessage,
  claimRewakeWaiter,
  HOOK_SNIPPET_HARNESSES,
  isHookSnippetHarness,
  parseHookStdin,
  readHookSessionState,
  resolveHookSessionKey,
  resolveHookStateDir,
  shouldSkipHook,
  writeHookSessionState,
  type HookStdinPayload,
} from '../../client/hooks.ts'
import type { Env } from '../../client/resolve.ts'
import {
  getBoolFlag,
  getStringFlag,
  parseCommandArgs,
  parseDurationSeconds,
} from '../args.ts'
import type { CliBridgeContext, CliHostBridge, CliIo } from '../bridge.ts'
import { EXIT_HOOK_WAKE, EXIT_OK, type Formatter } from '../output.ts'

export interface HookCommandEnv {
  readonly bridge: CliHostBridge
  readonly bridgeCtx: CliBridgeContext
  readonly fmt: Formatter
  readonly io: CliIo
  readonly env: Env
}

async function readOptionalHookStdin(io: CliIo, noStdin: boolean): Promise<HookStdinPayload> {
  if (noStdin || io.stdinIsTTY) return {}
  try {
    const raw = await io.readStdin()
    return parseHookStdin(raw)
  } catch {
    return {}
  }
}

async function withHookClient(
  ctx: HookCommandEnv,
  strict: boolean,
  outcome: 'emitted' | 'woke',
  run: (client: BoardClient) => Promise<number>,
): Promise<number> {
  let client: BoardClient | undefined
  try {
    client = await ctx.bridge.connect(ctx.bridgeCtx)
    return await run(client)
  } catch (err) {
    if (strict || (client && !(isBoardError(err) && err.status === 503))) throw err
    if (ctx.fmt.mode === 'json') ctx.fmt.json({ [outcome]: false, skipped: 'unavailable' })
    return EXIT_OK
  } finally {
    await client?.close()
  }
}

export async function cmdHook(ctx: HookCommandEnv, args: readonly string[]): Promise<number> {
  const sub = args[0]
  if (!sub || sub.startsWith('-')) {
    throw clientError('invalid_request', 'usage: swarmboard hook <brief|rewake|snippet> [options]')
  }
  const subArgs = args.slice(1)

  switch (sub) {
    case 'brief':
      return cmdHookBrief(ctx, subArgs)
    case 'rewake':
    case 'stop':
    case 'idle':
      return cmdHookRewake(ctx, subArgs)
    case 'snippet':
    case 'config':
      return cmdHookSnippet(ctx, subArgs)
    default:
      throw clientError('invalid_request', `unknown hook subcommand "${sub}" (expected brief, rewake, or snippet)`)
  }
}

async function cmdHookBrief(ctx: HookCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    seed: { kind: 'boolean' },
    session: { kind: 'string' },
    channel: { kind: 'string' },
    urgent: { kind: 'boolean' },
    'state-dir': { kind: 'string' },
    'include-subagents': { kind: 'boolean' },
    'no-stdin': { kind: 'boolean' },
    strict: { kind: 'boolean' },
  })
  const seed = getBoolFlag(parsed.flags, 'seed') === true
  const explicitSession = getStringFlag(parsed.flags, 'session')
  const channel = getStringFlag(parsed.flags, 'channel')
  const urgent = getBoolFlag(parsed.flags, 'urgent') === true
  const stateDir = resolveHookStateDir(ctx.env, getStringFlag(parsed.flags, 'state-dir'))
  const includeSubagents = getBoolFlag(parsed.flags, 'include-subagents') === true
  const noStdin = getBoolFlag(parsed.flags, 'no-stdin') === true
  const strict = getBoolFlag(parsed.flags, 'strict') === true

  const payload = await readOptionalHookStdin(ctx.io, noStdin)
  const skipReason = shouldSkipHook(ctx.env, payload, { isStopHook: false, includeSubagents })
  if (skipReason !== null) {
    if (ctx.fmt.mode === 'json') ctx.fmt.json({ emitted: false, skipped: skipReason })
    return EXIT_OK
  }

  return withHookClient(ctx, strict, 'emitted', async client => {
    const inbox = await client.agentInbox({
      notificationsLimit: 20,
      tasksLimit: 10,
      includeReadyPool: false,
      ...(urgent ? { urgentOnly: true } : {}),
      ...(channel !== undefined ? { channel } : {}),
    })
    const brief = buildHookBriefSummary(inbox)
    const sessionKey = resolveHookSessionKey(explicitSession, payload, ctx.bridgeCtx.cwd)
    const scopeParts = [client.caps.boardId ?? 'local', inbox.actor, channel ?? '*', urgent ? 'urgent' : 'all', sessionKey]
    const prev = readHookSessionState(stateDir, scopeParts)

    writeHookSessionState(stateDir, scopeParts, {
      fingerprint: brief.fingerprint,
      cursor: brief.cursor,
      updatedAt: new Date().toISOString(),
    })

    if (seed) {
      if (ctx.fmt.mode === 'json') {
        ctx.fmt.json({ seeded: true, emitted: false, ...brief })
      }
      return EXIT_OK
    }

    const unchanged = prev !== null && prev.fingerprint === brief.fingerprint
    if (!brief.hasItems || unchanged || brief.summary === null) {
      if (ctx.fmt.mode === 'json') {
        ctx.fmt.json({
          emitted: false,
          unchanged,
          ...brief,
        })
      }
      return EXIT_OK
    }

    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json({ emitted: true, unchanged: false, ...brief })
    } else {
      ctx.fmt.line(brief.summary)
    }
    return EXIT_OK
  })
}

async function cmdHookRewake(ctx: HookCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    timeout: { kind: 'string' },
    channel: { kind: 'string' },
    'ready-channel': { kind: 'string' },
    urgent: { kind: 'boolean' },
    session: { kind: 'string' },
    'state-dir': { kind: 'string' },
    'allow-reentry': { kind: 'boolean' },
    'include-subagents': { kind: 'boolean' },
    'no-stdin': { kind: 'boolean' },
    strict: { kind: 'boolean' },
  })

  const timeoutS = parseDurationSeconds(getStringFlag(parsed.flags, 'timeout'), 'timeout') ?? 0
  const channel = getStringFlag(parsed.flags, 'channel')
  const readyChannel = getStringFlag(parsed.flags, 'ready-channel')
  const urgent = getBoolFlag(parsed.flags, 'urgent') === true
  const explicitSession = getStringFlag(parsed.flags, 'session')
  const stateDir = resolveHookStateDir(ctx.env, getStringFlag(parsed.flags, 'state-dir'))
  const allowReentry = getBoolFlag(parsed.flags, 'allow-reentry') === true
  const includeSubagents = getBoolFlag(parsed.flags, 'include-subagents') === true
  const noStdin = getBoolFlag(parsed.flags, 'no-stdin') === true
  const strict = getBoolFlag(parsed.flags, 'strict') === true

  const payload = await readOptionalHookStdin(ctx.io, noStdin)
  const skipReason = shouldSkipHook(ctx.env, payload, {
    isStopHook: true,
    allowReentry,
    includeSubagents,
  })
  if (skipReason !== null) {
    if (ctx.fmt.mode === 'json') ctx.fmt.json({ woke: false, skipped: skipReason })
    return EXIT_OK
  }

  return withHookClient(ctx, strict, 'woke', async client => {
    const me = await client.me()
    const sessionKey = resolveHookSessionKey(explicitSession, payload, ctx.bridgeCtx.cwd)
    const waiterScope = [client.caps.boardId ?? 'local', me.actor, sessionKey]
    // Always claim the waiter slot (even for timeoutS === 0) so a newer hook invocation
    // immediately supersedes any older long-polling waiter for the same session scope.
    const waiter = claimRewakeWaiter(stateDir, waiterScope)

    const abortController = new AbortController()
    const onOuterAbort = () => abortController.abort()
    if (ctx.io.signal) {
      if (ctx.io.signal.aborted) abortController.abort()
      else ctx.io.signal.addEventListener('abort', onOuterAbort, { once: true })
    }

    let superseded = false
    let pollTimer: ReturnType<typeof setInterval> | null = null
    if (timeoutS > 0) {
      pollTimer = setInterval(() => {
        if (waiter.superseded()) {
          superseded = true
          abortController.abort()
        }
      }, 200)
      pollTimer.unref()
    }

    const emitSuperseded = (): number => {
      if (ctx.fmt.mode === 'json') ctx.fmt.json({ woke: false, reason: 'superseded' })
      return EXIT_OK
    }

    const emitNotificationsWake = (page: Awaited<ReturnType<typeof client.notifications.wait>>): number => {
      const wake = buildRewakeNotificationsMessage(page, me.profile)
      if (ctx.fmt.mode === 'json') {
        ctx.fmt.json({
          woke: true,
          reason: 'notifications',
          count: page.notifications.length,
          unread: page.unread,
          urgent: page.urgent,
          cursor: page.cursor,
          senders: wake.senders,
          channels: wake.channels,
          messageIds: wake.messageIds,
          message: wake.message,
        })
      } else {
        ctx.io.stderr(`${wake.message}\n`)
      }
      return EXIT_HOOK_WAKE
    }

    const checkReadyChannel = async (): Promise<number | null> => {
      if (readyChannel === undefined) return null
      // claim --next considers this worker's assignments and its principal's unassigned pool.
      const callOpts = { signal: abortController.signal }
      const [assigned, inbox] = await Promise.all([
        client.tasks.list({ channel: readyChannel, state: 'ready', for: me.actor, owner: me.principal, limit: 10 }, callOpts),
        client.agentInbox({ channel: readyChannel, includeReadyPool: true, tasksLimit: 10, notificationsLimit: 1 }, callOpts),
      ])
      if (superseded || waiter.superseded()) return emitSuperseded()
      const taskIds = [...new Set([...assigned.tasks.map(t => t.message.id), ...inbox.tasks.ready.map(t => t.id)])].slice(0, 10)
      if (taskIds.length === 0) return null
      const msg = buildRewakeReadyTasksMessage(readyChannel, taskIds, me.profile)
      if (ctx.fmt.mode === 'json') {
        ctx.fmt.json({
          woke: true,
          reason: 'ready_tasks',
          channel: readyChannel,
          count: taskIds.length,
          taskIds,
          cursor: inbox.cursor,
          message: msg,
        })
      } else {
        ctx.io.stderr(`${msg}\n`)
      }
      return EXIT_HOOK_WAKE
    }

    const waitQueryBase = {
      unreadOnly: true,
      ...(channel !== undefined ? { channel } : {}),
      ...(urgent ? { priority: 'urgent' as const } : {}),
    }

    try {
      // Check both sources before a long wait. A notification-only wait already returns immediately on unread mail.
      const waits = readyChannel !== undefined && timeoutS > 0 ? [0, timeoutS] : [timeoutS]
      let cursor: string = ''
      for (const wait of waits) {
        const page = await client.notifications.wait({ ...waitQueryBase, wait }, { signal: abortController.signal })
        cursor = page.cursor
        if (superseded || waiter.superseded()) return emitSuperseded()
        if (page.notifications.length > 0) return emitNotificationsWake(page)
        const ready = await checkReadyChannel()
        if (ready !== null) return ready
      }
      if (ctx.fmt.mode === 'json') {
        ctx.fmt.json({ woke: false, reason: 'quiet', cursor })
      }
      return EXIT_OK
    } catch (err) {
      if (superseded || waiter.superseded()) return emitSuperseded()
      throw err
    } finally {
      if (pollTimer !== null) clearInterval(pollTimer)
      if (ctx.io.signal) ctx.io.signal.removeEventListener('abort', onOuterAbort)
    }
  })
}

async function cmdHookSnippet(ctx: HookCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    channel: { kind: 'string' },
    'ready-channel': { kind: 'string' },
    timeout: { kind: 'string' },
    async: { kind: 'boolean', aliases: ['async-rewake'] },
  })
  const rawHarness = parsed.positionals[0]
  if (!isHookSnippetHarness(rawHarness)) {
    throw clientError(
      'invalid_request',
      `usage: swarmboard hook snippet <${HOOK_SNIPPET_HARNESSES.join('|')}> [--as <profile>] [--channel <ch>] [--ready-channel <ch>] [--timeout 0s] [--async]`,
    )
  }

  const res = buildHookSnippet({
    harness: rawHarness,
    ...(typeof ctx.bridgeCtx.flags.as === 'string' ? { profile: ctx.bridgeCtx.flags.as } : {}),
    ...(getStringFlag(parsed.flags, 'channel') !== undefined ? { channel: getStringFlag(parsed.flags, 'channel') } : {}),
    ...(getStringFlag(parsed.flags, 'ready-channel') !== undefined
      ? { readyChannel: getStringFlag(parsed.flags, 'ready-channel') }
      : {}),
    ...(getStringFlag(parsed.flags, 'timeout') !== undefined ? { timeout: getStringFlag(parsed.flags, 'timeout') } : {}),
    asyncRewake: getBoolFlag(parsed.flags, 'async') === true,
  })

  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
    return EXIT_OK
  }
  ctx.io.stdout(res.snippet)
  return EXIT_OK
}
