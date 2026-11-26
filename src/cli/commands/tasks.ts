// Full `swarmboard tasks` command surface with idempotent `claim`, claim proof caching,
// and `latestReply` preview in `list` (Swarmboard v2 launch design §3.2).
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import type { ClaimedTask, TaskInBatch } from '../../client/client.ts'
import { ClientError, clientError, isBoardError } from '../../client/errors.ts'
import type { TaskState } from '../../core/public.ts'
import {
  getBoolFlag,
  getStringFlag,
  getStringListFlag,
  parseCommandArgs,
  parseDurationSeconds,
  parseIntFlag,
  parseLabelRecord,
  splitCsvValues,
} from '../args.ts'
import { claimBoardKey, deleteCachedClaim, loadCachedClaim, resolveClaimActor, saveCachedClaim } from '../claims.ts'
import { EXIT_OK, renderMessage, renderTasksPage, renderThread } from '../output.ts'
import type { CommandEnv } from './social.ts'

const TASK_SUBCOMMANDS = new Set([
  'list',
  'get',
  'show',
  'create',
  'batch',
  'claim',
  'renew',
  'release',
  'complete',
  'fail',
  'block',
  'unblock',
  'reopen',
  'assign',
  'needs',
  'cancel',
])

const TASK_STATES: ReadonlySet<string> = new Set([
  'open',
  'all',
  'waiting',
  'ready',
  'claimed',
  'blocked',
  'completed',
  'failed',
  'canceled',
])

async function resolveProof(
  ctx: CommandEnv,
  actor: string,
  taskId: string,
  explicitEpoch: number | undefined,
  explicitToken: string | undefined,
): Promise<{ readonly epoch: number; readonly token: string } | null> {
  if ((explicitEpoch === undefined) !== (explicitToken === undefined)) {
    throw clientError('invalid_request', 'pass both --epoch and --token together, or omit both to use cached claim proof')
  }
  if (explicitEpoch !== undefined && explicitToken !== undefined) {
    return { epoch: explicitEpoch, token: explicitToken }
  }
  const boardKey = claimBoardKey(ctx.client)
  const cached = loadCachedClaim(boardKey, actor, taskId, ctx.env)
  return cached ? { epoch: cached.epoch, token: cached.token } : null
}

async function requireProof(
  ctx: CommandEnv,
  actor: string,
  taskId: string,
  explicitEpoch: number | undefined,
  explicitToken: string | undefined,
): Promise<{ readonly epoch: number; readonly token: string }> {
  const proof = await resolveProof(ctx, actor, taskId, explicitEpoch, explicitToken)
  if (!proof) {
    throw new ClientError(
      409,
      'claim_not_held',
      `no cached claim proof for task #${taskId}: claim it first or pass --epoch and --token`,
    )
  }
  return proof
}

const CLAIM_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/** Mints a 32-byte base64url (43-char) caller claim token accepted by ClaimTaskBody / ClaimReadyTaskBody. */
function mintClaimToken(): string {
  return randomBytes(32).toString('base64url')
}

function serializeClaimed(claimed: ClaimedTask) {
  return {
    task: claimed.task,
    claim: {
      epoch: claimed.epoch,
      token: claimed.token,
      until: claimed.until,
    },
  }
}

export async function cmdTasks(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const first = args[0]
  const sub = first !== undefined && TASK_SUBCOMMANDS.has(first) ? first : 'list'
  const subArgs = first !== undefined && TASK_SUBCOMMANDS.has(first) ? args.slice(1) : args

  switch (sub) {
    case 'list':
      return tasksList(ctx, subArgs)
    case 'get':
    case 'show':
      return tasksGet(ctx, subArgs)
    case 'create':
      return tasksCreate(ctx, subArgs)
    case 'batch':
      return tasksBatch(ctx, subArgs)
    case 'claim':
      return tasksClaim(ctx, subArgs)
    case 'renew':
      return tasksRenew(ctx, subArgs)
    case 'release':
      return tasksRelease(ctx, subArgs)
    case 'complete':
      return tasksComplete(ctx, subArgs)
    case 'fail':
      return tasksFail(ctx, subArgs)
    case 'block':
      return tasksBlock(ctx, subArgs)
    case 'unblock':
      return tasksUnblock(ctx, subArgs)
    case 'reopen':
      return tasksReopen(ctx, subArgs)
    case 'assign':
      return tasksAssign(ctx, subArgs)
    case 'needs':
      return tasksNeeds(ctx, subArgs)
    case 'cancel':
      return tasksCancel(ctx, subArgs)
    default:
      throw clientError('invalid_request', `unknown tasks subcommand "${sub}"`)
  }
}

