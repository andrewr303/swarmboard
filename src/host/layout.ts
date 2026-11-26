// The board directory, its manifest and the filesystem guard (HOST123_DESIGN 4.3; g1 5.1-5.4 as revised there).
//
// Layout of a file board's directory:
//   <dir>/                     0700 when Swarmboard creates it (missing intermediate directories too)
//     <db>                     pre-created 0600 (SQLite then creates -wal/-shm with the same mode)
//     <db>-wal  <db>-shm       SQLite's
//     <db>.wakeup              pre-created 0-byte 0600 whenever missing
//     <db>.wakeup.lock         the store's O_EXCL mutex (never pre-created: its existence is the lock)
//     <db>.jsonl               pre-created 0-byte 0600 whenever missing
//     <db>.manifest.json       0600, written once (tmp + link), then verified on every open
//     agents/<profile>.json    HOST-4 (cards); not touched here
//     .gitignore               only for the default git dir: "*\n!config.json\n"
//
// The guard is attribution and accident protection for one OS user's own processes, NOT a security boundary:
// any process running as the same user can edit these files directly (rule 11).
import * as fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import * as nodePath from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import {
  BOARD_ID_PATTERN,
  BoardService,
  SqliteUnifiedStore,
  type BoardServiceOptions,
  type SqliteStoreOptions,
} from '../core/public.ts'
import { clientError } from '../client/errors.ts'
import { processContext, type BoardTarget, type Env, type ExplainStep } from '../client/resolve.ts'
import { CLIENT_VERSION } from '../client/version.ts'

type PathModule = typeof nodePath.posix

/** The path flavour a path was written in (a drive letter or a UNC prefix means win32). */
const pathOf = (sample: string): PathModule => (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(sample) ? nodePath.win32 : nodePath.posix)

// ---------------------------------------------------------------------------------------------------------------
// Paths

export interface BoardPaths {
  readonly db: string
  readonly dir: string
  readonly wal: string
  readonly shm: string
  readonly wakeup: string
  readonly wakeupLock: string
  readonly jsonl: string
  readonly manifest: string
  readonly agents: string
}

