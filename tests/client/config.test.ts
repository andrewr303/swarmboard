// HS-24..HS-29: project and user config (src/client/config.ts), plus the merge rules that resolveBoard applies.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkUserConfigFile,
  findProjectConfig,
  parseProjectConfig,
  parseUserConfig,
  resolveProjectDb,
  userConfigPath,
} from '../../src/client/config.ts'
import { isBoardError } from '../../src/client/errors.ts'
import { nodeResolverFs, resolveBoard, type ResolveContext, type ResolveFlags, type ResolverFs } from '../../src/client/resolve.ts'
import { FakeFs, type FakeEntry } from './fake-fs.ts'

const tmpRoots: string[] = []
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
})
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

function thrown(fn: () => unknown): { code: string; status: number; message: string; details: unknown } {
  try {
    fn()
  } catch (e) {
    if (isBoardError(e)) return { code: e.code, status: e.status, message: e.message, details: e.details }
    throw e
  }
  throw new Error('expected a throw')
}

const HOME = '/home/u'
const USER_CFG = '/home/u/.config/swarmboard/config.json'
const FULL = '{"version":1,"db":".swarmboard/board.db","mode":"auto","daemon":{"idleExitS":600,"spawn":"on-demand"},"tick":"lease","wake":{"watch":true,"safetyPollMs":1500},"auth":{"enforce":false}}'

function ctx(files: Record<string, FakeEntry>, extra: Partial<ResolveContext> = {}, fsOptions = {}): ResolveContext {
  return { env: {}, cwd: '/r', platform: 'linux', home: HOME, uid: 501, fs: new FakeFs(files, fsOptions), ...extra }
}
const resolveWith = (files: Record<string, FakeEntry>, flags: ResolveFlags = {}, extra: Partial<ResolveContext> = {}) =>
  resolveBoard(flags, ctx({ '/r/.git': { kind: 'dir' }, ...files }, extra))