async function tasksList(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    state: { kind: 'string' },
    label: { kind: 'string[]', short: 'l' },
    by: { kind: 'string' },
    owner: { kind: 'string' },
    for: { kind: 'string' },
    needs: { kind: 'string' },
    after: { kind: 'string' },
    limit: { kind: 'string', short: 'n' },
    latest: { kind: 'boolean' },
  })
  const channel = parsed.positionals[0]
  const state = getStringFlag(parsed.flags, 'state')
  if (state !== undefined && !TASK_STATES.has(state)) {
    throw clientError('invalid_request', `--state must be one of ${[...TASK_STATES].join(', ')}`)
  }
  const labels = getStringListFlag(parsed.flags, 'label')
  const by = getStringFlag(parsed.flags, 'by')
  const owner = getStringFlag(parsed.flags, 'owner')
  const forActor = getStringFlag(parsed.flags, 'for')
  const needs = getStringFlag(parsed.flags, 'needs')
  const after = getStringFlag(parsed.flags, 'after')
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 500 })
  const latest = getBoolFlag(parsed.flags, 'latest')

  const page = await ctx.client.tasks.list({
    ...(channel !== undefined ? { channel } : {}),
    ...(state !== undefined ? { state: state as 'open' | 'all' | TaskState } : {}),
    ...(labels.length > 0 ? { label: [...labels] } : {}),
    ...(by !== undefined ? { by } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(forActor !== undefined ? { for: forActor } : {}),
    ...(needs !== undefined ? { needs } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(latest ? { latest: true } : {}),
  })
  renderTasksPage(ctx.fmt, page)
  return EXIT_OK
}

async function tasksGet(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    limit: { kind: 'string', short: 'n' },
    after: { kind: 'string' },
  })
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard tasks get <id>')
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 500 })
  const after = getStringFlag(parsed.flags, 'after')
  const thread = await ctx.client.thread(id, {
    ...(limit !== undefined ? { limit } : {}),
    ...(after !== undefined ? { after } : {}),
  })
  renderThread(ctx.fmt, thread)
  return EXIT_OK
}

