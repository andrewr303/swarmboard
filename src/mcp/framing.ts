// Zero-dependency JSON-RPC 2.0 stdio framing (Swarmboard v2 launch design §3.3).
// Accepts BOTH newline-delimited JSON (NDJSON, MCP 2024-11-05 / 2025-03-26 standard)
// AND LSP-style `Content-Length: <N>\r\n\r\n<json>` frames on the same byte stream,
// replying in the framing mode spoken by the client.

export const JSONRPC_VERSION = '2.0' as const

export const JSONRPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const)

export type FramingMode = 'ndjson' | 'content-length'

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly result: unknown
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly error: {
    readonly code: number
    readonly message: string
    readonly data?: unknown
  }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

export type ParsedFrame =
  | { readonly kind: 'message'; readonly mode: FramingMode; readonly value: unknown }
  | { readonly kind: 'error'; readonly mode: FramingMode; readonly code: number; readonly message: string }

/** Maximum byte size accepted for a single JSON-RPC frame (16 MiB). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
/** Maximum header block bytes for Content-Length framing (16 KiB). */
const MAX_HEADER_BYTES = 16 * 1024

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result }
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  }
}

/** Encodes a JSON-RPC message (or batch) in either NDJSON or Content-Length framing. */
export function encodeFrame(payload: unknown, mode: FramingMode = 'ndjson'): Buffer {
  const json = JSON.stringify(payload)
  if (mode === 'content-length') {
    const body = Buffer.from(json, 'utf8')
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
    return Buffer.concat([header, body])
  }
  return Buffer.from(`${json}\n`, 'utf8')
}

function findHeaderEnd(buf: Buffer): { readonly headerEnd: number; readonly sepLen: number } | null {
  const crlf = buf.indexOf('\r\n\r\n')
  const lf = buf.indexOf('\n\n')
  if (crlf === -1 && lf === -1) return null
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { headerEnd: crlf, sepLen: 4 }
  return { headerEnd: lf, sepLen: 2 }
}

function isHeaderPrefix(buf: Buffer): boolean {
  // Check if the trimmed start of the buffer looks like a Content-Length / Content-Type header
  // (never starts with `{`, `[`, `"`, etc. which are JSON tokens).
  if (buf.length === 0) return false
  const first = buf[0]!
  // ASCII letters only (e.g. 'C' for Content-Length / Content-Type)
  if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) return false
  const sample = buf.subarray(0, Math.min(buf.length, 64)).toString('ascii')
  // Either partial prefix of "content-length:" / "content-type:" or a header line containing ":"
  const lower = sample.toLowerCase()
  if ('content-length:'.startsWith(lower) || 'content-type:'.startsWith(lower)) return true
  return /^[a-z][a-z0-9-]*\s*:/i.test(sample)
}

function parseContentLength(headerText: string): number | null {
  let contentLength: number | null = null
  for (const rawLine of headerText.split(/\r?\n/)) {
    const idx = rawLine.indexOf(':')
    if (idx === -1) continue
    const name = rawLine.slice(0, idx).trim().toLowerCase()
    if (name !== 'content-length') continue
    const val = rawLine.slice(idx + 1).trim()
    if (!/^\d+$/.test(val)) return null
    const parsed = Number(val)
    if (!Number.isSafeInteger(parsed) || parsed < 0) return null
    contentLength = parsed
  }
  return contentLength
}

/**
 * Incremental byte-stream frame parser supporting both NDJSON and `Content-Length` framing.
 */
