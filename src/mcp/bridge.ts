// Thin host injection contract for the stdio MCP server (Swarmboard v2 launch design §0, §3.3).
// Pure type-only module: zero runtime imports; keeps src/mcp decoupled from composition roots.
import type { BoardClient } from '../client/client.ts'
import type { ModePolicy } from '../client/config.ts'
import type { Env } from '../client/resolve.ts'

export interface McpConnectRequest {
  readonly board?: string
  readonly url?: string
  readonly db?: string
  readonly mode?: ModePolicy
  readonly as?: string | null
  readonly allowUnsafeFs?: boolean
  readonly env?: Env
}

export interface FormattedErrorPayload {
  readonly status: number
  readonly payload: {
    readonly error: {
      readonly code: string
      readonly message: string
      readonly hint?: string
      readonly details?: unknown
    }
  }
  readonly retryAfter?: number
}

/**
 * Host bridge injected by the stdio binary entrypoint.
 * Allows src/mcp to run against any BoardClient (Mode 0..4) without importing host composition modules.
 */
export interface McpHostBridge {
  /** Opens and returns a connected BoardClient for this MCP session. */
  connect(req?: McpConnectRequest): Promise<BoardClient>
  /**
   * Optional error payload mapper for non-BoardError thrown values (e.g. Zod or SQLite errors).
   * When omitted, src/mcp maps BoardErrorLike directly and masks unknown errors as 500 internal.
   */
  formatError?: (err: unknown) => FormattedErrorPayload
  /** Environment snapshot (defaults to process.env). */
  readonly env?: Env
  /** Home directory override (defaults to os.homedir()). */
  readonly home?: string
  /** Platform override (defaults to process.platform). */
  readonly platform?: NodeJS.Platform
  /** POSIX uid override (defaults to process.getuid?.() ?? null). */
  readonly uid?: number | null
  /** Optional custom claim-cache directory (useful for isolated tests). */
  readonly claimsDir?: string | null
  /** Diagnostic log sink — MUST write to stderr or a test buffer, NEVER stdout. */
  readonly log?: (line: string) => void
}
