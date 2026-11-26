// HOST-10 run directory & boardKey path resolution (Swarmboard v2 launch design §4.3).
//
// boardKey = sha256(realpath + "\0" + dev + ":" + ino + "\0" + uid).slice(0, 20)
// - macOS:   ~/.swarmboard/run/<boardKey>/b.sock (0700 dir, 0600 sock, safely < 104-byte sun_path)
// - Linux:   $XDG_RUNTIME_DIR/swarmboard/<boardKey>/b.sock, fallback ~/.swarmboard/run/<boardKey>/b.sock
// - Fallback when socket path > 100 bytes on POSIX: /tmp/swarmboard-<uid>/<boardKey>/b.sock
//            (verified non-symlink, directory, owned by uid, mode 0700)
// - Windows: %LOCALAPPDATA%\swarmboard\run\<boardKey>\ + \\.\pipe\swarmboard-<boardKey>
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { clientError } from '../../client/errors.ts'
import type { Env } from '../../client/resolve.ts'

export const MAX_UNIX_SOCKET_BYTES = 100

export interface DaemonPaths {
  readonly boardKey: string
  readonly dbRealpath: string
  readonly dbDev: number
  readonly dbIno: number
  readonly runDir: string
  readonly socketPath: string
  readonly transport: 'uds' | 'pipe'
  readonly endpointFile: string
  readonly retiringFile: string
  readonly lockDir: string
  readonly lockOwnerFile: string
  readonly backoffFile: string
  readonly logFile: string
}

export interface DaemonPathsOptions {
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly env?: Env
  readonly uid?: number | null
  readonly runDirOverride?: string
  readonly stat?: { readonly dev: number | bigint; readonly ino: number | bigint }
  readonly realpath?: string
}

export interface BoardKeyInfo {
  readonly boardKey: string
  readonly realpath: string
  readonly dev: number
  readonly ino: number
}

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

