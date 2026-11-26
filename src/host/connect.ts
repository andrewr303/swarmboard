// SDK composition root (HOST123_DESIGN 5.7, Swarmboard v2 launch design §4.3): Modes 0, 1, 2, 3, and 4 connect().
// Static imports ONLY thin client modules + type-only imports; core-heavy, daemon, and transport modules
// load via literal dynamic import() so HS-22 (no child_process/net/http/https/worker_threads here) stays green.
import { createBoardClient, type BoardClient } from '../client/client.ts'
import { clientError, isBoardError } from '../client/errors.ts'
import type { IdentityProvider } from '../client/identity.ts'
import {
  processContext,
  resolveBoard,
  type Env,
  type ExplainStep,
  type ResolveContext,
  type ResolveFlags,
  type Resolution,
} from '../client/resolve.ts'
import type { BoardTransport, Selection } from '../client/types.ts'
import type { BoardService, BoardServiceOptions, CallerContext } from '../core/public.ts'
import type { FileHostOptions } from './file-host.ts'

export interface ConnectDaemonOptions {
  /** Override run directory for daemon probing/spawning (tests & custom run roots). */
  readonly runDir?: string
  /** Optional TCP loopback binding when spawning a daemon. */
  readonly tcp?: { readonly host?: string; readonly port?: number } | boolean | null
  /** Override daemon idle-exit timeout in seconds (0 disables). */
  readonly idleExitS?: number
  /** Override daemon entrypoint script path (tests). */
  readonly daemonScript?: string
  /** Override daemon spawn election timeout in ms (default 5000). */
  readonly spawnTimeoutMs?: number
  /** Override hello probe timeout in ms (default 2000). */
  readonly helloTimeoutMs?: number
  /** Ignore backoff.json when spawning. */
  readonly ignoreBackoff?: boolean
  /** Disable Mode 1 fallback on daemon spawn failure even when auth.enforce is false. */
  readonly noFallback?: boolean
}

export interface ConnectOptions extends ResolveFlags {
  /** Mode 0 over an existing service (tests, the daemon itself): skips resolution; never closed by the client. */
  readonly service?: BoardService
  readonly identity?: IdentityProvider
  readonly caller?: CallerContext
  /** Bearer token for Mode 2/3/4 (overrides SWARMBOARD_TOKEN / BOARD_TOKEN). */
  readonly token?: string
  /** Mode 0 only (inProcess or service); Mode 1+ rejects 400 conflicting_options (C20, OD-6). */
  readonly boardOptions?: BoardServiceOptions
  readonly context?: Partial<ResolveContext>
  readonly log?: (event: { selection: Selection; explain: readonly ExplainStep[] }) => void
  /** Mode 1 host tuning and test seams (HOST123_DESIGN 3). */
  readonly fileHost?: Partial<Pick<FileHostOptions, 'ticker' | 'onError' | 'layout' | 'bridgeTestHooks'>>
  /** Mode 2/3 daemon probing and spawn tuning. */
  readonly daemon?: ConnectDaemonOptions
  /** Injectable fetch implementation for Mode 4 HttpTransport (tests). */
  readonly fetch?: typeof globalThis.fetch
  /** Extra HTTP headers for Mode 4 HttpTransport. */
  readonly headers?: Readonly<Record<string, string>>
}

function readEnvToken(env: Env): string | undefined {
  const canonical = env.SWARMBOARD_TOKEN?.trim()
  if (canonical) return canonical
  const compat = env.BOARD_TOKEN?.trim()
  if (compat) return compat
  return undefined
}

