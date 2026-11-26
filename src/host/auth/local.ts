// HOST-4: Local identity resolver, agent cards, and safe g1 narrowing (Swarmboard v2 launch design §2.2).
//
// Attribution and accident prevention on a single-owner machine:
// - Interactive human (TTY, no agent profile) -> owner: true, member: true, actor.kind: 'person', local_unverified.
// - Cardless local agent -> owner: false, member: !authEnforce, cap: ['read','post','react','label'],
//   assurance: 'agent_delegated', locked to its own profile (as: null -> 403 agent_cannot_impersonate_human,
//   other profile -> 403 profile_mismatch).
// - Carded local agent (<boardDir>/agents/<profile>.json) -> card cap (manage stripped unless allowManage: true),
//   compiled card.can -> canHeader, card.as allowlist, impersonatePerson: true -> 403 agent_cannot_impersonate_human.
// - Non-TTY with no profile -> 401 agent_identity_required.
//
// Pure over node:fs, node:os, node:path, ../core/public.ts, and ../../client/* (no stdout/stderr logging,
// no internal barrel imports, no process-spawning or networking modules).
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import {
  checkCallerActor,
  createLocalCaller,
  forbidden,
  headerCan,
  PERMISSIONS,
  unauthorized,
  writtenCan,
  type Assurance,
  type CallerContext,
  type Permission,
} from '../../core/public.ts'
import { clientError } from '../../client/errors.ts'
import type { IdentityProvider } from '../../client/identity.ts'
import type { Env, Resolution } from '../../client/resolve.ts'

/** Safe g1 permission cap for local agents: read, post, react, label (never manage or sync by default). */
export const DEFAULT_AGENT_CAP: readonly Permission[] = Object.freeze(['read', 'post', 'react', 'label'] as const)

/** Profile grammar shared across client/host/core: a letter, then up to 31 letters, digits, or hyphens. */
export const PROFILE_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/

/** Prefix-glob pattern allowed in agent card `as` allowlists, e.g. `agy-*` or `eng-worker-*`. */
const AS_GLOB_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,30}\*$/

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS)
const PERM_INDEX = new Map<Permission, number>(PERMISSIONS.map((p, i) => [p, i]))
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

const KNOWN_CARD_KEYS: ReadonlySet<string> = new Set([
  'version',
  'profile',
  'displayName',
  'harness',
  'department',
  'captain',
  'cap',
  'can',
  'as',
  'allowManage',
  'impersonatePerson',
])

export interface AgentCardFile {
  readonly version: 1
  readonly profile: string
  readonly displayName?: string
  readonly harness?: string
  readonly department?: string
  readonly captain?: string
  readonly cap?: readonly Permission[]
  readonly can?: Readonly<Record<string, 'all' | readonly Permission[]>>
  readonly as?: readonly string[]
  readonly allowManage?: boolean
  readonly impersonatePerson: false
}

export interface ResolveLocalIdentityOptions {
  /** Explicit --as override (`undefined` = omitted; `null` = request principal without profile; `string` = profile). */
  readonly as?: string | null
  /** Environment variables (defaults to `process.env` unless `resolution` is given without `env`). */
  readonly env?: Env
  /** Whether an interactive terminal is attached (defaults to `Boolean(process.stdin.isTTY && process.stdout.isTTY)`). */
  readonly isTTY?: boolean
  /** Board directory holding optional `agents/<profile>.json` cards (derived from `resolution.target.dir` when omitted). */
  readonly boardDir?: string | null
  /** OS username for `local:user:<userId>` (defaults to sanitized `os.userInfo().username`). */
  readonly userId?: string
  /** Display handle (defaults to sanitized `userId`). */
  readonly handle?: string
  /** Display name (defaults to `handle`). */
  readonly name?: string
  /** When true, local agents receive `member: false` so explicit `board_grants` govern access. */
  readonly authEnforce?: boolean
  /** Current OS uid for POSIX card ownership checks (defaults to `process.getuid?.() ?? null`). */
  readonly uid?: number | null
  /** Platform override for tests (defaults to `process.platform`). */
  readonly platform?: NodeJS.Platform
  /** Optional `resolveBoard()` result; supplies default `boardDir`, `authEnforce`, and fallback profile. */
  readonly resolution?: Resolution
}