async function tasksCreate(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    re: { kind: 'string' },
    label: { kind: 'string[]', short: 'l' },
    for: { kind: 'string' },
    needs: { kind: 'string[]' },
    claim: { kind: 'boolean' },
    lease: { kind: 'string' },
    token: { kind: 'string' },
    id: { kind: 'string', aliases: ['idempotency-key'] },
    'no-sync': { kind: 'boolean' },
    file: { kind: 'string' },
  })
  const re = getStringFlag(parsed.flags, 're')
  const forActor = getStringFlag(parsed.flags, 'for')
  const needs = splitCsvValues(getStringListFlag(parsed.flags, 'needs'))
  const claim = getBoolFlag(parsed.flags, 'claim') === true
  const leaseS = parseDurationSeconds(getStringFlag(parsed.flags, 'lease'), 'lease')
  const explicitToken = getStringFlag(parsed.flags, 'token')
  const claimToken = claim ? (explicitToken ?? mintClaimToken()) : explicitToken
  const id = getStringFlag(parsed.flags, 'id')
  const noSync = getBoolFlag(parsed.flags, 'no-sync')
  const filePath = getStringFlag(parsed.flags, 'file')

  if (re !== undefined) {
    const res = await ctx.client.tasks.create(
      { re },
      {
        ...(forActor !== undefined ? { for: forActor } : {}),
        ...(needs.length > 0 ? { needs } : {}),
        ...(claim ? { claim: true } : {}),
        ...(leaseS !== undefined ? { lease: Math.round(leaseS) } : {}),
        ...(claimToken !== undefined ? { token: claimToken } : {}),
      },
    )
    if (res.claim) {
      const actor = await resolveClaimActor(ctx.client)
      saveCachedClaim(
        claimBoardKey(ctx.client),
        actor,
        res.task.id,
        { ...res.claim, thread: res.task.thread },
        ctx.env,
      )
    }
    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json({
        task: res.task,
        ...(res.claim ? { claim: { epoch: res.claim.epoch, token: res.claim.token, until: res.claim.until } } : {}),
      })
    } else {
      renderMessage(ctx.fmt, res.task, false)
    }
    return EXIT_OK
  }

  const channel = parsed.positionals[0]
  if (!channel) throw clientError('invalid_request', 'usage: swarmboard tasks create <channel> <text> | --re <id>')

  // Batch JSON creation when `--file` contains a JSON array of tasks
  if (filePath !== undefined) {
    const raw = filePath === '-' ? await ctx.io.readStdin() : fs.readFileSync(filePath, 'utf8')
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      throw clientError('invalid_request', `--file must contain valid JSON`)
    }
    const batchList = Array.isArray(parsedJson)
      ? parsedJson
      : parsedJson && typeof parsedJson === 'object' && Array.isArray((parsedJson as { tasks?: unknown }).tasks)
        ? (parsedJson as { tasks: unknown[] }).tasks
        : null
    if (!batchList) {
      throw clientError('invalid_request', '--file must be a JSON array of tasks or { "tasks": [...] }')
    }
    const created = await ctx.client.tasks.createMany(
      channel,
      batchList as TaskInBatch[],
      id !== undefined ? { id } : undefined,
    )
    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json({ tasks: created })
    } else {
      for (const t of created) renderMessage(ctx.fmt, t, false)
    }
    return EXIT_OK
  }

  const text = parsed.positionals.slice(1).join(' ').trim()
  if (!text) throw clientError('invalid_request', 'tasks create requires task text')
  const labels = parseLabelRecord(getStringListFlag(parsed.flags, 'label'))

  const res = await ctx.client.tasks.create(channel, {
    text,
    ...(labels ? { labels } : {}),
    ...(forActor !== undefined ? { for: forActor } : {}),
    ...(needs.length > 0 ? { needs } : {}),
    ...(claim ? { claim: true } : {}),
    ...(leaseS !== undefined ? { lease: Math.round(leaseS) } : {}),
    ...(claimToken !== undefined ? { token: claimToken } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(noSync ? { noSync: true } : {}),
  })
  if (res.claim) {
    const actor = await resolveClaimActor(ctx.client)
    saveCachedClaim(
      claimBoardKey(ctx.client),
      actor,
      res.task.id,
      { ...res.claim, thread: res.task.thread },
      ctx.env,
    )
  }
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json({
      task: res.task,
      ...(res.claim ? { claim: { epoch: res.claim.epoch, token: res.claim.token, until: res.claim.until } } : {}),
    })
  } else {
    const suffix = res.claim ? ` (claimed epoch=${res.claim.epoch} until=${res.claim.until})` : ''
    ctx.fmt.line(`created task #${res.task.id} [${res.task.channel}]${suffix}`)
  }
  return EXIT_OK
}

async function tasksBatch(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    request: { kind: 'string' },
  })
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard tasks batch <batch-id> [--request <digest>]')
  const request = getStringFlag(parsed.flags, 'request')
  const tasks = await ctx.client.tasks.batch(id, request !== undefined ? { request } : undefined)
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json({ tasks })
  } else {
    for (const t of tasks) renderMessage(ctx.fmt, t, false)
  }
  return EXIT_OK
}

