#!/usr/bin/env node
// Idempotent local installer & universal multi-harness rollout for Swarmboard.
// Thin wrapper around the built-in `swarmboard setup` engine (`dist/host.mjs`) that also
// enables legacy pre-rename cleanup during upgrades from older local checkouts.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

// Intentional legacy migration key for cleanly removing pre-rename entries during upgrade.
const LEGACY_SLUG = 'corpboard'

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    json: false,
    skipInit: false,
    help: false,
    home: process.env.HOME?.trim() || os.homedir(),
    repoRoot: DEFAULT_REPO_ROOT,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--skip-init') opts.skipInit = true
    else if (arg === '-h' || arg === '--help') opts.help = true
    else if (arg === '--home') {
      const v = argv[++i]
      if (!v) throw new Error('--home requires a directory path')
      opts.home = path.resolve(v)
    } else if (arg.startsWith('--home=')) {
      opts.home = path.resolve(arg.slice('--home='.length))
    } else if (arg === '--repo-root') {
      const v = argv[++i]
      if (!v) throw new Error('--repo-root requires a directory path')
      opts.repoRoot = path.resolve(v)
    } else if (arg.startsWith('--repo-root=')) {
      opts.repoRoot = path.resolve(arg.slice('--repo-root='.length))
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return opts
}

function usage() {
  return `Usage: node scripts/install-local.mjs [--dry-run] [--home <dir>] [--repo-root <dir>] [--skip-init] [--json]

Idempotently installs Swarmboard CLI/MCP/daemon binaries, global config, universal board seed,
canonical skill + harness symlinks, MCP configs across installed harnesses, and global agent instructions.
(Equivalent to \`swarmboard setup\`, plus legacy pre-rename migration cleanup.)
`
}

export async function runInstall(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    process.stdout.write(usage())
    return { help: true }
  }

  const hostBundle = path.join(opts.repoRoot, 'dist', 'host.mjs')
  if (!fs.existsSync(hostBundle)) {
    throw new Error(`missing built bundle ${hostBundle} — run "pnpm build" first`)
  }

  const { runSetup, formatSetupReport } = await import(pathToFileURL(hostBundle).href)
  const report = runSetup({
    dryRun: opts.dryRun,
    skipInit: opts.skipInit,
    home: opts.home,
    packageRoot: opts.repoRoot,
    legacySlug: LEGACY_SLUG,
  })

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(formatSetupReport(report))
  }

  return report
}

const isEntry = (() => {
  try {
    if (!process.argv[1]) return false
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntry) {
  runInstall(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[install-local] error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
