// Lifecycle & operational CLI commands: `init`, `doctor`, `backup`, `tick`, `serve`, `daemon`, `open`, `token`
// (Swarmboard v2 launch design §3.2, §6.2–§6.3).
import { clientError } from '../../client/errors.ts'
import type { Permission } from '../../core/public.ts'
import {
  getBoolFlag,
  getStringFlag,
  getStringListFlag,
  parseCommandArgs,
  parseDurationSeconds,
  parseIntFlag,
  splitCsvValues,
} from '../args.ts'
import type { CliBridgeContext, CliHostBridge, CliIo } from '../bridge.ts'
import { EXIT_OK, renderDoctor, renderTokenRecords, type Formatter } from '../output.ts'
import { seedRepoChannels, seedUniversalBoard } from '../seed.ts'

export interface OpsCommandEnv {
  readonly bridge: CliHostBridge
  readonly bridgeCtx: CliBridgeContext
  readonly fmt: Formatter
  readonly io: CliIo
}

const VALID_PERMISSIONS: ReadonlySet<string> = new Set(['read', 'post', 'react', 'label', 'sync', 'manage'])
const VALID_SCOPES: ReadonlySet<string> = new Set(['local', 'lan', 'remote'])

export async function cmdInit(ctx: OpsCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    universal: { kind: 'boolean' },
    repo: { kind: 'string[]' },
    'link-bin': { kind: 'boolean' },
  })
  const universal = getBoolFlag(parsed.flags, 'universal') === true
  const repos = splitCsvValues(getStringListFlag(parsed.flags, 'repo'))
  const linkBin = getBoolFlag(parsed.flags, 'link-bin') === true

  const opened = await ctx.bridge.openForInit(ctx.bridgeCtx)
  try {
    let universalSummary: Awaited<ReturnType<typeof seedUniversalBoard>> | undefined
    let repoSummary: { readonly created: string[]; readonly existing: string[] } | undefined

    if (universal) {
      universalSummary = await seedUniversalBoard(opened.client, { repos })
    } else if (repos.length > 0) {
      repoSummary = await seedRepoChannels(opened.client, repos)
    }

    let linkResult: { readonly linked: readonly string[]; readonly note?: string } | undefined
    if (linkBin) {
      if (ctx.bridge.linkBin) {
        linkResult = await ctx.bridge.linkBin(ctx.bridgeCtx)
      } else {
        linkResult = { linked: [], note: 'binary linking is unavailable in this environment' }
      }
    }

    const result = {
      ok: true,
      db: opened.db,
      created: opened.created,
      boardId: opened.boardId,
      instanceId: opened.instanceId,
      schemaVersion: opened.schemaVersion,
      mode: opened.mode,
      universal,
      ...(universalSummary ? { seed: universalSummary } : {}),
      ...(repoSummary ? { repoChannels: repoSummary } : {}),
      ...(linkResult ? { linkBin: linkResult } : {}),
    }

    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json(result)
    } else {
      const target = opened.db ?? ':memory:'
      ctx.fmt.line(
        `initialized board ${target} (boardId=${opened.boardId ?? 'n/a'} schema=v${opened.schemaVersion}${universal ? ' universal=true' : ''})`,
      )
      if (universalSummary) {
        ctx.fmt.line(
          `seeded channels=${universalSummary.channelsCreated.length} new/${universalSummary.channelsExisting.length} existing, schema=${universalSummary.schema.id}, groups=${universalSummary.groupsCreated.length} new/${universalSummary.groupsExisting.length} existing, charter=#${universalSummary.charter.announcements.id}/#${universalSummary.charter.general.id}`,
        )
      } else if (repoSummary) {
        ctx.fmt.line(`repo channels: ${repoSummary.created.length} created, ${repoSummary.existing.length} existing`)
      }
      if (linkResult && linkResult.linked.length > 0) {
        ctx.fmt.line(`linked: ${linkResult.linked.join(', ')}`)
      }
    }
    return EXIT_OK
  } finally {
    await opened.client.close()
  }
}

export async function cmdDoctor(ctx: OpsCommandEnv, args: readonly string[]): Promise<number> {
  parseCommandArgs(args, {})
  const report = await ctx.bridge.doctor(ctx.bridgeCtx)
  renderDoctor(ctx.fmt, report)
  return EXIT_OK
}

