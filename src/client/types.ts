// Transport-level types (HOST123_DESIGN 3): type-only, no run-time content. The op names and shapes come from
// ./ops.ts; the core's EventsPage comes from the public surface.
import type { EventsPage, EventsQueryInput } from '../core/public.ts'
import type { OpInput, OpName, OpOutput } from './ops.ts'

export type { ModePolicy } from './config.ts'

export type Mode = 'in-process' | 'shared-file' | 'daemon' | 'service' | 'remote'
export type WakeKind = 'in-process' | 'poll' | 'fs-watch' | 'long-poll' | 'sse' | 'ws'
export type AuthKind = 'os-user' | 'bearer' | 'oidc' | 'tailscale' | 'mtls'
export type Assurance = 'human_verified' | 'agent_delegated' | 'local_unverified'

/** Always a frozen object. A transport replaces its snapshot on ready() and on a restore; never mutates one. */
export interface Capabilities {
  readonly protocol: number // PROTOCOL_VERSION
  readonly mode: Mode
  readonly transport: 'direct' | 'uds' | 'pipe' | 'tcp' | 'https'
  readonly coreVersion: string // CLIENT_VERSION of the build serving the ops
  readonly schemaVersion: number // boardInfo().schema.version, never PRAGMA user_version; 0 before ready
  readonly schemaBuild: number // boardInfo().schema.build; 0 when unknown
  readonly writable: boolean // boardInfo().schema.refused == null
  readonly boardId: string | null // null before ready(), and on a write-refused board with no identity (F20)
  readonly instanceId: string | null // null as boardId; the live one after a restore
  readonly wake: WakeKind
  readonly crossProcessWake: boolean // a held wait returns another process's commit without the caller re-polling
  readonly wakePollMs: number | null // the slowest fallback that still wakes an events wait
  readonly maxWaitS: number // 300 for Modes 0-1 (the core's limit); HOST-6 caps MCP at 20
  readonly leaseMinS: number
  readonly leaseCapS: number
  readonly leaseDefaultS: number
  readonly batchMax: number
  readonly schedules: 'owner' | 'tick-lease' | 'none'
  readonly auth: readonly AuthKind[]
  readonly assurances: readonly Assurance[]
  readonly conditionalNeeds: boolean
  readonly priorityNative: boolean
  readonly defer: boolean
  readonly resume: boolean
  readonly subtreeRead: boolean
  readonly ops: readonly OpName[]
}

export interface CallOptions {
  readonly signal?: AbortSignal
  /** Mapped to a native id on client-id ops; accepted and unused on read/natural/fenced; 400 on unsafe. */
  readonly idempotencyKey?: string
  /** undefined: the transport's base identity; null: the principal itself; string: that profile. */
  readonly as?: string | null
  /** The instanceId the caller's cursor came from; a different live instance answers 410 cursor_expired. */
  readonly expectInstance?: string
}

export type EventsFeedQuery = Omit<EventsQueryInput, 'wait'>

export interface BoardTransport {
  /** A getter: the current frozen snapshot. */
  readonly capabilities: Capabilities
  readonly closed: boolean
  call<O extends OpName>(op: O, input: OpInput<O>, opts?: CallOptions): Promise<OpOutput<O>>
  /**
   * Pages after query.after (default: the head), in log order; never drops or repeats an event the caller may read.
   * Ends on abort or close; throws 410 cursor_expired after a restore or rewind, the sticky replaced 503 after a
   * replacement, or any other refusal.
   */
  events(query: EventsFeedQuery, opts?: CallOptions): AsyncIterable<EventsPage>
  /** Aborts in-flight waits (they resolve), then releases resources. Idempotent; never throws. */
  close(): Promise<void>
}

export interface Selection {
  readonly mode: Mode
  readonly reason: string
  readonly source: string
  readonly fallback?: string
}
