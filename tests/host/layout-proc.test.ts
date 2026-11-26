// HOST123_DESIGN stage B2, separate OS processes on one board directory: the concurrent first open (HS-40), the two
// crash windows of the manifest write (HS-41), and the modes under a real process umask (HS-35's umask 002 repo,
// HS-190's umask 022 recreate). Multi-process tests are sleep-sensitive (H0 errata): re-run this file alone before
// debugging a timeout.
import { fork } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { layoutReport, openBoardStore } from '../../src/host/layout.ts'

const CHILD = fileURLToPath(new URL('./layout-child.ts', import.meta.url))
const roots: string[] = []

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cb-layout-proc-')))
  roots.push(d)
  return d
}
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

type ChildOut = {
  boardId: string
  created: boolean
  db: string
  manifestCreatedAt: string | null
  manifestIno: string
  modes: Record<string, number>
  warnings: { note: string; value: string | null }[]
}

/** Forks layout-child.ts; resolves with its exit code and its parsed stdout line (null when it printed none). */
function run(args: Record<string, unknown>): Promise<{ code: number | null; out: ChildOut | null; stderr: string }> {
  const proc = fork(CHILD, [JSON.stringify(args)], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stdout = ''
  let stderr = ''
  proc.stdout!.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
  proc.stderr!.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
  return new Promise((resolve) => {
    proc.once('exit', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).at(-1)
      resolve({ code, out: line ? (JSON.parse(line) as ChildOut) : null, stderr })
    })
  })
}
const ctx = () => ({ platform: process.platform, home: tmpdir(), env: {}, uid: process.getuid!() })
const ctxBoardId = (db: string): string | null => {
  const r = new DatabaseSync(db, { readOnly: true })
  try {
    const row = r.prepare("SELECT value FROM board_meta WHERE key = 'core.board_id'").get() as { value: string } | undefined
    return row?.value ?? null
  } finally {
    r.close()
  }
}

