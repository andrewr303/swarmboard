// Unit tests for HOST-12 Command Center Web UI:
// - Bundle budget (< 60 KB gzipped), JS syntax validity, zero external runtime deps
// - Static XSS hygiene (zero innerHTML/outerHTML/insertAdjacentHTML/document.write/eval)
// - Rich text tokenizer & URL sanitization (blocks javascript:/data: schemes & HTML injection)
// - State projections (spaces, collapsible category tree, DMs, Announcements->Sticky->Active, Needs You, autocomplete)
// - Static UI handler (CSP, ETag / If-None-Match 304, HEAD, 404/traversal refusal, HS-01/HS-03 hygiene)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createUiHandler, getUiBundleStats, UI_CSP_HEADER } from '../../src/server/ui.ts'
import type { ServerListenerContext } from '../../src/server/types.ts'
import { UI_ASSETS, UI_BUNDLE_STATS } from '../../src/ui/bundle.ts'
import {
  avatarMonogram,
  emojiDisplay,
  excerptText,
  firstLineTitle,
  formatCanonicalActorHandle,
  formatCanonicalMentionsText,
  isSafeHttpUrl,
  tokenizeInlineRichText,
} from '../../src/ui/dom.ts'
import {
  buildActorLabelMap,
  buildAutocompleteItems,
  canReopenTaskState,
  createInitialState,
  deriveSpaces,
  extractDmPeer,
  flattenChannelTree,
  groupChannelsByCategory,
  needsYouCount,
  openFeedbackCount,
  partitionForumThreads,
  resolveEventRootId,
} from '../../src/ui/state.ts'
import type { UiChannelTreeNode, UiChannelView, UiMessageView, UiThreadSummaryView } from '../../src/ui/types.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const LOOPBACK_CTX: ServerListenerContext = { listener: 'tcp-loopback', port: 4180 }

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

function fakeMessage(overrides: Partial<UiMessageView> = {}): UiMessageView {
  return {
    id: '1',
    channel: 'general',
    text: 'Hello world',
    re: null,
    replyTo: null,
    thread: 'thr_1',
    labels: {},
    reactions: {},
    by: { actor: 'local:user:alice+codex', principal: 'local:user:alice', profile: 'codex' },
    createdAt: '2026-11-26T00:00:00.000Z',
    editedAt: null,
    deleted: false,
    revision: 1,
    author: { kind: 'agent', handle: 'alice/codex', name: 'codex', avatar: null },
    blocks: [],
    ...overrides,
  }
}

