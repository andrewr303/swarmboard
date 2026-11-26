// HS-57 and HS-58: idempotency keys, the body guard and claim-token minting.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isKeyIdOf } from '../../src/core/public.ts'
import { isBoardError } from '../../src/client/errors.ts'
import * as Idem from '../../src/client/idempotency.ts'
import { applyIdempotencyKey, bodyDigest, IDEMPOTENCY_KEY, keyedId, KeyBodyGuard, keyUse, mintClaimToken, mintKey } from '../../src/client/idempotency.ts'
import { OP_NAMES, OPS, type OpName } from '../../src/client/ops.ts'

function refusal(fn: () => unknown): { status: number; code: string; message: string; origin: string } {
  try {
    fn()
  } catch (e) {
    if (isBoardError(e)) return { status: e.status, code: e.code, message: e.message, origin: e.origin }
    throw e
  }
  throw new Error('did not throw')
}

const WHO = { principalId: 'local:user:u_ada', profile: 'w1' }

describe('keyedId', () => {
  it('HS-57 reproduces the measured vectors', () => {
    expect(keyedId('local:user:u_ada', 'w1', 'post', 'K-1')).toBe('key:local:user:u_ada:3e554b74e8a1bb12fcc2fe60bede1ec7')
    expect(keyedId('local:user:u_ada', 'w1', 'postMessage' as OpName, 'K-1')).toBe(
      'key:local:user:u_ada:958cd9d78851e1ec5b713ed563997590',
    )
    expect(isKeyIdOf(keyedId('local:user:u_ada', 'w1', 'post', 'K-1'), 'local:user:u_ada')).toBe(true)
  })

  it('HS-57 changes with any one of principal, profile, op or key', () => {
    const base = keyedId('local:user:u_ada', 'w1', 'post', 'K-1')
    const variants = [
      keyedId('local:user:u_bob', 'w1', 'post', 'K-1'),
      keyedId('local:user:u_ada', null, 'post', 'K-1'),
      keyedId('local:user:u_ada', 'w2', 'post', 'K-1'),
      keyedId('local:user:u_ada', 'w1', 'createTask', 'K-1'),
      keyedId('local:user:u_ada', 'w1', 'post', 'K-2'),
    ]
    expect(new Set([base, ...variants]).size).toBe(6)
    // the principal appears in the prefix, the digest part is 32 hex
    for (const v of variants) expect(v).toMatch(/^key:local:user:u_[a-z]+:[0-9a-f]{32}$/)
    expect(keyedId('local:user:u_ada', null, 'post', 'K-1')).toBe(keyedId('local:user:u_ada', null, 'post', 'K-1'))
  })

  it('HS-57 equals the original keyId over the joined derivation', () => {
    // orig client/ids.ts: keyId(principal, derived) = `key:${principal}:${sha256hex('board-key\u001f' + derived).slice(0, 32)}`
    const origKeyId = (principal: string, derived: string): string =>
      `key:${principal}:${createHash('sha256').update(`board-key\u001f${derived}`).digest('hex').slice(0, 32)}`
    const derived = ['swarmboard-idem/1', 'post', 'w1', 'K-1'].join('\u001f')
    expect(keyedId('local:user:u_ada', 'w1', 'post', 'K-1')).toBe(origKeyId('local:user:u_ada', derived))
    const noProfile = ['swarmboard-idem/1', 'createTasks', '', 'k'].join('\u001f')
    expect(keyedId('p', null, 'createTasks', 'k')).toBe(origKeyId('p', noProfile))
  })

  it('HS-57 the longest principal that fits the id limit is 163 characters', () => {
    const principal = 'p'.repeat(163)
    const id = keyedId(principal, null, 'post', 'k')
    expect(id.length).toBe(200)
    expect(isKeyIdOf(id, principal)).toBe(true)
  })
})

