// HOST123_DESIGN stage B2 (section 4.3): the board directory layout, the manifest, the filesystem guard, the
// read-only content check of a file without a manifest, the 0600 pre-create of missing sidecars and the read-only
// open of a write-refused legacy board. HS-30..HS-39, HS-42..HS-44, HS-189..HS-191. The multi-process first-open
// and crash-window tests (HS-35 under a real umask, HS-40, HS-41) are in layout-proc.test.ts.
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalCaller, type SqliteStoreOptions } from '../../src/core/public.ts'
import { isBoardError, type BoardErrorLike } from '../../src/client/errors.ts'
import { processContext, resolveBoard, type BoardTarget } from '../../src/client/resolve.ts'
import {
  boardPaths,
  checkLocation,
  layoutReport,
  openBoard,
  openBoardStore,
  probeLocation,
  type LocationEntry,
  type LocationFacts,
  type LocationProbe,
  type OpenedStore,
} from '../../src/host/layout.ts'
import { makeLegacyFile } from '../core/host0/legacy.ts'

// Every store and service layout.ts builds goes through these recording subclasses (they change no behaviour).
const rec = vi.hoisted(() => ({
  storeOptions: [] as Record<string, unknown>[],
  services: 0,
  beforeStore: null as null | ((o: { path: string }) => void),
}))
vi.mock('../../src/core/public.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/core/public.ts')>()
  class RecordingStore extends orig.SqliteUnifiedStore {
    constructor(o: SqliteStoreOptions) {
      rec.storeOptions.push({ ...o })
      rec.beforeStore?.(o)
      super(o)
    }
  }
  class RecordingService extends orig.BoardService {
    constructor(...args: ConstructorParameters<typeof orig.BoardService>) {
      rec.services += 1
      super(...args)
    }
  }
  return { ...orig, SqliteUnifiedStore: RecordingStore, BoardService: RecordingService }
})
// Imported after the mock is declared (vi.mock is hoisted): these are the recording classes.
const { SqliteUnifiedStore } = await import('../../src/core/public.ts')

const UID = process.getuid!()
const alice = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const roots: string[] = []
const opened: OpenedStore[] = []

/** A fresh real (canonical) temp dir, 0700. */
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cb-layout-')))
  roots.push(d)
  return d
}
const fileTarget = (db: string, defaultDir = false): Extract<BoardTarget, { kind: 'file' }> => ({ kind: 'file', db, dir: dirname(db), defaultDir })
const track = <T extends OpenedStore>(o: T): T => {
  opened.push(o)
  return o
}
const modeOf = (p: string): number => fs.statSync(p).mode & 0o777
const sha = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const listing = (d: string): string[] => fs.readdirSync(d).sort()

function thrown(fn: () => unknown): BoardErrorLike {
  try {
    fn()
  } catch (e) {
    if (!isBoardError(e)) throw e
    return e
  }
  throw new Error('expected a BoardError, nothing was thrown')
}
const notesOf = (steps: readonly { note: string }[], name: string): string[] =>
  steps.filter((s) => s.note.startsWith(`${name}:`)).map((s) => s.note)

