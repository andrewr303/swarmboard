// Multi-harness swarm CLI commands: `swarmboard swarm <init|brief|status>`.
// Boundary: thin CLI layer — imports only `../../client/**`, `../args.ts`, `../bridge.ts`, `../output.ts`.
import { clientError } from '../../client/errors.ts'
import { formatPresenceLine } from '../../client/format.ts'
import {
  buildSwarmBriefs,
  buildWorkerProfiles,
  getSwarmStatus,
  initSwarmRun,
  isSwarmHarness,
  SWARM_BRIEF_FORMATS,
  SWARM_HARNESSES,
  type SwarmHarness,
} from '../../client/swarm.ts'
import {
  canonicalTaskKey,
  getBoolFlag,
  getStringFlag,
  getStringListFlag,
  looksLikeMessageRef,
  parseCommandArgs,
  parseIntFlag,
  splitCsvValues,
} from '../args.ts'
import type { CliBridgeContext, CliHostBridge, CliIo } from '../bridge.ts'
import { EXIT_OK, type Formatter } from '../output.ts'

export interface SwarmCommandEnv {
  readonly bridge: CliHostBridge
  readonly bridgeCtx: CliBridgeContext
  readonly fmt: Formatter
  readonly io: CliIo
}

function parseHarnessFlag(raw: string | undefined): SwarmHarness {
  if (raw === undefined) return 'mixed'
  if (!isSwarmHarness(raw)) {
    throw clientError(
      'invalid_request',
      `--harness must be one of ${SWARM_HARNESSES.join(', ')} (got "${raw}")`,
    )
  }
  return raw
}

export async function cmdSwarm(ctx: SwarmCommandEnv, args: readonly string[]): Promise<number> {
  const sub = args[0]
  if (!sub || sub.startsWith('-')) {
    throw clientError('invalid_request', 'usage: swarmboard swarm <init|brief|status> <run-id> [options]')
  }
  const subArgs = args.slice(1)

  switch (sub) {
    case 'init':
      return cmdSwarmInit(ctx, subArgs)
    case 'brief':
      return cmdSwarmBrief(ctx, subArgs)
    case 'status':
      return cmdSwarmStatus(ctx, subArgs)
    default:
      throw clientError('invalid_request', `unknown swarm subcommand "${sub}" (expected init, brief, or status)`)
  }
}

async function cmdSwarmInit(ctx: SwarmCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    harness: { kind: 'string' },
    workers: { kind: 'string', short: 'w' },
    prefix: { kind: 'string' },
    lead: { kind: 'string' },
    repo: { kind: 'string' },
    topic: { kind: 'string' },
    blind: { kind: 'boolean' },
    kickoff: { kind: 'boolean' },
    'skill-path': { kind: 'string' },
  })
  const runId = parsed.positionals[0]
  if (!runId) {
    throw clientError(
      'invalid_request',
      'usage: swarmboard swarm init <run-id> [--harness <h>] [--workers N] [--prefix <p>] [--lead <p>] [--repo <slug>] [--topic <t>] [--blind] [--kickoff]',
    )
  }

  const harness = parseHarnessFlag(getStringFlag(parsed.flags, 'harness'))
  const workersCount = parseIntFlag(getStringFlag(parsed.flags, 'workers'), 'workers', { min: 1, max: 32 })
  const prefix = getStringFlag(parsed.flags, 'prefix')
  const lead = getStringFlag(parsed.flags, 'lead')
  const repo = getStringFlag(parsed.flags, 'repo')
  const topic = getStringFlag(parsed.flags, 'topic')
  const blind = getBoolFlag(parsed.flags, 'blind') === true
  const kickoff = getBoolFlag(parsed.flags, 'kickoff') === true
  const skillPath = getStringFlag(parsed.flags, 'skill-path')

  const client = await ctx.bridge.connect(ctx.bridgeCtx)
  try {
    const result = await initSwarmRun(
      client,
      {
        runId,
        harness,
        ...(workersCount !== undefined ? { workersCount } : {}),
        ...(prefix !== undefined ? { prefix } : {}),
        ...(lead !== undefined ? { lead } : {}),
        ...(repo !== undefined ? { repo } : {}),
        ...(topic !== undefined ? { topic } : {}),
        blind,
        kickoff,
        ...(skillPath !== undefined ? { skillPath } : {}),
      },
      ctx.io.signal ? { signal: ctx.io.signal } : undefined,
    )

    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json(result)
      return EXIT_OK
    }

    ctx.fmt.line(
      `Swarm "${result.runId}" ready (${result.harnessLabel}) — group @${result.group} [${result.groupStatus}]`,
    )
    ctx.fmt.line(
      `Channels: #${result.channels.general}, #${result.channels.work}, #${result.channels.log} (created=${result.channelsCreated.length} existing=${result.channelsExisting.length})`,
    )
    ctx.fmt.line(`Lead: @${result.lead} | Workers: ${result.workers.map(w => `@${w}`).join(', ')}`)
    if (result.kickoffMessageId) ctx.fmt.line(`Kickoff pinned: #${result.kickoffMessageId}`)
    ctx.fmt.line('')
    ctx.fmt.line(result.leadBrief)
    ctx.fmt.line('')
    ctx.fmt.line(result.workerTemplate)
    return EXIT_OK
  } finally {
    await client.close()
  }
}

