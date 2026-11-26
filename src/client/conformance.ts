// The transport conformance contract (HOST123_DESIGN 5.8): the types a target implements and the case catalogue,
// CF-01..CF-20. Thin: type-only imports and data, no test framework, so later transports (Socket, HTTP) and external
// implementations reuse it. The runner that turns the catalogue into tests lives under tests/conformance.
import type { OpName } from './ops.ts'
import type { BoardTransport, CallOptions } from './types.ts'

/** A portable identity: Mode 0/1 targets turn it into a caller, Mode 2-4 targets into a token. */
export type IdentitySpec = {
  readonly userId: string
  readonly profile?: string
  /** The profiles `as` may name; default: `profile` alone, or none. */
  readonly profiles?: readonly string[]
  /** An x-board-can narrowing (canHeader). */
  readonly can?: string
  /** Default true. */
  readonly member?: boolean
  readonly owner?: boolean
}

export interface TargetFeatures {
  /** Another process can write the same board. */
  readonly crossProcess: boolean
  /** The transport retries 503 + retryAfter itself. */
  readonly busyRetry: boolean
  readonly lanes: boolean
  /** Replaced/restored detection. */
  readonly identityEvents: boolean
  /** Can kill a peer after COMMIT. */
  readonly crashInjection: boolean
  /** Injectable board clock. */
  readonly clock: boolean
}

export interface PeerClient {
  call(op: OpName, input: unknown, opts?: Omit<CallOptions, 'signal'>): Promise<unknown>
  crashAfterNextCommit(): Promise<void>
  /** Holds BEGIN IMMEDIATE on its own raw connection. */
  hold(ms: number): Promise<void>
  close(): Promise<void>
}

export interface ConformanceBoard {
  readonly transport: BoardTransport
  /** Same board, identity `bob` by default. */
  peer(as?: string): Promise<BoardTransport>
  /** A post committed through another connection (Mode 1: another process). */
  externalPost(channel: string, text: string): Promise<{ id: string; index: number }>
  readonly clock: { advance(ms: number): void } | null
  close(): Promise<void>
}

export interface ConformanceTarget {
  readonly name: string
  readonly features: TargetFeatures
  open(dir: string, ids: Record<string, IdentitySpec>, opts?: { busyTimeoutMs?: number; busyBudgetMs?: number }): Promise<ConformanceBoard>
  /** Required when features.crossProcess. */
  spawnPeer?(dir: string, ids: Record<string, IdentitySpec>, as: string): Promise<PeerClient>
  dispose?(): Promise<void>
}

export interface ConformanceCaseSpec {
  readonly id: `CF-${string}`
  readonly title: string
  /** Each listed feature (or the crossProcessWake capability) must be on for the case to run. */
  readonly requires: readonly (keyof TargetFeatures | 'crossProcessWake')[]
  readonly clauses: readonly string[]
}