function currentUid(override?: number | null): number | null {
  if (override !== undefined) return override
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/**
 * Computes the canonical daemon boardKey for a database file:
 * `sha256(realpath + "\0" + dev + ":" + ino + "\0" + uid).slice(0, 20)`.
 */
export function boardKeyFor(dbPath: string, opts: Pick<DaemonPathsOptions, 'uid' | 'stat' | 'realpath'> = {}): BoardKeyInfo {
  let realpath = opts.realpath
  if (realpath === undefined) {
    try {
      realpath = fs.realpathSync(dbPath)
    } catch {
      const dir = nodePath.dirname(dbPath)
      const base = nodePath.basename(dbPath)
      try {
        realpath = nodePath.join(fs.realpathSync(dir), base)
      } catch {
        realpath = nodePath.resolve(dbPath)
      }
    }
  }

  let dev: number
  let ino: number
  if (opts.stat !== undefined) {
    dev = Number(opts.stat.dev)
    ino = Number(opts.stat.ino)
  } else {
    const st = fs.statSync(realpath)
    dev = Number(st.dev)
    ino = Number(st.ino)
  }

  const uid = currentUid(opts.uid)
  const uidPart = uid === null ? '0' : String(uid)
  const digest = createHash('sha256')
    .update(`${realpath}\0${dev}:${ino}\0${uidPart}`, 'utf8')
    .digest('hex')
    .slice(0, 20)

  return Object.freeze({
    boardKey: digest,
    realpath,
    dev,
    ino,
  })
}

function assertSafePosixDir(dir: string, uid: number | null): void {
  let st: fs.Stats
  try {
    st = fs.lstatSync(dir)
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return
    throw err
  }
  if (st.isSymbolicLink()) {
    throw clientError('unsafe_location', `${dir}: daemon run directory must not be a symlink`)
  }
  if (!st.isDirectory()) {
    throw clientError('unsafe_location', `${dir}: daemon run path is not a directory`)
  }
  if (uid !== null && st.uid !== uid) {
    throw clientError('unsafe_location', `${dir}: daemon run directory is owned by another user (uid ${st.uid})`)
  }
  if ((st.mode & 0o077) !== 0) {
    throw clientError('unsafe_location', `${dir}: daemon run directory permissions must be 0700 (got ${(st.mode & 0o777).toString(8)})`)
  }
}

/**
 * Computes the run directory and socket/pipe path for a board file.
 * Pure apart from stat/realpath of `dbPath` and existence check of `XDG_RUNTIME_DIR`.
 */
export function daemonPaths(dbPath: string, opts: DaemonPathsOptions = {}): DaemonPaths {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? os.homedir()
  const env = opts.env ?? process.env
  const uid = currentUid(opts.uid)
  const info = boardKeyFor(dbPath, opts)
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix

  let runDir: string
  let socketPath: string
  let transport: 'uds' | 'pipe'

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || P.join(home, 'AppData', 'Local')
    runDir = opts.runDirOverride ?? P.join(localAppData, 'swarmboard', 'run', info.boardKey)
    socketPath = `\\\\.\\pipe\\swarmboard-${info.boardKey}`
    transport = 'pipe'
  } else {
    transport = 'uds'
    if (opts.runDirOverride !== undefined) {
      runDir = opts.runDirOverride
    } else if (platform === 'linux') {
      const xdg = env.XDG_RUNTIME_DIR?.trim()
      if (xdg && P.isAbsolute(xdg) && fs.existsSync(xdg)) {
        runDir = P.join(xdg, 'swarmboard', info.boardKey)
      } else {
        runDir = P.join(home, '.swarmboard', 'run', info.boardKey)
      }
    } else {
      runDir = P.join(home, '.swarmboard', 'run', info.boardKey)
    }

    socketPath = P.join(runDir, 'b.sock')
    if (opts.runDirOverride === undefined && Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_BYTES) {
      const uidTag = uid === null ? 'local' : String(uid)
      const fallbackRoot = P.join('/tmp', `swarmboard-${uidTag}`)
      assertSafePosixDir(fallbackRoot, uid)
      runDir = P.join(fallbackRoot, info.boardKey)
      socketPath = P.join(runDir, 'b.sock')
    }
  }

  return Object.freeze({
    boardKey: info.boardKey,
    dbRealpath: info.realpath,
    dbDev: info.dev,
    dbIno: info.ino,
    runDir,
    socketPath,
    transport,
    endpointFile: P.join(runDir, 'endpoint.json'),
    retiringFile: P.join(runDir, 'endpoint.retiring'),
    lockDir: P.join(runDir, 'start.lock'),
    lockOwnerFile: P.join(runDir, 'start.lock', 'owner.json'),
    backoffFile: P.join(runDir, 'backoff.json'),
    logFile: P.join(runDir, 'daemon.log'),
  })
}

/**
 * Ensures the daemon run directory (and `/tmp/swarmboard-<uid>` parent if used) exists with mode `0700`
 * and passes symlink, owner, and mode hygiene checks on POSIX.
 */
export function ensureSecureRunDir(
  paths: DaemonPaths,
  opts: { readonly uid?: number | null; readonly platform?: NodeJS.Platform } = {},
): void {
  const platform = opts.platform ?? process.platform
  const uid = currentUid(opts.uid)

  if (platform !== 'win32') {
    const parent = nodePath.dirname(paths.runDir)
    if (nodePath.basename(parent).startsWith('swarmboard-') && nodePath.dirname(parent) === '/tmp') {
      assertSafePosixDir(parent, uid)
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
      try {
        fs.chmodSync(parent, 0o700)
      } catch {
        // best effort
      }
      assertSafePosixDir(parent, uid)
    }
  }

  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })

  if (platform !== 'win32') {
    const st = fs.lstatSync(paths.runDir)
    if (st.isSymbolicLink()) {
      throw clientError('unsafe_location', `${paths.runDir}: daemon run directory must not be a symlink`)
    }
    if (!st.isDirectory()) {
      throw clientError('unsafe_location', `${paths.runDir}: daemon run path is not a directory`)
    }
    if (uid !== null && st.uid !== uid) {
      throw clientError('unsafe_location', `${paths.runDir}: daemon run directory is owned by another user (uid ${st.uid})`)
    }
    if ((st.mode & 0o077) !== 0) {
      fs.chmodSync(paths.runDir, 0o700)
      const after = fs.lstatSync(paths.runDir)
      if ((after.mode & 0o077) !== 0) {
        throw clientError('unsafe_location', `${paths.runDir}: could not lock daemon run directory to 0700`)
      }
    }
  }
}
