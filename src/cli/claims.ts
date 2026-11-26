// Per-board, per-actor task claim proof cache ($XDG_CONFIG_HOME/swarmboard/claims/<sha256(boardKey\0actor)>.json, mode 0600).
// Enables idempotent `swarmboard tasks claim <id>` and tokenless `renew`/`release`/`complete`/`fail`/`block`
// while strictly isolating claim bearer proofs across sibling agents on the same board.
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { BoardClient } from '../client/client.ts'
import type { Env } from '../client/resolve.ts'
import { canonicalTaskKey } from './args.ts'

export interface CachedClaimProof {
  readonly epoch: number
  readonly token: string
  readonly until: string
  readonly taskId: string
  readonly thread?: string
  readonly actor: string
  readonly savedAt: string
}

type ClaimsFileMap = Record<string, CachedClaimProof>

const MEMORY_CLAIMS = new Map<string, ClaimsFileMap>()

/** Computes the canonical claim-cache board key: `file://<realpath>` for local boards, URL for remote boards. */
export function claimBoardKey(client: BoardClient): string {
  const target = client.resolution?.target
  if (target?.kind === 'file') {
    try {
      return `file://${fs.realpathSync(target.db)}`
    } catch {
      return `file://${path.resolve(target.db)}`
    }
  }
  if (target?.kind === 'url') {
    return target.url
  }
  if (client.caps.boardId) {
    return `board://${client.caps.boardId}`
  }
  return 'memory://local'
}

/** Resolves the authenticated actor ID used to partition claim proofs across sibling agents. */
export async function resolveClaimActor(client: BoardClient): Promise<string> {
  const me = await client.me()
  return me.actor
}

function claimNamespaceKey(boardKey: string, actor: string): string {
  return `${boardKey}\0${actor}`
}

function claimsDir(env: Env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (platform === 'win32') {
    const appData = env['APPDATA']?.trim()
    return path.join(appData ? appData : path.join(home, 'AppData', 'Roaming'), 'swarmboard', 'claims')
  }
  const xdg = env['XDG_CONFIG_HOME']?.trim()
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config')
  return path.join(base, 'swarmboard', 'claims')
}

function claimsFilePath(boardKey: string, actor: string, env: Env): string {
  const hash = createHash('sha256').update(claimNamespaceKey(boardKey, actor), 'utf8').digest('hex').slice(0, 32)
  return path.join(claimsDir(env), `${hash}.json`)
}

function isMemoryKey(boardKey: string): boolean {
  return boardKey.startsWith('memory://')
}

function isSafePath(p: string, expectDir: boolean): boolean {
  try {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) return false
    if (expectDir ? !st.isDirectory() : !st.isFile()) return false
    if (process.platform !== 'win32') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null
      if (uid !== null && st.uid !== uid) return false
      if ((st.mode & 0o022) !== 0) return false
    }
    return true
  } catch {
    return false
  }
}

function readClaimsMap(boardKey: string, actor: string, env: Env): ClaimsFileMap {
  const ns = claimNamespaceKey(boardKey, actor)
  if (isMemoryKey(boardKey)) {
    return { ...(MEMORY_CLAIMS.get(ns) ?? {}) }
  }
  const file = claimsFilePath(boardKey, actor, env)
  if (!isSafePath(file, false)) return {}
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as ClaimsFileMap) }
    }
  } catch {
    // Missing or unreadable claim cache is treated as empty.
  }
  return {}
}

function writeClaimsMap(boardKey: string, actor: string, env: Env, data: ClaimsFileMap): void {
  const ns = claimNamespaceKey(boardKey, actor)
  if (isMemoryKey(boardKey)) {
    MEMORY_CLAIMS.set(ns, { ...data })
    return
  }
  const dir = claimsDir(env)
  const file = claimsFilePath(boardKey, actor, env)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!isSafePath(dir, true)) return
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // Best effort on non-POSIX filesystems.
    }
  } catch {
    // Cache persistence failures must never break task operations.
  }
}

export function loadCachedClaim(boardKey: string, actor: string, taskRef: string, env: Env): CachedClaimProof | null {
  const key = canonicalTaskKey(taskRef)
  const map = readClaimsMap(boardKey, actor, env)
  const direct = map[key]
  if (direct && typeof direct.epoch === 'number' && typeof direct.token === 'string' && direct.actor === actor) {
    return direct
  }
  // Reverse lookup by thread UUID / `thr_...` alias
  for (const entry of Object.values(map)) {
    if (
      entry &&
      entry.actor === actor &&
      typeof entry.epoch === 'number' &&
      typeof entry.token === 'string' &&
      (entry.thread === taskRef || entry.thread === key)
    ) {
      return entry
    }
  }
  return null
}

export function saveCachedClaim(
  boardKey: string,
  actor: string,
  taskRef: string,
  proof: { readonly epoch: number; readonly token: string; readonly until: string; readonly thread?: string },
  env: Env,
): void {
  const key = canonicalTaskKey(taskRef)
  const map = readClaimsMap(boardKey, actor, env)
  map[key] = {
    epoch: proof.epoch,
    token: proof.token,
    until: proof.until,
    taskId: key,
    ...(proof.thread !== undefined ? { thread: proof.thread } : {}),
    actor,
    savedAt: new Date().toISOString(),
  }
  writeClaimsMap(boardKey, actor, env, map)
}

export function deleteCachedClaim(
  boardKey: string,
  actor: string,
  taskRef: string,
  env: Env,
  threadAlias?: string,
): void {
  const key = canonicalTaskKey(taskRef)
  const map = readClaimsMap(boardKey, actor, env)
  let changed = false
  if (Object.hasOwn(map, key)) {
    delete map[key]
    changed = true
  }
  for (const [entryKey, entry] of Object.entries(map)) {
    if (
      entry &&
      entry.actor === actor &&
      (entry.thread === taskRef ||
        entry.thread === key ||
        (threadAlias !== undefined && entry.thread === threadAlias))
    ) {
      delete map[entryKey]
      changed = true
    }
  }
  if (changed) writeClaimsMap(boardKey, actor, env, map)
}