describe('project config parsing (HS-24, HS-25)', () => {
  it('HS-24 the documented full config parses with no warnings', () => {
    const p = parseProjectConfig(FULL, '/r/.swarmboard/config.json')
    expect(p.warnings).toEqual([])
    expect(p.value).toEqual({
      version: 1,
      db: '.swarmboard/board.db',
      mode: 'auto',
      daemon: { idleExitS: 600, spawn: 'on-demand' },
      tick: 'lease',
      wake: { watch: true, safetyPollMs: 1500 },
      auth: { enforce: false },
    })
  })

  it('HS-24 an unknown key is a warning that names it, and is dropped', () => {
    const p = parseProjectConfig('{"version":1,"mdoe":"file"}', '/r/.swarmboard/config.json')
    expect(p.value).toEqual({ version: 1 })
    expect('mode' in p.value).toBe(false)
    expect(p.warnings).toHaveLength(1)
    expect(p.warnings[0]).toMatchObject({ topic: 'config', outcome: 'warn' })
    expect(p.warnings[0]!.note).toContain('mdoe')
  })

  it('HS-24 a nested unknown key warns with its dotted path; version may be absent', () => {
    const p = parseProjectConfig('{"wake":{"watch":false,"poll":3}}', '/c.json')
    expect(p.value).toEqual({ version: 1, wake: { watch: false } })
    expect(p.warnings[0]!.note).toContain('wake.poll')
  })

  it('HS-24 a wrong version, a non-object, and broken JSON are invalid_config', () => {
    const v = thrown(() => parseProjectConfig('{"version":2}', '/c.json'))
    expect(v).toMatchObject({ code: 'invalid_config', status: 400, details: { reason: 'version', version: 2 } })
    expect(thrown(() => parseProjectConfig('[]', '/c.json')).code).toBe('invalid_config')
    expect(thrown(() => parseProjectConfig('"x"', '/c.json')).code).toBe('invalid_config')
    expect(thrown(() => parseProjectConfig('null', '/c.json')).code).toBe('invalid_config')
    const broken = thrown(() => parseProjectConfig('{"version":1,', '/c.json'))
    expect(broken.code).toBe('invalid_config')
    expect(broken.message).toContain('/c.json')
    expect(broken.message).not.toContain('{"version"')
  })

  it('HS-24 parse errors never quote file content even when raw JSON.parse does (B1-F2)', () => {
    for (const raw of ['not json SECRET', '{"k": SECRET}']) {
      // Prove the raw SyntaxError from V8 actually quotes the secret, so this test cannot be vacuous.
      let rawMessage = ''
      try {
        JSON.parse(raw)
      } catch (e) {
        rawMessage = e instanceof Error ? e.message : ''
      }
      expect(rawMessage, raw).toContain('SECRET')

      const projErr = thrown(() => parseProjectConfig(raw, '/r/.swarmboard/config.json'))
      expect(projErr).toMatchObject({ code: 'invalid_config', status: 400 })
      expect(projErr.message).toContain('/r/.swarmboard/config.json')
      expect(projErr.message).not.toContain('SECRET')
      expect(JSON.stringify(projErr.details)).not.toContain('SECRET')

      const userErr = thrown(() => parseUserConfig(raw, USER_CFG, HOME))
      expect(userErr).toMatchObject({ code: 'invalid_config', status: 400 })
      expect(userErr.message).toContain(USER_CFG)
      expect(userErr.message).not.toContain('SECRET')
      expect(JSON.stringify(userErr.details)).not.toContain('SECRET')
    }
  })

  it('HS-24 wrong types and enum values name the key path', () => {
    expect(thrown(() => parseProjectConfig('{"mode":"fast"}', '/c.json')).message).toContain('mode')
    expect(thrown(() => parseProjectConfig('{"tick":1}', '/c.json')).message).toContain('tick')
    expect(thrown(() => parseProjectConfig('{"wake":{"watch":"yes"}}', '/c.json')).message).toContain('wake.watch')
    expect(thrown(() => parseProjectConfig('{"db":""}', '/c.json')).code).toBe('invalid_config')
    expect(thrown(() => parseProjectConfig('{"daemon":[]}', '/c.json')).code).toBe('invalid_config')
  })

  it('HS-25 forbidden keys are 403 config_forbidden with the dotted path', () => {
    const cases: Array<[string, string]> = [
      ['{"url":"https://h/x"}', 'url'],
      ['{"daemon":{"host":"x"}}', 'daemon.host'],
      ['{"boards":{}}', 'boards'],
      ['{"default":"x"}', 'default'],
      ['{"auth":{"token":"t"}}', 'auth.token'],
      ['{"allowUnsafeFs":true}', 'allowUnsafeFs'],
      ['{"wake":{"wakeup":"/x"}}', 'wake.wakeup'],
      ['{"jsonl":"/x"}', 'jsonl'],
      ['{"service":{}}', 'service'],
      ['{"tcp":1}', 'tcp'],
      ['{"lan":1}', 'lan'],
      ['{"tailscale":1}', 'tailscale'],
      ['{"x":[{"token":"t"}]}', 'x.0.token'],
      ['{"HOST":"x"}', 'HOST'],
    ]
    for (const [text, key] of cases) {
      const e = thrown(() => parseProjectConfig(text, '/c.json'))
      expect(e, text).toMatchObject({ code: 'config_forbidden', status: 403 })
      expect((e.details as { key: string }).key, text).toBe(key)
    }
  })

  it('HS-25 the forbidden-key refusal does not echo the value', () => {
    const e = thrown(() => parseProjectConfig('{"auth":{"token":"SECRET-VALUE"}}', '/c.json'))
    expect(e.message).not.toContain('SECRET')
    expect(JSON.stringify(e.details)).not.toContain('SECRET')
  })
})