export async function cmdBackup(ctx: OpsCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    force: { kind: 'boolean' },
  })
  const dest = parsed.positionals[0]
  if (!dest) throw clientError('invalid_request', 'usage: swarmboard backup <dest.db> [--force]')
  const force = getBoolFlag(parsed.flags, 'force') === true
  const res = await ctx.bridge.backup(ctx.bridgeCtx, dest, { force })
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else {
    ctx.fmt.line(
      `backup ok: ${res.destDb} (${res.bytes} bytes, integrity=${res.integrityOk ? 'ok' : 'failed'}, jsonl=${res.jsonlCopied ? 'copied' : 'none'})`,
    )
  }
  return EXIT_OK
}

export async function cmdTick(ctx: OpsCommandEnv, args: readonly string[]): Promise<number> {
  parseCommandArgs(args, {})
  const report = await ctx.bridge.runTickOnce(ctx.bridgeCtx)
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(report)
  } else {
    const sent = report.schedules?.sent.length ?? 0
    const expired = report.claims?.expired.length ?? 0
    ctx.fmt.line(`tick outcome=${report.outcome} schedules.sent=${sent} claims.expired=${expired}`)
  }
  return EXIT_OK
}

export async function cmdServe(ctx: OpsCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    host: { kind: 'string' },
    port: { kind: 'string' },
    'no-idle-exit': { kind: 'boolean' },
    open: { kind: 'boolean' },
    'tailscale-host': { kind: 'string' },
    'allow-host': { kind: 'string[]' },
  })
  const host = getStringFlag(parsed.flags, 'host') ?? '127.0.0.1'
  const port = parseIntFlag(getStringFlag(parsed.flags, 'port'), 'port', { min: 1, max: 65535 }) ?? 4180
  const noIdleExit = getBoolFlag(parsed.flags, 'no-idle-exit') === true
  const open = getBoolFlag(parsed.flags, 'open') === true
  const tailscaleHost = getStringFlag(parsed.flags, 'tailscale-host')
  const allowHosts = splitCsvValues(getStringListFlag(parsed.flags, 'allow-host'))

  if (tailscaleHost !== undefined && allowHosts.length > 0) {
    throw clientError(
      'conflicting_options',
      '--tailscale-host and --allow-host are mutually exclusive',
    )
  }

  const res = await ctx.bridge.serve(ctx.bridgeCtx, {
    host,
    port,
    noIdleExit,
    open,
    ...(tailscaleHost !== undefined ? { tailscaleHost } : {}),
    ...(allowHosts.length > 0 ? { allowHosts } : {}),
    ...(ctx.io.signal ? { signal: ctx.io.signal } : {}),
    onReady: (info) => {
      if (ctx.fmt.mode === 'json') {
        ctx.fmt.json({ ready: true, ...info })
      } else {
        ctx.fmt.line(
          `swarmboard serving ${info.url}${info.socketPath ? ` (uds: ${info.socketPath})` : ''} boardId=${info.boardId ?? 'n/a'} mode=${info.mode}`,
        )
      }
    },
  })

  if (ctx.fmt.mode === 'json' && res.stopped) {
    ctx.fmt.json(res)
  }
  return EXIT_OK
}

export async function cmdDaemon(ctx: OpsCommandEnv, args: readonly string[]): Promise<number> {
  const action = args[0]
  if (
    action !== 'start' &&
    action !== 'stop' &&
    action !== 'status' &&
    action !== 'restart' &&
    action !== 'logs'
  ) {
    throw clientError('invalid_request', 'usage: swarmboard daemon <start|stop|status|restart|logs>')
  }

  const parsed = parseCommandArgs(args.slice(1), {
    tcp: { kind: 'boolean' },
    host: { kind: 'string' },
    port: { kind: 'string' },
    'no-idle-exit': { kind: 'boolean' },
    lines: { kind: 'string', short: 'n' },
  })
  const tcp = getBoolFlag(parsed.flags, 'tcp')
  const host = getStringFlag(parsed.flags, 'host')
  const port = parseIntFlag(getStringFlag(parsed.flags, 'port'), 'port', { min: 1, max: 65535 })
  const noIdleExit = getBoolFlag(parsed.flags, 'no-idle-exit')
  const lines = parseIntFlag(getStringFlag(parsed.flags, 'lines'), 'lines', { min: 1, max: 5000 })

  const res = await ctx.bridge.daemonControl(ctx.bridgeCtx, {
    action,
    ...(tcp !== undefined ? { tcp } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(noIdleExit !== undefined ? { noIdleExit } : {}),
    ...(lines !== undefined ? { lines } : {}),
  })

  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
    return EXIT_OK
  }

  if (action === 'logs') {
    for (const line of res.logs ?? []) ctx.fmt.line(line)
    if (!res.logs || res.logs.length === 0) ctx.fmt.line('(no daemon logs)')
    return EXIT_OK
  }

  const st = res.status
  if (st) {
    ctx.fmt.line(
      `daemon ${action}: running=${st.running}${st.pid ? ` pid=${st.pid}` : ''}${st.socketPath ? ` sock=${st.socketPath}` : ''}${st.tcpUrl ? ` tcp=${st.tcpUrl}` : ''}${res.message ? ` — ${res.message}` : ''}`,
    )
  } else {
    ctx.fmt.line(`daemon ${action}: ok=${res.ok}${res.message ? ` — ${res.message}` : ''}`)
  }
  return EXIT_OK
}

