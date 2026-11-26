// Task claim proof cache (Swarmboard v2 launch design §3.3).
// Persists `{ epoch, token, until }` in process memory and `$XDG_CONFIG_HOME/swarmboard/claims/`
// (default `~/.config/swarmboard/claims/`, mode 0700 dir / 0600 file, keyed by `file://<realpath>` or URL)
// so agents do not have to round-trip 43-char claim tokens through LLM context.
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BoardClient } from '../client/client.ts'
import type { Env } from '../client/resolve.ts'

export interface CachedClaimProof {
  readonly epoch: number
  readonly token: string
  readonly until?: string
  readonly thread?: string
  readonly savedAt: string
}

interface PersistedClaimsFile {
  readonly version: 1
  readonly boardKey: string
  readonly actorKey: string
  readonly claims: Record<string, CachedClaimProof>
}

export interface ClaimCacheOptions {
  /** Logical board key (e.g. `file:///abs/path/board.db` or `https://...`). */
  readonly boardKey: string
  /** Authenticated actor ID scoping this cache (prevents cross-agent bearer token sharing on disk). */
  readonly actorKey: string
  /** Override directory for persisted claim JSON files. Pass `null` to disable disk persistence. */
  readonly claimsDir?: string | null
  readonly env?: Env
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly uid?: number | null
  readonly log?: (line: string) => void
}

/** Expire stale persisted entries older than 24h past their lease `until` timestamp. */
const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000

/** Normalizes task references like `#12`, `msg_12`, `thr_12`, `12` to canonical key `'12'`. */
export function normalizeTaskCacheKey(id: string | number): string {
  if (typeof id === 'number') return String(id)
  const trimmed = id.trim()
  const numeric = /^(?:#|msg_|thr_)?([1-9]\d{0,15})$/.exec(trimmed)
  if (numeric) return numeric[1]!
  return trimmed
}

/** Resolves `$XDG_CONFIG_HOME/swarmboard/claims` (default `<home>/.config/swarmboard/claims`; win32 `%APPDATA%/swarmboard/claims`). */
export function defaultClaimsDir(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim()
    return nodePath.win32.join(appData ? appData : nodePath.win32.join(home, 'AppData', 'Roaming'), 'swarmboard', 'claims')
  }
  const xdg = env.XDG_CONFIG_HOME?.trim()
  const base = xdg && nodePath.posix.isAbsolute(xdg) ? xdg : nodePath.posix.join(home, '.config')
  return nodePath.posix.join(base, 'swarmboard', 'claims')
}