async function tasksClaim(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    next: { kind: 'string', aliases: ['ready'] },
    wait: { kind: 'string' },
    lease: { kind: 'string' },
    label: { kind: 'string[]', short: 'l' },
    from: { kind: 'string[]' },
    token: { kind: 'string' },
  })
  const nextChannel = getStringFlag(parsed.flags, 'next')
  const taskId = parsed.positionals[0]
  const leaseS = parseDurationSeconds(getStringFlag(parsed.flags, 'lease'), 'lease')
  const explicitToken = getStringFlag(parsed.flags, 'token')
  const boardKey = claimBoardKey(ctx.client)
  const actor = await resolveClaimActor(ctx.client)

  if (nextChannel !== undefined) {
    if (taskId !== undefined) throw clientError('conflicting_options', 'pass either <id> or --next <channel>, not both')
    const waitS = parseDurationSeconds(getStringFlag(parsed.flags, 'wait'), 'wait')
    const labels = parseLabelRecord(getStringListFlag(parsed.flags, 'label'))
    const from = splitCsvValues(getStringListFlag(parsed.flags, 'from'))
    const callOpts = ctx.io.signal ? { signal: ctx.io.signal } : undefined
    const readyToken = explicitToken ?? mintClaimToken()
    const claimed = await ctx.client.tasks.claim(
      {
        channel: nextChannel,
        ...(labels ? { label: labels } : {}),
        ...(from.length > 0 ? { from } : {}),
        ...(waitS !== undefined ? { wait: waitS } : {}),
        ...(leaseS !== undefined ? { lease: Math.round(leaseS) } : {}),
        token: readyToken,
      },
      callOpts,
    )
    if (!claimed) {
      throw new ClientError(
        waitS !== undefined && waitS > 0 ? 408 : 404,
        waitS !== undefined && waitS > 0 ? 'timeout' : 'nothing_ready',
        waitS !== undefined && waitS > 0
          ? `no ready task in ${nextChannel} before timeout`
          : `no ready task in ${nextChannel}`,
      )
    }
    saveCachedClaim(boardKey, actor, claimed.task.id, { ...claimed, thread: claimed.task.thread }, ctx.env)
    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json(serializeClaimed(claimed))
    } else {
      ctx.fmt.line(
        `claimed #${claimed.task.id} [${claimed.task.channel}] epoch=${claimed.epoch} until=${claimed.until}`,
      )
    }
    return EXIT_OK
  }

  if (!taskId) {
    throw clientError('invalid_request', 'usage: swarmboard tasks claim <id> | swarmboard tasks claim --next <channel> [--wait N]')
  }

  // Idempotent claim: reuse cached 43-char claim proof token (or mint a fresh 43-char token on first claim)
  // so re-running `tasks claim <id>` returns the live claim cleanly without double-claiming or 409!
  const cached = loadCachedClaim(boardKey, actor, taskId, ctx.env)
  const cachedToken = cached && CLAIM_TOKEN_RE.test(cached.token) ? cached.token : undefined
  const token = explicitToken ?? cachedToken ?? mintClaimToken()
  const claimed = await ctx.client.tasks.claim(taskId, {
    ...(leaseS !== undefined ? { lease: Math.round(leaseS) } : {}),
    token,
  })
  saveCachedClaim(boardKey, actor, claimed.task.id, { ...claimed, thread: claimed.task.thread }, ctx.env)
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(serializeClaimed(claimed))
  } else {
    ctx.fmt.line(`claimed #${claimed.task.id} [${claimed.task.channel}] epoch=${claimed.epoch} until=${claimed.until}`)
  }
  return EXIT_OK
}

async function runWithClaimEviction<T>(
  ctx: CommandEnv,
  actor: string,
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isBoardError(err) && err.code === 'claim_lost') {
      deleteCachedClaim(claimBoardKey(ctx.client), actor, taskId, ctx.env)
    }
    throw err
  }
}

