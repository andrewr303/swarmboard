// W4-B packaging, dist bundle verification, and isolated HOME rollout tests (Swarmboard v2 launch design §3.1, §6, V2-22).
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { parseUserConfig } from '../../src/client/config.ts'
import allowedCoreExports from '../core/host0/public-surface.allow.json' with { type: 'json' }

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const DIST_DIR = path.join(REPO_ROOT, 'dist')
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'install-local.mjs')

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

describe('W4-B packaging & dist bundles (V2-22)', () => {
  it('package.json declares all 3 bin entries, 3 exports, and build scripts cleanly', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      bin: Record<string, string>
      exports: Record<string, { types: string; default: string }>
      scripts: Record<string, string>
      dependencies: Record<string, string>
    }
    expect(pkg.bin).toEqual({
      swarmboard: './dist/bin/swarmboard.mjs',
      'swarmboard-mcp': './dist/bin/swarmboard-mcp.mjs',
      'swarmboard-daemon': './dist/bin/swarmboard-daemon.mjs',
    })
    expect(pkg.exports).toEqual({
      './core': { types: './dist/core.d.mts', default: './dist/core.mjs' },
      './client': { types: './dist/client.d.mts', default: './dist/client.mjs' },
      './host': { types: './dist/host.d.mts', default: './dist/host.mjs' },
    })
    expect(pkg.scripts['build:ui']).toBe('node scripts/build-ui.mjs')
    expect(pkg.scripts['build']).toContain('scripts/build-ui.mjs')
    expect(pkg.scripts['build']).toContain('tsdown')
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['jose', 'zod'])
  })

  it('dist/ contains all 6 bundles + .d.mts files, exact 342/342 core exports, and 0 core/zod imports in client.mjs', async () => {
    const expectedFiles = [
      'core.mjs',
      'core.d.mts',
      'client.mjs',
      'client.d.mts',
      'host.mjs',
      'host.d.mts',
      'bin/swarmboard.mjs',
      'bin/swarmboard-mcp.mjs',
      'bin/swarmboard-daemon.mjs',
    ]
    for (const rel of expectedFiles) {
      const full = path.join(DIST_DIR, rel)
      expect(fs.existsSync(full), `missing ${rel} — run pnpm build`).toBe(true)
      expect(fs.statSync(full).size, `${rel} empty`).toBeGreaterThan(0)
    }

    // 1. dist/core.mjs exact 342/342 exports matching public-surface.allow.json
    const coreMod = (await import(pathToFileURL(path.join(DIST_DIR, 'core.mjs')).href)) as Record<string, unknown>
    const coreKeys = Object.keys(coreMod).sort()
    expect(coreKeys).toEqual([...allowedCoreExports].sort())
    expect(coreKeys).toHaveLength(342)

    // 2. dist/client.mjs has zero runtime imports of core or zod
    const clientSrc = fs.readFileSync(path.join(DIST_DIR, 'client.mjs'), 'utf8')
    const importSpecifiers = [...clientSrc.matchAll(/^(?:import|export)\s.*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1]!,
    )
    for (const spec of importSpecifiers) {
      expect(spec, `dist/client.mjs must not import core or zod (got ${spec})`).not.toMatch(/zod|\/core\b|core\.mjs/)
    }
    const clientMod = (await import(pathToFileURL(path.join(DIST_DIR, 'client.mjs')).href)) as Record<string, unknown>
    expect(typeof clientMod['createBoardClient']).toBe('function')
    expect(Array.isArray(clientMod['OP_NAMES'])).toBe(true)
    expect((clientMod['OP_NAMES'] as unknown[]).length).toBe(84)

    // 3. dist/host.mjs exports connect() and never leaks src/core/internal.ts symbols
    const hostMod = (await import(pathToFileURL(path.join(DIST_DIR, 'host.mjs')).href)) as Record<string, unknown>
    expect(typeof hostMod['connect']).toBe('function')
    expect(typeof hostMod['ensureDaemon']).toBe('function')
    for (const secret of ['TRANSPORT_ALLOW', 'createSystemCaller', 'M1_SCHEMA_SQL', 'V2_LAUNCH_SCHEMA_SQL']) {
      expect(secret in hostMod, `dist/host.mjs leaked internal symbol ${secret}`).toBe(false)
    }
  })

  it('all 3 dist/bin/*.mjs scripts have single shebang, mode 0755, and execute --help / --version cleanly (also via symlink)', () => {
    const bins = [
      { name: 'swarmboard', versionOn: 'stdout' as const, expectVersion: /swarmboard \d+\.\d+\.\d+/ },
      { name: 'swarmboard-mcp', versionOn: 'stderr' as const, expectVersion: /\d+\.\d+\.\d+/ },
      { name: 'swarmboard-daemon', versionOn: 'stdout' as const, expectVersion: /swarmboard-daemon \d+\.\d+\.\d+/ },
    ]
    const linkDir = mkTmp('cb-bin-links-')

    for (const bin of bins) {
      const full = path.join(DIST_DIR, 'bin', `${bin.name}.mjs`)
      const raw = fs.readFileSync(full, 'utf8')
      const lines = raw.split('\n')
      expect(lines[0], `${bin.name} shebang`).toBe('#!/usr/bin/env node')
      expect(lines[1]?.startsWith('#!'), `${bin.name} duplicate shebang`).toBe(false)
      if (process.platform !== 'win32') {
        expect(fs.statSync(full).mode & 0o111, `${bin.name} executable bit`).toBeGreaterThan(0)
      }

      // Direct execution + symlink execution (matching ~/.local/bin/<name>)
      const sym = path.join(linkDir, bin.name)
      fs.symlinkSync(full, sym)

      for (const exe of [full, sym]) {
        const ver = spawnSync(exe, ['--version'], { encoding: 'utf8' })
        expect(ver.status, `${exe} --version exit`).toBe(0)
        const verOut = bin.versionOn === 'stdout' ? ver.stdout : ver.stderr
        expect(verOut, `${exe} --version output`).toMatch(bin.expectVersion)

        const help = spawnSync(exe, ['--help'], { encoding: 'utf8' })
        expect(help.status, `${exe} --help exit`).toBe(0)
        const helpOut = bin.versionOn === 'stdout' ? help.stdout : help.stderr
        expect(helpOut, `${exe} --help output`).toContain(bin.name)
      }
    }
  })

  it('canonical docs/skill/SKILL.md and JOIN.md exist and document required workflows', () => {
    const skill = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'skill', 'SKILL.md'), 'utf8')
    expect(skill).toMatch(/^---\nname: swarmboard\n/)
    expect(skill).toContain('swarmboard-mcp')
    expect(skill).toContain('board_inbox')
    expect(skill).toContain('board_wait')
    expect(skill).toContain('meta/feedback')
    expect(skill).toContain('board_feedback')
    expect(skill).toContain('board-feedback@1')
    expect(skill).toContain('repos/<repo>')
    expect(skill).toContain('swarms/<id>')

    const join = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'skill', 'JOIN.md'), 'utf8')
    expect(join).toContain('board_inbox')
    expect(join).toContain('board_feedback')
    expect(join).toContain('meta/feedback')
  })

  it('PKG-F1 regression: standalone compiled dist/bin/swarmboard.mjs daemon start/stop prints valid JSON, releases start.lock, and stops PID cleanly', async () => {
    const workDir = mkTmp('cb-daemon-e2e-')
    const fakeHome = path.join(workDir, 'home')
    fs.mkdirSync(fakeHome, { recursive: true })
    const dbPath = path.join(workDir, 'board.db')
    const swarmboardBin = path.join(DIST_DIR, 'bin', 'swarmboard.mjs')
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fakeHome,
    }
    delete childEnv['SWARMBOARD_DB']
    delete childEnv['SWARMBOARD_AGENT']
    delete childEnv['BOARD_PROFILE']
    delete childEnv['SWARMBOARD_TOKEN']
    delete childEnv['BOARD_TOKEN']

    // Init DB first so daemon starts against a valid v5 board
    const initRes = spawnSync(swarmboardBin, ['init', '--db', dbPath, '--json'], {
      env: childEnv,
      encoding: 'utf8',
    })
    expect(initRes.status, `init stderr: ${initRes.stderr}`).toBe(0)
    expect(JSON.parse(initRes.stdout).ok).toBe(true)

    const freePort = await new Promise<number>((resolvePort, rejectPort) => {
      const srv = net.createServer()
      srv.once('error', rejectPort)
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const p = typeof addr === 'object' && addr !== null ? addr.port : 0
        srv.close(() => resolvePort(p))
      })
    })
    expect(freePort).toBeGreaterThan(0)

    let startedPid: number | null = null
    try {
      // Spawn real standalone compiled CLI process (`daemon start --tcp --port <p> --json`)
      const startRes = spawnSync(
        swarmboardBin,
        ['daemon', 'start', '--db', dbPath, '--tcp', '--port', String(freePort), '--json'],
        {
          env: childEnv,
          encoding: 'utf8',
          timeout: 15_000,
        },
      )
      expect(startRes.status, `daemon start stderr: ${startRes.stderr}`).toBe(0)
      expect(startRes.stdout.trim().length, 'daemon start stdout must not be empty').toBeGreaterThan(0)
      const started = JSON.parse(startRes.stdout) as {
        ok: boolean
        action: string
        status: { running: boolean; pid: number | null; socketPath: string | null; tcpUrl: string | null }
      }
      expect(started.ok).toBe(true)
      expect(started.action).toBe('start')
      expect(started.status.running).toBe(true)
      expect(typeof started.status.pid).toBe('number')
      expect(started.status.socketPath).toBeTruthy()
      expect(started.status.tcpUrl).toBe(`http://127.0.0.1:${freePort}`)
      startedPid = started.status.pid

      // Verify start.lock was cleanly released in runDir (no leaked lock from premature exit)
      const runDir = path.dirname(started.status.socketPath!)
      expect(fs.existsSync(path.join(runDir, 'start.lock'))).toBe(false)
      expect(fs.existsSync(path.join(runDir, 'endpoint.json'))).toBe(true)

      // Verify daemon stop prints valid JSON and terminates the daemon PID cleanly
      const stopRes = spawnSync(swarmboardBin, ['daemon', 'stop', '--db', dbPath, '--json'], {
        env: childEnv,
        encoding: 'utf8',
        timeout: 15_000,
      })
      expect(stopRes.status, `daemon stop stderr: ${stopRes.stderr}`).toBe(0)
      expect(stopRes.stdout.trim().length, 'daemon stop stdout must not be empty').toBeGreaterThan(0)
      const stopped = JSON.parse(stopRes.stdout) as {
        ok: boolean
        action: string
        status: { running: boolean; pid: number | null }
      }
      expect(stopped.ok).toBe(true)
      expect(stopped.action).toBe('stop')
      expect(stopped.status.running).toBe(false)

      // Verify PID is actually gone
      let alive = true
      try {
        process.kill(startedPid!, 0)
      } catch {
        alive = false
      }
      expect(alive).toBe(false)
      startedPid = null
    } finally {
      if (startedPid !== null) {
        try {
          process.kill(startedPid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  }, 30_000)
})

