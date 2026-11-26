// Zero-dependency argument parsing, global flag extraction, duration parsing,
// and bare `--mentions` warning detection (Swarmboard v2 launch design §3.2).
import { duration } from '../client/client.ts'
import { clientError } from '../client/errors.ts'
import { MODE_POLICIES, type ModePolicy } from '../client/config.ts'
import type { CliGlobalFlags } from './bridge.ts'

export interface ParsedGlobalArgs {
  readonly globals: CliGlobalFlags
  readonly command: string | null
  readonly rest: readonly string[]
}

const GLOBAL_VALUE_FLAGS = new Set(['--board', '--db', '--url', '--mode', '--as'])

/**
 * Extracts global flags from anywhere in `argv` (stopping at `--`),
 * leaving command name and subcommand arguments intact in order.
 */
export function parseGlobalArgs(argv: readonly string[]): ParsedGlobalArgs {
  let board: string | undefined
  let db: string | undefined
  let url: string | undefined
  let mode: ModePolicy | undefined
  let asProfile: string | undefined
  let allowUnsafeFs = false
  let json = false
  let compact = false
  let noColor = false
  let help = false
  let version = false

  const remaining: string[] = []
  let afterDoubleDash = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (afterDoubleDash) {
      remaining.push(arg)
      continue
    }
    if (arg === '--') {
      afterDoubleDash = true
      remaining.push(arg)
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--compact') {
      compact = true
      continue
    }
    if (arg === '--no-color') {
      noColor = true
      continue
    }
    if (arg === '--allow-unsafe-fs') {
      allowUnsafeFs = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--version' || arg === '-V') {
      version = true
      continue
    }

    // --flag=value form
    const eq = arg.indexOf('=')
    if (eq > 0 && GLOBAL_VALUE_FLAGS.has(arg.slice(0, eq))) {
      const name = arg.slice(0, eq)
      const val = arg.slice(eq + 1)
      assignGlobalValue(name, val)
      continue
    }

    // --flag value form
    if (GLOBAL_VALUE_FLAGS.has(arg)) {
      const next = argv[i + 1]
      if (next === undefined || next === '--') {
        throw clientError('invalid_request', `${arg} requires a value`)
      }
      i += 1
      assignGlobalValue(arg, next)
      continue
    }

    remaining.push(arg)
  }

  function assignGlobalValue(name: string, val: string): void {
    if (name === '--board') board = val
    else if (name === '--db') db = val
    else if (name === '--url') url = val
    else if (name === '--as') asProfile = val
    else if (name === '--mode') {
      if (!(MODE_POLICIES as readonly string[]).includes(val)) {
        throw clientError('invalid_mode', `--mode must be one of ${MODE_POLICIES.join(', ')}`)
      }
      mode = val as ModePolicy
    }
  }

  let command: string | null = null
  let rest: readonly string[] = []
  if (remaining.length > 0 && !remaining[0]!.startsWith('-')) {
    command = remaining[0]!
    rest = remaining.slice(1)
  } else {
    rest = remaining
  }

  return {
    globals: {
      ...(board !== undefined ? { board } : {}),
      ...(db !== undefined ? { db } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(asProfile !== undefined ? { as: asProfile } : {}),
      ...(allowUnsafeFs ? { allowUnsafeFs: true } : {}),
      json,
      compact,
      noColor,
      help,
      version,
    },
    command,
    rest,
  }
}

export type FlagKind = 'boolean' | 'string' | 'string[]' | 'mentions'

export interface FlagSpec {
  readonly kind: FlagKind
  readonly short?: string
  readonly aliases?: readonly string[]
}

export type CommandFlagsSpec = Readonly<Record<string, FlagSpec>>

export interface ParsedCommandArgs {
  readonly positionals: readonly string[]
  readonly flags: Readonly<Record<string, boolean | string | readonly string[]>>
  readonly warnings: readonly string[]
}

/** True when a `--mentions` argument looks like an explicit target (`@handle`, `user@domain`, `me`, or actor ID `a:b`). */
function isExplicitMentionTarget(word: string): boolean {
  return word === 'me' || word.includes('@') || word.includes(':')
}

/**
 * Parses subcommand arguments against a declarative flag table.
 * Handles `--flag=val`, `--flag val`, `-l val`, `-l=val`, `--no-<bool>`, repeatable `string[]`,
 * `--` end-of-options, and the special `--mentions [who]` rule with bare-word warnings.
 */