describe('project db location (HS-26)', () => {
  const fs = new FakeFs({}, { links: { '/r/data': '/elsewhere' } })
  const cfg = (db: string) => parseProjectConfig(JSON.stringify({ version: 1, db }), '/c.json').value

  it('HS-26 a path outside the repo is 403 unsafe_config outside-repo', () => {
    for (const db of ['../x.db', '/etc/b.db', 'data/b.db', '/r/../x.db', '/r']) {
      const e = thrown(() => resolveProjectDb(cfg(db), '/r', '/r', fs))
      expect(e, db).toMatchObject({ code: 'unsafe_config', status: 403, details: { reason: 'outside-repo' } })
    }
  })

  it('HS-26 a path inside the repo resolves against the project root', () => {
    expect(resolveProjectDb(cfg('data2/b.db'), '/r', '/r', fs)).toBe('/r/data2/b.db')
    expect(resolveProjectDb(cfg('b.db'), '/r/pkg', '/r', fs)).toBe('/r/pkg/b.db')
    expect(resolveProjectDb(cfg('/r/x/b.db'), '/r/pkg', '/r', fs)).toBe('/r/x/b.db')
  })

  it('HS-26 a project at a nested root is found from a subdirectory', () => {
    const f = new FakeFs({ '/r/pkg/.swarmboard/config.json': '{"version":1,"db":"b.db"}' })
    expect(findProjectConfig('/r/pkg/src', '/r', f)).toEqual({ path: '/r/pkg/.swarmboard/config.json', root: '/r/pkg' })
    const via = resolveWith({ '/r/pkg/.swarmboard/config.json': '{"version":1,"db":"b.db"}' }, {}, { cwd: '/r/pkg/src' })
    expect(via.target).toMatchObject({ kind: 'file', db: '/r/pkg/b.db' })
    expect(via.source).toBe('project:/r/pkg/.swarmboard/config.json')
  })

  it('HS-26 findProjectConfig never looks above the git root or outside a repo', () => {
    const f = new FakeFs({ '/.swarmboard/config.json': '{}', '/r/a/.swarmboard/config.json': '{}' })
    expect(findProjectConfig('/r/a/b', '/r', f)?.root).toBe('/r/a')
    expect(f.touched().every((p) => p.startsWith('/r'))).toBe(true)
    expect(findProjectConfig('/r/a/b', null, f)).toBeNull()
    expect(findProjectConfig('/q', '/q', new FakeFs({ '/.swarmboard/config.json': '{}' }))).toBeNull()
  })

  it('HS-26 an unsafe project db fails resolveBoard when the project db is chosen', () => {
    const e = thrown(() => resolveWith({ '/r/.swarmboard/config.json': '{"db":"../x.db"}' }))
    expect(e).toMatchObject({ code: 'unsafe_config', status: 403 })
  })

  it('HS-26 dangling symlinks escaping the repo are refused on the real filesystem (B1-F3)', () => {
    const base = mkTmp('hs-b1f3-')
    const repo = join(base, 'repo')
    const realSub = join(repo, 'real')
    const elsewhere = join(base, 'elsewhere') // intentionally absent (dangling)
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.swarmboard'), { recursive: true })
    mkdirSync(realSub, { recursive: true })

    // 1. Final component dangling symlink with absolute outside target
    symlinkSync(join(elsewhere, 'x.db'), join(realSub, 'abs-out.db'))
    // 2. Final component dangling symlink with relative outside target
    symlinkSync('../../elsewhere/rel.db', join(realSub, 'rel-out.db'))
    // 3. Intermediate dangling directory symlink pointing outside
    symlinkSync(elsewhere, join(repo, 'dangling-dir'))
    // 4. Chained dangling symlinks escaping outside
    symlinkSync('abs-out.db', join(realSub, 'chain.db'))
    // 5. Dangling symlink whose target traverses an existing symlink + `..` to escape outside
    const outsideSub = join(base, 'outside-dir', 'sub')
    mkdirSync(outsideSub, { recursive: true })
    symlinkSync(outsideSub, join(realSub, 'hop'))
    symlinkSync('hop/../escaped.db', join(realSub, 'hop-escape.db'))
    // 6. Symlink loop at final component
    symlinkSync(join(realSub, 'loop-b.db'), join(realSub, 'loop-a.db'))
    symlinkSync(join(realSub, 'loop-a.db'), join(realSub, 'loop-b.db'))
    // 7. Dangling symlink staying inside the repo (allowed by resolveProjectDb; opener enforces symlink guard)
    symlinkSync('./inside-target.db', join(realSub, 'in-repo.db'))

    for (const db of ['real/abs-out.db', 'real/rel-out.db', 'dangling-dir/sub/b.db', 'real/chain.db', 'real/hop-escape.db', 'real/loop-a.db']) {
      const e = thrown(() => resolveProjectDb(cfg(db), repo, repo, nodeResolverFs))
      expect(e, db).toMatchObject({ code: 'unsafe_config', status: 403, details: { reason: 'outside-repo' } })
    }

    // End-to-end through resolveBoard with real nodeResolverFs
    writeFileSync(join(repo, '.swarmboard', 'config.json'), '{"version":1,"db":"real/abs-out.db"}')
    const resErr = thrown(() =>
      resolveBoard(
        {},
        {
          env: {},
          cwd: repo,
          platform: process.platform,
          home: join(base, 'home'),
          uid: typeof process.getuid === 'function' ? process.getuid() : null,
          fs: nodeResolverFs,
        },
      ),
    )
    expect(resErr).toMatchObject({ code: 'unsafe_config', status: 403, details: { reason: 'outside-repo' } })

    // Dangling symlink pointing inside the repo resolves inside the repo
    expect(resolveProjectDb(cfg('real/in-repo.db'), repo, repo, nodeResolverFs)).toBe(join(realSub, 'in-repo.db'))

    // Defense in depth: a custom ResolverFs whose realpathish fails to follow a dangling final symlink
    const naiveFs: ResolverFs = {
      readText: () => null,
      lstat: (p) => (p === '/r/real/link.db' ? { kind: 'symlink', mode: 0o777, uid: 501 } : null),
      realpathish: (p) => p,
    }
    const naiveErr = thrown(() => resolveProjectDb(cfg('real/link.db'), '/r', '/r', naiveFs))
    expect(naiveErr).toMatchObject({ code: 'unsafe_config', status: 403, details: { reason: 'outside-repo' } })
  })
})

