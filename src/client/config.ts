// Project and user config (HOST123_DESIGN 4.2, g1 section 4). Thin: node:path and ./errors.ts only at runtime.
// Everything here is pure apart from the injected ResolverFs reads; nothing is written, nothing is spawned.
import * as nodePath from 'node:path'
import { clientError, isBoardError } from './errors.ts'
import type { Env, ExplainStep, ResolverFs } from './resolve.ts'

export type ModePolicy = 'auto' | 'file' | 'daemon' | 'service'
export type TickPolicy = 'lease' | 'owner-only' | 'off'

export interface ProjectConfig {
  readonly version: 1
  readonly db?: string
  readonly mode?: ModePolicy
  readonly daemon?: { readonly idleExitS?: number; readonly spawn?: 'on-demand' | 'never' }
  readonly tick?: TickPolicy
  readonly wake?: { readonly watch?: boolean; readonly safetyPollMs?: number }
  readonly auth?: { readonly enforce?: boolean }
}
export type UserBoardEntry =
  | { readonly url: string; readonly auth?: 'oidc' | 'bearer' }
  | { readonly db: string; readonly mode?: ModePolicy }
export interface UserConfig {
  readonly version: 1
  readonly boards?: Readonly<Record<string, UserBoardEntry>>
  readonly default?: string
  readonly allowUnsafeFs?: boolean
  readonly tick?: TickPolicy
  readonly wake?: ProjectConfig['wake']
  readonly daemon?: ProjectConfig['daemon']
  /** A user config can also tighten auth (HS-28: enforce is an OR across sources). */
  readonly auth?: ProjectConfig['auth']
  /** A later slice owns its shape; parsed opaquely, never interpreted here. */
  readonly service?: unknown
}
export interface Parsed<T> {
  readonly value: T
  readonly warnings: readonly ExplainStep[]
}

export const MODE_POLICIES: readonly ModePolicy[] = ['auto', 'file', 'daemon', 'service']
export const BOARD_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const TICKS: readonly TickPolicy[] = ['lease', 'owner-only', 'off']
const SPAWNS = ['on-demand', 'never'] as const
const AUTHS = ['oidc', 'bearer'] as const
/** Keys a project config may never carry, at any depth: a cloned repository must not redirect agents. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'url', 'host', 'token', 'boards', 'default', 'tcp', 'lan', 'tailscale', 'service', 'allowunsafefs', 'jsonl', 'wakeup',
])

export type PathModule = typeof nodePath.posix

/** The path flavour for a platform. */
export function pathForPlatform(platform: NodeJS.Platform): PathModule {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix
}
/** The path flavour a path was written in (a drive letter or a UNC prefix means win32). */
export function pathForSample(sample: string): PathModule {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(sample) ? nodePath.win32 : nodePath.posix
}

// ---------------------------------------------------------------------------------------------------------------
// Shared URL rule (g1 3.3): https anywhere, http only on loopback, never credentials. Throws invalid_url.

/** A board URL without userinfo, query or fragment. */
export function validateBoardUrl(raw: string, what: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw clientError('invalid_url', `${what} is not a URL`)
  }
  if (u.username !== '' || u.password !== '') {
    throw clientError('invalid_url', `${what} carries credentials: a token travels in the environment, never in a URL`)
  }
  if (u.protocol === 'https:') {
    // fine
  } else if (u.protocol === 'http:') {
    const h = u.hostname
    if (h !== '127.0.0.1' && h !== '[::1]' && h !== '::1' && h !== 'localhost') {
      throw clientError('invalid_url', `${what} is plain http to a host that is not this machine: use https`)
    }
  } else {
    throw clientError('invalid_url', `${what} must be an https URL (or http on loopback)`)
  }
  return u.origin + (u.pathname === '/' ? '' : u.pathname)
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

