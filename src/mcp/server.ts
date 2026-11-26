// Zero-dependency stdio MCP JSON-RPC 2.0 server (Swarmboard v2 launch design §3.3).
// Speaks MCP protocol versions 2024-11-05 and 2025-03-26 over NDJSON or Content-Length stdio frames.
// Never writes diagnostics to stdout (all diagnostics go through bridge.log -> stderr).
import type { BoardClient } from '../client/client.ts'
import { clientError, errorPayload, isBoardError } from '../client/errors.ts'
import { CLIENT_VERSION } from '../client/version.ts'
import type { FormattedErrorPayload, McpConnectRequest, McpHostBridge } from './bridge.ts'
import { ClaimCache, deriveBoardKey } from './claim-cache.ts'
import {
  encodeFrame,
  FrameParser,
  JSONRPC_ERRORS,
  JSONRPC_VERSION,
  jsonRpcError,
  jsonRpcResult,
  type FramingMode,
  type JsonRpcId,
  type JsonRpcResponse,
} from './framing.ts'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PRESENCE_TTL_S,
  PresenceManager,
  type ClientInfo,
} from './presence.ts'
import { callMcpTool, MCP_TOOL_NAMES, MCP_TOOLS, WAIT_CAP_S } from './tools.ts'

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-03-26', '2024-11-05'] as const)
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

const SERVER_INSTRUCTIONS =
  'Swarmboard multi-agent board. Start non-trivial turns with board_inbox. ' +
  'Use board_wait (hard-capped at 20 s) to wait for @mentions/@groups/DMs, ' +
  'board_task_claim + board_task_update for tasks (claim tokens cached automatically), ' +
  'and board_feedback to file bugs or UX notes in meta/feedback.'

export interface McpServerOptions {
  readonly bridge: McpHostBridge
  readonly connectRequest?: McpConnectRequest
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  readonly waitCapS?: number
  readonly heartbeatIntervalMs?: number
  readonly presenceTtlS?: number
  readonly autoPresence?: boolean
  readonly maxFrameBytes?: number
  readonly serverVersion?: string
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidJsonRpcId(v: unknown): v is JsonRpcId {
  return v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
}

function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested
  }
  return LATEST_PROTOCOL_VERSION
}

function extractClientInfo(params: unknown): ClientInfo | undefined {
  if (!isPlainRecord(params)) return undefined
  const raw = params['clientInfo']
  if (!isPlainRecord(raw)) return undefined
  const name = typeof raw['name'] === 'string' ? raw['name'] : undefined
  const version = typeof raw['version'] === 'string' ? raw['version'] : undefined
  if (name === undefined && version === undefined) return undefined
  return { ...(name !== undefined ? { name } : {}), ...(version !== undefined ? { version } : {}) }
}

export class McpServer {
  readonly #bridge: McpHostBridge
  readonly #connectReq: McpConnectRequest | undefined
  readonly #input: NodeJS.ReadableStream | undefined
  readonly #output: NodeJS.WritableStream | undefined
  readonly #waitCapS: number
  readonly #serverVersion: string
  readonly #parser: FrameParser
  readonly #presence: PresenceManager
  readonly #inFlight = new Map<string, { readonly ctrl: AbortController; readonly isWait: boolean }>()
  readonly #activeTasks = new Set<Promise<void>>()

  #client: BoardClient | null = null
  #connectPromise: Promise<BoardClient> | null = null
  #claimCache: ClaimCache | null = null
  #clientInfo: ClientInfo | undefined
  #running = false
  #shutdownPromise: Promise<void> | null = null
  #doneResolve: (() => void) | null = null
  #detachInput: (() => void) | null = null