async function tasksRenew(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    lease: { kind: 'string' },
    epoch: { kind: 'string' },
    token: { kind: 'string' },
  })
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard tasks renew <id> [--lease 5m]')
  const leaseS = parseDurationSeconds(getStringFlag(parsed.flags, 'lease'), 'lease')
  const actor = await resolveClaimActor(ctx.client)
  const proof = await requireProof(
    ctx,
    actor,
    id,
    parseIntFlag(getStringFlag(parsed.flags, 'epoch'), 'epoch', { min: 1 }),
    getStringFlag(parsed.flags, 'token'),
  )
  const renewed = await runWithClaimEviction(ctx, actor, id, () =>
    ctx.client.tasks.held(id, proof).renew(leaseS !== undefined ? Math.round(leaseS) : undefined),
  )
  saveCachedClaim(
    claimBoardKey(ctx.client),
    actor,
    renewed.task.id,
    { ...renewed, thread: renewed.task.thread },
    ctx.env,
  )
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(serializeClaimed(renewed))
  } else {
    ctx.fmt.line(`renewed #${renewed.task.id} epoch=${renewed.epoch} until=${renewed.until}`)
  }
  return EXIT_OK
}

async function tasksRelease(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    epoch: { kind: 'string' },
    token: { kind: 'string' },
  })
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard tasks release <id>')
  const actor = await resolveClaimActor(ctx.client)
  const proof = await requireProof(
    ctx,
    actor,
    id,
    parseIntFlag(getStringFlag(parsed.flags, 'epoch'), 'epoch', { min: 1 }),
    getStringFlag(parsed.flags, 'token'),
  )
  const task = await runWithClaimEviction(ctx, actor, id, () => ctx.client.tasks.held(id, proof).release())
  deleteCachedClaim(claimBoardKey(ctx.client), actor, task.id, ctx.env, task.thread)
  if (ctx.fmt.mode === 'json') ctx.fmt.json({ task })
  else ctx.fmt.line(`released #${task.id} state=${task.task?.state ?? 'ready'}`)
  return EXIT_OK
}

async function tasksComplete(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    epoch: { kind: 'string' },
    token: { kind: 'string' },
  })
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard tasks complete <id> [result]')
  const result = parsed.positionals.length > 1 ? parsed.positionals.slice(1).join(' ') : undefined
  const actor = await resolveClaimActor(ctx.client)
  const proof = await requireProof(
    ctx,
    actor,
    id,
    parseIntFlag(getStringFlag(parsed.flags, 'epoch'), 'epoch', { min: 1 }),
    getStringFlag(parsed.flags, 'token'),
  )
  const task = await runWithClaimEviction(ctx, actor, id, () => ctx.client.tasks.held(id, proof).complete(result))
  deleteCachedClaim(claimBoardKey(ctx.client), actor, task.id, ctx.env, task.thread)
  if (ctx.fmt.mode === 'json') ctx.fmt.json({ task })
  else ctx.fmt.line(`completed #${task.id}`)
  return EXIT_OK
}

async function tasksFail(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    epoch: { kind: 'string' },
    token: { kind: 'string' },
  })
  const id = parsed.positionals[0]
  const reason = parsed.positionals.slice(1).join(' ').trim()
  if (!id || !reason) throw clientError('invalid_request', 'usage: swarmboard tasks fail <id> <reason>')
  const actor = await resolveClaimActor(ctx.client)
  const proof = await requireProof(
    ctx,
    actor,
    id,
    parseIntFlag(getStringFlag(parsed.flags, 'epoch'), 'epoch', { min: 1 }),
    getStringFlag(parsed.flags, 'token'),
  )
  const task = await runWithClaimEviction(ctx, actor, id, () => ctx.client.tasks.held(id, proof).fail(reason))
  deleteCachedClaim(claimBoardKey(ctx.client), actor, task.id, ctx.env, task.thread)
  if (ctx.fmt.mode === 'json') ctx.fmt.json({ task })
  else ctx.fmt.line(`failed #${task.id}: ${reason}`)
  return EXIT_OK
}