class Collector {
  readonly warnings: ExplainStep[] = []
  readonly source: string
  readonly path: string
  constructor(source: string, path: string) {
    this.source = source
    this.path = path
  }
  bad(key: string, why: string, reason?: string): Error {
    return clientError('invalid_config', `${this.path}: ${key === '' ? '' : `"${key}" `}${why}`, {
      details: { key, ...(reason !== undefined ? { reason } : {}) },
    })
  }
  warn(note: string): void {
    this.warnings.push({ topic: 'config', source: this.source, outcome: 'warn', note })
  }
  unknown(o: Obj, known: readonly string[], prefix: string): void {
    for (const k of Object.keys(o)) if (!known.includes(k)) this.warn(`unknown key "${prefix}${k}" ignored`)
  }
  object(v: unknown, key: string): Obj {
    if (!isObj(v)) throw this.bad(key, 'must be an object')
    return v
  }
  bool(v: unknown, key: string): boolean {
    if (typeof v !== 'boolean') throw this.bad(key, 'must be true or false')
    return v
  }
  int(v: unknown, key: string, min: number, max: number): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw this.bad(key, `must be an integer from ${min} to ${max}`)
    }
    return v
  }
  oneOf<T extends string>(v: unknown, key: string, allowed: readonly T[]): T {
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      throw this.bad(key, `must be one of ${allowed.join(', ')}`)
    }
    return v as T
  }
  string(v: unknown, key: string): string {
    if (typeof v !== 'string' || v.trim() === '') throw this.bad(key, 'must be a non-empty string')
    return v
  }
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch (e) {
    // The parser's own message can quote the file's text, so only its position is kept.
    const at = /position (\d+)/.exec(e instanceof Error ? e.message : '')
    throw clientError('invalid_config', `${path}: not valid JSON${at ? ` (at position ${at[1]})` : ''}`, {
      details: { reason: 'json', ...(at ? { position: Number(at[1]) } : {}) },
    })
  }
}

function checkVersion(root: Obj, c: Collector): void {
  if ('version' in root && root.version !== 1) {
    throw clientError('invalid_config', `${c.path}: unsupported config version`, {
      details: { reason: 'version', version: root.version },
    })
  }
}

function sharedPolicy(root: Obj, c: Collector): Pick<ProjectConfig, 'mode' | 'daemon' | 'tick' | 'wake' | 'auth'> {
  const out: { -readonly [K in 'mode' | 'daemon' | 'tick' | 'wake' | 'auth']?: ProjectConfig[K] } = {}
  if (root.mode !== undefined) out.mode = c.oneOf(root.mode, 'mode', MODE_POLICIES)
  if (root.tick !== undefined) out.tick = c.oneOf(root.tick, 'tick', TICKS)
  if (root.daemon !== undefined) {
    const d = c.object(root.daemon, 'daemon')
    c.unknown(d, ['idleExitS', 'spawn'], 'daemon.')
    out.daemon = {
      ...(d.idleExitS !== undefined ? { idleExitS: c.int(d.idleExitS, 'daemon.idleExitS', 0, 86400) } : {}),
      ...(d.spawn !== undefined ? { spawn: c.oneOf(d.spawn, 'daemon.spawn', SPAWNS) } : {}),
    }
  }
  if (root.wake !== undefined) {
    const w = c.object(root.wake, 'wake')
    c.unknown(w, ['watch', 'safetyPollMs'], 'wake.')
    out.wake = {
      ...(w.watch !== undefined ? { watch: c.bool(w.watch, 'wake.watch') } : {}),
      ...(w.safetyPollMs !== undefined ? { safetyPollMs: c.int(w.safetyPollMs, 'wake.safetyPollMs', 50, 60000) } : {}),
    }
  }
  if (root.auth !== undefined) {
    const a = c.object(root.auth, 'auth')
    c.unknown(a, ['enforce'], 'auth.')
    out.auth = { ...(a.enforce !== undefined ? { enforce: c.bool(a.enforce, 'auth.enforce') } : {}) }
  }
  return out
}

/** The first forbidden key at any depth, as a dotted path, or null. */
function forbiddenKey(v: unknown, prefix: string): string | null {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = forbiddenKey(v[i], `${prefix}${i}.`)
      if (hit !== null) return hit
    }
  } else if (isObj(v)) {
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) return prefix + k
      const hit = forbiddenKey(v[k], `${prefix}${k}.`)
      if (hit !== null) return hit
    }
  }
  return null
}

/** Parses a project config. Throws ClientError: invalid_config (400) or config_forbidden (403). */
export function parseProjectConfig(text: string, path: string): Parsed<ProjectConfig> {
  const c = new Collector(`project:${path}`, path)
  const root = parseJson(text, path)
  if (!isObj(root)) throw c.bad('', 'must be a JSON object')
  checkVersion(root, c)
  const key = forbiddenKey(root, '')
  if (key !== null) {
    throw clientError('config_forbidden', `${path}: "${key}" cannot be set in a project config`, {
      hint: 'a repository must not choose a remote board, a token, a listener or a sidecar path: use the user config or the environment',
      details: { key },
    })
  }
  c.unknown(root, ['version', 'db', 'mode', 'daemon', 'tick', 'wake', 'auth'], '')
  const value: ProjectConfig = {
    version: 1,
    ...(root.db !== undefined ? { db: c.string(root.db, 'db') } : {}),
    ...sharedPolicy(root, c),
  }
  return { value, warnings: c.warnings }
}