export class FrameParser {
  #buf: Buffer = Buffer.alloc(0)
  #maxFrameBytes: number
  #lastMode: FramingMode = 'ndjson'

  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.#maxFrameBytes = maxFrameBytes
  }

  /** Most recently observed client framing mode (defaults to `'ndjson'`). */
  get detectedMode(): FramingMode {
    return this.#lastMode
  }

  /** Appends an incoming chunk and returns all complete frames (or parse errors). */
  push(chunk: Buffer | string): ParsedFrame[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (incoming.length === 0) return []
    this.#buf = this.#buf.length === 0 ? incoming : Buffer.concat([this.#buf, incoming])
    return this.#drain(false)
  }

  /** Flushes any trailing buffered NDJSON frame on stream EOF. */
  flush(): ParsedFrame[] {
    return this.#drain(true)
  }

  #skipLeadingEmptyLines(): void {
    let i = 0
    while (i < this.#buf.length) {
      const b = this.#buf[i]!
      if (b === 0x0a || b === 0x0d || b === 0x20 || b === 0x09) {
        i += 1
      } else {
        break
      }
    }
    if (i > 0) this.#buf = this.#buf.subarray(i)
  }

  #drain(eof: boolean): ParsedFrame[] {
    const out: ParsedFrame[] = []

    for (;;) {
      this.#skipLeadingEmptyLines()
      if (this.#buf.length === 0) break

      if (isHeaderPrefix(this.#buf)) {
        const headerLoc = findHeaderEnd(this.#buf)
        if (headerLoc === null) {
          if (this.#buf.length > MAX_HEADER_BYTES || eof) {
            this.#buf = Buffer.alloc(0)
            this.#lastMode = 'content-length'
            out.push({
              kind: 'error',
              mode: 'content-length',
              code: JSONRPC_ERRORS.PARSE_ERROR,
              message: 'Malformed or oversized Content-Length header',
            })
          }
          break
        }
        if (headerLoc.headerEnd > MAX_HEADER_BYTES) {
          this.#buf = Buffer.alloc(0)
          this.#lastMode = 'content-length'
          out.push({
            kind: 'error',
            mode: 'content-length',
            code: JSONRPC_ERRORS.INVALID_REQUEST,
            message: 'Header exceeds maximum size',
          })
          break
        }
        const headerText = this.#buf.subarray(0, headerLoc.headerEnd).toString('ascii')
        const bodyStart = headerLoc.headerEnd + headerLoc.sepLen
        const contentLength = parseContentLength(headerText)
        this.#lastMode = 'content-length'
        if (contentLength === null) {
          this.#buf = this.#buf.subarray(bodyStart)
          out.push({
            kind: 'error',
            mode: 'content-length',
            code: JSONRPC_ERRORS.PARSE_ERROR,
            message: 'Missing or invalid Content-Length header',
          })
          continue
        }
        if (contentLength > this.#maxFrameBytes) {
          this.#buf = Buffer.alloc(0)
          out.push({
            kind: 'error',
            mode: 'content-length',
            code: JSONRPC_ERRORS.INVALID_REQUEST,
            message: `Frame exceeds maximum size of ${this.#maxFrameBytes} bytes`,
          })
          break
        }
        const frameEnd = bodyStart + contentLength
        if (this.#buf.length < frameEnd) {
          if (eof) {
            this.#buf = Buffer.alloc(0)
            out.push({
              kind: 'error',
              mode: 'content-length',
              code: JSONRPC_ERRORS.PARSE_ERROR,
              message: 'Truncated Content-Length frame at EOF',
            })
          }
          break
        }
        const bodyText = this.#buf.subarray(bodyStart, frameEnd).toString('utf8')
        this.#buf = this.#buf.subarray(frameEnd)
        out.push(this.#parseJson(bodyText, 'content-length'))
        continue
      }

      // NDJSON framing: wait for '\n' (or EOF)
      const nl = this.#buf.indexOf(0x0a)
      if (nl === -1) {
        if (this.#buf.length > this.#maxFrameBytes) {
          this.#buf = Buffer.alloc(0)
          out.push({
            kind: 'error',
            mode: 'ndjson',
            code: JSONRPC_ERRORS.INVALID_REQUEST,
            message: `Frame exceeds maximum size of ${this.#maxFrameBytes} bytes`,
          })
          break
        }
        if (!eof) break
        const line = this.#buf.toString('utf8').trim()
        this.#buf = Buffer.alloc(0)
        if (line.length === 0) break
        this.#lastMode = 'ndjson'
        out.push(this.#parseJson(line, 'ndjson'))
        break
      }

      if (nl > this.#maxFrameBytes) {
        this.#buf = this.#buf.subarray(nl + 1)
        this.#lastMode = 'ndjson'
        out.push({
          kind: 'error',
          mode: 'ndjson',
          code: JSONRPC_ERRORS.INVALID_REQUEST,
          message: `Frame exceeds maximum size of ${this.#maxFrameBytes} bytes`,
        })
        continue
      }

      const line = this.#buf.subarray(0, nl).toString('utf8').replace(/\r$/, '').trim()
      this.#buf = this.#buf.subarray(nl + 1)
      if (line.length === 0) continue
      this.#lastMode = 'ndjson'
      out.push(this.#parseJson(line, 'ndjson'))
    }

    return out
  }

  #parseJson(text: string, mode: FramingMode): ParsedFrame {
    try {
      const value: unknown = JSON.parse(text)
      return { kind: 'message', mode, value }
    } catch {
      return {
        kind: 'error',
        mode,
        code: JSONRPC_ERRORS.PARSE_ERROR,
        message: 'Parse error: invalid JSON',
      }
    }
  }
}