function resolveDefaultAs(
  opts: Pick<ConnectOptions, 'caller'>,
  res: Resolution,
): { readonly defaultAs: string | null | undefined; readonly extraExplain: ExplainStep[] } {
  const extraExplain: ExplainStep[] = []
  let defaultAs: string | null | undefined
  if (opts.caller) {
    defaultAs = opts.caller.profile
    if (res.identity.profileSource !== null && res.identity.profile !== opts.caller.profile) {
      extraExplain.push({
        topic: 'identity',
        source: res.identity.profileSource,
        outcome: 'ignored',
        ...(res.identity.profile !== null ? { value: res.identity.profile } : {}),
        note: `caller profile ${String(opts.caller.profile)} overrides resolved profile`,
      })
    }
  } else if (res.identity.profileSource !== null) {
    defaultAs = res.identity.profile
  } else {
    defaultAs = undefined
  }
  return { defaultAs, extraExplain }
}

async function preflightAndFinish(
  transport: BoardTransport,
  principalLabel: string,
  selection: Selection,
  profile: string | null | undefined,
  res: Resolution | null,
  extraExplain: readonly ExplainStep[],
  initialWarnings: readonly ExplainStep[],
  log: ConnectOptions['log'],
  normalizeErrorFn: (e: unknown) => Error,
): Promise<BoardClient> {
  try {
    const warnings: ExplainStep[] = [...initialWarnings]
    try {
      await transport.call('me', {})
    } catch (e) {
      // Only board-origin 403 forbidden (missing admitting grant) becomes a warning; a handle-origin 403
      // (e.g. OD-11 deployment-kind principal refusal from prepareCall) must fail connect().
      if (isBoardError(e) && e.status === 403 && e.code === 'forbidden' && e.origin === 'board') {
        warnings.push(
          Object.freeze({
            topic: 'identity',
            source: 'connect',
            outcome: 'warn',
            note: `${principalLabel} is admitted by no grant on this board: a local identity on a default-seeded board needs member: true (grant g1 admits members) or an explicit grant`,
          }),
        )
      } else {
        throw e
      }
    }
    const explain: ExplainStep[] = [...(res?.explain ?? []), ...extraExplain, ...warnings]
    log?.({ selection, explain })
    return createBoardClient(transport, {
      selection,
      profile,
      resolution: res,
      warnings,
    })
  } catch (e) {
    await transport.close().catch(() => {})
    throw normalizeErrorFn(e)
  }
}

