// The environment contract and `resolveBoard` (HOST123_DESIGN 4.1, g1 section 3). Thin: node built-ins and
// ./config.ts, ./errors.ts only. Pure apart from the injected ResolverFs reads: it never spawns, never connects,
// never writes. The token string is never stored anywhere in a Resolution.
import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  BOARD_NAME_PATTERN,
  MODE_POLICIES,
  callFs,
  checkUserConfigFile,
  findProjectConfig,
  parseProjectConfig,
  parseUserConfig,
  pathForPlatform,
  pathForSample,
  resolveProjectDb,
  userConfigPath,
  validateBoardUrl,
  type ModePolicy,
  type PathModule,
  type ProjectConfig,
  type UserBoardEntry,
  type UserConfig,
} from './config.ts'
import { clientError } from './errors.ts'

export type Env = Readonly<Record<string, string | undefined>>

/** The only filesystem access the resolver does, injected for tests. All paths absolute. */
export interface ResolverFs {
  /** File text, or null for ENOENT/ENOTDIR. Other errors throw. */
  readText(path: string): string | null
  /** lstat facts, or null for ENOENT/ENOTDIR. */
  lstat(path: string): { kind: 'file' | 'dir' | 'symlink' | 'other'; mode: number; uid: number } | null
  /** realpath of the deepest existing ancestor of `path`, joined with the missing tail. */
  realpathish(path: string): string
}

const MISSING = new Set(['ENOENT', 'ENOTDIR'])
const MAX_SYMLINK_HOPS = 40
const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

export const nodeResolverFs: ResolverFs = {
  readText(path) {
    try {
      return nodeFs.readFileSync(path, 'utf8')
    } catch (e) {
      if (MISSING.has(codeOf(e) ?? '')) return null
      throw e
    }
  },
  lstat(path) {
    try {
      const st = nodeFs.lstatSync(path)
      const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
      return { kind, mode: st.mode, uid: st.uid }
    } catch (e) {
      if (MISSING.has(codeOf(e) ?? '')) return null
      throw e
    }
  },
  realpathish(inputPath) {
    const P = pathForSample(inputPath)
    // Fast path: when the full path exists, let the OS canonicalize it directly.
    try {
      return nodeFs.realpathSync(inputPath)
    } catch (e) {
      if (!MISSING.has(codeOf(e) ?? '')) throw e
    }
    // Walk left-to-right following symlinks (including dangling ones) in POSIX order so a dangling symlink
    // cannot hide an escaping target behind its parent's realpath.
    const startPath = P.isAbsolute(inputPath) ? inputPath : P.resolve(inputPath)
    const root = P.parse(startPath).root
    const sepRe = P.sep === '\\' ? /[\\/]+/ : /\/+/
    let cur = root
    const rest = startPath.slice(root.length).split(sepRe).filter(Boolean)
    let hops = 0
    let missing = false
    while (rest.length > 0) {
      const seg = rest.shift()!
      if (seg === '.') continue
      if (seg === '..') {
        cur = P.dirname(cur)
        if (missing) {
          try {
            cur = nodeFs.realpathSync(cur)
            missing = false
          } catch (e) {
            if (!MISSING.has(codeOf(e) ?? '')) throw e
          }
        }
        continue
      }
      const next = P.join(cur, seg)
      if (missing) {
        cur = next
        continue
      }
      let st: nodeFs.Stats
      try {
        st = nodeFs.lstatSync(next)
      } catch (e) {
        if (!MISSING.has(codeOf(e) ?? '')) throw e
        cur = next
        missing = true
        continue
      }
      if (st.isSymbolicLink()) {
        hops += 1
        if (hops > MAX_SYMLINK_HOPS) {
          throw Object.assign(new Error(`ELOOP: too many symbolic links encountered, realpath '${inputPath}'`), {
            code: 'ELOOP',
          })
        }
        const target = nodeFs.readlinkSync(next)
        const tRoot = P.parse(target).root
        const tSegs = target.slice(tRoot.length).split(sepRe).filter(Boolean)
        if (tRoot !== '') cur = tRoot === '\\' ? P.parse(cur).root || tRoot : tRoot
        rest.unshift(...tSegs)
        continue
      }
      cur = next
    }
    return cur
  },
}

