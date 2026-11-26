// Auto-presence lifecycle manager for swarmboard-mcp (Swarmboard v2 launch design §3.3).
// Sets status 'active' on initialize (with harness/model from env + clientInfo),
// refreshes every 60 s via an .unref() timer, preserves explicit board_presence updates,
// and sets status 'offline' cleanly on stdin EOF / shutdown.
import type { BoardClient } from '../client/client.ts'
import type { Env } from '../client/resolve.ts'

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000
export const DEFAULT_PRESENCE_TTL_S = 120
const OFFLINE_TIMEOUT_MS = 2_000

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g

export interface ClientInfo {
  readonly name?: string
  readonly version?: string
}

export type PresenceStatus = 'active' | 'busy' | 'idle' | 'offline'

export interface PresenceStateInput {
  readonly status?: PresenceStatus
  readonly channel?: string | null
  readonly taskId?: string | number | null
  readonly note?: string | null
  readonly harness?: string
  readonly model?: string
  readonly ttlS?: number
}

export interface PresenceManagerOptions {
  readonly env?: Env
  readonly heartbeatIntervalMs?: number
  readonly ttlS?: number
  readonly enabled?: boolean
  readonly log?: (line: string) => void
}

function sanitizeToken(raw: string | undefined, maxLen: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw.replace(CONTROL_CHARS, ' ').trim()
  if (cleaned.length === 0) return undefined
  return cleaned.slice(0, maxLen)
}

export class PresenceManager {
  readonly #env: Env
  readonly #heartbeatIntervalMs: number
  readonly #defaultTtlS: number
  readonly #enabled: boolean
  readonly #log: ((line: string) => void) | undefined

  #client: BoardClient | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  #started = false
  #startPromise: Promise<void> | null = null
  #stopped = false

  #harness: string | undefined
  #model: string | undefined
  #status: PresenceStatus = 'active'
  #channel: string | null | undefined = undefined
  #taskId: string | null | undefined = undefined
  #note: string | null | undefined = undefined
  #ttlS: number

  constructor(opts: PresenceManagerOptions = {}) {
    this.#env = opts.env ?? process.env
    this.#heartbeatIntervalMs = Math.max(50, opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)
    this.#defaultTtlS = Math.max(15, Math.min(3600, Math.floor(opts.ttlS ?? DEFAULT_PRESENCE_TTL_S)))
    this.#ttlS = this.#defaultTtlS
    this.#enabled = opts.enabled ?? true
    this.#log = opts.log
    this.#harness = sanitizeToken(this.#env['SWARMBOARD_HARNESS'], 64)
    this.#model = sanitizeToken(this.#env['SWARMBOARD_MODEL'], 128)
  }

  /** Effective harness label (env SWARMBOARD_HARNESS takes precedence over clientInfo.name). */
  get harness(): string | undefined {
    return this.#harness
  }

  /** Effective model label (from env SWARMBOARD_MODEL or explicit setPresence). */
  get model(): string | undefined {
    return this.#model
  }

  /** Records clientInfo from MCP initialize (only fills harness if env did not specify one). */
  setClientInfo(clientInfo?: ClientInfo): void {
    if (!this.#harness && clientInfo?.name) {
      this.#harness = sanitizeToken(clientInfo.name, 64)
    }
  }

  /** Marks the agent active on the board and starts the .unref() heartbeat timer. */
  async start(client: BoardClient, clientInfo?: ClientInfo): Promise<void> {
    this.#client = client
    this.setClientInfo(clientInfo)
    if (!this.#enabled || this.#stopped) return
    if (this.#startPromise !== null) return this.#startPromise
    this.#started = true
    this.#status = 'active'

    this.#startPromise = (async () => {
      await this.#pushBestEffort()
      if (this.#stopped) return

      this.#timer = setInterval(() => {
        if (this.#stopped || this.#status === 'offline') return
        void this.#pushBestEffort()
      }, this.#heartbeatIntervalMs)
      if (typeof this.#timer.unref === 'function') {
        this.#timer.unref()
      }
    })()
    return this.#startPromise
  }

  /**
   * Explicit presence update triggered by `board_presence({ action: 'set', ... })`.
   * Throws on board error (so the tool call reports real errors) and updates tracked heartbeat state.
   */
  async set(client: BoardClient, input: PresenceStateInput): Promise<Awaited<ReturnType<BoardClient['presence']['set']>>> {
    this.#client = client
    const nextStatus = input.status ?? this.#status
    const nextHarness = sanitizeToken(input.harness, 64) ?? this.#harness
    const nextModel = sanitizeToken(input.model, 128) ?? this.#model
    const nextTtlS = input.ttlS ?? this.#ttlS
    const nextChannel = input.channel !== undefined ? input.channel : this.#channel
    const nextTaskId =
      input.taskId !== undefined ? (input.taskId === null ? null : String(input.taskId)) : this.#taskId
    const nextNote = input.note !== undefined ? input.note : this.#note

    const body = {
      status: nextStatus,
      ttlS: nextTtlS,
      ...(nextChannel !== undefined ? { channel: nextChannel } : {}),
      ...(nextTaskId !== undefined ? { taskId: nextTaskId } : {}),
      ...(nextNote !== undefined ? { note: nextNote } : {}),
      ...(nextHarness !== undefined ? { harness: nextHarness } : {}),
      ...(nextModel !== undefined ? { model: nextModel } : {}),
    }

    const view = await client.presence.set(body)

    this.#status = nextStatus
    this.#harness = nextHarness
    this.#model = nextModel
    this.#ttlS = nextTtlS
    this.#channel = nextChannel
    this.#taskId = nextTaskId
    this.#note = nextNote

    return view
  }

  /** Stops the heartbeat timer and sets presence to 'offline' best-effort before client close. */
  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    if (!this.#enabled || !this.#started || this.#client === null || this.#client.raw.closed) return

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), OFFLINE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      await this.#client.presence.set(
        {
          status: 'offline',
          ttlS: 15,
          ...(this.#harness !== undefined ? { harness: this.#harness } : {}),
          ...(this.#model !== undefined ? { model: this.#model } : {}),
        },
        { signal: ctrl.signal },
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.#log?.(`[swarmboard-mcp] presence offline update skipped: ${msg}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async #pushBestEffort(): Promise<void> {
    if (this.#client === null || this.#client.raw.closed) return
    try {
      await this.#client.presence.set({
        status: this.#status,
        ttlS: this.#ttlS,
        ...(this.#channel !== undefined ? { channel: this.#channel } : {}),
        ...(this.#taskId !== undefined ? { taskId: this.#taskId } : {}),
        ...(this.#note !== undefined ? { note: this.#note } : {}),
        ...(this.#harness !== undefined ? { harness: this.#harness } : {}),
        ...(this.#model !== undefined ? { model: this.#model } : {}),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.#log?.(`[swarmboard-mcp] presence heartbeat skipped: ${msg}`)
    }
  }
}