async function tasksBlock(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    kind: { kind: 'string' },
    epoch: { kind: 'string' },
    token: { kind: 'string' },
  })
  const id = parsed.positionals[0]
  const reason = parsed.positionals.slice(1).join(' ').trim()
  if (!id || !reason) throw clientError('invalid_request', 'usage: swarmboard tasks block <id> <reason> [--kind <k>]')
  const kind = getStringFlag(parsed.flags, 'kind')
  const actor = await resolveClaimActor(ctx.client)
  const proof = await resolveProof(
    ctx,
    actor,
    id,
    parseIntFlag(getStringFlag(parsed.flags, 'epoch'), 'epoch', { min: 1 }),
    getStringFlag(parsed.flags, 'token'),
  )
  const task = await runWithClaimEviction(ctx, actor, id, () =>
    proof
      ? ctx.client.tasks.held(id, proof).block(reason, kind !== undefined ? { kind } : undefined)
      : ctx.client.tasks.block(id, reason, kind !== undefined ? { kind } : undefined),
  )
  deleteCachedClaim(claimBoardKey(ctx.client), actor, task.id, ctx.env, task.thread)
  if (ctx.fmt.mode === 'json') ctx.fmt.json({ task })
  else ctx.fmt.line(`blocked #${task.id}: ${reason}`)
  return EXIT_OK
}

async function tasksUnblock(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {})
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard tasks unblock <id>')
  const task = await ctx.client.tasks.unblock(id)
  if (ctx.fmt.mode === 'json') ctx.fmt.json({ task })
  else ctx.fmt.line(`unblocked #${task.id} state=${task.task?.state ?? 'ready'}`)
  return EXIT_OK
}

async function tasksReopen(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {})
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard tasks reopen <id>')
  const task = await ctx.client.tasks.reopen(id)
  if (ctx.fmt.mode === 'json') ctx.fmt.json({ task })
  else ctx.fmt.line(`reopened #${task.id} state=${task.task?.state ?? 'ready'}`)
  return EXIT_OK
}

async function tasksAssign(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    pool: { kind: 'boolean' },
  })
  const id = parsed.positionals[0]
  const pool = getBoolFlag(parsed.flags, 'pool') === true
  const actor = parsed.positionals[1]
  if (!id || (!pool && !actor)) {
    throw clientError('invalid_request', 'usage: swarmboard tasks assign <id> <actor> | swarmboard tasks assign <id> --pool')
  }
  const task = await ctx.client.tasks.assign(id, pool ? null : actor!)
  if (ctx.fmt.mode === 'json') ctx.fmt.json({ task })
  else ctx.fmt.line(`assigned #${task.id} for=${task.task?.for ?? 'pool'}`)
  return EXIT_OK
}

async function tasksNeeds(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    none: { kind: 'boolean' },
  })
  const id = parsed.positionals[0]
  const none = getBoolFlag(parsed.flags, 'none') === true
  const deps = splitCsvValues(parsed.positionals.slice(1))
  if (!id || (!none && deps.length === 0)) {
    throw clientError('invalid_request', 'usage: swarmboard tasks needs <id> <dep...> | swarmboard tasks needs <id> --none')
  }
  const task = await ctx.client.tasks.needs(id, none ? [] : deps)
  if (ctx.fmt.mode === 'json') ctx.fmt.json({ task })
  else ctx.fmt.line(`updated needs #${task.id} needs=[${(task.task?.needs ?? []).join(',')}]`)
  return EXIT_OK
}

async function tasksCancel(ctx: CommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {})
  const id = parsed.positionals[0]
  const reason = parsed.positionals.slice(1).join(' ').trim()
  if (!id || !reason) throw clientError('invalid_request', 'usage: swarmboard tasks cancel <id> <reason>')
  const actor = await resolveClaimActor(ctx.client)
  const task = await ctx.client.tasks.cancel(id, reason)
  deleteCachedClaim(claimBoardKey(ctx.client), actor, task.id, ctx.env, task.thread)
  if (ctx.fmt.mode === 'json') ctx.fmt.json({ task })
  else ctx.fmt.line(`canceled #${task.id}: ${reason}`)
  return EXIT_OK
}
