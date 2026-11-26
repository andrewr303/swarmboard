// HS-04..HS-23: resolveBoard, childEnv and processContext (src/client/resolve.ts), against an in-memory ResolverFs.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isBoardError } from '../../src/client/errors.ts'
import {
  childEnv,
  nodeResolverFs,
  processContext,
  resolveBoard,
  type ResolveContext,
  type ResolveFlags,
  type Resolution,
  type ResolverFs,
} from '../../src/client/resolve.ts'
import { FakeFs, type FakeEntry } from './fake-fs.ts'

const tmpCleanup: Array<() => void> = []
afterAll(() => {
  for (const fn of tmpCleanup.reverse()) {
    try {
      fn()
    } catch {
      // best effort
    }
  }
})

const ROOT = resolvePath(import.meta.dirname, '..', '..')
const HOME = '/home/u'
const USER_CFG = '/home/u/.config/swarmboard/config.json'
const REPO: Record<string, FakeEntry> = { '/r/.git': { kind: 'dir' } }

interface Setup {
  flags?: ResolveFlags
  env?: Record<string, string | undefined>
  files?: Record<string, FakeEntry>
  cwd?: string
  platform?: NodeJS.Platform
  home?: string
  uid?: number | null
}
function run(s: Setup = {}): { res: Resolution; fs: FakeFs } {
  const fs = new FakeFs(s.files ?? {})
  const ctx: ResolveContext = {
    env: s.env ?? {},
    cwd: s.cwd ?? '/work',
    platform: s.platform ?? 'linux',
    home: s.home ?? HOME,
    uid: s.uid === undefined ? 501 : s.uid,
    fs,
  }
  return { res: resolveBoard(s.flags ?? {}, ctx), fs }
}
const resolve = (s: Setup = {}): Resolution => run(s).res
function code(s: Setup): { code: string; status: number; message: string } {
  try {
    resolveBoard(s.flags ?? {}, {
      env: s.env ?? {},
      cwd: s.cwd ?? '/work',
      platform: s.platform ?? 'linux',
      home: s.home ?? HOME,
      uid: s.uid === undefined ? 501 : s.uid,
      fs: new FakeFs(s.files ?? {}),
    })
  } catch (e) {
    if (isBoardError(e)) return { code: e.code, status: e.status, message: e.message }
    throw e
  }
  throw new Error('expected a throw')
}
const db = (r: Resolution): string => {
  if (r.target.kind === 'url') throw new Error('url target')
  return r.target.db
}
const steps = (r: Resolution, topic: string) => r.explain.filter((s) => s.topic === topic)

