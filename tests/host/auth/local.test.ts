import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardService,
  checkCallerActor,
  requireHumanVerified,
  SqliteUnifiedStore,
} from '../../../src/core/public.ts'
import { isBoardError, type BoardErrorLike } from '../../../src/client/errors.ts'
import { nodeResolverFs, resolveBoard } from '../../../src/client/resolve.ts'
import { InProcessTransport } from '../../../src/client/transport-inproc.ts'
import {
  compileCanHeader,
  DEFAULT_AGENT_CAP,
  loadAgentCard,
  matchesAsAllowlist,
  matchesAsPattern,
  parseAgentCard,
  resolveLocalIdentity,
  sanitizeOsUser,
  writeAgentCard,
  type AgentCardFile,
} from '../../../src/host/auth/local.ts'

const tmpDirs: string[] = []
const stores: SqliteUnifiedStore[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-host4-'))
  tmpDirs.push(dir)
  return dir
}

function makeBoard(): BoardService {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return new BoardService(store)
}

function expectErr(fn: () => unknown, status: number, code: string): BoardErrorLike {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(isBoardError(caught), `expected BoardErrorLike ${status} ${code}, got ${String(caught)}`).toBe(true)
  const err = caught as BoardErrorLike
  expect(err.status).toBe(status)
  expect(err.code).toBe(code)
  return err
}

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close()
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('HOST-4: Local identity resolver & safe g1 narrowing (V2-11)', () => {
  it('resolves interactive TTY human with owner+member local_unverified and blocks human_verified in Mode 1', () => {
    const board = makeBoard()
    const resolved = resolveLocalIdentity({
      env: {},
      isTTY: true,
      userId: 'alice',
      boardDir: null,
    })

    expect(resolved.isHuman).toBe(true)
    expect(resolved.card).toBeNull()
    expect(resolved.assurance).toBe('local_unverified')
    expect(resolved.profile).toBeNull()
    expect(resolved.provider.kind).toBe('local')
    expect(resolved.provider.base).toEqual({ principal: 'local:user:alice', profile: null })
    expect(resolved.caller.principal).toMatchObject({
      id: 'local:user:alice',
      kind: 'user',
      owner: true,
      member: true,
      assurance: 'local_unverified',
    })
    expect(resolved.caller.principal.cap).toBeUndefined()
    expect(resolved.caller.actor.kind).toBe('person')
    expect(resolved.caller.actor.verified).toBeUndefined()

    // Full grant management works for interactive human
    const grant = board.createGrant(resolved.caller, {
      principals: [{ kind: 'everyone' }],
      can: { 'public/': ['read'] },
    })
    expect(grant.id).toBeTruthy()
    expect(board.me(resolved.caller).assurance).toBe('local_unverified')

    // human_verified is refused 501 not_supported in Mode 1
    expectErr(() => requireHumanVerified(resolved.caller), 501, 'not_supported')

    // Acting as a profile from an interactive human narrows to agent_delegated without manage
    const asAgy = resolved.provider.callerFor('agy')
    expect(asAgy.actor.id).toBe('local:user:alice+agy')
    expect(asAgy.actor.kind).toBe('agent')
    expect(asAgy.principal.owner).toBe(false)
    expect(asAgy.principal.assurance).toBe('agent_delegated')
    expect(asAgy.principal.cap).toEqual(DEFAULT_AGENT_CAP)
    expectErr(
      () => board.createGrant(asAgy, { principals: [{ kind: 'everyone' }], can: { '*': ['read'] } }),
      403,
      'forbidden',
    )
    // Calling as(null) returns the human caller
    expect(resolved.provider.callerFor(null)).toBe(resolved.caller)
  })

  it('refuses non-TTY with no profile immediately with 401 agent_identity_required', () => {
    const err = expectErr(
      () => resolveLocalIdentity({ env: {}, isTTY: false, userId: 'alice' }),
      401,
      'agent_identity_required',
    )
    expect(err.hint).toContain('SWARMBOARD_AGENT')

    // Even explicit as: null in non-TTY with no agent profile is refused 401
    expectErr(
      () => resolveLocalIdentity({ env: {}, isTTY: false, as: null, userId: 'alice' }),
      401,
      'agent_identity_required',
    )
  })

  it('locks cardless local agent to its own profile, narrows g1 cap, enables cross-provider task handoff, and blocks grants', async () => {
    const board = makeBoard()
    const dir = makeTmpDir()

    const agy = resolveLocalIdentity({
      env: { SWARMBOARD_AGENT: 'agy' },
      isTTY: false,
      boardDir: dir,
      userId: 'alice',
    })
    const codex = resolveLocalIdentity({
      env: { BOARD_PROFILE: 'codex' },
      isTTY: false,
      boardDir: dir,
      userId: 'alice',
    })
    const claude = resolveLocalIdentity({
      env: { FUSION_AGENT_ID: 'claude' },
      isTTY: false,
      boardDir: dir,
      userId: 'alice',
    })

    // Principal & cap verification
    expect(agy.isHuman).toBe(false)
    expect(agy.card).toBeNull()
    expect(agy.provider.kind).toBe('local')
    expect(agy.caller.principal).toMatchObject({
      id: 'local:user:alice',
      owner: false,
      member: true,
      assurance: 'agent_delegated',
      cap: ['read', 'post', 'react', 'label'],
    })
    expect(agy.caller.actor).toMatchObject({
      id: 'local:user:alice+agy',
      kind: 'agent',
      handle: 'alice/agy',
    })
    expect(agy.caller.actor.verified).toBeUndefined()
    expect(codex.caller.actor.id).toBe('local:user:alice+codex')
    expect(claude.caller.actor.id).toBe('local:user:alice+claude')

    // Cardless as-lock: own profile allowed, null -> 403 agent_cannot_impersonate_human, foreign -> 403 profile_mismatch
    expect(agy.provider.callerFor(undefined)).toBe(agy.caller)
    expect(agy.provider.callerFor('agy')).toBe(agy.caller)
    expectErr(() => agy.provider.callerFor(null), 403, 'agent_cannot_impersonate_human')
    expectErr(() => agy.provider.callerFor('codex'), 403, 'profile_mismatch')
    expectErr(() => agy.provider.callerFor('bad_profile'), 400, 'invalid_profile')

    // Process env SWARMBOARD_AGENT cannot be escaped via opts.as: null or foreign opts.as
    expectErr(
      () => resolveLocalIdentity({ env: { SWARMBOARD_AGENT: 'agy' }, as: null, isTTY: true, boardDir: dir, userId: 'alice' }),
      403,
      'agent_cannot_impersonate_human',
    )
    expectErr(
      () => resolveLocalIdentity({ env: { SWARMBOARD_AGENT: 'agy' }, as: 'codex', isTTY: true, boardDir: dir, userId: 'alice' }),
      403,
      'profile_mismatch',
    )

    // Env precedence: SWARMBOARD_AGENT > BOARD_PROFILE > FUSION_AGENT_ID
    const prec = resolveLocalIdentity({
      env: { SWARMBOARD_AGENT: 'agy', BOARD_PROFILE: 'codex', FUSION_AGENT_ID: 'claude' },
      isTTY: false,
      userId: 'alice',
    })
    expect(prec.profile).toBe('agy')

    // Seamless cross-provider task handoff under shared local:user:alice ownership
    const created = board.tasks.createTask(agy.caller, {
      channel: 'work/sprint',
      text: 'Implement HOST-4 & HOST-8',
      for: 'local:user:alice+codex',
    })
    const claimed = board.tasks.claimTask(codex.caller, created.task.id)
    expect(claimed.task.task?.state).toBe('claimed')
    expect(claimed.task.task?.claim?.actor).toBe('local:user:alice+codex')

    const completed = board.tasks.completeTask(codex.caller, created.task.id, {
      epoch: claimed.claim.epoch,
      token: claimed.claim.token,
      result: 'Shipped and tested',
    })
    expect(completed.task.task?.state).toBe('completed')

    // Review comment & reaction by claude
    const reply = board.postMessage(claude.caller, { re: created.task.id, text: 'LGTM @agy @codex' })
    expect(reply.message.by.actor).toBe('local:user:alice+claude')

    // Grant mutations MUST fail 403 forbidden for every local agent
    expectErr(
      () => board.createGrant(agy.caller, { principals: [{ kind: 'everyone' }], can: { '*': ['read'] } }),
      403,
      'forbidden',
    )
    expectErr(() => board.revokeGrant(codex.caller, 'g1'), 403, 'forbidden')
    expectErr(() => requireHumanVerified(agy.caller), 403, 'human_verification_required')

    // Works cleanly inside InProcessTransport
    const tx = new InProcessTransport({ board, identity: agy.provider })
    const me = await tx.call('me', {})
    expect(me.actor).toBe('local:user:alice+agy')
    expect(me.assurance).toBe('agent_delegated')
    expect(me.can).toEqual({ '*': ['read', 'post', 'react', 'label'] })
    await expect(tx.call('me', {}, { as: 'codex' })).rejects.toMatchObject({ status: 403, code: 'profile_mismatch' })
    await tx.close()
  })

  it('loads agent card, narrows g1 via card.can + card.cap, strips manage unless allowManage:true, and enforces card.as allowlist', () => {
    const dir = makeTmpDir()
    const board = makeBoard()

    const card: AgentCardFile = {
      version: 1,
      profile: 'captain',
      displayName: 'Eng Captain',
      harness: 'claude-code',
      department: 'engineering',
      captain: 'cto',
      cap: ['read', 'post', 'react', 'label', 'manage'], // manage must be stripped without allowManage: true
      can: { 'dev/': ['read', 'post', 'label'], 'work/': 'all' },
      as: ['captain', 'worker-*'],
      impersonatePerson: false,
    }
    const cardPath = writeAgentCard(dir, card)
    if (process.platform !== 'win32') {
      expect(statSync(cardPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, 'agents')).mode & 0o777).toBe(0o700)
    }

    const resolved = resolveLocalIdentity({
      env: { SWARMBOARD_AGENT: 'captain' },
      isTTY: false,
      boardDir: dir,
      userId: 'alice',
    })
    expect(resolved.provider.kind).toBe('cards')
    expect(resolved.card?.department).toBe('engineering')
    expect(resolved.caller.actor.name).toBe('Eng Captain')
    // 'manage' stripped because allowManage is not true
    expect(resolved.caller.principal.cap).toEqual(['read', 'post', 'react', 'label'])
    expect(resolved.caller.canHeader).toBe('dev/=read,post,label;work/=all')

    // Allowed in dev/ and work/ (without manage), denied in ops/
    expect(board.postMessage(resolved.caller, { channel: 'dev/api', text: 'ship it' }).message.channel).toBe('dev/api')
    expect(board.postMessage(resolved.caller, { channel: 'work/q1', text: 'task ready' }).message.channel).toBe('work/q1')
    expectErr(() => board.postMessage(resolved.caller, { channel: 'ops/secret', text: 'nope' }), 403, 'forbidden')
    expectErr(() => board.revokeGrant(resolved.caller, 'g1'), 403, 'forbidden')

    // card.as allowlist: exact + prefix glob allowed; unlisted denied 403 profile_mismatch; null -> 403 agent_cannot_impersonate_human
    const worker1 = resolved.provider.callerFor('worker-1')
    expect(worker1.actor.id).toBe('local:user:alice+worker-1')
    expect(worker1.canHeader).toBe(resolved.caller.canHeader)
    expect(worker1.principal.cap).toEqual(['read', 'post', 'react', 'label'])
    checkCallerActor(worker1)

    expectErr(() => resolved.provider.callerFor('rogue'), 403, 'profile_mismatch')
    expectErr(() => resolved.provider.callerFor(null), 403, 'agent_cannot_impersonate_human')

    // Env SWARMBOARD_AGENT=captain with explicit opts.as='worker-9' succeeds via card.as
    const delegatedStart = resolveLocalIdentity({
      env: { SWARMBOARD_AGENT: 'captain' },
      as: 'worker-9',
      isTTY: false,
      boardDir: dir,
      userId: 'alice',
    })
    expect(delegatedStart.profile).toBe('worker-9')
    expect(delegatedStart.caller.actor.id).toBe('local:user:alice+worker-9')

    // Explicit allowManage: true retains 'manage' in cap (still owner: false and agent_delegated)
    writeAgentCard(dir, {
      version: 1,
      profile: 'opsbot',
      cap: ['read', 'post', 'manage'],
      allowManage: true,
      impersonatePerson: false,
    })
    const opsbot = resolveLocalIdentity({
      as: 'opsbot',
      isTTY: false,
      boardDir: dir,
      userId: 'alice',
    })
    expect(opsbot.caller.principal.cap).toContain('manage')
    expect(opsbot.caller.principal.owner).toBe(false)
    expect(opsbot.caller.principal.assurance).toBe('agent_delegated')
  })

  it('sets member: false when authEnforce=true so explicit board_grants govern access', () => {
    const dir = makeTmpDir()
    const board = makeBoard()
    writeAgentCard(dir, {
      version: 1,
      profile: 'strictbot',
      cap: ['read', 'post'],
      impersonatePerson: false,
    })

    const strict = resolveLocalIdentity({
      env: { SWARMBOARD_AGENT: 'strictbot' },
      isTTY: false,
      boardDir: dir,
      userId: 'alice',
      authEnforce: true,
    })
    expect(strict.caller.principal.member).toBe(false)
    // g1 only admits all-users with member: true -> denied 403 until an explicit grant exists
    expectErr(() => board.me(strict.caller), 403, 'forbidden')

    // Add explicit user grant from human owner -> admitted and still bounded by card cap
    const human = resolveLocalIdentity({ env: {}, isTTY: true, userId: 'alice' })
    board.createGrant(human.caller, {
      principals: [{ kind: 'user', userId: 'alice' }],
      can: { 'dev/': 'all' },
    })
    const me = board.me(strict.caller)
    expect(me.can).toEqual({ 'dev/': ['read', 'post'] })
  })

  it('rejects cards with impersonatePerson:true, symlinks, world-writable permissions, foreign uid, or malformed fields', () => {
    const dir = makeTmpDir()
    const agentsDir = join(dir, 'agents')
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 })

    // 1. impersonatePerson: true -> 403 agent_cannot_impersonate_human
    writeFileSync(
      join(agentsDir, 'evil.json'),
      JSON.stringify({ version: 1, profile: 'evil', impersonatePerson: true }),
      { mode: 0o600 },
    )
    expectErr(() => loadAgentCard(dir, 'evil'), 403, 'agent_cannot_impersonate_human')
    expectErr(
      () => resolveLocalIdentity({ as: 'evil', isTTY: false, boardDir: dir, userId: 'alice' }),
      403,
      'agent_cannot_impersonate_human',
    )

    // 2. Missing impersonatePerson or wrong version or mismatched profile -> 400 invalid_config
    expectErr(() => parseAgentCard({ version: 1, profile: 'a' }), 400, 'invalid_config')
    expectErr(() => parseAgentCard({ version: 2, profile: 'a', impersonatePerson: false }), 400, 'invalid_config')
    expectErr(() => parseAgentCard({ version: 1, profile: 'b', impersonatePerson: false }, 'a'), 400, 'invalid_config')
    expectErr(() => parseAgentCard({ version: 1, profile: 'a', as: ['*'], impersonatePerson: false }), 400, 'invalid_config')
    expectErr(() => parseAgentCard({ version: 1, profile: 'a', as: ['a*b'], impersonatePerson: false }), 400, 'invalid_config')
    expectErr(() => parseAgentCard({ version: 1, profile: 'a', cap: ['root' as never], impersonatePerson: false }), 400, 'invalid_config')
    expectErr(() => parseAgentCard({ version: 1, profile: 'a', unknownKey: 1, impersonatePerson: false }), 400, 'invalid_config')
    expectErr(() => parseAgentCard(JSON.parse('{"version":1,"profile":"a","impersonatePerson":false,"__proto__":{"x":1}}')), 400, 'invalid_config')

    // 3. Profile path traversal rejected 400 invalid_profile
    expectErr(() => loadAgentCard(dir, '../evil'), 400, 'invalid_profile')

    // 4. Symlink card rejected 403 unsafe_config
    const realCard = join(dir, 'outside.json')
    writeFileSync(realCard, JSON.stringify({ version: 1, profile: 'sym', impersonatePerson: false }), { mode: 0o600 })
    symlinkSync(realCard, join(agentsDir, 'sym.json'))
    expectErr(() => loadAgentCard(dir, 'sym'), 403, 'unsafe_config')

    // 5. Group-writable (0o660) and world-writable (0o666) cards rejected 403 unsafe_config (POSIX)
    if (process.platform !== 'win32') {
      const gwPath = join(agentsDir, 'gw.json')
      writeFileSync(gwPath, JSON.stringify({ version: 1, profile: 'gw', impersonatePerson: false }))
      chmodSync(gwPath, 0o660)
      expectErr(() => loadAgentCard(dir, 'gw'), 403, 'unsafe_config')

      const wwPath = join(agentsDir, 'ww.json')
      writeFileSync(wwPath, JSON.stringify({ version: 1, profile: 'ww', impersonatePerson: false }))
      chmodSync(wwPath, 0o666)
      expectErr(() => loadAgentCard(dir, 'ww'), 403, 'unsafe_config')

      // Foreign uid rejected 403 unsafe_config
      const goodPath = join(agentsDir, 'foreign.json')
      writeFileSync(goodPath, JSON.stringify({ version: 1, profile: 'foreign', impersonatePerson: false }), { mode: 0o600 })
      expectErr(() => loadAgentCard(dir, 'foreign', { uid: 999_999 }), 403, 'unsafe_config')
    }
  })

  it('integrates with resolveBoard() resolution and helper utilities', () => {
    const dir = makeTmpDir()
    const dbPath = join(dir, 'board.db')
    writeAgentCard(dir, {
      version: 1,
      profile: 'worker',
      cap: ['read', 'post'],
      can: { 'dev/': ['read', 'post'] },
      impersonatePerson: false,
    })

    const res = resolveBoard(
      { db: dbPath },
      {
        env: { SWARMBOARD_AGENT: 'worker' },
        cwd: dir,
        platform: process.platform,
        home: dir,
        uid: process.getuid?.() ?? null,
        fs: nodeResolverFs,
      },
    )
    const resolved = resolveLocalIdentity({ resolution: res, isTTY: false, userId: 'alice' })
    expect(resolved.profile).toBe('worker')
    expect(resolved.provider.kind).toBe('cards')
    expect(resolved.caller.canHeader).toBe('dev/=read,post')

    // HA-F2 regression: env-sourced Resolution cannot be escaped via as: null or foreign as
    const envRes = resolveBoard(
      { db: dbPath },
      {
        env: { SWARMBOARD_AGENT: 'agy' },
        cwd: dir,
        platform: process.platform,
        home: dir,
        uid: process.getuid?.() ?? null,
        fs: nodeResolverFs,
      },
    )
    expectErr(
      () => resolveLocalIdentity({ resolution: envRes, as: null, isTTY: true, userId: 'alice' }),
      403,
      'agent_cannot_impersonate_human',
    )
    expectErr(
      () => resolveLocalIdentity({ resolution: envRes, as: 'codex', isTTY: false, userId: 'alice' }),
      403,
      'profile_mismatch',
    )
    // With an agent card allowing 'agy-*', resolution + as:'agy-2' succeeds while 'codex' & null still fail
    writeAgentCard(dir, {
      version: 1,
      profile: 'agy',
      as: ['agy', 'agy-*'],
      impersonatePerson: false,
    })
    const switched = resolveLocalIdentity({ resolution: envRes, as: 'agy-2', isTTY: false, userId: 'alice' })
    expect(switched.profile).toBe('agy-2')
    expect(switched.caller.actor.id).toBe('local:user:alice+agy-2')
    expectErr(
      () => resolveLocalIdentity({ resolution: envRes, as: 'codex', isTTY: false, userId: 'alice' }),
      403,
      'profile_mismatch',
    )
    expectErr(
      () => resolveLocalIdentity({ resolution: envRes, as: null, isTTY: true, userId: 'alice' }),
      403,
      'agent_cannot_impersonate_human',
    )
    // flag:as-sourced Resolution applies as default profile when opts.as is omitted
    const flagRes = resolveBoard(
      { db: dbPath, as: 'worker' },
      {
        env: {},
        cwd: dir,
        platform: process.platform,
        home: dir,
        uid: process.getuid?.() ?? null,
        fs: nodeResolverFs,
      },
    )
    const fromFlag = resolveLocalIdentity({ resolution: flagRes, isTTY: false, userId: 'alice' })
    expect(fromFlag.profile).toBe('worker')
    expect(fromFlag.provider.kind).toBe('cards')

    // Pure helpers
    expect(matchesAsPattern('agy-1', 'agy-*')).toBe(true)
    expect(matchesAsPattern('codex-1', 'agy-*')).toBe(false)
    expect(matchesAsAllowlist('agy-2', ['agy', 'agy-*'])).toBe(true)
    expect(matchesAsAllowlist('agy-2', undefined)).toBe(false)
    expect(compileCanHeader({ 'work/': ['post', 'read'], '*': ['read'] })).toBe('*=read;work/=read,post')
    expect(sanitizeOsUser('  Alice.Dev! ')).toBe('alice.dev')
    expect(sanitizeOsUser('   ')).toBe('local')
  })
})
