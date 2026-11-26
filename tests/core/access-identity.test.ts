import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  SqliteUnifiedStore,
  type CallerContext,
} from '../../src/core/index.ts'

// Regression tests for the M1 access-control and identity gap fixes (batch A). Each cites the
// original Vercel board source it matches (board/packages/board/src/...).

const stores: SqliteUnifiedStore[] = []

function setup(seedDefaultGrants = true): BoardService {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return new BoardService(store, { seedDefaultGrants })
}

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close()
})

function caught(fn: () => unknown): BoardError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(BoardError)
    return e as BoardError
  }
  throw new Error('expected a BoardError')
}

const owner = (): CallerContext => createLocalCaller({ userId: 'owner', handle: 'owner', owner: true })
const reader = (): CallerContext => createLocalCaller({ userId: 'reader', handle: 'reader', canHeader: '*=read' })

const appCaller = (id: string): CallerContext => ({
  principal: { id: `app:${id}`, kind: 'app', handle: id, clientId: id, teamApp: false },
  actor: { id: `app:${id}`, kind: 'agent', handle: id, name: id, avatar: null },
  profile: null,
})

const platformUser = (id: string, handle = 'malte') => ({
  id,
  handle,
  name: 'Malte Ubl',
  avatar: null,
  isBot: false,
})

describe('GAP-008 grants listing and explain are for listers only (trust.ts:189-198, :408-452)', () => {
  it('refuses listGrants and a named explain to a caller without manage at *, and hides decided grants', () => {
    const board = setup()
    const r = reader()
    const e1 = caught(() => board.listGrants(r))
    expect(e1.status).toBe(403)
    expect(e1.code).toBe('forbidden')

    const e2 = caught(() => board.explainAccess(r, { channel: 'dev', user: 'bob' }))
    expect(e2.status).toBe(403)

    const own = board.explainAccess(r, { channel: 'dev' })
    expect(own.can).toEqual(['read'])
    expect(own.grants).toEqual([])

    const o = owner()
    expect(board.listGrants(o).map((g) => g.id)).toEqual(['g1', 'g2', 'g3'])
    const bob = board.explainAccess(o, { channel: 'dev', user: 'bob' })
    expect(bob.grants.map((g) => g.id)).toEqual(['g1'])
    // A member who manages * lists them too.
    expect(board.listGrants(createLocalCaller({ userId: 'm', handle: 'm' })).length).toBe(3)
  })
})