describe('board choice (HS-04..HS-10)', () => {
  it('HS-04 a flag db beats env, project config and user default; every lower holder is shadowed', () => {
    const r = resolve({
      flags: { db: '/b/x.db' },
      env: { SWARMBOARD_DB: '/e/y.db' },
      cwd: '/r/a',
      files: {
        ...REPO,
        '/r/.swarmboard/config.json': '{"db":"p.db"}',
        [USER_CFG]: '{"boards":{"l":{"db":"/u/b.db"}},"default":"l"}',
      },
    })
    expect(db(r)).toBe('/b/x.db')
    expect(r.source).toBe('flag:db')
    const board = steps(r, 'board')
    expect(board.filter((s) => s.outcome === 'chosen')).toHaveLength(1)
    expect(board.filter((s) => s.outcome === 'chosen')[0]!.source).toBe('flag:db')
    const shadowed = board.filter((s) => s.outcome === 'shadowed').map((s) => s.source)
    expect(shadowed).toContain('env:SWARMBOARD_DB')
    expect(shadowed).toContain('project:/r/.swarmboard/config.json')
    expect(shadowed).toContain(`user:${USER_CFG}`)
    expect(shadowed).toHaveLength(3)
  })

  it('HS-05 flag conflicts, file urls, relative paths, user names', () => {
    expect(code({ flags: { url: 'https://h/x', db: '/a.db' } })).toMatchObject({ code: 'conflicting_options', status: 400 })
    expect(db(resolve({ flags: { board: 'file:///a/b.db' } }))).toBe('/a/b.db')
    expect(code({ flags: { board: './b.db' } }).code).toBe('invalid_db_path')
    const r = resolve({ flags: { board: 'corp' }, files: { [USER_CFG]: '{"boards":{"corp":{"url":"https://h/api/board"}}}' } })
    expect(r.target).toEqual({ kind: 'url', url: 'https://h/api/board', auth: null })
    expect(r.source).toBe(`user:${USER_CFG}`)
    expect(code({ flags: { board: 'nope' } })).toMatchObject({ code: 'no_board', status: 404 })
  })

  it('HS-05 Object.prototype keys like constructor do not crash resolveBoard (B1-F1)', () => {
    // Missing from user boards -> ClientError 404 no_board (never a raw TypeError through Object.prototype)
    expect(code({ flags: { board: 'constructor' }, files: { [USER_CFG]: '{"boards":{}}' } })).toMatchObject({
      code: 'no_board',
      status: 404,
    })
    expect(
      code({ flags: { board: 'constructor' }, files: { [USER_CFG]: '{"boards":{"corp":{"db":"/a.db"}}}' } }),
    ).toMatchObject({ code: 'no_board', status: 404 })
    // User default naming "constructor" when not defined -> ClientError 400 invalid_config
    expect(code({ files: { [USER_CFG]: '{"boards":{},"default":"constructor"}' } })).toMatchObject({
      code: 'invalid_config',
      status: 400,
    })
    // Non-matching prototype keys fail pattern validation cleanly
    expect(code({ flags: { board: 'toString' }, files: { [USER_CFG]: '{"boards":{}}' } })).toMatchObject({
      code: 'invalid_db_path',
      status: 400,
    })
    expect(code({ flags: { board: '__proto__' }, files: { [USER_CFG]: '{"boards":{}}' } })).toMatchObject({
      code: 'invalid_db_path',
      status: 400,
    })
    // An own board literally named "constructor" still resolves cleanly
    const own = resolve({
      flags: { board: 'constructor' },
      files: { [USER_CFG]: '{"boards":{"constructor":{"db":"/c/b.db"}}}' },
    })
    expect(db(own)).toBe('/c/b.db')
  })

  it('HS-06 a relative SWARMBOARD_DB names itself; blank is unset', () => {
    const e = code({ env: { SWARMBOARD_DB: 'rel/b.db' } })
    expect(e.code).toBe('invalid_db_path')
    expect(e.message).toContain('SWARMBOARD_DB')
    expect(resolve({ env: { SWARMBOARD_DB: '  ' } }).source).toBe('default:state')
  })

  it('HS-07 SWARMBOARD_DIR and its agreement with SWARMBOARD_DB', () => {
    const d = resolve({ env: { SWARMBOARD_DIR: '/x' } })
    expect(db(d)).toBe('/x/board.db')
    expect(d.source).toBe('env:SWARMBOARD_DIR')
    const both = resolve({ env: { SWARMBOARD_DIR: '/x/', SWARMBOARD_DB: '/x/board.db' } })
    expect(both.source).toBe('env:SWARMBOARD_DB')
    expect(code({ env: { SWARMBOARD_DIR: '/y', SWARMBOARD_DB: '/x/board.db' } }).code).toBe('conflicting_options')
    expect(code({ env: { SWARMBOARD_DIR: 'rel' } }).message).toContain('SWARMBOARD_DIR')
  })

  it('HS-08 SWARMBOARD_URL with a file variable conflicts', () => {
    expect(code({ env: { SWARMBOARD_URL: 'https://h/api/board', SWARMBOARD_DB: '/x.db' } }).code).toBe('conflicting_options')
    expect(code({ env: { SWARMBOARD_URL: 'https://h/api/board', SWARMBOARD_DIR: '/x' } }).code).toBe('conflicting_options')
  })

  it('HS-09 compat variables: tiering, ignored steps, the name conflict', () => {
    const ignored = resolve({ env: { BOARD_URL: 'https://v/api/board', SWARMBOARD_DB: '/x.db' } })
    expect(ignored.target.kind).toBe('file')
    expect(steps(ignored, 'board').some((s) => s.outcome === 'ignored' && s.source === 'env:BOARD_URL')).toBe(true)
    const alone = resolve({ env: { BOARD_URL: 'https://v/api/board' } })
    expect(alone.target).toMatchObject({ kind: 'url', url: 'https://v/api/board' })
    expect(alone.source).toBe('env:BOARD_URL')
    expect(code({ env: { BOARD_URL: 'https://v/api/board', BOARD_NAME: 't' } }).code).toBe('conflicting_options')
    expect(resolve({ env: { BOARD_NAME: 't', SWARMBOARD_DB: '/x.db' } }).target.kind).toBe('file')
    const name = resolve({ env: { BOARD_NAME: 't' } })
    expect(name.source).toBe('default:state')
    expect(steps(name, 'board').some((s) => s.outcome === 'ignored' && s.source === 'env:BOARD_NAME')).toBe(true)
    // with a canonical variable set, BOARD_URL plus BOARD_NAME is ignored, not a conflict
    expect(resolve({ env: { BOARD_URL: 'https://v/x', BOARD_NAME: 't', SWARMBOARD_DB: '/x.db' } }).source).toBe('env:SWARMBOARD_DB')
  })

  it('HS-10 URL rules and redaction', () => {
    expect(resolve({ flags: { url: 'http://127.0.0.1:4180/api/board' } }).target.kind).toBe('url')
    expect(resolve({ flags: { url: 'http://localhost:4180' } }).target.kind).toBe('url')
    expect(code({ flags: { url: 'http://example.com' } }).code).toBe('invalid_url')
    expect(code({ flags: { url: 'https://u:p@h/x' } }).code).toBe('invalid_url')
    expect(code({ flags: { url: 'https://u:SECRETPW@h/x' } }).message).not.toContain('SECRETPW')
    const r = resolve({ flags: { url: 'https://h/x?token=abc#f' } })
    const chosen = steps(r, 'board').find((s) => s.outcome === 'chosen')!
    expect(chosen.value).toBe('https://h/x')
    expect(JSON.stringify(r)).not.toContain('abc')
  })
})