/** Every path of a file board, from its absolute db path. Pure. */
export function boardPaths(db: string): BoardPaths {
  const P = pathOf(db)
  const dir = P.dirname(db)
  return Object.freeze({
    db,
    dir,
    wal: `${db}-wal`,
    shm: `${db}-shm`,
    wakeup: `${db}.wakeup`,
    wakeupLock: `${db}.wakeup.lock`,
    jsonl: `${db}.jsonl`,
    manifest: `${db}.manifest.json`,
    agents: P.join(dir, 'agents'),
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest

export interface Manifest {
  readonly version: 1
  readonly boardId: string
  readonly db: string
  readonly sidecars: { readonly wakeup: string; readonly jsonl: string }
  readonly createdBy: string
  readonly createdAt: string
}
export const MANIFEST_VERSION = 1

type ManifestRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly manifest: Manifest }
  | { readonly kind: 'malformed'; readonly why: string }
  | { readonly kind: 'newer'; readonly version: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parses manifest text. A version above MANIFEST_VERSION is 'newer' whatever else it holds. */
function parseManifest(text: string): ManifestRead {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'malformed', why: 'not JSON' }
  }
  if (!isObj(raw)) return { kind: 'malformed', why: 'not an object' }
  const v = raw.version
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return { kind: 'malformed', why: 'version' }
  if (v > MANIFEST_VERSION) return { kind: 'newer', version: v }
  const { boardId, db, sidecars, createdBy, createdAt } = raw
  if (typeof boardId !== 'string' || !BOARD_ID_PATTERN.test(boardId)) return { kind: 'malformed', why: 'boardId' }
  if (typeof db !== 'string' || db === '') return { kind: 'malformed', why: 'db' }
  if (!isObj(sidecars) || typeof sidecars.wakeup !== 'string' || typeof sidecars.jsonl !== 'string') {
    return { kind: 'malformed', why: 'sidecars' }
  }
  if (typeof createdBy !== 'string') return { kind: 'malformed', why: 'createdBy' }
  if (typeof createdAt !== 'string') return { kind: 'malformed', why: 'createdAt' }
  return {
    kind: 'ok',
    manifest: Object.freeze({
      version: 1,
      boardId,
      db,
      sidecars: Object.freeze({ wakeup: sidecars.wakeup, jsonl: sidecars.jsonl }),
      createdBy,
      createdAt,
    }),
  }
}

/** Reads `<db>.manifest.json`; never creates anything. */
function readManifest(path: string): ManifestRead {
  let text: string
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (e) {
    const code = (e as { code?: string } | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    if (code === 'EISDIR') return { kind: 'malformed', why: 'a directory' }
    throw e
  }
  return parseManifest(text)
}

/** The manifest this build writes for `paths` and `boardId`. */
function expectedManifest(paths: BoardPaths, boardId: string, createdAt: string): Manifest {
  const base = pathOf(paths.db).basename(paths.db)
  return {
    version: 1,
    boardId,
    db: base,
    sidecars: { wakeup: `${base}.wakeup`, jsonl: `${base}.jsonl` },
    createdBy: `swarmboard ${CLIENT_VERSION}`,
    createdAt,
  }
}

const malformedError = (path: string, why: string) =>
  clientError('manifest_mismatch', `the board manifest ${path} is malformed (${why})`, {
    hint: 'restore the manifest, or move it aside to let Swarmboard write a new one for this board file',
    details: { reason: 'malformed', path },
  })

const newerManifestError = (path: string, version: number) =>
  clientError('schema_too_new', `the board manifest ${path} has version ${version}; this Swarmboard reads version ${MANIFEST_VERSION}`, {
    hint: 'upgrade Swarmboard',
    details: { what: 'manifest', version, path },
  })

// ---------------------------------------------------------------------------------------------------------------
// The filesystem guard

export type FsKind = 'local' | 'network' | 'cloud-sync' | 'wsl-boundary' | 'vm-share' | 'removable-or-network' | 'unknown'
export type LocationReason =
  | 'network-fs' | 'cloud-sync' | 'wsl-boundary' | 'vm-share' | 'removable-or-network' // downgradable
  | 'symlink' | 'writable-dir' | 'writable-parent' | 'foreign-owner' // never downgradable

const DOWNGRADABLE: ReadonlySet<LocationReason> = new Set(['network-fs', 'cloud-sync', 'wsl-boundary', 'vm-share', 'removable-or-network'])

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other'

/** One lstat fact. `dir`: the board dir (its real dir when it is a symlink); `parent`: the real dir's parent;
 *  `anchor`: the deepest existing ancestor when the board dir does not exist; `file`: an existing board file. */
export interface LocationEntry {
  readonly role: 'dir' | 'parent' | 'anchor' | 'file'
  readonly path: string
  readonly kind: EntryKind
  readonly mode: number
  readonly uid: number
}

export interface LocationFacts {
  readonly platform: NodeJS.Platform
  /** The db path as resolved. */
  readonly path: string
  /** The db path under the canonical directory (the real dir, or the real anchor plus the missing tail). */
  readonly canonical: string
  /** realpath of the dir when it exists. */
  readonly realDir: string | null
  /** The dir itself when it exists, else its deepest existing ancestor. */
  readonly anchor: string
  /** statfs type of the real dir (or anchor); null when statfs failed or win32 answered 0. */
  readonly fsType: number | null
  /** linux, and /proc/version mentions Microsoft. */
  readonly isWsl: boolean
  readonly home: string
  readonly env: Env
  readonly entries: readonly LocationEntry[]
  readonly uid: number | null
}

export interface LocationRefusal {
  readonly reason: LocationReason
  readonly path: string
  readonly downgradable: boolean
}

export interface LocationVerdict {
  readonly kind: FsKind
  readonly refusals: readonly LocationRefusal[]
  readonly warnings: readonly ExplainStep[]
}

export interface LocationProbe {
  statfsType(p: string): number | null
  lstat(p: string): { kind: EntryKind; mode: number; uid: number } | null
  realpath(p: string): string | null
  procVersion(): string | null
}

export const nodeLocationProbe: LocationProbe = {
  statfsType(p) {
    try {
      return Number(fs.statfsSync(p).type)
    } catch {
      return null
    }
  },
  lstat(p) {
    try {
      const st = fs.lstatSync(p, { throwIfNoEntry: false })
      if (!st) return null
      const kind: EntryKind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
      return { kind, mode: st.mode, uid: st.uid }
    } catch (e) {
      if (codeOf(e) === 'ENOTDIR') return null
      throw e
    }
  },
  realpath(p) {
    try {
      return fs.realpathSync(p)
    } catch {
      return null
    }
  },
  procVersion() {
    try {
      return fs.readFileSync('/proc/version', 'utf8')
    } catch {
      return null
    }
  },
}

/** Reads (never writes) the facts the guard judges. */
export function probeLocation(
  paths: BoardPaths,
  ctx: { platform: NodeJS.Platform; home: string; env: Env; uid: number | null },
  probe: LocationProbe = nodeLocationProbe,
): LocationFacts {
  const P = ctx.platform === 'win32' ? nodePath.win32 : nodePath.posix
  const entries: LocationEntry[] = []
  const dirSt = probe.lstat(paths.dir)
  let realDir: string | null = null
  let dirIsDir = false
  let anchor = paths.dir
  let realAnchor = paths.dir
  let canonicalDir: string
  if (dirSt) {
    realDir = probe.realpath(paths.dir) ?? paths.dir
    canonicalDir = realDir
    const real = dirSt.kind === 'symlink' ? probe.lstat(realDir) : dirSt
    if (real) {
      entries.push({ role: 'dir', path: realDir, ...real })
      dirIsDir = real.kind === 'dir'
    }
    const parentPath = P.dirname(realDir)
    if (parentPath !== realDir) {
      const parent = probe.lstat(parentPath)
      if (parent) entries.push({ role: 'parent', path: parentPath, ...parent })
    }
  } else {
    let anchorSt: ReturnType<LocationProbe['lstat']> = null
    for (;;) {
      const up = P.dirname(anchor)
      if (up === anchor) break
      anchor = up
      anchorSt = probe.lstat(anchor)
      if (anchorSt) break
    }
    realAnchor = probe.realpath(anchor) ?? anchor
    const resolvedAnchor = anchorSt?.kind === 'symlink' ? probe.lstat(realAnchor) : anchorSt
    if (resolvedAnchor) entries.push({ role: 'anchor', path: realAnchor, ...resolvedAnchor })
    canonicalDir = P.join(realAnchor, P.relative(anchor, paths.dir))
  }
  const canonical = P.join(canonicalDir, P.basename(paths.db))
  if (dirIsDir) {
    const files = boardPaths(canonical)
    for (const f of [files.db, files.wal, files.shm, files.wakeup, files.jsonl, files.manifest]) {
      const st = probe.lstat(f)
      if (st) entries.push({ role: 'file', path: f, ...st })
    }
  }
  let fsType = probe.statfsType(realDir ?? realAnchor)
  if (ctx.platform === 'win32' && fsType === 0) fsType = null
  const isWsl = ctx.platform === 'linux' && /microsoft/i.test(probe.procVersion() ?? '')
  return Object.freeze({
    platform: ctx.platform,
    path: paths.db,
    canonical,
    realDir,
    anchor,
    fsType,
    isWsl,
    home: ctx.home,
    env: ctx.env,
    entries: Object.freeze(entries),
    uid: ctx.uid,
  })
}

const LINUX_NETWORK = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x564c, 0x5346414f, 0x00c36400, 0x73757245])
const LINUX_VM_SHARE = new Set([0x01021997, 0x6a656a63])
const LINUX_LOCAL = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x2fc12fc1, 0xf2f52010, 0xca451a4e, 0x794c7630])
const DARWIN_LOCAL = new Set([0x1a, 0x11])
const DARWIN_MOUNT_ROOTS = ['/Volumes/', '/net/', '/Network/', '/automount/']