describe('GAP-009 grant principals are validated (auth.ts:193-321)', () => {
  it('refuses an oidc principal without a sub, a private or http issuer, and a wildcard sub', () => {
    const board = setup()
    const o = owner()
    const grant = (principal: Record<string, unknown>) =>
      caught(() => board.createGrant(o, { principals: [principal], can: { '*': ['read', 'post'] } }))
    for (const principal of [
      { kind: 'oidc', issuer: 'https://issuer.example.com', claims: { aud: 'x' } },
      { kind: 'oidc', issuer: 'http://issuer.example.com', claims: { sub: 'a' } },
      { kind: 'oidc', issuer: 'https://localhost', claims: { sub: 'a' } },
      { kind: 'oidc', issuer: 'https://token.actions.githubusercontent.com', claims: { sub: 'a' } },
      { kind: 'oidc', issuer: 'https://oidc.vercel.com/acme', claims: { sub: 'a' } },
      { kind: 'oidc', issuer: 'https://issuer.example.com', claims: { sub: '*' } },
      { kind: 'oidc', issuer: 'https://issuer.example.com', claims: { sub: 'a*b' } },
      { kind: 'project', project: 'my-project', environments: ['production'] },
      { kind: 'project', project: 'prj_abc' },
      { kind: 'all-projects', environments: ['staging'] },
      { kind: 'github', repository: 'not a repo' },
      { kind: 'user', email: 'ada@example.com' },
      { kind: 'user', userId: 'bad id with spaces' },
      { kind: 'app', app: 'bad app!' },
    ]) {
      const e = grant(principal)
      expect(e.status, JSON.stringify(principal)).toBe(400)
      expect(e.code, JSON.stringify(principal)).toBe('invalid_grant')
    }
  })

  it('normalises workflow, branch and environments, and dedupes principals', () => {
    const board = setup()
    const g = board.createGrant(owner(), {
      principals: [
        { kind: 'github', repository: 'acme/api', workflow: 'ci.yml', branch: 'refs/heads/main' },
        { kind: 'project', project: 'prj_abc', environments: ['development', 'production', 'production'] },
        { kind: 'user', userId: 'ada' },
        { kind: 'user', userId: 'ada' },
        { kind: 'oidc', issuer: 'https://issuer.example.com', claims: { sub: 'project_path:acme/api:*' } },
      ],
      can: { 'dev/': ['read'] },
    })
    expect(g.principals).toEqual([
      { kind: 'github', repositoryId: null, repository: 'acme/api', workflow: '.github/workflows/ci.yml', branch: 'main' },
      { kind: 'project', projectId: 'prj_abc', name: null, environments: ['production', 'development'], teamId: null },
      { kind: 'user', userId: 'ada', email: null },
      { kind: 'oidc', issuer: 'https://issuer.example.com', claims: { sub: 'project_path:acme/api:*' } },
    ])
  })

  it('takes a user login only where the verifier names people by login', () => {
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    stores.push(store)
    const board = new BoardService(store, { logins: true })
    const g = board.createGrant(owner(), {
      principals: [{ kind: 'user', email: 'Ada@Example.com' }],
      can: { dev: ['read'] },
    })
    expect(g.principals).toEqual([{ kind: 'user', userId: 'ada@example.com', email: null }])
  })

  it('takes manage at * to name an oidc issuer (trust.ts:297-299, :394)', () => {
    const board = setup(false)
    const o = owner()
    board.createGrant(o, { principals: [{ kind: 'user', userId: 'mgr' }], can: { 'dev/': 'all' } })
    const mgr = createLocalCaller({ userId: 'mgr', handle: 'mgr', member: false })
    // A user grant in its reach is fine...
    board.createGrant(mgr, { principals: [{ kind: 'user', userId: 'x' }], can: { 'dev/a': ['read'] } })
    // ...but naming an issuer makes the board trust its tokens.
    const e = caught(() =>
      board.createGrant(mgr, {
        principals: [{ kind: 'oidc', issuer: 'https://issuer.example.com', claims: { sub: 'a' } }],
        can: { 'dev/a': ['read'] },
      }),
    )
    expect(e.status).toBe(403)
    expect(e.message).toContain('naming an oidc issuer')
  })
})

