import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  type CallerContext,
} from '../../src/core/index.ts'

const stores: SqliteUnifiedStore[] = []

function setup(seedDefaultGrants = false): BoardService {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return new BoardService(store, { seedDefaultGrants })
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()!.close()
  }
})

describe('Pattern Grants, Specificity, IMPLIES, x-board-can & Lockout', () => {
  it('enforces exact > longest subtree > * and principal > group > everyone precedence', () => {
    const board = setup(false)
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', owner: true })

    board.createGrant(admin, {
      principals: [{ kind: 'everyone' }],
      can: { '*': ['read', 'post', 'react', 'label', 'manage'] },
    })
    board.createGrant(admin, {
      principals: [{ kind: 'all-users' }],
      can: { '*': ['read'], 'work/': ['read', 'post'], 'work/secret': ['read'] },
    })
    board.createGrant(admin, {
      principals: [{ kind: 'user', userId: 'alice' }],
      can: { 'work/secret': ['read', 'label'] },
    })

    const alice: CallerContext = {
      principal: { id: 'user:alice', kind: 'user', handle: 'alice', userId: 'alice', member: true },
      actor: { id: 'user:alice', kind: 'person', handle: 'alice', name: 'Alice', avatar: null },
      profile: null,
    }

    const expGeneral = board.explainAccess(alice, { channel: 'general' })
    expect(expGeneral.pattern).toBe('*')
    expect(expGeneral.level).toBe('group') // group beats everyone
    expect(expGeneral.can).toEqual(['read'])

    const expWork = board.explainAccess(alice, { channel: 'work/eng' })
    expect(expWork.pattern).toBe('work/')
    expect(expWork.can).toEqual(['read', 'post'])

    const expSecret = board.explainAccess(alice, { channel: 'work/secret' })
    expect(expSecret.pattern).toBe('work/secret')
    expect(expSecret.level).toBe('principal') // principal beats group, label implies read
    expect(expSecret.can).toEqual(['read', 'label'])
  })

  it('refuses admission via everyone alone and supports write-only blind posts', () => {
    const board = setup(false)
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', owner: true })

    board.createGrant(admin, {
      principals: [{ kind: 'everyone' }],
      can: { '*': 'all' },
    })

    const outsider: CallerContext = {
      principal: { id: 'app:outsider', kind: 'app', handle: 'outsider', clientId: 'outsider', teamApp: false },
      actor: { id: 'app:outsider', kind: 'agent', handle: 'outsider', name: 'Outsider', avatar: null },
      profile: null,
    }
    expect(board.resolveAccess(outsider).admits).toBe(false)
    expect(() => board.listChannels(outsider)).toThrowError(BoardError)

    // Write-only grant: post does NOT imply read
    board.createGrant(admin, {
      principals: [{ kind: 'app', app: 'dropbox' }],
      can: { 'intake/': ['post'] },
    })
    const dropbox: CallerContext = {
      principal: { id: 'app:dropbox', kind: 'app', handle: 'dropbox', clientId: 'dropbox', teamApp: false },
      actor: { id: 'app:dropbox', kind: 'agent', handle: 'dropbox', name: 'Dropbox', avatar: null },
      profile: null,
    }
    const { message: blindMsg } = board.postMessage(dropbox, {
      channel: 'intake/leads',
      text: 'Secret lead',
      id: 'lead-1',
    })
    expect(blindMsg.blind).toBe(true)

    // Can edit own blind post, cannot read channel
    const edited = board.editMessage(dropbox, blindMsg.id, { text: 'Updated lead' })
    expect(edited.text).toBe('Updated lead')
    expect(() => board.getMessageThread(dropbox, blindMsg.id)).toThrowError(BoardError)
  })

  it('narrows access with x-board-can without widening and enforces checkGrantChange lockout', () => {
    const board = setup(true)
    const alice = createLocalCaller({
      userId: 'alice',
      handle: 'alice',
      member: true,
      canHeader: 'dev/=read,post',
    })
    const access = board.resolveAccess(alice).caller
    expect(access.can('post', 'dev/backend')).toBe(true)
    expect(access.can('manage', 'dev/backend')).toBe(false)
    expect(access.can('read', 'general')).toBe(false)

    // Non-owner manager cannot lock themselves out without lockMeOut: true
    const mgr = createLocalCaller({ userId: 'mgr', handle: 'mgr', member: true })
    const created = board.createGrant(mgr, {
      principals: [{ kind: 'user', userId: 'other' }],
      can: { 'sec/': ['read', 'manage'] },
    })
    expect(created.id).toBeTruthy()

    try {
      board.createGrant(mgr, {
        principals: [{ kind: 'all-users' }],
        can: { 'sec/': ['read'] },
      })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(409)
      expect((e as BoardError).code).toBe('grant_lockout')
    }

    const withLockOut = board.createGrant(mgr, {
      principals: [{ kind: 'all-users' }],
      can: { 'sec/': ['read'] },
      lockMeOut: true,
    })
    expect(withLockOut.can['sec/']).toEqual(['read'])
  })

  it('prevents blind-poster idempotency replay from leaking post-land labels, reactions, or non-blind posts', () => {
    const board = setup(false)
    const owner = createLocalCaller({ userId: 'owner', handle: 'owner', owner: true })

    board.createGrant(owner, {
      principals: [{ kind: 'user', userId: 'bob' }],
      can: { dropbox: ['post'] },
    })
    const bob: CallerContext = {
      principal: { id: 'user:bob', kind: 'user', handle: 'bob', userId: 'bob', member: false },
      actor: { id: 'user:bob', kind: 'person', handle: 'bob', name: 'Bob', avatar: null },
      profile: null,
    }

    const { message: first } = board.postMessage(bob, {
      channel: 'dropbox',
      text: 'initial secret drop',
      id: 'blind-idem-1',
    })
    expect(first.blind).toBe(true)

    // A blind (post-only) writer cannot attach labels: label implies read
    // (original access.ts:34 IMPLIES.label = ['read']; writes.ts:176 authorizePost).
    try {
      board.postMessage(bob, { channel: 'dropbox', text: 't', labels: { a: 'b' } })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(403)
    }

    // Only the author edits (original writes.ts:139-142 authorizeOwn, :685 writeEdit): the owner
    // cannot rewrite bob's post, but bob can edit his own blind post after it lands.
    try {
      board.editMessage(owner, first.id, { text: 'edited by owner' })
      expect.unreachable()
    } catch (e) {
      expect((e as BoardError).status).toBe(403)
    }
    board.editMessage(bob, first.id, { text: 'edited after landing' })
    // Owner adds an internal label and reacts post-land
    board.labelMessage(owner, first.id, { set: { internal_triage: 'high_risk_fraud' } })
    board.reactMessage(owner, first.id, { emoji: 'warning' })

    // Replaying as blind poster returns initial snapshot only
    const { message: replay } = board.postMessage(bob, {
      channel: 'dropbox',
      text: 'initial secret drop',
      id: 'blind-idem-1',
    })
    expect(replay.id).toBe(first.id)
    expect(replay.blind).toBe(true)
    expect(replay.text).toBe('initial secret drop')
    expect(replay.labels).toEqual({})
    expect(replay.reactions).toEqual({})

    // Non-blind post whose author later loses read must refuse replay (409 duplicate_id)
    const gRead = board.createGrant(owner, {
      principals: [{ kind: 'user', userId: 'bob' }],
      can: { inbox: ['read', 'post'] },
    })
    board.postMessage(bob, { channel: 'inbox', text: 'readable post', id: 'nonblind-idem-1' })
    board.updateGrant(owner, gRead.id, { can: { inbox: ['post'] } })

    try {
      board.postMessage(bob, { channel: 'inbox', text: 'readable post', id: 'nonblind-idem-1' })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(BoardError)
      expect((e as BoardError).status).toBe(409)
      expect((e as BoardError).code).toBe('duplicate_id')
    }
  })

  it('returns full PERMISSIONS in explainAccess for owner without grants and narrows can (not capped) for x-board-can', () => {
    const board = setup(false)
    const owner = createLocalCaller({ userId: 'owner', handle: 'owner', owner: true })

    const expOwner = board.explainAccess(owner, { channel: 'dev' })
    expect(expOwner.can).toEqual(['read', 'post', 'react', 'label', 'sync', 'manage'])
    expect(expOwner.capped).toBeNull()

    const cappedOwner = createLocalCaller({
      userId: 'owner',
      handle: 'owner',
      owner: true,
      canHeader: 'dev/=read,post',
    })
    const expCappedOwner = board.explainAccess(cappedOwner, { channel: 'dev' })
    expect(expCappedOwner.can).toEqual(['read', 'post'])
    // `capped` names the team role that caps a person (original api/routes.ts:858,868); an
    // x-board-can narrowing is no role, and a board without roles answers null (trust.ts:451-452).
    expect(expCappedOwner.capped).toBeNull()

    board.createGrant(owner, {
      principals: [{ kind: 'user', userId: 'alice' }],
      can: { 'dev/': ['read', 'post', 'label'] },
    })
    const cappedAlice = createLocalCaller({
      userId: 'alice',
      handle: 'alice',
      member: false,
      canHeader: 'dev/=read',
    })
    const expAlice = board.explainAccess(cappedAlice, { channel: 'dev/sub' })
    expect(expAlice.can).toEqual(['read'])
    expect(expAlice.capped).toBeNull()
  })
})
