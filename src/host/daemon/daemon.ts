// HOST-10 lazy UDS + loopback TCP daemon server (Swarmboard v2 launch design §4.3).
//
// Composes:
// - openBoardStore (layout guard + manifest + 0700/0600 sidecars)
// - WakeBridge (bridges Mode 1 direct SQLite writers into RealtimeHub in ~3.6 ms!)
// - Ticker (runs schedules & task lease sweeps)
// - TokenStore + Authenticator (per-listener auth matrix + 4 loopback CSRF guards + audit log)
// - WriteQueue (512 FIFO queue) + RealtimeHub (single-listener SSE fan-out) + createServerHandler
// - UDS / named-pipe listener (0600) + optional loopback TCP listener (127.0.0.1:4180)
// - Idle exit timer (default 600 s, --no-idle-exit disables, vetoed by in-flight requests or open SSE streams)
// - Clean drain on idle/retire/SIGTERM: rename endpoint.json -> endpoint.retiring -> server.close() ->
//   wait <= 10 s for in-flight -> notify SSE shutdown -> PRAGMA wal_checkpoint(TRUNCATE) ->
//   ticker.stop() -> bridge.stop() -> store.close() -> unlink b.sock.
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as nodePath from 'node:path'
import { BoardService } from '../../core/public.ts'
import { clientError } from '../../client/errors.ts'
import { CLIENT_VERSION, PROTOCOL_VERSION } from '../../client/version.ts'
import {
  attachNodeHandler,
  createServerHandler,
  createUiHandler,
  RealtimeHub,
  WriteQueue,
  type DaemonHelloPayload,
  type ServerHandler,
  type ServerListenerContext,
  type UiHandler,
} from '../../server/index.ts'
import {
  Authenticator,
  validateListenerConfig,
  type OidcConfig,
} from '../auth/authenticator.ts'
import { TokenStore } from '../auth/tokens.ts'
import { boardPaths, openBoardStore } from '../layout.ts'
import { Ticker, type TickerOptions } from '../tick.ts'
import { WakeBridge, type WakeBridgeOptions } from '../wake-bridge.ts'
import { writeEndpointAtomic, type EndpointRecord } from './election.ts'
import { daemonPaths, ensureSecureRunDir, type DaemonPaths } from './paths.ts'

export const DEFAULT_IDLE_EXIT_S = 600
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000
export const DEFAULT_TCP_HOST = '127.0.0.1'
export const DEFAULT_TCP_PORT = 4180

export interface RunDaemonOptions {
  readonly db: string
  readonly runDir?: string
  readonly nonce?: string
  readonly tcp?: { readonly host?: string; readonly port?: number } | boolean | null
  readonly tailscaleHost?: string
  readonly tailscaleOwnerLogin?: string
  readonly allowHosts?: readonly string[]
  readonly boardUrl?: string
  readonly oidc?: OidcConfig
  /** Idle auto-exit in seconds (default 600; 0 disables like --no-idle-exit). */
  readonly idleExitS?: number
  /** Exact millisecond override for idle auto-exit (primarily for fast deterministic tests). */
  readonly idleExitMs?: number
  readonly authEnforce?: boolean
  readonly allowUnsafeFs?: boolean
  readonly requireExplicitGrants?: boolean
  readonly ownerUserId?: string
  readonly ownerHandle?: string
  readonly ownerName?: string
  readonly wake?: Pick<WakeBridgeOptions, 'watch' | 'safetyPollMs' | 'degradedPollMs'>
  readonly tick?: 'lease' | 'owner-only' | 'off'
  readonly tickerOptions?: Pick<TickerOptions, 'intervalMs' | 'ttlMs' | 'jitter'>
  readonly uiHandler?: UiHandler
  readonly mode?: 'daemon' | 'service'
  readonly drainTimeoutMs?: number
  readonly sseKeepAliveMs?: number
  readonly sseMaxDurationMs?: number
  readonly maxBodyBytes?: number
  readonly registerSignals?: boolean
  readonly onLog?: (line: string) => void
}

export interface BoundTcpInfo {
  readonly host: string
  readonly port: number
  readonly url: string
}