describe('GAP-010 updateGrant removes, joins and judges like the original (trust.ts:304-345, auth.ts:336-377)', () => {
  it('removes a repository principal whatever workflow it names and answers not_in_grant', () => {
    const board = setup(false)
    const o = owner()
    const g = board.createGrant(o, {
      principals: [
        { kind: 'github', repository: 'o/r', workflow: 'ci.yml' },
        { kind: 'user', userId: 'keep' },
      ],
      can: { dev: ['read'] },
    })
    const updated = board.updateGrant(o, g.id, { remove: [{ kind: 'github', repository: 'o/r' }] })
    expect(updated.principals).toEqual([{ kind: 'user', userId: 'keep', email: null }])

    const e = caught(() => board.updateGrant(o, g.id, { remove: [{ kind: 'user', userId: 'nobody' }] }))
    expect(e.status).toBe(400)
    expect(e.code).toBe('not_in_grant')
  })

  it('joins environments into a project the grant names already', () => {
    const board = setup(false)
    const o = owner()
    const g = board.createGrant(o, {
      principals: [{ kind: 'project', project: 'prj_abc', environments: ['production'] }],
      can: { dev: ['read'] },
    })
    const updated = board.updateGrant(o, g.id, {
      add: [{ kind: 'project', project: 'prj_abc', environments: ['preview'] }],
    })
    expect(updated.principals).toEqual([
      { kind: 'project', projectId: 'prj_abc', name: null, environments: ['production', 'preview'], teamId: null },
    ])
  })

  it('judges a remove-only update by reach, not by what making it would take', () => {
    const board = setup(false)
    const o = owner()
    // Everyone may read everywhere; mgr manages dev/ but its token is narrowed to dev/.
    board.createGrant(o, { principals: [{ kind: 'everyone' }], can: { '*': ['read'] } })
    board.createGrant(o, { principals: [{ kind: 'user', userId: 'mgr' }], can: { 'dev/': 'all' } })
    const g = board.createGrant(o, {
      principals: [
        { kind: 'user', userId: 'x' },
        { kind: 'user', userId: 'y' },
      ],
      can: { 'dev/': ['read'] },
    })
    const mgr = createLocalCaller({ userId: 'mgr', handle: 'mgr', member: false, canHeader: 'dev/=all' })
    const updated = board.updateGrant(mgr, g.id, { remove: [{ kind: 'user', userId: 'y' }] })
    expect(updated.principals).toEqual([{ kind: 'user', userId: 'x', email: null }])
  })

  it('answers a caller that cannot list grants the same 403 for a missing grant', () => {
    const board = setup()
    const e = caught(() => board.updateGrant(reader(), 'g999', { can: { dev: ['read'] } }))
    expect(e.status).toBe(403)
    const e2 = caught(() => board.updateGrant(owner(), 'g999', { can: { dev: ['read'] } }))
    expect(e2.status).toBe(404)
    expect(e2.code).toBe('grant_not_found')
  })
})

describe('GAP-011 grant ids are never reused (trust.ts:56-71)', () => {
  it('issues a new id after the highest grant is revoked', () => {
    const board = setup()
    const o = owner()
    const first = board.createGrant(o, { principals: [{ kind: 'user', userId: 'a' }], can: { dev: ['read'] } })
    expect(first.id).toBe('g4')
    expect(board.revokeGrant(o, first.id)).toEqual({ revoked: true })
    const second = board.createGrant(o, { principals: [{ kind: 'user', userId: 'b' }], can: { dev: ['read'] } })
    expect(second.id).toBe('g5')
  })
})

describe('GAP-012 revoking a missing grant (trust.ts:456-471)', () => {
  it('answers revoked:false to a lister and 403 to anyone else', () => {
    const board = setup()
    expect(board.revokeGrant(owner(), 'g999')).toEqual({ revoked: false })
    const e = caught(() => board.revokeGrant(reader(), 'g999'))
    expect(e.status).toBe(403)
    expect(e.code).toBe('forbidden')
  })
})

describe('GAP-013 explain names principals as the original does (trust.ts:139-179, :430-452)', () => {
  it('refuses a malformed claim, a project name, an email, and a non-URL issuer', () => {
    const board = setup()
    const o = owner()
    for (const query of [
      { channel: 'dev', oidc: 'https://issuer.example.com', claim: ['bad'] },
      { channel: 'dev', oidc: 'not a url', claim: ['sub=a'] },
      { channel: 'dev', project: 'my-project' },
      { channel: 'dev', user: 'ada@example.com' },
    ]) {
      expect(caught(() => board.explainAccess(o, query)).status, JSON.stringify(query)).toBe(400)
    }
  })

  it('answers nothing for an app and defaults a github run to main with its workflow_ref', () => {
    const board = setup(false)
    const o = owner()
    board.createGrant(o, { principals: [{ kind: 'app', app: 'dropbox' }], can: { dev: ['read'] } })
    const app = board.explainAccess(o, { channel: 'dev', app: 'dropbox' })
    expect(app.can).toEqual([])
    expect(app.grants).toEqual([])

    board.createGrant(o, {
      principals: [{ kind: 'github', repository: 'acme/api', workflow: 'ci.yml', branch: 'main' }],
      can: { dev: ['read', 'post'] },
    })
    const run = board.explainAccess(o, { channel: 'dev', github: 'acme/api', workflow: 'ci.yml' })
    expect(run.can).toEqual(['read', 'post'])
    const other = board.explainAccess(o, { channel: 'dev', github: 'acme/api', workflow: 'ci.yml', branch: 'dev' })
    expect(other.can).toEqual([])
  })
})

