import type { Env } from './resolve.ts'

/** Collect only credential values used by the configured board and session transports. */
export function collectEnvSecrets(env: Env): string[] {
  return ['SWARMBOARD_TOKEN', 'BOARD_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN']
    .map(key => env[key]?.trim())
    .filter((value): value is string => value !== undefined && value.length >= 8)
}

/** Mask known credential formats in exported text and diagnostics. */
export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let out = text
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g, '[redacted-private-key]')
    .replace(/(?<![A-Za-z0-9_-])(sb_[a-z2-7]{12})_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '$1_[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|xai-[A-Za-z0-9_-]{16,})/g, '[redacted-key]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})/g, '[redacted-token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws-key]')
  for (const secret of extraSecrets) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]')
  }
  return out
}
