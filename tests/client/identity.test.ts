// HS-56: the identity providers.
import { describe, expect, it } from 'vitest'
import { createLocalCaller } from '../../src/core/public.ts'
import { isBoardError } from '../../src/client/errors.ts'
import { fixedIdentity, localIdentity } from '../../src/client/identity.ts'

function refusal(fn: () => unknown): { status: number; code: string; origin: string } {
  try {
    fn()
  } catch (e) {
    if (isBoardError(e)) return { status: e.status, code: e.code, origin: e.origin }
    throw e
  }
  throw new Error('did not throw')
}

describe('identity providers', () => {
  it('HS-56 fixedIdentity returns its caller for its own profile only', () => {
    const c = createLocalCaller({ userId: 'ada', profile: 'w1' })
    const id = fixedIdentity(c)
    expect(id.kind).toBe('fixed')
    expect(id.base).toEqual({ principal: 'local:user:ada', profile: 'w1' })
    expect(id.callerFor(undefined)).toBe(c)
    expect(id.callerFor('w1')).toBe(c)
    expect(refusal(() => id.callerFor('zz'))).toEqual({ status: 403, code: 'profile_mismatch', origin: 'handle' })
    expect(refusal(() => id.callerFor(null)).code).toBe('profile_mismatch')
    const plain = createLocalCaller({ userId: 'ada' })
    const p = fixedIdentity(plain)
    expect(p.callerFor(null)).toBe(plain)
    expect(p.callerFor(undefined)).toBe(plain)
    expect(refusal(() => p.callerFor('w1')).code).toBe('profile_mismatch')
  })

  it('HS-56 localIdentity memoizes callers per profile and checks names and membership', () => {
    const id = localIdentity({ userId: 'ada', profiles: ['w1'] })
    expect(id.kind).toBe('local')
    expect(id.base).toEqual({ principal: 'local:user:ada', profile: null })
    const w1 = id.callerFor('w1')
    expect(w1.actor.id).toBe('local:user:ada+w1')
    expect(id.callerFor('w1')).toBe(w1)
    expect(w1.principal.member).toBe(false)
    expect(refusal(() => id.callerFor('w2'))).toEqual({ status: 403, code: 'profile_mismatch', origin: 'handle' })
    expect(refusal(() => id.callerFor('bad_name'))).toEqual({ status: 400, code: 'invalid_profile', origin: 'handle' })
    expect(id.callerFor(null).profile).toBeNull()
    expect(id.callerFor(null).actor.id).toBe('local:user:ada')
    expect(id.callerFor(undefined)).toBe(id.callerFor(null))
    expect(id.callerFor(null)).toBe(id.callerFor(null))
  })

  it('HS-56 profiles "*" accepts any valid name; options flow into the caller', () => {
    const id = localIdentity({ userId: 'ada', profiles: '*', member: true, owner: true, handle: 'ada-h', name: 'Ada' })
    expect(id.callerFor('anything-1').actor.id).toBe('local:user:ada+anything-1')
    expect(id.callerFor('anything-1').principal).toMatchObject({ member: true, owner: true, handle: 'ada-h' })
    expect(id.callerFor(null).actor.name).toBe('Ada')
    expect(refusal(() => id.callerFor('1abc')).code).toBe('invalid_profile')
    expect(refusal(() => id.callerFor('a'.repeat(33))).code).toBe('invalid_profile')
    expect(id.callerFor('a'.repeat(32)).profile).toBe('a'.repeat(32))
  })

  it('HS-56 defaultProfile is the base; bad construction is refused', () => {
    const id = localIdentity({ userId: 'ada', profiles: ['w1', 'w2'], defaultProfile: 'w2' })
    expect(id.base).toEqual({ principal: 'local:user:ada', profile: 'w2' })
    expect(id.callerFor(undefined)).toBe(id.callerFor('w2'))
    expect(id.callerFor(undefined).actor.id).toBe('local:user:ada+w2')
    expect(refusal(() => localIdentity({ userId: 'ada', profiles: ['w1'], defaultProfile: 'w9' })).code).toBe('profile_mismatch')
    expect(refusal(() => localIdentity({ userId: 'ada', profiles: ['bad name'] })).code).toBe('invalid_profile')
    expect(refusal(() => localIdentity({ userId: '', profiles: [] })).code).toBe('invalid_request')
  })

  it('HS-56 localIdentity rejects non-array non-"*" profiles from untyped callers with 400 invalid_profile', () => {
    const sparse = new Array<string>(1)
    for (const bad of ['w1', '', null, undefined, 42, { w1: true }, new Set(['w1']), sparse]) {
      expect(
        refusal(() => localIdentity({ userId: 'ada', profiles: bad as unknown as readonly string[] })),
        String(bad),
      ).toEqual({ status: 400, code: 'invalid_profile', origin: 'handle' })
    }
  })
})