export async function cmdOpen(ctx: OpsCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    port: { kind: 'string' },
    host: { kind: 'string' },
    'no-browser': { kind: 'boolean' },
  })
  const host = getStringFlag(parsed.flags, 'host') ?? '127.0.0.1'
  const port = parseIntFlag(getStringFlag(parsed.flags, 'port'), 'port', { min: 1, max: 65535 }) ?? 4180
  const noBrowser = getBoolFlag(parsed.flags, 'no-browser') === true

  const res = await ctx.bridge.openUi(ctx.bridgeCtx, { host, port, noBrowser })
  if (ctx.fmt.mode === 'json') {
    // Keep one-time login URL out of stdout unless caller explicitly requested --no-browser.
    const { loginUrl, ...safe } = res
    ctx.fmt.json(noBrowser && loginUrl ? { ...safe, loginUrl } : safe)
  } else {
    ctx.fmt.line(`Command Center UI: ${res.url}${res.opened ? ' (opened in browser)' : ''}`)
    if (noBrowser && res.loginUrl) {
      ctx.fmt.line(`one-time login (60s): ${res.loginUrl}`)
    }
  }
  return EXIT_OK
}

export async function cmdToken(ctx: OpsCommandEnv, args: readonly string[]): Promise<number> {
  const sub = args[0]
  if (sub !== 'issue' && sub !== 'list' && sub !== 'revoke') {
    throw clientError('invalid_request', 'usage: swarmboard token <issue|list|revoke>')
  }

  if (sub === 'issue') {
    const parsed = parseCommandArgs(args.slice(1), {
      profile: { kind: 'string' },
      cap: { kind: 'string[]' },
      can: { kind: 'string[]' },
      scope: { kind: 'string', aliases: ['listener-scope'] },
      ttl: { kind: 'string' },
      note: { kind: 'string' },
    })
    const profile = getStringFlag(parsed.flags, 'profile')
    const rawCap = splitCsvValues(getStringListFlag(parsed.flags, 'cap'))
    let cap: Permission[] | undefined
    if (rawCap.length > 0) {
      for (const p of rawCap) {
        if (!VALID_PERMISSIONS.has(p)) {
          throw clientError('invalid_request', `unknown permission "${p}" in --cap (allowed: ${[...VALID_PERMISSIONS].join(', ')})`)
        }
      }
      cap = rawCap as Permission[]
    }
    const rawCan = getStringListFlag(parsed.flags, 'can')
    const can = rawCan.length > 0 ? rawCan.join(';') : undefined
    const scope = getStringFlag(parsed.flags, 'scope')
    if (scope !== undefined && !VALID_SCOPES.has(scope)) {
      throw clientError('invalid_request', '--scope must be local, lan, or remote')
    }
    const ttlS = parseDurationSeconds(getStringFlag(parsed.flags, 'ttl'), 'ttl')
    const note = getStringFlag(parsed.flags, 'note')

    const issued = await ctx.bridge.tokenIssue(ctx.bridgeCtx, {
      ...(profile !== undefined ? { profile } : {}),
      ...(cap !== undefined ? { cap } : {}),
      ...(can !== undefined ? { can } : {}),
      ...(scope !== undefined ? { listenerScope: scope as 'local' | 'lan' | 'remote' } : {}),
      ...(ttlS !== undefined ? { ttlS: Math.round(ttlS) } : {}),
      ...(note !== undefined ? { note } : {}),
    })
    if (ctx.fmt.mode === 'json') {
      ctx.fmt.json(issued)
    } else {
      ctx.fmt.line(issued.token)
      ctx.fmt.warn(
        `issued ${issued.record.id} profile=${issued.record.profile ?? '(principal)'} scope=${issued.record.listenerScope} exp=${issued.record.expiresAt ?? 'never'} (shown once; store safely)`,
      )
    }
    return EXIT_OK
  }

  if (sub === 'list') {
    const parsed = parseCommandArgs(args.slice(1), {
      all: { kind: 'boolean' },
      'include-revoked': { kind: 'boolean' },
      'include-expired': { kind: 'boolean' },
      limit: { kind: 'string', short: 'n' },
    })
    const all = getBoolFlag(parsed.flags, 'all') === true
    const includeRevoked = all || getBoolFlag(parsed.flags, 'include-revoked') === true
    const includeExpired = all || getBoolFlag(parsed.flags, 'include-expired') === true
    const limit = parseIntFlag(getStringFlag(parsed.flags, 'limit'), 'limit', { min: 1, max: 1000 })
    const records = await ctx.bridge.tokenList(ctx.bridgeCtx, {
      includeRevoked,
      includeExpired,
      ...(limit !== undefined ? { limit } : {}),
    })
    renderTokenRecords(ctx.fmt, records)
    return EXIT_OK
  }

  // revoke
  const parsed = parseCommandArgs(args.slice(1), {})
  const id = parsed.positionals[0]
  if (!id) throw clientError('invalid_request', 'usage: swarmboard token revoke <id>')
  const res = await ctx.bridge.tokenRevoke(ctx.bridgeCtx, id)
  if (ctx.fmt.mode === 'json') {
    ctx.fmt.json(res)
  } else {
    ctx.fmt.line(`revoked ${res.record.id} at=${res.record.revokedAt ?? 'now'}`)
  }
  return EXIT_OK
}

