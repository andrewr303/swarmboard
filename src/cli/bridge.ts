// Thin injected host bridge contract for the CLI (Swarmboard v2 launch design §3.2).
// Boundary invariant: zero imports from core runtime or host/server layers.
import type { BoardClient } from '../client/client.ts'
import type { Env, Resolution, ResolveFlags } from '../client/resolve.ts'
import type { Assurance, Mode } from '../client/types.ts'
import type { Permission } from '../core/public.ts'

/** Verbatim same-uid trust disclosure required in `swarmboard doctor` (HOSTING_PLANS.md:622-624). */
export const TRUST_DISCLOSURE =
  'Modes 0-3 give attribution and accident prevention among agents that run as your OS user. They do not isolate those agents from each other. For isolation, run agents sandboxed with only the socket mounted, as other OS users, or against a remote board.'

export interface CliIo {
  stdout(text: string): void
  stderr(text: string): void
  readStdin(): Promise<string>
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
  readonly signal?: AbortSignal
}

export interface CliGlobalFlags {
  readonly board?: string
  readonly db?: string
  readonly url?: string
  readonly mode?: 'auto' | 'file' | 'daemon' | 'service'
  readonly as?: string
  readonly allowUnsafeFs?: boolean
  readonly json: boolean
  readonly compact: boolean
  readonly noColor: boolean
  readonly help: boolean
  readonly version: boolean
}

export interface CliBridgeContext {
  readonly flags: ResolveFlags
  readonly env: Env
  readonly cwd: string
  readonly isTTY: boolean
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
}

export interface InitBoardResult {
  readonly client: BoardClient
  readonly db: string | null
  readonly created: boolean
  readonly boardId: string | null
  readonly instanceId: string | null
  readonly schemaVersion: number
  readonly mode: Mode
}

export interface DaemonStatusInfo {
  readonly running: boolean
  readonly pid?: number | null
  readonly boardId?: string | null
  readonly instanceId?: string | null
  readonly socketPath?: string | null
  readonly tcpUrl?: string | null
  readonly mode?: string | null
  readonly uptimeMs?: number | null
  readonly streams?: number | null
  readonly queueDepth?: number | null
  readonly logPath?: string | null
  readonly idleExitS?: number | null
  readonly note?: string
}

export interface DaemonControlRequest {
  readonly action: 'start' | 'stop' | 'status' | 'restart' | 'logs'
  readonly tcp?: boolean
  readonly host?: string
  readonly port?: number
  readonly noIdleExit?: boolean
  readonly lines?: number
}

export interface DaemonControlResult {
  readonly action: DaemonControlRequest['action']
  readonly ok: boolean
  readonly status?: DaemonStatusInfo
  readonly logs?: readonly string[]
  readonly message?: string
}

export interface ServeRequest {
  readonly host: string
  readonly port: number
  readonly noIdleExit: boolean
  readonly open: boolean
  readonly tailscaleHost?: string
  readonly allowHosts?: readonly string[]
  readonly signal?: AbortSignal
  readonly onReady?: (info: ServeReadyInfo) => void
}

export interface ServeReadyInfo {
  readonly url: string
  readonly socketPath: string | null
  readonly boardId: string | null
  readonly instanceId: string | null
  readonly mode: string
  readonly loginUrl?: string
}

export interface ServeResult {
  readonly url: string
  readonly socketPath: string | null
  readonly stopped: boolean
}

export interface OpenUiRequest {
  readonly host: string
  readonly port: number
  readonly noBrowser?: boolean
}

export interface OpenUiResult {
  readonly url: string
  readonly loginUrl?: string
  readonly expiresAt?: string
  readonly opened: boolean
  readonly pid?: number | null
}

export interface BackupResult {
  readonly sourceDb: string
  readonly destDb: string
  readonly jsonlSource: string | null
  readonly jsonlDest: string | null
  readonly jsonlCopied: boolean
  readonly bytes: number
  readonly integrityOk: boolean
}

