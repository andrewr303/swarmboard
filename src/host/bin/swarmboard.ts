#!/usr/bin/env node
// Thin `swarmboard` CLI binary entrypoint & default CliHostBridge composition root
// (Swarmboard v2 launch design §3.1–§3.2).
// - Enables Node >= 22.8 compile cache on boot for fast cold starts (~71 ms).
// - Static imports stay thin; heavy host/core/server/daemon modules load lazily via literal dynamic import().
// - Never imports `src/core/internal.ts` (HS-151) or core error normalizers (HS-03).
import * as nodeModule from 'node:module'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBoardClient } from '../../client/client.ts'
import { ClientError, clientError, isBoardError } from '../../client/errors.ts'
import { processContext, resolveBoard, type Env, type Resolution } from '../../client/resolve.ts'
import { CLIENT_VERSION } from '../../client/version.ts'
import {
  createProcessIo,
  redactSecrets,
  runCli,
  TRUST_DISCLOSURE,
  type BackupResult,
  type CliBridgeContext,
  type CliHostBridge,
  type DaemonControlRequest,
  type DaemonControlResult,
  type DaemonStatusInfo,
  type DoctorReport,
  type InitBoardResult,
  type LinkBinResult,
  type OpenUiRequest,
  type OpenUiResult,
  type PortCheck,
  type ServeRequest,
  type ServeResult,
  type TickResult,
  type TokenIssueRequest,
  type TokenIssueResult,
  type TokenListRequest,
  type TokenRecordView,
  type TokenRevokeResult,
} from '../../cli/index.ts'
import type { DaemonStatusResult } from '../daemon/index.ts'

// Line-1 compile cache activation (Node >= 22.8 built-in; safe no-op if unavailable).
function initCompileCache(env: Env = process.env): void {
  try {
    const disabled = env['SWARMBOARD_DISABLE_COMPILE_CACHE']?.trim().toLowerCase()
    if (disabled && disabled !== '0' && disabled !== 'false') return
    const fn = (nodeModule as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache
    if (typeof fn !== 'function') return
    const explicit = env['NODE_COMPILE_CACHE']?.trim()
    if (explicit) {
      fn(explicit)
      return
    }
    const xdgCache = env['XDG_CACHE_HOME']?.trim()
    const base = xdgCache && path.isAbsolute(xdgCache) ? xdgCache : path.join(os.homedir(), '.cache')
    fn(path.join(base, 'swarmboard', 'compile-cache'))
  } catch {
    // Compile cache is purely an optimization; never fail CLI startup.
  }
}

initCompileCache()

function resolveCtxOf(ctx: CliBridgeContext) {
  const envHome =
    process.platform === 'win32'
      ? (ctx.env['USERPROFILE']?.trim() || ctx.env['HOME']?.trim())
      : ctx.env['HOME']?.trim()
  return processContext({
    env: ctx.env,
    cwd: ctx.cwd,
    ...(envHome ? { home: envHome } : {}),
  })
}

function requireFileTarget(res: Resolution, opName: string): Extract<Resolution['target'], { kind: 'file' }> {
  if (res.target.kind !== 'file') {
    throw clientError('invalid_request', `${opName} requires a local file board (got ${res.target.kind})`)
  }
  return res.target
}

function readEnvToken(env: Env): string | undefined {
  const canonical = env['SWARMBOARD_TOKEN']?.trim()
  if (canonical) return canonical
  const compat = env['BOARD_TOKEN']?.trim()
  if (compat) return compat
  return undefined
}

function hasExplicitAgentIdentity(ctx: CliBridgeContext): boolean {
  if (ctx.flags.as !== undefined) return true
  for (const key of ['SWARMBOARD_AGENT', 'BOARD_PROFILE', 'FUSION_AGENT_ID']) {
    if (ctx.env[key]?.trim()) return true
  }
  return false
}

function probePort(host: string, port: number, timeoutMs = 250): Promise<PortCheck> {
  return new Promise((resolvePromise) => {
    let settled = false
    const done = (result: PortCheck) => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    const socket = net.createConnection({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      const req = http.get({ host, port, path: '/healthz', timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const isSwarm = res.statusCode === 200 && text.includes('"boardId"')
          done({
            host,
            port,
            inUse: true,
            swarmboard: isSwarm,
            note: isSwarm ? 'Swarmboard HTTP listener active' : `in use by another service (port ${port})`,
          })
        })
      })
      req.on('error', () => {
        done({ host, port, inUse: true, swarmboard: false, note: `port ${port} is occupied by another process` })
      })
      req.on('timeout', () => {
        req.destroy()
        done({ host, port, inUse: true, swarmboard: false, note: `port ${port} is occupied` })
      })
    })
    socket.once('timeout', () => {
      socket.destroy()
      done({ host, port, inUse: false })
    })
    socket.once('error', () => {
      socket.destroy()
      done({ host, port, inUse: false })
    })
  })
}