/** Parses the user config; `home` expands a leading `~/` in a board entry's db. */
export function parseUserConfig(text: string, path: string, home: string): Parsed<UserConfig> {
  const c = new Collector(`user:${path}`, path)
  const root = parseJson(text, path)
  if (!isObj(root)) throw c.bad('', 'must be a JSON object')
  checkVersion(root, c)
  c.unknown(root, ['version', 'boards', 'default', 'allowUnsafeFs', 'tick', 'wake', 'daemon', 'auth', 'service'], '')
  const P = pathForSample(home)
  let boards: Record<string, UserBoardEntry> | undefined
  if (root.boards !== undefined) {
    const b = c.object(root.boards, 'boards')
    boards = {}
    for (const name of Object.keys(b)) {
      const where = `boards.${name}`
      if (!BOARD_NAME_PATTERN.test(name)) throw c.bad(where, 'is not a valid board name (lowercase letters, digits, dashes)')
      const e = c.object(b[name], where)
      const hasUrl = e.url !== undefined
      const hasDb = e.db !== undefined
      if (hasUrl === hasDb) throw c.bad(where, 'must have exactly one of url or db')
      if (hasUrl) {
        c.unknown(e, ['url', 'auth'], `${where}.`)
        let url: string
        try {
          url = validateBoardUrl(c.string(e.url, `${where}.url`), `${where}.url`)
        } catch (err) {
          if (err instanceof Error && 'code' in err && err.code === 'invalid_url') {
            throw clientError('invalid_config', `${path}: ${err.message}`, {
              details: { key: `${where}.url`, reason: 'invalid_url' },
            })
          }
          throw err
        }
        boards[name] = {
          url,
          ...(e.auth !== undefined ? { auth: c.oneOf(e.auth, `${where}.auth`, AUTHS) } : {}),
        }
      } else {
        c.unknown(e, ['db', 'mode'], `${where}.`)
        let db = c.string(e.db, `${where}.db`)
        if (db === '~' || db.startsWith('~/') || db.startsWith('~\\')) db = P.join(home, db.slice(2))
        if (!P.isAbsolute(db)) throw c.bad(`${where}.db`, 'must be an absolute path (a leading ~/ is allowed here)')
        boards[name] = {
          db,
          ...(e.mode !== undefined ? { mode: c.oneOf(e.mode, `${where}.mode`, MODE_POLICIES) } : {}),
        }
      }
    }
  }
  let def: string | undefined
  if (root.default !== undefined) {
    def = c.string(root.default, 'default')
    if (!BOARD_NAME_PATTERN.test(def)) throw c.bad('default', 'is not a valid board name')
  }
  const value: UserConfig = {
    version: 1,
    ...(boards !== undefined ? { boards } : {}),
    ...(def !== undefined ? { default: def } : {}),
    ...(root.allowUnsafeFs !== undefined ? { allowUnsafeFs: c.bool(root.allowUnsafeFs, 'allowUnsafeFs') } : {}),
    ...(root.service !== undefined ? { service: root.service } : {}),
    ...sharedPolicy(root, c),
  }
  return { value, warnings: c.warnings }
}

// ---------------------------------------------------------------------------------------------------------------
// Locations and checks

const fsErrnoOf = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === 'string' && c !== '' ? c : undefined
}

/** Runs a ResolverFs call and wraps non-BoardError filesystem errors as ClientError so raw Node errors never escape. */
export function callFs<T>(
  fn: () => T,
  code: 'invalid_config' | 'unsafe_config' | 'internal',
  path: string,
  action: string,
): T {
  try {
    return fn()
  } catch (e) {
    if (isBoardError(e)) throw e
    const errno = fsErrnoOf(e)
    const suffix = errno !== undefined ? ` (${errno})` : ''
    throw clientError(code, `${path}: ${action}${suffix}`, {
      details: { reason: 'io', ...(errno !== undefined ? { errno } : {}) },
      cause: e,
    })
  }
}

/** The nearest `<d>/.swarmboard/config.json` from cwd up to and including the git root; none outside a repository. */
export function findProjectConfig(
  cwd: string,
  gitRoot: string | null,
  fs: ResolverFs,
  platform?: NodeJS.Platform,
): { path: string; root: string } | null {
  if (gitRoot === null) return null
  const P = platform !== undefined ? pathForPlatform(platform) : pathForSample(cwd)
  let d = cwd
  for (;;) {
    const candidate = P.join(d, '.swarmboard', 'config.json')
    if (callFs(() => fs.lstat(candidate), 'invalid_config', candidate, 'cannot inspect project config') !== null) {
      return { path: candidate, root: d }
    }
    if (d === gitRoot) return null
    const parent = P.dirname(d)
    if (parent === d) return null
    d = parent
  }
}