beforeEach(() => {
  rec.storeOptions.length = 0
  rec.services = 0
  rec.beforeStore = null
})
afterEach(() => {
  for (const o of opened.splice(0)) o.close()
  vi.restoreAllMocks()
})
afterAll(() => {
  for (const r of roots) {
    try {
      fs.chmodSync(r, 0o700)
      fs.rmSync(r, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Pure: paths and the guard table

describe('boardPaths (HS-30)', () => {
  it('HS-30 every path of a board derives from the db path by one suffix rule', () => {
    expect(boardPaths('/a/b/board.db')).toEqual({
      db: '/a/b/board.db',
      dir: '/a/b',
      wal: '/a/b/board.db-wal',
      shm: '/a/b/board.db-shm',
      wakeup: '/a/b/board.db.wakeup',
      wakeupLock: '/a/b/board.db.wakeup.lock',
      jsonl: '/a/b/board.db.jsonl',
      manifest: '/a/b/board.db.manifest.json',
      agents: '/a/b/agents',
    })
    expect(boardPaths('/a/b/x.db')).toEqual({
      db: '/a/b/x.db',
      dir: '/a/b',
      wal: '/a/b/x.db-wal',
      shm: '/a/b/x.db-shm',
      wakeup: '/a/b/x.db.wakeup',
      wakeupLock: '/a/b/x.db.wakeup.lock',
      jsonl: '/a/b/x.db.jsonl',
      manifest: '/a/b/x.db.manifest.json',
      agents: '/a/b/agents',
    })
    expect(boardPaths('C:\\x\\b.db').dir).toBe('C:\\x')
  })
})

/** Synthetic facts: an existing, private, user-owned dir unless overridden. */
function facts(over: Partial<LocationFacts> & { platform: NodeJS.Platform; path: string }): LocationFacts {
  return {
    canonical: over.path,
    realDir: null,
    anchor: dirname(over.path),
    fsType: null,
    isWsl: false,
    home: '/home/u',
    env: {},
    entries: [],
    uid: 1000,
    ...over,
  }
}
const reasons = (f: LocationFacts, allowUnsafeFs = false): string[] => checkLocation(f, { allowUnsafeFs }).refusals.map((r) => r.reason)

describe('the filesystem classification (HS-31..HS-34)', () => {
  it('HS-31 linux: network types refuse network-fs, 9p is vm-share, ext4 is local, FUSE is unknown with a warn, WSL /mnt/c is a boundary', () => {
    for (const t of [0x6969, 0x517b, 0xff534d42, 0xfe534d42]) {
      const v = checkLocation(facts({ platform: 'linux', path: '/srv/b/board.db', fsType: t }), { allowUnsafeFs: false })
      expect(v.refusals.map((r) => r.reason), t.toString(16)).toEqual(['network-fs'])
      expect(v.kind).toBe('network')
      expect(v.refusals[0]!.downgradable).toBe(true)
    }
    expect(reasons(facts({ platform: 'linux', path: '/srv/b/board.db', fsType: 0x01021997 }))).toEqual(['vm-share'])
    const ext4 = checkLocation(facts({ platform: 'linux', path: '/srv/b/board.db', fsType: 0xef53 }), { allowUnsafeFs: false })
    expect(ext4).toMatchObject({ kind: 'local', refusals: [] })
    expect(ext4.warnings).toEqual([])
    const fuse = checkLocation(facts({ platform: 'linux', path: '/srv/b/board.db', fsType: 0x65735546 }), { allowUnsafeFs: false })
    expect(fuse.kind).toBe('unknown')
    expect(fuse.refusals).toEqual([])
    expect(fuse.warnings).toHaveLength(1)
    expect(fuse.warnings[0]).toMatchObject({ topic: 'location', outcome: 'warn' })
    const wsl = checkLocation(facts({ platform: 'linux', path: '/mnt/c/x/board.db', fsType: 0xef53, isWsl: true }), { allowUnsafeFs: false })
    expect(wsl.kind).toBe('wsl-boundary')
    expect(wsl.refusals.map((r) => r.reason)).toEqual(['wsl-boundary'])
  })

  it('HS-32 darwin: APFS is local anywhere; another type is removable-or-network under /Volumes and unknown elsewhere', () => {
    expect(checkLocation(facts({ platform: 'darwin', path: '/Users/u/r/board.db', home: '/Users/u', fsType: 0x1a }), { allowUnsafeFs: false })).toMatchObject({ kind: 'local', refusals: [] })
    const stick = checkLocation(facts({ platform: 'darwin', path: '/Volumes/stick/b/board.db', home: '/Users/u', fsType: 0x1c }), { allowUnsafeFs: false })
    expect(stick.kind).toBe('removable-or-network')
    expect(stick.refusals.map((r) => r.reason)).toEqual(['removable-or-network'])
    const other = checkLocation(facts({ platform: 'darwin', path: '/Users/u/r/board.db', home: '/Users/u', fsType: 0x1c }), { allowUnsafeFs: false })
    expect(other.kind).toBe('unknown')
    expect(other.refusals).toEqual([])
    expect(other.warnings).toHaveLength(1)
    expect(checkLocation(facts({ platform: 'darwin', path: '/Volumes/ssd/b/board.db', home: '/Users/u', fsType: 0x1a }), { allowUnsafeFs: false })).toMatchObject({ kind: 'local', refusals: [] })
  })

  /** A probe over an in-memory tree: `dirs` and `files` exist (user-owned, private), `links` are symlinks. */
  function fakeProbe(t: { dirs: string[]; files?: string[]; links?: string[]; fsType: number }): LocationProbe & { calls: number } {
    const p = {
      calls: 0,
      statfsType: () => {
        p.calls += 1
        return t.fsType
      },
      lstat: (q: string) => {
        p.calls += 1
        if (t.links?.includes(q)) return { kind: 'symlink' as const, mode: 0o120777, uid: 1000 }
        if (t.files?.includes(q)) return { kind: 'file' as const, mode: 0o100600, uid: 1000 }
        if (t.dirs.includes(q)) return { kind: 'dir' as const, mode: 0o40700, uid: 1000 }
        return null
      },
      realpath: (q: string) => {
        p.calls += 1
        return t.dirs.includes(q) || t.files?.includes(q) ? q : null
      },
      procVersion: () => {
        p.calls += 1
        return null
      },
    }
    return p
  }

  it('HS-33 cloud-sync roots are refused by path (any case on darwin, %OneDrive% on win32); allowUnsafeFs downgrades them but never a symlink', () => {
    const home = '/Users/u'
    const ctx = { platform: 'darwin' as const, home, env: {}, uid: 1000 }
    const cs = `${home}/Library/CloudStorage/OneDrive-X/r`
    const f1 = probeLocation(boardPaths(`${cs}/b.db`), ctx, fakeProbe({ dirs: ['/', '/Users', home, `${home}/Library`, `${home}/Library/CloudStorage`, `${home}/Library/CloudStorage/OneDrive-X`, cs], fsType: 0x1a }))
    expect(checkLocation(f1, { allowUnsafeFs: false })).toMatchObject({ kind: 'cloud-sync', refusals: [{ reason: 'cloud-sync', downgradable: true }] })
    const icloud = `${home}/Library/Mobile Documents/com~apple~CloudDocs`
    expect(reasons(facts({ platform: 'darwin', home, path: `${icloud}/b.db`, fsType: 0x1a }))).toEqual(['cloud-sync'])
    expect(reasons(facts({ platform: 'darwin', home, path: `${home}/library/cloudstorage/Dropbox/b.db`, fsType: 0x1a }))).toEqual(['cloud-sync'])
    const win = facts({ platform: 'win32', home: 'C:\\Users\\u', path: 'C:\\Users\\u\\OneDrive\\r\\b.db', env: { OneDrive: 'C:\\Users\\u\\OneDrive' } })
    expect(checkLocation(win, { allowUnsafeFs: false })).toMatchObject({ kind: 'cloud-sync' })
    expect(reasons(win)).toEqual(['cloud-sync'])
    const winEnv = facts({ platform: 'win32', home: 'C:\\Users\\u', path: 'D:\\Sync\\r\\b.db', env: { OneDrive: 'D:\\Sync' } })
    expect(reasons(winEnv)).toEqual(['cloud-sync'])

    const allowed = checkLocation(f1, { allowUnsafeFs: true })
    expect(allowed.refusals).toEqual([])
    expect(notesOf(allowed.warnings, 'cloud-sync')).toHaveLength(1)

    // a symlinked .wakeup in the same cloud dir: allowUnsafeFs still refuses the link
    const f2 = probeLocation(
      boardPaths(`${cs}/b.db`),
      ctx,
      fakeProbe({ dirs: ['/', '/Users', home, `${home}/Library`, `${home}/Library/CloudStorage`, `${home}/Library/CloudStorage/OneDrive-X`, cs], links: [`${cs}/b.db.wakeup`], fsType: 0x1a }),
    )
    const v2 = checkLocation(f2, { allowUnsafeFs: true })
    expect(v2.refusals).toEqual([{ reason: 'symlink', path: `${cs}/b.db.wakeup`, downgradable: false }])
    expect(notesOf(v2.warnings, 'cloud-sync')).toHaveLength(1)
  })

  it('HS-34 win32: \\\\wsl$ is a WSL boundary, a UNC share is network, a drive path or \\\\?\\ is unknown with a warn; permissions are skipped with one warn', () => {
    const w = (path: string): LocationFacts => facts({ platform: 'win32', path, home: 'C:\\Users\\u', uid: null })
    expect(checkLocation(w('\\\\wsl$\\Ubuntu\\home\\u\\b.db'), { allowUnsafeFs: false })).toMatchObject({ kind: 'wsl-boundary', refusals: [{ reason: 'wsl-boundary' }] })
    expect(checkLocation(w('\\\\wsl.localhost\\Ubuntu\\b.db'), { allowUnsafeFs: false }).kind).toBe('wsl-boundary')
    expect(checkLocation(w('\\\\srv\\share\\b.db'), { allowUnsafeFs: false })).toMatchObject({ kind: 'network', refusals: [{ reason: 'network-fs' }] })
    for (const p of ['\\\\?\\C:\\x\\b.db', 'C:\\x\\b.db']) {
      const v = checkLocation(w(p), { allowUnsafeFs: false })
      expect(v.kind, p).toBe('unknown')
      expect(v.refusals, p).toEqual([])
      expect(notesOf(v.warnings, 'unknown-fs'), p).toHaveLength(1)
      expect(notesOf(v.warnings, 'not-checked'), p).toHaveLength(1)
    }
    // permission facts that would refuse on POSIX are not judged on win32
    const loose: LocationEntry = { role: 'dir', path: 'C:\\x', kind: 'dir', mode: 0o40777, uid: 7 }
    expect(checkLocation({ ...w('C:\\x\\b.db'), entries: [loose] }, { allowUnsafeFs: false }).refusals).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Real filesystem: the permission rules

/** root/p (parent) / d (board dir), with the given modes. */
function tree(parentMode: number, dirMode: number): { parent: string; dir: string; db: string } {
  const parent = join(tmp(), 'p')
  fs.mkdirSync(parent)
  const dir = join(parent, 'd')
  fs.mkdirSync(dir)
  fs.chmodSync(dir, dirMode)
  fs.chmodSync(parent, parentMode)
  return { parent, dir, db: join(dir, 'board.db') }
}
const ctxNow = (uid: number | null = UID) => ({ platform: process.platform, home: tmpdir(), env: {}, uid })
const verdictAt = (db: string, uid: number | null = UID) => checkLocation(probeLocation(boardPaths(db), ctxNow(uid)), { allowUnsafeFs: false })

describe('the permission rules on a real filesystem (HS-35, HS-36)', () => {
  it('HS-35 other-writable dirs and non-sticky other-writable parents refuse; 0755 warns; 0775 under 0775 warns and opens', () => {
    const a = tree(0o700, 0o777)
    expect(verdictAt(a.db).refusals).toEqual([{ reason: 'writable-dir', path: a.dir, downgradable: false }])
    const e = thrown(() => openBoardStore(fileTarget(a.db), { allowUnsafeFs: true }))
    expect(e).toMatchObject({ status: 403, code: 'unsafe_location', details: { reasons: ['writable-dir'] } })
    expect(listing(a.dir)).toEqual([])

    const b = tree(0o700, 0o702)
    expect(verdictAt(b.db).refusals.map((r) => r.reason)).toEqual(['writable-dir'])

    const c = tree(0o777, 0o700)
    expect(verdictAt(c.db).refusals).toEqual([{ reason: 'writable-parent', path: c.parent, downgradable: false }])

    const d = tree(0o1777, 0o700)
    expect(verdictAt(d.db).refusals).toEqual([])

    const e755 = tree(0o700, 0o755)
    const v755 = verdictAt(e755.db)
    expect(v755.refusals).toEqual([])
    expect(notesOf(v755.warnings, 'readable-by-others')).toHaveLength(1)

    for (const allowUnsafeFs of [undefined, false]) {
      const g = tree(0o775, 0o775) // the umask 002 repo (F26)
      const vg = verdictAt(g.db)
      expect(vg.refusals).toEqual([])
      const group = vg.warnings.filter((w) => w.note.startsWith('writable-by-group:')).map((w) => w.value)
      expect(group.sort()).toEqual([g.dir, g.parent].sort())
      const o = track(openBoard(fileTarget(g.db), allowUnsafeFs === undefined ? {} : { allowUnsafeFs }))
      expect(o.board.boardInfo().boardId).toMatch(/^b_[0-9a-f]{32}$/)
      expect(notesOf(o.warnings, 'writable-by-group')).toHaveLength(2)
    }
  })

  it('HS-35 a dir owned by another uid is foreign-owner (uid faked)', () => {
    const f = tree(0o700, 0o700)
    expect(verdictAt(f.db, UID + 1).refusals).toEqual([{ reason: 'foreign-owner', path: f.dir, downgradable: false }])
    const e = thrown(() => openBoardStore(fileTarget(f.db), { uid: UID + 1, allowUnsafeFs: true }))
    expect(e).toMatchObject({ status: 403, code: 'unsafe_location', details: { reasons: ['foreign-owner'] } })
  })

  it('HS-35 a missing board dir is judged by its deepest existing ancestor: 0777 not sticky refuses, and nothing is created', () => {
    const anc = join(tmp(), 'open')
    fs.mkdirSync(anc)
    fs.chmodSync(anc, 0o777)
    const db = join(anc, 'x', 'y', 'board.db')
    const v = verdictAt(db)
    expect(v.refusals).toEqual([{ reason: 'writable-parent', path: anc, downgradable: false }])
    const e = thrown(() => openBoardStore(fileTarget(db)))
    expect(e).toMatchObject({ status: 403, code: 'unsafe_location', details: { reasons: ['writable-parent'] } })
    expect(e.message).toContain(anc)
    expect(listing(anc)).toEqual([])
    // the same ancestor sticky: accepted, and the two missing levels are created 0700
    fs.chmodSync(anc, 0o1777)
    const o = track(openBoardStore(fileTarget(db)))
    expect(o.writable).toBe(true)
    expect(modeOf(join(anc, 'x'))).toBe(0o700)
    expect(modeOf(join(anc, 'x', 'y'))).toBe(0o700)
  })

  it('HS-36 a symlinked board.db or .wakeup refuses (target untouched); a symlinked board dir opens at its realpath', () => {
    const root = tmp()
    const target = join(root, 'elsewhere.db')
    fs.writeFileSync(target, 'precious')
    const dir = join(root, 'b')
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.symlinkSync(target, join(dir, 'board.db'))
    const e = thrown(() => openBoard(fileTarget(join(dir, 'board.db')), { allowUnsafeFs: true }))
    expect(e).toMatchObject({ status: 403, code: 'unsafe_location', details: { reasons: ['symlink'] } })
    expect(fs.readFileSync(target, 'utf8')).toBe('precious')
    expect(rec.storeOptions).toHaveLength(0)

    const dir2 = join(root, 'c')
    fs.mkdirSync(dir2, { mode: 0o700 })
    const victim = join(root, 'victim.txt')
    fs.writeFileSync(victim, 'keep')
    fs.symlinkSync(victim, join(dir2, 'board.db.wakeup'))
    const e2 = thrown(() => openBoard(fileTarget(join(dir2, 'board.db'))))
    expect(e2).toMatchObject({ status: 403, code: 'unsafe_location', details: { reasons: ['symlink'] } })
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep')
    expect(listing(dir2)).toEqual(['board.db.wakeup'])

    const real = join(root, 'real')
    fs.mkdirSync(real, { mode: 0o700 })
    const link = join(root, 'link')
    fs.symlinkSync(real, link)
    const o = track(openBoard(fileTarget(join(link, 'board.db'))))
    expect(o.paths!.db).toBe(join(real, 'board.db'))
    expect(o.store.path).toBe(join(real, 'board.db'))
    expect(rec.storeOptions.at(-1)!.path).toBe(join(real, 'board.db'))
    expect(fs.existsSync(join(real, 'board.db.manifest.json'))).toBe(true)
  })

  it('HS-35 (B2-V3) a board dir or ancestor that is a regular file (or non-dir symlink) throws ClientError 400 invalid_db_path, never raw ENOTDIR', () => {
    const root = tmp()
    const notadir = join(root, 'notadir')
    fs.writeFileSync(notadir, 'precious file\n', { mode: 0o600 })
    const hash = sha(notadir)

    // Board dir itself is a regular file
    const dbDirect = join(notadir, 'board.db')
    const e1 = thrown(() => openBoardStore(fileTarget(dbDirect)))
    expect(e1).toMatchObject({ status: 400, code: 'invalid_db_path', origin: 'handle', details: { reason: 'not_a_directory', path: notadir, db: dbDirect } })
    expect(thrown(() => openBoard(fileTarget(dbDirect)))).toMatchObject({ status: 400, code: 'invalid_db_path', origin: 'handle' })

    // Ancestor of board dir is a regular file
    const dbNested = join(notadir, 'x', 'y', 'board.db')
    const e2 = thrown(() => openBoardStore(fileTarget(dbNested)))
    expect(e2).toMatchObject({ status: 400, code: 'invalid_db_path', origin: 'handle', details: { reason: 'not_a_directory', path: notadir, db: dbNested } })

    // Symlink to regular file as board dir, and dangling symlink as board dir
    const linkToFile = join(root, 'link-to-file')
    fs.symlinkSync(notadir, linkToFile)
    expect(thrown(() => openBoardStore(fileTarget(join(linkToFile, 'board.db'))))).toMatchObject({
      status: 400,
      code: 'invalid_db_path',
      origin: 'handle',
      details: { reason: 'not_a_directory', path: notadir },
    })
    const dangling = join(root, 'dangling-dir')
    fs.symlinkSync(join(root, 'missing-target'), dangling)
    expect(thrown(() => openBoardStore(fileTarget(join(dangling, 'board.db'))))).toMatchObject({
      status: 400,
      code: 'invalid_db_path',
      origin: 'handle',
      details: { reason: 'not_a_directory', path: dangling },
    })

    // layoutReport also handles regular-file dir/ancestor without throwing raw ENOTDIR
    expect(layoutReport(dbDirect, ctxNow()).manifest).toBe('absent')
    expect(layoutReport(dbNested, ctxNow()).manifest).toBe('absent')

    expect(sha(notadir)).toBe(hash)
    expect(rec.storeOptions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Real filesystem: creation, manifest, reopen

describe('creation and the manifest (HS-37..HS-39)', () => {
  it('HS-37 a fresh default-dir open in a git repo: 0700 dir, 0600 files, the exact manifest and .gitignore', () => {
    const repo = tmp()
    fs.mkdirSync(join(repo, '.git'))
    const home = tmp()
    const res = resolveBoard({}, processContext({ cwd: repo, env: {}, home }))
    expect(res.target).toMatchObject({ kind: 'file', db: join(repo, '.swarmboard', 'board.db'), defaultDir: true })
    const o = track(openBoard(res.target as Extract<BoardTarget, { kind: 'file' }>, { clock: () => new Date('2026-11-24T10:00:00.000Z') }))
    const dir = join(repo, '.swarmboard')
    expect(o.created).toBe(true)
    expect(o.writable).toBe(true)
    expect(modeOf(dir)).toBe(0o700)
    const db = join(dir, 'board.db')
    for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}.wakeup`, `${db}.jsonl`, `${db}.manifest.json`]) expect(modeOf(f), f).toBe(0o600)
    const manifest = JSON.parse(fs.readFileSync(`${db}.manifest.json`, 'utf8')) as unknown
    expect(manifest).toStrictEqual({
      version: 1,
      boardId: o.board.boardInfo().boardId,
      db: 'board.db',
      sidecars: { wakeup: 'board.db.wakeup', jsonl: 'board.db.jsonl' },
      createdBy: 'swarmboard 0.2.0',
      createdAt: '2026-11-24T10:00:00.000Z',
    })
    expect(o.manifest).toStrictEqual(manifest)
    expect(fs.readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n!config.json\n')
    expect(fs.existsSync(join(repo, '.gitignore'))).toBe(false)

    // an explicit dir (SWARMBOARD_DB) writes no .gitignore
    const xdir = join(tmp(), 'x')
    const res2 = resolveBoard({}, processContext({ cwd: repo, env: { SWARMBOARD_DB: join(xdir, 'board.db') }, home }))
    expect(res2.target).toMatchObject({ kind: 'file', defaultDir: false })
    const o2 = track(openBoard(res2.target as Extract<BoardTarget, { kind: 'file' }>))
    expect(o2.created).toBe(true)
    expect(fs.existsSync(join(xdir, '.gitignore'))).toBe(false)
    expect(modeOf(xdir)).toBe(0o700)
  })

  it('HS-38 a reopen verifies the manifest without writing it; a mismatch, a newer version, bad JSON or other sidecars refuse', () => {
    const dir = join(tmp(), 'b')
    const db = join(dir, 'board.db')
    const man = `${db}.manifest.json`
    const first = openBoard(fileTarget(db))
    const boardId = first.board.boardInfo().boardId!
    first.close()
    const before = { bytes: fs.readFileSync(man, 'utf8'), mtimeMs: fs.statSync(man).mtimeMs }
    const again = track(openBoard(fileTarget(db)))
    expect(again.created).toBe(false)
    expect(again.manifest!.boardId).toBe(boardId)
    expect(fs.readFileSync(man, 'utf8')).toBe(before.bytes)
    expect(fs.statSync(man).mtimeMs).toBe(before.mtimeMs)
    again.close()

    const good = JSON.parse(before.bytes) as Record<string, unknown>
    const write = (v: unknown): void => fs.writeFileSync(man, typeof v === 'string' ? v : JSON.stringify(v))
    const close = vi.spyOn(SqliteUnifiedStore.prototype, 'close')

    write({ ...good, boardId: `b_${'0'.repeat(32)}` })
    const e1 = thrown(() => openBoard(fileTarget(db)))
    expect(e1).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'board' } })
    expect(close).toHaveBeenCalledTimes(1)

    write({ ...good, version: 2 })
    expect(thrown(() => openBoard(fileTarget(db)))).toMatchObject({ status: 503, code: 'schema_too_new', details: { what: 'manifest' } })
    write('{')
    expect(thrown(() => openBoard(fileTarget(db)))).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'malformed' } })
    write({ ...good, sidecars: { wakeup: 'board.db.wakeup', jsonl: 'other.jsonl' } })
    expect(thrown(() => openBoard(fileTarget(db)))).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'sidecars' } })
    expect(close).toHaveBeenCalledTimes(4)
    expect(rec.services).toBe(2) // only the two successful opens built a service
  })

  it('HS-39 a manifest without its db is 404 no_board and the call creates and touches nothing', () => {
    const dir = join(tmp(), 'm')
    fs.mkdirSync(dir, { mode: 0o700 })
    const db = join(dir, 'board.db')
    fs.writeFileSync(`${db}.manifest.json`, JSON.stringify({
      version: 1,
      boardId: `b_${'a'.repeat(32)}`,
      db: 'board.db',
      sidecars: { wakeup: 'board.db.wakeup', jsonl: 'board.db.jsonl' },
      createdBy: 'swarmboard 0.2.0',
      createdAt: '2026-11-24T00:00:00.000Z',
    }))
    const e = thrown(() => openBoard(fileTarget(db)))
    expect(e).toMatchObject({ status: 404, code: 'no_board' })
    expect(e.message).toContain(db)
    expect(listing(dir)).toEqual(['board.db.manifest.json'])
    expect(rec.storeOptions).toHaveLength(0)

    // a board opened once, closed, then its db deleted: nothing is created or touched
    const dir2 = join(tmp(), 'n')
    const db2 = join(dir2, 'board.db')
    openBoard(fileTarget(db2)).close()
    fs.unlinkSync(db2)
    const before = listing(dir2).map((n) => [n, fs.statSync(join(dir2, n)).mtimeMs] as const)
    expect(thrown(() => openBoard(fileTarget(db2)))).toMatchObject({ status: 404, code: 'no_board' })
    expect(listing(dir2).map((n) => [n, fs.statSync(join(dir2, n)).mtimeMs] as const)).toEqual(before)
  })

  it('HS-40 (B2-V4) write-once manifest: a concurrent winner survives (inode, createdAt, bytes) and a mismatching winner refuses 409 without overwriting', () => {
    // (1) Same-board concurrent open wins between A's tmp write and A's linkSync
    const dir = join(tmp(), 'wo1')
    const db = join(dir, 'board.db')
    const man = `${db}.manifest.json`
    let winnerIno = 0n
    let winnerBytes = ''
    const winnerTime = '2026-11-24T11:00:00.000Z'
    const loserTime = '2026-11-24T12:00:00.000Z'

    const openerA = track(
      openBoardStore(fileTarget(db), {
        clock: () => new Date(loserTime),
        testHooks: {
          afterTmpWrite() {
            const openerB = openBoardStore(fileTarget(db), { clock: () => new Date(winnerTime) })
            openerB.close()
            winnerIno = fs.statSync(man, { bigint: true }).ino
            winnerBytes = fs.readFileSync(man, 'utf8')
          },
        },
      }),
    )
    expect(openerA.manifest!.createdAt).toBe(winnerTime)
    expect(fs.statSync(man, { bigint: true }).ino).toBe(winnerIno)
    expect(fs.readFileSync(man, 'utf8')).toBe(winnerBytes)
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    openerA.close()

    // (2) A mismatching manifest appears before A links: linkSync gets EEXIST -> verifyManifest refuses 409 without overwriting
    const dir2 = join(tmp(), 'wo2')
    const db2 = join(dir2, 'board.db')
    const man2 = `${db2}.manifest.json`
    const foreignMan = `${JSON.stringify({
      version: 1,
      boardId: `b_${'f'.repeat(32)}`,
      db: 'board.db',
      sidecars: { wakeup: 'board.db.wakeup', jsonl: 'board.db.jsonl' },
      createdBy: 'swarmboard 0.2.0',
      createdAt: winnerTime,
    }, null, 2)}\n`
    let placedIno = 0n
    const closeSpy = vi.spyOn(SqliteUnifiedStore.prototype, 'close')
    const e = thrown(() =>
      openBoardStore(fileTarget(db2), {
        clock: () => new Date(loserTime),
        testHooks: {
          afterTmpWrite() {
            fs.writeFileSync(man2, foreignMan, { mode: 0o600 })
            placedIno = fs.statSync(man2, { bigint: true }).ino
          },
        },
      }),
    )
    expect(e).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'board' } })
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(fs.statSync(man2, { bigint: true }).ino).toBe(placedIno)
    expect(fs.readFileSync(man2, 'utf8')).toBe(foreignMan)
    expect(fs.readdirSync(dir2).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('the store options, memory boards, layoutReport and the split (HS-42..HS-44)', () => {
  it('HS-42 the store is never given a sidecar path: its sidecars are the layout paths', () => {
    const root = tmp()
    const db = join(root, 'b', 'board.db')
    const o = track(openBoard(fileTarget(db), {
      // a caller smuggling a sidecar override past the type: it must not reach the store
      storeOptions: { busyTimeoutMs: 250, jsonlPath: join(root, 'evil.jsonl'), wakeupPath: join(root, 'evil.wakeup') } as never,
    }))
    expect(rec.storeOptions).toHaveLength(1)
    const seen = rec.storeOptions[0]!
    expect(Object.keys(seen)).not.toContain('jsonlPath')
    expect(Object.keys(seen)).not.toContain('wakeupPath')
    expect(seen.path).toBe(o.paths!.db)
    expect(seen.busyTimeoutMs).toBe(250)
    expect(o.store.jsonlPath).toBe(o.paths!.jsonl)
    expect(o.store.wakeupPath).toBe(o.paths!.wakeup)
    expect(fs.existsSync(join(root, 'evil.jsonl'))).toBe(false)
  })

  it('HS-43 a memory board has no paths, no manifest and probes nothing; layoutReport reads a dir without opening a store', () => {
    const probe: LocationProbe & { calls: number } = {
      calls: 0,
      statfsType() { this.calls += 1; return null },
      lstat() { this.calls += 1; return null },
      realpath() { this.calls += 1; return null },
      procVersion() { this.calls += 1; return null },
    }
    const o = track(openBoard({ kind: 'memory', db: ':memory:' }, { probe }))
    expect(o.paths).toBeNull()
    expect(o.manifest).toBeNull()
    expect(probe.calls).toBe(0)
    expect(o.board.boardInfo().boardId).toMatch(/^b_/)

    rec.storeOptions.length = 0
    const dir = join(tmp(), 'r')
    fs.mkdirSync(dir, { mode: 0o700 })
    const db = join(dir, 'board.db')
    const stray = `${db}.manifest.json.123.abcdef01.tmp`
    fs.writeFileSync(stray, '{}')
    const report = layoutReport(db, ctxNow())
    expect(report.manifest).toBe('absent')
    expect(report.strays).toEqual([stray])
    expect(report.paths.db).toBe(db)
    expect(report.location.refusals).toEqual([])
    expect(rec.storeOptions).toHaveLength(0)
    expect(listing(dir)).toEqual([`board.db.manifest.json.123.abcdef01.tmp`])
  })

  it('HS-44 openBoardStore opens a verified store and builds no service; a throw after the store opened closes it', () => {
    const db = join(tmp(), 's', 'board.db')
    const s = openBoardStore(fileTarget(db))
    expect(rec.services).toBe(0)
    expect(s.manifest!.boardId).toBe(s.store.identity()!.boardId)
    expect(s.created).toBe(true)
    expect((s.store.db.prepare('SELECT count(*) AS n FROM board_grants').get() as { n: number }).n).toBe(0)
    s.close()
    s.close() // idempotent
    const b = track(openBoard(fileTarget(db)))
    expect(rec.services).toBe(1)
    expect((b.store.db.prepare('SELECT count(*) AS n FROM board_grants').get() as { n: number }).n).toBeGreaterThan(0)
    b.close()

    const close = vi.spyOn(SqliteUnifiedStore.prototype, 'close')
    const db2 = join(tmp(), 't', 'board.db')
    const boom = new Error('boom')
    expect(() => openBoardStore(fileTarget(db2), { testHooks: { beforeManifest: () => { throw boom } } })).toThrow(boom)
    expect(close).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(`${db2}.manifest.json`)).toBe(false)
    // the next open writes the manifest for the identity the first one minted
    const again = track(openBoardStore(fileTarget(db2)))
    expect(again.created).toBe(false)
    expect(again.manifest!.boardId).toBe(again.store.identity()!.boardId)
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('the content check of a file without a manifest (HS-189)', () => {
  const fresh = (): { dir: string; db: string } => {
    const dir = join(tmp(), 'f')
    fs.mkdirSync(dir, { mode: 0o700 })
    return { dir, db: join(dir, 'board.db') }
  }
  const journalMode = (db: string): string => {
    const r = new DatabaseSync(db, { readOnly: true })
    try {
      return String((r.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode)
    } finally {
      r.close()
    }
  }

  it('HS-189 (a) a foreign SQLite db (journal delete) is refused 409 foreign before any store, byte for byte unchanged', () => {
    const { dir, db } = fresh()
    const w = new DatabaseSync(db)
    w.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('mine')")
    w.close()
    const hash = sha(db)
    expect(journalMode(db)).toBe('delete')
    const e = thrown(() => openBoardStore(fileTarget(db)))
    expect(e).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'foreign', path: db } })
    expect(e.message).toContain(db)
    expect(rec.storeOptions).toHaveLength(0)
    expect(sha(db)).toBe(hash)
    expect(journalMode(db)).toBe('delete')
    expect(listing(dir)).toEqual(['board.db'])
    // openBoard says the same
    expect(thrown(() => openBoard(fileTarget(db)))).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'foreign' } })
  })

  it('HS-189 (b) a closed foreign WAL db is refused the same way and the immutable read creates no -wal/-shm', () => {
    const { dir, db } = fresh()
    const w = new DatabaseSync(db)
    w.exec("PRAGMA journal_mode = WAL; CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('mine')")
    w.close()
    const before = listing(dir)
    expect(before).toEqual(['board.db'])
    const hash = sha(db)
    expect(thrown(() => openBoardStore(fileTarget(db)))).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'foreign' } })
    expect(listing(dir)).toEqual(before)
    expect(sha(db)).toBe(hash)
    expect(rec.storeOptions).toHaveLength(0)
  })

  it('HS-189 (c) a text file is 409 not_sqlite, never 500, and unchanged; so is a corrupt SQLite header', () => {
    const { dir, db } = fresh()
    fs.writeFileSync(db, 'hello, I am a text file\n')
    const hash = sha(db)
    expect(thrown(() => openBoardStore(fileTarget(db)))).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'not_sqlite', path: db } })
    expect(sha(db)).toBe(hash)
    expect(listing(dir)).toEqual(['board.db'])
    fs.writeFileSync(db, Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(200, 7)]))
    expect(thrown(() => openBoardStore(fileTarget(db)))).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'not_sqlite' } })
    expect(listing(dir)).toEqual(['board.db'])
    expect(rec.storeOptions).toHaveLength(0)
  })

  it('HS-189 (d) a 0-byte board.db (the pre-create crash window) opens and gets its manifest', () => {
    const { db } = fresh()
    fs.writeFileSync(db, '', { mode: 0o600 })
    const o = track(openBoardStore(fileTarget(db)))
    expect(o.created).toBe(false)
    expect(o.manifest!.boardId).toBe(o.store.identity()!.boardId)
    expect(fs.existsSync(`${db}.manifest.json`)).toBe(true)
  })

  it('HS-189 (e) a legacy board file (board_meta, no manifest) is adopted and gets its manifest', () => {
    const { db } = fresh()
    makeLegacyFile(db, 'sliceA', 3)
    const o = track(openBoard(fileTarget(db)))
    expect(o.writable).toBe(true)
    expect(o.manifest!.boardId).toBe(o.board.boardInfo().boardId)
    expect(JSON.parse(fs.readFileSync(`${db}.manifest.json`, 'utf8'))).toMatchObject({ boardId: o.manifest!.boardId })
  })

  it('HS-189 (f) a SQLite file with zero tables is adopted', () => {
    const { db } = fresh()
    const w = new DatabaseSync(db)
    w.exec('CREATE TABLE t (x); DROP TABLE t')
    w.close()
    expect(fs.statSync(db).size).toBeGreaterThan(0)
    const o = track(openBoardStore(fileTarget(db)))
    expect(o.manifest!.boardId).toBe(o.store.identity()!.boardId)
  })

  it('HS-189 (B2-V1) a foreign SQLite db or non-SQLite file next to an existing manifest is refused 409 before opening, byte-identical', () => {
    const tableNames = (p: string): string[] => {
      const r = new DatabaseSync(p, { readOnly: true })
      try {
        return (r.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
          .map((row) => row.name)
          .sort()
      } finally {
        r.close()
      }
    }
    const validManifest = JSON.stringify({
      version: 1,
      boardId: `b_${'a'.repeat(32)}`,
      db: 'board.db',
      sidecars: { wakeup: 'board.db.wakeup', jsonl: 'board.db.jsonl' },
      createdBy: 'swarmboard 0.2.0',
      createdAt: '2026-11-24T00:00:00.000Z',
    })

    // (1) Foreign delete-mode SQLite db next to a valid manifest, a malformed manifest, and a newer manifest
    for (const [label, manifestText] of [
      ['valid manifest', validManifest],
      ['malformed manifest', '{'],
      ['newer manifest', JSON.stringify({ ...JSON.parse(validManifest), version: 2 })],
    ] as const) {
      rec.storeOptions.length = 0
      const { dir, db } = fresh()
      const w = new DatabaseSync(db)
      w.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('mine')")
      w.close()
      fs.writeFileSync(`${db}.manifest.json`, manifestText, { mode: 0o600 })
      const hash = sha(db)
      const beforeListing = listing(dir)
      expect(journalMode(db), label).toBe('delete')

      const e = thrown(() => openBoardStore(fileTarget(db)))
      expect(e, label).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'foreign', path: db } })
      expect(rec.storeOptions, label).toHaveLength(0)
      expect(sha(db), label).toBe(hash)
      expect(journalMode(db), label).toBe('delete')
      expect(tableNames(db), label).toEqual(['notes'])
      expect(listing(dir), label).toEqual(beforeListing)
    }

    // (2) Closed foreign WAL db next to a valid manifest: immutable read creates no -wal/-shm
    rec.storeOptions.length = 0
    const walCase = fresh()
    const ww = new DatabaseSync(walCase.db)
    ww.exec("PRAGMA journal_mode = WAL; CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('wal')")
    ww.close()
    fs.writeFileSync(`${walCase.db}.manifest.json`, validManifest, { mode: 0o600 })
    const walHash = sha(walCase.db)
    const walBefore = listing(walCase.dir)
    expect(walBefore).toEqual(['board.db', 'board.db.manifest.json'])
    expect(thrown(() => openBoardStore(fileTarget(walCase.db)))).toMatchObject({
      status: 409,
      code: 'manifest_mismatch',
      details: { reason: 'foreign', path: walCase.db },
    })
    expect(rec.storeOptions).toHaveLength(0)
    expect(sha(walCase.db)).toBe(walHash)
    expect(listing(walCase.dir)).toEqual(walBefore)

    // (3) Non-SQLite text file next to a valid manifest: 409 not_sqlite, byte-identical
    rec.storeOptions.length = 0
    const txtCase = fresh()
    fs.writeFileSync(txtCase.db, 'not a database\n', { mode: 0o600 })
    fs.writeFileSync(`${txtCase.db}.manifest.json`, validManifest, { mode: 0o600 })
    const txtHash = sha(txtCase.db)
    const txtBefore = listing(txtCase.dir)
    expect(thrown(() => openBoardStore(fileTarget(txtCase.db)))).toMatchObject({
      status: 409,
      code: 'manifest_mismatch',
      details: { reason: 'not_sqlite', path: txtCase.db },
    })
    expect(rec.storeOptions).toHaveLength(0)
    expect(sha(txtCase.db)).toBe(txtHash)
    expect(listing(txtCase.dir)).toEqual(txtBefore)
  })

  it('HS-189 (B2-V2) a locked db fails promptly with 503 unavailable (retryAfter: 1), never hangs ~44s or reports not_sqlite', () => {
    // (1) Real board_meta WAL db held under locking_mode=EXCLUSIVE, with manifest present and with manifest absent
    const { db } = fresh()
    const init = openBoardStore(fileTarget(db))
    const manifestBackup = fs.readFileSync(`${db}.manifest.json`, 'utf8')
    init.close()

    const locker = new DatabaseSync(db)
    try {
      locker.exec('PRAGMA locking_mode = EXCLUSIVE')
      locker.exec('BEGIN IMMEDIATE')
      locker.exec("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('_lock_test', '1')")

      // With manifest present
      const tMan = Date.now()
      const eWithMan = thrown(() => openBoardStore(fileTarget(db), { storeOptions: { busyTimeoutMs: 120 } }))
      expect(eWithMan).toMatchObject({ status: 503, code: 'unavailable', retryAfter: 1, details: { reason: 'busy', path: db } })
      expect(eWithMan.message).not.toMatch(/not a SQLite file/i)
      expect(Date.now() - tMan).toBeLessThan(1_000)

      // With manifest absent and default options (no busyTimeoutMs override)
      fs.unlinkSync(`${db}.manifest.json`)
      const t0 = Date.now()
      const e = thrown(() => openBoardStore(fileTarget(db)))
      const elapsed = Date.now() - t0
      expect(e).toMatchObject({ status: 503, code: 'unavailable', retryAfter: 1, details: { reason: 'busy', path: db } })
      expect(e.message).not.toMatch(/not a SQLite file/i)
      expect(elapsed).toBeLessThan(5_000)
      expect(rec.storeOptions).toHaveLength(1) // only the initial openBoardStore constructed a store

      // Zero busyTimeoutMs returns immediately without hanging
      const eZero = thrown(() => openBoardStore(fileTarget(db), { storeOptions: { busyTimeoutMs: 0 } }))
      expect(eZero).toMatchObject({ status: 503, code: 'unavailable', retryAfter: 1, details: { reason: 'busy', path: db } })
    } finally {
      try {
        locker.exec('ROLLBACK')
      } finally {
        locker.close()
      }
      fs.writeFileSync(`${db}.manifest.json`, manifestBackup, { mode: 0o600 })
    }

    // (2) Foreign delete-mode db held under BEGIN EXCLUSIVE is also classified as 503 busy (not bypassed by immutable=1)
    rec.storeOptions.length = 0
    const foreignCase = fresh()
    const fw = new DatabaseSync(foreignCase.db)
    try {
      fw.exec("PRAGMA journal_mode = DELETE; CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('x')")
      fw.exec("BEGIN EXCLUSIVE; INSERT INTO notes VALUES ('y')")
      const t2 = Date.now()
      const eDel = thrown(() => openBoardStore(fileTarget(foreignCase.db), { storeOptions: { busyTimeoutMs: 120 } }))
      expect(eDel).toMatchObject({ status: 503, code: 'unavailable', retryAfter: 1, details: { reason: 'busy', path: foreignCase.db } })
      expect(Date.now() - t2).toBeLessThan(1_000)
      expect(rec.storeOptions).toHaveLength(0)
    } finally {
      try {
        fw.exec('ROLLBACK')
      } finally {
        fw.close()
      }
    }
  })
})

describe('sidecars recreated 0600 (HS-190)', () => {
  it('HS-190 deleted .jsonl and .wakeup come back 0600 before the store opens; a 0644 .jsonl is kept and named', () => {
    const dir = join(tmp(), 'sc')
    const db = join(dir, 'board.db')
    openBoard(fileTarget(db)).close()
    fs.unlinkSync(`${db}.jsonl`)
    fs.unlinkSync(`${db}.wakeup`)
    const seen: Array<[boolean, boolean]> = []
    rec.beforeStore = () => {
      seen.push([fs.existsSync(`${db}.jsonl`), fs.existsSync(`${db}.wakeup`)])
    }
    const o = track(openBoard(fileTarget(db)))
    expect(seen).toEqual([[true, true]])
    expect(modeOf(`${db}.jsonl`)).toBe(0o600)
    expect(modeOf(`${db}.wakeup`)).toBe(0o600)
    o.board.postMessage(alice, { channel: 'dev', text: 'after the delete' })
    expect(fs.readFileSync(`${db}.jsonl`, 'utf8')).toContain('after the delete')
    expect(modeOf(`${db}.jsonl`)).toBe(0o600)
    expect(modeOf(`${db}.wakeup`)).toBe(0o600)
    o.close()

    fs.chmodSync(`${db}.jsonl`, 0o644)
    const again = track(openBoardStore(fileTarget(db)))
    expect(modeOf(`${db}.jsonl`)).toBe(0o644)
    const named = again.warnings.filter((w) => w.note.startsWith('readable-by-others:')).map((w) => w.value)
    expect(named).toEqual([`${db}.jsonl`])
    again.close()
    const report = layoutReport(db, ctxNow())
    expect(report.location.warnings.filter((w) => w.note.startsWith('readable-by-others:')).map((w) => w.value)).toEqual([`${db}.jsonl`])
  })
})

describe('a write-refused board without an identity opens read-only (HS-191)', () => {
  const legacyNewer = (): { dir: string; db: string } => {
    const dir = join(tmp(), 'lg')
    fs.mkdirSync(dir, { mode: 0o700 })
    const db = join(dir, 'board.db')
    makeLegacyFile(db, 'sliceA', 2)
    const w = new DatabaseSync(db)
    w.exec("UPDATE board_meta SET value = '99' WHERE key = 'tasks_schema'")
    w.close()
    return { dir, db }
  }

  it('HS-191 no manifest: writable false, manifest null, none written, one manifest-unverified warn naming the refusal', () => {
    const { db } = legacyNewer()
    const o = track(openBoardStore(fileTarget(db)))
    expect(o.writable).toBe(false)
    expect(o.manifest).toBeNull()
    expect(fs.existsSync(`${db}.manifest.json`)).toBe(false)
    expect(o.store.identity()).toBeNull()
    const unverified = notesOf(o.warnings, 'manifest-unverified')
    expect(unverified).toHaveLength(1)
    expect(unverified[0]).toContain('written by a newer Swarmboard (tasks_schema 99)')
    o.close()

    const b = track(openBoard(fileTarget(db)))
    expect(b.board.boardInfo()).toMatchObject({ boardId: null, instanceId: null, schema: { refused: 'writes' } })
    expect(() => b.board.postMessage(alice, { channel: 'dev', text: 'x' })).toThrow(/newer Swarmboard/)
  })

  it('HS-191 a valid hand-written manifest is parsed and left as is; a malformed one is 409', () => {
    const { db } = legacyNewer()
    const man = `${db}.manifest.json`
    const text = `${JSON.stringify({
      version: 1,
      boardId: `b_${'c'.repeat(32)}`,
      db: 'board.db',
      sidecars: { wakeup: 'board.db.wakeup', jsonl: 'board.db.jsonl' },
      createdBy: 'swarmboard 9.9.9',
      createdAt: '2027-01-01T00:00:00.000Z',
    })}\n`
    fs.writeFileSync(man, text)
    const o = track(openBoardStore(fileTarget(db)))
    expect(o.writable).toBe(false)
    expect(o.manifest).toMatchObject({ boardId: `b_${'c'.repeat(32)}`, createdBy: 'swarmboard 9.9.9' })
    expect(fs.readFileSync(man, 'utf8')).toBe(text)
    expect(notesOf(o.warnings, 'manifest-unverified')).toHaveLength(1)
    o.close()

    fs.writeFileSync(man, '{"version":1,')
    expect(thrown(() => openBoardStore(fileTarget(db)))).toMatchObject({ status: 409, code: 'manifest_mismatch', details: { reason: 'malformed' } })
  })
})
