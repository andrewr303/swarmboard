// The zod schema of each operation's body, for the CLI, MCP and router generators (HOST123_DESIGN 5.1). Thick: it
// loads the core's public surface. Transports do not import it; they let the core's own parse be the authority.
import type { ZodType } from 'zod'
import * as Core from '../core/public.ts'
import { OP_NAMES, OPS, type OpName } from './ops.ts'

const byName = Core as unknown as Readonly<Record<string, ZodType | undefined>>

function build(): { readonly [K in OpName]: ZodType | null } {
  const out: Record<string, ZodType | null> = {}
  for (const op of OP_NAMES) {
    const name = OPS[op].schema
    if (name === null) {
      out[op] = null
      continue
    }
    const schema = byName[name]
    if (schema === undefined) throw new Error(`op ${op}: the public surface has no ${name}`)
    out[op] = schema
  }
  return Object.freeze(out) as { readonly [K in OpName]: ZodType | null }
}

export const OP_SCHEMAS: { readonly [K in OpName]: ZodType | null } = build()
