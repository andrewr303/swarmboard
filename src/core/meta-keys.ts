// The board_meta namespaces (HOST0_DESIGN 3.4, X2). Internal: neither index.ts nor public.ts re-exports
// this module, so the package surface does not grow. `core.*` belongs to the core seams, `host.*` to
// hosts (for example `host.tick.lease`) and `fed.*` to federation. Hosts reach the table only through
// `StorageBackend.getMeta` / `casMeta`, which enforce these patterns.
import { frozenSet } from './frozen-set.ts'

/** Keys `getMeta` reads: the three namespaces. */
export const META_READABLE_KEY = /^(?:core|host|fed)\.[A-Za-z0-9_][A-Za-z0-9_.:-]{0,118}$/

/** Keys `casMeta` writes: hosts and federation only. `core.*` is written by the store's own code. */
export const META_WRITABLE_KEY = /^(?:host|fed)\.[A-Za-z0-9_][A-Za-z0-9_.:-]{0,118}$/

/** Two keys from before the namespaces that `getMeta` may read (never write). Immutable at run time too. */
export const META_READABLE_LEGACY: ReadonlySet<string> = frozenSet(['tasks_schema', 'wakeup_generation'])

/** The most UTF-8 bytes a `casMeta` value may hold. */
export const META_VALUE_MAX_BYTES = 65_536

export const META_SCHEMA_VERSION = 'core.schema_version'
export const META_WRITE_MIN = 'core.schema_write_min'
export const META_READ_MIN = 'core.schema_read_min'
export const META_BOARD_ID = 'core.board_id'
export const META_INSTANCE_ID = 'core.instance_id'
export const META_INSTANCE_FILE = 'core.instance_file'

/** The keys the store owns: `casMeta` refuses each one (defence in depth beside the pattern). Immutable at run time too. */
export const RESERVED_META_KEYS: ReadonlySet<string> = frozenSet([
  META_SCHEMA_VERSION,
  META_WRITE_MIN,
  META_READ_MIN,
  META_BOARD_ID,
  META_INSTANCE_ID,
  META_INSTANCE_FILE,
  'tasks_schema',
])
