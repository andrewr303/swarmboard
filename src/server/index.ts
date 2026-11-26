// Public barrel for Swarmboard HTTP/SSE server layer (HOST-9).
export { createServerHandler, DEFAULT_HTTP_MAX_WAIT_S, DEFAULT_MAX_BODY_BYTES } from './router.ts'
export { WriteQueue, DEFAULT_WRITE_QUEUE_MAX, type WriteQueueOptions, type WriteQueueStats } from './write-queue.ts'
export {
  RealtimeHub,
  DEFAULT_SSE_KEEPALIVE_MS,
  DEFAULT_SSE_MAX_DURATION_MS,
  type RealtimeHubOptions,
  type SseCategory,
  type StreamFilters,
} from './realtime-hub.ts'
export { attachNodeHandler, createNodeHttpServer, type NodeAdapterOptions } from './node-adapter.ts'
export { createUiHandler, getUiBundleStats, UI_CSP_HEADER } from './ui.ts'
export type {
  DaemonHelloPayload,
  ServerAuthenticator,
  ServerAuthResult,
  ServerControlHooks,
  ServerHandler,
  ServerHandlerOptions,
  ServerIssueTokenRequest,
  ServerListenerClass,
  ServerListenerContext,
  ServerListenerScope,
  ServerTokenIssuer,
  ServerTokenRecord,
  ServerTokenStore,
  UiHandler,
} from './types.ts'