export function parseCommandArgs(args: readonly string[], spec: CommandFlagsSpec): ParsedCommandArgs {
  const longMap = new Map<string, { readonly canonical: string; readonly def: FlagSpec }>()
  const shortMap = new Map<string, { readonly canonical: string; readonly def: FlagSpec }>()

  for (const [canonical, def] of Object.entries(spec)) {
    longMap.set(canonical, { canonical, def })
    if (def.short) shortMap.set(def.short, { canonical, def })
    if (def.aliases) {
      for (const alias of def.aliases) longMap.set(alias, { canonical, def })
    }
  }

  const values: Record<string, boolean | string | string[]> = {}
  const positionals: string[] = []
  const warnings: string[] = []

  const setVal = (canonical: string, def: FlagSpec, val: boolean | string): void => {
    if (def.kind === 'string[]') {
      const existing = values[canonical]
      if (Array.isArray(existing)) existing.push(String(val))
      else values[canonical] = [String(val)]
    } else {
      values[canonical] = val
    }
  }

  let afterDoubleDash = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (afterDoubleDash) {
      positionals.push(arg)
      continue
    }
    if (arg === '--') {
      afterDoubleDash = true
      continue
    }
    if (arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      const rawName = eq >= 0 ? body.slice(0, eq) : body
      const inlineVal = eq >= 0 ? body.slice(eq + 1) : undefined

      // Support `--no-<bool>` negation for boolean flags not explicitly defined as `no-...`
      if (inlineVal === undefined && rawName.startsWith('no-') && !longMap.has(rawName)) {
        const base = rawName.slice(3)
        const entry = longMap.get(base)
        if (entry && entry.def.kind === 'boolean') {
          values[entry.canonical] = false
          continue
        }
      }

      const entry = longMap.get(rawName)
      if (!entry) {
        throw clientError('invalid_request', `unknown option "--${rawName}"`)
      }

      if (entry.def.kind === 'boolean') {
        if (inlineVal === undefined) {
          setVal(entry.canonical, entry.def, true)
        } else if (inlineVal === 'true' || inlineVal === '1') {
          setVal(entry.canonical, entry.def, true)
        } else if (inlineVal === 'false' || inlineVal === '0') {
          setVal(entry.canonical, entry.def, false)
        } else {
          throw clientError('invalid_request', `--${rawName} expects a boolean value (true/false), got "${inlineVal}"`)
        }
        continue
      }

      if (entry.def.kind === 'mentions') {
        if (inlineVal !== undefined) {
          if (inlineVal.trim() === '') {
            throw clientError('invalid_request', `--${rawName} value must not be empty`)
          }
          if (!isExplicitMentionTarget(inlineVal)) {
            warnings.push(
              `warning: "--${rawName}=${inlineVal}" has no "@": use "--${rawName} @${inlineVal}" to filter mentions of ${inlineVal}`,
            )
          }
          const normalized = inlineVal.startsWith('@') ? inlineVal.slice(1) : inlineVal
          setVal(entry.canonical, entry.def, normalized)
          continue
        }
        const next = args[i + 1]
        if (next === undefined || next === '--' || next.startsWith('-')) {
          setVal(entry.canonical, entry.def, 'me')
          continue
        }
        if (isExplicitMentionTarget(next)) {
          i += 1
          const normalized = next.startsWith('@') ? next.slice(1) : next
          setVal(entry.canonical, entry.def, normalized)
          continue
        }
        // Bare word without `@` after `--mentions`:
        // Follows `withMentions` semantics (defaults to `me`, leaving `next` as positional) and warns clearly!
        warnings.push(
          `warning: bare "--${rawName}" without "@" defaults to "me" (treating "${next}" as a positional argument); use "--${rawName} @${next}" to filter mentions of ${next}`,
        )
        setVal(entry.canonical, entry.def, 'me')
        continue
      }

      // string or string[]
      if (inlineVal !== undefined) {
        setVal(entry.canonical, entry.def, inlineVal)
      } else {
        const next = args[i + 1]
        if (next === undefined || next === '--') {
          throw clientError('invalid_request', `--${rawName} requires a value`)
        }
        i += 1
        setVal(entry.canonical, entry.def, next)
      }
      continue
    }

    // Short flag: `-l k=v`, `-n 20`, `-n=20`
    const shortBody = arg.slice(1)
    const eq = shortBody.indexOf('=')
    const shortKey = eq >= 0 ? shortBody.slice(0, eq) : shortBody
    const inlineVal = eq >= 0 ? shortBody.slice(eq + 1) : undefined
    const entry = shortMap.get(shortKey)
    if (!entry) {
      throw clientError('invalid_request', `unknown option "-${shortKey}"`)
    }
    if (entry.def.kind === 'boolean') {
      if (inlineVal !== undefined) {
        throw clientError('invalid_request', `-${shortKey} does not take a value`)
      }
      setVal(entry.canonical, entry.def, true)
      continue
    }
    if (inlineVal !== undefined) {
      setVal(entry.canonical, entry.def, inlineVal)
    } else {
      const next = args[i + 1]
      if (next === undefined || next === '--') {
        throw clientError('invalid_request', `-${shortKey} requires a value`)
      }
      i += 1
      setVal(entry.canonical, entry.def, next)
    }
  }

  return { positionals, flags: values, warnings }
}