describe('filesystem errors are normalized to ClientError (B1-F4)', () => {
  it('B1-F4 a directory at .swarmboard/config.json throws ClientError invalid_config instead of raw EISDIR', () => {
    const base = mkTmp('hs-b1f4-dir-')
    const repo = join(base, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.swarmboard', 'config.json'), { recursive: true })

    const err = thrown(() =>
      resolveBoard(
        {},
        {
          env: {},
          cwd: repo,
          platform: process.platform,
          home: join(base, 'home'),
          uid: typeof process.getuid === 'function' ? process.getuid() : null,
          fs: nodeResolverFs,
        },
      ),
    )
    expect(err).toMatchObject({ code: 'invalid_config', status: 400, details: { reason: 'not-a-file' } })
  })

  it('B1-F4 non-ENOENT/ENOTDIR fs errors (EISDIR, EACCES) wrap as ClientError across config helpers', () => {
    const mkErr = (code: string) => Object.assign(new Error(`${code}: simulated`), { code })

    const eisdirReadFs: ResolverFs = {
      readText: () => {
        throw mkErr('EISDIR')
      },
      lstat: (p) => (p === '/r/.git' ? { kind: 'dir', mode: 0o755, uid: 501 } : p === '/r/.swarmboard/config.json' ? { kind: 'file', mode: 0o644, uid: 501 } : null),
      realpathish: (p) => p,
    }
    expect(
      thrown(() => resolveBoard({}, { env: {}, cwd: '/r', platform: 'linux', home: HOME, uid: 501, fs: eisdirReadFs })),
    ).toMatchObject({ code: 'invalid_config', status: 400, details: { reason: 'io', errno: 'EISDIR' } })

    const eaccesUserReadFs: ResolverFs = {
      readText: (p) => {
        if (p === USER_CFG) throw mkErr('EACCES')
        return null
      },
      lstat: (p) => (p === USER_CFG ? { kind: 'file', mode: 0o600, uid: 501 } : null),
      realpathish: (p) => p,
    }
    expect(
      thrown(() => resolveBoard({}, { env: {}, cwd: '/w', platform: 'linux', home: HOME, uid: 501, fs: eaccesUserReadFs })),
    ).toMatchObject({ code: 'invalid_config', status: 400, details: { reason: 'io', errno: 'EACCES' } })

    const eaccesLstatFs: ResolverFs = {
      readText: () => null,
      lstat: () => {
        throw mkErr('EACCES')
      },
      realpathish: (p) => p,
    }
    expect(thrown(() => findProjectConfig('/r', '/r', eaccesLstatFs))).toMatchObject({
      code: 'invalid_config',
      status: 400,
      details: { reason: 'io', errno: 'EACCES' },
    })
    expect(thrown(() => checkUserConfigFile(USER_CFG, eaccesLstatFs, 501))).toMatchObject({
      code: 'invalid_config',
      status: 400,
      details: { reason: 'io', errno: 'EACCES' },
    })

    const eaccesRealpathFs: ResolverFs = {
      readText: () => null,
      lstat: () => null,
      realpathish: () => {
        throw mkErr('EACCES')
      },
    }
    expect(thrown(() => resolveProjectDb({ version: 1, db: 'b.db' }, '/r', '/r', eaccesRealpathFs))).toMatchObject({
      code: 'invalid_config',
      status: 400,
      details: { reason: 'io', errno: 'EACCES' },
    })

    // Non-file user config is refused even when uid is null (win32)
    const winDirFs = new FakeFs({ [USER_CFG]: { kind: 'dir', mode: 0o755 } })
    expect(thrown(() => checkUserConfigFile(USER_CFG, winDirFs, null))).toMatchObject({
      code: 'unsafe_config',
      status: 403,
      details: { reason: 'not-a-file' },
    })
  })
})

describe('user config (HS-27, HS-28, HS-29)', () => {
  it('HS-27 permissions: group or world writable, a foreign owner', () => {
    const f = (mode: number, uid = 501) => new FakeFs({ [USER_CFG]: { text: '{}', mode, uid } })
    expect(thrown(() => checkUserConfigFile(USER_CFG, f(0o664), 501))).toMatchObject({
      code: 'unsafe_config',
      status: 403,
      details: { reason: 'writable-by-others' },
    })
    expect(thrown(() => checkUserConfigFile(USER_CFG, f(0o602), 501)).details).toEqual({ reason: 'writable-by-others' })
    expect(thrown(() => checkUserConfigFile(USER_CFG, f(0o644, 501), 502)).details).toEqual({ reason: 'foreign-owner' })
    expect(checkUserConfigFile(USER_CFG, f(0o644), 501)).toBeNull()
    expect(checkUserConfigFile(USER_CFG, f(0o600), 501)).toBeNull()
    expect(checkUserConfigFile('/missing.json', f(0o600), 501)).toBeNull()
  })

  it('HS-27 a symlinked config is checked at its target', () => {
    const fs = new FakeFs(
      { [USER_CFG]: { kind: 'symlink', mode: 0o777 }, '/real/c.json': { text: '{}', mode: 0o666 } },
      { links: { [USER_CFG]: '/real/c.json' } },
    )
    expect(thrown(() => checkUserConfigFile(USER_CFG, fs, 501)).details).toEqual({ reason: 'writable-by-others' })
  })

  it('HS-27 on win32 (uid null) the check is skipped with a warn step; resolveBoard accepts', () => {
    const fs = new FakeFs({ [USER_CFG]: { text: '{}', mode: 0o666 } })
    const step = checkUserConfigFile(USER_CFG, fs, null)
    expect(step).toMatchObject({ topic: 'config', outcome: 'warn' })
    expect(step!.note).toContain('not-checked')
    const res = resolveBoard({}, {
      env: { APPDATA: 'C:\\A' },
      cwd: 'C:\\w',
      platform: 'win32',
      home: 'C:\\Users\\u',
      uid: null,
      fs: new FakeFs({ 'C:\\A\\swarmboard\\config.json': { text: '{"version":1}', mode: 0o666 } }),
    })
    expect(res.explain.some((s) => s.outcome === 'warn' && s.note.includes('not-checked'))).toBe(true)
    expect(res.configs.user).toBe('C:\\A\\swarmboard\\config.json')
  })

  it('HS-27 resolveBoard refuses an unsafe user config', () => {
    const e = thrown(() => resolveWith({ [USER_CFG]: { text: '{"version":1}', mode: 0o664 } }))
    expect(e).toMatchObject({ code: 'unsafe_config', details: { reason: 'writable-by-others' } })
  })

  it('HS-27 userConfigPath', () => {
    expect(userConfigPath({}, 'linux', HOME)).toBe('/home/u/.config/swarmboard/config.json')
    expect(userConfigPath({}, 'darwin', HOME)).toBe('/home/u/.config/swarmboard/config.json')
    expect(userConfigPath({ XDG_CONFIG_HOME: '/x' }, 'linux', HOME)).toBe('/x/swarmboard/config.json')
    expect(userConfigPath({ XDG_CONFIG_HOME: ' ' }, 'linux', HOME)).toBe('/home/u/.config/swarmboard/config.json')
    expect(userConfigPath({ APPDATA: 'C:\\A' }, 'win32', 'C:\\Users\\u')).toBe('C:\\A\\swarmboard\\config.json')
    expect(userConfigPath({}, 'win32', 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Roaming\\swarmboard\\config.json')
  })

  it('HS-28 auth.enforce is an OR: a config can only tighten', () => {
    const user = { [USER_CFG]: '{"version":1,"auth":{"enforce":true}}' }
    const proj = { '/r/.swarmboard/config.json': '{"version":1,"auth":{"enforce":false}}' }
    expect(resolveWith({ ...user, ...proj }).policy.authEnforce).toBe(true)
    expect(resolveWith({ ...proj }).policy.authEnforce).toBe(false)
    expect(resolveWith({ '/r/.swarmboard/config.json': '{"auth":{"enforce":true}}' }).policy.authEnforce).toBe(true)
  })

  it('HS-28 mode: the project beats the chosen user entry', () => {
    const files = {
      [USER_CFG]: '{"version":1,"boards":{"b":{"db":"/b/board.db","mode":"daemon"}},"default":"b"}',
      '/r/.swarmboard/config.json': '{"version":1,"mode":"file"}',
    }
    const res = resolveWith(files)
    expect(res.policy.mode).toBe('file')
    expect(res.policy.modeSource).toBe('project:/r/.swarmboard/config.json')
    expect(res.target).toMatchObject({ db: '/b/board.db' })
    const only = resolveWith({ [USER_CFG]: files[USER_CFG] })
    expect(only.policy.mode).toBe('daemon')
    expect(only.policy.modeSource).toBe(`user:${USER_CFG}`)
  })

  it('HS-28 project values beat user values; policy defaults', () => {
    const res = resolveWith({
      [USER_CFG]: '{"tick":"off","wake":{"watch":false,"safetyPollMs":2000},"daemon":{"idleExitS":10,"spawn":"never"}}',
      '/r/.swarmboard/config.json': '{"tick":"owner-only","wake":{"safetyPollMs":700}}',
    })
    expect(res.policy.tick).toBe('owner-only')
    expect(res.policy.wake).toEqual({ watch: false, safetyPollMs: 700 })
    expect(res.policy.daemon).toEqual({ idleExitS: 10, spawn: 'never' })
    const none = resolveWith({})
    expect(none.policy).toMatchObject({
      tick: 'lease',
      wake: { watch: true, safetyPollMs: 1500 },
      daemon: { idleExitS: 600, spawn: 'on-demand' },
      authEnforce: false,
      allowUnsafeFs: false,
      mode: 'auto',
      modeSource: 'default',
    })
  })

  it('HS-28 bounds: safetyPollMs 50..60000 and idleExitS 0..86400', () => {
    for (const text of [
      '{"wake":{"safetyPollMs":10}}', '{"wake":{"safetyPollMs":49}}', '{"wake":{"safetyPollMs":60001}}',
      '{"wake":{"safetyPollMs":1.5}}', '{"daemon":{"idleExitS":-1}}', '{"daemon":{"idleExitS":86401}}',
    ]) {
      expect(thrown(() => parseProjectConfig(text, '/c.json')).code, text).toBe('invalid_config')
      expect(thrown(() => parseUserConfig(text, USER_CFG, HOME)).code, text).toBe('invalid_config')
    }
    expect(parseProjectConfig('{"wake":{"safetyPollMs":50}}', '/c.json').value.wake?.safetyPollMs).toBe(50)
    expect(parseProjectConfig('{"wake":{"safetyPollMs":60000}}', '/c.json').value.wake?.safetyPollMs).toBe(60000)
    expect(parseProjectConfig('{"daemon":{"idleExitS":0}}', '/c.json').value.daemon?.idleExitS).toBe(0)
    expect(parseProjectConfig('{"daemon":{"idleExitS":86400}}', '/c.json').value.daemon?.idleExitS).toBe(86400)
  })

  it('HS-29 user entries: relative db, both or neither of url and db, bad names', () => {
    const bad = (boards: unknown) => thrown(() => parseUserConfig(JSON.stringify({ version: 1, boards }), USER_CFG, HOME))
    expect(bad({ b: { db: 'boards/b.db' } }).code).toBe('invalid_config')
    expect(bad({ b: { db: '/x.db', url: 'https://h/x' } }).code).toBe('invalid_config')
    expect(bad({ b: {} }).code).toBe('invalid_config')
    expect(bad({ Corp: { db: '/x.db' } }).code).toBe('invalid_config')
    expect(bad({ '1b': { db: '/x.db' } }).code).toBe('invalid_config')
    expect(bad({ b: { url: 'http://example.com' } }).code).toBe('invalid_config')
    expect(bad({ b: { url: 'https://u:p@h/x' } }).code).toBe('invalid_config')
    expect(bad({ b: { url: 'https://h/x', auth: 'basic' } }).code).toBe('invalid_config')
    expect(bad({ b: { db: '/x.db', mode: 'turbo' } }).code).toBe('invalid_config')
    expect(bad([]).code).toBe('invalid_config')
  })

  it('HS-29 a leading ~/ expands against home in the user config only', () => {
    const p = parseUserConfig('{"version":1,"boards":{"local":{"db":"~/b/board.db"},"r":{"url":"https://h/x","auth":"oidc"}},"default":"local"}', USER_CFG, HOME)
    expect(p.value.boards).toEqual({ local: { db: '/home/u/b/board.db' }, r: { url: 'https://h/x', auth: 'oidc' } })
    expect(p.value.default).toBe('local')
    expect(p.warnings).toEqual([])
    const e = thrown(() => resolveWith({}, {}, { env: { SWARMBOARD_DB: '~/b.db' } }))
    expect(e.code).toBe('invalid_db_path')
    expect(e.message).toContain('SWARMBOARD_DB')
  })

  it('HS-29 user config keys: allowUnsafeFs, service is opaque, unknown keys warn', () => {
    const p = parseUserConfig('{"allowUnsafeFs":true,"service":{"anything":[1]},"extra":1,"boards":{"b":{"url":"https://h/x","mode":"file"}}}', USER_CFG, HOME)
    expect(p.value.allowUnsafeFs).toBe(true)
    expect(p.value.service).toEqual({ anything: [1] })
    expect(p.warnings.map((w) => w.note).join('|')).toMatch(/extra/)
    expect(p.warnings.map((w) => w.note).join('|')).toMatch(/boards\.b\.mode/)
    expect(resolveWith({ [USER_CFG]: '{"allowUnsafeFs":true}' }).policy.allowUnsafeFs).toBe(true)
    expect(resolveWith({ [USER_CFG]: '{"allowUnsafeFs":true}' }, { allowUnsafeFs: false }).policy.allowUnsafeFs).toBe(false)
  })
})
