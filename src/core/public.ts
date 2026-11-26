// The transport and package surface (HOST0_DESIGN 3.9): what src/server, src/client, src/mcp and src/cli and
// package consumers (tsdown's `core` entry) get. index.ts is the in-repo barrel (tests, src/host) and also
// carries nine legacy internals; internal.ts carries the rest. A new export here means a reviewed edit of
// tests/core/host0/public-surface.allow.json.
export * from './errors.ts'
export * from './schemas.ts'
export * from './storage.ts'
export { SqliteUnifiedStore, TASKS_SCHEMA_VERSION, type SqliteStoreOptions } from './sqlite-store.ts'
export * from './board-service.ts'
export * from './tasks/bodies.ts'
export {
  foldTask,
  isTaskEventType,
  TASK_EVENT_TYPES,
  type FoldRoot,
  type TaskEventLike,
  type TaskEventType,
  identityOf,
  type Identity,
  type PlannedTaskEvent,
  type PostedRoot,
  type TaskRootInput,
  type TaskHost,
  type TaskRootOption,
  type RebuildResult,
  isFinished,
  isLapsed,
  isTerminal,
  stateNow,
  TASK_STATES,
  toTaskView,
  type TaskRow,
  TaskService,
  type TaskCapabilities,
  type TaskServiceOptions,
  batchAskedId,
  batchDigest,
  batchPlan,
  batchRootId,
  derivedId,
  type BatchNeed,
  type BatchTask,
  type DigestTask,
  type CreatedTasks,
  type ClaimedNext,
  RESERVED_HOLD_KINDS,
  type CandidateQuery,
  type CandidateTerm,
  type LapseAnswer,
  type TaskApplied,
  type TaskHook,
  type TaskOp,
  type TaskPlan,
  type TaskTx,
  type ExpireRun,
} from './tasks/index.ts'
export type { JsonlAudit } from './jsonl-audit.ts'
export { SCHEMA_VERSION, BOARD_ID_PATTERN, INSTANCE_ID_PATTERN, type SchemaGate } from './migrations.ts'
