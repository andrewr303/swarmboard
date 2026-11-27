#!/usr/bin/env node
// Build self-contained Swarmboard release artifacts:
//   1. release/swarmboard-v<version>.tar.gz  (standalone runtime bundle — needs ONLY Node.js >= 22.18)
//   2. release/swarmboard-<version>.tgz      (clean npm package tarball via `npm pack`)
//   3. release/SHA256SUMS.txt                (SHA-256 checksums for all generated archives)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

const REQUIRED_DIST_FILES = Object.freeze([
  'core.mjs',
  'core.d.mts',
  'client.mjs',
  'client.d.mts',
  'host.mjs',
  'host.d.mts',
  'bin/swarmboard.mjs',
  'bin/swarmboard-mcp.mjs',
  'bin/swarmboard-daemon.mjs',
])

const REQUIRED_SKILL_FILES = Object.freeze(['SKILL.md', 'JOIN.md'])

function parseArgs(argv) {
  const opts = {
    outDir: path.join(REPO_ROOT, 'release'),
    skipBuild: false,
    skipNpmPack: false,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--skip-build') opts.skipBuild = true
    else if (arg === '--skip-npm-pack') opts.skipNpmPack = true
    else if (arg === '--json') opts.json = true
    else if (arg === '-h' || arg === '--help') opts.help = true
    else if (arg === '--out') {
      const v = argv[++i]
      if (!v) throw new Error('--out requires a directory path')
      opts.outDir = path.resolve(v)
    } else if (arg.startsWith('--out=')) {
      opts.outDir = path.resolve(arg.slice('--out='.length))
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return opts
}

function usage() {
  return `Usage: node scripts/build-release.mjs [--out <dir>] [--skip-build] [--skip-npm-pack] [--json]

Creates self-contained release archives in release/ (or --out):
  - swarmboard-v<version>.tar.gz  (standalone package with pruned runtime deps; needs only Node >= 22.18)
  - swarmboard-<version>.tgz      (clean npm package tarball from package.json "files" whitelist)
  - SHA256SUMS.txt                (SHA-256 checksums for verification)
`
}

function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function buildRuntimePackageJson(pkg) {
  return {
    name: pkg.name,
    version: pkg.version,
    private: false,
    type: pkg.type,
    description: pkg.description,
    license: pkg.license,
    repository: pkg.repository,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    keywords: pkg.keywords,
    engines: pkg.engines,
    bin: pkg.bin,
    exports: pkg.exports,
    dependencies: pkg.dependencies,
  }
}

export function buildRelease(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    process.stdout.write(usage())
    return { help: true }
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  const version = pkg.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`invalid package.json version: ${String(version)}`)
  }

  if (!opts.skipBuild) {
    execFileSync('pnpm', ['build'], {
      cwd: REPO_ROOT,
      stdio: opts.json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
  }

  // Verify required built artifacts and docs exist before staging
  for (const rel of REQUIRED_DIST_FILES) {
    const full = path.join(REPO_ROOT, 'dist', rel)
    if (!fs.existsSync(full)) {
      throw new Error(`missing required dist file: ${full} (run "pnpm build" first)`)
    }
  }
  for (const fname of REQUIRED_SKILL_FILES) {
    const full = path.join(REPO_ROOT, 'docs', 'skill', fname)
    if (!fs.existsSync(full)) {
      throw new Error(`missing required skill file: ${full}`)
    }
  }
  for (const rootFile of ['README.md', 'LICENSE']) {
    const full = path.join(REPO_ROOT, rootFile)
    if (!fs.existsSync(full)) {
      throw new Error(`missing required root file: ${full}`)
    }
  }

  const runtimeDeps = Object.keys(pkg.dependencies ?? {}).sort()
  for (const dep of runtimeDeps) {
    const depDir = path.join(REPO_ROOT, 'node_modules', dep)
    const depPkgPath = path.join(depDir, 'package.json')
    if (!fs.existsSync(depPkgPath)) {
      throw new Error(`missing runtime dependency ${dep} in node_modules (run "pnpm install")`)
    }
    const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8'))
    const transitive = Object.keys(depPkg.dependencies ?? {})
    if (transitive.length > 0) {
      throw new Error(
        `runtime dependency "${dep}" declares transitive dependencies (${transitive.join(', ')}); update scripts/build-release.mjs to vendor transitive deps`,
      )
    }
  }

  fs.mkdirSync(opts.outDir, { recursive: true })

  const tarEnv = {
    ...process.env,
    // Prevent macOS tar from emitting AppleDouble ._ metadata files into release archives.
    COPYFILE_DISABLE: '1',
    COPY_EXTENDED_ATTRIBUTES_DISABLE: '1',
  }

  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmboard-release-'))
  const bundleFolderName = `swarmboard-v${version}`
  const stageDir = path.join(stageParent, bundleFolderName)
  const standaloneFilename = `${bundleFolderName}.tar.gz`
  const standalonePath = path.join(opts.outDir, standaloneFilename)

  const artifacts = []

  try {
    fs.mkdirSync(path.join(stageDir, 'docs', 'skill'), { recursive: true })
    fs.mkdirSync(path.join(stageDir, 'node_modules'), { recursive: true })

    // 1. Clean runtime package.json + root docs
    fs.writeFileSync(
      path.join(stageDir, 'package.json'),
      `${JSON.stringify(buildRuntimePackageJson(pkg), null, 2)}\n`,
      { encoding: 'utf8', mode: 0o644 },
    )
    fs.copyFileSync(path.join(REPO_ROOT, 'README.md'), path.join(stageDir, 'README.md'))
    fs.copyFileSync(path.join(REPO_ROOT, 'LICENSE'), path.join(stageDir, 'LICENSE'))

    // 2. Compiled dist/ (preserve executable bit on bin/*.mjs)
    fs.cpSync(path.join(REPO_ROOT, 'dist'), path.join(stageDir, 'dist'), {
      recursive: true,
      dereference: true,
    })
    for (const binName of ['swarmboard.mjs', 'swarmboard-mcp.mjs', 'swarmboard-daemon.mjs']) {
      fs.chmodSync(path.join(stageDir, 'dist', 'bin', binName), 0o755)
    }

    // 3. Canonical agent skills
    for (const fname of REQUIRED_SKILL_FILES) {
      fs.copyFileSync(path.join(REPO_ROOT, 'docs', 'skill', fname), path.join(stageDir, 'docs', 'skill', fname))
    }

    // 4. Dereferenced runtime dependencies (jose, zod — zero transitive deps)
    for (const dep of runtimeDeps) {
      const srcReal = fs.realpathSync(path.join(REPO_ROOT, 'node_modules', dep))
      const dstDep = path.join(stageDir, 'node_modules', dep)
      fs.cpSync(srcReal, dstDep, {
        recursive: true,
        dereference: true,
        filter: (src) => {
          const base = path.basename(src)
          return base !== '.DS_Store' && !base.startsWith('._')
        },
      })
    }

    // 5. Pack standalone tarball
    if (fs.existsSync(standalonePath)) fs.unlinkSync(standalonePath)
    execFileSync('tar', ['-czf', standalonePath, '-C', stageParent, bundleFolderName], {
      env: tarEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Sanity-check tarball contents (no macOS ._ files, includes dist/bin/swarmboard.mjs + runtime deps)
    const standaloneEntries = execFileSync('tar', ['-tzf', standalonePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .filter(Boolean)
    if (standaloneEntries.some((e) => path.basename(e).startsWith('._'))) {
      throw new Error(`standalone tarball contains AppleDouble metadata files`)
    }
    for (const mustHave of [
      `${bundleFolderName}/package.json`,
      `${bundleFolderName}/dist/bin/swarmboard.mjs`,
      `${bundleFolderName}/dist/bin/swarmboard-mcp.mjs`,
      `${bundleFolderName}/dist/bin/swarmboard-daemon.mjs`,
      `${bundleFolderName}/docs/skill/SKILL.md`,
      ...runtimeDeps.map((d) => `${bundleFolderName}/node_modules/${d}/package.json`),
    ]) {
      if (!standaloneEntries.includes(mustHave)) {
        throw new Error(`standalone tarball missing expected entry: ${mustHave}`)
      }
    }

    artifacts.push({
      kind: 'standalone',
      filename: standaloneFilename,
      path: standalonePath,
      bytes: fs.statSync(standalonePath).size,
      sha256: sha256File(standalonePath),
      entryCount: standaloneEntries.length,
    })

    // 6. Pack clean npm tarball via `npm pack`
    if (!opts.skipNpmPack) {
      const npmFilename = `swarmboard-${version}.tgz`
      const npmPath = path.join(opts.outDir, npmFilename)
      if (fs.existsSync(npmPath)) fs.unlinkSync(npmPath)
      execFileSync('npm', ['pack', '--pack-destination', opts.outDir, '--silent'], {
        cwd: REPO_ROOT,
        env: tarEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (!fs.existsSync(npmPath)) {
        throw new Error(`npm pack did not create expected archive ${npmPath}`)
      }
      const npmEntries = execFileSync('tar', ['-tzf', npmPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .split(/\r?\n/)
        .filter(Boolean)
      for (const forbidden of ['package/src/', 'package/tests/', 'package/scripts/', 'package/.github/']) {
        if (npmEntries.some((e) => e.startsWith(forbidden))) {
          throw new Error(`npm tarball leaked non-published path prefix: ${forbidden}`)
        }
      }
      artifacts.push({
        kind: 'npm',
        filename: npmFilename,
        path: npmPath,
        bytes: fs.statSync(npmPath).size,
        sha256: sha256File(npmPath),
        entryCount: npmEntries.length,
      })
    }

    // 7. Write SHA256SUMS.txt
    const checksumPath = path.join(opts.outDir, 'SHA256SUMS.txt')
    const checksumLines = artifacts.map((a) => `${a.sha256}  ${a.filename}`).join('\n') + '\n'
    fs.writeFileSync(checksumPath, checksumLines, { encoding: 'utf8', mode: 0o644 })

    const report = {
      ok: true,
      version,
      outDir: opts.outDir,
      runtimeDependencies: runtimeDeps,
      artifacts,
      checksumsPath: checksumPath,
    }

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      process.stdout.write(`Swarmboard v${version} release artifacts built in ${opts.outDir}:\n`)
      for (const a of artifacts) {
        process.stdout.write(
          `  - ${a.filename} (${formatBytes(a.bytes)}, ${a.entryCount} entries) sha256=${a.sha256.slice(0, 16)}...\n`,
        )
      }
      process.stdout.write(`  - SHA256SUMS.txt\n`)
    }
    return report
  } finally {
    fs.rmSync(stageParent, { recursive: true, force: true })
  }
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
  try {
    buildRelease(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`[build-release] error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}
