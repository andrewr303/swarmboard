// Server structural interfaces (HOST-9, Swarmboard v2 launch design §4.2).
// Strictly decoupled from the host composition layer (F-1 / HS-01): authenticators, token stores,
// control hooks, and UI handlers are injected structurally by the composition root.
import type {
  Assurance,
  BoardService,
  CallerContext,
  CanSpec,
  Permission,
} from '../core/public.ts'
import type { WriteQueue } from './write-queue.ts'
import type { RealtimeHub } from './realtime-hub.ts'

export type ServerListenerClass = 'uds' | 'pipe' | 'tcp-loopback' | 'tailscale' | 'https'
export type ServerListenerScope = 'local' | 'lan' | 'remote'

export interface ServerListenerContext {
  readonly listener: ServerListenerClass
  readonly port?: number
  readonly allowHosts?: readonly string[]
  readonly tailscaleHost?: string
  readonly boardUrl?: string
}

export interface ServerTokenRecord {
  readonly id: string
  readonly principalId: string
  readonly profile: string | null
  readonly assurance: Assurance
  readonly cap: readonly Permission[]
  readonly canHeader: string | null
  readonly listenerScope: ServerListenerScope
  readonly delegationDepth: number
  readonly issuedBy: string
  readonly note: string | null
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly revokedAt: string | null
  readonly lastUsedAt: string | null
}

export interface ServerIssueTokenRequest {
  readonly principalId?: string
  readonly profile?: string | null
  readonly assurance?: Assurance
  readonly owner?: boolean
  readonly cap?: readonly Permission[]
  readonly can?: CanSpec | string | null
  readonly listenerScope?: ServerListenerScope
  readonly ttlS?: number | null
  readonly note?: string | null
}

export type ServerTokenIssuer =
  | { readonly kind: 'caller'; readonly caller: CallerContext }
  | { readonly kind: 'token'; readonly token: ServerTokenRecord }
  | CallerContext

export interface ServerTokenStore {
  issueToken(
    issuer: ServerTokenIssuer,
    req?: ServerIssueTokenRequest,
  ): { readonly token: string; readonly record: ServerTokenRecord }
  listTokens(filter?: {
    readonly principalId?: string
    readonly includeRevoked?: boolean
    readonly includeExpired?: boolean
    readonly limit?: number
  }): ServerTokenRecord[]
  revokeToken(
    id: string,
    opts?: { readonly actor?: CallerContext | ServerTokenRecord },
  ): ServerTokenRecord
  getToken(id: string): ServerTokenRecord | null
}

export interface ServerAuthResult {
  readonly caller: CallerContext
  readonly listener: ServerListenerClass
  readonly authMethod: 'bearer-token' | 'os-user' | 'session-cookie' | 'loopback-ui' | 'tailscale' | 'oidc'
  readonly tokenId: string | null
  readonly tokenRecord: ServerTokenRecord | null
}

export interface ServerAuthenticator {
  readonly tokens?: ServerTokenStore
  authenticate(req: Request, ctx: ServerListenerContext): Promise<ServerAuthResult>
  mintLoginCode?(opts?: {
    readonly ttlMs?: number
    readonly assurance?: 'local_unverified' | 'human_verified'
  }): { readonly code: string; readonly expiresAt: string }
  exchangeLoginCode?(
    code: string,
    opts?: { readonly sessionTtlMs?: number; readonly secure?: boolean },
  ): { readonly sessionId: string; readonly cookieHeader: string; readonly expiresAt: string }
  revokeSession?(sessionId: string): boolean
}

export interface DaemonHelloPayload {
  readonly protocol: readonly [number, number]
  readonly build: string
  readonly pid: number
  readonly nonce: string
  readonly boardId: string | null
  readonly instanceId: string | null
  readonly schema: number
  readonly db: { readonly realpath: string; readonly dev: number; readonly ino: number }
  readonly sidecars: { readonly wakeup: string; readonly jsonl: string }
  readonly tcp: { readonly host: string; readonly port: number } | null
  readonly startedAt: string
  readonly idleExitS: number
  readonly capabilities: readonly string[]
}

export interface ServerControlHooks {
  readonly hello?: () => DaemonHelloPayload
  readonly status?: () => Record<string, unknown>
  readonly retire?: (reason?: string) => Promise<{ readonly retiring: true }> | { readonly retiring: true }
  readonly listenTcp?: (opts?: {
    readonly host?: string
    readonly port?: number
  }) => Promise<{ readonly host: string; readonly port: number; readonly url: string }>
  readonly onActivity?: () => void
}

export type UiHandler = (
  req: Request,
  ctx: ServerListenerContext,
) => Response | null | Promise<Response | null>

export interface ServerHandlerOptions {
  readonly board: BoardService
  readonly authenticator: ServerAuthenticator
  readonly writeQueue?: WriteQueue
  readonly realtimeHub?: RealtimeHub
  readonly control?: ServerControlHooks
  readonly uiHandler?: UiHandler
  readonly mode?: 'daemon' | 'service' | 'remote'
  readonly startedAtMs?: number
  readonly maxBodyBytes?: number
  readonly maxWaitS?: number
  readonly sseKeepAliveMs?: number
  readonly sseMaxDurationMs?: number
  readonly now?: () => number
}

export type ServerHandler = ((req: Request, ctx: ServerListenerContext) => Promise<Response>) & {
  readonly queue: WriteQueue
  readonly hub: RealtimeHub
  close(): void
}