export interface TickResult {
  readonly outcome: string
  readonly at: number
  readonly holder: string | null
  readonly fence: number | null
  readonly takeover: boolean
  readonly lost: boolean
  readonly schedules: {
    readonly sent: readonly string[]
    readonly skipped: readonly string[]
    readonly failed: readonly { readonly schedule: string; readonly code: string }[]
    readonly stopped: boolean
  } | null
  readonly claims: {
    readonly expired: readonly number[]
    readonly held: readonly number[]
    readonly failed: readonly { readonly task: number; readonly code: string }[]
    readonly backlog: boolean
  } | null
  readonly clockJump: boolean
  readonly skew: boolean
  readonly nextDelayMs: number
}

export interface PortCheck {
  readonly port: number
  readonly host: string
  readonly inUse: boolean
  readonly swarmboard?: boolean
  readonly note?: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly version: string
  readonly target: Resolution['target']
  readonly source: string
  readonly modePolicy: string
  readonly authEnforce: boolean
  readonly identity: {
    readonly profile: string | null
    readonly profileSource: string | null
    readonly token: 'set' | 'unset'
    readonly tokenSource: string | null
  }
  readonly configs: {
    readonly project: string | null
    readonly user: string | null
  }
  readonly board: {
    readonly exists: boolean
    readonly boardId: string | null
    readonly instanceId: string | null
    readonly schemaVersion: number | null
    readonly expectedSchemaVersion: number
    readonly writable: boolean | null
    readonly error?: string
  }
  readonly layout: {
    readonly fsKind: string
    readonly manifest: string
    readonly walExists: boolean
    readonly shmExists: boolean
    readonly wakeupExists: boolean
    readonly jsonlExists: boolean
    readonly strays: readonly string[]
    readonly refusals: readonly { readonly reason: string; readonly path: string; readonly downgradable: boolean }[]
    readonly warnings: readonly string[]
  } | null
  readonly daemon: DaemonStatusInfo
  readonly ports: readonly PortCheck[]
  readonly fallbacks: number
  readonly warnings: readonly string[]
  readonly trustDisclosure: string
}

export interface TokenRecordView {
  readonly id: string
  readonly principalId: string
  readonly profile: string | null
  readonly assurance: Assurance
  readonly cap: readonly Permission[]
  readonly canHeader: string | null
  readonly listenerScope: 'local' | 'lan' | 'remote'
  readonly delegationDepth: number
  readonly issuedBy: string
  readonly note: string | null
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly revokedAt: string | null
  readonly lastUsedAt: string | null
}

export interface TokenIssueRequest {
  readonly profile?: string | null
  readonly cap?: readonly Permission[]
  readonly can?: string | null
  readonly listenerScope?: 'local' | 'lan' | 'remote'
  readonly ttlS?: number | null
  readonly note?: string | null
}

export interface TokenIssueResult {
  readonly token: string
  readonly record: TokenRecordView
}

export interface TokenListRequest {
  readonly includeRevoked?: boolean
  readonly includeExpired?: boolean
  readonly limit?: number
}

export interface TokenRevokeResult {
  readonly record: TokenRecordView
  readonly revoked: boolean
}

export interface LinkBinResult {
  readonly linked: readonly string[]
  readonly note?: string
}

/**
 * Injected bridge supplied by the binary entrypoint or tests.
 * Keeps `src/cli/**` strictly dependent on `src/client/**` and Node stdlib.
 */
export interface CliHostBridge {
  connect(ctx: CliBridgeContext): Promise<BoardClient>
  openForInit(ctx: CliBridgeContext): Promise<InitBoardResult>
  doctor(ctx: CliBridgeContext): Promise<DoctorReport>
  backup(ctx: CliBridgeContext, destPath: string, opts?: { readonly force?: boolean }): Promise<BackupResult>
  runTickOnce(ctx: CliBridgeContext): Promise<TickResult>
  serve(ctx: CliBridgeContext, req: ServeRequest): Promise<ServeResult>
  daemonControl(ctx: CliBridgeContext, req: DaemonControlRequest): Promise<DaemonControlResult>
  openUi(ctx: CliBridgeContext, req: OpenUiRequest): Promise<OpenUiResult>
  tokenIssue(ctx: CliBridgeContext, req: TokenIssueRequest): Promise<TokenIssueResult>
  tokenList(ctx: CliBridgeContext, req: TokenListRequest): Promise<readonly TokenRecordView[]>
  tokenRevoke(ctx: CliBridgeContext, id: string): Promise<TokenRevokeResult>
  linkBin?(ctx: CliBridgeContext): Promise<LinkBinResult>
}
