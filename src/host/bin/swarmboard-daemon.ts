#!/usr/bin/env node
// Detached background daemon entrypoint for Swarmboard (HOST-10, Swarmboard v2 launch design §4.3).
// Spawned by `ensureDaemon()` (`src/host/daemon/election.ts`) or invoked directly via `node dist/bin/swarmboard-daemon.mjs`.
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBoardError } from '../../client/errors.ts'
import { CLIENT_VERSION } from '../../client/version.ts'
import { runDaemonServer, type RunDaemonOptions } from '../daemon/daemon.ts'

const HELP_TEXT = `swarmboard-daemon ${CLIENT_VERSION} — Swarmboard lazy UDS + loopback TCP background daemon

Usage:
  swarmboard-daemon --db <abs-path> [options]

Options:
  --db <path>               Absolute path to SQLite board.db (required)
  --run <dir>               Override daemon runtime directory
  --nonce <hex>             Election nonce for endpoint.json
  --tcp <host:port|port>    Enable loopback HTTP + SSE + UI listener (e.g. 127.0.0.1:4180)
  --idle-exit <seconds>     Idle auto-exit timeout in seconds (default 600)
  --no-idle-exit            Disable idle auto-exit (resident service mode)
  --auth-enforce            Require bearer tokens / strict listener auth
  --allow-unsafe-fs         Allow opening board on non-standard filesystems
  --tailscale-host <host>   Accept Tailscale Serve identity on this host
  --tailscale-owner <login> Tailscale login granted human_verified owner status
  --allow-host <host>       Additional allowed HTTP Host header (mutually exclusive with --tailscale-host)
  --board-url <url>         External board URL for audience verification
  --mode <daemon|service>   Reported daemon mode
  -h, --help                Show this help and exit
  -V, -v, --version         Print version and exit
`

interface ParsedArgs {
  db?: string
  runDir?: string
  nonce?: string
  tcp?: { host: string; port: number }
  idleExitS?: number
  authEnforce?: boolean
  allowUnsafeFs?: boolean
  tailscaleHost?: string
  tailscaleOwnerLogin?: string
  allowHosts?: string[]
  boardUrl?: string
  mode?: 'daemon' | 'service'
  help?: boolean
  version?: boolean
}

function parseTcpSpec(raw: string): { host: string; port: number } {
  const idx = raw.lastIndexOf(':')
  if (idx <= 0) {
    const portOnly = Number(raw)
    if (Number.isInteger(portOnly) && portOnly >= 0 && portOnly <= 65535) {
      return { host: '127.0.0.1', port: portOnly }
    }
    throw new Error(`invalid --tcp specification "${raw}" (expected host:port)`)
  }
  const host = raw.slice(0, idx)
  const port = Number(raw.slice(idx + 1))
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --tcp port in "${raw}"`)
  }
  return { host, port }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case '-h':
      case '--help':
        out.help = true
        break
      case '-V':
      case '-v':
      case '--version':
        out.version = true
        break
      case '--db':
        out.db = next()
        break
      case '--run':
        out.runDir = next()
        break
      case '--nonce':
        out.nonce = next()
        break
      case '--tcp':
        out.tcp = parseTcpSpec(next())
        break
      case '--idle-exit': {
        const s = Number(next())
        if (!Number.isFinite(s) || s < 0) throw new Error(`invalid --idle-exit value`)
        out.idleExitS = s
        break
      }
      case '--no-idle-exit':
        out.idleExitS = 0
        break
      case '--auth-enforce':
        out.authEnforce = true
        break
      case '--allow-unsafe-fs':
        out.allowUnsafeFs = true
        break
      case '--tailscale-host':
        out.tailscaleHost = next()
        break
      case '--tailscale-owner':
        out.tailscaleOwnerLogin = next()
        break
      case '--allow-host':
        out.allowHosts ??= []
        out.allowHosts.push(next())
        break
      case '--board-url':
        out.boardUrl = next()
        break
      case '--mode': {
        const m = next()
        if (m !== 'daemon' && m !== 'service') throw new Error(`invalid --mode: ${m}`)
        out.mode = m
        break
      }
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

async function main(): Promise<void> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`[swarmboard-daemon] ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
    return
  }
  if (parsed.help) {
    process.stdout.write(HELP_TEXT)
    return
  }
  if (parsed.version) {
    process.stdout.write(`swarmboard-daemon ${CLIENT_VERSION}\n`)
    return
  }
  if (!parsed.db) {
    process.stderr.write('[swarmboard-daemon] --db <path> is required (pass --help for usage)\n')
    process.exitCode = 1
    return
  }

  const options: RunDaemonOptions = {
    db: parsed.db,
    registerSignals: true,
    onLog: (line) => {
      process.stderr.write(`${new Date().toISOString()} ${line}\n`)
    },
    ...(parsed.runDir !== undefined ? { runDir: parsed.runDir } : {}),
    ...(parsed.nonce !== undefined ? { nonce: parsed.nonce } : {}),
    ...(parsed.tcp !== undefined ? { tcp: parsed.tcp } : {}),
    ...(parsed.idleExitS !== undefined ? { idleExitS: parsed.idleExitS } : {}),
    ...(parsed.authEnforce !== undefined ? { authEnforce: parsed.authEnforce } : {}),
    ...(parsed.allowUnsafeFs !== undefined ? { allowUnsafeFs: parsed.allowUnsafeFs } : {}),
    ...(parsed.tailscaleHost !== undefined ? { tailscaleHost: parsed.tailscaleHost } : {}),
    ...(parsed.tailscaleOwnerLogin !== undefined ? { tailscaleOwnerLogin: parsed.tailscaleOwnerLogin } : {}),
    ...(parsed.allowHosts !== undefined ? { allowHosts: parsed.allowHosts } : {}),
    ...(parsed.boardUrl !== undefined ? { boardUrl: parsed.boardUrl } : {}),
    ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
  }

  try {
    const handle = await runDaemonServer(options)
    await handle.done
    process.exit(0)
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException | null)?.code
    if (errno === 'EADDRINUSE') {
      // Another daemon won the UDS bind race; exit 0 cleanly per election protocol.
      process.stderr.write('[swarmboard-daemon] socket already bound by another daemon; exiting 0\n')
      process.exit(0)
    }
    if (isBoardError(err) && (err.details as { code?: string } | null)?.code === 'port_taken') {
      process.stderr.write(`[swarmboard-daemon] ${err.message}\n`)
      process.exit(78)
    }
    process.stderr.write(`[swarmboard-daemon] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(nodePath.resolve(entry))
  } catch {
    return false
  }
}

if (isMainModule()) {
  void main()
}