export interface ResolveFlags {
  readonly board?: string
  readonly url?: string
  readonly db?: string
  readonly mode?: ModePolicy
  readonly as?: string | null
  readonly inProcess?: boolean
  readonly allowUnsafeFs?: boolean
}
export interface ResolveContext {
  readonly env: Env
  readonly cwd: string
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly uid: number | null
  readonly fs: ResolverFs
}

export type BoardTarget =
  | { readonly kind: 'file'; readonly db: string; readonly dir: string; readonly defaultDir: boolean }
  | { readonly kind: 'memory'; readonly db: ':memory:' }
  | { readonly kind: 'url'; readonly url: string; readonly auth: 'oidc' | 'bearer' | null }

export type Source =
  | `flag:${'board' | 'url' | 'db' | 'mode' | 'as' | 'inProcess' | 'allowUnsafeFs'}`
  | `env:${string}`
  | `project:${string}`
  | `user:${string}`
  | 'default:git'
  | 'default:state'
  | 'default'
  | 'option:service'

export interface ExplainStep {
  readonly topic: 'board' | 'mode' | 'identity' | 'config' | 'location' | 'manifest'
  readonly source: string
  readonly outcome: 'chosen' | 'shadowed' | 'ignored' | 'warn' | 'refused'
  /** Redacted: never a token; URLs without userinfo, query or fragment. */
  readonly value?: string
  readonly note: string
}

export interface Resolution {
  readonly target: BoardTarget
  readonly source: Source
  readonly policy: {
    readonly mode: ModePolicy
    readonly modeSource: Source
    readonly inProcess: boolean
    readonly tick: 'lease' | 'owner-only' | 'off'
    readonly wake: { readonly watch: boolean; readonly safetyPollMs: number }
    readonly daemon: { readonly idleExitS: number; readonly spawn: 'on-demand' | 'never' }
    readonly authEnforce: boolean
    readonly allowUnsafeFs: boolean
  }
  readonly identity: {
    readonly profile: string | null
    readonly profileSource: Source | null
    readonly parent: string | null
    readonly swarm: string | null
    readonly token: 'set' | 'unset'
    readonly tokenSource: Source | null
  }
  readonly gitRoot: string | null
  readonly configs: { readonly project: string | null; readonly user: string | null }
  readonly explain: readonly ExplainStep[]
}

const PROFILE_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const HINT_MAX = 200

/** A candidate for one decision: the highest present one wins, later present ones are reported shadowed. */
interface Candidate<T> {
  readonly source: string
  readonly value: string | undefined
  readonly note: string
  build(): T
}

