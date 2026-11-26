// The in-repo barrel: public.ts (what transports and the package get) plus the nine legacy internals of
// slice A and the wakeup lock. New internals go in internal.ts, never here. Code under src/server,
// src/client, src/mcp and src/cli imports public.ts only; src/host and tests may import this file.
export * from './errors.ts'
export * from './schemas.ts'
export * from './storage.ts'
export * from './sqlite-store.ts'
export * from './board-service.ts'
export * from './tasks/index.ts'
export type { JsonlAudit } from './jsonl-audit.ts'
export { SCHEMA_VERSION, BOARD_ID_PATTERN, INSTANCE_ID_PATTERN, type SchemaGate } from './migrations.ts'