export async function connect(opts: ConnectOptions = {}): Promise<BoardClient> {
  // 1. Existing service (borrowed; never closed by client)
  if (opts.service !== undefined) {
    if (!opts.identity && !opts.caller) {
      throw clientError('invalid_request', 'Mode 0 needs an identity: pass caller or identity')
    }
    const [{ fixedIdentity }, { InProcessTransport }, { normalizeThrown }] = await Promise.all([
      import('../client/identity.ts'),
      import('../client/transport-inproc.ts'),
      import('../client/normalize.ts'),
    ])
    const identity = opts.identity ?? fixedIdentity(opts.caller!)
    const transport = new InProcessTransport({ board: opts.service, identity })
    const selection: Selection = {
      mode: 'in-process',
      reason: 'service option',
      source: 'option:service',
    }
    const defaultAs = opts.caller ? opts.caller.profile : undefined
    return preflightAndFinish(
      transport,
      identity.base.principal,
      selection,
      defaultAs,
      null,
      [],
      [],
      opts.log,
      normalizeThrown,
    )
  }

  // 2. Resolve board & policy
  const flags: ResolveFlags = {
    ...(opts.board !== undefined ? { board: opts.board } : {}),
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    ...(opts.db !== undefined ? { db: opts.db } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.as !== undefined ? { as: opts.as } : {}),
    ...(opts.inProcess !== undefined ? { inProcess: opts.inProcess } : {}),
    ...(opts.allowUnsafeFs !== undefined ? { allowUnsafeFs: opts.allowUnsafeFs } : {}),
  }
  const ctx = processContext(opts.context)
  const res = resolveBoard(flags, ctx)

  // 3. Mode 4: URL target -> HttpTransport (never falls back locally)
  if (res.target.kind === 'url') {
    if (opts.boardOptions !== undefined) {
      throw clientError('conflicting_options', 'boardOptions cannot be passed for a URL board')
    }
    const [{ HttpTransport }, { normalizeThrown }] = await Promise.all([
      import('../client/transport-http.ts'),
      import('../client/normalize.ts'),
    ])
    const { defaultAs, extraExplain } = resolveDefaultAs(opts, res)
    const token = opts.token ?? readEnvToken(ctx.env)
    const defaultProfile =
      opts.caller?.profile ?? opts.identity?.base.profile ?? (defaultAs !== undefined ? defaultAs : null)
    const canHeader = opts.caller?.canHeader
    const transport = new HttpTransport({
      url: res.target.url,
      mode: 'remote',
      ...(token !== undefined ? { token } : {}),
      defaultProfile,
      ...(canHeader !== undefined ? { canHeader } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
    })
    try {
      await transport.ready()
      const selection: Selection = {
        mode: 'remote',
        reason: 'url target',
        source: res.source,
      }
      const principalLabel = opts.identity?.base.principal ?? opts.caller?.principal.id ?? defaultProfile ?? 'remote'
      return await preflightAndFinish(
        transport,
        principalLabel,
        selection,
        defaultAs,
        res,
        extraExplain,
        [],
        opts.log,
        normalizeThrown,
      )
    } catch (e) {
      await transport.close().catch(() => {})
      throw normalizeThrown(e)
    }
  }

  // 4. Mode 0: inProcess openBoard + owned InProcessTransport
  if (res.policy.inProcess) {
    if (!opts.identity && !opts.caller) {
      throw clientError('invalid_request', 'Mode 0 needs an identity: pass caller or identity')
    }
    const [{ openBoard }, { fixedIdentity }, { InProcessTransport }, { normalizeThrown }] = await Promise.all([
      import('./layout.ts'),
      import('../client/identity.ts'),
      import('../client/transport-inproc.ts'),
      import('../client/normalize.ts'),
    ])

    const identity = opts.identity ?? fixedIdentity(opts.caller!)
    const { defaultAs, extraExplain } = resolveDefaultAs(opts, res)

    let opened: Awaited<ReturnType<typeof openBoard>> | undefined
    let transport: InstanceType<typeof InProcessTransport> | undefined
    try {
      opened = openBoard(res.target, {
        boardOptions: opts.boardOptions,
        allowUnsafeFs: res.policy.allowUnsafeFs,
        platform: ctx.platform,
        home: ctx.home,
        env: ctx.env,
        uid: ctx.uid,
      })
      transport = new InProcessTransport({ board: opened.board, identity, owned: opened })
      const selection: Selection = {
        mode: 'in-process',
        reason: 'inProcess option',
        source: res.source,
      }
      return await preflightAndFinish(
        transport,
        identity.base.principal,
        selection,
        defaultAs,
        res,
        extraExplain,
        opened.warnings,
        opts.log,
        normalizeThrown,
      )
    } catch (e) {
      if (transport !== undefined) {
        await transport.close().catch(() => {})
      } else if (opened !== undefined) {
        try {
          opened.close()
        } catch {
          // already closed
        }
      }
      throw normalizeThrown(e)
    }
  }

  // Pre-filesystem file-board policy checks (zero FS side effects)
  if (res.target.kind !== 'file') {
    throw clientError('invalid_db_path', 'file board modes require a file board path')
  }
  if (opts.boardOptions !== undefined) {
    throw clientError(
      'conflicting_options',
      'boardOptions cannot be passed in Mode 1+ (shared-file/daemon): one BoardService is shared per board',
      { hint: 'pass inProcess: true for Mode 0 with custom boardOptions' },
    )
  }

  const fileTarget = res.target
  const { defaultAs, extraExplain } = resolveDefaultAs(opts, res)
  const token = opts.token ?? readEnvToken(ctx.env)

  const connectOverSocket = async (
    socketPath: string,
    mode: 'daemon' | 'service',
    reason: string,
  ): Promise<BoardClient> => {
    const [{ SocketTransport }, { normalizeThrown }] = await Promise.all([
      import('../client/transport-socket.ts'),
      import('../client/normalize.ts'),
    ])
    const defaultProfile =
      opts.caller?.profile ?? opts.identity?.base.profile ?? (defaultAs !== undefined ? defaultAs : null)
    const canHeader = opts.caller?.canHeader
    const transport = new SocketTransport({
      socketPath,
      mode,
      ...(token !== undefined ? { token } : {}),
      defaultProfile,
      ...(canHeader !== undefined ? { canHeader } : {}),
    })
    try {
      await transport.ready()
      const selection: Selection = { mode, reason, source: res.source }
      const principalLabel = opts.identity?.base.principal ?? opts.caller?.principal.id ?? defaultProfile ?? 'local'
      return await preflightAndFinish(
        transport,
        principalLabel,
        selection,
        defaultAs,
        res,
        extraExplain,
        [],
        opts.log,
        normalizeThrown,
      )
    } catch (e) {
      await transport.close().catch(() => {})
      throw normalizeThrown(e)
    }
  }

  const connectSharedFile = async (
    reason: string,
    fallback?: string,
    extraWarnings: readonly ExplainStep[] = [],
  ): Promise<BoardClient> => {
    if (res.policy.authEnforce) {
      throw clientError(
        'daemon_required',
        'auth.enforce is enabled: Mode 1 shared-file access is refused without a daemon',
        { hint: 'start a Swarmboard daemon or disable auth.enforce in config' },
      )
    }
    if (!opts.identity && !opts.caller) {
      throw clientError('invalid_request', 'Mode 1 needs an identity: pass caller or identity')
    }
    const [{ createFileHost }, { SharedFileTransport }, { fixedIdentity }, { normalizeThrown }] = await Promise.all([
      import('./file-host.ts'),
      import('../client/transport-file.ts'),
      import('../client/identity.ts'),
      import('../client/normalize.ts'),
    ])

    const identity = opts.identity ?? fixedIdentity(opts.caller!)
    let transport: InstanceType<typeof SharedFileTransport> | undefined
    try {
      const host = createFileHost({
        target: fileTarget,
        allowUnsafeFs: res.policy.allowUnsafeFs,
        wake: res.policy.wake,
        tick: res.policy.tick,
        layout: {
          platform: ctx.platform,
          home: ctx.home,
          env: ctx.env,
          uid: ctx.uid,
          ...opts.fileHost?.layout,
        },
        ...(opts.fileHost?.ticker !== undefined ? { ticker: opts.fileHost.ticker } : {}),
        ...(opts.fileHost?.onError !== undefined ? { onError: opts.fileHost.onError } : {}),
        ...(opts.fileHost?.bridgeTestHooks !== undefined ? { bridgeTestHooks: opts.fileHost.bridgeTestHooks } : {}),
      })
      transport = new SharedFileTransport({ path: fileTarget.db, identity, host })
      await transport.ready()
      const selection: Selection = {
        mode: 'shared-file',
        reason,
        source: res.source,
        ...(fallback !== undefined ? { fallback } : {}),
      }
      return await preflightAndFinish(
        transport,
        identity.base.principal,
        selection,
        defaultAs,
        res,
        extraExplain,
        [...extraWarnings, ...transport.warnings],
        opts.log,
        normalizeThrown,
      )
    } catch (e) {
      if (transport !== undefined) {
        await transport.close().catch(() => {})
      }
      throw normalizeThrown(e)
    }
  }

  // 5. Mode 1 explicit (`mode: 'file'`)
  if (res.policy.mode === 'file') {
    return connectSharedFile('mode file')
  }

  // Shared daemon probe options (isolated inside ./daemon/election.ts via literal dynamic import)
  const daemonProbeOpts = {
    platform: ctx.platform,
    home: ctx.home,
    env: ctx.env,
    uid: ctx.uid,
    ...(opts.daemon?.runDir !== undefined ? { runDirOverride: opts.daemon.runDir } : {}),
    ...(opts.daemon?.helloTimeoutMs !== undefined ? { helloTimeoutMs: opts.daemon.helloTimeoutMs } : {}),
  }

  // 6. Mode 3 explicit (`mode: 'service'`): requires an already-live daemon; never silently downgrades.
  if (res.policy.mode === 'service') {
    const { probeDaemon } = await import('./daemon/election.ts')
    const probe = await probeDaemon(fileTarget.db, daemonProbeOpts)
    if (probe.status === 'live') {
      return connectOverSocket(probe.paths.socketPath, 'service', 'mode service: live daemon')
    }
    throw clientError(
      'daemon_unavailable',
      `service mode requires a running Swarmboard daemon for ${fileTarget.db} (none reachable)`,
      { hint: 'start the resident service with `swarmboard serve` or `swarmboard daemon start`' },
    )
  }

  // 7. Mode 2 explicit (`mode: 'daemon'`): probe live, else run election/spawn; fallback to Mode 1 ONLY if !authEnforce.
  if (res.policy.mode === 'daemon') {
    const { probeDaemon, ensureDaemon } = await import('./daemon/election.ts')
    const probe = await probeDaemon(fileTarget.db, daemonProbeOpts)
    if (probe.status === 'live') {
      return connectOverSocket(probe.paths.socketPath, 'daemon', 'mode daemon: live')
    }

    if (res.policy.daemon.spawn === 'never') {
      if (res.policy.authEnforce) {
        throw clientError('daemon_required', 'auth.enforce is enabled and daemon.spawn is "never": no daemon reachable')
      }
      throw clientError('daemon_unavailable', 'no running daemon and daemon.spawn is set to "never"')
    }

    try {
      const ensured = await ensureDaemon(fileTarget.db, {
        ...daemonProbeOpts,
        idleExitS: opts.daemon?.idleExitS ?? res.policy.daemon.idleExitS,
        authEnforce: res.policy.authEnforce,
        allowUnsafeFs: res.policy.allowUnsafeFs,
        ...(opts.daemon?.tcp !== undefined ? { tcp: opts.daemon.tcp } : {}),
        ...(opts.daemon?.daemonScript !== undefined ? { daemonScript: opts.daemon.daemonScript } : {}),
        ...(opts.daemon?.spawnTimeoutMs !== undefined ? { spawnTimeoutMs: opts.daemon.spawnTimeoutMs } : {}),
        ...(opts.daemon?.ignoreBackoff !== undefined ? { ignoreBackoff: opts.daemon.ignoreBackoff } : {}),
      })
      return await connectOverSocket(
        ensured.paths.socketPath,
        'daemon',
        ensured.spawned ? 'mode daemon: spawned' : 'mode daemon: live',
      )
    } catch (err) {
      // Never swallow layout/security/missing-board errors.
      if (
        isBoardError(err) &&
        (err.code === 'unsafe_location' || err.code === 'no_board' || err.code === 'manifest_mismatch')
      ) {
        throw err
      }
      if (res.policy.authEnforce) {
        throw clientError(
          'daemon_required',
          `auth.enforce is enabled and daemon could not be started: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
      if (opts.daemon?.noFallback === true || (!opts.identity && !opts.caller)) {
        throw err
      }
      const cause = isBoardError(err) ? err.code : 'spawn_failed'
      const warn: ExplainStep = Object.freeze({
        topic: 'mode',
        source: 'connect',
        outcome: 'warn',
        note: `daemon-fallback:${cause}: ${err instanceof Error ? err.message : String(err)}`,
      })
      return connectSharedFile(`daemon-fallback:${cause}`, cause, [warn])
    }
  }

  // 8. Default `mode: 'auto'`: use live daemon if running; else Mode 1 (unless auth.enforce=true -> daemon_required).
  {
    const { probeDaemon } = await import('./daemon/election.ts')
    const probe = await probeDaemon(fileTarget.db, daemonProbeOpts)
    if (probe.status === 'live') {
      const resolvedMode = probe.hello.tcp !== null ? 'service' : 'daemon'
      return connectOverSocket(probe.paths.socketPath, resolvedMode, 'auto: live daemon')
    }
    return connectSharedFile('auto: no live daemon')
  }
}