export function resolveBoard(flags: ResolveFlags, ctx: ResolveContext): Resolution {
  const P: PathModule = pathForPlatform(ctx.platform)
  const { env, fs } = ctx
  const explain: ExplainStep[] = []
  const get = (name: string): string | undefined => {
    const v = env[name]
    if (v === undefined) return undefined
    const t = v.trim()
    return t === '' ? undefined : t
  }
  const present = (v: string | null | undefined): v is string => v !== undefined && v !== null && v.trim() !== ''

  /** Runs the first candidate; reports the chosen one and every later present one as shadowed. */
  function pick<T>(topic: ExplainStep['topic'], list: readonly Candidate<T>[]): { source: string; value: T } {
    const first = list[0]
    if (first === undefined) throw clientError('internal', `nothing to choose for ${topic}`)
    const value = first.build()
    explain.push({ topic, source: first.source, outcome: 'chosen', ...(first.value !== undefined ? { value: first.value } : {}), note: first.note })
    for (const c of list.slice(1)) {
      if (c.source.startsWith('default')) continue
      explain.push({ topic, source: c.source, outcome: 'shadowed', ...(c.value !== undefined ? { value: c.value } : {}), note: `${c.note}; a higher-precedence source won` })
    }
    return { source: first.source, value }
  }

  // ---- flag sanity ---------------------------------------------------------------------------------------------
  if (flags.mode !== undefined && !MODE_POLICIES.includes(flags.mode)) {
    throw clientError('invalid_mode', `the mode must be one of ${MODE_POLICIES.join(', ')}`)
  }
  const unsafeEnv = get('SWARMBOARD_UNSAFE_FS')
  if (unsafeEnv !== undefined && unsafeEnv !== 'allow') {
    throw clientError('invalid_request', 'SWARMBOARD_UNSAFE_FS must be "allow" or unset')
  }

  // ---- git root and configs ------------------------------------------------------------------------------------
  let gitRoot: string | null = null
  for (let d = ctx.cwd; ; ) {
    const gitPath = P.join(d, '.git')
    if (callFs(() => fs.lstat(gitPath), 'internal', gitPath, 'cannot inspect path') !== null) {
      gitRoot = d
      break
    }
    const parent = P.dirname(d)
    if (parent === d) break
    d = parent
  }

  const userPath = userConfigPath(env, ctx.platform, ctx.home)
  let user: UserConfig | null = null
  let userFile: string | null = null
  const userCheck = checkUserConfigFile(userPath, fs, ctx.uid)
  const userText = callFs(() => fs.readText(userPath), 'invalid_config', userPath, 'cannot read user config')
  if (userText !== null) {
    const parsed = parseUserConfig(userText, userPath, ctx.home)
    user = parsed.value
    userFile = userPath
    if (userCheck !== null) explain.push(userCheck)
    explain.push({ topic: 'config', source: `user:${userPath}`, outcome: 'chosen', value: userPath, note: 'user config' })
    explain.push(...parsed.warnings)
  }

  let project: ProjectConfig | null = null
  let projectFile: string | null = null
  let projectRoot: string | null = null
  const found = findProjectConfig(ctx.cwd, gitRoot, fs, ctx.platform)
  if (found !== null) {
    let st = callFs(() => fs.lstat(found.path), 'invalid_config', found.path, 'cannot inspect project config')
    if (st?.kind === 'symlink') {
      const target = callFs(() => fs.realpathish(found.path), 'invalid_config', found.path, 'cannot resolve project config')
      st = callFs(() => fs.lstat(target), 'invalid_config', found.path, 'cannot inspect project config')
    }
    if (st !== null) {
      if (st.kind !== 'file') {
        throw clientError('invalid_config', `${found.path}: is not a regular file`, {
          details: { reason: 'not-a-file' },
        })
      }
      const text = callFs(() => fs.readText(found.path), 'invalid_config', found.path, 'cannot read project config')
      if (text !== null) {
        const parsed = parseProjectConfig(text, found.path)
        project = parsed.value
        projectFile = found.path
        projectRoot = found.root
        explain.push({ topic: 'config', source: `project:${found.path}`, outcome: 'chosen', value: found.path, note: 'project config' })
        explain.push(...parsed.warnings)
      }
    }
  }

  // ---- the board -----------------------------------------------------------------------------------------------
  interface Pick {
    readonly target: BoardTarget
    readonly source: Source
    readonly userEntryMode?: ModePolicy
  }
  const fileTarget = (db: string, defaultDir = false): BoardTarget => {
    const abs = P.resolve(db)
    return { kind: 'file', db: abs, dir: P.dirname(abs), defaultDir }
  }
  const requireAbsolute = (value: string, what: string): string => {
    if (!P.isAbsolute(value)) {
      throw clientError('invalid_db_path', `${what} must be an absolute path (got a relative one)`, {
        hint: '~ is expanded only in the user config; spell the full path here',
      })
    }
    return value
  }
  const fromEntry = (name: string, entry: UserBoardEntry): Pick => {
    const source = `user:${userPath}` as Source
    if ('url' in entry) return { target: { kind: 'url', url: entry.url, auth: entry.auth ?? null }, source }
    return { target: fileTarget(entry.db), source, ...(entry.mode !== undefined ? { userEntryMode: entry.mode } : {}) }
  }
  const entryByName = (name: string, missing: 'no_board' | 'invalid_config'): UserBoardEntry => {
    const boards = user?.boards
    if (boards === undefined || !Object.hasOwn(boards, name)) {
      throw clientError(missing, missing === 'no_board' ? `no board named "${name}" in the user config` : `the user config default "${name}" names no board`)
    }
    return boards[name]!
  }
  const urlPick = (raw: string, what: string, source: Source): Pick => ({
    target: { kind: 'url', url: validateBoardUrl(raw, what), auth: null },
    source,
  })

  const flagCount = [flags.board, flags.url, flags.db].filter(present).length
  if (flagCount > 1) throw clientError('conflicting_options', 'give at most one of board, url and db')

  const candidates: Candidate<Pick>[] = []
  const redactUrl = (raw: string): string | undefined => {
    try {
      const u = new URL(raw)
      return u.origin + (u.pathname === '/' ? '' : u.pathname)
    } catch {
      return undefined
    }
  }

  // 1. flags
  if (present(flags.board)) {
    const raw = flags.board.trim()
    candidates.push({
      source: 'flag:board',
      value: /^https?:/i.test(raw) ? redactUrl(raw) : raw,
      note: 'the board flag',
      build() {
        if (/^https?:/i.test(raw)) return urlPick(raw, 'the board flag', 'flag:board')
        if (/^file:/i.test(raw)) {
          let path: string
          try {
            path = fileURLToPath(raw)
          } catch {
            throw clientError('invalid_url', 'the board flag is not a valid file: URL')
          }
          return { target: fileTarget(requireAbsolute(path, 'the board flag')), source: 'flag:board' }
        }
        if (BOARD_NAME_PATTERN.test(raw)) return fromEntry(raw, entryByName(raw, 'no_board'))
        throw clientError('invalid_db_path', 'the board flag must be a URL, a file: URL or a board name from the user config')
      },
    })
  } else if (present(flags.url)) {
    const raw = flags.url.trim()
    candidates.push({ source: 'flag:url', value: redactUrl(raw), note: 'the url flag', build: () => urlPick(raw, 'the url flag', 'flag:url') })
  } else if (present(flags.db)) {
    const raw = flags.db.trim()
    candidates.push({
      source: 'flag:db',
      value: raw,
      note: 'the db flag',
      build() {
        if (raw === ':memory:') {
          if (flags.inProcess !== true) throw clientError('invalid_db_path', 'an in-memory board needs the in-process option')
          return { target: { kind: 'memory', db: ':memory:' }, source: 'flag:db' }
        }
        return { target: fileTarget(requireAbsolute(raw, 'the db flag')), source: 'flag:db' }
      },
    })
  }

  // 2. canonical env
  const eUrl = get('SWARMBOARD_URL')
  const eDb = get('SWARMBOARD_DB')
  const eDir = get('SWARMBOARD_DIR')
  const canonical = eUrl !== undefined || eDb !== undefined || eDir !== undefined
  if (canonical) {
    const source = eUrl !== undefined ? 'env:SWARMBOARD_URL' : eDb !== undefined ? 'env:SWARMBOARD_DB' : 'env:SWARMBOARD_DIR'
    candidates.push({
      source,
      value: eUrl !== undefined ? redactUrl(eUrl) : (eDb ?? eDir),
      note: 'the canonical environment',
      build() {
        if (eUrl !== undefined) {
          if (eDb !== undefined || eDir !== undefined) {
            throw clientError('conflicting_options', 'SWARMBOARD_URL cannot be combined with SWARMBOARD_DB or SWARMBOARD_DIR')
          }
          return urlPick(eUrl, 'SWARMBOARD_URL', 'env:SWARMBOARD_URL')
        }
        const dirDb = eDir !== undefined ? P.join(requireAbsolute(eDir, 'SWARMBOARD_DIR'), 'board.db') : undefined
        if (eDb !== undefined) {
          const abs = requireAbsolute(eDb, 'SWARMBOARD_DB')
          if (dirDb !== undefined && P.resolve(dirDb) !== P.resolve(abs)) {
            throw clientError('conflicting_options', 'SWARMBOARD_DB and SWARMBOARD_DIR name different boards')
          }
          return { target: fileTarget(abs), source: 'env:SWARMBOARD_DB' }
        }
        return { target: fileTarget(dirDb as string), source: 'env:SWARMBOARD_DIR' }
      },
    })
  }

  // 3. compat env
  const bUrl = get('BOARD_URL')
  const bName = get('BOARD_NAME')
  if (bName !== undefined) {
    explain.push({ topic: 'board', source: 'env:BOARD_NAME', outcome: 'ignored', note: 'BOARD_NAME names a Vercel team board and never selects a Swarmboard board' })
  }
  if (bUrl !== undefined) {
    if (canonical) {
      explain.push({ topic: 'board', source: 'env:BOARD_URL', outcome: 'ignored', ...(redactUrl(bUrl) !== undefined ? { value: redactUrl(bUrl) as string } : {}), note: 'a canonical board variable is set' })
    } else {
      candidates.push({
        source: 'env:BOARD_URL',
        value: redactUrl(bUrl),
        note: 'the compatibility environment',
        build() {
          if (bName !== undefined) throw clientError('conflicting_options', 'BOARD_URL and BOARD_NAME cannot both be set')
          return urlPick(bUrl, 'BOARD_URL', 'env:BOARD_URL')
        },
      })
    }
  }

  // 4. project config
  if (project?.db !== undefined && projectFile !== null && projectRoot !== null && gitRoot !== null) {
    const cfg = project
    const root = projectRoot
    const top = gitRoot
    const file = projectFile
    candidates.push({
      source: `project:${file}`,
      value: project.db,
      note: 'the project config',
      build: () => ({ target: fileTarget(resolveProjectDb(cfg, root, top, fs)), source: `project:${file}` }),
    })
  }

  // 5. user default
  if (user?.default !== undefined) {
    const name = user.default
    candidates.push({
      source: `user:${userPath}`,
      value: name,
      note: 'the user config default',
      build: () => fromEntry(name, entryByName(name, 'invalid_config')),
    })
  }

  // 6. the default file board
  candidates.push({
    source: gitRoot !== null ? 'default:git' : 'default:state',
    value: undefined,
    note: 'the default board',
    build(): Pick {
      if (gitRoot !== null) return { target: fileTarget(P.join(gitRoot, '.swarmboard', 'board.db'), true), source: 'default:git' }
      const base =
        ctx.platform === 'win32'
          ? (get('LOCALAPPDATA') ?? P.join(ctx.home, 'AppData', 'Local'))
          : (() => {
              const x = get('XDG_STATE_HOME')
              return x !== undefined && P.isAbsolute(x) ? x : P.join(ctx.home, '.local', 'state')
            })()
      return { target: fileTarget(P.join(base, 'swarmboard', 'default', 'board.db')), source: 'default:state' }
    },
  })

  const chosen = pick('board', candidates).value
  const target = chosen.target

  // ---- the mode ------------------------------------------------------------------------------------------------
  const modeEnv = get('SWARMBOARD_MODE')
  const daemonEnv = get('SWARMBOARD_DAEMON')
  const checkMode = (v: string, what: string): ModePolicy => {
    if (!(MODE_POLICIES as readonly string[]).includes(v)) {
      throw clientError('invalid_mode', `${what} must be one of ${MODE_POLICIES.join(', ')}`)
    }
    return v as ModePolicy
  }
  const mapDaemon = (v: string): ModePolicy => {
    if (v === 'off') return 'file'
    if (v === 'auto') return 'auto'
    if (v === 'required') return 'daemon'
    throw clientError('invalid_mode', 'SWARMBOARD_DAEMON must be off, auto or required')
  }
  const modeCands: Candidate<ModePolicy>[] = []
  if (flags.mode !== undefined) {
    const m = flags.mode
    modeCands.push({ source: 'flag:mode', value: m, note: 'the mode flag', build: () => m })
  }
  if (modeEnv !== undefined || daemonEnv !== undefined) {
    modeCands.push({
      source: modeEnv !== undefined ? 'env:SWARMBOARD_MODE' : 'env:SWARMBOARD_DAEMON',
      value: modeEnv ?? daemonEnv,
      note: 'the environment',
      build() {
        const a = modeEnv !== undefined ? checkMode(modeEnv, 'SWARMBOARD_MODE') : undefined
        const b = daemonEnv !== undefined ? mapDaemon(daemonEnv) : undefined
        if (a !== undefined && b !== undefined && a !== b) {
          throw clientError('conflicting_options', 'SWARMBOARD_MODE and SWARMBOARD_DAEMON ask for different modes')
        }
        return (a ?? b) as ModePolicy
      },
    })
  }
  if (project?.mode !== undefined && projectFile !== null) {
    const m = project.mode
    modeCands.push({ source: `project:${projectFile}`, value: m, note: 'the project config', build: () => m })
  }
  if (chosen.userEntryMode !== undefined) {
    const m = chosen.userEntryMode
    modeCands.push({ source: `user:${userPath}`, value: m, note: 'the user config entry', build: () => m })
  }
  modeCands.push({ source: 'default', value: 'auto', note: 'the default mode', build: () => 'auto' as ModePolicy })

  const inProcess = flags.inProcess === true
  if (inProcess && target.kind === 'url') {
    throw clientError('conflicting_options', 'the in-process option cannot be combined with a url board')
  }
  const modePick = pick('mode', modeCands)
  let mode: ModePolicy = modePick.value
  let modeSource = modePick.source as Source
  if (inProcess && modeSource !== 'default') {
    explain.push({ topic: 'mode', source: modeSource, outcome: 'ignored', value: mode, note: 'the in-process option ignores the mode policy' })
  }
  if (target.kind === 'url' && mode !== 'auto') {
    // Explicit non-auto mode (flag or env, per g1 3.3) conflicts with a URL board; a project-config mode is
    // demoted to an ignored step so a cloned repo cannot break an explicit URL.
    if (modeSource.startsWith('flag:') || modeSource.startsWith('env:')) {
      throw clientError('conflicting_options', `a url board has one mode (remote); the ${modeSource.startsWith('flag:') ? 'mode flag' : 'environment'} asks for "${mode}"`)
    }
    explain.push({ topic: 'mode', source: modeSource, outcome: 'ignored', value: mode, note: 'a url board has one mode (remote)' })
    mode = 'auto'
    modeSource = 'default'
  }

  // ---- identity hints ------------------------------------------------------------------------------------------
  const checkProfile = (v: string, what: string): string => {
    if (!PROFILE_PATTERN.test(v)) {
      throw clientError('invalid_profile', `${what} must be a profile name: a letter, then letters, digits or dashes, at most 32 characters`)
    }
    return v
  }
  let profile: string | null = null
  let profileSource: Source | null = null
  const agent = get('SWARMBOARD_AGENT')
  const bProfile = get('BOARD_PROFILE')
  const fusion = get('FUSION_AGENT_ID')
  const profileStep = (source: string, outcome: ExplainStep['outcome'], note: string): void => {
    explain.push({ topic: 'identity', source, outcome, note })
  }
  if (flags.as !== undefined) {
    if (flags.as !== null) profile = checkProfile(flags.as, '--as')
    profileSource = 'flag:as'
    profileStep('flag:as', 'chosen', 'the as flag')
    for (const [n, v] of [['SWARMBOARD_AGENT', agent], ['BOARD_PROFILE', bProfile], ['FUSION_AGENT_ID', fusion]] as const) {
      if (v !== undefined) profileStep(`env:${n}`, 'shadowed', 'the as flag won')
    }
  } else if (agent !== undefined) {
    profile = checkProfile(agent, 'SWARMBOARD_AGENT')
    profileSource = 'env:SWARMBOARD_AGENT'
    profileStep('env:SWARMBOARD_AGENT', 'chosen', 'the canonical variable')
    if (bProfile !== undefined) profileStep('env:BOARD_PROFILE', 'ignored', 'SWARMBOARD_AGENT is set')
    if (fusion !== undefined) profileStep('env:FUSION_AGENT_ID', 'ignored', 'SWARMBOARD_AGENT is set')
  } else if (bProfile !== undefined) {
    profile = checkProfile(bProfile, 'BOARD_PROFILE')
    profileSource = 'env:BOARD_PROFILE'
    profileStep('env:BOARD_PROFILE', 'chosen', 'the compatibility variable')
    if (fusion !== undefined) profileStep('env:FUSION_AGENT_ID', 'ignored', 'BOARD_PROFILE is set')
  } else if (fusion !== undefined) {
    profile = checkProfile(fusion, 'FUSION_AGENT_ID')
    profileSource = 'env:FUSION_AGENT_ID'
    profileStep('env:FUSION_AGENT_ID', 'chosen', 'the compatibility variable')
  }

  const hint = (canonicalName: string, compatName: string): string | null => {
    const name = get(canonicalName) !== undefined ? canonicalName : get(compatName) !== undefined ? compatName : null
    if (name === null) return null
    const v = get(name) as string
    if (v.length > HINT_MAX || CONTROL.test(v)) {
      throw clientError('invalid_request', `${name} must be at most ${HINT_MAX} characters with no control characters`)
    }
    return v
  }
  const parent = hint('SWARMBOARD_PARENT', 'FUSION_PARENT_ID')
  const swarm = hint('SWARMBOARD_SWARM', 'FUSION_SWARM_ID')

  let token: 'set' | 'unset' = 'unset'
  let tokenSource: Source | null = null
  if (get('SWARMBOARD_TOKEN') !== undefined) {
    token = 'set'
    tokenSource = 'env:SWARMBOARD_TOKEN'
    explain.push({ topic: 'identity', source: 'env:SWARMBOARD_TOKEN', outcome: 'chosen', note: 'a token is set (its value is never recorded)' })
    if (get('BOARD_TOKEN') !== undefined) {
      explain.push({ topic: 'identity', source: 'env:BOARD_TOKEN', outcome: 'ignored', note: 'SWARMBOARD_TOKEN is set' })
    }
  } else if (get('BOARD_TOKEN') !== undefined) {
    token = 'set'
    tokenSource = 'env:BOARD_TOKEN'
    explain.push({ topic: 'identity', source: 'env:BOARD_TOKEN', outcome: 'chosen', note: 'a token is set (its value is never recorded)' })
  }

  // ---- policy --------------------------------------------------------------------------------------------------
  const allowUnsafeFs = flags.allowUnsafeFs ?? (unsafeEnv === 'allow' ? true : (user?.allowUnsafeFs ?? false))
  const policy: Resolution['policy'] = Object.freeze({
    mode,
    modeSource,
    inProcess,
    tick: project?.tick ?? user?.tick ?? 'lease',
    wake: Object.freeze({
      watch: project?.wake?.watch ?? user?.wake?.watch ?? true,
      safetyPollMs: project?.wake?.safetyPollMs ?? user?.wake?.safetyPollMs ?? (ctx.platform === 'win32' ? 250 : 1500),
    }),
    daemon: Object.freeze({
      idleExitS: project?.daemon?.idleExitS ?? user?.daemon?.idleExitS ?? 600,
      spawn: project?.daemon?.spawn ?? user?.daemon?.spawn ?? 'on-demand',
    }),
    authEnforce: project?.auth?.enforce === true || user?.auth?.enforce === true,
    allowUnsafeFs,
  })

  return Object.freeze({
    target: Object.freeze({ ...target }),
    source: chosen.source,
    policy,
    identity: Object.freeze({ profile, profileSource, parent, swarm, token, tokenSource }),
    gitRoot,
    configs: Object.freeze({ project: projectFile, user: userFile }),
    explain: Object.freeze(explain.map((step) => Object.freeze({ ...step }))),
  })
}

