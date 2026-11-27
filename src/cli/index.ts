// Main `swarmboard` CLI dispatcher (Swarmboard v2 launch design §3.2).
// Depends ONLY on `../client/**` and Node stdlib; all host/daemon/store concerns enter via `CliHostBridge`.
import { clientError } from '../client/errors.ts'
import type { Env, ResolveFlags } from '../client/resolve.ts'
import { CLIENT_VERSION } from '../client/version.ts'
import { parseGlobalArgs } from './args.ts'
import type { CliBridgeContext, CliHostBridge, CliIo } from './bridge.ts'
import {
  cmdBackup,
  cmdDaemon,
  cmdDoctor,
  cmdInit,
  cmdOpen,
  cmdServe,
  cmdSetup,
  cmdTick,
  cmdToken,
  cmdUninstall,
} from './commands/ops.ts'
import { cmdTail, cmdWait } from './commands/realtime.ts'
import {
  cmdAck,
  cmdChannels,
  cmdDelete,
  cmdDm,
  cmdEdit,
  cmdFeedback,
  cmdFlag,
  cmdGroup,
  cmdInbox,
  cmdInsights,
  cmdLabel,
  cmdMe,
  cmdMentions,
  cmdPin,
  cmdPins,
  cmdPost,
  cmdPresence,
  cmdReact,
  cmdRead,
  cmdReply,
  cmdSearch,
  cmdThreads,
  cmdUnpin,
  cmdWho,
  type CommandEnv,
} from './commands/social.ts'
import { cmdTasks } from './commands/tasks.ts'
import { COMMAND_HELP, MAIN_HELP } from './help.ts'
import {
  collectEnvSecrets,
  createFormatter,
  EXIT_OK,
  formatCliError,
  resolveOutputMode,
} from './output.ts'

export * from './bridge.ts'
export * from './args.ts'
export * from './output.ts'
export * from './seed.ts'
export * from './claims.ts'

export interface RunCliOptions {
  readonly cwd?: string
  readonly io?: CliIo
}

export function createProcessIo(signal?: AbortSignal): CliIo {
  return {
    stdout(text: string): void {
      process.stdout.write(text)
    },
    stderr(text: string): void {
      process.stderr.write(text)
    },
    async readStdin(): Promise<string> {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
      }
      return Buffer.concat(chunks).toString('utf8')
    },
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    ...(signal !== undefined ? { signal } : {}),
  }
}

const CANONICAL_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  whoami: 'me',
  rm: 'delete',
  del: 'delete',
  groups: 'group',
  channel: 'channels',
  task: 'tasks',
  notif: 'mentions',
  notifications: 'mentions',
  tokens: 'token',
}

function canonicalCommand(cmd: string): string {
  return CANONICAL_COMMAND_ALIASES[cmd] ?? cmd
}

const OPS_COMMANDS = new Set(['setup', 'uninstall', 'init', 'doctor', 'backup', 'tick', 'serve', 'daemon', 'open', 'token'])

/**
 * Executes one `swarmboard` CLI invocation and returns its POSIX exit code:
 * - `0`: success (or quiet timeout on `wait --hook-rewake`)
 * - `1`: error
 * - `2`: `wait --hook-rewake` wake signal
 * - `78`: port already in use (`EADDRINUSE`)
 */
