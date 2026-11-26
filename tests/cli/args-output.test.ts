// Unit tests for CLI argument parsing, bare `--mentions` warnings, formatting,
// secret redaction, error exit codes, and F-1 / HS-03 / HS-151 static boundaries.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClientError, clientError } from '../../src/client/errors.ts'
import {
  canonicalTaskKey,
  collectEnvSecrets,
  EXIT_ERROR,
  EXIT_HOOK_WAKE,
  EXIT_OK,
  EXIT_PORT_TAKEN,
  formatCliError,
  looksLikeMessageRef,
  parseCommandArgs,
  parseDurationSeconds,
  parseGlobalArgs,
  redactSecrets,
  resolveOutputMode,
  runCli,
  TRUST_DISCLOSURE,
  type CliHostBridge,
  type CliIo,
} from '../../src/cli/index.ts'
import { hostPathViolations, scanBoth, stripComments, transportFiles } from '../core/host0/import-graph.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

function makeMockIo(opts: { stdin?: string; stdinIsTTY?: boolean; stdoutIsTTY?: boolean } = {}) {
  let out = ''
  let err = ''
  const io: CliIo = {
    stdout(s) {
      out += s
    },
    stderr(s) {
      err += s
    },
    async readStdin() {
      return opts.stdin ?? ''
    },
    stdinIsTTY: opts.stdinIsTTY ?? false,
    stdoutIsTTY: opts.stdoutIsTTY ?? false,
  }
  return { io, get stdout() { return out }, get stderr() { return err } }
}

function unimplementedBridge(): CliHostBridge {
  const fail = (name: string) => () => {
    throw new Error(`unexpected bridge call: ${name}`)
  }
  return {
    connect: fail('connect'),
    openForInit: fail('openForInit'),
    doctor: fail('doctor'),
    backup: fail('backup'),
    runTickOnce: fail('runTickOnce'),
    serve: fail('serve'),
    daemonControl: fail('daemonControl'),
    openUi: fail('openUi'),
    tokenIssue: fail('tokenIssue'),
    tokenList: fail('tokenList'),
    tokenRevoke: fail('tokenRevoke'),
  }
}

