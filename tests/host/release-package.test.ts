// End-to-end tests for built-in `swarmboard setup` / `swarmboard uninstall`,
// `scripts/build-release.mjs`, and `install.sh` in completely isolated temp directories.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const DIST_BIN = path.join(REPO_ROOT, 'dist', 'bin', 'swarmboard.mjs')
const BUILD_RELEASE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-release.mjs')
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh')
const PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

function mkTmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra }
  delete env['SWARMBOARD_DB']
  delete env['SWARMBOARD_DIR']
  delete env['SWARMBOARD_URL']
  delete env['SWARMBOARD_AGENT']
  delete env['BOARD_PROFILE']
  delete env['FUSION_AGENT_ID']
  delete env['SWARMBOARD_TOKEN']
  delete env['BOARD_TOKEN']
  delete env['XDG_CONFIG_HOME']
  delete env['XDG_STATE_HOME']
  delete env['XDG_CACHE_HOME']
  delete env['XDG_RUNTIME_DIR']
  return env
}

function seedHarnessHome(): string {
  const home = mkTmp('sb-rel-home-')
  const write = (rel: string, content: string, mode = 0o644) => {
    const full = path.join(home, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, { encoding: 'utf8', mode })
    fs.chmodSync(full, mode)
  }

  write('.zshenv', 'export USER_KEEP=1\n')
  write('AGENTS.md', '# User Agents\n\nKeep me.\n')
  write('dotfiles/claude.md', '\n# Keep Claude rules\n\n\n<!-- swarmboard:universal:start -->\nOld guidance\n<!-- swarmboard:universal:end -->\nTail rule\n')
  fs.mkdirSync(path.join(home, '.claude'))
  fs.symlinkSync('../dotfiles/claude.md', path.join(home, '.claude', 'CLAUDE.md'))
  write('.claude.json', JSON.stringify({ mcpServers: { keep: { command: 'echo' } } }, null, 2), 0o600)
  write('.codex/config.toml', 'model = "gpt-5"\n\n[mcp_servers.keep]\ncommand = "echo"\n', 0o600)
  write('.gemini/config/mcp_config.json', JSON.stringify({ mcpServers: { keep: { command: 'echo' } } }, null, 2))
  return home
}