describe('HOST-12 UI bundle integrity, size budget, and XSS hygiene', () => {
  it('stays strictly under 60 KiB gzipped and produces syntactically valid JS', () => {
    const stats = getUiBundleStats()
    expect(stats).toEqual(UI_BUNDLE_STATS)
    expect(stats.assetCount).toBeGreaterThanOrEqual(4)
    expect(stats.totalGzipBytes).toBeGreaterThan(1000)
    expect(stats.totalGzipBytes).toBeLessThan(60 * 1024)

    expect(UI_ASSETS['/']?.contentType).toContain('text/html')
    expect(UI_ASSETS['/assets/app.js']?.contentType).toContain('text/javascript')
    expect(UI_ASSETS['/assets/app.css']?.contentType).toContain('text/css')
    expect(UI_ASSETS['/assets/favicon.svg']?.contentType).toContain('image/svg+xml')

    // V8 parse check guarantees zero syntax errors in bundled browser script
    expect(() => new vm.Script(UI_ASSETS['/assets/app.js']!.body, { filename: 'app.js' })).not.toThrow()
  })

  it('has zero inline scripts or external CDN resources in index.html', () => {
    const html = UI_ASSETS['/']!.body
    expect(html).toContain('<script type="module" src="/assets/app.js"></script>')
    expect(html).toContain('<link rel="stylesheet" href="/assets/app.css"')
    // No inline script body
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
    // No external third-party URLs
    expect(html).not.toMatch(/https?:\/\//i)
  })

  it('contains zero unsafe DOM HTML sinks across all src/ui source files and emitted bundle', () => {
    const unsafeSinkRe = /\.(?:innerHTML|outerHTML|insertAdjacentHTML)\b|\bdocument\.write\s*\(|\beval\s*\(|\bnew\s+Function\s*\(/
    const uiFiles = walkFiles(join(ROOT, 'src', 'ui')).filter((f) => f.endsWith('.ts') && !f.endsWith('bundle.ts'))
    expect(uiFiles.length).toBeGreaterThanOrEqual(10)

    const hits: string[] = []
    for (const f of uiFiles) {
      const content = readFileSync(f, 'utf8')
      // Strip comments so explanatory comments don't trigger false positives
      const stripped = content.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      if (unsafeSinkRe.test(stripped)) {
        hits.push(relative(ROOT, f))
      }
    }
    expect(hits).toEqual([])
    expect(unsafeSinkRe.test(UI_ASSETS['/assets/app.js']!.body)).toBe(false)
  })

  it('enforces HS-01 and HS-03 cleanliness on src/server/ui.ts', () => {
    const src = readFileSync(join(ROOT, 'src', 'server', 'ui.ts'), 'utf8')
    expect(src).not.toMatch(/\b(?:normalizeError|toErrorPayload|toErrorResponse)\b/)
    expect(src).not.toMatch(/internal\.ts/)
    expect(src).not.toMatch(/src\/host|\.\.\/host/)
    expect(src).not.toMatch(/from\s+['"]swarmboard(?:\/|['"])/)
  })
})

describe('HOST-12 XSS-safe rich text tokenizer & DOM formatting helpers', () => {
  it('keeps HTML tags and javascript:/data: URLs strictly inert text tokens', () => {
    expect(isSafeHttpUrl('https://swarmboard.local/docs')).toBe(true)
    expect(isSafeHttpUrl('http://127.0.0.1:4180/')).toBe(true)
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeHttpUrl('vbscript:msgbox(1)')).toBe(false)

    const payload = '<script>alert("xss")</script> <img src=x onerror=alert(1)> javascript:alert(1)'
    const tokens = tokenizeInlineRichText(payload)
    expect(tokens.every((t) => t.kind === 'text')).toBe(true)
    expect(tokens.map((t) => t.value).join('')).toBe(payload)
  })

  it('tokenizes @agent, @group, #channel, inline code, and safe https URLs cleanly', () => {
    const groups = new Set(['swarmteam3', 'reviewers'])
    const line = 'Ping @codex and @swarmteam3 + @here in #repos/agent-board/dev with `pnpm test` https://example.com/pr/1.'
    const tokens = tokenizeInlineRichText(line, groups)
    expect(tokens.find((t) => t.kind === 'mention' && t.value === 'codex')).toBeTruthy()
    expect(tokens.find((t) => t.kind === 'group' && t.value === 'swarmteam3')).toBeTruthy()
    expect(tokens.find((t) => t.kind === 'group' && t.value === 'here')).toBeTruthy()
    expect(tokens.find((t) => t.kind === 'channel' && t.value === 'repos/agent-board/dev')).toBeTruthy()
    expect(tokens.find((t) => t.kind === 'code' && t.value === 'pnpm test')).toBeTruthy()
    expect(tokens.find((t) => t.kind === 'url' && t.value === 'https://example.com/pr/1')).toBeTruthy()
  })

  it('UI-F1 parses canonical @[actorId] mentions into clickable pills and clean titles/excerpts', () => {
    const groups = new Set(['ui-devs'])
    const actors = new Map<string, string>([
      ['local:user:alice', 'alice'],
      ['local:user:alice+codex', 'alice/codex'],
    ])

    const tokens = tokenizeInlineRichText(
      'Ping @[local:user:alice], @[local:user:alice+codex], @[tailscale:user:ada@ex.com+agy], and @ui-devs',
      groups,
      actors,
    )
    expect(tokens.filter((t) => t.kind === 'mention')).toEqual([
      { kind: 'mention', raw: '@alice', value: 'alice' },
      { kind: 'mention', raw: '@alice/codex', value: 'codex' },
      { kind: 'mention', raw: '@ada@ex.com/agy', value: 'agy' },
    ])
    expect(tokens.find((t) => t.kind === 'group' && t.value === 'ui-devs')).toBeTruthy()

    // Fallback without actorLabels strips local:user: / tailscale:user: and converts + -> /
    expect(formatCanonicalActorHandle('local:user:alice')).toBe('alice')
    expect(formatCanonicalActorHandle('local:user:alice+codex')).toBe('alice/codex')
    expect(formatCanonicalActorHandle('tailscale:user:alice@corp.io+claude')).toBe('alice@corp.io/claude')
    expect(formatCanonicalMentionsText('Review @[local:user:alice] + @[local:user:alice+codex]')).toBe(
      'Review @alice + @alice/codex',
    )
    expect(firstLineTitle('Decision for @[local:user:alice+codex]\nSecond line', 110, actors)).toBe(
      'Decision for @alice/codex',
    )
    expect(excerptText('Quote @[local:user:alice] here', 160, actors)).toBe('Quote @alice here')

    // buildActorLabelMap populates from state actors/presence/me
    const st = createInitialState()
    st.actors = [{ id: 'local:user:alice+agy', kind: 'agent', handle: 'alice/agy', name: 'agy', avatar: null }]
    expect(buildActorLabelMap(st).get('local:user:alice+agy')).toBe('alice/agy')
  })

  it('UI-F2 restricts task Reopen strictly to failed state and UI-F3 resolves SSE event rootId without payload.id', () => {
    expect(canReopenTaskState('failed')).toBe(true)
    expect(canReopenTaskState('completed')).toBe(false)
    expect(canReopenTaskState('canceled')).toBe(false)
    expect(canReopenTaskState('ready')).toBe(false)
    expect(canReopenTaskState('claimed')).toBe(false)
    expect(canReopenTaskState('blocked')).toBe(false)
    expect(canReopenTaskState('waiting')).toBe(false)

    // Real SSE message.posted on a root post omits payload.id and provides payload.thread + cursor
    expect(
      resolveEventRootId({
        cursor: '42',
        type: 'message.posted',
        createdAt: '2026-11-26T00:00:00Z',
        payload: { channel: 'decisions', thread: 'thr_abc123', re: null },
      }),
    ).toBe('thr_abc123')

    // Reply prefers payload.re
    expect(
      resolveEventRootId({
        cursor: '43',
        type: 'message.posted',
        createdAt: '2026-11-26T00:00:00Z',
        payload: { channel: 'decisions', thread: 'thr_abc123', re: '42' },
      }),
    ).toBe('42')

    // Fallback to cursor when thread & id absent
    expect(
      resolveEventRootId({
        cursor: '99',
        type: 'message.posted',
        createdAt: '2026-11-26T00:00:00Z',
        payload: { channel: 'decisions' },
      }),
    ).toBe('99')

    // Confirm bundled app.js includes claim_lost eviction & canReopenTaskState guard
    const js = UI_ASSETS['/assets/app.js']!.body
    expect(js).toContain("err.code === 'claim_lost'")
    expect(js).toContain('canReopenTaskState')
    expect(js).toContain('resolveEventRootId')
  })

  it('formats titles, excerpts, monograms, and shortcode emojis cleanly', () => {
    expect(firstLineTitle('# Launch Checklist\nDetails here')).toBe('Launch Checklist')
    expect(excerptText('Hello ```ts\nconst x = 1\n``` world')).toBe('Hello [code] world')
    expect(avatarMonogram('agent-board')).toBe('AB')
    expect(avatarMonogram('local:user:alice+codex')).toBe('CO')
    expect(emojiDisplay('thumbs_up')).toBe('👍')
    expect(emojiDisplay('party')).toBe('🎉')
    expect(emojiDisplay('unknown_custom')).toBe(':unknown_custom:')
  })
})

describe('HOST-12 state projections, channel tree, forum tiers & autocomplete', () => {
  it('flattens channel trees, derives spaces, groups collapsible categories, and extracts DM peers', () => {
    const tree: UiChannelTreeNode[] = [
      {
        path: 'general',
        segment: 'general',
        virtual: false,
        channel: { path: 'general', kind: 'chat', unreadCount: 2 },
        unreadCount: 2,
        totalMessages: 10,
        children: [],
      },
      {
        path: 'repos',
        segment: 'repos',
        virtual: true,
        channel: null,
        unreadCount: 5,
        totalMessages: 20,
        children: [
          {
            path: 'repos/agent-board',
            segment: 'agent-board',
            virtual: true,
            channel: null,
            unreadCount: 5,
            totalMessages: 20,
            children: [
              {
                path: 'repos/agent-board/dev',
                segment: 'dev',
                virtual: false,
                channel: { path: 'repos/agent-board/dev', kind: 'chat', unreadCount: 5 },
                unreadCount: 5,
                totalMessages: 20,
                children: [],
              },
            ],
          },
        ],
      },
      {
        path: 'swarms/w4/general',
        segment: 'general',
        virtual: false,
        channel: { path: 'swarms/w4/general', kind: 'chat', unreadCount: 1 },
        unreadCount: 1,
        totalMessages: 4,
        children: [],
      },
      {
        path: 'dm/alice--codex',
        segment: 'alice--codex',
        virtual: false,
        channel: { path: 'dm/alice--codex', kind: 'dm', private: true, unreadCount: 1 },
        unreadCount: 1,
        totalMessages: 3,
        children: [],
      },
    ]

    const flat: UiChannelView[] = flattenChannelTree(tree)
    expect(flat.map((c) => c.path)).toEqual(['general', 'repos/agent-board/dev', 'swarms/w4/general', 'dm/alice--codex'])

    const spaces = deriveSpaces(flat)
    expect(spaces.map((s) => s.id)).toEqual(['global', 'repo:agent-board', 'swarm:w4'])
    expect(spaces[0]?.monogram).toBe('SB')
    expect(spaces.find((s) => s.id === 'repo:agent-board')?.unread).toBe(5)

    const allCats = groupChannelsByCategory(flat, 'global')
    expect(allCats.map((g) => g.key)).toEqual(['Global', 'repos/agent-board', 'swarms/w4'])

    const repoOnly = groupChannelsByCategory(flat, 'repo:agent-board')
    expect(repoOnly.map((g) => g.key)).toEqual(['repos/agent-board'])

    expect(extractDmPeer('dm/alice--codex', 'alice')).toBe('codex')
    expect(extractDmPeer('dm/agy--alice', 'alice')).toBe('agy')
  })

  it('partitions Forum Index threads into Announcements -> Sticky -> Active tiers', () => {
    const threads: UiThreadSummaryView[] = [
      {
        message: fakeMessage({ id: '1', text: 'Board Rules' }),
        replies: 2,
        last: null,
        pin: { scope: 'announcement', note: 'Read first', pinnedBy: 'alice', pinnedAt: '2026-11-26T00:00:00Z' },
      },
      {
        message: fakeMessage({ id: '2', text: 'Wave Plan' }),
        replies: 5,
        last: null,
        pin: { scope: 'channel', note: null, pinnedBy: 'alice', pinnedAt: '2026-11-26T00:00:00Z' },
      },
      {
        message: fakeMessage({ id: '3', text: 'Normal topic' }),
        replies: 1,
        last: null,
      },
    ]

    const tiers = partitionForumThreads(threads)
    expect(tiers.announcements.map((t) => t.message.id)).toEqual(['1'])
    expect(tiers.stickies.map((t) => t.message.id)).toEqual(['2'])
    expect(tiers.regular.map((t) => t.message.id)).toEqual(['3'])
  })

  it('computes Needs You / Decisions counts, feedback counts, and @ / # / slash autocomplete items', () => {
    const state = createInitialState()
    state.tasks = [
      {
        message: fakeMessage({
          id: '10',
          task: {
            state: 'blocked',
            owner: 'local:user:alice',
            by: 'local:user:alice',
            for: null,
            needs: [],
            epoch: 0,
            claim: null,
            blocked: { kind: 'approval', reason: 'Need owner sign-off' },
            result: null,
            reason: null,
          },
        }),
        replies: 0,
        last: null,
      },
    ]
    state.decisionsThreads = [
      { message: fakeMessage({ id: '11', channel: 'decisions', labels: {} }), replies: 0, last: null },
      { message: fakeMessage({ id: '12', channel: 'decisions', labels: { status: 'approved' } }), replies: 1, last: null },
    ]
    state.feedbackThreads = [
      { message: fakeMessage({ id: '13', channel: 'meta/feedback', labels: { status: 'new' } }), replies: 0, last: null },
      { message: fakeMessage({ id: '14', channel: 'meta/feedback', labels: { status: 'resolved' } }), replies: 0, last: null },
    ]
    state.groups = [
      {
        handle: 'swarmteam3',
        name: 'Swarm Team 3',
        description: 'Wave 4 squad',
        kind: 'swarm',
        channel: null,
        members: [{ memberId: 'codex', role: 'member', addedBy: 'alice', addedAt: '2026-11-26T00:00:00Z' }],
        byActor: 'local:user:alice',
        createdAt: '2026-11-26T00:00:00Z',
        updatedAt: '2026-11-26T00:00:00Z',
      },
    ]
    state.presence = [
      {
        agent: 'local:user:alice+codex',
        principal: 'local:user:alice',
        profile: 'codex',
        handle: 'alice/codex',
        harness: 'codex',
        model: 'gpt-5',
        status: 'active',
        channel: 'general',
        taskId: null,
        note: null,
        updatedAt: '2026-11-26T00:00:00Z',
        expiresAt: '2026-11-26T01:00:00Z',
      },
    ]
    state.flatChannels = [{ path: 'repos/agent-board/dev', kind: 'chat', topic: 'Dev room' }]

    expect(needsYouCount(state)).toBe(2) // 1 blocked task + 1 open decision
    expect(openFeedbackCount(state)).toBe(1)

    const atItems = buildAutocompleteItems('@', 'sw', state)
    expect(atItems.some((i) => i.label === '@swarmteam3' && i.kind === 'group')).toBe(true)

    const atAll = buildAutocompleteItems('@', '', state)
    expect(atAll.some((i) => i.label === '@channel')).toBe(true)
    expect(atAll.some((i) => i.label === '@here')).toBe(true)
    expect(atAll.some((i) => i.label === '@codex')).toBe(true)

    const chItems = buildAutocompleteItems('#', 'dev', state)
    expect(chItems.some((i) => i.label === '#repos/agent-board/dev')).toBe(true)

    const slashItems = buildAutocompleteItems('/', 'code', state)
    expect(slashItems.some((i) => i.label === '/code')).toBe(true)
  })
})

describe('HOST-12 static UI handler (CSP, ETag 304, HEAD, 404 traversal)', () => {
  it('serves /, /assets/*, and /favicon.ico with strict CSP, security headers, ETag 304, and HEAD', async () => {
    const ui = createUiHandler()

    const rootRes = await ui(new Request('http://127.0.0.1:4180/'), LOOPBACK_CTX)
    expect(rootRes).not.toBeNull()
    expect(rootRes!.status).toBe(200)
    expect(rootRes!.headers.get('content-type')).toContain('text/html')
    const csp = rootRes!.headers.get('content-security-policy') ?? ''
    expect(csp).toBe(UI_CSP_HEADER)
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("connect-src 'self'")
    expect(rootRes!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(rootRes!.headers.get('referrer-policy')).toBe('no-referrer')
    expect(rootRes!.headers.get('x-frame-options')).toBe('DENY')
    expect(rootRes!.headers.get('cache-control')).toBe('no-cache')

    const etag = rootRes!.headers.get('etag')!
    expect(etag).toMatch(/^"[a-f0-9]{16}"$/)
    const rootHtml = await rootRes!.text()
    expect(rootHtml).toContain('Swarmboard')
    expect(rootHtml).toContain('>SB<')
    expect(rootHtml).not.toContain('>CB<')

    // Exact If-None-Match -> 304
    const notMod = await ui(
      new Request('http://127.0.0.1:4180/', { headers: { 'if-none-match': etag } }),
      LOOPBACK_CTX,
    )
    expect(notMod!.status).toBe(304)
    expect(await notMod!.text()).toBe('')
    expect(notMod!.headers.get('content-security-policy')).toBe(UI_CSP_HEADER)

    // Weak ETag in comma-separated list -> 304
    const weakNotMod = await ui(
      new Request('http://127.0.0.1:4180/', { headers: { 'if-none-match': `"other", W/${etag}` } }),
      LOOPBACK_CTX,
    )
    expect(weakNotMod!.status).toBe(304)

    // HEAD /assets/app.js -> 200 with content-length and empty body
    const headJs = await ui(new Request('http://127.0.0.1:4180/assets/app.js', { method: 'HEAD' }), LOOPBACK_CTX)
    expect(headJs!.status).toBe(200)
    expect(Number(headJs!.headers.get('content-length'))).toBeGreaterThan(1000)
    expect(await headJs!.text()).toBe('')

    // CSS and favicon routes
    const cssRes = await ui(new Request('http://127.0.0.1:4180/assets/app.css'), LOOPBACK_CTX)
    expect(cssRes!.status).toBe(200)
    expect(cssRes!.headers.get('content-type')).toContain('text/css')

    const favRes = await ui(new Request('http://127.0.0.1:4180/favicon.ico'), LOOPBACK_CTX)
    expect(favRes!.status).toBe(200)
    expect(favRes!.headers.get('content-type')).toContain('image/svg+xml')

    // Unknown assets, traversal attempts, and non-GET/HEAD methods return null
    expect(await ui(new Request('http://127.0.0.1:4180/assets/missing.js'), LOOPBACK_CTX)).toBeNull()
    expect(await ui(new Request('http://127.0.0.1:4180/assets/../package.json'), LOOPBACK_CTX)).toBeNull()
    expect(await ui(new Request('http://127.0.0.1:4180/', { method: 'POST' }), LOOPBACK_CTX)).toBeNull()
  })
})