describe('CLI global & command argument parsing', () => {
  it('extracts global flags before and after the command while preserving -- separator', () => {
    const parsed = parseGlobalArgs([
      '--db',
      '/tmp/board.db',
      'post',
      'dev',
      '--as=agy',
      '--json',
      '--',
      '--db',
      'literal-text',
    ])
    expect(parsed.command).toBe('post')
    expect(parsed.globals.db).toBe('/tmp/board.db')
    expect(parsed.globals.as).toBe('agy')
    expect(parsed.globals.json).toBe(true)
    expect(parsed.rest).toEqual(['dev', '--', '--db', 'literal-text'])
  })

  it('rejects invalid --mode values cleanly', () => {
    expect(() => parseGlobalArgs(['--mode', 'bogus', 'me'])).toThrow(/--mode must be one of/)
  })

  it('warns on bare --mentions without "@" and defaults to "me" (leaving bare word positional)', () => {
    const bareSpace = parseCommandArgs(['--mentions', 'dev'], { mentions: { kind: 'mentions' } })
    expect(bareSpace.flags['mentions']).toBe('me')
    expect(bareSpace.positionals).toEqual(['dev'])
    expect(bareSpace.warnings).toHaveLength(1)
    expect(bareSpace.warnings[0]).toMatch(/bare "--mentions" without "@"/)
    expect(bareSpace.warnings[0]).toContain('--mentions @dev')

    const bareEq = parseCommandArgs(['--mentions=alice'], { mentions: { kind: 'mentions' } })
    expect(bareEq.flags['mentions']).toBe('alice')
    expect(bareEq.warnings).toHaveLength(1)
    expect(bareEq.warnings[0]).toMatch(/has no "@"/)

    const explicitAt = parseCommandArgs(['--mentions', '@alice', 'dev'], { mentions: { kind: 'mentions' } })
    expect(explicitAt.flags['mentions']).toBe('alice')
    expect(explicitAt.positionals).toEqual(['dev'])
    expect(explicitAt.warnings).toEqual([])

    const explicitMe = parseCommandArgs(['--mentions', 'me', 'dev'], { mentions: { kind: 'mentions' } })
    expect(explicitMe.flags['mentions']).toBe('me')
    expect(explicitMe.positionals).toEqual(['dev'])
    expect(explicitMe.warnings).toEqual([])

    const standalone = parseCommandArgs(['dev', '--mentions'], { mentions: { kind: 'mentions' } })
    expect(standalone.flags['mentions']).toBe('me')
    expect(standalone.positionals).toEqual(['dev'])
    expect(standalone.warnings).toEqual([])
  })

  it('parses durations and bare seconds accurately', () => {
    expect(parseDurationSeconds('20', 'timeout')).toBe(20)
    expect(parseDurationSeconds('20s', 'timeout')).toBe(20)
    expect(parseDurationSeconds('500ms', 'timeout')).toBe(0.5)
    expect(parseDurationSeconds('2m', 'timeout')).toBe(120)
    expect(parseDurationSeconds('12h', 'ttl')).toBe(43_200)
    expect(() => parseDurationSeconds('notaduration', 'timeout')).toThrow(/duration/)
  })

  it('distinguishes message/thread references from channel paths', () => {
    expect(looksLikeMessageRef('12')).toBe(true)
    expect(looksLikeMessageRef('#12')).toBe(true)
    expect(looksLikeMessageRef('msg_12')).toBe(true)
    expect(looksLikeMessageRef('thr_12')).toBe(true)
    expect(looksLikeMessageRef('thr_abc_123')).toBe(true)
    expect(looksLikeMessageRef('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(looksLikeMessageRef('dev')).toBe(false)
    expect(looksLikeMessageRef('repos/agent-board/dev')).toBe(false)
    expect(looksLikeMessageRef('dm/agy--codex')).toBe(false)

    expect(canonicalTaskKey('#42')).toBe('42')
    expect(canonicalTaskKey('msg_42')).toBe('42')
    expect(canonicalTaskKey('thr_42')).toBe('42')
    expect(canonicalTaskKey('thr_custom')).toBe('thr_custom')
  })
})

describe('CLI output modes, redaction, and exit codes', () => {
  it('selects output mode: --json > --compact > TTY/non-TTY default', () => {
    const base = { json: false, compact: false, noColor: false, help: false, version: false }
    expect(resolveOutputMode({ ...base, json: true, compact: true }, true)).toBe('json')
    expect(resolveOutputMode({ ...base, compact: true }, true)).toBe('compact')
    expect(resolveOutputMode(base, false)).toBe('compact')
    expect(resolveOutputMode(base, true)).toBe('tty')
  })

  it('redacts sb_* wire tokens, Bearer credentials, and env token secrets unconditionally', () => {
    const secret = 'sb_abcdefghijkl_0123456789abcdef0123456789abcdef0123456789a'
    const customEnvSecret = 'super-secret-env-token-value-999'
    const envSecrets = collectEnvSecrets({ SWARMBOARD_TOKEN: customEnvSecret })
    const raw = `auth failed for ${secret} and Bearer anotherLongSecretToken12345 and ${customEnvSecret}`
    const redacted = redactSecrets(raw, envSecrets)
    expect(redacted).not.toContain('0123456789abcdef')
    expect(redacted).not.toContain('anotherLongSecretToken12345')
    expect(redacted).not.toContain(customEnvSecret)
    expect(redacted).toContain('sb_abcdefghijkl_[redacted]')
    expect(redacted).toContain('Bearer [redacted]')
  })

  it('maps BoardErrorLike to JSON error payload and EADDRINUSE to exit code 78', () => {
    const err = clientError('invalid_request', 'bad flag', { hint: 'pass --help' })
    const formattedJson = formatCliError(err, 'json')
    expect(formattedJson.exitCode).toBe(EXIT_ERROR)
    expect(JSON.parse(formattedJson.stderr)).toEqual({
      error: { code: 'invalid_request', message: 'bad flag', hint: 'pass --help' },
    })

    const portErr = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4180'), {
      code: 'EADDRINUSE',
    })
    const portFormatted = formatCliError(portErr, 'json')
    expect(portFormatted.exitCode).toBe(EXIT_PORT_TAKEN)
    expect(JSON.parse(portFormatted.stderr).error.code).toBe('port_in_use')

    const wrappedPortErr = new ClientError(503, 'daemon_unavailable', 'port occupied', { cause: portErr })
    expect(formatCliError(wrappedPortErr, 'compact').exitCode).toBe(EXIT_PORT_TAKEN)
    expect(EXIT_OK).toBe(0)
    expect(EXIT_HOOK_WAKE).toBe(2)
  })

  it('serves --help, --version, and unknown command errors without opening a board', async () => {
    const bridge = unimplementedBridge()

    const helpIo = makeMockIo()
    expect(await runCli(['--help'], {}, bridge, { io: helpIo.io })).toBe(0)
    expect(helpIo.stdout).toContain('swarmboard')
    expect(helpIo.stdout).toContain('--hook-rewake')

    const subHelpIo = makeMockIo()
    expect(await runCli(['wait', '--help'], {}, bridge, { io: subHelpIo.io })).toBe(0)
    expect(subHelpIo.stdout).toContain('exits 2')

    const verIo = makeMockIo()
    expect(await runCli(['--version', '--json'], {}, bridge, { io: verIo.io })).toBe(0)
    expect(JSON.parse(verIo.stdout).name).toBe('swarmboard')

    const badIo = makeMockIo()
    expect(await runCli(['no-such-cmd', '--json'], {}, bridge, { io: badIo.io })).toBe(1)
    expect(JSON.parse(badIo.stderr).error.code).toBe('invalid_request')
  })

  it('exposes the exact verbatim same-uid trust disclosure text', () => {
    expect(TRUST_DISCLOSURE).toBe(
      'Modes 0-3 give attribution and accident prevention among agents that run as your OS user. They do not isolate those agents from each other. For isolation, run agents sandboxed with only the socket mounted, as other OS users, or against a remote board.',
    )
  })
})

describe('CLI F-1, HS-03, and HS-151 static boundary checks', () => {
  it('src/cli/** has zero import-boundary violations, zero host path mentions, and zero core normalizer refs', () => {
    const { files, symlinks } = transportFiles(REPO_ROOT, ['cli'])
    expect(symlinks).toEqual([])
    expect(files.length).toBeGreaterThanOrEqual(8)
    const normalizerRe = /\b(?:normalizeError|toErrorPayload|toErrorResponse)\b/
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      expect(scanBoth(REPO_ROOT, file, text), file).toEqual([])
      expect(hostPathViolations(REPO_ROOT, file, text), file).toEqual([])
      expect(normalizerRe.test(text), file).toBe(false)
    }
  })

  it('src/host/bin/swarmboard.ts never imports src/core/internal.ts and never calls core error normalizers', () => {
    const binPath = path.join(REPO_ROOT, 'src', 'host', 'bin', 'swarmboard.ts')
    const text = stripComments(fs.readFileSync(binPath, 'utf8'))
    expect(text).not.toMatch(/core\/internal\.ts/)
    expect(text).not.toMatch(/\b(?:normalizeError|toErrorPayload|toErrorResponse)\b/)
  })
})