export interface ResolvedLocalIdentity {
  readonly provider: IdentityProvider
  readonly caller: CallerContext
  readonly card: AgentCardFile | null
  readonly assurance: Assurance
  readonly isHuman: boolean
  readonly profile: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

/** True when `value` is a syntactically valid profile name. */
export function isValidProfile(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_PATTERN.test(value)
}

function assertProfile(value: unknown, what: string): string {
  if (!isValidProfile(value)) {
    throw clientError(
      'invalid_profile',
      `${what}: profiles start with a letter and use up to 32 letters, numbers, and hyphens`,
    )
  }
  return value
}

/** Sanitizes an OS username into a safe local principal/handle token. */
export function sanitizeOsUser(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64)
  return cleaned === '' ? 'local' : cleaned
}

/** Resolves the current OS username safely even in minimal containers without `/etc/passwd` entries. */
export function resolveOsUser(env?: Env): string {
  try {
    const info = os.userInfo()
    if (info.username.trim() !== '') return sanitizeOsUser(info.username)
  } catch {
    // Fallback below when uid has no passwd entry.
  }
  const fallback = env?.USER ?? env?.LOGNAME ?? env?.USERNAME ?? ''
  return sanitizeOsUser(fallback)
}

/** Matches a concrete profile name against one card `as` entry (exact profile or `<prefix>*`). */
export function matchesAsPattern(profile: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1)
    return prefix.length > 0 && profile.startsWith(prefix)
  }
  return profile === pattern
}

/** True when `profile` matches any pattern in `patterns`. */
export function matchesAsAllowlist(profile: string, patterns: readonly string[] | undefined): boolean {
  if (patterns === undefined || patterns.length === 0) return false
  return patterns.some((p) => matchesAsPattern(profile, p))
}

/**
 * Compiles a channel permission map (`card.can`) into a canonical `x-board-can` header string
 * validated through core `writtenCan` and `headerCan`.
 */
export function compileCanHeader(can: Readonly<Record<string, 'all' | readonly Permission[]>>): string {
  const normalized = writtenCan(can)
  const parts: string[] = []
  for (const [pattern, grant] of Object.entries(normalized)) {
    parts.push(`${pattern}=${grant === 'all' ? 'all' : grant.join(',')}`)
  }
  const compiled = parts.join(';')
  // Round-trip verify length <= CAN_MAX and parser agreement.
  headerCan(compiled)
  return compiled
}

function effectiveCardCap(card: AgentCardFile): readonly Permission[] {
  const raw = card.cap ?? DEFAULT_AGENT_CAP
  const filtered = card.allowManage === true ? raw : raw.filter((p) => p !== 'manage')
  const unique = [...new Set(filtered)].sort((a, b) => PERM_INDEX.get(a)! - PERM_INDEX.get(b)!)
  return Object.freeze(unique)
}

function checkOptionalString(
  obj: Record<string, unknown>,
  key: string,
  maxLen: number,
  where: string,
): string | undefined {
  const v = obj[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.trim() === '' || v.length > maxLen || CONTROL_CHARS.test(v)) {
    throw clientError('invalid_config', `${where}: "${key}" must be a non-empty string up to ${maxLen} chars`)
  }
  return v
}

/**
 * Validates and freezes a parsed JSON agent card.
 * Rejects `impersonatePerson: true` with `403 agent_cannot_impersonate_human`.
 */