/** Derives a stable board key (`file://<realpath>` for file boards, URL for remote boards). */
export function deriveBoardKey(client: BoardClient): string {
  const target = client.resolution?.target
  if (target?.kind === 'file') {
    let canon = target.db
    try {
      canon = fs.realpathSync(target.db)
    } catch {
      // File may not exist yet or realpath failed; fall back to resolved absolute path.
    }
    try {
      return pathToFileURL(canon).href
    } catch {
      return `file://${canon}`
    }
  }
  if (target?.kind === 'url') {
    return target.url
  }
  const boardId = client.caps.boardId
  return boardId ? `memory://${boardId}` : 'memory://ephemeral'
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidProof(v: unknown): v is CachedClaimProof {
  if (!isPlainRecord(v)) return false
  return (
    typeof v['epoch'] === 'number' &&
    Number.isInteger(v['epoch']) &&
    v['epoch'] >= 1 &&
    typeof v['token'] === 'string' &&
    v['token'].length > 0 &&
    (v['until'] === undefined || typeof v['until'] === 'string') &&
    (v['thread'] === undefined || typeof v['thread'] === 'string')
  )
}

function isStaleProof(proof: CachedClaimProof, nowMs: number): boolean {
  if (!proof.until) return false
  const untilMs = Date.parse(proof.until)
  return Number.isFinite(untilMs) && untilMs + PRUNE_GRACE_MS < nowMs
}

export class ClaimCache {
  readonly boardKey: string
  readonly actorKey: string
  readonly filePath: string | null
  readonly #dir: string | null
  readonly #platform: NodeJS.Platform
  readonly #uid: number | null
  readonly #log: ((line: string) => void) | undefined
  readonly #memory = new Map<string, CachedClaimProof>()
  /** Maps thread UUID -> canonical numeric task key for reverse lookup. */
  readonly #aliases = new Map<string, string>()

  constructor(opts: ClaimCacheOptions) {
    this.boardKey = opts.boardKey
    this.actorKey = opts.actorKey
    this.#platform = opts.platform ?? process.platform
    this.#uid = opts.uid !== undefined ? opts.uid : typeof process.getuid === 'function' ? process.getuid() : null
    this.#log = opts.log

    const disableDisk = opts.claimsDir === null || opts.boardKey.startsWith('memory://') || opts.actorKey.trim() === ''
    if (disableDisk) {
      this.#dir = null
      this.filePath = null
    } else {
      const dir = opts.claimsDir ?? defaultClaimsDir(opts.env, this.#platform, opts.home)
      const hash = createHash('sha256').update(`${opts.boardKey}\0${opts.actorKey}`).digest('hex').slice(0, 32)
      this.#dir = dir
      this.filePath = nodePath.join(dir, `${hash}.json`)
    }
  }

  /** Looks up a cached claim proof by task ID (`12`, `#12`, `msg_12`, `thr_12`, or thread UUID). */
  get(taskId: string | number): CachedClaimProof | null {
    const key = normalizeTaskCacheKey(taskId)
    const direct = this.#memory.get(key)
    if (direct !== undefined) return direct
    const aliasedKey = this.#aliases.get(key)
    if (aliasedKey !== undefined) {
      const aliased = this.#memory.get(aliasedKey)
      if (aliased !== undefined) return aliased
    }
    // Check persisted file (handles claims persisted before MCP restart or by sibling process)
    const persisted = this.#readDisk()
    if (persisted === null) return null
    const found = persisted[key]
    if (found !== undefined) {
      this.#memory.set(key, found)
      if (found.thread && found.thread !== key) this.#aliases.set(found.thread, key)
      return found
    }
    for (const [k, proof] of Object.entries(persisted)) {
      if (proof.thread === key) {
        this.#memory.set(k, proof)
        this.#aliases.set(key, k)
        return proof
      }
    }
    return null
  }

  /** Stores a claim proof in memory and atomically persists it (`0600`) to disk. */
  set(
    taskId: string | number,
    proof: { readonly epoch: number; readonly token: string; readonly until?: string; readonly thread?: string },
  ): void {
    const key = normalizeTaskCacheKey(taskId)
    const entry: CachedClaimProof = {
      epoch: proof.epoch,
      token: proof.token,
      ...(proof.until !== undefined ? { until: proof.until } : {}),
      ...(proof.thread !== undefined ? { thread: proof.thread } : {}),
      savedAt: new Date().toISOString(),
    }
    this.#memory.set(key, entry)
    if (proof.thread && proof.thread !== key) {
      this.#aliases.set(proof.thread, key)
    }
    this.#mutateDisk((claims) => {
      claims[key] = entry
    })
  }

  /** Removes a task's claim proof from memory and disk (called on release/complete/fail/cancel/claim_lost). */
  delete(taskId: string | number): void {
    const key = normalizeTaskCacheKey(taskId)
    const canonical = this.#aliases.get(key) ?? key
    const existing = this.#memory.get(canonical)
    if (existing?.thread) this.#aliases.delete(existing.thread)
    this.#aliases.delete(key)
    this.#memory.delete(key)
    this.#memory.delete(canonical)
    this.#mutateDisk((claims) => {
      delete claims[key]
      delete claims[canonical]
      for (const [k, v] of Object.entries(claims)) {
        if (v.thread === key) delete claims[k]
      }
    })
  }

  #checkHygiene(targetPath: string, kind: 'dir' | 'file'): boolean {
    let st: fs.Stats
    try {
      st = fs.lstatSync(targetPath)
    } catch (e) {
      const code = (e as { code?: string } | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return true
      this.#warn(`claim-cache: cannot stat ${targetPath}: ${code ?? 'io_error'}`)
      return false
    }
    if (st.isSymbolicLink()) {
      this.#warn(`claim-cache: refusing symlink at ${targetPath}`)
      return false
    }
    if (kind === 'dir' && !st.isDirectory()) {
      this.#warn(`claim-cache: expected directory at ${targetPath}`)
      return false
    }
    if (kind === 'file' && !st.isFile()) {
      this.#warn(`claim-cache: expected regular file at ${targetPath}`)
      return false
    }
    if (this.#platform !== 'win32') {
      if (this.#uid !== null && st.uid !== this.#uid) {
        this.#warn(`claim-cache: refusing foreign-owned path ${targetPath}`)
        return false
      }
      if ((st.mode & 0o022) !== 0) {
        this.#warn(`claim-cache: refusing group/world-writable path ${targetPath}`)
        return false
      }
    }
    return true
  }

  #readDisk(): Record<string, CachedClaimProof> | null {
    if (this.#dir === null || this.filePath === null) return null
    if (!this.#checkHygiene(this.#dir, 'dir') || !this.#checkHygiene(this.filePath, 'file')) return null
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch (e) {
      const code = (e as { code?: string } | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return {}
      this.#warn(`claim-cache: read failed (${code ?? 'io_error'})`)
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (
        !isPlainRecord(parsed) ||
        parsed['version'] !== 1 ||
        parsed['boardKey'] !== this.boardKey ||
        parsed['actorKey'] !== this.actorKey ||
        !isPlainRecord(parsed['claims'])
      ) {
        return {}
      }
      const out: Record<string, CachedClaimProof> = {}
      const nowMs = Date.now()
      for (const [k, v] of Object.entries(parsed['claims'])) {
        if (isValidProof(v) && !isStaleProof(v, nowMs)) {
          out[k] = {
            epoch: v.epoch,
            token: v.token,
            ...(v.until !== undefined ? { until: v.until } : {}),
            ...(v.thread !== undefined ? { thread: v.thread } : {}),
            savedAt: typeof v.savedAt === 'string' ? v.savedAt : new Date().toISOString(),
          }
        }
      }
      return out
    } catch {
      return {}
    }
  }

  #mutateDisk(mutator: (claims: Record<string, CachedClaimProof>) => void): void {
    if (this.#dir === null || this.filePath === null) return
    try {
      fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
      try {
        fs.chmodSync(this.#dir, 0o700)
      } catch {
        // Best-effort on non-POSIX filesystems.
      }
      if (!this.#checkHygiene(this.#dir, 'dir') || !this.#checkHygiene(this.filePath, 'file')) return
      const existing = this.#readDisk() ?? {}
      mutator(existing)
      const nowMs = Date.now()
      const pruned: Record<string, CachedClaimProof> = {}
      for (const [k, v] of Object.entries(existing)) {
        if (!isStaleProof(v, nowMs)) pruned[k] = v
      }
      const doc: PersistedClaimsFile = {
        version: 1,
        boardKey: this.boardKey,
        actorKey: this.actorKey,
        claims: pruned,
      }
      const tmp = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, this.filePath)
      try {
        fs.chmodSync(this.filePath, 0o600)
      } catch {
        // Best-effort on non-POSIX filesystems.
      }
    } catch (e) {
      const code = (e as { code?: string } | null)?.code
      this.#warn(`claim-cache: persist failed (${code ?? 'io_error'})`)
    }
  }

  #warn(message: string): void {
    this.#log?.(`[swarmboard-mcp] ${message}`)
  }
}