export async function runCli(
  argv: readonly string[],
  env: Env,
  bridge: CliHostBridge,
  opts: RunCliOptions = {},
): Promise<number> {
  const io = opts.io ?? createProcessIo()
  const cwd = opts.cwd ?? process.cwd()
  const secrets = collectEnvSecrets(env)

  let modeForErrors: 'json' | 'compact' | 'tty' = argv.includes('--json')
    ? 'json'
    : io.stdoutIsTTY
      ? 'tty'
      : 'compact'

  try {
    const parsed = parseGlobalArgs(argv)
    const { globals, command, rest } = parsed
    modeForErrors = resolveOutputMode(globals, io.stdoutIsTTY)
    const fmt = createFormatter(globals, env, io)

    if (globals.version) {
      if (fmt.mode === 'json') fmt.json({ name: 'swarmboard', version: CLIENT_VERSION })
      else fmt.line(`swarmboard ${CLIENT_VERSION}`)
      return EXIT_OK
    }

    if (command === 'help') {
      const topic = rest[0] ? canonicalCommand(rest[0]) : null
      if (topic && COMMAND_HELP[topic]) {
        io.stdout(`${COMMAND_HELP[topic]}\n`)
      } else {
        io.stdout(MAIN_HELP)
      }
      return EXIT_OK
    }

    if (globals.help || command === null) {
      const topic = command ? canonicalCommand(command) : null
      if (topic && COMMAND_HELP[topic]) {
        io.stdout(`${COMMAND_HELP[topic]}\n`)
      } else {
        io.stdout(MAIN_HELP)
      }
      return EXIT_OK
    }

    const cmd = canonicalCommand(command)

    const resolveFlags: ResolveFlags = {
      ...(globals.board !== undefined ? { board: globals.board } : {}),
      ...(globals.db !== undefined ? { db: globals.db } : {}),
      ...(globals.url !== undefined ? { url: globals.url } : {}),
      ...(globals.mode !== undefined ? { mode: globals.mode } : {}),
      ...(globals.as !== undefined ? { as: globals.as } : {}),
      ...(globals.allowUnsafeFs ? { allowUnsafeFs: true } : {}),
    }

    const bridgeCtx: CliBridgeContext = {
      flags: resolveFlags,
      env,
      cwd,
      isTTY: io.stdinIsTTY && io.stdoutIsTTY,
      stdinIsTTY: io.stdinIsTTY,
      stdoutIsTTY: io.stdoutIsTTY,
    }

    if (OPS_COMMANDS.has(cmd)) {
      const opsEnv = { bridge, bridgeCtx, fmt, io }
      switch (cmd) {
        case 'setup':
          return await cmdSetup(opsEnv, rest)
        case 'uninstall':
          return await cmdUninstall(opsEnv, rest)
        case 'init':
          return await cmdInit(opsEnv, rest)
        case 'doctor':
          return await cmdDoctor(opsEnv, rest)
        case 'backup':
          return await cmdBackup(opsEnv, rest)
        case 'tick':
          return await cmdTick(opsEnv, rest)
        case 'serve':
          return await cmdServe(opsEnv, rest)
        case 'daemon':
          return await cmdDaemon(opsEnv, rest)
        case 'open':
          return await cmdOpen(opsEnv, rest)
        case 'token':
          return await cmdToken(opsEnv, rest)
      }
    }

    // Validate command name before opening a board connection
    const clientHandler = CLIENT_HANDLERS[cmd]
    if (!clientHandler) {
      throw clientError('invalid_request', `unknown command "${command}"`, {
        hint: 'run "swarmboard --help" to see available commands',
      })
    }

    const client = await bridge.connect(bridgeCtx)
    try {
      const cmdEnv: CommandEnv = { client, fmt, io, env }
      return await clientHandler(cmdEnv, rest)
    } finally {
      await client.close()
    }
  } catch (err) {
    const formatted = formatCliError(err, modeForErrors, secrets)
    io.stderr(formatted.stderr)
    return formatted.exitCode
  }
}

const CLIENT_HANDLERS: Readonly<Record<string, (ctx: CommandEnv, args: readonly string[]) => Promise<number>>> = {
  me: cmdMe,
  post: cmdPost,
  reply: cmdReply,
  read: cmdRead,
  threads: cmdThreads,
  edit: cmdEdit,
  delete: cmdDelete,
  react: cmdReact,
  label: cmdLabel,
  flag: cmdFlag,
  inbox: cmdInbox,
  insights: cmdInsights,
  mentions: cmdMentions,
  ack: cmdAck,
  dm: cmdDm,
  pin: cmdPin,
  unpin: cmdUnpin,
  pins: cmdPins,
  group: cmdGroup,
  channels: cmdChannels,
  who: cmdWho,
  presence: cmdPresence,
  wait: cmdWait,
  tail: cmdTail,
  tasks: cmdTasks,
  feedback: cmdFeedback,
  search: cmdSearch,
}