export async function cmdSetup(ctx: OpsCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    'dry-run': { kind: 'boolean' },
    'skip-init': { kind: 'boolean' },
    'no-link-bin': { kind: 'boolean' },
    'no-shell': { kind: 'boolean' },
    'no-skills': { kind: 'boolean' },
    'no-mcp': { kind: 'boolean' },
    'no-instructions': { kind: 'boolean' },
    home: { kind: 'string' },
    'bin-dir': { kind: 'string' },
    'mcp-bin': { kind: 'string' },
  })
  if (!ctx.bridge.setup) {
    throw clientError('not_supported', 'swarmboard setup is not available in this environment')
  }
  const home = getStringFlag(parsed.flags, 'home')
  const binDir = getStringFlag(parsed.flags, 'bin-dir')
  const mcpBin = getStringFlag(parsed.flags, 'mcp-bin')
  const report = await ctx.bridge.setup(ctx.bridgeCtx, {
    dryRun: getBoolFlag(parsed.flags, 'dry-run') === true,
    skipInit: getBoolFlag(parsed.flags, 'skip-init') === true,
    linkBins: getBoolFlag(parsed.flags, 'no-link-bin') !== true,
    configureShell: getBoolFlag(parsed.flags, 'no-shell') !== true,
    installSkills: getBoolFlag(parsed.flags, 'no-skills') !== true,
    configureMcp: getBoolFlag(parsed.flags, 'no-mcp') !== true,
    configureInstructions: getBoolFlag(parsed.flags, 'no-instructions') !== true,
    ...(home !== undefined ? { home } : {}),
    ...(binDir !== undefined ? { binDir } : {}),
    ...(mcpBin !== undefined ? { mcpBin } : {}),
  })
  if (ctx.fmt.mode === 'json') {
    const { summaryText: _summary, ...jsonReport } = report
    ctx.fmt.json(jsonReport)
  } else if (report.summaryText) {
    ctx.io.stdout(report.summaryText)
  } else {
    ctx.fmt.line(`Swarmboard setup complete (home=${report.home})`)
  }
  return EXIT_OK
}

export async function cmdUninstall(ctx: OpsCommandEnv, args: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    'dry-run': { kind: 'boolean' },
    'purge-data': { kind: 'boolean' },
    home: { kind: 'string' },
    'bin-dir': { kind: 'string' },
    'app-dir': { kind: 'string' },
  })
  if (!ctx.bridge.uninstall) {
    throw clientError('not_supported', 'swarmboard uninstall is not available in this environment')
  }
  const home = getStringFlag(parsed.flags, 'home')
  const binDir = getStringFlag(parsed.flags, 'bin-dir')
  const appDir = getStringFlag(parsed.flags, 'app-dir')
  const report = await ctx.bridge.uninstall(ctx.bridgeCtx, {
    dryRun: getBoolFlag(parsed.flags, 'dry-run') === true,
    purgeData: getBoolFlag(parsed.flags, 'purge-data') === true,
    ...(home !== undefined ? { home } : {}),
    ...(binDir !== undefined ? { binDir } : {}),
    ...(appDir !== undefined ? { appDir } : {}),
  })
  if (ctx.fmt.mode === 'json') {
    const { summaryText: _summary, ...jsonReport } = report
    ctx.fmt.json(jsonReport)
  } else if (report.summaryText) {
    ctx.io.stdout(report.summaryText)
  } else {
    ctx.fmt.line(`Swarmboard uninstall complete (removed=${report.removed.length})`)
  }
  return EXIT_OK
}
