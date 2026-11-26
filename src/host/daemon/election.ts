// HOST-10 daemon election, probing, spawn backoff, and lifecycle control (Swarmboard v2 launch design §4.3).
//
// Election protocol (connect-first, lock-to-start, bind-is-truth):
// 1. Read endpoint.json -> probe GET /_swarm/v1/hello over UDS (2 s timeout) -> verify boardId,
//    db.dev:ino, sidecars, and overlapping protocol range.
// 2. If unreachable and backoff.json window is active -> refuse spawn (caller falls back per policy).
// 3. Atomic `mkdir start.lock`; steal if owner.json PID is dead (ESRCH) or lock age > 15 s.
// 4. Double-check probe under lock; unlink stale b.sock; spawn detached daemon with scrubbed env
//    (dropping SWARMBOARD_AGENT, BOARD_PROFILE, SWARMBOARD_TOKEN, BOARD_TOKEN, FUSION_*), stdio ->
//    daemon.log, windowsHide: true, .unref().
// 5. Wait <= 5 s for endpoint.json matching nonce + live hello; release start.lock; on failure
//    write backoff.json (30 s doubling to 10 min).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { request as httpRequest } from 'node:http'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientError } from '../../client/errors.ts'
import { processContext, type Env } from '../../client/resolve.ts'
import { PROTOCOL_VERSION } from '../../client/version.ts'
import type { DaemonHelloPayload } from '../../server/types.ts'
import { boardPaths, checkLocation, probeLocation } from '../layout.ts'
import { daemonPaths, ensureSecureRunDir, type DaemonPaths, type DaemonPathsOptions } from './paths.ts'

export const DEFAULT_HELLO_TIMEOUT_MS = 2_000
export const DEFAULT_SPAWN_TIMEOUT_MS = 5_000
export const DEFAULT_LOCK_STALE_MS = 15_000
export const BACKOFF_BASE_S = 30
export const BACKOFF_MAX_S = 600
const LOG_ROTATE_BYTES = 1024 * 1024

export interface EndpointRecord {
  readonly protocol: readonly [number, number]
  readonly build: string
  readonly pid: number
  readonly nonce: string
  readonly socket: string
  readonly boardId: string | null
  readonly instanceId: string | null
  readonly schema: number
  readonly db: { readonly realpath: string; readonly dev: number; readonly ino: number }
  readonly tcp: { readonly host: string; readonly port: number } | null
  readonly startedAt: string
  readonly idleExitS: number
}

export interface BackoffRecord {
  readonly until: number
  readonly delayS: number
  readonly reason: string
  readonly updatedAt: string
}

export type DaemonProbeResult =
  | { readonly status: 'absent'; readonly paths: DaemonPaths | null }
  | { readonly status: 'stale'; readonly paths: DaemonPaths; readonly endpoint: EndpointRecord }
  | {
      readonly status: 'live'
      readonly paths: DaemonPaths
      readonly endpoint: EndpointRecord
      readonly hello: DaemonHelloPayload
    }
  | {
      readonly status: 'incompatible_older' | 'incompatible_newer' | 'mismatch'
      readonly paths: DaemonPaths
      readonly endpoint: EndpointRecord
      readonly hello: DaemonHelloPayload
      readonly reason: string
    }

export interface EnsureDaemonOptions extends DaemonPathsOptions {
  readonly tcp?: { readonly host?: string; readonly port?: number } | boolean | null
  readonly idleExitS?: number
  readonly authEnforce?: boolean
  readonly allowUnsafeFs?: boolean
  readonly spawnTimeoutMs?: number
  readonly helloTimeoutMs?: number
  readonly ignoreBackoff?: boolean
  readonly daemonScript?: string
}

export interface EnsureDaemonResult {
  readonly paths: DaemonPaths
  readonly endpoint: EndpointRecord
  readonly hello: DaemonHelloPayload
  readonly spawned: boolean
}

export interface StartDaemonOptions extends EnsureDaemonOptions {}