describe('project, git and default locations (HS-11..HS-15)', () => {
  it('HS-11 the project config is the nearest one inside the repo and nothing outside it is read', () => {
    const { res, fs } = run({
      cwd: '/r/a/b',
      files: { ...REPO, '/r/a/.swarmboard/config.json': '{"db":"p.db"}', '/.swarmboard/config.json': '{"db":"z.db"}' },
    })
    expect(res.configs.project).toBe('/r/a/.swarmboard/config.json')
    expect(db(res)).toBe('/r/a/p.db')
    const outside = fs.touched().filter((p) => !p.startsWith('/r'))
    expect(outside.every((p) => p === USER_CFG)).toBe(true)
    expect(outside).not.toContain('/.swarmboard/config.json')
    expect(outside).not.toContain('/.git')
    const none = run({ cwd: '/work/q', files: { '/work/.swarmboard/config.json': '{"db":"p.db"}', '/.swarmboard/config.json': '{}' } })
    expect(none.res.source).toBe('default:state')
    expect(none.fs.reads.some((p) => p.endsWith('/.swarmboard/config.json'))).toBe(false)
  })

  it('HS-12 a .git file marks the repo root', () => {
    const r = resolve({ cwd: '/r/a/b', files: { '/r/.git': { kind: 'file', text: 'gitdir: /x/y' } } })
    expect(r.gitRoot).toBe('/r')
    expect(db(r)).toBe('/r/.swarmboard/board.db')
    expect(resolve({ cwd: '/work' }).gitRoot).toBeNull()
  })

  it('HS-13 default locations', () => {
    const git = resolve({ cwd: '/r/a', files: REPO })
    expect(git.target).toEqual({ kind: 'file', db: '/r/.swarmboard/board.db', dir: '/r/.swarmboard', defaultDir: true })
    expect(git.source).toBe('default:git')
    const s = resolve({ env: { XDG_STATE_HOME: '/s' } })
    expect(s.target).toEqual({ kind: 'file', db: '/s/swarmboard/default/board.db', dir: '/s/swarmboard/default', defaultDir: false })
    expect(s.source).toBe('default:state')
    expect(db(resolve())).toBe('/home/u/.local/state/swarmboard/default/board.db')
    const w = resolve({ platform: 'win32', uid: null, cwd: 'C:\\w', home: 'C:\\Users\\u', env: { LOCALAPPDATA: 'C:\\L' } })
    expect(db(w)).toBe('C:\\L\\swarmboard\\default\\board.db')
    expect(w.policy.wake.safetyPollMs).toBe(250)
  })

  it('HS-14 user default entries', () => {
    const r = resolve({ files: { [USER_CFG]: '{"boards":{"local":{"db":"~/b/board.db"}},"default":"local"}' } })
    expect(db(r)).toBe('/home/u/b/board.db')
    expect(r.source).toBe(`user:${USER_CFG}`)
    const u = resolve({ files: { [USER_CFG]: '{"boards":{"c":{"url":"https://h/api/board","auth":"oidc"}},"default":"c"}' } })
    expect(u.target).toEqual({ kind: 'url', url: 'https://h/api/board', auth: 'oidc' })
    expect(code({ files: { [USER_CFG]: '{"boards":{},"default":"gone"}' } })).toMatchObject({ code: 'invalid_config', status: 400 })
  })

  it('HS-14 a shadowed bad default does not fail the resolution', () => {
    expect(resolve({ flags: { db: '/a.db' }, files: { [USER_CFG]: '{"default":"gone"}' } }).source).toBe('flag:db')
  })

  it('HS-15 remote is never implicit', () => {
    const r = resolve({ files: { [USER_CFG]: '{"boards":{"c":{"url":"https://h/api/board"}}}' } })
    expect(r.target.kind).toBe('file')
    expect(code({ cwd: '/r', files: { ...REPO, '/r/.swarmboard/config.json': '{"url":"https://h/x"}' } })).toMatchObject({
      code: 'config_forbidden',
      status: 403,
    })
  })
})