const hex = (n: number | null): string => (n === null ? 'unknown' : `0x${n.toString(16)}`)

/** Prefix match on a path, case-insensitive on darwin and win32. */
function under(path: string, root: string, platform: NodeJS.Platform): boolean {
  if (platform === 'darwin' || platform === 'win32') return path.toLowerCase().startsWith(root.toLowerCase())
  return path.startsWith(root)
}

function cloudRoots(facts: LocationFacts): string[] {
  const P = facts.platform === 'win32' ? nodePath.win32 : nodePath.posix
  const h = facts.home
  const sep = P.sep
  const roots = [
    P.join(h, 'Library', 'Mobile Documents') + sep,
    P.join(h, 'Library', 'CloudStorage') + sep,
    P.join(h, 'Dropbox') + sep,
    P.join(h, 'Google Drive') + sep,
    P.join(h, 'OneDrive'), // any suffix: OneDrive, OneDrive - Org
    P.join(h, 'iCloudDrive') + sep,
  ]
  if (facts.platform === 'win32') {
    for (const k of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
      const v = facts.env[k]?.trim()
      if (v) roots.push(v.endsWith(sep) ? v : v + sep)
    }
  }
  return roots
}

const warnStep = (name: string, path: string, note: string): ExplainStep =>
  Object.freeze({ topic: 'location', source: 'layout', outcome: 'warn', value: path, note: `${name}: ${note}` })

/** The guard's verdict on probed facts. Pure. Downgradable reasons become warn steps under allowUnsafeFs; the
 *  permission and link reasons never do. Accident protection, not a security boundary (rule 11). */