export function parseAgentCard(raw: unknown, expectedProfile?: string, sourcePath = 'agent card'): AgentCardFile {
  if (!isRecord(raw)) {
    throw clientError('invalid_config', `${sourcePath}: must be a JSON object`)
  }
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw clientError('invalid_config', `${sourcePath}: forbidden key "${key}"`)
    }
    if (!KNOWN_CARD_KEYS.has(key)) {
      throw clientError('invalid_config', `${sourcePath}: unknown key "${key}"`)
    }
  }
  if (raw.version !== 1) {
    throw clientError('invalid_config', `${sourcePath}: "version" must be 1`)
  }
  if (!isValidProfile(raw.profile)) {
    throw clientError('invalid_config', `${sourcePath}: "profile" must be a valid profile name`)
  }
  if (expectedProfile !== undefined && raw.profile !== expectedProfile) {
    throw clientError(
      'invalid_config',
      `${sourcePath}: card profile "${raw.profile}" does not match expected profile "${expectedProfile}"`,
    )
  }
  if (raw.impersonatePerson === true) {
    throw forbidden(
      `${sourcePath}: an agent card cannot set impersonatePerson: true`,
      'agent_cannot_impersonate_human',
    )
  }
  if (raw.impersonatePerson !== false) {
    throw clientError('invalid_config', `${sourcePath}: "impersonatePerson" must be false`)
  }

  let allowManage: boolean | undefined
  if (raw.allowManage !== undefined) {
    if (typeof raw.allowManage !== 'boolean') {
      throw clientError('invalid_config', `${sourcePath}: "allowManage" must be a boolean`)
    }
    allowManage = raw.allowManage
  }

  const displayName = checkOptionalString(raw, 'displayName', 120, sourcePath)
  const harness = checkOptionalString(raw, 'harness', 64, sourcePath)
  const department = checkOptionalString(raw, 'department', 120, sourcePath)
  const captain = checkOptionalString(raw, 'captain', 120, sourcePath)

  let cap: readonly Permission[] | undefined
  if (raw.cap !== undefined) {
    if (!Array.isArray(raw.cap)) {
      throw clientError('invalid_config', `${sourcePath}: "cap" must be an array of permissions`)
    }
    const seen = new Set<Permission>()
    for (const item of raw.cap) {
      if (typeof item !== 'string' || !PERMISSION_SET.has(item)) {
        throw clientError(
          'invalid_config',
          `${sourcePath}: unknown permission "${String(item)}" in "cap" (allowed: ${PERMISSIONS.join(', ')})`,
        )
      }
      seen.add(item as Permission)
    }
    cap = Object.freeze([...seen].sort((a, b) => PERM_INDEX.get(a)! - PERM_INDEX.get(b)!))
  }

  let can: Readonly<Record<string, 'all' | readonly Permission[]>> | undefined
  if (raw.can !== undefined) {
    try {
      const normalized = writtenCan(raw.can)
      compileCanHeader(normalized)
      const frozenEntries = Object.entries(normalized).map(([k, v]) => [
        k,
        v === 'all' ? 'all' : Object.freeze([...v]),
      ] as const)
      can = Object.freeze(Object.fromEntries(frozenEntries))
    } catch (err) {
      throw clientError('invalid_config', `${sourcePath}: invalid "can": ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  }

  let asPatterns: readonly string[] | undefined
  if (raw.as !== undefined) {
    if (!Array.isArray(raw.as)) {
      throw clientError('invalid_config', `${sourcePath}: "as" must be an array of profile names or prefix globs`)
    }
    const list: string[] = []
    for (const entry of raw.as) {
      if (typeof entry !== 'string' || (!PROFILE_PATTERN.test(entry) && !AS_GLOB_PATTERN.test(entry))) {
        throw clientError(
          'invalid_config',
          `${sourcePath}: invalid "as" entry "${String(entry)}" (use an exact profile or prefix glob like "agy-*")`,
        )
      }
      if (!list.includes(entry)) list.push(entry)
    }
    asPatterns = Object.freeze(list)
  }

  return Object.freeze({
    version: 1,
    profile: raw.profile,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(harness !== undefined ? { harness } : {}),
    ...(department !== undefined ? { department } : {}),
    ...(captain !== undefined ? { captain } : {}),
    ...(cap !== undefined ? { cap } : {}),
    ...(can !== undefined ? { can } : {}),
    ...(asPatterns !== undefined ? { as: asPatterns } : {}),
    ...(allowManage !== undefined ? { allowManage } : {}),
    impersonatePerson: false,
  })
}

function checkCardEntryHygiene(
  filePath: string,
  kind: 'file' | 'dir',
  uid: number | null,
  platform: NodeJS.Platform,
): fs.Stats | null {
  let st: fs.Stats
  try {
    st = fs.lstatSync(filePath)
  } catch (err) {
    const code = codeOf(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw err
  }
  if (st.isSymbolicLink()) {
    throw clientError('unsafe_config', `${filePath}: agent card path must not be a symlink`)
  }
  if (kind === 'file' && !st.isFile()) {
    throw clientError('unsafe_config', `${filePath}: agent card path must be a regular file`)
  }
  if (kind === 'dir' && !st.isDirectory()) {
    throw clientError('unsafe_config', `${filePath}: agents path must be a directory`)
  }
  if (platform !== 'win32') {
    if (uid !== null && st.uid !== uid) {
      throw clientError('unsafe_config', `${filePath}: agent card path is owned by another user (uid ${st.uid})`)
    }
    if ((st.mode & 0o022) !== 0) {
      throw clientError('unsafe_config', `${filePath}: agent card path is group- or world-writable`)
    }
  }
  return st
}

/**
 * Loads `<boardDir>/agents/<profile>.json` when present, returning `null` if no card exists.
 * Enforces profile syntax, symlink/owner/world-writable hygiene, and card schema.
 */
export function loadAgentCard(
  boardDir: string,
  profile: string,
  opts: { readonly uid?: number | null; readonly platform?: NodeJS.Platform } = {},
): AgentCardFile | null {
  const safeProfile = assertProfile(profile, 'profile')
  const platform = opts.platform ?? process.platform
  const uid = opts.uid !== undefined ? opts.uid : typeof process.getuid === 'function' ? process.getuid() : null
  const agentsDir = nodePath.join(boardDir, 'agents')
  const dirStat = checkCardEntryHygiene(agentsDir, 'dir', uid, platform)
  if (dirStat === null) return null

  const cardPath = nodePath.join(agentsDir, `${safeProfile}.json`)
  const fileStat = checkCardEntryHygiene(cardPath, 'file', uid, platform)
  if (fileStat === null) return null

  let text: string
  try {
    text = fs.readFileSync(cardPath, 'utf8')
  } catch (err) {
    const code = codeOf(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw clientError('invalid_config', `${cardPath}: cannot read agent card`, { cause: err })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw clientError('invalid_config', `${cardPath}: invalid JSON`, { cause: err })
  }

  return parseAgentCard(parsed, safeProfile, cardPath)
}

/** Writes `<boardDir>/agents/<profile>.json` atomically (`0700` dir, `0600` file) after full validation. */
export function writeAgentCard(boardDir: string, card: AgentCardFile): string {
  const validated = parseAgentCard(card, card.profile)
  const agentsDir = nodePath.join(boardDir, 'agents')
  fs.mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
  const cardPath = nodePath.join(agentsDir, `${validated.profile}.json`)
  const tmpPath = `${cardPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const payload = `${JSON.stringify(validated, null, 2)}\n`
  fs.writeFileSync(tmpPath, payload, { mode: 0o600 })
  fs.renameSync(tmpPath, cardPath)
  try {
    fs.chmodSync(cardPath, 0o600)
  } catch {
    // Best-effort on filesystems without POSIX chmod.
  }
  return cardPath
}

function readEnvProfile(env: Env): string | null {
  const keys = ['SWARMBOARD_AGENT', 'BOARD_PROFILE', 'FUSION_AGENT_ID'] as const
  for (const key of keys) {
    const raw = env[key]
    if (raw === undefined) continue
    const trimmed = raw.trim()
    if (trimmed === '') continue
    return assertProfile(trimmed, key)
  }
  return null
}

function buildAgentCaller(params: {
  readonly userId: string
  readonly handle: string
  readonly name: string
  readonly profile: string
  readonly member: boolean
  readonly cap: readonly Permission[]
  readonly canHeader?: string
  readonly displayName?: string
}): CallerContext {
  const base = createLocalCaller({
    userId: params.userId,
    handle: params.handle,
    name: params.name,
    profile: params.profile,
    owner: false,
    member: params.member,
    cap: params.cap,
    assurance: 'agent_delegated',
    verified: false,
    ...(params.canHeader !== undefined ? { canHeader: params.canHeader } : {}),
  })
  const caller: CallerContext =
    params.displayName !== undefined
      ? {
          ...base,
          actor: { ...base.actor, name: params.displayName },
        }
      : base
  checkCallerActor(caller)
  return caller
}

function buildHumanCaller(params: {
  readonly userId: string
  readonly handle: string
  readonly name: string
}): CallerContext {
  const caller = createLocalCaller({
    userId: params.userId,
    handle: params.handle,
    name: params.name,
    profile: null,
    owner: true,
    member: true,
    assurance: 'local_unverified',
    verified: false,
  })
  checkCallerActor(caller)
  return caller
}

/**
 * HOST-4 local identity resolver.
 *
 * Resolves interactive human vs agent (carded or cardless) local callers and returns an
 * `IdentityProvider` whose `callerFor(as)` enforces `agent_cannot_impersonate_human`,
 * cardless `as` lock, card `as` allowlists, and safe `g1` cap narrowing.
 */
export function resolveLocalIdentity(opts: ResolveLocalIdentityOptions = {}): ResolvedLocalIdentity {
  const env: Env = opts.env ?? (opts.resolution !== undefined ? {} : process.env)
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const platform = opts.platform ?? process.platform
  const uid = opts.uid !== undefined ? opts.uid : typeof process.getuid === 'function' ? process.getuid() : null
  const authEnforce = opts.authEnforce ?? opts.resolution?.policy.authEnforce ?? false
  const boardDir =
    opts.boardDir !== undefined
      ? opts.boardDir
      : opts.resolution?.target.kind === 'file'
        ? opts.resolution.target.dir
        : null

  const userId = opts.userId !== undefined ? sanitizeOsUser(opts.userId) : resolveOsUser(env)
  const handle = opts.handle !== undefined ? sanitizeOsUser(opts.handle) : userId
  const name = opts.name ?? handle
  const principalId = `local:user:${userId}`

  // Determine any process-bound agent profile from environment or an env-sourced Resolution.
  const resIdentity = opts.resolution?.identity
  const resEnvProfile =
    resIdentity?.profile != null && resIdentity.profileSource !== 'flag:as'
      ? assertProfile(resIdentity.profile, 'resolution.identity.profile')
      : null
  const envProfile = readEnvProfile(env) ?? resEnvProfile
  const effectiveAs: string | null | undefined =
    opts.as !== undefined
      ? opts.as
      : resIdentity?.profileSource === 'flag:as'
        ? resIdentity.profile
        : undefined

  // Case A: An agent profile is bound via env (or explicit --as <profile>).
  if (envProfile !== null || (effectiveAs !== undefined && effectiveAs !== null)) {
    const baseProfile = envProfile ?? assertProfile(effectiveAs, '--as')
    const card = boardDir !== null ? loadAgentCard(boardDir, baseProfile, { uid, platform }) : null
    const cap = card !== null ? effectiveCardCap(card) : DEFAULT_AGENT_CAP
    const canHeader = card?.can !== undefined ? compileCanHeader(card.can) : undefined
    const member = !authEnforce

    const callers = new Map<string, CallerContext>()
    const makeAgent = (targetProfile: string): CallerContext => {
      const cached = callers.get(targetProfile)
      if (cached !== undefined) return cached
      const built = buildAgentCaller({
        userId,
        handle,
        name,
        profile: targetProfile,
        member,
        cap,
        ...(canHeader !== undefined ? { canHeader } : {}),
        ...(card?.displayName !== undefined && targetProfile === card.profile ? { displayName: card.displayName } : {}),
      })
      callers.set(targetProfile, built)
      return built
    }

    const resolveTargetProfile = (requested: string | null | undefined, defaultProfile: string): string => {
      if (requested === undefined) return defaultProfile
      if (requested === null) {
        throw forbidden(
          `agent "${baseProfile}" cannot drop its profile to act as a person`,
          'agent_cannot_impersonate_human',
        )
      }
      const target = assertProfile(requested, 'as')
      if (target === baseProfile) return target
      if (card === null) {
        throw clientError(
          'profile_mismatch',
          `cardless agent "${baseProfile}" is locked to its own profile and cannot act as "${target}"`,
          { hint: `add an agent card at agents/${baseProfile}.json with an "as" allowlist to switch profiles` },
        )
      }
      if (!matchesAsAllowlist(target, card.as)) {
        throw clientError(
          'profile_mismatch',
          `agent "${baseProfile}" is not allowed by its card to act as "${target}"`,
          { hint: card.as?.length ? `allowed: ${card.as.join(', ')}` : 'card has no "as" allowlist' },
        )
      }
      return target
    }

    // If BOTH envProfile and effectiveAs were supplied, validate effectiveAs against envProfile's rules immediately.
    const initialProfile = effectiveAs !== undefined ? resolveTargetProfile(effectiveAs, baseProfile) : baseProfile
    const initialCaller = makeAgent(initialProfile)

    const provider: IdentityProvider = {
      kind: card !== null ? 'cards' : 'local',
      base: Object.freeze({ principal: principalId, profile: initialProfile }),
      callerFor(as) {
        const target = resolveTargetProfile(as, initialProfile)
        return makeAgent(target)
      },
    }

    return Object.freeze({
      provider,
      caller: initialCaller,
      card,
      assurance: 'agent_delegated',
      isHuman: false,
      profile: initialProfile,
    })
  }

  // Case B: No agent profile -> non-TTY is refused fail-closed (`401 agent_identity_required`).
  if (!isTTY) {
    throw unauthorized(
      'non-interactive session has no agent identity: refusing to act as the local human principal',
      'agent_identity_required',
      { hint: 'set SWARMBOARD_AGENT=<profile> or pass --as <profile>' },
    )
  }

  // Case C: Interactive TTY human with no agent profile.
  const humanCaller = buildHumanCaller({ userId, handle, name })
  const agentCallers = new Map<string, CallerContext>()
  const provider: IdentityProvider = {
    kind: 'local',
    base: Object.freeze({ principal: principalId, profile: null }),
    callerFor(as) {
      if (as === undefined || as === null) return humanCaller
      const target = assertProfile(as, 'as')
      const cached = agentCallers.get(target)
      if (cached !== undefined) return cached
      const card = boardDir !== null ? loadAgentCard(boardDir, target, { uid, platform }) : null
      const cap = card !== null ? effectiveCardCap(card) : DEFAULT_AGENT_CAP
      const canHeader = card?.can !== undefined ? compileCanHeader(card.can) : undefined
      const built = buildAgentCaller({
        userId,
        handle,
        name,
        profile: target,
        member: !authEnforce,
        cap,
        ...(canHeader !== undefined ? { canHeader } : {}),
        ...(card?.displayName !== undefined ? { displayName: card.displayName } : {}),
      })
      agentCallers.set(target, built)
      return built
    },
  }

  return Object.freeze({
    provider,
    caller: humanCaller,
    card: null,
    assurance: 'local_unverified',
    isHuman: true,
    profile: null,
  })
}