const cases: ConformanceCaseSpec[] = [
  {
    id: 'CF-01',
    title: 'capabilities',
    requires: [],
    clauses: [
      'capabilities is a frozen object',
      'protocol equals PROTOCOL_VERSION',
      "schemaVersion equals the board's core.schema_version (boardInfo().schema.version), never PRAGMA user_version",
      'boardId matches BOARD_ID_PATTERN',
      'ops lists only registry names and includes every op the transport answers without 501',
    ],
  },
  {
    id: 'CF-02',
    title: 'reachability',
    requires: [],
    clauses: ['every op in caps.ops answers its minimal fixture input without 501 and without 400'],
  },
  {
    id: 'CF-03',
    title: 'envelope parity',
    requires: [],
    clauses: ['the bad-input table yields the same {status, code} on every target, and the core is never called for a refused input'],
  },
  {
    id: 'CF-04',
    title: 'error parity',
    requires: [],
    clauses: [
      'a core refusal keeps its status, code, message and hint',
      'a non-board failure is 500 internal "internal error" and leaks nothing of the original',
      'busy is 503 unavailable with retryAfter 1',
    ],
  },
  {
    id: 'CF-05',
    title: 'idempotency',
    requires: [],
    clauses: [
      'post, createTask and createTasks twice with one idempotencyKey return the same ids and append one set of events',
      'a key with another body is 409 duplicate_id; a refused keyed call records nothing',
      'keys are scoped per principal, profile and op; a key on an unsafe op is 400',
      'a busy-injected first attempt retried by the transport yields one set of events',
    ],
  },
  {
    id: 'CF-06',
    title: 'feed integrity',
    requires: [],
    clauses: [
      'while one consumer iterates events(), two writers (transport and peer) post 250 each',
      "the union of yielded indexes is exactly the range of the 500 posts' events, ascending, with no duplicates",
      'cursors are non-decreasing decimal strings',
    ],
  },
  {
    id: 'CF-07',
    title: 'bounded wait',
    requires: [],
    clauses: ["call('events', {wait: N}) on a quiet board returns {events: []} with the cursor at the head after ≥ N s and ≤ N s + wakePollMs + 250 ms"],
  },
  {
    id: 'CF-08',
    title: 'abort',
    requires: [],
    clauses: [
      'an aborted wait resolves its partial or empty answer within 100 ms + wakePollMs and never rejects',
      "an aborted non-wait op rejects with the signal's reason and never reaches the core",
    ],
  },
  {
    id: 'CF-09',
    title: 'cross-process wake',
    requires: ['crossProcessWake'],
    clauses: ["over 20 trials an externalPost wakes a pending events wait; p95 ≤ 50 ms when wake is 'fs-watch', ≤ wakePollMs + 50 ms otherwise"],
  },
  {
    id: 'CF-10',
    title: 'identity',
    requires: [],
    clauses: [
      "as:'w1' acts as <principal>+w1",
      'a profile outside the provider is 403 profile_mismatch with nothing written',
      'as:null acts as the principal',
      "a deployment-kind caller is 403 forbidden (accident protection, not a boundary: identity is self-asserted in Modes 0-1)",
    ],
  },
  {
    id: 'CF-11',
    title: 'close',
    requires: [],
    clauses: ['in-flight waits resolve', 'later calls reject 503 unavailable', 'close() is idempotent'],
  },
  {
    id: 'CF-12',
    title: 'output parity',
    requires: [],
    clauses: ["a scripted 30-op session's outputs are JSON-equal across two targets after replacing ids and timestamps by placeholders"],
  },
  {
    id: 'CF-13',
    title: 'token hygiene',
    requires: [],
    clauses: ['a claim token never appears in an error, in a log line, or in an event a non-claimant reads'],
  },
  {
    id: 'CF-14',
    title: 'cursor portability',
    requires: [],
    clauses: ['a cursor from transport used on peer returns the same next events'],
  },
  {
    id: 'CF-15',
    title: 'hidden = missing',
    requires: [],
    clauses: ['hidden and missing ids answer the same status, code and message (after replacing the requested id)'],
  },
  {
    id: 'CF-16',
    title: 'lanes',
    requires: ['lanes', 'crossProcess'],
    clauses: ["one identity's writes keep issue order", 'reads and waits never queue', 'laneMax sheds with 503 backpressure_shed'],
  },
  {
    id: 'CF-17',
    title: 'busy policy',
    requires: ['busyRetry'],
    clauses: ['busy 503s retry within the budget, then give up with the last error', 'an abort ends the retry', 'schema floors are never retried'],
  },
  {
    id: 'CF-18',
    title: 'identity events',
    requires: ['identityEvents'],
    clauses: ['write and read floors refuse', 'replaced is a sticky 503 and the path is poisoned for the process', 'restored answers 410 and honours expectInstance'],
  },
  {
    id: 'CF-19',
    title: 'crash replay',
    requires: ['crashInjection'],
    clauses: ['a keyed write that crashed after COMMIT replays once from another process'],
  },
  {
    id: 'CF-20',
    title: 'ported original checks',
    requires: [],
    clauses: ['the ten transport-relevant checks of the original conformance suite pass over BoardTransport.call'],
  },
]

function freezeCase(c: ConformanceCaseSpec): ConformanceCaseSpec {
  Object.freeze(c.requires)
  Object.freeze(c.clauses)
  return Object.freeze(c)
}

/** CF-01..CF-20 (HOST123_DESIGN 5.8). Frozen. */
export const CONFORMANCE_CASES: readonly ConformanceCaseSpec[] = Object.freeze(cases.map(freezeCase))