describe('mode, identity (HS-16..HS-21)', () => {
  it('HS-16 the mode precedence table', () => {
    const user = { [USER_CFG]: '{"boards":{"b":{"db":"/b.db","mode":"service"}},"default":"b"}' }
    const proj = { ...REPO, '/r/.swarmboard/config.json': '{"mode":"file"}' }
    const rows: Array<[Setup, string, string]> = [
      [{ flags: { mode: 'daemon' }, env: { SWARMBOARD_MODE: 'file' } }, 'daemon', 'flag:mode'],
      [{ env: { SWARMBOARD_MODE: 'file' }, files: user }, 'file', 'env:SWARMBOARD_MODE'],
      [{ env: { SWARMBOARD_DAEMON: 'required' }, files: user }, 'daemon', 'env:SWARMBOARD_DAEMON'],
      [{ cwd: '/r', files: { ...user, ...proj } }, 'file', 'project:/r/.swarmboard/config.json'],
      [{ files: user }, 'service', `user:${USER_CFG}`],
      [{}, 'auto', 'default'],
    ]
    for (const [s, mode, src] of rows) {
      const r = resolve(s)
      expect([r.policy.mode, r.policy.modeSource]).toEqual([mode, src])
    }
    expect(code({ env: { SWARMBOARD_MODE: 'file', SWARMBOARD_DAEMON: 'required' } }).code).toBe('conflicting_options')
    expect(resolve({ env: { SWARMBOARD_DAEMON: 'off', SWARMBOARD_MODE: 'file' } }).policy.mode).toBe('file')
    expect(resolve({ env: { SWARMBOARD_DAEMON: 'auto' } }).policy.mode).toBe('auto')
    expect(code({ env: { SWARMBOARD_MODE: 'fast' } })).toMatchObject({ code: 'invalid_mode', status: 400 })
  })

  it('HS-17 url targets, in-process and memory', () => {
    expect(code({ flags: { url: 'https://h/x', mode: 'file' } }).code).toBe('conflicting_options')
    expect(code({ flags: { url: 'https://h/x', inProcess: true } }).code).toBe('conflicting_options')
    expect(code({ flags: { db: ':memory:' } }).code).toBe('invalid_db_path')
    const m = resolve({ flags: { db: ':memory:', inProcess: true } })
    expect(m.target).toEqual({ kind: 'memory', db: ':memory:' })
    expect(m.policy.inProcess).toBe(true)
    const ip = resolve({ flags: { db: '/m.db', inProcess: true, mode: 'daemon' } })
    expect(ip.policy.inProcess).toBe(true)
    expect(steps(ip, 'mode').some((s) => s.outcome === 'ignored')).toBe(true)
  })

  it('HS-17 a project mode does not conflict with a url board: it is ignored', () => {
    const r = resolve({ cwd: '/r', flags: { url: 'https://h/x' }, files: { ...REPO, '/r/.swarmboard/config.json': '{"mode":"file"}' } })
    expect(r.target.kind).toBe('url')
    expect(steps(r, 'mode').some((s) => s.outcome === 'ignored')).toBe(true)
  })

  it('HS-18 profile precedence and validation', () => {
    const a = resolve({ flags: { as: 'a1' }, env: { SWARMBOARD_AGENT: 'a2' } })
    expect([a.identity.profile, a.identity.profileSource]).toEqual(['a1', 'flag:as'])
    const n = resolve({ flags: { as: null }, env: { SWARMBOARD_AGENT: 'a2' } })
    expect([n.identity.profile, n.identity.profileSource]).toEqual([null, 'flag:as'])
    const c = resolve({ env: { SWARMBOARD_AGENT: 'a2', BOARD_PROFILE: 'b', FUSION_AGENT_ID: 'f' } })
    expect([c.identity.profile, c.identity.profileSource]).toEqual(['a2', 'env:SWARMBOARD_AGENT'])
    expect(steps(c, 'identity').filter((s) => s.outcome === 'ignored').map((s) => s.source).sort()).toEqual(['env:BOARD_PROFILE', 'env:FUSION_AGENT_ID'])
    expect(resolve({ env: { BOARD_PROFILE: 'b', FUSION_AGENT_ID: 'f' } }).identity.profile).toBe('b')
    const bad = code({ env: { FUSION_AGENT_ID: 'worker_1' } })
    expect(bad).toMatchObject({ code: 'invalid_profile', status: 400 })
    expect(bad.message).toContain('FUSION_AGENT_ID')
    expect(code({ flags: { as: 'bad_name' } }).message).toContain('--as')
    expect(resolve({}).identity).toMatchObject({ profile: null, profileSource: null })
  })

  it('HS-19 the token is reported but never stored', () => {
    const r = resolve({ env: { SWARMBOARD_TOKEN: 'tok-SECRET-123', BOARD_TOKEN: 'tok-OTHER-999' } })
    expect(r.identity.token).toBe('set')
    expect(r.identity.tokenSource).toBe('env:SWARMBOARD_TOKEN')
    const text = JSON.stringify(r)
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('OTHER')
    for (const s of r.explain) expect(`${s.value ?? ''}${s.note}`).not.toMatch(/SECRET|OTHER/)
    expect(steps(r, 'identity').some((s) => s.outcome === 'ignored' && s.source === 'env:BOARD_TOKEN')).toBe(true)
    const compat = resolve({ env: { BOARD_TOKEN: 'x' } })
    expect([compat.identity.token, compat.identity.tokenSource]).toEqual(['set', 'env:BOARD_TOKEN'])
    expect(resolve({}).identity).toMatchObject({ token: 'unset', tokenSource: null })
  })

  it('HS-20 parent and swarm hints', () => {
    const r = resolve({ env: { FUSION_PARENT_ID: 'cto', FUSION_SWARM_ID: 's1' } })
    expect([r.identity.parent, r.identity.swarm]).toEqual(['cto', 's1'])
    const c = resolve({ env: { FUSION_PARENT_ID: 'cto', SWARMBOARD_PARENT: 'ceo', FUSION_SWARM_ID: 's1', SWARMBOARD_SWARM: 's2' } })
    expect([c.identity.parent, c.identity.swarm]).toEqual(['ceo', 's2'])
    expect(code({ env: { SWARMBOARD_PARENT: 'a\nb' } })).toMatchObject({ code: 'invalid_request', status: 400 })
    expect(code({ env: { SWARMBOARD_SWARM: 'x'.repeat(201) } }).code).toBe('invalid_request')
    expect(resolve({ env: { SWARMBOARD_SWARM: 'x'.repeat(200) } }).identity.swarm).toHaveLength(200)
    expect(resolve({}).identity).toMatchObject({ parent: null, swarm: null })
  })

  it('HS-21 childEnv hands a child the same board, with no compat steering and no token', () => {
    const parent = resolve({
      cwd: '/r/a',
      env: { SWARMBOARD_AGENT: 'cap', SWARMBOARD_TOKEN: 'tok' },
      files: { ...REPO, '/r/.swarmboard/config.json': '{"db":"b.db"}' },
    })
    const env = childEnv(parent, { agent: 'w3' })
    expect(env).toMatchObject({
      SWARMBOARD_DB: '/r/b.db',
      SWARMBOARD_AGENT: 'w3',
      SWARMBOARD_PARENT: 'cap',
      BOARD_URL: '',
      BOARD_PROFILE: '',
      FUSION_AGENT_ID: '',
      SWARMBOARD_MODE: 'auto',
    })
    expect('SWARMBOARD_TOKEN' in env).toBe(false)
    const child = resolve({ cwd: '/', env })
    expect(db(child)).toBe('/r/b.db')
    expect(child.identity.profile).toBe('w3')
    expect(child.identity.parent).toBe('cap')
    expect(childEnv(parent, { agent: 'w3', token: 't1', swarm: 's9' })).toMatchObject({ SWARMBOARD_TOKEN: 't1', SWARMBOARD_SWARM: 's9' })
    expect(() => childEnv(parent, { agent: 'bad_name' })).toThrow()
    const url = resolve({ flags: { url: 'https://h/api/board' } })
    expect(childEnv(url, {})).toMatchObject({ SWARMBOARD_URL: 'https://h/api/board' })
    expect(resolve({ cwd: '/', env: childEnv(url, {}) }).target.kind).toBe('url')
    expect(() => childEnv(resolve({ flags: { db: ':memory:', inProcess: true } }), {})).toThrow()
    // B1-F5: childEnv carries SWARMBOARD_MODE from resolved policy and never propagates SWARMBOARD_UNSAFE_FS
    const unsafeFile = resolve({ flags: { db: '/b/x.db', mode: 'file', allowUnsafeFs: true } })
    const unsafeChildEnv = childEnv(unsafeFile, { agent: 'w4' })
    expect(unsafeChildEnv.SWARMBOARD_MODE).toBe('file')
    expect('SWARMBOARD_UNSAFE_FS' in unsafeChildEnv).toBe(false)
    expect(resolve({ cwd: '/', env: unsafeChildEnv }).policy).toMatchObject({ mode: 'file', allowUnsafeFs: false })
  })
})