export interface DaemonStatusResult {
  readonly running: boolean
  readonly paths: DaemonPaths | null
  readonly endpoint: EndpointRecord | null
  readonly hello: DaemonHelloPayload | null
  readonly status: Record<string, unknown> | null
  readonly backoff: BackoffRecord | null
  readonly logFile: string | null
}

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Must stay ref'd so standalone CLI processes awaiting daemon election/stop do not exit early.
    setTimeout(resolve, ms)
  })
}

/** True when `pid` still exists according to `process.kill(pid, 0)`. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = codeOf(err)
    return code === 'EPERM'
  }
}

/**
 * Scrubs caller environment before spawning a detached daemon that outlives any single agent.
 * Drops `SWARMBOARD_AGENT`, `BOARD_PROFILE`, `SWARMBOARD_TOKEN`, `BOARD_TOKEN`, and all `FUSION_*`.
 */
export function scrubDaemonEnv(env: Env): Record<string, string> {
  const KEEP_EXACT: ReadonlySet<string> = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'USERNAME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'TZ',
    'NODE_COMPILE_CACHE',
    'NODE_OPTIONS',
    'SYSTEMROOT',
    'COMSPEC',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ])
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(env)) {
    if (val === undefined) continue
    if (
      key === 'SWARMBOARD_AGENT' ||
      key === 'BOARD_PROFILE' ||
      key === 'SWARMBOARD_TOKEN' ||
      key === 'BOARD_TOKEN' ||
      key === 'SWARMBOARD_PARENT' ||
      key === 'SWARMBOARD_SWARM' ||
      key.startsWith('FUSION_')
    ) {
      continue
    }
    if (KEEP_EXACT.has(key) || key.startsWith('XDG_') || key.startsWith('LC_')) {
      out[key] = val
    }
  }
  return out
}

/** Reads `<runDir>/endpoint.json`, returning null if missing or malformed. */
export function readEndpoint(paths: DaemonPaths): EndpointRecord | null {
  try {
    const text = fs.readFileSync(paths.endpointFile, 'utf8')
    const raw = JSON.parse(text) as Partial<EndpointRecord>
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !Array.isArray(raw.protocol) ||
      typeof raw.pid !== 'number' ||
      typeof raw.nonce !== 'string' ||
      typeof raw.socket !== 'string'
    ) {
      return null
    }
    return raw as EndpointRecord
  } catch {
    return null
  }
}

/** Atomically writes `endpoint.json` (temp file mode 0600 + rename). */
export function writeEndpointAtomic(paths: DaemonPaths, record: EndpointRecord): void {
  const tmp = `${paths.endpointFile}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, paths.endpointFile)
  try {
    fs.chmodSync(paths.endpointFile, 0o600)
  } catch {
    // best effort
  }
}

/** Reads `<runDir>/backoff.json`, returning null if absent or expired. */
export function readBackoff(paths: DaemonPaths, nowMs = Date.now()): BackoffRecord | null {
  try {
    const text = fs.readFileSync(paths.backoffFile, 'utf8')
    const raw = JSON.parse(text) as Partial<BackoffRecord>
    if (typeof raw?.until !== 'number' || typeof raw?.delayS !== 'number') return null
    if (raw.until <= nowMs) return null
    return {
      until: raw.until,
      delayS: raw.delayS,
      reason: typeof raw.reason === 'string' ? raw.reason : 'spawn_failed',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(nowMs).toISOString(),
    }
  } catch {
    return null
  }
}

function writeBackoff(paths: DaemonPaths, reason: string, nowMs = Date.now()): BackoffRecord {
  let prevDelay = 0
  try {
    const raw = JSON.parse(fs.readFileSync(paths.backoffFile, 'utf8')) as { delayS?: number }
    if (typeof raw?.delayS === 'number' && Number.isFinite(raw.delayS)) prevDelay = raw.delayS
  } catch {
    // none
  }
  const delayS = prevDelay > 0 ? Math.min(BACKOFF_MAX_S, prevDelay * 2) : BACKOFF_BASE_S
  const record: BackoffRecord = {
    until: nowMs + delayS * 1000,
    delayS,
    reason,
    updatedAt: new Date(nowMs).toISOString(),
  }
  try {
    const tmp = `${paths.backoffFile}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, paths.backoffFile)
  } catch {
    // best effort
  }
  return record
}