describe('GAP-014/015 schema registry (server/schemas.ts:62-86)', () => {
  const definition = { type: 'object', properties: { ok: { type: 'boolean' } } }

  it('registers a schema only with manage at *', () => {
    const board = setup()
    const poster = createLocalCaller({ userId: 'p', handle: 'p', canHeader: 'dev/=read,post' })
    const e = caught(() => board.createSchema(poster, { name: 'deploy-check', version: 1, schema: definition }))
    expect(e.status).toBe(403)
    expect(e.message).toContain('manage at *')
    expect(board.createSchema(owner(), { name: 'deploy-check', version: 1, schema: definition }).created).toBe(true)
  })

  it('caps the description, names which part differs, and says whether it was created', () => {
    const board = setup()
    const o = owner()
    const long = caught(() =>
      board.createSchema(o, { name: 'x', version: 1, description: 'd'.repeat(2001), schema: definition }),
    )
    expect(long.status).toBe(400)
    const made = board.createSchema(o, { name: 'x', version: 1, description: 'first', schema: definition })
    expect(made.created).toBe(true)
    const again = board.createSchema(o, { name: 'x', version: 1, description: 'first', schema: definition })
    expect(again.created).toBe(false)
    const differs = caught(() =>
      board.createSchema(o, { name: 'x', version: 1, description: 'second', schema: definition }),
    )
    expect(differs.status).toBe(409)
    expect(differs.code).toBe('schema_immutable')
    expect(differs.message).toContain('description')
  })
})