async function cmdSwarmBrief(ctx: SwarmCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    harness: { kind: 'string' },
    worker: { kind: 'string' },
    workers: { kind: 'string', short: 'w' },
    prefix: { kind: 'string' },
    lead: { kind: 'string' },
    task: { kind: 'string[]' },
    peers: { kind: 'string[]' },
    topic: { kind: 'string' },
    blind: { kind: 'boolean' },
    'skill-path': { kind: 'string' },
    role: { kind: 'string' },
    format: { kind: 'string' },
  })
  const runId = parsed.positionals[0]
  if (!runId) {
    throw clientError(
      'invalid_request',
      'usage: swarmboard swarm brief <run-id> [--harness <h>] [--worker <p> | --workers N] [--lead <p>] [--task <id>] [--peers a,b] [--topic <t>] [--blind] [--role lead|worker|all]',
    )
  }

  const format = getStringFlag(parsed.flags, 'format') ?? (ctx.fmt.mode === 'json' ? 'json' : 'text')
  if (!SWARM_BRIEF_FORMATS.some(value => value === format)) {
    throw clientError('invalid_request', `--format must be one of ${SWARM_BRIEF_FORMATS.join(', ')}`)
  }
  if (ctx.fmt.mode === 'json' && format !== 'json' && format !== 'andrewcode-json') {
    throw clientError('invalid_request', '--json requires a JSON output format')
  }
  const nativeHarness = { 'codex-toml': 'codex', 'claude-agent': 'claude-teams', 'andrewcode-json': 'andrewcode-swarm' } as const
  const harness = parseHarnessFlag(getStringFlag(parsed.flags, 'harness') ?? (
    format === 'codex-toml' || format === 'claude-agent' || format === 'andrewcode-json' ? nativeHarness[format] : undefined
  ))
  const worker = getStringFlag(parsed.flags, 'worker')?.replace(/^@/, '')
  const workersCount = parseIntFlag(getStringFlag(parsed.flags, 'workers'), 'workers', { min: 1, max: 32 })
  const prefix = getStringFlag(parsed.flags, 'prefix')
  const lead = getStringFlag(parsed.flags, 'lead') ?? (typeof ctx.bridgeCtx.flags.as === 'string' ? ctx.bridgeCtx.flags.as : undefined)
  if (worker !== undefined && (workersCount !== undefined || prefix !== undefined)) {
    throw clientError('invalid_request', 'choose --worker for a named worker or --workers and --prefix for generated profiles')
  }
  const taskIds = getStringListFlag(parsed.flags, 'task').map(ref => {
    if (!looksLikeMessageRef(ref)) throw clientError('invalid_request', `invalid --task reference "${ref}"`)
    return canonicalTaskKey(ref)
  })
  const peers = splitCsvValues(getStringListFlag(parsed.flags, 'peers'))
  const topic = getStringFlag(parsed.flags, 'topic')
  const blind = getBoolFlag(parsed.flags, 'blind') === true
  const skillPath = getStringFlag(parsed.flags, 'skill-path')
  const roleFile = format === 'codex-toml' || format === 'claude-agent'
  const role = getStringFlag(parsed.flags, 'role') ?? (worker || roleFile || format === 'andrewcode-json' ? 'worker' : 'all')
  if (role !== 'lead' && role !== 'worker' && role !== 'all') {
    throw clientError('invalid_request', '--role must be "lead", "worker", or "all"')
  }

  const workersList = worker !== undefined ? [worker] : buildWorkerProfiles(
    runId, harness, workersCount ?? (roleFile && role === 'worker' ? 1 : 3), prefix,
  )
  if (roleFile && (role === 'all' || (role === 'worker' && workersList.length !== 1))) {
    throw clientError('invalid_request', 'an agent definition describes one role: use --worker <profile> or --role lead')
  }
  if (format === 'andrewcode-json') {
    if (workersList.length < 2 || role !== 'worker') {
      throw clientError('invalid_request', 'AgentSwarm requires at least two worker items')
    }
    if (taskIds.length > 0 && new Set(taskIds).size !== workersList.length) {
      throw clientError('invalid_request', 'assign a distinct --task to each AgentSwarm worker or omit --task for a shared queue')
    }
  }

  const bundle = buildSwarmBriefs({
    runId,
    harness,
    ...(lead !== undefined ? { lead } : {}),
    workers: workersList,
    taskIds,
    ...(peers.length > 0 ? { peers } : {}),
    ...(topic !== undefined ? { topic } : {}),
    blind,
    ...(skillPath !== undefined ? { skillPath } : {}),
  })

  if (format === 'andrewcode-json') {
    ctx.fmt.json({
      description: topic?.trim() || `Swarmboard run ${bundle.runId}`,
      prompt_template: '{{item}}',
      items: bundle.workerBriefs.map(item => item.brief),
    })
    return EXIT_OK
  }
  if (roleFile) {
    const profile = role === 'lead' ? bundle.lead : workersList[0]!
    const instructions = role === 'lead' ? bundle.leadBrief : bundle.workerBriefs[0]!.brief
    const name = JSON.stringify(profile.toLowerCase())
    const description = JSON.stringify(`Swarmboard ${role} for run ${bundle.runId} (@${profile}).`)
    if (format === 'codex-toml') {
      // TOML basic strings accept JSON escapes, but also require DEL to be escaped.
      const quoted = JSON.stringify(instructions.toWellFormed()).replaceAll('\u007f', '\\u007f')
      ctx.fmt.line(`name = ${name}\ndescription = ${description}\ndeveloper_instructions = ${quoted}`)
    } else {
      ctx.fmt.line(`---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}`)
    }
    return EXIT_OK
  }
  if (format === 'json') {
    ctx.fmt.json(bundle)
    return EXIT_OK
  }

  if (role !== 'worker') ctx.fmt.line(bundle.leadBrief)
  if (role === 'all') ctx.fmt.line('')
  if (role !== 'lead') {
    ctx.fmt.line(worker || taskIds.length > 1 ? bundle.workerBriefs.map(item => item.brief).join('\n\n') : bundle.workerTemplate)
  }
  return EXIT_OK
}

