#!/usr/bin/env node
// Thin stdio binary entrypoint for swarmboard-mcp (HOST-6, Swarmboard v2 launch design §3.3).
// CRITICAL: stdout is reserved exclusively for MCP JSON-RPC frames. All diagnostics go to stderr.
import * as fs from 'node:fs'
import * as moduleApi from 'node:module'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODE_POLICIES, type ModePolicy } from '../../client/config.ts'
import { clientError } from '../../client/errors.ts'
import { clientErrorPayload } from '../../client/normalize.ts'
import { processContext, resolveBoard, type Env, type ResolveFlags } from '../../client/resolve.ts'
import { CLIENT_VERSION } from '../../client/version.ts'
import { createMcpServer, type McpConnectRequest, type McpHostBridge } from '../../mcp/index.ts'
import { resolveLocalIdentity } from '../auth/local.ts'
import { connect } from '../connect.ts'

// Enable Node >= 22.8 compile cache safely for fast MCP cold start (silent on unsupported versions).
function tryEnableCompileCache(): void {
  try {
    const disabled = process.env['SWARMBOARD_DISABLE_COMPILE_CACHE']?.trim().toLowerCase()
    if (disabled && disabled !== '0' && disabled !== 'false') return
    const fn = (moduleApi as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache
    if (typeof fn !== 'function') return
    const cacheDir =
      process.env['NODE_COMPILE_CACHE']?.trim() ||
      nodePath.join(os.homedir(), '.cache', 'swarmboard', 'compile-cache')
    fn(cacheDir)
  } catch {
    // Compile cache is purely an optimization; never break startup or write to stdout.
  }
}

export interface ParsedMcpArgs {
  readonly flags: McpConnectRequest
  readonly help: boolean
  readonly version: boolean
}

const HELP_TEXT = `swarmboard-mcp ${CLIENT_VERSION} — Swarmboard zero-dependency stdio MCP server

Usage:
  swarmboard-mcp [--db <abs-path> | --url <https-url> | --board <name>] [--mode <auto|file|daemon|service>] [--as <profile>]

Environment:
  SWARMBOARD_DB       Absolute path to SQLite board.db
  SWARMBOARD_URL      Remote Swarmboard HTTPS URL
  SWARMBOARD_AGENT    Agent profile name (required for non-TTY local boards)
  SWARMBOARD_HARNESS  Optional harness label for auto-presence (e.g. claude-code, codex, agy)
  SWARMBOARD_MODEL    Optional model label for auto-presence
  SWARMBOARD_MODE     auto | file | daemon | service
  SWARMBOARD_TOKEN    Bearer token (for strict/remote boards)
`

export function parseMcpArgv(argv: readonly string[]): ParsedMcpArgs {
  let board: string | undefined
  let url: string | undefined
  let db: string | undefined
  let mode: ModePolicy | undefined
  let as: string | undefined
  let allowUnsafeFs: boolean | undefined
  let help = false
  let version = false

  const nextValue = (i: number, flag: string): string => {
    const val = argv[i + 1]
    if (val === undefined) {
      throw clientError('invalid_request', `${flag} requires a value`)
    }
    return val
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--version' || arg === '-v' || arg === '-V') {
      version = true
    } else if (arg === '--db') {
      db = nextValue(i, arg)
      i += 1
    } else if (arg.startsWith('--db=')) {
      db = arg.slice('--db='.length)
    } else if (arg === '--url') {
      url = nextValue(i, arg)
      i += 1
    } else if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length)
    } else if (arg === '--board') {
      board = nextValue(i, arg)
      i += 1
    } else if (arg.startsWith('--board=')) {
      board = arg.slice('--board='.length)
    } else if (arg === '--mode') {
      const m = nextValue(i, arg)
      if (!(MODE_POLICIES as readonly string[]).includes(m)) {
        throw clientError('invalid_mode', `--mode must be one of ${MODE_POLICIES.join(', ')}`)
      }
      mode = m as ModePolicy
      i += 1
    } else if (arg.startsWith('--mode=')) {
      const m = arg.slice('--mode='.length)
      if (!(MODE_POLICIES as readonly string[]).includes(m)) {
        throw clientError('invalid_mode', `--mode must be one of ${MODE_POLICIES.join(', ')}`)
      }
      mode = m as ModePolicy
    } else if (arg === '--as') {
      as = nextValue(i, arg)
      i += 1
    } else if (arg.startsWith('--as=')) {
      as = arg.slice('--as='.length)
    } else if (arg === '--allow-unsafe-fs') {
      allowUnsafeFs = true
    } else {
      throw clientError('invalid_request', `unknown argument: ${arg}`)
    }
  }

  return {
    flags: {
      ...(board !== undefined ? { board } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(db !== undefined ? { db } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(as !== undefined ? { as } : {}),
      ...(allowUnsafeFs !== undefined ? { allowUnsafeFs } : {}),
    },
    help,
    version,
  }
}

export interface CreateStdioBridgeOptions {
  readonly env?: Env
  readonly cwd?: string
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly uid?: number | null
  readonly claimsDir?: string | null
  readonly log?: (line: string) => void
}

/** Builds the real host bridge wiring resolveBoard() + resolveLocalIdentity({ isTTY: false }) + connect(). */
export function createStdioHostBridge(opts: CreateStdioBridgeOptions = {}): McpHostBridge {
  const env = opts.env ?? process.env
  const log = opts.log ?? ((line: string) => {
    process.stderr.write(`${line}\n`)
  })

  return {
    env,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...(opts.claimsDir !== undefined ? { claimsDir: opts.claimsDir } : {}),
    log,
    formatError: clientErrorPayload,
    async connect(req?: McpConnectRequest) {
      const mergedEnv = req?.env ?? env
      const ctx = processContext({
        env: mergedEnv,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
        ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      })
      const flags: ResolveFlags = {
        ...(req?.board !== undefined ? { board: req.board } : {}),
        ...(req?.url !== undefined ? { url: req.url } : {}),
        ...(req?.db !== undefined ? { db: req.db } : {}),
        ...(req?.mode !== undefined ? { mode: req.mode } : {}),
        ...(req?.as !== undefined ? { as: req.as } : {}),
        ...(req?.allowUnsafeFs !== undefined ? { allowUnsafeFs: req.allowUnsafeFs } : {}),
      }
      const resolution = resolveBoard(flags, ctx)
      if (resolution.target.kind === 'url') {
        return connect({ ...flags, context: ctx })
      }
      // MCP stdio is strictly non-interactive: never fall back to local human principal.
      const localId = resolveLocalIdentity({
        resolution,
        env: mergedEnv,
        isTTY: false,
        as: req?.as,
        uid: ctx.uid,
        platform: ctx.platform,
      })
      return connect({
        ...flags,
        identity: localId.provider,
        context: ctx,
      })
    },
  }
}

export interface RunMcpMainOptions extends CreateStdioBridgeOptions {
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  readonly stderr?: NodeJS.WritableStream
  readonly installSignalHandlers?: boolean
  readonly waitCapS?: number
  readonly heartbeatIntervalMs?: number
  readonly presenceTtlS?: number
  readonly autoPresence?: boolean
}

export async function runMcpMain(argv: readonly string[], opts: RunMcpMainOptions = {}): Promise<number> {
  const stderr = opts.stderr ?? process.stderr
  const log = opts.log ?? ((line: string) => {
    stderr.write(`${line}\n`)
  })

  let parsed: ParsedMcpArgs
  try {
    parsed = parseMcpArgv(argv)
  } catch (err) {
    const formatted = clientErrorPayload(err)
    log(`[swarmboard-mcp] ${formatted.payload.error.code}: ${formatted.payload.error.message}`)
    return 1
  }

  if (parsed.help) {
    stderr.write(HELP_TEXT)
    return 0
  }
  if (parsed.version) {
    stderr.write(`${CLIENT_VERSION}\n`)
    return 0
  }

  const bridge = createStdioHostBridge({
    env: opts.env,
    cwd: opts.cwd,
    home: opts.home,
    platform: opts.platform,
    uid: opts.uid,
    claimsDir: opts.claimsDir,
    log,
  })

  const server = createMcpServer({
    bridge,
    connectRequest: parsed.flags,
    input: opts.input ?? process.stdin,
    output: opts.output ?? process.stdout,
    ...(opts.waitCapS !== undefined ? { waitCapS: opts.waitCapS } : {}),
    ...(opts.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: opts.heartbeatIntervalMs } : {}),
    ...(opts.presenceTtlS !== undefined ? { presenceTtlS: opts.presenceTtlS } : {}),
    ...(opts.autoPresence !== undefined ? { autoPresence: opts.autoPresence } : {}),
  })

  const installSignals = opts.installSignalHandlers ?? true
  const onSignal = (): void => {
    void server.shutdown().finally(() => {
      process.exitCode = 0
    })
  }
  if (installSignals) {
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  }

  try {
    await server.run()
    return 0
  } catch (err) {
    const formatted = clientErrorPayload(err)
    log(`[swarmboard-mcp] fatal (${formatted.payload.error.code}): ${formatted.payload.error.message}`)
    await server.shutdown().catch(() => {})
    return 1
  } finally {
    if (installSignals) {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    }
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const selfPath = fs.realpathSync(fileURLToPath(import.meta.url))
    const invokedPath = fs.realpathSync(nodePath.resolve(entry))
    return selfPath === invokedPath
  } catch {
    return false
  }
}

if (isMainModule()) {
  tryEnableCompileCache()
  void runMcpMain(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