function clearBackoff(paths: DaemonPaths): void {
  try {
    fs.unlinkSync(paths.backoffFile)
  } catch {
    // ignore ENOENT
  }
}

/** Low-level UDS/pipe JSON request helper for `/_swarm/v1/*` control calls. */
export function udsControlRequest<T = unknown>(
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  opts: { readonly body?: unknown; readonly timeoutMs?: number; readonly token?: string } = {},
): Promise<{ readonly status: number; readonly data: T | null }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    const headers: Record<string, string> = {
      host: 'localhost',
      ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
    }
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload, 'utf8'))
    }

    let settled = false
    const done = (err: unknown, value?: { status: number; data: T | null }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err !== null) reject(err)
      else resolve(value!)
    }

    const req = httpRequest(
      {
        socketPath,
        method,
        path,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let data: T | null = null
          try {
            data = text === '' ? null : (JSON.parse(text) as T)
          } catch {
            data = null
          }
          done(null, { status: res.statusCode ?? 500, data })
        })
        res.on('error', (err) => done(err))
      },
    )

    const timer = setTimeout(() => {
      req.destroy()
      done(new Error(`control request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()

    req.on('error', (err) => done(err))
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** Probes `GET /_swarm/v1/hello` on a daemon UDS/pipe with a 2 s default timeout. */
export async function probeUdsHello(
  socketPath: string,
  timeoutMs = DEFAULT_HELLO_TIMEOUT_MS,
): Promise<DaemonHelloPayload | null> {
  try {
    const res = await udsControlRequest<DaemonHelloPayload>(socketPath, 'GET', '/_swarm/v1/hello', { timeoutMs })
    if (res.status !== 200 || res.data === null || !Array.isArray(res.data.protocol)) return null
    return res.data
  } catch {
    return null
  }
}

function readManifestBoardId(dbPath: string): string | null {
  try {
    const text = fs.readFileSync(`${dbPath}.manifest.json`, 'utf8')
    const parsed = JSON.parse(text) as { boardId?: unknown }
    return typeof parsed?.boardId === 'string' ? parsed.boardId : null
  } catch {
    return null
  }
}

/**
 * Probes whether a compatible live daemon is currently serving `dbPath`.
 * Performs ZERO filesystem writes (safe in read-only / pre-open checks).
 */
export async function probeDaemon(
  dbPath: string,
  opts: DaemonPathsOptions & { readonly helloTimeoutMs?: number } = {},
): Promise<DaemonProbeResult> {
  if (!fs.existsSync(dbPath)) {
    return { status: 'absent', paths: null }
  }
  const paths = daemonPaths(dbPath, opts)
  const endpoint = readEndpoint(paths)
  if (endpoint === null) {
    return { status: 'absent', paths }
  }

  const hello = await probeUdsHello(paths.socketPath, opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS)
  if (hello === null) {
    return { status: 'stale', paths, endpoint }
  }

  // Verify DB inode/dev, sidecars, and manifest boardId.
  if (hello.db.dev !== paths.dbDev || hello.db.ino !== paths.dbIno) {
    return {
      status: 'mismatch',
      paths,
      endpoint,
      hello,
      reason: `daemon serves different db inode (${hello.db.dev}:${hello.db.ino} != ${paths.dbDev}:${paths.dbIno})`,
    }
  }
  const bp = boardPaths(paths.dbRealpath)
  if (hello.sidecars.wakeup !== bp.wakeup || hello.sidecars.jsonl !== bp.jsonl) {
    return {
      status: 'mismatch',
      paths,
      endpoint,
      hello,
      reason: 'daemon sidecar paths differ from expected board sidecars',
    }
  }
  const manifestBoardId = readManifestBoardId(paths.dbRealpath)
  if (manifestBoardId !== null && hello.boardId !== null && hello.boardId !== manifestBoardId) {
    return {
      status: 'mismatch',
      paths,
      endpoint,
      hello,
      reason: `daemon boardId ${hello.boardId} does not match manifest ${manifestBoardId}`,
    }
  }

  const [minProto, maxProto] = hello.protocol
  if (PROTOCOL_VERSION > maxProto) {
    return {
      status: 'incompatible_older',
      paths,
      endpoint,
      hello,
      reason: `daemon protocol max ${maxProto} < client ${PROTOCOL_VERSION}`,
    }
  }
  if (PROTOCOL_VERSION < minProto) {
    return {
      status: 'incompatible_newer',
      paths,
      endpoint,
      hello,
      reason: `daemon protocol min ${minProto} > client ${PROTOCOL_VERSION}`,
    }
  }

  return { status: 'live', paths, endpoint, hello }
}

/** Resolves the daemon entrypoint script (works both in `src/` dev/test and bundled `dist/`). */
export function resolveDaemonEntrypoint(override?: string): string {
  if (override !== undefined) return override
  const here = fileURLToPath(import.meta.url)
  const dir = nodePath.dirname(here)
  if (here.endsWith('.mjs') || here.endsWith('.js')) {
    const builtSibling = nodePath.resolve(dir, 'bin', 'swarmboard-daemon.mjs')
    if (fs.existsSync(builtSibling)) return builtSibling
    const builtUp = nodePath.resolve(dir, '..', 'bin', 'swarmboard-daemon.mjs')
    if (fs.existsSync(builtUp)) return builtUp
  }
  const srcBin = nodePath.resolve(dir, '..', 'bin', 'swarmboard-daemon.ts')
  if (fs.existsSync(srcBin)) return srcBin
  const repoDist = nodePath.resolve(dir, '..', '..', '..', 'dist', 'bin', 'swarmboard-daemon.mjs')
  if (fs.existsSync(repoDist)) return repoDist
  return srcBin
}

function ensureDbFileForElection(
  dbPath: string,
  opts: { readonly allowUnsafeFs?: boolean; readonly platform?: NodeJS.Platform; readonly home?: string; readonly env?: Env; readonly uid?: number | null },
): void {
  const proc = processContext()
  const bp = boardPaths(dbPath)
  const facts = probeLocation(bp, {
    platform: opts.platform ?? proc.platform,
    home: opts.home ?? proc.home,
    env: opts.env ?? proc.env,
    uid: opts.uid !== undefined ? opts.uid : proc.uid,
  })
  const verdict = checkLocation(facts, { allowUnsafeFs: opts.allowUnsafeFs ?? false })
  if (verdict.refusals.length > 0) {
    const reasons = [...new Set(verdict.refusals.map((r) => r.reason))]
    const list = verdict.refusals.map((r) => `${r.reason} (${r.path})`).join(', ')
    throw clientError('unsafe_location', `Swarmboard will not start a daemon here: ${list}`, {
      details: { reasons, kind: verdict.kind },
    })
  }
  const canonicalPaths = boardPaths(facts.canonical)
  if (fs.existsSync(canonicalPaths.db)) return
  if (fs.existsSync(canonicalPaths.manifest)) {
    throw clientError(
      'no_board',
      `the manifest says a board lived at ${canonicalPaths.db}, but the file is gone`,
      { details: { path: canonicalPaths.db, manifest: canonicalPaths.manifest } },
    )
  }
  fs.mkdirSync(canonicalPaths.dir, { recursive: true, mode: 0o700 })
  try {
    const fd = fs.openSync(canonicalPaths.db, 'wx', 0o600)
    fs.closeSync(fd)
  } catch (err) {
    if (codeOf(err) !== 'EEXIST') throw err
  }
}

function openDaemonLogFd(logFile: string): number {
  try {
    const st = fs.statSync(logFile)
    if (st.size > LOG_ROTATE_BYTES) {
      const backup = `${logFile}.1`
      try {
        fs.copyFileSync(logFile, backup)
        fs.truncateSync(logFile, 0)
      } catch {
        // best effort rotation
      }
    }
  } catch {
    // file doesn't exist yet
  }
  return fs.openSync(logFile, 'a', 0o600)
}

function isLockStale(paths: DaemonPaths, staleMs = DEFAULT_LOCK_STALE_MS): boolean {
  try {
    const ownerText = fs.readFileSync(paths.lockOwnerFile, 'utf8')
    const owner = JSON.parse(ownerText) as { pid?: number; at?: number }
    if (typeof owner.pid === 'number' && !isPidAlive(owner.pid)) return true
    if (typeof owner.at === 'number' && Date.now() - owner.at > staleMs) return true
    return false
  } catch {
    // owner.json not yet written (brief race) or corrupted: check lockDir mtime
    try {
      const st = fs.statSync(paths.lockDir)
      return Date.now() - st.mtimeMs > staleMs
    } catch {
      return false
    }
  }
}

function releaseLock(paths: DaemonPaths): void {
  try {
    fs.rmSync(paths.lockDir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

/**
 * Ensures a live, compatible daemon is serving `dbPath`, running atomic `start.lock` election
 * and detached spawn if needed. Safe under heavy concurrent thundering-herd contention.
 */
export async function ensureDaemon(
  dbPath: string,
  opts: EnsureDaemonOptions = {},
): Promise<EnsureDaemonResult> {
  ensureDbFileForElection(dbPath, opts)
  const paths = daemonPaths(dbPath, opts)
  ensureSecureRunDir(paths, opts)

  // Step 1: fast connect-first probe
  const initial = await probeDaemon(paths.dbRealpath, opts)
  if (initial.status === 'live') {
    return { paths: initial.paths, endpoint: initial.endpoint, hello: initial.hello, spawned: false }
  }
  if (initial.status === 'incompatible_newer' || initial.status === 'mismatch') {
    throw clientError('daemon_unavailable', `incompatible daemon running: ${initial.reason}`)
  }
  if (initial.status === 'incompatible_older') {
    await udsControlRequest(paths.socketPath, 'POST', '/_swarm/v1/retire', {
      body: { reason: 'protocol-upgrade' },
      timeoutMs: 1_500,
    }).catch(() => {})
    const retireWait = Date.now() + 2_000
    while (Date.now() < retireWait) {
      if ((await probeUdsHello(paths.socketPath, 300)) === null) break
      await sleepMs(50)
    }
  }

  // Step 2: check backoff window
  if (opts.ignoreBackoff !== true) {
    const backoff = readBackoff(paths)
    if (backoff !== null) {
      throw clientError(
        'daemon_unavailable',
        `daemon spawn backoff active until ${new Date(backoff.until).toISOString()} (${backoff.reason})`,
        { details: { backoff } },
      )
    }
  }

  const spawnTimeoutMs = opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
  const overallDeadline = Date.now() + Math.max(spawnTimeoutMs, 5_000) + 2_000

  // Step 3: atomic mkdir start.lock election loop
  while (Date.now() < overallDeadline) {
    let acquired = false
    try {
      fs.mkdirSync(paths.lockDir, { mode: 0o700 })
      acquired = true
    } catch (err) {
      if (codeOf(err) !== 'EEXIST') throw err
    }

    if (!acquired) {
      if (isLockStale(paths)) {
        releaseLock(paths)
        continue
      }
      // Wait briefly for the lock holder to finish publishing endpoint.json, then re-probe.
      await sleepMs(35)
      const again = await probeDaemon(paths.dbRealpath, {
        ...opts,
        helloTimeoutMs: Math.min(opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS, 1_000),
      })
      if (again.status === 'live') {
        return { paths: again.paths, endpoint: again.endpoint, hello: again.hello, spawned: false }
      }
      continue
    }

    // Lock holder!
    try {
      fs.writeFileSync(
        paths.lockOwnerFile,
        JSON.stringify({ pid: process.pid, at: Date.now() }),
        { mode: 0o600 },
      )

      // Step 4: double-check probe under lock
      const recheck = await probeDaemon(paths.dbRealpath, {
        ...opts,
        helloTimeoutMs: Math.min(opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS, 1_000),
      })
      if (recheck.status === 'live') {
        return { paths: recheck.paths, endpoint: recheck.endpoint, hello: recheck.hello, spawned: false }
      }

      // Safe to unlink stale socket & endpoint files while holding start.lock
      if (paths.transport === 'uds') {
        try {
          fs.unlinkSync(paths.socketPath)
        } catch {
          // ignore ENOENT
        }
      }
      try {
        fs.unlinkSync(paths.endpointFile)
      } catch {
        // ignore ENOENT
      }

      // Step 5: spawn detached daemon with scrubbed env
      const nonce = randomBytes(16).toString('hex')
      const script = resolveDaemonEntrypoint(opts.daemonScript)
      const idleExitS = opts.idleExitS ?? 600
      const childArgs: string[] = [
        '--no-warnings',
        script,
        '--db',
        paths.dbRealpath,
        '--run',
        paths.runDir,
        '--nonce',
        nonce,
      ]
      if (idleExitS <= 0) {
        childArgs.push('--no-idle-exit')
      } else {
        childArgs.push('--idle-exit', String(idleExitS))
      }
      if (opts.tcp !== undefined && opts.tcp !== null && opts.tcp !== false) {
        const tcpCfg = opts.tcp === true ? { host: '127.0.0.1', port: 4180 } : opts.tcp
        childArgs.push('--tcp', `${tcpCfg.host ?? '127.0.0.1'}:${tcpCfg.port ?? 4180}`)
      }
      if (opts.authEnforce === true) {
        childArgs.push('--auth-enforce')
      }
      if (opts.allowUnsafeFs === true) {
        childArgs.push('--allow-unsafe-fs')
      }

      const logFd = openDaemonLogFd(paths.logFile)
      let childExitCode: number | null = null
      let childSpawnErr: Error | null = null
      let childExited = false

      const child = spawn(process.execPath, childArgs, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        env: scrubDaemonEnv(opts.env ?? process.env),
      })
      fs.closeSync(logFd)

      child.once('error', (err) => {
        childSpawnErr = err
        childExited = true
      })
      child.once('exit', (code) => {
        childExitCode = code
        childExited = true
      })
      child.unref()

      // Step 6: wait <= spawnTimeoutMs for endpoint.json matching nonce + live hello
      const waitDeadline = Date.now() + spawnTimeoutMs
      while (Date.now() < waitDeadline) {
        if (childSpawnErr !== null) break
        const ep = readEndpoint(paths)
        if (ep !== null && ep.nonce === nonce) {
          const hello = await probeUdsHello(paths.socketPath, 1_500)
          if (hello !== null && hello.nonce === nonce) {
            clearBackoff(paths)
            return { paths, endpoint: ep, hello, spawned: true }
          }
        }
        if (childExited) {
          if (childExitCode === 0) {
            // Another daemon may have won the socket bind race.
            const raced = await probeDaemon(paths.dbRealpath, opts)
            if (raced.status === 'live') {
              clearBackoff(paths)
              return { paths: raced.paths, endpoint: raced.endpoint, hello: raced.hello, spawned: false }
            }
          }
          break
        }
        await sleepMs(25)
      }

      const reason =
        childSpawnErr !== null
          ? `spawn error: ${(childSpawnErr as Error).message}`
          : childExited
            ? `daemon exited prematurely with code ${String(childExitCode)}`
            : `daemon did not publish endpoint within ${spawnTimeoutMs}ms`
      writeBackoff(paths, reason)
      throw clientError('daemon_unavailable', `failed to start Swarmboard daemon: ${reason}`, {
        hint: `inspect ${paths.logFile} for daemon startup logs`,
        details: { logFile: paths.logFile, reason },
      })
    } finally {
      releaseLock(paths)
    }
  }

  // Final probe if we waited out another starter
  const finalProbe = await probeDaemon(paths.dbRealpath, opts)
  if (finalProbe.status === 'live') {
    return { paths: finalProbe.paths, endpoint: finalProbe.endpoint, hello: finalProbe.hello, spawned: false }
  }
  throw clientError('daemon_unavailable', `timed out waiting for Swarmboard daemon election on ${paths.dbRealpath}`)
}

/**
 * Starts (or ensures) the background daemon for `dbPath`, ignoring any prior backoff window.
 * If `opts.tcp` is requested and an existing daemon does not have TCP enabled yet, calls
 * `POST /_swarm/v1/listen-tcp` to activate it lazily.
 */
export async function startDaemon(
  dbPath: string,
  opts: StartDaemonOptions = {},
): Promise<EnsureDaemonResult> {
  const res = await ensureDaemon(dbPath, { ...opts, ignoreBackoff: true })
  if (opts.tcp !== undefined && opts.tcp !== null && opts.tcp !== false && res.hello.tcp === null) {
    const tcpCfg = opts.tcp === true ? { host: '127.0.0.1', port: 4180 } : opts.tcp
    await udsControlRequest(res.paths.socketPath, 'POST', '/_swarm/v1/listen-tcp', {
      body: {
        ...(tcpCfg.host !== undefined ? { host: tcpCfg.host } : {}),
        ...(tcpCfg.port !== undefined ? { port: tcpCfg.port } : {}),
      },
      timeoutMs: 3_000,
    })
    const refreshed = await probeDaemon(res.paths.dbRealpath, opts)
    if (refreshed.status === 'live') {
      return { paths: refreshed.paths, endpoint: refreshed.endpoint, hello: refreshed.hello, spawned: res.spawned }
    }
  }
  return res
}

/**
 * Gracefully retires a running daemon via `POST /_swarm/v1/retire` and waits for exit.
 */
export async function stopDaemon(
  dbPath: string,
  opts: DaemonPathsOptions & { readonly timeoutMs?: number; readonly force?: boolean; readonly token?: string } = {},
): Promise<{ readonly stopped: boolean; readonly pid: number | null }> {
  const probe = await probeDaemon(dbPath, opts)
  if (probe.status === 'absent') {
    return { stopped: false, pid: null }
  }
  const pid = probe.endpoint.pid
  if (probe.status === 'stale') {
    // Clean up stale endpoint/socket artifacts if process is dead
    if (!isPidAlive(pid)) {
      try {
        fs.unlinkSync(probe.paths.endpointFile)
      } catch {
        // ignore
      }
      if (probe.paths.transport === 'uds') {
        try {
          fs.unlinkSync(probe.paths.socketPath)
        } catch {
          // ignore
        }
      }
      return { stopped: false, pid: null }
    }
  }

  await udsControlRequest(probe.paths.socketPath, 'POST', '/_swarm/v1/retire', {
    body: { reason: 'cli-stop' },
    timeoutMs: 2_000,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
  }).catch(() => {})

  const deadline = Date.now() + (opts.timeoutMs ?? 5_000)
  while (Date.now() < deadline) {
    if (!isPidAlive(pid) && (await probeUdsHello(probe.paths.socketPath, 300)) === null) {
      return { stopped: true, pid }
    }
    await sleepMs(40)
  }

  if (opts.force !== false && isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // ignore ESRCH
    }
    const termDeadline = Date.now() + 2_000
    while (Date.now() < termDeadline) {
      if (!isPidAlive(pid)) return { stopped: true, pid }
      await sleepMs(40)
    }
  }

  return { stopped: !isPidAlive(pid), pid }
}

/**
 * Inspects the running daemon status, endpoint metadata, backoff state, and log path.
 */
export async function daemonStatus(
  dbPath: string,
  opts: DaemonPathsOptions & { readonly token?: string } = {},
): Promise<DaemonStatusResult> {
  const probe = await probeDaemon(dbPath, opts)
  if (probe.status === 'absent') {
    const paths = probe.paths
    return {
      running: false,
      paths,
      endpoint: null,
      hello: null,
      status: null,
      backoff: paths !== null ? readBackoff(paths) : null,
      logFile: paths?.logFile ?? null,
    }
  }
  if (probe.status !== 'live') {
    return {
      running: false,
      paths: probe.paths,
      endpoint: probe.endpoint,
      hello: probe.status === 'stale' ? null : probe.hello,
      status: null,
      backoff: readBackoff(probe.paths),
      logFile: probe.paths.logFile,
    }
  }
  let statusObj: Record<string, unknown> | null = null
  try {
    const res = await udsControlRequest<Record<string, unknown>>(probe.paths.socketPath, 'GET', '/_swarm/v1/status', {
      timeoutMs: 1_500,
      ...(opts.token !== undefined ? { token: opts.token } : {}),
    })
    if (res.status === 200) statusObj = res.data
  } catch {
    // status may require bearer token under authEnforce; hello still confirms live daemon
  }
  return {
    running: true,
    paths: probe.paths,
    endpoint: probe.endpoint,
    hello: probe.hello,
    status: statusObj,
    backoff: readBackoff(probe.paths),
    logFile: probe.paths.logFile,
  }
}