export interface DaemonHandle {
  readonly paths: DaemonPaths
  readonly endpoint: EndpointRecord
  readonly hello: DaemonHelloPayload
  readonly tcp: BoundTcpInfo | null
  readonly board: BoardService
  readonly authenticator: Authenticator
  readonly handler: ServerHandler
  readonly done: Promise<void>
  listenTcp(opts?: { readonly host?: string; readonly port?: number }): Promise<BoundTcpInfo>
  retire(reason?: string): Promise<void>
  close(): Promise<void>
}

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

function listenServer(server: Server, target: { readonly path: string } | { readonly host: string; readonly port: number }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    if ('path' in target) {
      server.listen(target.path)
    } else {
      server.listen(target.port, target.host)
    }
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      server.close(() => resolve())
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections()
      }
    } catch {
      resolve()
    }
  })
}

/**
 * Starts a Swarmboard daemon instance (UDS/pipe + optional loopback TCP + WakeBridge + Ticker +
 * RealtimeHub + FIFO WriteQueue + idle auto-exit + clean drain).
 */
export async function runDaemonServer(opts: RunDaemonOptions): Promise<DaemonHandle> {
  // Validate mutually exclusive remote/proxy options before opening any resources.
  validateListenerConfig({
    ...(opts.tailscaleHost !== undefined ? { tailscaleHost: opts.tailscaleHost } : {}),
    ...(opts.allowHosts !== undefined ? { allowHosts: opts.allowHosts } : {}),
  })

  const log = opts.onLog ?? (() => {})
  const mode = opts.mode ?? 'daemon'
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  const idleExitMs =
    opts.idleExitMs !== undefined
      ? Math.max(0, Math.floor(opts.idleExitMs))
      : opts.idleExitS !== undefined
        ? Math.max(0, Math.round(opts.idleExitS * 1000))
        : DEFAULT_IDLE_EXIT_S * 1000
  const idleExitS = idleExitMs > 0 ? Math.max(1, Math.round(idleExitMs / 1000)) : 0
  const nonce = opts.nonce ?? randomBytes(16).toString('hex')
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()

  const absDb = nodePath.resolve(opts.db)
  const opened = openBoardStore(
    { kind: 'file', db: absDb, dir: nodePath.dirname(absDb), defaultDir: false },
    { allowUnsafeFs: opts.allowUnsafeFs ?? false },
  )

  const dbPath = opened.paths?.db ?? absDb
  const bp = boardPaths(dbPath)
  const paths = daemonPaths(dbPath, {
    ...(opts.runDir !== undefined ? { runDirOverride: opts.runDir } : {}),
  })
  ensureSecureRunDir(paths)

  const bridge = new WakeBridge(opened.store, {
    watch: opts.wake?.watch ?? true,
    ...(opts.wake?.safetyPollMs !== undefined ? { safetyPollMs: opts.wake.safetyPollMs } : {}),
    ...(opts.wake?.degradedPollMs !== undefined ? { degradedPollMs: opts.wake.degradedPollMs } : {}),
    onError: (err, site) => {
      log(`[wake:${site}] ${err instanceof Error ? err.message : String(err)}`)
    },
  })

  const board = new BoardService(opened.store, bridge.serviceOptions())
  let ticker: Ticker | null = null
  const queue = new WriteQueue()
  const hub = new RealtimeHub(board, {
    ...(opts.sseKeepAliveMs !== undefined ? { keepAliveMs: opts.sseKeepAliveMs } : {}),
    ...(opts.sseMaxDurationMs !== undefined ? { maxDurationMs: opts.sseMaxDurationMs } : {}),
  })

  let boundTcp: BoundTcpInfo | null = null
  let tcpServer: Server | null = null
  let udsServer: Server | null = null
  let inFlightRequests = 0
  let inFlightDrainWaiters: Array<() => void> = []
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let lastActivityMs = Date.now()
  let retirePromise: Promise<void> | null = null
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const tokens = new TokenStore(opened.store)
  const authenticator = new Authenticator({
    store: opened.store,
    tokens,
    authEnforce: opts.authEnforce ?? false,
    boardDir: bp.dir,
    ...(opts.requireExplicitGrants !== undefined ? { requireExplicitGrants: opts.requireExplicitGrants } : {}),
    ...(opts.ownerUserId !== undefined ? { ownerUserId: opts.ownerUserId } : {}),
    ...(opts.ownerHandle !== undefined ? { ownerHandle: opts.ownerHandle } : {}),
    ...(opts.ownerName !== undefined ? { ownerName: opts.ownerName } : {}),
    ...(opts.tailscaleHost !== undefined ? { tailscaleHost: opts.tailscaleHost } : {}),
    ...(opts.tailscaleOwnerLogin !== undefined ? { tailscaleOwnerLogin: opts.tailscaleOwnerLogin } : {}),
    ...(opts.allowHosts !== undefined ? { allowHosts: opts.allowHosts } : {}),
    ...(opts.boardUrl !== undefined ? { boardUrl: opts.boardUrl } : {}),
    ...(opts.oidc !== undefined ? { oidc: opts.oidc } : {}),
  })

  const buildHello = (): DaemonHelloPayload => {
    const info = board.boardInfo()
    return Object.freeze({
      protocol: Object.freeze([PROTOCOL_VERSION, PROTOCOL_VERSION] as const),
      build: `swarmboard ${CLIENT_VERSION}`,
      pid: process.pid,
      nonce,
      boardId: info.boardId,
      instanceId: info.instanceId,
      schema: info.schema?.version ?? 0,
      db: Object.freeze({ realpath: paths.dbRealpath, dev: paths.dbDev, ino: paths.dbIno }),
      sidecars: Object.freeze({ wakeup: bp.wakeup, jsonl: bp.jsonl }),
      tcp: boundTcp !== null ? Object.freeze({ host: boundTcp.host, port: boundTcp.port }) : null,
      startedAt,
      idleExitS,
      capabilities: Object.freeze(['sse', 'rpc', 'v2', 'tcp-on-demand']),
    })
  }

  const buildEndpoint = (): EndpointRecord => {
    const info = board.boardInfo()
    return Object.freeze({
      protocol: Object.freeze([PROTOCOL_VERSION, PROTOCOL_VERSION] as const),
      build: `swarmboard ${CLIENT_VERSION}`,
      pid: process.pid,
      nonce,
      socket: paths.transport === 'uds' ? nodePath.basename(paths.socketPath) : paths.socketPath,
      boardId: info.boardId,
      instanceId: info.instanceId,
      schema: info.schema?.version ?? 0,
      db: Object.freeze({ realpath: paths.dbRealpath, dev: paths.dbDev, ino: paths.dbIno }),
      tcp: boundTcp !== null ? Object.freeze({ host: boundTcp.host, port: boundTcp.port }) : null,
      startedAt,
      idleExitS,
    })
  }

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  const armIdleTimer = (): void => {
    clearIdleTimer()
    if (idleExitMs <= 0 || retirePromise !== null) return
    // Idle exit is vetoed while any request is in flight or any SSE stream is open.
    if (inFlightRequests > 0 || hub.activeStreams > 0) return
    const elapsed = Date.now() - lastActivityMs
    const waitMs = Math.max(10, idleExitMs - elapsed)
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (retirePromise !== null) return
      if (inFlightRequests > 0 || hub.activeStreams > 0) return
      if (Date.now() - lastActivityMs < idleExitMs) {
        armIdleTimer()
        return
      }
      log(`[daemon] idle timeout reached (${idleExitMs}ms); retiring`)
      void retire('idle')
    }, waitMs)
    idleTimer.unref()
  }

  const noteActivity = (): void => {
    lastActivityMs = Date.now()
    armIdleTimer()
  }

  const onRequestStart = (): void => {
    inFlightRequests += 1
    lastActivityMs = Date.now()
    clearIdleTimer()
  }

  const onRequestEnd = (): void => {
    inFlightRequests = Math.max(0, inFlightRequests - 1)
    lastActivityMs = Date.now()
    if (inFlightRequests === 0) {
      const waiters = inFlightDrainWaiters
      inFlightDrainWaiters = []
      for (const w of waiters) w()
      armIdleTimer()
    }
  }

  const unsubStreams = hub.onStreamCountChange((count) => {
    lastActivityMs = Date.now()
    if (count > 0) clearIdleTimer()
    else armIdleTimer()
  })

  const waitInFlightZero = (timeoutMs: number): Promise<void> => {
    if (inFlightRequests === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        inFlightDrainWaiters = inFlightDrainWaiters.filter((w) => w !== onZero)
        resolve()
      }, timeoutMs)
      timer.unref()
      const onZero = (): void => {
        clearTimeout(timer)
        resolve()
      }
      inFlightDrainWaiters.push(onZero)
    })
  }

  const startTcpListener = async (tcpOpts?: {
    readonly host?: string
    readonly port?: number
  }): Promise<BoundTcpInfo> => {
    if (boundTcp !== null) return boundTcp
    const host = tcpOpts?.host ?? DEFAULT_TCP_HOST
    const port = tcpOpts?.port ?? DEFAULT_TCP_PORT
    const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'
    const listenerClass: ServerListenerContext['listener'] = opts.tailscaleHost
      ? 'tailscale'
      : isLoopback
        ? 'tcp-loopback'
        : 'https'

    const srv = createServer()
    let actualPort = port
    attachNodeHandler(
      srv,
      handler,
      () => ({
        listener: listenerClass,
        port: actualPort,
        ...(opts.tailscaleHost !== undefined ? { tailscaleHost: opts.tailscaleHost } : {}),
        ...(opts.allowHosts !== undefined ? { allowHosts: opts.allowHosts } : {}),
        ...(opts.boardUrl !== undefined ? { boardUrl: opts.boardUrl } : {}),
      }),
      {
        ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
        onRequestStart,
        onRequestEnd,
      },
    )

    try {
      await listenServer(srv, { host, port })
    } catch (err) {
      if (codeOf(err) === 'EADDRINUSE') {
        throw clientError('unavailable', `port ${port} on ${host} is already in use`, {
          hint: 'pass --port <other> or stop the process using this port',
          details: { code: 'port_taken', host, port },
          cause: err,
        })
      }
      throw err
    }

    const addr = srv.address() as AddressInfo | null
    actualPort = addr?.port ?? port
    tcpServer = srv
    const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    boundTcp = Object.freeze({
      host,
      port: actualPort,
      url: `http://${urlHost}:${actualPort}`,
    })
    writeEndpointAtomic(paths, buildEndpoint())
    log(`[daemon] TCP listener bound at ${boundTcp.url}`)
    return boundTcp
  }

  const handler = createServerHandler({
    board,
    authenticator,
    writeQueue: queue,
    realtimeHub: hub,
    mode,
    startedAtMs,
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    uiHandler: opts.uiHandler ?? createUiHandler(),
    control: {
      hello: buildHello,
      status: () => ({
        inFlightRequests,
        idleExitS,
        wake: bridge.status(),
        tick: ticker?.status() ?? null,
        tcp: boundTcp,
        socketPath: paths.socketPath,
      }),
      retire: (reason) => {
        // Schedule drain right after this HTTP response flushes.
        setImmediate(() => {
          void retire(reason ?? 'api-retire')
        })
        return { retiring: true as const }
      },
      listenTcp: startTcpListener,
      onActivity: noteActivity,
    },
  })

  const onSigTerm = (): void => {
    log('[daemon] received SIGTERM; draining')
    void retire('sigterm')
  }
  const onSigInt = (): void => {
    log('[daemon] received SIGINT; draining')
    void retire('sigint')
  }

  const cleanupSignals = (): void => {
    if (opts.registerSignals === true) {
      process.off('SIGTERM', onSigTerm)
      process.off('SIGINT', onSigInt)
    }
  }

  const retire = (reason = 'retire'): Promise<void> => {
    if (retirePromise !== null) return retirePromise
    retirePromise = (async () => {
      log(`[daemon] retiring (${reason})`)
      clearIdleTimer()
      unsubStreams()
      cleanupSignals()

      // 1. Rename endpoint.json -> endpoint.retiring so new clients go to election.
      try {
        if (fs.existsSync(paths.endpointFile)) {
          fs.renameSync(paths.endpointFile, paths.retiringFile)
        }
      } catch {
        // best effort
      }

      // 2. Notify SSE streams with `event: shutdown` so long-lived tabs close cleanly.
      hub.shutdown(reason)

      // 3. Stop accepting new connections.
      const closePromises: Promise<void>[] = []
      if (udsServer !== null) closePromises.push(closeServer(udsServer))
      if (tcpServer !== null) closePromises.push(closeServer(tcpServer))

      // 4. Wait up to drainTimeoutMs for in-flight HTTP requests & queued writes.
      await Promise.race([
        Promise.all([waitInFlightZero(drainTimeoutMs), queue.drain()]),
        new Promise<void>((r) => {
          const t = setTimeout(r, drainTimeoutMs)
          t.unref()
        }),
      ])

      handler.close()
      if (udsServer !== null && typeof udsServer.closeAllConnections === 'function') {
        udsServer.closeAllConnections()
      }
      if (tcpServer !== null && typeof tcpServer.closeAllConnections === 'function') {
        tcpServer.closeAllConnections()
      }
      await Promise.all(closePromises)

      // 5. Stop Ticker (releases tick lease) and WakeBridge before closing store.
      try {
        ticker?.stop()
      } catch {
        // best effort
      }
      try {
        bridge.stop()
      } catch {
        // best effort
      }
      try {
        hub.close()
      } catch {
        // best effort
      }

      // 6. WAL checkpoint (TRUNCATE) for clean on-disk state.
      if (opened.writable) {
        try {
          opened.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
        } catch {
          // ignore if store closed or busy
        }
      }

      // 7. Close SQLite store.
      try {
        opened.close()
      } catch {
        // already closed
      }

      // 8. Unlink socket and retiring marker.
      if (paths.transport === 'uds') {
        try {
          fs.unlinkSync(paths.socketPath)
        } catch {
          // ignore ENOENT
        }
      }
      try {
        fs.unlinkSync(paths.retiringFile)
      } catch {
        // ignore ENOENT
      }

      resolveDone()
    })()
    return retirePromise
  }

  // Startup sequence: bind UDS, chmod 0600, optionally bind TCP, start WakeBridge & Ticker, publish endpoint.json.
  try {
    udsServer = createServer()
    attachNodeHandler(
      udsServer,
      handler,
      { listener: paths.transport },
      {
        ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
        onRequestStart,
        onRequestEnd,
      },
    )

    await listenServer(udsServer, { path: paths.socketPath })
    if (paths.transport === 'uds') {
      fs.chmodSync(paths.socketPath, 0o600)
    }

    bridge.start()
    bridge.onReset(() => {
      hub.invalidateCaches()
    })
    bridge.onStop((stop) => {
      if (stop.reason === 'replaced') {
        log('[daemon] database file was replaced; retiring daemon')
        void retire('db-replaced')
      }
    })

    if (opts.tick !== 'off') {
      ticker = new Ticker(board, {
        ...opts.tickerOptions,
        onError: (err, site) => {
          log(`[tick:${site}] ${err instanceof Error ? err.message : String(err)}`)
        },
      })
      ticker.start()
    }

    if (opts.tcp !== undefined && opts.tcp !== null && opts.tcp !== false) {
      const tcpCfg = opts.tcp === true ? { host: DEFAULT_TCP_HOST, port: DEFAULT_TCP_PORT } : opts.tcp
      await startTcpListener(tcpCfg)
    }

    const endpoint = buildEndpoint()
    writeEndpointAtomic(paths, endpoint)

    if (opts.registerSignals === true) {
      process.on('SIGTERM', onSigTerm)
      process.on('SIGINT', onSigInt)
    }

    armIdleTimer()
    log(`[daemon] listening on ${paths.socketPath} (pid=${process.pid}, idleExitMs=${idleExitMs})`)

    return {
      paths,
      get endpoint() {
        return buildEndpoint()
      },
      get hello() {
        return buildHello()
      },
      get tcp() {
        return boundTcp
      },
      board,
      authenticator,
      handler,
      done,
      listenTcp: startTcpListener,
      retire,
      close: () => retire('close'),
    }
  } catch (err) {
    // Clean up partially started resources on startup failure (e.g. EADDRINUSE).
    clearIdleTimer()
    unsubStreams()
    try {
      ticker?.stop()
    } catch {
      // ignore
    }
    try {
      bridge.stop()
    } catch {
      // ignore
    }
    try {
      hub.close()
    } catch {
      // ignore
    }
    handler.close()
    if (tcpServer !== null) await closeServer(tcpServer)
    if (udsServer !== null) await closeServer(udsServer)
    try {
      opened.close()
    } catch {
      // ignore
    }
    throw err
  }
}