describe('applyIdempotencyKey', () => {
  it('HS-58 post, createTasks and createTask with a channel get a keyed id', () => {
    for (const [op, input] of [
      ['post', { channel: 'a', text: 't' }],
      ['createTasks', { channel: 'a', tasks: [{ text: 't' }] }],
      ['createTask', { channel: 'a', text: 't' }],
    ] as const) {
      const out = applyIdempotencyKey(op, { ...input }, WHO, 'K-1')
      const id = keyedId(WHO.principalId, WHO.profile, op, 'K-1')
      expect(out.nativeId, op).toBe(id)
      expect(out.input, op).toEqual({ ...input, id })
      expect(isKeyIdOf(id, WHO.principalId)).toBe(true)
    }
    const original = { channel: 'a', text: 't' }
    applyIdempotencyKey('post', original, WHO, 'K-1')
    expect(original).toEqual({ channel: 'a', text: 't' })
  })

  it('HS-58 no key leaves the input unchanged with no native id', () => {
    const input = { channel: 'a', text: 't', id: 'mine' }
    const out = applyIdempotencyKey('post', input, WHO, undefined)
    expect(out.input).toBe(input)
    expect(out.nativeId).toBeNull()
  })

  it('HS-58 createTask with re, and read, natural and fenced ops accept the key and leave the input alone', () => {
    for (const [op, input] of [
      ['createTask', { re: 5 }],
      ['createTask', { channel: 'a', re: 5 }],
      ['createTask', { channel: 'a', re: 0 }],
      ['channels', {}],
      ['react', { id: 1, emoji: 'x' }],
      ['completeTask', { id: 1, token: 't' }],
      ['claimTask', { id: 1 }],
    ] as const) {
      const given = { ...input }
      const out = applyIdempotencyKey(op, given, WHO, 'K-1')
      expect(out.input, op).toBe(given)
      expect(out.nativeId, op).toBeNull()
      expect(keyUse(op, given)).toBe('accepted')
    }
    expect(keyUse('post', {})).toBe('id')
    expect(keyUse('createTask', { channel: 'a' })).toBe('id')
    expect(keyUse('createTask', { channel: 'a', re: undefined })).toBe('id')
  })

  it('HS-58 every unsafe op refuses a key with 400 "no idempotent form"', () => {
    const unsafe = OP_NAMES.filter((o) => OPS[o].idem === 'unsafe')
    expect(unsafe).toEqual(
      ['claimReadyTask', 'createGrant', 'createGrants', 'edit', 'inboxNext', 'matches', 'schedule', 'syncReceipt', 'updateGrant', 'upload', 'uploadStart'],
    )
    for (const op of unsafe) {
      const e = refusal(() => applyIdempotencyKey(op, {}, WHO, 'K-1'))
      expect(e, op).toMatchObject({ status: 400, code: 'invalid_request', origin: 'handle' })
      expect(e.message, op).toContain('no idempotent form')
      expect(keyUse(op, {})).toBe('refused')
    }
  })

  it('HS-58 a key with an explicit id, a bad key and a long key are 400', () => {
    expect(refusal(() => applyIdempotencyKey('post', { id: 'x' }, WHO, 'K-1')).message).toContain('pass an id or an idempotencyKey, not both')
    expect(refusal(() => applyIdempotencyKey('createTasks', { id: 'x' }, WHO, 'K-1')).code).toBe('invalid_request')
    expect(refusal(() => applyIdempotencyKey('post', {}, WHO, 'has space')).status).toBe(400)
    expect(refusal(() => applyIdempotencyKey('post', {}, WHO, 'k'.repeat(129))).status).toBe(400)
    expect(refusal(() => applyIdempotencyKey('post', {}, WHO, '')).status).toBe(400)
    expect(refusal(() => applyIdempotencyKey('post', {}, WHO, 'tab\there')).status).toBe(400)
    expect(refusal(() => applyIdempotencyKey('post', {}, WHO, 'ünï')).status).toBe(400)
    expect(applyIdempotencyKey('post', {}, WHO, 'k'.repeat(128)).nativeId).not.toBeNull()
    expect(IDEMPOTENCY_KEY.test('!~')).toBe(true)
    // a bad key is refused before anything else, even on an unsafe op
    expect(refusal(() => applyIdempotencyKey('edit', {}, WHO, 'has space')).message).toContain('idempotencyKey')
  })

  it('HS-58 a token is never derived: no token key, no keyedToken export, mintClaimToken is random', () => {
    const created = applyIdempotencyKey('createTask', { channel: 'a', text: 't', claim: true }, WHO, 'K-1')
    expect(Object.hasOwn(created.input, 'token')).toBe(false)
    const claimed = applyIdempotencyKey('claimTask', { id: 5 }, WHO, 'K-1')
    expect(Object.hasOwn(claimed.input, 'token')).toBe(false)
    const keys = Object.keys(Idem)
    expect(keys).not.toContain('keyedToken')
    expect(keys.filter((k) => /token/i.test(k))).toEqual(['mintClaimToken'])
    expect(keys).toContain('mintClaimToken')
    expect(mintClaimToken.length).toBe(0)
    const tokens = new Set<string>()
    for (let i = 0; i < 1000; i++) tokens.add(mintClaimToken())
    expect(tokens.size).toBe(1000)
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(mintKey()).toMatch(IDEMPOTENCY_KEY)
    expect(mintKey()).not.toBe(mintKey())
  })

  it('HS-58 bodyDigest ignores id, token and request and the order of keys', () => {
    const a = bodyDigest('post', { channel: 'a', text: 't', id: 'x', token: 'y', request: 'r' })
    expect(a).toBe(bodyDigest('post', { text: 't', channel: 'a' }))
    expect(a).not.toBe(bodyDigest('post', { channel: 'a', text: 'u' }))
    expect(a).not.toBe(bodyDigest('createTask', { channel: 'a', text: 't' }))
    expect(bodyDigest('post', { n: { b: 1, a: [1, { d: 1, c: 2 }] } })).toBe(bodyDigest('post', { n: { a: [1, { c: 2, d: 1 }], b: 1 } }))
    expect(bodyDigest('post', { a: undefined, text: 't' })).toBe(bodyDigest('post', { text: 't' }))
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('KeyBodyGuard', () => {
  it('HS-58 a committed id passes with the same digest and is 409 with another', () => {
    const g = new KeyBodyGuard()
    g.begin('id1', 'd1').commit()
    g.begin('id1', 'd1').commit()
    const e = refusal(() => g.begin('id1', 'd2'))
    expect(e).toMatchObject({ status: 409, code: 'duplicate_id', origin: 'handle' })
  })

  it('HS-58 an aborted call records nothing', () => {
    const g = new KeyBodyGuard()
    g.begin('id1', 'd1').abort()
    const h = g.begin('id1', 'd2')
    h.commit()
    expect(refusal(() => g.begin('id1', 'd1')).code).toBe('duplicate_id')
  })

  it('HS-58 while a call is in flight another digest is 409 and the same digest passes', () => {
    const g = new KeyBodyGuard()
    const first = g.begin('id1', 'd1')
    expect(refusal(() => g.begin('id1', 'd2')).code).toBe('duplicate_id')
    const second = g.begin('id1', 'd1')
    first.abort()
    // the second is still in flight
    expect(refusal(() => g.begin('id1', 'd2')).code).toBe('duplicate_id')
    second.abort()
    g.begin('id1', 'd2').abort()
  })

  it('HS-58 a handle settles once: a later commit after an abort records nothing', () => {
    const g = new KeyBodyGuard()
    const h = g.begin('id1', 'd1')
    h.abort()
    h.commit()
    g.begin('id1', 'd2').abort()
    const c = g.begin('id2', 'd1')
    c.commit()
    c.abort()
    expect(refusal(() => g.begin('id2', 'd2')).code).toBe('duplicate_id')
  })

  it('HS-58 after 4,097 distinct committed ids the oldest is evicted', () => {
    const g = new KeyBodyGuard()
    for (let i = 0; i < 4097; i++) g.begin(`id${i}`, 'd').commit()
    g.begin('id0', 'other').abort() // evicted: another digest passes
    expect(refusal(() => g.begin('id1', 'other')).code).toBe('duplicate_id')
    expect(refusal(() => g.begin('id4096', 'other')).code).toBe('duplicate_id')
  })

  it('HS-58 a re-committed id is refreshed, so the least recently committed goes first', () => {
    const g = new KeyBodyGuard(3)
    for (const id of ['a', 'b', 'c']) g.begin(id, 'd').commit()
    g.begin('a', 'd').commit() // a is now the newest
    g.begin('d', 'd').commit() // evicts b
    g.begin('b', 'other').abort()
    expect(refusal(() => g.begin('a', 'other')).code).toBe('duplicate_id')
    expect(refusal(() => g.begin('c', 'other')).code).toBe('duplicate_id')
  })
})