describe('Built-in `swarmboard setup` and `swarmboard uninstall`', () => {
  it('supports --dry-run, full setup, opt-out flags, idempotent rerun, and safe uninstall (preserve vs --purge-data)', () => {
    const home = seedHarnessHome()
    const env = cleanEnv(home)

    // 1. --dry-run makes zero mutations
    const dryRes = spawnSync(process.execPath, [DIST_BIN, 'setup', '--dry-run', '--home', home, '--json'], {
      env,
      encoding: 'utf8',
    })
    expect(dryRes.status, `dry-run stderr: ${dryRes.stderr}`).toBe(0)
    const dryJson = JSON.parse(dryRes.stdout) as { ok: boolean; dryRun: boolean; bins: unknown[] }
    expect(dryJson.ok).toBe(true)
    expect(dryJson.dryRun).toBe(true)
    expect(dryJson.bins).toHaveLength(3)
    expect(fs.existsSync(path.join(home, '.config', 'swarmboard', 'config.json'))).toBe(false)

    // 2. Full setup with --no-instructions opt-out
    const setupRes = spawnSync(
      process.execPath,
      [DIST_BIN, 'setup', '--home', home, '--no-instructions', '--json'],
      { env, encoding: 'utf8' },
    )
    expect(setupRes.status, `setup stderr: ${setupRes.stderr}`).toBe(0)
    const setupJson = JSON.parse(setupRes.stdout) as {
      ok: boolean
      globalBoard: { doctorOk: boolean; schemaVersion: number; channelsCreated: number }
      instructions: unknown[]
    }
    expect(setupJson.ok).toBe(true)
    expect(setupJson.globalBoard.doctorOk).toBe(true)
    expect(setupJson.globalBoard.schemaVersion).toBe(5)
    expect(setupJson.globalBoard.channelsCreated).toBe(6)
    expect(setupJson.instructions).toEqual([])
    expect(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')).not.toContain('swarmboard:universal:start')
    expect(fs.existsSync(path.join(home, 'CLAUDE.md'))).toBe(false)

    // 3. Re-run with full defaults -> adds instructions while keeping everything else idempotent
    const setup2Res = spawnSync(process.execPath, [DIST_BIN, 'setup', '--home', home, '--json'], {
      env,
      encoding: 'utf8',
    })
    expect(setup2Res.status, `setup2 stderr: ${setup2Res.stderr}`).toBe(0)
    const setup2Json = JSON.parse(setup2Res.stdout) as {
      ok: boolean
      globalBoard: { channelsCreated: number; groupsCreated: number }
      config: { status: string }
    }
    expect(setup2Json.ok).toBe(true)
    expect(setup2Json.config.status).toBe('unchanged')
    expect(setup2Json.globalBoard.channelsCreated).toBe(0)
    expect(setup2Json.globalBoard.groupsCreated).toBe(0)
    for (const rel of ['AGENTS.md', 'CLAUDE.md', '.codex/AGENTS.md', '.claude/CLAUDE.md']) {
      const instructions = fs.readFileSync(path.join(home, rel), 'utf8')
      expect(instructions.match(/<!-- swarmboard:universal:start -->/g), rel).toHaveLength(1)
      expect(instructions, rel).toContain('Claude Code Ultracode, Codex Ultra')
      expect(instructions, rel).toContain('board_post({ re: taskId')
      expect(instructions, rel).not.toContain('Old guidance')
    }
    expect(fs.lstatSync(path.join(home, '.claude/CLAUDE.md')).isSymbolicLink()).toBe(true)

    // 4. Default uninstall removes symlinks, MCP entries, skills, instruction/shell blocks, while PRESERVING DB & config
    const uninstallRes = spawnSync(process.execPath, [DIST_BIN, 'uninstall', '--home', home, '--json'], {
      env,
      encoding: 'utf8',
    })
    expect(uninstallRes.status, `uninstall stderr: ${uninstallRes.stderr}`).toBe(0)
    const uninstallJson = JSON.parse(uninstallRes.stdout) as {
      ok: boolean
      purgeData: boolean
      removed: { kind: string; target: string }[]
      preservedData: string[]
    }
    expect(uninstallJson.ok).toBe(true)
    expect(uninstallJson.purgeData).toBe(false)
    expect(uninstallJson.preservedData).toContain(path.join(home, '.local', 'state', 'swarmboard'))
    expect(uninstallJson.preservedData).toContain(path.join(home, '.config', 'swarmboard'))
    expect(fs.existsSync(path.join(home, '.local', 'state', 'swarmboard', 'global', 'board.db'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'swarmboard'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'swarmboard'))).toBe(false)

    // Original user entries preserved intact in MCP & instruction & shell configs
    const claudeCfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(claudeCfg.mcpServers['keep']).toEqual({ command: 'echo' })
    expect(claudeCfg.mcpServers['swarmboard']).toBeUndefined()

    const codexToml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    expect(codexToml).toContain('[mcp_servers.keep]')
    expect(codexToml).not.toContain('[mcp_servers.swarmboard]')

    const agentsMd = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')
    expect(agentsMd).toContain('Keep me.')
    expect(agentsMd).not.toContain('swarmboard:universal:start')
    expect(fs.readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8')).toBe('\n# Keep Claude rules\n\n\nTail rule\n')

    const zshenv = fs.readFileSync(path.join(home, '.zshenv'), 'utf8')
    expect(zshenv).toContain('export USER_KEEP=1')
    expect(zshenv).not.toContain('SWARMBOARD_DB')

    // 5. Uninstall with --purge-data deletes preserved state & config directories
    const purgeRes = spawnSync(process.execPath, [DIST_BIN, 'uninstall', '--purge-data', '--home', home, '--json'], {
      env,
      encoding: 'utf8',
    })
    expect(purgeRes.status, `purge stderr: ${purgeRes.stderr}`).toBe(0)
    const purgeJson = JSON.parse(purgeRes.stdout) as { ok: boolean; purgeData: boolean; preservedData: string[] }
    expect(purgeJson.ok).toBe(true)
    expect(purgeJson.purgeData).toBe(true)
    expect(purgeJson.preservedData).toEqual([])
    expect(fs.existsSync(path.join(home, '.local', 'state', 'swarmboard'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.config', 'swarmboard'))).toBe(false)
  }, 30_000)
})

describe('Standalone release package (`scripts/build-release.mjs`) & `install.sh` E2E', () => {
  it('builds verified standalone + npm release packages and installs/runs/uninstalls cleanly in an isolated temp directory', () => {
    const outDir = mkTmp('sb-release-out-')

    // 1. Build release artifacts (--skip-build since dist/ is already built)
    const buildRaw = execFileSync(
      process.execPath,
      [BUILD_RELEASE_SCRIPT, '--skip-build', '--out', outDir, '--json'],
      { encoding: 'utf8' },
    )
    const buildReport = JSON.parse(buildRaw) as {
      ok: boolean
      version: string
      runtimeDependencies: string[]
      artifacts: { kind: string; filename: string; path: string; bytes: number; sha256: string }[]
      checksumsPath: string
    }
    expect(buildReport.ok).toBe(true)
    expect(buildReport.version).toBe(PKG_VERSION)
    expect(buildReport.runtimeDependencies).toEqual(['jose', 'zod'])
    expect(buildReport.artifacts).toHaveLength(2)

    const standalone = buildReport.artifacts.find((a) => a.kind === 'standalone')!
    const npmPkg = buildReport.artifacts.find((a) => a.kind === 'npm')!
    expect(standalone.filename).toBe(`swarmboard-v${PKG_VERSION}.tar.gz`)
    expect(npmPkg.filename).toBe(`swarmboard-${PKG_VERSION}.tgz`)

    // Verify SHA256SUMS.txt matches actual file hashes
    const sumsText = fs.readFileSync(buildReport.checksumsPath, 'utf8')
    for (const art of buildReport.artifacts) {
      const actual = createHash('sha256').update(fs.readFileSync(art.path)).digest('hex')
      expect(actual).toBe(art.sha256)
      expect(sumsText).toContain(`${art.sha256}  ${art.filename}`)
    }

    // Verify npm tarball respects package.json "files" whitelist (zero src/, tests/, scripts/)
    const npmEntries = execFileSync('tar', ['-tzf', npmPkg.path], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    expect(npmEntries).toContain('package/package.json')
    expect(npmEntries).toContain('package/dist/bin/swarmboard.mjs')
    expect(npmEntries).toContain('package/docs/skill/SKILL.md')
    expect(npmEntries.some((e) => e.startsWith('package/src/'))).toBe(false)
    expect(npmEntries.some((e) => e.startsWith('package/tests/'))).toBe(false)
    expect(npmEntries.some((e) => e.startsWith('package/scripts/'))).toBe(false)

    // 2. Run install.sh --tarball into completely isolated /tmp directories (outside repo, zero external node_modules!)
    const home = mkTmp('sb-clean-install-home-')
    fs.mkdirSync(path.join(home, '.gemini/config'), { recursive: true })
    const appDir = path.join(mkTmp('sb-standalone-app-'), 'app')
    const binDir = mkTmp('sb-standalone-bin-')
    const env = cleanEnv(home)

    const instRes = spawnSync(
      'sh',
      [INSTALL_SH, '--tarball', standalone.path, '--home', home, '--dir', appDir, '--bin-dir', binDir],
      { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 30_000 },
    )
    expect(instRes.status, `install.sh stderr: ${instRes.stderr}\nstdout: ${instRes.stdout}`).toBe(0)
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(fs.readFileSync(path.join(home, name), 'utf8'), name).toContain('Collaborate throughout implementation')
    }
    const agyRules = fs.readFileSync(path.join(home, '.gemini/GEMINI.md'), 'utf8')
    const agySkill = fs.readFileSync(path.join(home, '.gemini/config/skills/swarmboard/SKILL.md'), 'utf8')
    for (const mode of ['/swarm', '/teamwork', '/boost']) {
      expect(agyRules).toContain(mode)
      expect(agySkill).toContain(mode)
    }
    const agyMcpPath = path.join(home, '.gemini/config/mcp_config.json')
    const agyMcp = JSON.parse(fs.readFileSync(agyMcpPath, 'utf8')).mcpServers.swarmboard
    expect(agyMcp.command).toBe(path.join(binDir, 'swarmboard-mcp'))
    expect(agyMcp.env.SWARMBOARD_AGENT).toBe('agy')
    expect(fs.existsSync(path.join(appDir, 'node_modules', 'jose', 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(appDir, 'node_modules', 'zod', 'package.json'))).toBe(true)

    const cliBin = path.join(binDir, 'swarmboard')
    const mcpBin = path.join(binDir, 'swarmboard-mcp')
    const daemonBin = path.join(binDir, 'swarmboard-daemon')

    // 3. Execute installed standalone binaries from /tmp with zero access to repo node_modules
    expect(execFileSync(cliBin, ['--version'], { cwd: os.tmpdir(), env, encoding: 'utf8' })).toContain(PKG_VERSION)
    const mcpVer = spawnSync(mcpBin, ['--version'], { cwd: os.tmpdir(), env, encoding: 'utf8' })
    expect(mcpVer.status).toBe(0)
    expect(mcpVer.stderr).toContain(PKG_VERSION)
    expect(execFileSync(daemonBin, ['--version'], { cwd: os.tmpdir(), env, encoding: 'utf8' })).toContain(PKG_VERSION)

    // Run doctor, post with @mention, and verify inbox across agents!
    const doctorOut = JSON.parse(
      execFileSync(cliBin, ['doctor', '--json'], { cwd: os.tmpdir(), env, encoding: 'utf8' }),
    ) as { ok: boolean; board: { schemaVersion: number } }
    expect(doctorOut.ok).toBe(true)
    expect(doctorOut.board.schemaVersion).toBe(5)

    const postOut = JSON.parse(
      execFileSync(cliBin, ['post', 'general', 'hello @codex from standalone release', '--as', 'claude', '--json'], {
        cwd: os.tmpdir(),
        env,
        encoding: 'utf8',
      }),
    ) as { id: string }
    expect(Number(postOut.id)).toBeGreaterThan(0)

    const inboxOut = JSON.parse(
      execFileSync(cliBin, ['inbox', '--as', 'codex', '--json'], { cwd: os.tmpdir(), env, encoding: 'utf8' }),
    ) as { unreadNotifications: number }
    expect(inboxOut.unreadNotifications).toBeGreaterThanOrEqual(1)

    // 4. Uninstall via install.sh --uninstall (preserves DB by default, removes appDir & symlinks)
    const uninstRes = spawnSync(
      'sh',
      [INSTALL_SH, '--uninstall', '--home', home, '--dir', appDir, '--bin-dir', binDir],
      { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 30_000 },
    )
    expect(uninstRes.status, `uninstall stderr: ${uninstRes.stderr}`).toBe(0)
    expect(fs.existsSync(appDir)).toBe(false)
    expect(fs.existsSync(cliBin)).toBe(false)
    expect(fs.existsSync(path.join(home, '.local', 'state', 'swarmboard', 'global', 'board.db'))).toBe(true)

    // 5. Purge data via install.sh --uninstall --purge-data (direct fallback path when CLI already removed)
    const purgeRes = spawnSync(
      'sh',
      [INSTALL_SH, '--uninstall', '--purge-data', '--home', home, '--dir', appDir, '--bin-dir', binDir],
      { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 30_000 },
    )
    expect(purgeRes.status, `purge stderr: ${purgeRes.stderr}`).toBe(0)
    expect(fs.existsSync(path.join(home, '.local', 'state', 'swarmboard'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.config', 'swarmboard'))).toBe(false)
  }, 60_000)
})
