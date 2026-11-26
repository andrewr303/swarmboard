import { afterEach, describe, expect, it } from 'vitest'
import {
  ASSURANCE_LEVELS,
  AssuranceSchema,
  BoardError,
  BoardService,
  checkCallerActor,
  createLocalCaller,
  requireHumanVerified,
  SqliteUnifiedStore,
  type CallerContext,
} from '../../src/core/index.ts'

const stores: SqliteUnifiedStore[] = []

function makeBoard(): BoardService {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return new BoardService(store)
}

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close()
})

function expectBoardError(fn: () => unknown, status: number, code: string): BoardError {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught, `expected BoardError ${status} ${code}`).toBeInstanceOf(BoardError)
  const err = caught as BoardError
  expect(err.status).toBe(status)
  expect(err.code).toBe(code)
  return err
}

describe('HOST-0b C10: Identity Assurance & agent_cannot_impersonate_human', () => {
  it('exports valid Assurance schema and levels', () => {
    expect(ASSURANCE_LEVELS).toEqual(['human_verified', 'agent_delegated', 'local_unverified'])
    for (const level of ASSURANCE_LEVELS) expect(AssuranceSchema.parse(level)).toBe(level)
    expect(AssuranceSchema.safeParse('forged').success).toBe(false)
  })

  it('refuses agent_delegated callers impersonating person, owner, deployment, or null profile', () => {
    const board = makeBoard()

    // 1. actor.kind === 'person' with agent_delegated
    const forgedPerson: CallerContext = {
      principal: {
        id: 'local:user:alex',
        kind: 'user',
        handle: 'alex',
        userId: 'alex',
        member: true,
        owner: false,
        assurance: 'agent_delegated',
      },
      actor: {
        id: 'local:user:alex+codex',
        kind: 'person',
        handle: 'alex/codex',
        name: 'codex',
        avatar: null,
      },
      profile: 'codex',
    }
    expectBoardError(() => checkCallerActor(forgedPerson), 403, 'agent_cannot_impersonate_human')
    expectBoardError(() => board.me(forgedPerson), 403, 'agent_cannot_impersonate_human')

    // 2. principal.owner === true with agent_delegated
    const forgedOwner = createLocalCaller({
      userId: 'alex',
      handle: 'alex',
      profile: 'codex',
      owner: true,
      assurance: 'agent_delegated',
    })
    expectBoardError(() => checkCallerActor(forgedOwner), 403, 'agent_cannot_impersonate_human')
    expectBoardError(
      () => board.postMessage(forgedOwner, { channel: 'dev', text: 'impersonate' }),
      403,
      'agent_cannot_impersonate_human',
    )

    // 3. principal.kind === 'deployment' with agent_delegated
    const forgedDeployment: CallerContext = {
      principal: {
        id: 'deployment:d1',
        kind: 'deployment',
        handle: 'deploy',
        assurance: 'agent_delegated',
      },
      actor: {
        id: 'deployment:d1+bot',
        kind: 'agent',
        handle: 'deploy/bot',
        name: 'bot',
        avatar: null,
      },
      profile: 'bot',
    }
    expectBoardError(() => checkCallerActor(forgedDeployment), 403, 'agent_cannot_impersonate_human')

    // 4. profile === null with agent_delegated
    const forgedNullProfile: CallerContext = {
      principal: {
        id: 'local:user:alex',
        kind: 'user',
        handle: 'alex',
        userId: 'alex',
        member: true,
        owner: false,
        assurance: 'agent_delegated',
      },
      actor: {
        id: 'local:user:alex',
        kind: 'agent',
        handle: 'alex',
        name: 'alex',
        avatar: null,
      },
      profile: null,
    }
    expectBoardError(() => checkCallerActor(forgedNullProfile), 403, 'agent_cannot_impersonate_human')
  })

  it('allows valid narrowed agent_delegated callers, blocks grant mutations, and preserves legacy me() shape', () => {
    const board = makeBoard()
    const agent = createLocalCaller({
      userId: 'alex',
      handle: 'alex',
      profile: 'codex',
      owner: false,
      cap: ['read', 'post', 'react', 'label'],
      assurance: 'agent_delegated',
      verified: false,
    })
    expect(agent.actor.verified).toBeUndefined()
    const meAgent = board.me(agent)
    expect(meAgent.assurance).toBe('agent_delegated')
    expect(meAgent.kind).toBe('agent')
    expect(meAgent.can).toEqual({ '*': ['read', 'post', 'react', 'label'] })

    // Agent can post, create/claim tasks, and manage social ops, but CANNOT create or revoke grants
    const msg = board.postMessage(agent, { channel: 'dev', text: 'hello as delegated agent' }).message
    expect(msg.by.actor).toBe('local:user:alex+codex')
    expectBoardError(
      () => board.createGrant(agent, { principals: [{ kind: 'everyone' }], can: { '*': ['read'] } }),
      403,
      'forbidden',
    )
    expectBoardError(() => board.revokeGrant(agent, 'g1'), 403, 'forbidden')

    // Legacy caller without assurance omits `assurance` on me() and keeps `verified: true`
    const legacy = createLocalCaller({ userId: 'alice', handle: 'alice' })
    expect(legacy.actor.verified).toBe(true)
    const meLegacy = board.me(legacy)
    expect('assurance' in meLegacy).toBe(false)
  })

  it('enforces requireHumanVerified across human_verified, agent_delegated, and local_unverified', () => {
    const verifiedHuman = createLocalCaller({
      userId: 'alex',
      handle: 'alex',
      owner: true,
      assurance: 'human_verified',
    })
    const delegatedAgent = createLocalCaller({
      userId: 'alex',
      handle: 'alex',
      profile: 'agy',
      assurance: 'agent_delegated',
    })
    const localUnverified = createLocalCaller({
      userId: 'alex',
      handle: 'alex',
      owner: true,
      assurance: 'local_unverified',
    })
    const unsetCaller = createLocalCaller({ userId: 'alex', handle: 'alex', owner: true })

    // human_verified passes everywhere
    expect(() => requireHumanVerified(verifiedHuman)).not.toThrow()

    // agent_delegated ALWAYS fails with 403 human_verification_required
    expectBoardError(() => requireHumanVerified(delegatedAgent), 403, 'human_verification_required')
    expectBoardError(
      () => requireHumanVerified(delegatedAgent, { mode: 'daemon', allowLocalUnverified: true }),
      403,
      'human_verification_required',
    )

    // local_unverified / unset fails with 501 not_supported in Modes 0-1 (with clear hint)
    const err1 = expectBoardError(() => requireHumanVerified(localUnverified), 501, 'not_supported')
    expect(err1.hint).toContain('Mode 2+')
    expectBoardError(() => requireHumanVerified(unsetCaller, { mode: 'file' }), 501, 'not_supported')

    // Modes 2-3 explicit low-stakes opt-in allows local_unverified person
    expect(() =>
      requireHumanVerified(localUnverified, { mode: 'daemon', allowLocalUnverified: true }),
    ).not.toThrow()
    expect(() =>
      requireHumanVerified(localUnverified, { mode: 'service', allowLocalUnverified: true }),
    ).not.toThrow()
  })
})