describe('GAP-019 sync imports cannot write as anyone the board signs in (a2.ts:170-191, :1201-1235)', () => {
  function syncSetup() {
    const board = setup()
    const alice = createLocalCaller({ userId: 'alice', handle: 'alice' })
    board.postMessage(alice, { channel: 'dev', text: 'hello from alice' })
    const bot = createLocalCaller({ userId: 'syncbot', handle: 'syncbot' })
    board.registerWatchers(bot, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    return { board, alice, bot }
  }

  it('refuses an author the board signs in, an unregistered key, and an ID outside the key', () => {
    const { board, bot } = syncSetup()
    const post = (author: ReturnType<typeof platformUser>, from: string | null = 'slack') =>
      caught(() => board.syncImport(bot, { op: 'post', author, from, channel: 'dev', text: 'spoof' }))
    expect(post(platformUser('local:user:alice', 'alice')).status).toBe(403)
    expect(post(platformUser('slack:U1'), 'teams').status).toBe(403)
    expect(post(platformUser('U1')).status).toBe(403)
    const unregistered = createLocalCaller({ userId: 'other', handle: 'other' })
    const e = caught(() =>
      board.syncImport(unregistered, { op: 'post', author: platformUser('slack:U1'), from: 'slack', channel: 'dev', text: 'x' }),
    )
    expect(e.status).toBe(403)
  })

  it('records an import as a profile of the importer and leaves existing actors untouched', () => {
    const { board, bot, alice } = syncSetup()
    const { message } = board.syncImport(bot, {
      op: 'post',
      author: platformUser('slack:U1', 'Malte Ubl'),
      from: 'slack',
      channel: 'dev',
      text: 'from slack',
    })
    expect(message.by.actor).toBe('local:user:syncbot+slack:U1')
    expect(message.by.principal).toBe('local:user:syncbot')
    expect(message.author?.handle).toBe('syncbot/malte-ubl')
    expect(message.author?.via).toEqual({ name: 'syncbot', environment: null })

    const actors = board.listActors(alice)
    const aliceView = actors.find((a) => a.id === 'local:user:alice')
    expect(aliceView?.kind).toBe('person')
    expect(aliceView?.handle).toBe('alice')
    expect(actors.find((a) => a.id === 'slack:U1')).toBeUndefined()
  })
})

describe('GAP-025 listActors for a caller that reads some channels (a2.ts:350-364, :500-520)', () => {
  it('shows who wrote, was mentioned, or reacted where it reads, sorted, and settles @handles', () => {
    const board = setup()
    const ada = createLocalCaller({ userId: 'ada', handle: 'ada' })
    const zed = createLocalCaller({ userId: 'zed', handle: 'zed' })
    const hidden = createLocalCaller({ userId: 'hidden', handle: 'hidden' })
    const { message } = board.postMessage(ada, { channel: 'dev', text: 'ship it' })
    board.reactMessage(zed, message.id, { emoji: 'eyes' })
    board.postMessage(hidden, { channel: 'secret', text: 'not for dev readers' })

    const narrow = createLocalCaller({ userId: 'nar', handle: 'nar', canHeader: 'dev/=read,post' })
    const posted = board.postMessage(narrow, { channel: 'dev', text: 'thanks @ada' })
    expect(posted.mentions?.[0]?.actor?.id).toBe('local:user:ada')

    const handles = board.listActors(narrow).map((a) => a.handle)
    expect(handles).toEqual(['ada', 'nar', 'zed'])
  })
})

describe('GAP-028 record events never reach /events (feed.ts; trust.ts ACCESS_SESSION)', () => {
  it('serves no grant, schema or schedule events to a reader of every channel', async () => {
    const board = setup()
    const o = owner()
    const g = board.createGrant(o, { principals: [{ kind: 'user', userId: 'ada' }], can: { dev: ['read'] } })
    board.updateGrant(o, g.id, { can: { dev: ['read', 'post'] } })
    board.revokeGrant(o, g.id)
    board.createSchema(o, { name: 'x', version: 1, schema: { type: 'object' } })
    board.postMessage(o, { channel: 'dev', text: 'a message' })
    const page = await board.getEvents(reader(), { after: '0', all: true })
    const types = page.events.map((e) => e.type)
    expect(types).toContain('message.posted')
    expect(types.filter((t) => /^(grant|schema|schedule)\./.test(t))).toEqual([])
  })

  it('hides a link snapshot of a message the reader cannot read', async () => {
    const board = setup()
    const bot = createLocalCaller({ userId: 'syncbot', handle: 'syncbot' })
    board.registerWatchers(bot, { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const { message: secret } = board.postMessage(bot, { channel: 'secret', text: 'classified' })
    const { message: open } = board.postMessage(bot, { channel: 'dev', text: 'open' })
    board.syncImport(bot, {
      op: 'links',
      author: platformUser('slack:U1'),
      from: 'slack',
      message: open.id,
      links: [{ url: 'https://example.com/x', message: secret.id, snapshot: null, unavailable: null }],
    })
    const devReader = createLocalCaller({ userId: 'r', handle: 'r', canHeader: 'dev/=read' })
    const page = await board.getEvents(devReader, { after: '0', channel: 'dev' })
    const linked = page.events.find((e) => e.type === 'message.linked')
    expect(linked).toBeDefined()
    const links = linked!.payload.links as { snapshot: unknown; message: unknown }[]
    expect(links[0]?.snapshot).toBeNull()
    expect(links[0]?.message).toBeNull()
  })
})

describe('GAP-036 an unadmitted caller (auth.ts:452-505)', () => {
  it('gets 403 forbidden with the grant that would let it in', () => {
    const board = setup(false)
    const e = caught(() => board.listChannels(appCaller('outsider')))
    expect(e.status).toBe(403)
    expect(e.code).toBe('forbidden')
    expect(e.message).toContain('no grant lets in app outsider')
    expect(e.hint).toBe('Grant it: vb grants create --app outsider')
  })

  it('gets 401 for an oidc issuer no grant names', () => {
    const board = setup(false)
    const oidc: CallerContext = {
      principal: { id: 'oidc:x:a', kind: 'oidc', handle: 'a', issuer: 'https://unknown.example.com', claims: { sub: 'a' } },
      actor: { id: 'oidc:x:a', kind: 'agent', handle: 'a', name: 'a', avatar: null },
      profile: null,
    }
    expect(caught(() => board.listChannels(oidc)).status).toBe(401)
  })
})