  constructor(opts: McpServerOptions) {
    this.#bridge = opts.bridge
    this.#connectReq = opts.connectRequest
    this.#input = opts.input
    this.#output = opts.output
    this.#waitCapS = Math.min(opts.waitCapS ?? WAIT_CAP_S, WAIT_CAP_S)
    this.#serverVersion = opts.serverVersion ?? CLIENT_VERSION
    this.#parser = new FrameParser(opts.maxFrameBytes)
    this.#presence = new PresenceManager({
      env: opts.bridge.env,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      ttlS: opts.presenceTtlS ?? DEFAULT_PRESENCE_TTL_S,
      enabled: opts.autoPresence ?? true,
      log: opts.bridge.log,
    })
  }

  /** Starts reading JSON-RPC frames from `input`, resolving once EOF and clean shutdown finish. */
  run(): Promise<void> {
    if (this.#running) {
      return this.#shutdownPromise ?? Promise.resolve()
    }
    const input = this.#input
    const output = this.#output
    if (!input || !output) {
      throw clientError('invalid_request', 'McpServer.run() requires input and output streams')
    }
    this.#running = true

    return new Promise<void>((resolve) => {
      this.#doneResolve = resolve
      const onData = (chunk: Buffer | string): void => {
        if (this.#shutdownPromise !== null) return
        const frames = this.#parser.push(chunk)
        for (const frame of frames) {
          this.#dispatchFrame(frame, output)
        }
      }
      const detach = (): void => {
        if (this.#detachInput === null) return
        this.#detachInput = null
        input.off('data', onData)
        input.off('end', onEnd)
        input.off('close', onClose)
        input.off('error', onError)
        if (typeof input.pause === 'function') {
          input.pause()
        }
        const maybeUnref = (input as { unref?: () => void }).unref
        if (typeof maybeUnref === 'function') {
          maybeUnref.call(input)
        }
      }
      const finish = (abortAll: boolean): void => {
        detach()
        void this.shutdown({ abortAll })
      }
      const onEnd = (): void => {
        const trailing = this.#parser.flush()
        for (const frame of trailing) {
          this.#dispatchFrame(frame, output)
        }
        finish(false)
      }
      const onClose = (): void => {
        finish(false)
      }
      const onError = (err: Error): void => {
        this.#bridge.log?.(`[swarmboard-mcp] stdin error: ${err.message}`)
        finish(true)
      }
      this.#detachInput = detach
      input.on('data', onData)
      input.on('end', onEnd)
      input.on('close', onClose)
      input.on('error', onError)
    })
  }

  /**
   * Handles one decoded JSON-RPC message or batch directly (useful for unit tests and embedded harnesses).
   * Returns `null` for notifications (which produce no response per JSON-RPC 2.0).
   */
  async handleMessage(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(message)) {
      if (message.length === 0) {
        return jsonRpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: empty batch')
      }
      const results = await Promise.all(message.map((entry) => this.#handleSingle(entry)))
      const responses = results.filter((r): r is JsonRpcResponse => r !== null)
      return responses.length > 0 ? responses : null
    }
    return this.#handleSingle(message)
  }

  /** Gracefully aborts held waits (or all calls on signal), drains in-flight work, sets presence offline, and closes the board client. Idempotent. */
  shutdown(opts: { readonly abortAll?: boolean } = {}): Promise<void> {
    const abortAll = opts.abortAll ?? true
    if (this.#shutdownPromise !== null) {
      if (abortAll) {
        for (const entry of this.#inFlight.values()) entry.ctrl.abort()
        this.#inFlight.clear()
      }
      return this.#shutdownPromise
    }
    this.#detachInput?.()
    this.#shutdownPromise = (async () => {
      try {
        // Abort held waits immediately (and all calls on SIGINT/SIGTERM)
        for (const [key, entry] of this.#inFlight.entries()) {
          if (abortAll || entry.isWait) {
            entry.ctrl.abort()
            this.#inFlight.delete(key)
          }
        }

        // Wait for in-flight dispatch tasks to finish writing responses before closing SQLite
        if (this.#activeTasks.size > 0) {
          await Promise.race([
            Promise.allSettled([...this.#activeTasks]),
            new Promise<void>((r) => {
              const t = setTimeout(r, abortAll ? 1500 : 5000)
              if (typeof t.unref === 'function') t.unref()
            }),
          ])
        }

        for (const entry of this.#inFlight.values()) entry.ctrl.abort()
        this.#inFlight.clear()

        // If a connect() was in flight, wait for it so we can close it cleanly
        if (this.#connectPromise !== null && this.#client === null) {
          try {
            this.#client = await this.#connectPromise
          } catch {
            // Connect already failed; nothing to close.
          }
        }

        await this.#presence.stop()

        if (this.#client !== null) {
          try {
            await this.#client.close()
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            this.#bridge.log?.(`[swarmboard-mcp] client close error: ${msg}`)
          }
          this.#client = null
        }
      } finally {
        const done = this.#doneResolve
        this.#doneResolve = null
        done?.()
      }
    })()
    return this.#shutdownPromise
  }

  #dispatchFrame(
    frame: ReturnType<FrameParser['push']>[number],
    output: NodeJS.WritableStream,
  ): void {
    const task = (async () => {
      if (frame.kind === 'error') {
        this.#writeResponse(output, jsonRpcError(null, frame.code, frame.message), frame.mode)
        return
      }
      const resp = await this.handleMessage(frame.value)
      if (resp !== null) {
        this.#writeResponse(output, resp, frame.mode)
      }
    })()
    this.#activeTasks.add(task)
    void task.finally(() => {
      this.#activeTasks.delete(task)
    })
  }

  #writeResponse(output: NodeJS.WritableStream, payload: unknown, mode: FramingMode): void {
    try {
      const writableEnded = (output as { writableEnded?: boolean; destroyed?: boolean }).writableEnded === true
      const destroyed = (output as { destroyed?: boolean }).destroyed === true
      if (writableEnded || destroyed) return
      output.write(encodeFrame(payload, mode))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.#bridge.log?.(`[swarmboard-mcp] stdout write error: ${msg}`)
    }
  }

  async #ensureClient(): Promise<{ readonly client: BoardClient; readonly claimCache: ClaimCache }> {
    if (this.#client !== null && this.#claimCache !== null) {
      return { client: this.#client, claimCache: this.#claimCache }
    }
    if (this.#connectPromise === null) {
      this.#connectPromise = this.#bridge.connect(this.#connectReq)
    }
    try {
      const client = await this.#connectPromise
      this.#client = client
      if (this.#claimCache === null) {
        let actorKey = ''
        if (typeof client.me === 'function') {
          try {
            const self = await client.me()
            if (typeof self.actor === 'string' && self.actor.trim() !== '') {
              actorKey = self.actor
            }
          } catch {
            // If identity cannot be verified via me(), leave actorKey empty so ClaimCache stays memory-only (never collides on disk).
          }
        }
        this.#claimCache = new ClaimCache({
          boardKey: deriveBoardKey(client),
          actorKey,
          claimsDir: actorKey === '' ? null : this.#bridge.claimsDir,
          env: this.#bridge.env,
          home: this.#bridge.home,
          platform: this.#bridge.platform,
          uid: this.#bridge.uid,
          log: this.#bridge.log,
        })
      }
      return { client, claimCache: this.#claimCache }
    } catch (err) {
      this.#connectPromise = null
      throw err
    }
  }

  #formatError(err: unknown): FormattedErrorPayload {
    if (isBoardError(err)) return errorPayload(err)
    if (this.#bridge.formatError) return this.#bridge.formatError(err)
    return errorPayload(clientError('internal', 'internal error'))
  }

  async #handleSingle(raw: unknown): Promise<JsonRpcResponse | null> {
    if (!isPlainRecord(raw)) {
      return jsonRpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: expected JSON object')
    }
    const hasId = Object.hasOwn(raw, 'id') && raw['id'] !== undefined
    const id: JsonRpcId = hasId ? (isValidJsonRpcId(raw['id']) ? raw['id'] : null) : null
    if (hasId && !isValidJsonRpcId(raw['id'])) {
      return jsonRpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: invalid id')
    }
    if (raw['jsonrpc'] !== JSONRPC_VERSION || typeof raw['method'] !== 'string' || raw['method'].length === 0) {
      return hasId
        ? jsonRpcError(id, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: missing jsonrpc "2.0" or method')
        : null
    }

    const method = raw['method']
    const params = raw['params']

    // Notifications (no `id`) never receive a JSON-RPC response.
    if (!hasId) {
      this.#handleNotification(method, params)
      return null
    }

    const reqKey = String(id)
    const ctrl = new AbortController()
    const isWaitCall =
      method === 'tools/call' &&
      isPlainRecord(params) &&
      (params['name'] === 'board_wait' ||
        (params['name'] === 'board_task_claim' &&
          isPlainRecord(params['arguments']) &&
          (typeof params['arguments']['wait'] === 'number' || typeof params['arguments']['timeoutS'] === 'number')))
    this.#inFlight.set(reqKey, { ctrl, isWait: isWaitCall })

    try {
      switch (method) {
        case 'initialize': {
          const clientInfo = extractClientInfo(params)
          if (clientInfo) this.#clientInfo = clientInfo
          const protocolVersion = negotiateProtocolVersion(
            isPlainRecord(params) ? params['protocolVersion'] : undefined,
          )
          const { client } = await this.#ensureClient()
          await this.#presence.start(client, this.#clientInfo)
          return jsonRpcResult(id, {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: 'swarmboard-mcp',
              version: this.#serverVersion,
            },
            instructions: SERVER_INSTRUCTIONS,
          })
        }

        case 'ping':
          return jsonRpcResult(id, {})

        case 'tools/list':
          return jsonRpcResult(id, { tools: MCP_TOOLS })

        case 'tools/call': {
          if (!isPlainRecord(params) || typeof params['name'] !== 'string' || params['name'].length === 0) {
            return jsonRpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid params: tools/call requires tool "name"')
          }
          const toolName = params['name']
          if (!MCP_TOOL_NAMES.has(toolName)) {
            return jsonRpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${toolName}`)
          }
          const toolArgs = params['arguments']
          if (toolArgs !== undefined && toolArgs !== null && !isPlainRecord(toolArgs)) {
            return jsonRpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid params: "arguments" must be an object')
          }

          try {
            const { client, claimCache } = await this.#ensureClient()
            await this.#presence.start(client, this.#clientInfo)
            const result = await callMcpTool(toolName, toolArgs ?? {}, {
              client,
              claimCache,
              presence: this.#presence,
              signal: ctrl.signal,
              waitCapS: this.#waitCapS,
            })
            return jsonRpcResult(id, {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result),
                },
              ],
            })
          } catch (err) {
            const formatted = this.#formatError(err)
            const errorBody = {
              error: {
                status: formatted.status,
                ...formatted.payload.error,
                ...(formatted.retryAfter !== undefined ? { retryAfter: formatted.retryAfter } : {}),
              },
            }
            return jsonRpcResult(id, {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(errorBody),
                },
              ],
            })
          }
        }

        default:
          return jsonRpcError(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`)
      }
    } catch (err) {
      const formatted = this.#formatError(err)
      return jsonRpcError(id, JSONRPC_ERRORS.INTERNAL_ERROR, formatted.payload.error.message, {
        status: formatted.status,
        ...formatted.payload.error,
        ...(formatted.retryAfter !== undefined ? { retryAfter: formatted.retryAfter } : {}),
      })
    } finally {
      this.#inFlight.delete(reqKey)
    }
  }

  #handleNotification(method: string, params: unknown): void {
    if (method === 'notifications/cancelled' && isPlainRecord(params) && params['requestId'] !== undefined) {
      const key = String(params['requestId'])
      const entry = this.#inFlight.get(key)
      if (entry) {
        entry.ctrl.abort()
        this.#inFlight.delete(key)
      }
    }
    // notifications/initialized and other client notifications require no response.
  }
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  return new McpServer(opts)
}