export function checkLocation(facts: LocationFacts, opts: { allowUnsafeFs: boolean }): LocationVerdict {
  const refusals: LocationRefusal[] = []
  const warnings: ExplainStep[] = []
  const at = facts.canonical
  const refuse = (reason: LocationReason, path: string): void => {
    refusals.push({ reason, path, downgradable: DOWNGRADABLE.has(reason) })
  }
  let kind: FsKind = 'unknown'
  let fsReason: LocationReason | null = null
  const t = facts.fsType
  const unknownWarn = (): void => {
    warnings.push(warnStep('unknown-fs', at, `the filesystem type ${hex(t)} is not known to be local: Swarmboard cannot tell whether SQLite's locks work here`))
  }
  if (facts.platform === 'linux') {
    if (facts.isWsl && /^\/mnt\/[A-Za-z]\//.test(at)) {
      kind = 'wsl-boundary'
      fsReason = 'wsl-boundary'
    } else if (t !== null && LINUX_NETWORK.has(t)) {
      kind = 'network'
      fsReason = 'network-fs'
    } else if (t !== null && LINUX_VM_SHARE.has(t)) {
      kind = 'vm-share'
      fsReason = 'vm-share'
    } else if (t !== null && LINUX_LOCAL.has(t)) {
      kind = 'local'
    } else {
      unknownWarn()
    }
  } else if (facts.platform === 'darwin') {
    if (t !== null && DARWIN_LOCAL.has(t)) {
      kind = 'local'
    } else if (DARWIN_MOUNT_ROOTS.some((r) => under(at, r, 'darwin') || under(facts.path, r, 'darwin'))) {
      kind = 'removable-or-network'
      fsReason = 'removable-or-network'
    } else {
      unknownWarn()
    }
  } else if (facts.platform === 'win32') {
    const p = facts.path
    if (/^\\\\wsl(?:\$|\.localhost)\\/i.test(p)) {
      kind = 'wsl-boundary'
      fsReason = 'wsl-boundary'
    } else if (/^\\\\(?![?.]\\)[^\\]+\\[^\\]+/.test(p)) {
      kind = 'network'
      fsReason = 'network-fs'
    } else {
      warnings.push(warnStep('unknown-fs', p, 'mapped network drives cannot be told apart from local disks on Windows'))
    }
  } else if (t === null) {
    unknownWarn()
  }
  if (fsReason) refuse(fsReason, at)

  const roots = cloudRoots(facts)
  if (roots.some((r) => under(at, r, facts.platform) || under(facts.path, r, facts.platform))) {
    if (kind === 'local' || kind === 'unknown') kind = 'cloud-sync'
    refuse('cloud-sync', at)
  }

  if (facts.platform === 'win32') {
    warnings.push(warnStep('not-checked', facts.path, 'file permissions and links are not checked on this platform'))
  } else {
    for (const e of facts.entries) {
      const sticky = (e.mode & 0o1000) !== 0
      switch (e.role) {
        case 'file':
          if (e.kind === 'symlink') refuse('symlink', e.path)
          else if ((e.mode & 0o044) !== 0) {
            warnings.push(warnStep('readable-by-others', e.path, `${e.path} can be read by other users (mode ${(e.mode & 0o777).toString(8)})`))
          }
          break
        case 'dir':
          if (facts.uid !== null && e.uid !== facts.uid) refuse('foreign-owner', e.path)
          if ((e.mode & 0o002) !== 0) refuse('writable-dir', e.path)
          else if ((e.mode & 0o020) !== 0) {
            warnings.push(warnStep('writable-by-group', e.path, `the board directory ${e.path} is writable by its group`))
          }
          if ((e.mode & 0o044) !== 0) {
            warnings.push(warnStep('readable-by-others', e.path, `the board directory ${e.path} can be listed by other users`))
          }
          break
        case 'parent':
        case 'anchor':
          // Owned by another (non-root) user: they could rename the board dir away. Root-owned ancestors (/, /tmp)
          // are the normal case: root can do anything anyway.
          if (e.role === 'anchor' && facts.uid !== null && e.uid !== facts.uid && e.uid !== 0) refuse('foreign-owner', e.path)
          if ((e.mode & 0o002) !== 0 && !sticky) refuse('writable-parent', e.path)
          else if ((e.mode & 0o020) !== 0 && !sticky) {
            warnings.push(warnStep('writable-by-group', e.path, `${e.path}, which holds the board directory, is writable by its group`))
          }
          break
      }
    }
  }

  let kept = refusals
  if (opts.allowUnsafeFs) {
    kept = []
    for (const r of refusals) {
      if (r.downgradable) warnings.push(warnStep(r.reason, r.path, `${r.path} is refused by default (${r.reason}); allowed by allowUnsafeFs`))
      else kept.push(r)
    }
  }
  return Object.freeze({ kind, refusals: Object.freeze(kept), warnings: Object.freeze(warnings) })
}