describe('determinism, the one-spawner rule and the table (HS-22, HS-23)', () => {
  it('HS-22 two resolutions of equal inputs are deep-equal and frozen (B1-F5)', () => {
    const s: Setup = { cwd: '/r/a', env: { SWARMBOARD_AGENT: 'a1' }, files: { ...REPO, '/r/.swarmboard/config.json': '{"db":"b.db"}' } }
    const r1 = resolve(s)
    const r2 = resolve(s)
    expect(r1).toEqual(r2)
    expect(Object.isFrozen(r1)).toBe(true)
    expect(Object.isFrozen(r1.target)).toBe(true)
    expect(Object.isFrozen(r1.policy)).toBe(true)
    expect(Object.isFrozen(r1.policy.wake)).toBe(true)
    expect(Object.isFrozen(r1.policy.daemon)).toBe(true)
    expect(Object.isFrozen(r1.identity)).toBe(true)
    expect(Object.isFrozen(r1.configs)).toBe(true)
    expect(Object.isFrozen(r1.explain)).toBe(true)
    for (const step of r1.explain) expect(Object.isFrozen(step)).toBe(true)
  })

  it('B1-F4 non-ENOENT/ENOTDIR fs errors during resolution throw ClientError', () => {
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const badGitFs: ResolverFs = {
      readText: () => null,
      lstat: () => {
        throw eacces
      },
      realpathish: (p) => p,
    }
    let caught: unknown
    try {
      resolveBoard({}, { env: {}, cwd: '/work', platform: 'linux', home: HOME, uid: 501, fs: badGitFs })
    } catch (e) {
      caught = e
    }
    expect(isBoardError(caught)).toBe(true)
    expect(caught).toMatchObject({ code: 'internal', status: 500, origin: 'handle', details: { reason: 'io', errno: 'EACCES' } })

    // Real-fs unreadable project config (skip chmod assertion only if running as root)
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
      const dir = mkdtempSync(join(tmpdir(), 'hs-b1f4-eacces-'))
      const cfgPath = join(dir, '.swarmboard', 'config.json')
      tmpCleanup.push(() => {
        try {
          chmodSync(cfgPath, 0o600)
        } catch {
          // ignore
        }
        rmSync(dir, { recursive: true, force: true })
      })
      mkdirSync(join(dir, '.git'), { recursive: true })
      mkdirSync(join(dir, '.swarmboard'), { recursive: true })
      writeFileSync(cfgPath, '{"version":1}')
      chmodSync(cfgPath, 0o000)

      let realErr: unknown
      try {
        resolveBoard(
          {},
          {
            env: {},
            cwd: dir,
            platform: process.platform,
            home: join(dir, 'home'),
            uid: process.getuid(),
            fs: nodeResolverFs,
          },
        )
      } catch (e) {
        realErr = e
      }
      expect(isBoardError(realErr)).toBe(true)
      expect(realErr).toMatchObject({
        code: 'invalid_config',
        status: 400,
        origin: 'handle',
        details: { reason: 'io', errno: 'EACCES' },
      })
    }
  })

  it('HS-22 no file of the resolver or host composition imports a process-spawning or listening module', () => {
    const forbidden = /(?:from|import|require)\s*\(?\s*['"](?:node:)?(?:child_process|net|http|https|worker_threads)['"]/
    const files = [
      'src/client/resolve.ts', 'src/client/config.ts', 'src/host/connect.ts', 'src/host/layout.ts',
      'src/host/file-host.ts', 'src/host/wake-bridge.ts', 'src/host/tick.ts',
    ]
    let scanned = 0
    for (const f of files) {
      let text: string
      try {
        text = readFileSync(join(ROOT, f), 'utf8')
      } catch {
        continue
      }
      scanned += 1
      expect(forbidden.test(text), f).toBe(false)
    }
    expect(scanned).toBeGreaterThanOrEqual(2)
  })

  it('HS-22 processContext reads the process and accepts overrides', () => {
    const c = processContext()
    expect(c.cwd).toBe(process.cwd())
    expect(c.platform).toBe(process.platform)
    expect(c.env).toBe(process.env)
    expect(c.fs).toBe(nodeResolverFs)
    expect(processContext({ cwd: '/zzz' }).cwd).toBe('/zzz')
  })

  it('HS-22 nodeResolverFs reads the real tree', () => {
    const f = nodeResolverFs
    expect(f.readText(join(ROOT, 'package.json'))).toContain('swarmboard')
    expect(f.readText(join(ROOT, 'no-such-file.json'))).toBeNull()
    expect(f.readText(join(ROOT, 'package.json', 'x'))).toBeNull()
    expect(f.lstat(join(ROOT, 'src'))).toMatchObject({ kind: 'dir' })
    expect(f.lstat(join(ROOT, 'package.json'))).toMatchObject({ kind: 'file' })
    expect(f.lstat(join(ROOT, 'nope'))).toBeNull()
    expect(f.realpathish(join(ROOT, 'src', 'missing', 'x.db'))).toBe(join(realpathSync(join(ROOT, 'src')), 'missing', 'x.db'))
  })
})

interface TableRow {
  name: string
  flags?: ResolveFlags
  env?: Record<string, string>
  files?: Record<string, FakeEntry>
  cwd?: string
  home?: string
  platform?: NodeJS.Platform
  uid?: number | null
  expect: {
    kind?: string; db?: string; url?: string; auth?: string | null; source?: string; mode?: string; modeSource?: string
    profile?: string | null; profileSource?: string | null; defaultDir?: boolean; allowUnsafeFs?: boolean; inProcess?: boolean
    error?: string
  }
}

describe('the resolution table (HS-23)', () => {
  const rows = JSON.parse(readFileSync(join(ROOT, 'tests', 'client', 'fixtures', 'resolve-table.json'), 'utf8')) as TableRow[]

  it('HS-23 the table has at least 40 rows with unique names', () => {
    expect(rows.length).toBeGreaterThanOrEqual(40)
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length)
  })

  for (const row of rows) {
    it(`HS-23 ${row.name}`, () => {
      const setup: Setup = {
        ...(row.flags ? { flags: row.flags } : {}),
        ...(row.env ? { env: row.env } : {}),
        ...(row.files ? { files: row.files } : {}),
        ...(row.cwd ? { cwd: row.cwd } : {}),
        ...(row.home ? { home: row.home } : {}),
        ...(row.platform ? { platform: row.platform } : {}),
        ...(row.uid !== undefined ? { uid: row.uid } : {}),
      }
      const want = row.expect
      if (want.error !== undefined) {
        expect(code(setup).code).toBe(want.error)
        return
      }
      const r = resolve(setup)
      expect(r.target.kind).toBe(want.kind)
      if (want.db !== undefined) expect((r.target as { db: string }).db).toBe(want.db)
      if (want.url !== undefined) expect((r.target as { url: string }).url).toBe(want.url)
      if (want.auth !== undefined) expect((r.target as { auth: string | null }).auth).toBe(want.auth)
      if (want.defaultDir !== undefined) expect((r.target as { defaultDir: boolean }).defaultDir).toBe(want.defaultDir)
      if (want.source !== undefined) expect(r.source).toBe(want.source)
      if (want.mode !== undefined) expect(r.policy.mode).toBe(want.mode)
      if (want.modeSource !== undefined) expect(r.policy.modeSource).toBe(want.modeSource)
      if (want.profile !== undefined) expect(r.identity.profile).toBe(want.profile)
      if (want.profileSource !== undefined) expect(r.identity.profileSource).toBe(want.profileSource)
      if (want.allowUnsafeFs !== undefined) expect(r.policy.allowUnsafeFs).toBe(want.allowUnsafeFs)
      if (want.inProcess !== undefined) expect(r.policy.inProcess).toBe(want.inProcess)
      expect(JSON.stringify(r)).not.toMatch(/token=|SECRET/)
    })
  }
})
