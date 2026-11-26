// Identity providers for the in-process transports (HOST123_DESIGN 5.2). Thick: it builds core CallerContexts.
//
// SELF-ASSERTED. The embedding process chooses the provider. Profiles, `as` and the deployment refusal give
// attribution and accident protection, never isolation: any same-user process can build a CallerContext for any
// principal (createLocalCaller is a public export) or edit the board file. Nothing here is a security boundary.
import { createLocalCaller, type CallerContext } from '../core/public.ts'
import { clientError } from './errors.ts'

export interface IdentityProvider {
  /** undefined = base; null = the principal with no profile. Throws 403 profile_mismatch or 400 invalid_profile. */
  callerFor(as: string | null | undefined): CallerContext
  readonly base: { readonly principal: string; readonly profile: string | null }
  readonly kind: 'fixed' | 'local' | 'cards' // 'cards' = HOST-4
}

/** The original's profile rule (backend-vercel.ts PROFILE): a letter, then letters, digits or dashes, at most 32. */
const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/

function checkProfile(name: unknown, what: string): string {
  if (typeof name !== 'string' || !PROFILE.test(name)) {
    throw clientError('invalid_profile', `${what}: profiles start with a letter and use up to 32 letters, numbers, and hyphens`)
  }
  return name
}

/** One caller, taken as given (Mode 0, caller-chosen). Only its own profile is accepted. */
export function fixedIdentity(caller: CallerContext): IdentityProvider {
  return {
    kind: 'fixed',
    base: { principal: caller.principal.id, profile: caller.profile },
    callerFor(as) {
      if (as === undefined || as === caller.profile) return caller
      throw clientError('profile_mismatch', `this identity is ${caller.actor.id}: it cannot act as ${as === null ? 'its principal' : `profile ${as}`}`, {
        hint: 'omit as, or build the client with an identity that has the profile',
      })
    },
  }
}

/**
 * A local user and the profiles it may act as. `member` defaults to FALSE: on a board seeded with the starting
 * grants only the all-users grant admits a local user and it needs `member`, so a localIdentity with member false
 * and no explicit grant is refused 403 on every op, `me` included. Entry points that build one pass member: true.
 */
export function localIdentity(opts: {
  userId: string
  handle?: string
  name?: string
  member?: boolean
  owner?: boolean
  profiles: readonly string[] | '*'
  defaultProfile?: string | null
}): IdentityProvider {
  if (typeof opts.userId !== 'string' || opts.userId.length === 0) {
    throw clientError('invalid_request', 'localIdentity: userId must be a non-empty string')
  }
  let allowed: ReadonlySet<string> | '*'
  if (opts.profiles === '*') {
    allowed = '*'
  } else if (Array.isArray(opts.profiles)) {
    const set = new Set<string>()
    for (const p of opts.profiles) set.add(checkProfile(p, 'profiles'))
    allowed = set
  } else {
    throw clientError('invalid_profile', "profiles: must be an array of profile names or '*'")
  }
  const defaultProfile = opts.defaultProfile == null ? null : checkProfile(opts.defaultProfile, 'defaultProfile')
  if (defaultProfile !== null && allowed !== '*' && !allowed.has(defaultProfile)) {
    throw clientError('profile_mismatch', `defaultProfile ${defaultProfile} is not one of the profiles`)
  }
  const handle = opts.handle ?? opts.userId
  const callers = new Map<string | null, CallerContext>()
  const callerFor = (as: string | null | undefined): CallerContext => {
    const profile = as === undefined ? defaultProfile : as
    const known = callers.get(profile)
    if (known !== undefined) return known
    if (profile !== null) {
      checkProfile(profile, 'as')
      if (allowed !== '*' && !allowed.has(profile)) {
        throw clientError('profile_mismatch', `profile ${profile} is not one this identity may act as`, {
          hint: `allowed: ${[...allowed].join(', ') || '(none)'}`,
        })
      }
    }
    const made = createLocalCaller({
      userId: opts.userId,
      handle,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      member: opts.member ?? false,
      owner: opts.owner ?? false,
      profile,
    })
    callers.set(profile, made)
    return made
  }
  return {
    kind: 'local',
    base: { principal: callerFor(null).principal.id, profile: defaultProfile },
    callerFor,
  }
}
