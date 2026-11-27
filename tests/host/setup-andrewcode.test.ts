// Verification of first-run AndrewCode setup & uninstall (`~/.andrewcode/mcp.json` creation
// when parent directory exists, AGENTS.md swarm mode instructions, skill symlink, and clean uninstall).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildUniversalInstructionBlock, runSetup, runUninstall } from '../../src/host/setup.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

function mkTmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

describe('AndrewCode first-run setup, universal instructions, and clean uninstall', () => {
  it('creates ~/.andrewcode/mcp.json when ~/.andrewcode/ exists without mcp.json, writes swarm-mode guidance, and uninstalls cleanly', () => {
    const home = mkTmp('sb-andrewcode-home-')
    const binDir = path.join(home, '.local', 'bin')
    const acDir = path.join(home, '.andrewcode')
    fs.mkdirSync(acDir, { recursive: true })

    // Confirm mcp.json does NOT exist prior to setup
    const acMcpPath = path.join(acDir, 'mcp.json')
    expect(fs.existsSync(acMcpPath)).toBe(false)

    // Run setup (skipInit=true so unit test stays fast and focused on config/MCP/skills/instructions)
    const report = runSetup({
      home,
      binDir,
      packageRoot: REPO_ROOT,
      skipInit: true,
      configureShell: false,
    })
    expect(report.ok).toBe(true)

    // 1. ~/.andrewcode/mcp.json created and verified with SWARMBOARD_AGENT=andrewcode
    expect(fs.existsSync(acMcpPath)).toBe(true)
    const mcpJson = JSON.parse(fs.readFileSync(acMcpPath, 'utf8')) as {
      mcpServers: {
        swarmboard?: {
          command: string
          env: { SWARMBOARD_AGENT: string; SWARMBOARD_HARNESS: string; SWARMBOARD_DB: string }
        }
      }
    }
    expect(mcpJson.mcpServers.swarmboard?.command).toBe(path.join(binDir, 'swarmboard-mcp'))
    expect(mcpJson.mcpServers.swarmboard?.env.SWARMBOARD_AGENT).toBe('andrewcode')
    expect(mcpJson.mcpServers.swarmboard?.env.SWARMBOARD_HARNESS).toBe('andrewcode')

    // 2. ~/.andrewcode/AGENTS.md created with AndrewCode swarm mode, Claude Octopus, Antigravity & Ultracode guidance
    const acAgentsPath = path.join(acDir, 'AGENTS.md')
    expect(fs.existsSync(acAgentsPath)).toBe(true)
    const agentsText = fs.readFileSync(acAgentsPath, 'utf8')
    expect(agentsText).toContain('AndrewCode swarm mode')
    expect(agentsText).toContain('AgentSwarm')
    expect(agentsText).toContain('/swarm fusion')
    expect(agentsText).toContain('Claude Octopus')
    expect(agentsText).toContain('Claude Code Ultracode, Codex Ultra')
    expect(agentsText).toContain('/run-workflow')

    // 3. Skill symlink installed for AndrewCode
    const acSkillLink = path.join(acDir, 'skills', 'swarmboard')
    expect(fs.lstatSync(acSkillLink).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(acSkillLink, 'SKILL.md'))).toBe(true)

    // 4. Idempotent rerun leaves MCP entry unchanged
    const rerun = runSetup({
      home,
      binDir,
      packageRoot: REPO_ROOT,
      skipInit: true,
      configureShell: false,
    })
    const acMcpEntry = rerun.mcp.find(m => m.harness === 'andrewcode')
    expect(acMcpEntry?.status).toBe('unchanged')

    // 5. Add a sibling MCP server, then run uninstall -> removes only swarmboard and preserves sibling
    const withSibling = JSON.parse(fs.readFileSync(acMcpPath, 'utf8')) as { mcpServers: Record<string, unknown> }
    withSibling.mcpServers['keep-other'] = { command: 'echo' }
    fs.writeFileSync(acMcpPath, `${JSON.stringify(withSibling, null, 2)}\n`, 'utf8')

    const uninstall = runUninstall({ home, binDir, packageRoot: REPO_ROOT })
    expect(uninstall.ok).toBe(true)
    const afterMcp = JSON.parse(fs.readFileSync(acMcpPath, 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(afterMcp.mcpServers['swarmboard']).toBeUndefined()
    expect(afterMcp.mcpServers['keep-other']).toEqual({ command: 'echo' })
    expect(fs.existsSync(acSkillLink)).toBe(false)
    expect(fs.readFileSync(acAgentsPath, 'utf8')).not.toContain('swarmboard:universal:start')
  })

  it('buildUniversalInstructionBlock preserves all cross-harness coordination invariants', () => {
    const block = buildUniversalInstructionBlock()
    for (const required of [
      'Collaborate throughout implementation',
      'Claude Code Ultracode, Codex Ultra',
      'board_post({ re: taskId',
      'AndrewCode swarm mode',
      'AgentSwarm',
      '/swarm fusion',
      'Claude Octopus',
      '/swarm',
      '/teamwork',
      '/boost',
      '/run-workflow',
    ]) {
      expect(block, `missing ${required}`).toContain(required)
    }
  })
})