describe('concurrent first opens and crash windows (HS-40, HS-41)', () => {
  it('HS-40 eight processes open one fresh dir at once: one board, one manifest, no tmp left, integrity ok', { timeout: 60_000 }, async () => {
    const root = tmp()
    const dir = join(root, 'shared')
    const db = join(dir, 'board.db')
    const barrier = join(root, 'go')
    const runs = Array.from({ length: 8 }, (_, i) => run({ db, barrier, clock: `2026-11-24T10:00:0${i}.000Z` }))
    await new Promise((r) => setTimeout(r, 300)) // let every child reach the barrier
    fs.writeFileSync(barrier, '')
    const results = await Promise.all(runs)
    for (const r of results) expect(r.code, r.stderr).toBe(0)
    const ids = new Set(results.map((r) => r.out!.boardId))
    expect(ids.size).toBe(1)
    expect([...ids][0]).toMatch(/^b_[0-9a-f]{32}$/)
    expect(results.filter((r) => r.out!.created)).toHaveLength(1)
    const names = fs.readdirSync(dir)
    expect(names.filter((n) => n.endsWith('.manifest.json'))).toEqual(['board.db.manifest.json'])
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([])
    const manifest = JSON.parse(fs.readFileSync(`${db}.manifest.json`, 'utf8')) as { boardId: string; createdAt: string }
    const finalIno = fs.statSync(`${db}.manifest.json`, { bigint: true }).ino.toString()
    expect(manifest.boardId).toBe([...ids][0])
    expect(new Set(results.map((r) => r.out!.manifestCreatedAt))).toEqual(new Set([manifest.createdAt]))
    expect(new Set(results.map((r) => r.out!.manifestIno))).toEqual(new Set([finalIno]))
    const check = new DatabaseSync(db)
    try {
      expect(check.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally {
      check.close()
    }
  })

  it('HS-40 (B2-V4) write-once manifest across processes: a slower process pausing after tmp write never overwrites the winner', { timeout: 60_000 }, async () => {
    const root = tmp()
    const dir = join(root, 'race')
    const db = join(dir, 'board.db')
    const man = `${db}.manifest.json`
    const ready = join(root, 'p1-ready')
    const go = join(root, 'p1-go')
    const loserTime = '2026-11-24T12:00:00.000Z'
    const winnerTime = '2026-11-24T11:00:00.000Z'

    // Child 1 opens the fresh board, writes its tmp manifest (12:00:00), and pauses before linkSync.
    const p1 = run({ db, clock: loserTime, afterTmpWritePause: { ready, go } })
    const deadline = Date.now() + 30_000
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) throw new Error('child 1 never reached afterTmpWrite')
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(fs.existsSync(man)).toBe(false)

    // Child 2 wins the manifest race with 11:00:00.
    const r2 = await run({ db, clock: winnerTime })
    expect(r2.code, r2.stderr).toBe(0)
    const winnerIno = fs.statSync(man, { bigint: true }).ino.toString()
    const winnerBytes = fs.readFileSync(man, 'utf8')
    expect(r2.out!.manifestCreatedAt).toBe(winnerTime)

    // Release child 1 to execute linkSync -> EEXIST -> verifyManifest (must NOT replace inode/bytes/createdAt).
    fs.writeFileSync(go, '')
    const r1 = await p1
    expect(r1.code, r1.stderr).toBe(0)
    expect(r1.out!.boardId).toBe(r2.out!.boardId)
    expect(r1.out!.manifestCreatedAt).toBe(winnerTime)
    expect(r1.out!.manifestIno).toBe(winnerIno)
    expect(fs.statSync(man, { bigint: true }).ino.toString()).toBe(winnerIno)
    expect(fs.readFileSync(man, 'utf8')).toBe(winnerBytes)
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('HS-189 (B2-V2) a real board transiently locked by another process retries cleanly during Step 2b and opens', { timeout: 60_000 }, async () => {
    const root = tmp()
    const dir = join(root, 'busy')
    const db = join(dir, 'board.db')
    const init = openBoardStore({ kind: 'file', db, dir, defaultDir: false })
    const expectedId = init.manifest!.boardId
    init.close()
    fs.unlinkSync(`${db}.manifest.json`)

    const ready = join(root, 'locked')
    const locker = run({ db, holdLock: { ready, ms: 200 } })
    const deadline = Date.now() + 30_000
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) throw new Error('locker child never acquired exclusive lock')
      await new Promise((r) => setTimeout(r, 5))
    }

    const opened = openBoardStore({ kind: 'file', db, dir, defaultDir: false })
    try {
      expect(opened.manifest!.boardId).toBe(expectedId)
    } finally {
      opened.close()
    }
    const res = await locker
    expect(res.code, res.stderr).toBe(0)
  })

  it('HS-41 a crash before the manifest leaves an identified db; a crash after the tmp write leaves a stray; the next open heals both', { timeout: 60_000 }, async () => {
    // A: exits between the store open and the manifest
    const a = join(tmp(), 'a', 'board.db')
    const ra = await run({ db: a, hook: 'beforeManifest' })
    expect(ra.code, ra.stderr).toBe(9)
    expect(fs.existsSync(`${a}.manifest.json`)).toBe(false)
    const minted = ctxBoardId(a)
    expect(minted).toMatch(/^b_[0-9a-f]{32}$/)
    const oa = openBoardStore({ kind: 'file', db: a, dir: join(a, '..'), defaultDir: false })
    try {
      expect(oa.created).toBe(false)
      expect(oa.manifest!.boardId).toBe(minted)
      expect(JSON.parse(fs.readFileSync(`${a}.manifest.json`, 'utf8'))).toMatchObject({ boardId: minted })
    } finally {
      oa.close()
    }

    // B: exits after writing its tmp, before the link
    const bdir = join(tmp(), 'b')
    const b = join(bdir, 'board.db')
    const rb = await run({ db: b, hook: 'afterTmpWrite' })
    expect(rb.code, rb.stderr).toBe(9)
    const strays = fs.readdirSync(bdir).filter((n) => n.endsWith('.tmp'))
    expect(strays).toHaveLength(1)
    expect(strays[0]).toMatch(/^board\.db\.manifest\.json\.\d+\.[0-9a-f]{8}\.tmp$/)
    expect(fs.existsSync(`${b}.manifest.json`)).toBe(false)
    const ob = openBoardStore({ kind: 'file', db: b, dir: bdir, defaultDir: false })
    try {
      expect(ob.created).toBe(false)
      expect(ob.manifest!.boardId).toBe(ctxBoardId(b))
      expect(JSON.parse(fs.readFileSync(strays.map((n) => join(bdir, n))[0]!, 'utf8'))).toMatchObject({ boardId: ob.manifest!.boardId })
    } finally {
      ob.close()
    }
    expect(layoutReport(b, ctx()).strays).toEqual([join(bdir, strays[0]!)])
    expect(layoutReport(b, ctx()).manifest).toMatchObject({ boardId: ctxBoardId(b) })
  })
})

describe('modes under a real umask (HS-35, HS-190)', () => {
  it('HS-35 under umask 002 the default in-repo board opens: the 0775 repo only warns; the dir is 0700 and every file 0600', { timeout: 60_000 }, async () => {
    const repo = join(tmp(), 'repo')
    const r = await run({ repo, umask: 0o002 })
    expect(r.code, r.stderr).toBe(0)
    const out = r.out!
    expect(fs.statSync(repo).mode & 0o777).toBe(0o775) // what umask 002 gave the repo (F26)
    const dir = join(repo, '.swarmboard')
    expect(out.modes[dir]).toBe(0o700)
    for (const [p, m] of Object.entries(out.modes)) if (p !== dir) expect(m, p).toBe(0o600)
    const group = out.warnings.filter((w) => w.note.startsWith('writable-by-group:')).map((w) => w.value)
    expect(group).toEqual([repo])
    expect(fs.readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n!config.json\n')
  })

  it('HS-190 under umask 022 a reopen recreates deleted sidecars 0600 (the core would make them 0644)', { timeout: 60_000 }, async () => {
    const db = join(tmp(), 'u', 'board.db')
    const first = await run({ db, umask: 0o022 })
    expect(first.code, first.stderr).toBe(0)
    fs.unlinkSync(`${db}.jsonl`)
    fs.unlinkSync(`${db}.wakeup`)
    const again = await run({ db, umask: 0o022 })
    expect(again.code, again.stderr).toBe(0)
    expect(again.out!.created).toBe(false)
    expect(again.out!.boardId).toBe(first.out!.boardId)
    expect(fs.statSync(`${db}.jsonl`).mode & 0o777).toBe(0o600)
    expect(fs.statSync(`${db}.wakeup`).mode & 0o777).toBe(0o600)
  })
})