function unsafeLocation(verdict: LocationVerdict) {
  const reasons = [...new Set(verdict.refusals.map((r) => r.reason))]
  const list = verdict.refusals.map((r) => `${r.reason} (${r.path})`).join(', ')
  const fixable = verdict.refusals.every((r) => r.downgradable)
  return clientError('unsafe_location', `Swarmboard will not open a board here: ${list}`, {
    hint: fixable
      ? 'move the board to a local disk, or pass allowUnsafeFs if you accept the risk'
      : 'fix the permissions or links named here; allowUnsafeFs does not override them',
    details: { reasons, kind: verdict.kind, refusals: verdict.refusals.map((r) => ({ reason: r.reason, path: r.path })) },
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Step 2b: the read-only content check of an existing file before opening the store (SEC-1, F21)

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1')
const SLEEP = new Int32Array(new SharedArrayBuffer(4))
const sleepSync = (ms: number): void => {
  Atomics.wait(SLEEP, 0, 0, ms)
}
const DEFAULT_PROBE_BUDGET_MS = 1000
const MAX_PROBE_ATTEMPT_TIMEOUT_MS = 50
const MAX_PROBE_ATTEMPTS = 40

type Content = 'adopt' | 'not_sqlite' | 'foreign' | 'busy'

const isBusyLike = (e: unknown): boolean => {
  const v = e as { errcode?: unknown; errstr?: unknown; message?: unknown } | null
  if (typeof v?.errcode === 'number') {
    const primary = v.errcode & 0xff
    if (primary === 5 || primary === 6) return true
  }
  const text = `${typeof v?.errstr === 'string' ? v.errstr : ''} ${typeof v?.message === 'string' ? v.message : ''}`
  return /database (?:table )?is (?:locked|busy)/i.test(text)
}

/** Reads, never writes: the header, then the table list through a read-only (immutable when closed WAL) connection. */
function classifyOnce(paths: BoardPaths, timeoutMs: number): Content {
  const head = Buffer.alloc(100)
  let n: number
  let fd: number
  try {
    fd = fs.openSync(paths.db, 'r')
  } catch {
    return 'not_sqlite'
  }
  try {
    n = fs.readSync(fd, head, 0, 100, 0)
  } catch {
    return 'not_sqlite'
  } finally {
    fs.closeSync(fd)
  }
  if (n === 0) return 'adopt' // the pre-create window
  if (n < SQLITE_HEADER.length || !head.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) return 'not_sqlite'
  const url = pathToFileURL(paths.db)
  // A plain read-only open of a closed WAL file creates -wal/-shm; immutable=1 does not (F21).
  // Restrict immutable=1 to closed WAL headers so rollback-journal locks are still observed.
  const isWalHeader = head[18] === 2 || head[19] === 2
  if (isWalHeader && !fs.existsSync(paths.wal) && !fs.existsSync(paths.shm)) url.searchParams.set('immutable', '1')
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(url, { readOnly: true, timeout: Math.max(0, Math.trunc(timeoutMs)) })
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
      .all() as { name: string }[]
    if (rows.length === 0) return 'adopt'
    return rows.some((r) => r.name === 'board_meta') ? 'adopt' : 'foreign'
  } catch (e) {
    return isBusyLike(e) ? 'busy' : 'not_sqlite'
  } finally {
    try {
      db?.close()
    } catch {
      // nothing to release
    }
  }
}

const fileKey = (paths: BoardPaths): string => {
  const st = fs.statSync(paths.db, { throwIfNoEntry: false, bigint: true })
  const side = (p: string): string => (fs.existsSync(p) ? '1' : '0')
  return st ? `${st.ino}:${st.size}:${st.mtimeNs}:${side(paths.wal)}${side(paths.shm)}${side(`${paths.db}-journal`)}` : 'gone'
}

/** Throws 409 manifest_mismatch unless the file is empty, an empty SQLite db, or a board (`board_meta`), or 503
 *  unavailable (retryAfter: 1) if the database stays locked past the probe budget. A result seen while another
 *  process was writing the file (it changed under the read) is looked at again within the bounded budget. */
function checkContent(paths: BoardPaths, busyTimeoutMs?: number): void {
  const budgetMs =
    busyTimeoutMs !== undefined && Number.isFinite(busyTimeoutMs)
      ? Math.max(0, Math.min(Math.trunc(busyTimeoutMs), DEFAULT_PROBE_BUDGET_MS))
      : DEFAULT_PROBE_BUDGET_MS
  const deadline = Date.now() + budgetMs
  let last: Content = 'not_sqlite'
  for (let attempt = 0; attempt < MAX_PROBE_ATTEMPTS; attempt++) {
    const before = fileKey(paths)
    const remaining = Math.max(0, deadline - Date.now())
    const attemptTimeout = Math.min(MAX_PROBE_ATTEMPT_TIMEOUT_MS, remaining)
    last = classifyOnce(paths, attemptTimeout)
    if (last === 'adopt') return
    const moving = last === 'busy' || fileKey(paths) !== before
    if (!moving) break
    const left = deadline - Date.now()
    if (left <= 0) break
    sleepSync(Math.min(5 * (attempt + 1), 25, left))
  }
  if (last === 'busy') {
    throw clientError('unavailable', `${paths.db} is busy: try again`, {
      hint: 'another process holds a lock on this database; retry shortly',
      retryAfter: 1,
      details: { reason: 'busy', path: paths.db },
    })
  }
  if (last === 'foreign') {
    throw clientError('manifest_mismatch', `${paths.db} holds another application's database`, {
      hint: 'point Swarmboard at another path; it never adopts a database it did not create',
      details: { reason: 'foreign', path: paths.db },
    })
  }
  throw clientError('manifest_mismatch', `${paths.db} is not a SQLite file: Swarmboard will not open it as a board`, {
    hint: 'point Swarmboard at another path',
    details: { reason: 'not_sqlite', path: paths.db },
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Opening

export interface OpenBoardOptions {
  /** openBoard only; forwarded verbatim to the BoardService. */
  readonly boardOptions?: BoardServiceOptions
  /** Never jsonlPath/wakeupPath: the sidecars always sit next to the db. */
  readonly storeOptions?: Pick<SqliteStoreOptions, 'busyTimeoutMs' | 'onSidecarError' | 'testHooks'>
  readonly allowUnsafeFs?: boolean
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly env?: Env
  readonly uid?: number | null
  readonly probe?: LocationProbe
  readonly clock?: () => Date
  /** Test-only crash points, inert when unset (HS-41, HS-44). */
  readonly testHooks?: { beforeManifest?(): void; afterTmpWrite?(): void }
}

export interface OpenedStore {
  readonly store: SqliteUnifiedStore
  /** null for ':memory:'. */
  readonly paths: BoardPaths | null
  readonly manifest: Manifest | null
  /** This call created the db file. */
  readonly created: boolean
  /** false when the store refuses writes (store.writeRefusal() !== null at open); then manifest may be null (F20, CR-1). */
  readonly writable: boolean
  readonly warnings: readonly ExplainStep[]
  /** Idempotent; closes the store. */
  close(): void
}

export interface OpenedBoard extends OpenedStore {
  readonly board: BoardService
}

/** Only the store options a layout open forwards: never a sidecar path override, whatever the caller's object holds. */
function storeOptionsOf(o: OpenBoardOptions['storeOptions']): Omit<SqliteStoreOptions, 'path'> {
  const out: Omit<SqliteStoreOptions, 'path'> = {}
  if (o?.busyTimeoutMs !== undefined) out.busyTimeoutMs = o.busyTimeoutMs
  if (o?.onSidecarError !== undefined) out.onSidecarError = o.onSidecarError
  if (o?.testHooks !== undefined) out.testHooks = o.testHooks
  return out
}

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

const notDirectoryError = (db: string, path: string, cause?: unknown) =>
  clientError('invalid_db_path', `cannot open board at ${db}: ${path} is not a directory`, {
    hint: 'point Swarmboard at a board file inside a directory',
    details: { reason: 'not_a_directory', path, db },
    ...(cause !== undefined ? { cause } : {}),
  })

function lstatExisting(path: string, db: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(path, { throwIfNoEntry: false })
  } catch (e) {
    if (codeOf(e) === 'ENOTDIR') throw notDirectoryError(db, pathOf(path).dirname(path), e)
    throw e
  }
}

/** `openSync(path, 'wx', mode)`; true when this call created it, false on EEXIST. */
function createExclusive(path: string, mode: number, text?: string, db?: string): boolean {
  let fd: number
  try {
    fd = fs.openSync(path, 'wx', mode)
  } catch (e) {
    const c = codeOf(e)
    if (c === 'EEXIST') return false
    if (c === 'ENOTDIR' && db !== undefined) throw notDirectoryError(db, pathOf(path).dirname(path), e)
    throw e
  }
  try {
    if (text !== undefined) fs.writeSync(fd, text)
  } finally {
    fs.closeSync(fd)
  }
  return true
}

function finish(o: Omit<OpenedStore, 'close'>): OpenedStore {
  const store = o.store
  return Object.freeze({ ...o, warnings: Object.freeze([...o.warnings]), close: () => store.close() })
}

/**
 * Opens (or creates) a board's store under the layout rules, in section 4.3's order: (1) the guard, then the
 * canonical paths; (2) the manifest read; (2b) the content check of an existing db; (3) `no_board` for a missing
 * db with a manifest (nothing created); (4) mkdir 0700; (5) the default dir's .gitignore; (6) the 0600 pre-create
 * of the db and of each missing sidecar; (7) the store, with no sidecar override; (8) its identity (a write-refused
 * board without one opens read-only); (9) the manifest, written once or verified. Never leaves an open store behind
 * on a throw. Builds no BoardService.
 */
export function openBoardStore(target: Extract<BoardTarget, { kind: 'file' | 'memory' }>, opts: OpenBoardOptions = {}): OpenedStore {
  if (target.kind === 'memory') {
    const store = new SqliteUnifiedStore({ path: ':memory:', ...storeOptionsOf(opts.storeOptions) })
    return finish({ store, paths: null, manifest: null, created: true, writable: store.writeRefusal() === null, warnings: [] })
  }
  const proc = processContext()
  const ctx = {
    platform: opts.platform ?? proc.platform,
    home: opts.home ?? proc.home,
    env: opts.env ?? proc.env,
    uid: opts.uid !== undefined ? opts.uid : proc.uid,
  }
  // (1) the guard, on the path as resolved; every later step uses the canonical paths.
  const facts = probeLocation(boardPaths(target.db), ctx, opts.probe ?? nodeLocationProbe)
  const notDir = facts.entries.find((e) => (e.role === 'dir' || e.role === 'anchor') && e.kind !== 'dir')
  if (notDir) throw notDirectoryError(target.db, notDir.path)
  const verdict = checkLocation(facts, { allowUnsafeFs: opts.allowUnsafeFs ?? false })
  if (verdict.refusals.length > 0) throw unsafeLocation(verdict)
  const warnings: ExplainStep[] = [...verdict.warnings]
  const paths = boardPaths(facts.canonical)

  // (2) what is there
  const dbExists = lstatExisting(paths.db, paths.db) !== undefined
  const man = readManifest(paths.manifest)
  // (2b) never open or migrate another application's file, even when a manifest is present
  if (dbExists) checkContent(paths, opts.storeOptions?.busyTimeoutMs)
  // (3) a manifest without its db: the board was moved or deleted; create nothing
  if (!dbExists && man.kind !== 'absent') {
    const id = man.kind === 'ok' ? ` ${man.manifest.boardId}` : ''
    throw clientError(
      'no_board',
      `the manifest says board${id} lived at ${paths.db}, but the file is gone: restore it, or move ${paths.manifest} aside to start a new board`,
      { details: { path: paths.db, manifest: paths.manifest } },
    )
  }
  // (4) the directory, 0700 (missing intermediate directories too)
  if (lstatExisting(paths.dir, paths.db) === undefined) {
    try {
      fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
    } catch (e) {
      if (codeOf(e) === 'ENOTDIR' || codeOf(e) === 'EEXIST') throw notDirectoryError(paths.db, paths.dir, e)
      throw e
    }
  }
  // (5) the default git dir keeps itself out of the repository; the repo's own .gitignore is never edited
  if (target.defaultDir) createExclusive(nodePath.join(paths.dir, '.gitignore'), 0o644, '*\n!config.json\n', paths.db)
  // (6) the db and every missing sidecar, 0600 (the core would create sidecars 0644/umask)
  const created = dbExists ? false : createExclusive(paths.db, 0o600, undefined, paths.db)
  createExclusive(paths.wakeup, 0o600, undefined, paths.db)
  createExclusive(paths.jsonl, 0o600, undefined, paths.db)
  // (7) the store, never with a sidecar override
  const store = new SqliteUnifiedStore({ path: paths.db, ...storeOptionsOf(opts.storeOptions) })
  try {
    // (8) identity
    const identity = store.identity()
    const refusal = store.writeRefusal()
    opts.testHooks?.beforeManifest?.()
    if (identity === null) {
      if (refusal === null) throw clientError('internal', `the board file ${paths.db} has no identity after open`)
      // (CR-1, F20) a newer build's board: readable, never written, nothing to pin the manifest to
      let manifest: Manifest | null = null
      if (man.kind === 'malformed') throw malformedError(paths.manifest, man.why)
      if (man.kind === 'newer') throw newerManifestError(paths.manifest, man.version)
      if (man.kind === 'ok') manifest = man.manifest
      warnings.push(
        Object.freeze({
          topic: 'manifest',
          source: 'layout',
          outcome: 'warn',
          value: paths.manifest,
          note: `manifest-unverified: the board refuses writes (${refusal.message}), so it was opened read-only and its manifest was not ${manifest ? 'checked' : 'written'}`,
        }),
      )
      return finish({ store, paths, manifest, created, writable: false, warnings })
    }
    // (9) the manifest: written once, or verified
    const manifest = settleManifest(paths, man, identity.boardId, opts)
    return finish({ store, paths, manifest, created, writable: refusal === null, warnings })
  } catch (e) {
    store.close()
    throw e
  }
}

function verifyManifest(paths: BoardPaths, read: ManifestRead, boardId: string): Manifest {
  if (read.kind === 'absent') throw clientError('internal', `the board manifest ${paths.manifest} vanished while it was being verified`)
  if (read.kind === 'malformed') throw malformedError(paths.manifest, read.why)
  if (read.kind === 'newer') throw newerManifestError(paths.manifest, read.version)
  const m = read.manifest
  if (m.boardId !== boardId) {
    throw clientError('manifest_mismatch', `${paths.db} holds board ${boardId}, but its manifest names board ${m.boardId}`, {
      hint: 'another board file was copied over this one: restore the right file, or move the manifest aside',
      details: { reason: 'board', manifest: m.boardId, db: boardId, path: paths.manifest },
    })
  }
  const want = expectedManifest(paths, boardId, '')
  if (m.db !== want.db || m.sidecars.wakeup !== want.sidecars.wakeup || m.sidecars.jsonl !== want.sidecars.jsonl) {
    throw clientError('manifest_mismatch', `the board manifest ${paths.manifest} pins other file names than ${want.db}`, {
      hint: 'the sidecars always sit next to the db as <db>.wakeup and <db>.jsonl',
      details: { reason: 'sidecars', path: paths.manifest },
    })
  }
  return m
}

function settleManifest(paths: BoardPaths, read: ManifestRead, boardId: string, opts: OpenBoardOptions): Manifest {
  if (read.kind !== 'absent') return verifyManifest(paths, read, boardId)
  const manifest = expectedManifest(paths, boardId, (opts.clock ?? (() => new Date()))().toISOString())
  const tmp = `${paths.manifest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    createExclusive(tmp, 0o600, `${JSON.stringify(manifest, null, 2)}\n`)
    opts.testHooks?.afterTmpWrite?.()
    try {
      fs.linkSync(tmp, paths.manifest)
    } catch (e) {
      if (codeOf(e) !== 'EEXIST') throw e
      // Another opener linked its manifest first: it must name the same board.
      return verifyManifest(paths, readManifest(paths.manifest), boardId)
    }
    return parseManifestOk(manifest)
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // a crash window leaves it; layoutReport lists strays
    }
  }
}

const parseManifestOk = (m: Manifest): Manifest =>
  Object.freeze({ ...m, sidecars: Object.freeze({ ...m.sidecars }) })

/** openBoardStore, then `new BoardService(store, boardOptions)`; closes the store on a throw. */
export function openBoard(target: Extract<BoardTarget, { kind: 'file' | 'memory' }>, opts: OpenBoardOptions = {}): OpenedBoard {
  const opened = openBoardStore(target, opts)
  try {
    const board = new BoardService(opened.store, opts.boardOptions)
    return Object.freeze({ ...opened, board })
  } catch (e) {
    opened.close()
    throw e
  }
}

// ---------------------------------------------------------------------------------------------------------------
// doctor

export interface LayoutReport {
  readonly paths: BoardPaths
  readonly manifest: Manifest | 'absent' | 'malformed'
  /** Leftover manifest tmp files (a crash between the tmp write and its unlink). */
  readonly strays: readonly string[]
  readonly location: LocationVerdict
}

/** For `doctor` (HOST-5): read-only, opens no store, creates nothing. A manifest of a newer version is 'malformed'
 *  here (this build cannot read it). */
export function layoutReport(
  db: string,
  ctx: { platform: NodeJS.Platform; home: string; env: Env; uid: number | null; probe?: LocationProbe },
): LayoutReport {
  const facts = probeLocation(boardPaths(db), ctx, ctx.probe ?? nodeLocationProbe)
  const location = checkLocation(facts, { allowUnsafeFs: false })
  const paths = boardPaths(facts.canonical)
  const read = readManifest(paths.manifest)
  const manifest = read.kind === 'ok' ? read.manifest : read.kind === 'absent' ? 'absent' : 'malformed'
  const prefix = `${pathOf(paths.manifest).basename(paths.manifest)}.`
  let strays: string[] = []
  try {
    strays = fs
      .readdirSync(paths.dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.tmp'))
      .sort()
      .map((n) => pathOf(paths.dir).join(paths.dir, n))
  } catch (e) {
    if (codeOf(e) !== 'ENOENT' && codeOf(e) !== 'ENOTDIR') throw e
  }
  return Object.freeze({ paths, manifest, strays: Object.freeze(strays), location })
}
