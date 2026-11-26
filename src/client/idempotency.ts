// Idempotency keys (HOST123_DESIGN 6.2). Thin: node:crypto, ./ops.ts and ./errors.ts only.
//
// A key becomes a principal-scoped native id with the original's keyId form, `key:<principal>:<32 hex>`, on the
// client-id ops (post, createTask with a channel, createTasks). It is accepted and unused on read, natural and fenced
// ops and refused on unsafe ops. A claim token is NEVER derived from a key (hazard H-KEY): the claim fence accepts
// any holder of the token, so a token computable from a guessable key would hand the claim to whoever knows the key.
// A keyed replay of a claim uses a token the caller minted at random and kept (mintClaimToken).
import { createHash, randomBytes } from 'node:crypto'
import { clientError } from './errors.ts'
import { OPS, type OpName } from './ops.ts'

export const IDEMPOTENCY_KEY: RegExp = /^[\x21-\x7e]{1,128}$/

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * `key:${principalId}:` + sha256hex('board-key\u001f' + derivation).slice(0, 32), the derivation being
 * ['swarmboard-idem/1', op, profile ?? '', key] joined with \u001f. Scope: board (the file), principal, profile, op.
 */
export function keyedId(principalId: string, profile: string | null, op: OpName, key: string): string {
  const derived = ['swarmboard-idem/1', op, profile ?? '', key].join('\u001f')
  return `key:${principalId}:${sha256Hex(`board-key\u001f${derived}`).slice(0, 32)}`
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

/** sha256 hex (first 32) of the op and the canonical JSON of the input (sorted keys) without id, token and request. */
export function bodyDigest(op: OpName, input: unknown): string {
  const rest: Record<string, unknown> = {}
  if (input !== null && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (k !== 'id' && k !== 'token' && k !== 'request') rest[k] = v
    }
  }
  return sha256Hex(`${op}\u001f${canonical(rest)}`).slice(0, 32)
}

export type KeyUse = 'id' | 'accepted' | 'refused'

/**
 * 'id' for post, createTasks and createTask without `re`; 'accepted' for read, natural and fenced ops (and
 * createTask with `re`, whose body forbids an id); 'refused' for unsafe ops.
 */
export function keyUse(op: OpName, input: Readonly<Record<string, unknown>>): KeyUse {
  const idem = OPS[op].idem
  if (idem === 'unsafe') return 'refused'
  if (idem !== 'client-id') return 'accepted'
  if (op === 'createTask' && input['re'] !== undefined) return 'accepted'
  return 'id'
}

/** Never sets or derives `token`. Throws ClientError 400 (bad key, key with id, key on an unsafe op). */
export function applyIdempotencyKey(
  op: OpName,
  input: Record<string, unknown>,
  who: { readonly principalId: string; readonly profile: string | null },
  key: string | undefined,
): { readonly input: Record<string, unknown>; readonly nativeId: string | null } {
  if (key === undefined) return { input, nativeId: null }
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
    throw clientError('invalid_request', 'idempotencyKey: 1 to 128 printable ASCII characters, no spaces', {
      hint: 'a random string or a hash of the work is a good key',
    })
  }
  const use = keyUse(op, input)
  if (use === 'refused') {
    throw clientError('invalid_request', `idempotencyKey: ${op} has no idempotent form; a retry would write twice`, {
      hint: 'send it once, or use an op with an id',
    })
  }
  if (use === 'accepted') return { input, nativeId: null }
  if (input['id'] !== undefined) {
    throw clientError('invalid_request', 'pass an id or an idempotencyKey, not both')
  }
  const nativeId = keyedId(who.principalId, who.profile, op, key)
  return { input: { ...input, id: nativeId }, nativeId }
}

/**
 * A per-process LRU (default 4096) of nativeId to bodyDigest, recorded only for calls that SUCCEEDED: a refused call
 * records nothing (in process every rejection is before the commit), so a corrected retry under the same key passes.
 */
export class KeyBodyGuard {
  readonly #max: number
  readonly #done = new Map<string, string>()
  readonly #inFlight = new Map<string, { digest: string; count: number }>()

  constructor(max = 4096) {
    this.#max = Math.max(1, Math.floor(max))
  }

  /**
   * Throws 409 duplicate_id (ClientError) when a recorded digest, or the digest of an in-flight call with this id,
   * differs. Otherwise marks the id in flight. The caller settles the returned handle exactly once.
   */
  begin(nativeId: string, digest: string): { commit(): void; abort(): void } {
    const recorded = this.#done.get(nativeId)
    const flying = this.#inFlight.get(nativeId)
    if ((recorded !== undefined && recorded !== digest) || (flying !== undefined && flying.digest !== digest)) {
      throw clientError('duplicate_id', 'this idempotency key was already used with a different request body', {
        hint: 'use a new key for a different request',
      })
    }
    if (flying !== undefined) flying.count += 1
    else this.#inFlight.set(nativeId, { digest, count: 1 })
    let settled = false
    const leave = (): void => {
      const f = this.#inFlight.get(nativeId)
      if (f === undefined) return
      f.count -= 1
      if (f.count <= 0) this.#inFlight.delete(nativeId)
    }
    return {
      commit: () => {
        if (settled) return
        settled = true
        leave()
        this.#done.delete(nativeId)
        this.#done.set(nativeId, digest)
        while (this.#done.size > this.#max) {
          const oldest = this.#done.keys().next()
          if (oldest.done === true) break
          this.#done.delete(oldest.value)
        }
      },
      abort: () => {
        if (settled) return
        settled = true
        leave()
      },
    }
  }
}

/** HOST-9/10 wire transports only: 16 random bytes, base64url, minted before the first attempt of a client-id op. */
export function mintKey(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * A claim token for a keyed claim replay: 32 bytes from crypto.randomBytes, base64url (43 characters). An adapter
 * persists it next to its key. A token is NEVER derived from the key or from any other guessable input.
 */
export function mintClaimToken(): string {
  return randomBytes(32).toString('base64url')
}