function readDbInfoReadOnly(dbPath: string, walPath: string, shmPath: string): {
  readonly boardId: string | null
  readonly instanceId: string | null
  readonly schemaVersion: number | null
  readonly writable: boolean | null
  readonly error?: string
} {
  let db: DatabaseSync | null = null
  try {
    const url = pathToFileURL(dbPath)
    if (!fs.existsSync(walPath) && !fs.existsSync(shmPath)) {
      url.searchParams.set('immutable', '1')
    }
    db = new DatabaseSync(url, { readOnly: true, timeout: 500 })
    const rows = db.prepare('SELECT key, value FROM board_meta').all() as { key: string; value: string }[]
    const map = new Map(rows.map((r) => [r.key, r.value]))
    const rawVer = map.get('core.schema_version')
    const schemaVersion = rawVer !== undefined && /^\d+$/.test(rawVer) ? Number(rawVer) : null
    const rawWriteMin = map.get('core.write_min')
    const writeMin = rawWriteMin !== undefined && /^\d+$/.test(rawWriteMin) ? Number(rawWriteMin) : null
    return {
      boardId: map.get('board_id') ?? null,
      instanceId: map.get('instance_id') ?? null,
      schemaVersion,
      writable: writeMin === null ? true : schemaVersion !== null ? writeMin <= schemaVersion : null,
    }
  } catch (err) {
    return {
      boardId: null,
      instanceId: null,
      schemaVersion: null,
      writable: null,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }
}

function openBrowserBestEffort(url: string): boolean {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

function formatHttpOrigin(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${h}:${port}`
}

function normalizeDaemonStatus(raw: DaemonStatusResult): DaemonStatusInfo {
  const tcp = raw.hello?.tcp ?? raw.endpoint?.tcp ?? null
  const st = raw.status ?? null
  return {
    running: raw.running,
    pid: raw.hello?.pid ?? raw.endpoint?.pid ?? null,
    boardId: raw.hello?.boardId ?? raw.endpoint?.boardId ?? null,
    instanceId: raw.hello?.instanceId ?? raw.endpoint?.instanceId ?? null,
    socketPath: raw.paths?.socketPath ?? null,
    tcpUrl: tcp ? formatHttpOrigin(tcp.host, tcp.port) : null,
    mode: typeof st?.['mode'] === 'string' ? st['mode'] : null,
    uptimeMs: typeof st?.['uptimeMs'] === 'number' ? st['uptimeMs'] : null,
    streams: typeof st?.['streams'] === 'number' ? st['streams'] : null,
    queueDepth: typeof st?.['queueDepth'] === 'number' ? st['queueDepth'] : null,
    logPath: raw.logFile ?? raw.paths?.logFile ?? null,
    idleExitS: raw.hello?.idleExitS ?? raw.endpoint?.idleExitS ?? null,
  }
}

/** Builds the default production `CliHostBridge` wired to real `connect`, `layout`, `auth`, `tick`, `server`, and `daemon`. */
export function createDefaultHostBridge(): CliHostBridge {
  return {
    async connect(ctx: CliBridgeContext) {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)
      const [{ connect }, { resolveLocalIdentity }] = await Promise.all([
        import('../connect.ts'),
        import('../auth/local.ts'),
      ])
      const token = readEnvToken(ctx.env)

      if (
        res.target.kind === 'url' ||
        (token !== undefined &&
          !hasExplicitAgentIdentity(ctx) &&
          !ctx.isTTY &&
          (res.policy.mode === 'daemon' || res.policy.mode === 'service' || res.policy.authEnforce))
      ) {
        return connect({
          ...ctx.flags,
          context: rCtx,
          ...(token !== undefined ? { token } : {}),
        })
      }

      const localId = resolveLocalIdentity({
        ...(ctx.flags.as !== undefined ? { as: ctx.flags.as } : {}),
        env: ctx.env,
        isTTY: ctx.isTTY,
        resolution: res,
      })

      return connect({
        ...ctx.flags,
        identity: localId.provider,
        context: rCtx,
        ...(token !== undefined ? { token } : {}),
      })
    },

    async openForInit(ctx: CliBridgeContext): Promise<InitBoardResult> {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)

      if (res.target.kind === 'url') {
        const client = await this.connect(ctx)
        return {
          client,
          db: null,
          created: false,
          boardId: client.caps.boardId,
          instanceId: client.caps.instanceId,
          schemaVersion: client.caps.schemaVersion,
          mode: client.selection.mode,
        }
      }

      const [{ openBoard }, { resolveLocalIdentity, resolveOsUser }, { createLocalCaller }, { fixedIdentity }, { InProcessTransport }] =
        await Promise.all([
          import('../layout.ts'),
          import('../auth/local.ts'),
          import('../../core/public.ts'),
          import('../../client/identity.ts'),
          import('../../client/transport-inproc.ts'),
        ])

      const opened = openBoard(res.target, {
        allowUnsafeFs: res.policy.allowUnsafeFs,
        platform: rCtx.platform,
        home: rCtx.home,
        env: rCtx.env,
        uid: rCtx.uid,
      })

      try {
        const identity = hasExplicitAgentIdentity(ctx)
          ? resolveLocalIdentity({
              ...(ctx.flags.as !== undefined ? { as: ctx.flags.as } : {}),
              env: ctx.env,
              isTTY: ctx.isTTY,
              resolution: res,
            }).provider
          : (() => {
              const user = resolveOsUser(ctx.env)
              const ownerCaller = createLocalCaller({
                userId: user,
                handle: user,
                name: user,
                profile: null,
                owner: true,
                member: true,
                assurance: 'local_unverified',
                verified: false,
              })
              return fixedIdentity(ownerCaller)
            })()

        const transport = new InProcessTransport({
          board: opened.board,
          identity,
          owned: opened,
        })
        const info = opened.board.boardInfo()
        const client = createBoardClient(transport, {
          selection: { mode: 'in-process', reason: 'init local board', source: res.source },
          profile: identity.base.profile,
          resolution: res,
          warnings: opened.warnings,
        })
        return {
          client,
          db: opened.paths?.db ?? null,
          created: opened.created,
          boardId: info.boardId,
          instanceId: info.instanceId,
          schemaVersion: info.schema?.version ?? 0,
          mode: 'in-process',
        }
      } catch (err) {
        opened.close()
        throw err
      }
    },

    async doctor(ctx: CliBridgeContext): Promise<DoctorReport> {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)
      const [{ layoutReport }, { SCHEMA_VERSION }, { daemonStatus }] = await Promise.all([
        import('../layout.ts'),
        import('../../core/public.ts'),
        import('../daemon/index.ts'),
      ])

      const warnings: string[] = res.explain.filter((s) => s.outcome === 'warn').map((s) => `${s.source}: ${s.note}`)
      let layoutSection: DoctorReport['layout'] = null
      let boardSection: DoctorReport['board'] = {
        exists: false,
        boardId: null,
        instanceId: null,
        schemaVersion: null,
        expectedSchemaVersion: SCHEMA_VERSION,
        writable: null,
      }
      let daemonInfo: DaemonStatusInfo = { running: false }
      let ok = true

      if (res.target.kind === 'file') {
        const rep = layoutReport(res.target.db, {
          platform: rCtx.platform,
          home: rCtx.home,
          env: rCtx.env,
          uid: rCtx.uid,
        })
        const dbExists = fs.existsSync(rep.paths.db)
        layoutSection = {
          fsKind: rep.location.kind,
          manifest: typeof rep.manifest === 'string' ? rep.manifest : `v${rep.manifest.version} (${rep.manifest.boardId})`,
          walExists: fs.existsSync(rep.paths.wal),
          shmExists: fs.existsSync(rep.paths.shm),
          wakeupExists: fs.existsSync(rep.paths.wakeup),
          jsonlExists: fs.existsSync(rep.paths.jsonl),
          strays: rep.strays,
          refusals: rep.location.refusals,
          warnings: rep.location.warnings.map((w) => w.note),
        }
        if (rep.location.refusals.length > 0) ok = false
        if (rep.manifest === 'malformed') {
          ok = false
          warnings.push('board manifest is malformed')
        }
        if (rep.strays.length > 0) {
          warnings.push(`found ${rep.strays.length} stray manifest temp file(s)`)
        }
        if (dbExists) {
          const info = readDbInfoReadOnly(rep.paths.db, rep.paths.wal, rep.paths.shm)
          boardSection = {
            exists: true,
            boardId: info.boardId,
            instanceId: info.instanceId,
            schemaVersion: info.schemaVersion,
            expectedSchemaVersion: SCHEMA_VERSION,
            writable: info.writable,
            ...(info.error !== undefined ? { error: info.error } : {}),
          }
          if (info.error) ok = false
        } else {
          warnings.push('board database does not exist yet (run "swarmboard init --universal")')
        }

        try {
          const token = readEnvToken(ctx.env)
          const st = await daemonStatus(rep.paths.db, {
            platform: rCtx.platform,
            home: rCtx.home,
            env: rCtx.env,
            uid: rCtx.uid,
            ...(token !== undefined ? { token } : {}),
          })
          daemonInfo = normalizeDaemonStatus(st)
        } catch {
          daemonInfo = { running: false }
        }
      }

      const [port4180, port4100] = await Promise.all([
        probePort('127.0.0.1', 4180),
        probePort('127.0.0.1', 4100),
      ])

      return {
        ok,
        version: CLIENT_VERSION,
        target: res.target,
        source: res.source,
        modePolicy: res.policy.mode,
        authEnforce: res.policy.authEnforce,
        identity: {
          profile: res.identity.profile,
          profileSource: res.identity.profileSource,
          token: res.identity.token,
          tokenSource: res.identity.tokenSource,
        },
        configs: res.configs,
        board: boardSection,
        layout: layoutSection,
        daemon: daemonInfo,
        ports: [port4180, port4100],
        fallbacks: 0,
        warnings,
        trustDisclosure: TRUST_DISCLOSURE,
      }
    },

    async backup(ctx: CliBridgeContext, destPath: string, opts?: { readonly force?: boolean }): Promise<BackupResult> {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)
      const target = requireFileTarget(res, 'backup')
      const { openBoardStore } = await import('../layout.ts')

      const destAbs = path.resolve(ctx.cwd, destPath)
      const opened = openBoardStore(target, {
        allowUnsafeFs: res.policy.allowUnsafeFs,
        platform: rCtx.platform,
        home: rCtx.home,
        env: rCtx.env,
        uid: rCtx.uid,
      })

      try {
        const sourceDb = opened.paths!.db
        if (path.resolve(sourceDb) === destAbs) {
          throw clientError('invalid_request', 'backup destination must differ from the live board database path')
        }
        if (fs.existsSync(destAbs)) {
          if (opts?.force === true) {
            fs.unlinkSync(destAbs)
          } else {
            throw clientError('invalid_request', `backup destination already exists: ${destAbs} (pass --force to overwrite)`)
          }
        }
        fs.mkdirSync(path.dirname(destAbs), { recursive: true, mode: 0o700 })

        // Online SQLite VACUUM INTO snapshot (never raw cp; captures committed WAL state consistently).
        const sqlEscaped = destAbs.replace(/'/g, "''")
        opened.store.db.exec(`VACUUM INTO '${sqlEscaped}'`)
        try {
          fs.chmodSync(destAbs, 0o600)
        } catch {
          // Best-effort on non-POSIX filesystems.
        }

        // Verify snapshot integrity read-only.
        let integrityOk = false
        let verifyDb: DatabaseSync | null = null
        try {
          verifyDb = new DatabaseSync(destAbs, { readOnly: true })
          const row = verifyDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
          integrityOk = row?.integrity_check === 'ok'
        } finally {
          verifyDb?.close()
        }

        // Copy .jsonl audit sidecar alongside if present.
        const jsonlSource = opened.paths!.jsonl
        const jsonlDest = `${destAbs}.jsonl`
        let jsonlCopied = false
        if (fs.existsSync(jsonlSource)) {
          fs.copyFileSync(jsonlSource, jsonlDest)
          try {
            fs.chmodSync(jsonlDest, 0o600)
          } catch {
            // Best-effort.
          }
          jsonlCopied = true
        }

        const bytes = fs.statSync(destAbs).size
        return {
          sourceDb,
          destDb: destAbs,
          jsonlSource: jsonlCopied ? jsonlSource : null,
          jsonlDest: jsonlCopied ? jsonlDest : null,
          jsonlCopied,
          bytes,
          integrityOk,
        }
      } finally {
        opened.close()
      }
    },

    async runTickOnce(ctx: CliBridgeContext): Promise<TickResult> {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)
      const target = requireFileTarget(res, 'tick')
      const [{ openBoard }, { Ticker }] = await Promise.all([
        import('../layout.ts'),
        import('../tick.ts'),
      ])
      const opened = openBoard(target, {
        allowUnsafeFs: res.policy.allowUnsafeFs,
        platform: rCtx.platform,
        home: rCtx.home,
        env: rCtx.env,
        uid: rCtx.uid,
      })
      const ticker = new Ticker(opened.board)
      try {
        return ticker.runOnce()
      } finally {
        ticker.stop()
        opened.close()
      }
    },

    async serve(ctx: CliBridgeContext, req: ServeRequest): Promise<ServeResult> {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)
      const target = requireFileTarget(res, 'serve')
      const { runDaemonServer } = await import('../daemon/index.ts')

      const handle = await runDaemonServer({
        db: target.db,
        tcp: { host: req.host, port: req.port },
        idleExitS: req.noIdleExit ? 0 : res.policy.daemon.idleExitS,
        authEnforce: res.policy.authEnforce,
        allowUnsafeFs: res.policy.allowUnsafeFs,
        ...(req.tailscaleHost !== undefined ? { tailscaleHost: req.tailscaleHost } : {}),
        ...(req.allowHosts !== undefined ? { allowHosts: req.allowHosts } : {}),
        registerSignals: false,
        mode: req.noIdleExit ? 'service' : 'daemon',
      })

      const url = handle.tcp?.url ?? formatHttpOrigin(req.host, req.port)
      req.onReady?.({
        url,
        socketPath: handle.paths.socketPath,
        boardId: handle.hello.boardId,
        instanceId: handle.hello.instanceId,
        mode: req.noIdleExit ? 'service' : 'daemon',
      })
      if (req.open) openBrowserBestEffort(url)

      await new Promise<void>((resolveWait) => {
        const onAbort = () => {
          void handle.close().finally(resolveWait)
        }
        if (req.signal?.aborted) {
          onAbort()
          return
        }
        req.signal?.addEventListener('abort', onAbort, { once: true })
        void handle.done.then(resolveWait, resolveWait)
      })
      return { url, socketPath: handle.paths.socketPath, stopped: true }
    },

    async daemonControl(ctx: CliBridgeContext, req: DaemonControlRequest): Promise<DaemonControlResult> {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)
      const target = requireFileTarget(res, 'daemon')
      const { daemonPaths, daemonStatus, startDaemon, stopDaemon, udsControlRequest } = await import('../daemon/index.ts')
      const token = readEnvToken(ctx.env)
      const pathOpts = {
        platform: rCtx.platform,
        home: rCtx.home,
        env: rCtx.env,
        uid: rCtx.uid,
      }
      const authPathOpts = {
        ...pathOpts,
        ...(token !== undefined ? { token } : {}),
      }

      if (req.action === 'status') {
        const st = await daemonStatus(target.db, authPathOpts)
        return { action: 'status', ok: true, status: normalizeDaemonStatus(st) }
      }

      if (req.action === 'logs') {
        const paths = daemonPaths(target.db, pathOpts)
        const maxLines = req.lines ?? 50
        let lines: string[] = []
        if (fs.existsSync(paths.logFile)) {
          const raw = fs.readFileSync(paths.logFile, 'utf8')
          const all = raw.split(/\r?\n/).filter((l) => l.length > 0)
          lines = all.slice(-maxLines).map((l) => redactSecrets(l))
        }
        return { action: 'logs', ok: true, logs: lines }
      }

      if (req.action === 'stop') {
        const stopped = await stopDaemon(target.db, authPathOpts)
        return {
          action: 'stop',
          ok: true,
          status: { running: false, pid: stopped.pid },
          message: stopped.stopped ? 'daemon stopped' : 'daemon was not running',
        }
      }

      if (req.action === 'restart') {
        await stopDaemon(target.db, authPathOpts).catch(() => {})
      }

      const tcpOpt =
        req.tcp === true || req.host !== undefined || req.port !== undefined
          ? { host: req.host ?? '127.0.0.1', port: req.port ?? 4180 }
          : undefined

      const started = await startDaemon(target.db, {
        ...pathOpts,
        ...(tcpOpt !== undefined ? { tcp: tcpOpt } : {}),
        idleExitS: req.noIdleExit ? 0 : res.policy.daemon.idleExitS,
        authEnforce: res.policy.authEnforce,
        allowUnsafeFs: res.policy.allowUnsafeFs,
      })
      if (tcpOpt !== undefined && started.hello.tcp === null && token !== undefined) {
        const tcpRes = await udsControlRequest<{ error?: { code?: string; message?: string } }>(
          started.paths.socketPath,
          'POST',
          '/_swarm/v1/listen-tcp',
          { body: tcpOpt, timeoutMs: 3_000, token },
        )
        if (tcpRes.status >= 400) {
          throw new ClientError(
            tcpRes.status,
            tcpRes.data?.error?.code ?? 'daemon_unavailable',
            tcpRes.data?.error?.message ?? 'failed to activate daemon TCP listener',
          )
        }
      }
      const st = await daemonStatus(target.db, authPathOpts)
      return {
        action: req.action,
        ok: st.running,
        status: normalizeDaemonStatus(st),
        message: st.running ? 'daemon running' : 'daemon failed to report running status',
      }
    },

    async openUi(ctx: CliBridgeContext, req: OpenUiRequest): Promise<OpenUiResult> {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)
      const target = requireFileTarget(res, 'open')
      const { probeDaemon, startDaemon, udsControlRequest } = await import('../daemon/index.ts')
      const token = readEnvToken(ctx.env)
      const pathOpts = {
        platform: rCtx.platform,
        home: rCtx.home,
        env: rCtx.env,
        uid: rCtx.uid,
      }

      let started = await startDaemon(target.db, {
        ...pathOpts,
        tcp: { host: req.host, port: req.port },
        authEnforce: res.policy.authEnforce,
        allowUnsafeFs: res.policy.allowUnsafeFs,
      })

      if (started.hello.tcp === null && token !== undefined) {
        const tcpRes = await udsControlRequest<{ error?: { code?: string; message?: string } }>(
          started.paths.socketPath,
          'POST',
          '/_swarm/v1/listen-tcp',
          { body: { host: req.host, port: req.port }, timeoutMs: 3_000, token },
        )
        if (tcpRes.status >= 400) {
          throw new ClientError(
            tcpRes.status,
            tcpRes.data?.error?.code ?? 'daemon_unavailable',
            tcpRes.data?.error?.message ?? 'failed to activate daemon TCP listener',
          )
        }
        const refreshed = await probeDaemon(started.paths.dbRealpath, pathOpts)
        if (refreshed.status === 'live') {
          started = { ...started, endpoint: refreshed.endpoint, hello: refreshed.hello }
        }
      }

      const boundTcp = started.hello.tcp ?? started.endpoint.tcp
      const baseUrl = boundTcp ? formatHttpOrigin(boundTcp.host, boundTcp.port) : formatHttpOrigin(req.host, req.port)

      let loginUrl: string | undefined
      let expiresAt: string | undefined

      const codeRes = await udsControlRequest<{ code?: string; expiresAt?: string; error?: { code?: string; message?: string } }>(
        started.paths.socketPath,
        'POST',
        '/_swarm/v1/login-code',
        { body: {}, timeoutMs: 3_000, ...(token !== undefined ? { token } : {}) },
      )
      if (codeRes.status >= 400) {
        throw new ClientError(
          codeRes.status,
          codeRes.data?.error?.code ?? 'daemon_unavailable',
          codeRes.data?.error?.message ?? 'failed to mint one-time login code',
        )
      }
      if (typeof codeRes.data?.code === 'string') {
        loginUrl = `${baseUrl}/_swarm/v1/login?code=${encodeURIComponent(codeRes.data.code)}`
        if (typeof codeRes.data.expiresAt === 'string') expiresAt = codeRes.data.expiresAt
      }

      const targetToOpen = loginUrl ?? baseUrl
      const opened = req.noBrowser === true ? false : openBrowserBestEffort(targetToOpen)

      return {
        url: baseUrl,
        ...(loginUrl !== undefined ? { loginUrl } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        opened,
        pid: started.hello.pid,
      }
    },

    async tokenIssue(ctx: CliBridgeContext, req: TokenIssueRequest): Promise<TokenIssueResult> {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)
      const target = requireFileTarget(res, 'token issue')
      const [{ openBoardStore }, { TokenStore }, { resolveLocalIdentity, resolveOsUser }, { createLocalCaller }] =
        await Promise.all([
          import('../layout.ts'),
          import('../auth/tokens.ts'),
          import('../auth/local.ts'),
          import('../../core/public.ts'),
        ])

      const opened = openBoardStore(target, {
        allowUnsafeFs: res.policy.allowUnsafeFs,
        platform: rCtx.platform,
        home: rCtx.home,
        env: rCtx.env,
        uid: rCtx.uid,
      })
      try {
        const tokens = new TokenStore(opened.store)
        const caller = hasExplicitAgentIdentity(ctx)
          ? resolveLocalIdentity({
              ...(ctx.flags.as !== undefined ? { as: ctx.flags.as } : {}),
              env: ctx.env,
              isTTY: ctx.isTTY,
              resolution: res,
            }).caller
          : (() => {
              const user = resolveOsUser(ctx.env)
              return createLocalCaller({
                userId: user,
                handle: user,
                name: user,
                profile: null,
                owner: true,
                member: true,
                assurance: 'local_unverified',
                verified: false,
              })
            })()
        return tokens.issueToken(caller, req)
      } finally {
        opened.close()
      }
    },

    async tokenList(ctx: CliBridgeContext, req: TokenListRequest): Promise<readonly TokenRecordView[]> {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)
      const target = requireFileTarget(res, 'token list')
      const [{ openBoardStore }, { TokenStore }] = await Promise.all([
        import('../layout.ts'),
        import('../auth/tokens.ts'),
      ])
      const opened = openBoardStore(target, {
        allowUnsafeFs: res.policy.allowUnsafeFs,
        platform: rCtx.platform,
        home: rCtx.home,
        env: rCtx.env,
        uid: rCtx.uid,
      })
      try {
        const tokens = new TokenStore(opened.store)
        return tokens.listTokens(req)
      } finally {
        opened.close()
      }
    },

    async tokenRevoke(ctx: CliBridgeContext, id: string): Promise<TokenRevokeResult> {
      const rCtx = resolveCtxOf(ctx)
      const res = resolveBoard(ctx.flags, rCtx)
      const target = requireFileTarget(res, 'token revoke')
      const [{ openBoardStore }, { TokenStore }, { resolveLocalIdentity, resolveOsUser }, { createLocalCaller }] =
        await Promise.all([
          import('../layout.ts'),
          import('../auth/tokens.ts'),
          import('../auth/local.ts'),
          import('../../core/public.ts'),
        ])
      const opened = openBoardStore(target, {
        allowUnsafeFs: res.policy.allowUnsafeFs,
        platform: rCtx.platform,
        home: rCtx.home,
        env: rCtx.env,
        uid: rCtx.uid,
      })
      try {
        const tokens = new TokenStore(opened.store)
        const caller = hasExplicitAgentIdentity(ctx)
          ? resolveLocalIdentity({
              ...(ctx.flags.as !== undefined ? { as: ctx.flags.as } : {}),
              env: ctx.env,
              isTTY: ctx.isTTY,
              resolution: res,
            }).caller
          : (() => {
              const user = resolveOsUser(ctx.env)
              return createLocalCaller({
                userId: user,
                handle: user,
                name: user,
                profile: null,
                owner: true,
                member: true,
                assurance: 'local_unverified',
                verified: false,
              })
            })()
        const record = tokens.revokeToken(id, { actor: caller })
        return { record, revoked: record.revokedAt !== null }
      } finally {
        opened.close()
      }
    },

    async linkBin(ctx: CliBridgeContext): Promise<LinkBinResult> {
      const selfPath = fileURLToPath(import.meta.url)
      const repoRoot = selfPath.endsWith('.mjs')
        ? path.resolve(path.dirname(selfPath), '..', '..')
        : path.resolve(path.dirname(selfPath), '..', '..', '..')
      const home = ctx.env['HOME']?.trim() || os.homedir()
      const binDir = path.join(home, '.local', 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      const pairs: readonly [string, string][] = [
        ['swarmboard', path.join(repoRoot, 'dist', 'bin', 'swarmboard.mjs')],
        ['swarmboard-mcp', path.join(repoRoot, 'dist', 'bin', 'swarmboard-mcp.mjs')],
        ['swarmboard-daemon', path.join(repoRoot, 'dist', 'bin', 'swarmboard-daemon.mjs')],
      ]
      const linked: string[] = []
      for (const [name, targetFile] of pairs) {
        if (!fs.existsSync(targetFile)) continue
        const dest = path.join(binDir, name)
        try {
          fs.chmodSync(targetFile, 0o755)
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(dest)
        } catch {
          // ignore if absent
        }
        fs.symlinkSync(targetFile, dest)
        linked.push(`${dest} -> ${targetFile}`)
      }
      return {
        linked,
        ...(linked.length === 0 ? { note: 'build dist/bin/*.mjs first before running --link-bin' } : {}),
      }
    },

    async setup(ctx, req) {
      const { formatSetupReport, runSetup } = await import('../setup.ts')
      const envHome =
        process.platform === 'win32'
          ? (ctx.env['USERPROFILE']?.trim() || ctx.env['HOME']?.trim())
          : ctx.env['HOME']?.trim()
      const report = runSetup({
        ...req,
        ...(req.home !== undefined ? { home: req.home } : envHome ? { home: envHome } : {}),
      })
      return { ...report, summaryText: formatSetupReport(report) }
    },

    async uninstall(ctx, req) {
      const { formatUninstallReport, runUninstall } = await import('../setup.ts')
      const envHome =
        process.platform === 'win32'
          ? (ctx.env['USERPROFILE']?.trim() || ctx.env['HOME']?.trim())
          : ctx.env['HOME']?.trim()
      const report = runUninstall({
        ...req,
        ...(req.home !== undefined ? { home: req.home } : envHome ? { home: envHome } : {}),
      })
      return { ...report, summaryText: formatUninstallReport(report) }
    },
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2), env: Env = process.env): Promise<number> {
  const ctrl = new AbortController()
  const onSig = () => ctrl.abort()
  process.once('SIGINT', onSig)
  process.once('SIGTERM', onSig)
  try {
    const bridge = createDefaultHostBridge()
    return await runCli(argv, env, bridge, { io: createProcessIo(ctrl.signal) })
  } finally {
    process.removeListener('SIGINT', onSig)
    process.removeListener('SIGTERM', onSig)
  }
}

// Run when executed directly as a CLI script (resolving symlinks so ~/.local/bin/swarmboard works).
const isEntry = (() => {
  try {
    if (!process.argv[1]) return false
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntry) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      const msg = isBoardError(err) ? err.message : err instanceof Error ? err.message : String(err)
      process.stderr.write(`error: ${redactSecrets(msg)}\n`)
      process.exitCode = 1
    })
}