/** `$XDG_CONFIG_HOME/swarmboard/config.json` (default `<home>/.config`, also on macOS); win32 `%APPDATA%`. */
export function userConfigPath(env: Env, platform: NodeJS.Platform, home: string): string {
  const P = pathForPlatform(platform)
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim()
    return P.join(appData ? appData : P.join(home, 'AppData', 'Roaming'), 'swarmboard', 'config.json')
  }
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return P.join(xdg && P.isAbsolute(xdg) ? xdg : P.join(home, '.config'), 'swarmboard', 'config.json')
}

/**
 * The user config may name remotes, so it must not be writable by others or owned by someone else (POSIX). A
 * symlink is followed once. Accident protection, not a boundary: any process of the same user can rewrite it.
 * Returns a warn step where the check cannot run (no uid: win32); null when it passed or the file is absent.
 */
export function checkUserConfigFile(path: string, fs: ResolverFs, uid: number | null): ExplainStep | null {
  let st = callFs(() => fs.lstat(path), 'invalid_config', path, 'cannot inspect user config')
  if (st === null) return null
  if (st.kind === 'symlink') {
    const target = callFs(() => fs.realpathish(path), 'invalid_config', path, 'cannot resolve user config')
    st = callFs(() => fs.lstat(target), 'invalid_config', path, 'cannot inspect user config')
    if (st === null) return null
  }
  if (st.kind !== 'file') {
    throw clientError('unsafe_config', `${path} is not a regular file`, { details: { reason: 'not-a-file' } })
  }
  if (uid === null) {
    return {
      topic: 'config',
      source: `user:${path}`,
      outcome: 'warn',
      note: 'not-checked: file permissions are not checked on this platform',
    }
  }
  if (st.uid !== uid) {
    throw clientError('unsafe_config', `${path} is owned by another user`, {
      hint: 'the user config can name remote boards, so it must be yours',
      details: { reason: 'foreign-owner' },
    })
  }
  if ((st.mode & 0o022) !== 0) {
    throw clientError('unsafe_config', `${path} is writable by others`, {
      hint: `run chmod go-w on it`,
      details: { reason: 'writable-by-others' },
    })
  }
  return null
}

/**
 * The project's board file: relative to the project root (or absolute), and, canonicalized, inside the git root.
 * Throws unsafe_config (outside-repo), including when a symlink (even dangling) escapes the repository. Returns
 * the logical absolute path; the opener canonicalizes again.
 */
export function resolveProjectDb(cfg: ProjectConfig, root: string, gitRoot: string, fs: ResolverFs): string {
  if (cfg.db === undefined) throw clientError('invalid_config', 'the project config names no db')
  const P = pathForSample(root)
  const abs = P.resolve(root, cfg.db)
  const fold = (p: string): string => (P === nodePath.win32 ? p.toLowerCase() : p)
  const resolveCanon = (p: string): string => {
    try {
      return fs.realpathish(p)
    } catch (e) {
      if (isBoardError(e)) throw e
      const errno = fsErrnoOf(e)
      if (errno === 'ELOOP') {
        throw clientError('unsafe_config', 'the project config places the board at a symbolic link loop', {
          hint: 'a project db must resolve inside the git work tree, symlinks included',
          details: { reason: 'outside-repo', errno: 'ELOOP' },
          cause: e,
        })
      }
      const suffix = errno !== undefined ? ` (${errno})` : ''
      throw clientError('invalid_config', `${p}: cannot resolve project db path${suffix}`, {
        details: { reason: 'io', ...(errno !== undefined ? { errno } : {}) },
        cause: e,
      })
    }
  }
  const canon = fold(resolveCanon(abs))
  const top = fold(resolveCanon(gitRoot))
  const prefix = top.endsWith(P.sep) ? top : top + P.sep
  if (!canon.startsWith(prefix)) {
    throw clientError('unsafe_config', 'the project config places the board outside the repository', {
      hint: 'a project db must resolve inside the git work tree, symlinks included',
      details: { reason: 'outside-repo' },
    })
  }
  // Defense in depth: if the final path is a symlink whose target was not followed by a custom ResolverFs,
  // we cannot prove it stays inside the repository.
  const st = callFs(() => fs.lstat(abs), 'invalid_config', abs, 'cannot inspect project db path')
  if (st?.kind === 'symlink') {
    const parentCanon = fold(resolveCanon(P.dirname(abs)))
    const unfollowed = fold(P.join(parentCanon, P.basename(abs)))
    if (canon === unfollowed) {
      throw clientError('unsafe_config', 'the project config places the board at an unresolved symlink', {
        hint: 'a project db must resolve inside the git work tree, symlinks included',
        details: { reason: 'outside-repo' },
      })
    }
  }
  return abs
}