/** ctx from process.env, process.cwd(), process.platform, os.homedir(), process.getuid?.() ?? null, nodeResolverFs. */
export function processContext(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    home: nodeOs.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    fs: nodeResolverFs,
    ...overrides,
  }
}

/**
 * The canonical env a parent hands a spawned child so it resolves the same board (g1 3.2): the resolved db (or url),
 * `SWARMBOARD_MODE` set to `res.policy.mode`, the child's profile, this resolution's profile as the parent and the
 * swarm. Every compatibility variable is set to '' (unset) so an inherited one cannot steer the child.
 * `SWARMBOARD_TOKEN` travels only when `opts.token` is passed; `SWARMBOARD_UNSAFE_FS` is intentionally not propagated.
 */
export function childEnv(
  res: Resolution,
  opts: { agent?: string | null; swarm?: string | null; token?: string },
): Record<string, string> {
  if (res.target.kind === 'memory') {
    throw clientError('invalid_request', 'an in-memory board cannot be shared with a child process')
  }
  if (opts.agent !== undefined && opts.agent !== null && !PROFILE_PATTERN.test(opts.agent)) {
    throw clientError('invalid_profile', 'the child profile must be a letter, then letters, digits or dashes, at most 32 characters')
  }
  const out: Record<string, string> = {
    SWARMBOARD_DB: res.target.kind === 'file' ? res.target.db : '',
    SWARMBOARD_URL: res.target.kind === 'url' ? res.target.url : '',
    SWARMBOARD_DIR: '',
    SWARMBOARD_DAEMON: '',
    SWARMBOARD_MODE: res.policy.mode,
    SWARMBOARD_AGENT: opts.agent ?? '',
    SWARMBOARD_PARENT: res.identity.profile ?? '',
    SWARMBOARD_SWARM: opts.swarm ?? res.identity.swarm ?? '',
    BOARD_URL: '',
    BOARD_NAME: '',
    BOARD_PROFILE: '',
    BOARD_TOKEN: '',
    FUSION_AGENT_ID: '',
    FUSION_PARENT_ID: '',
    FUSION_SWARM_ID: '',
  }
  if (opts.token !== undefined) out.SWARMBOARD_TOKEN = opts.token
  return out
}