describe('W4-B scripts/install-local.mjs (--dry-run + isolated HOME end-to-end)', () => {
  function seedFakeHome(): string {
    const home = mkTmp('cb-home-')
    const write = (rel: string, content: string, mode = 0o644) => {
      const full = path.join(home, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content, { encoding: 'utf8', mode })
      fs.chmodSync(full, mode)
    }

    write('.zshenv', 'export EXISTING_VAR=hello\n')
    write('AGENTS.md', '# Global Agents\n\nExisting user rule.\n')
    write('CLAUDE.md', '# Global Claude\n')
    write('.claude/CLAUDE.md', '# Claude Dir Rules\n')
    write('.claude.json', JSON.stringify({ numStartups: 5, mcpServers: { existing: { command: 'echo' } } }, null, 2), 0o600)
    write(
      '.codex/config.toml',
      'model = "gpt-5"\n\n[mcp_servers.deja]\ncommand = "/usr/bin/env"\nargs = ["deja"]\n',
      0o600,
    )
    write('.codex/AGENTS.md', '# Codex Rules\n')
    write('.gemini/GEMINI.md', '# Gemini Rules\n')
    write('.gemini/config/mcp_config.json', JSON.stringify({ mcpServers: { deja: { command: 'deja' } } }, null, 2))
    write('.gemini/antigravity/mcp_config.json', JSON.stringify({ mcpServers: { pencil: { command: 'pen' } } }, null, 2))
    write('.gemini/antigravity-ide/mcp_config.json', JSON.stringify({ mcpServers: { pencil: { command: 'pen' } } }, null, 2))
    write('.gemini/settings.json', JSON.stringify({ mcpServers: { aws: { command: 'uvx' } }, hooksConfig: {} }, null, 2))
    write(
      '.config/opencode/opencode.json',
      JSON.stringify({ mcp: { existing: { type: 'local', command: ['foo'] } } }, null, 2),
    )
    write('.config/opencode/AGENTS.md', '# OpenCode Rules\n')
    write('.copilot/mcp-config.json', JSON.stringify({ mcpServers: { deja: { type: 'local', command: 'deja', args: [], tools: ['*'] } } }, null, 2), 0o600)
    write('.copilot/copilot-instructions.md', '# Copilot Rules\n')
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { other: { url: 'http://127.0.0.1:9010/mcp' } } }, null, 2))
    write('.pi/agent/mcp.json', JSON.stringify({ mcpServers: { deja: { command: 'deja', args: ['mcp'] } } }, null, 2), 0o600)
    write('.andrewcode/mcp.json', JSON.stringify({ mcpServers: { deja: { command: 'deja', args: ['mcp'] } } }, null, 2))
    // Seed a legacy canonical skill directory to verify REN-F3 cleanup
    const legacySlug = ['corp', 'board'].join('')
    write(`.agents/skills/${legacySlug}/SKILL.md`, '# Legacy skill\n')
    return home
  }

  it('--dry-run inspects and plans without mutating any files', () => {
    const home = seedFakeHome()
    const legacySlug = ['corp', 'board'].join('')
    const beforeClaude = fs.readFileSync(path.join(home, '.claude.json'), 'utf8')
    const out = execFileSync(process.execPath, [INSTALL_SCRIPT, '--dry-run', '--home', home, '--json'], {
      encoding: 'utf8',
    })
    const report = JSON.parse(out)
    expect(report.ok).toBe(true)
    expect(report.dryRun).toBe(true)
    expect(report.bins).toHaveLength(3)
    expect(fs.existsSync(path.join(home, '.config', 'swarmboard', 'config.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'swarmboard'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.agents', 'skills', legacySlug, 'SKILL.md'))).toBe(true)
    expect(report.legacyCleanup).toContainEqual({
      kind: 'skill-canonical',
      target: path.join(home, '.agents', 'skills', legacySlug),
      status: 'would-remove',
    })
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe(beforeClaude)
    expect(fs.existsSync(path.join(home, '.claude.json.bak.swarmboard'))).toBe(false)
  })

  it('installs end-to-end into an isolated HOME, initializes universal board, validates configs, and is 100% idempotent on rerun', () => {
    const home = seedFakeHome()

    // First run (full live install into isolated HOME)
    const run1Raw = execFileSync(process.execPath, [INSTALL_SCRIPT, '--home', home, '--json'], {
      encoding: 'utf8',
    })
    const run1 = JSON.parse(run1Raw)
    expect(run1.ok).toBe(true)
    expect(run1.globalBoard.doctorOk).toBe(true)
    expect(run1.globalBoard.schemaVersion).toBe(5)
    expect(run1.globalBoard.schemaId).toBe('board-feedback@1')
    expect(run1.globalBoard.channelsCreated).toBe(6)
    expect(run1.globalBoard.groupsCreated).toBe(10)

    // Global config parses with parseUserConfig (0 warnings!) and resolves global -> mode: 'daemon'
    const cfgPath = path.join(home, '.config', 'swarmboard', 'config.json')
    expect(fs.statSync(cfgPath).mode & 0o777).toBe(0o600)
    const parsedCfg = parseUserConfig(fs.readFileSync(cfgPath, 'utf8'), cfgPath, home)
    expect(parsedCfg.warnings).toEqual([])
    expect(parsedCfg.value.default).toBe('global')
    expect(parsedCfg.value.boards?.['global']).toEqual({
      db: path.join(home, '.local', 'state', 'swarmboard', 'global', 'board.db'),
      mode: 'daemon',
    })

    // All 3 bin symlinks resolve cleanly
    for (const name of ['swarmboard', 'swarmboard-mcp', 'swarmboard-daemon']) {
      const link = path.join(home, '.local', 'bin', name)
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
      expect(fs.realpathSync(link)).toBe(path.join(DIST_DIR, 'bin', `${name}.mjs`))
    }

    // Backups created once and original entries preserved across all harness MCP configs
    expect(fs.existsSync(path.join(home, '.claude.json.bak.swarmboard'))).toBe(true)
    const claudeCfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))
    expect(claudeCfg.numStartups).toBe(5)
    expect(claudeCfg.mcpServers.existing).toEqual({ command: 'echo' })
    expect(claudeCfg.mcpServers.swarmboard.command).toBe(path.join(home, '.local', 'bin', 'swarmboard-mcp'))
    expect(claudeCfg.mcpServers.swarmboard.env.SWARMBOARD_AGENT).toBe('claude')

    const opencodeCfg = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'))
    expect(opencodeCfg.mcp.existing).toEqual({ type: 'local', command: ['foo'] })
    expect(opencodeCfg.mcp.swarmboard.type).toBe('local')
    expect(opencodeCfg.mcp.swarmboard.command).toEqual([path.join(home, '.local', 'bin', 'swarmboard-mcp')])
    expect(opencodeCfg.mcp.swarmboard.environment.SWARMBOARD_AGENT).toBe('opencode')
    expect(opencodeCfg.mcp.swarmboard.enabled).toBe(true)

    const copilotCfg = JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'mcp-config.json'), 'utf8'))
    expect(copilotCfg.mcpServers.swarmboard.tools).toEqual(['*'])
    expect(copilotCfg.mcpServers.swarmboard.type).toBe('local')

    const codexToml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    expect(codexToml).toContain('model = "gpt-5"')
    expect(codexToml).toContain('[mcp_servers.deja]')
    expect(codexToml).toContain('[mcp_servers.swarmboard]')
    expect(codexToml).toContain('SWARMBOARD_AGENT = "codex"')

    // Harness skills resolve to the canonical skill, including Antigravity CLI global discovery.
    const legacySlug = ['corp', 'board'].join('')
    expect(fs.existsSync(path.join(home, '.agents', 'skills', legacySlug))).toBe(false)
    expect(run1.legacyCleanup).toContainEqual({
      kind: 'skill-canonical',
      target: path.join(home, '.agents', 'skills', legacySlug),
      status: 'removed',
    })
    const expectedSkill = fs.realpathSync(path.join(home, '.agents', 'skills', 'swarmboard', 'SKILL.md'))
    for (const rel of [
      '.claude/skills/swarmboard',
      '.codex/skills/swarmboard',
      '.gemini/skills/swarmboard',
      '.gemini/config/skills/swarmboard',
      '.cursor/skills/swarmboard',
      '.config/opencode/skills/swarmboard',
      '.copilot/skills/swarmboard',
      '.pi/agent/skills/swarmboard',
      '.andrewcode/skills/swarmboard',
    ]) {
      const skillMd = path.join(home, rel, 'SKILL.md')
      expect(fs.realpathSync(skillMd), rel).toBe(expectedSkill)
    }

    // Instructions preserved verbatim + marked block appended across all global & harness instruction files
    const agentsMd = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')
    expect(agentsMd).toContain('Existing user rule.')
    expect(agentsMd).toContain('<!-- swarmboard:universal:start -->')
    expect(agentsMd).toContain('<!-- swarmboard:universal:end -->')
    expect(agentsMd).toContain('MUST use Swarmboard')

    const piAgentsMd = fs.readFileSync(path.join(home, '.pi', 'agent', 'AGENTS.md'), 'utf8')
    expect(piAgentsMd).toContain('<!-- swarmboard:universal:start -->')
    const andrewcodeAgentsMd = fs.readFileSync(path.join(home, '.andrewcode', 'AGENTS.md'), 'utf8')
    expect(andrewcodeAgentsMd).toContain('<!-- swarmboard:universal:start -->')

    // .zshenv preserved + SWARMBOARD_DB exported
    const zshenv = fs.readFileSync(path.join(home, '.zshenv'), 'utf8')
    expect(zshenv).toContain('export EXISTING_VAR=hello')
    expect(zshenv).toContain(`export SWARMBOARD_DB=${JSON.stringify(path.join(home, '.local', 'state', 'swarmboard', 'global', 'board.db'))}`)

    // Second run MUST be 100% idempotent (0 new backups, all configs/files unchanged, 0 duplicate channels/groups)
    const run2Raw = execFileSync(process.execPath, [INSTALL_SCRIPT, '--home', home, '--json'], {
      encoding: 'utf8',
    })
    const run2 = JSON.parse(run2Raw)
    expect(run2.ok).toBe(true)
    expect(run2.backups).toEqual([])
    expect(run2.legacyCleanup).toEqual([])
    expect(run2.config.status).toBe('unchanged')
    expect(run2.zshenv.status).toBe('unchanged')
    expect(run2.globalBoard.channelsCreated).toBe(0)
    expect(run2.globalBoard.groupsCreated).toBe(0)
    for (const b of run2.bins) expect(b.status).toBe('unchanged')
    for (const m of run2.mcp) expect(m.status).toBe('unchanged')
    for (const s of run2.skills.symlinks) expect(s.status).toBe('unchanged')
    for (const i of run2.instructions) {
      if (i.status !== 'skipped-absent') expect(i.status).toBe('unchanged')
    }
  }, 30_000)
})