export function getStringFlag(flags: ParsedCommandArgs['flags'], name: string): string | undefined {
  const v = flags[name]
  return typeof v === 'string' ? v : undefined
}

export function getBoolFlag(flags: ParsedCommandArgs['flags'], name: string): boolean | undefined {
  const v = flags[name]
  return typeof v === 'boolean' ? v : undefined
}

export function getStringListFlag(flags: ParsedCommandArgs['flags'], name: string): readonly string[] {
  const v = flags[name]
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return [v]
  return []
}

export function parseIntFlag(raw: string | undefined, name: string, bounds?: { min?: number; max?: number }): number | undefined {
  if (raw === undefined) return undefined
  if (!/^-?\d+$/.test(raw.trim())) {
    throw clientError('invalid_request', `--${name} must be an integer (got "${raw}")`)
  }
  const n = Number(raw.trim())
  if (!Number.isSafeInteger(n)) {
    throw clientError('invalid_request', `--${name} is out of range`)
  }
  if (bounds?.min !== undefined && n < bounds.min) {
    throw clientError('invalid_request', `--${name} must be at least ${bounds.min}`)
  }
  if (bounds?.max !== undefined && n > bounds.max) {
    throw clientError('invalid_request', `--${name} must be at most ${bounds.max}`)
  }
  return n
}

/**
 * Parses a duration or bare numeric seconds (e.g. `'20s'`, `'500ms'`, `'12h'`, `'30'`) into seconds.
 */
export function parseDurationSeconds(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const secs = Number(trimmed)
    if (!Number.isFinite(secs) || secs < 0) {
      throw clientError('invalid_request', `--${name} must be a non-negative duration`)
    }
    return secs
  }
  const ms = duration(trimmed)
  return ms / 1000
}

export function parseKeyValuePair(raw: string, flagName: string): readonly [string, string] {
  const eq = raw.indexOf('=')
  if (eq <= 0) {
    throw clientError('invalid_request', `${flagName} expects key=value (got "${raw}")`)
  }
  return [raw.slice(0, eq), raw.slice(eq + 1)]
}

export function parseLabelRecord(entries: readonly string[], flagName = '--label'): Record<string, string> | undefined {
  if (entries.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const item of entries) {
    const [k, v] = parseKeyValuePair(item, flagName)
    out[k] = v
  }
  return out
}

export function splitCsvValues(values: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of values) {
    for (const part of raw.split(',')) {
      const trimmed = part.trim()
      if (trimmed !== '') out.push(trimmed)
    }
  }
  return out
}

const MESSAGE_REF_RE =
  /^(?:[1-9]\d{0,15}|#[1-9]\d{0,15}|msg_[1-9]\d{0,15}|thr_[A-Za-z0-9_-]{1,120}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** True when `target` is a message/thread reference (`12`, `#12`, `msg_12`, `thr_...`, or UUID) rather than a channel path. */
export function looksLikeMessageRef(target: string): boolean {
  return MESSAGE_REF_RE.test(target)
}

/** Normalizes a numeric reference (`#12`, `msg_12`, `thr_12`, `12`) into a canonical cache key; preserves opaque `thr_...` IDs. */
export function canonicalTaskKey(ref: string): string {
  const m = /^(?:#|msg_|thr_)([1-9]\d{0,15})$/.exec(ref)
  return m ? m[1]! : ref
}