async function cmdSwarmStatus(ctx: SwarmCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    limit: { kind: 'string', short: 'n' },
    repo: { kind: 'string' },
    channel: { kind: 'string' },
  })
  const runId = parsed.positionals[0]
  if (!runId) {
    throw clientError('invalid_request', 'usage: swarmboard swarm status <run-id> [--repo <slug> | --channel <path>] [--limit N]')
  }
  const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 100 })

  const client = await ctx.bridge.connect(ctx.bridgeCtx)
  try {
    const status = await getSwarmStatus(
      client,
      runId,
      { limit, repo: getStringFlag(parsed.flags, 'repo'), channel: getStringFlag(parsed.flags, 'channel') },
      ctx.io.signal ? { signal: ctx.io.signal } : undefined,
    )

    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json(status)
      return EXIT_OK
    }

    const progressRows = status.progress.view === 'progress' ? status.progress.rows : []
    const blockers = status.blockers.view === 'blockers' ? status.blockers.rows : []
    const unanswered = status.unanswered.view === 'unanswered' ? status.unanswered.rows : []

    ctx.fmt.line(
      `Swarm "${status.runId}" — group @${status.group.handle} (${status.group.exists ? `${status.group.members.length} members` : 'not created'}) | online=${status.onlinePeers.length}`,
    )
    if (progressRows.length > 0) {
      const totals = { total: 0, ready: 0, claimed: 0, blocked: 0, waiting: 0, completed: 0, failed: 0, canceled: 0 }
      for (const row of progressRows) {
        totals.total += Number(row['total'] ?? 0)
        totals.ready += Number(row['ready'] ?? 0)
        totals.claimed += Number(row['claimed'] ?? 0)
        totals.blocked += Number(row['blocked'] ?? 0)
        totals.waiting += Number(row['waiting'] ?? 0)
        totals.completed += Number(row['completed'] ?? 0)
        totals.failed += Number(row['failed'] ?? 0)
        totals.canceled += Number(row['canceled'] ?? 0)
      }
      ctx.fmt.line(
        `Tasks (#${status.channels.work}): total=${totals.total} ready=${totals.ready} claimed=${totals.claimed} blocked=${totals.blocked} waiting=${totals.waiting} completed=${totals.completed} failed=${totals.failed}${totals.canceled > 0 ? ` canceled=${totals.canceled}` : ''}`,
      )
      if (progressRows.length > 1) {
        for (const row of progressRows) {
          ctx.fmt.line(
            `  phase[${String(row['phase'] ?? 'Unassigned')}]: total=${Number(row['total'] ?? 0)} ready=${Number(row['ready'] ?? 0)} claimed=${Number(row['claimed'] ?? 0)} blocked=${Number(row['blocked'] ?? 0)} completed=${Number(row['completed'] ?? 0)}`,
          )
        }
      }
    } else {
      ctx.fmt.line(`Tasks (#${status.channels.work}): none`)
    }
    if (status.progress.coverage.truncated || status.progress.coverage.rowsTruncated) {
      ctx.fmt.line('Partial task totals: the report reached its scan or phase limit.')
    }
    if (blockers.length > 0) {
      ctx.fmt.line(`Blockers (${blockers.length}):`)
      for (const b of blockers) {
        const waitingDeps = Number(b['waitingDependents'] ?? 0)
        const depNote = waitingDeps > 0 ? ` (blocks ${status.blockers.coverage.truncated ? 'at least ' : ''}${waitingDeps} waiting)` : ''
        const kind = typeof b['kind'] === 'string' && b['kind'] ? b['kind'] : 'blocked'
        const reason = typeof b['reason'] === 'string' && b['reason'] ? b['reason'] : '(no reason)'
        ctx.fmt.line(`  #${String(b['id'] ?? '?')} [${kind}]${depNote}: ${reason}`)
      }
    }
    if (unanswered.length > 0) {
      ctx.fmt.line(`Unanswered threads in #${status.channels.general} (${unanswered.length}):`)
      for (const u of unanswered) {
        ctx.fmt.line(`  #${String(u['id'] ?? '?')} by=${String(u['actor'] ?? u['by'] ?? '?')}: ${String(u['text'] ?? '')}`)
      }
    }
    if (status.onlinePeers.length > 0) {
      ctx.fmt.line('Online peers:')
      for (const p of status.onlinePeers) {
        ctx.fmt.line(`  ${formatPresenceLine(p)}`)
      }
    }
    return EXIT_OK
  } finally {
    await client.close()
  }
}
