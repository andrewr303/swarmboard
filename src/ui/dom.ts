// XSS-safe DOM primitives, inline SVG icons, rich text parser, and formatting helpers.
// INVARIANT: ZERO innerHTML / outerHTML / insertAdjacentHTML / document.write anywhere in src/ui/**.

const SVG_NS = 'http://www.w3.org/2000/svg'

export type ChildNodeSpec = Node | string | number | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | boolean | number | null | undefined>,
  ...children: ChildNodeSpec[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (val === undefined || val === null || val === false) continue
      if (key === 'className') {
        node.className = String(val)
      } else if (key === 'textContent') {
        node.textContent = String(val)
      } else if (val === true) {
        node.setAttribute(key, '')
      } else {
        node.setAttribute(key, String(val))
      }
    }
  }
  appendChildren(node, children)
  return node
}

export function appendChildren(parent: Node, children: readonly ChildNodeSpec[]): void {
  for (const ch of children) {
    if (ch === null || ch === undefined || ch === false) continue
    if (typeof ch === 'string' || typeof ch === 'number') {
      parent.appendChild(document.createTextNode(String(ch)))
    } else {
      parent.appendChild(ch)
    }
  }
}

export function clearEl(node: Element): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild)
  }
}

export type IconName =
  | 'bolt'
  | 'home'
  | 'at'
  | 'pin'
  | 'scale'
  | 'bug'
  | 'hash'
  | 'forum'
  | 'tasks'
  | 'megaphone'
  | 'lock'
  | 'dm'
  | 'search'
  | 'users'
  | 'sun'
  | 'moon'
  | 'plus'
  | 'chevron-down'
  | 'chevron-right'
  | 'quote'
  | 'flag'
  | 'smile'
  | 'edit'
  | 'trash'
  | 'check'
  | 'close'
  | 'menu'
  | 'send'
  | 'refresh'
  | 'globe'
  | 'swarm'

const ICON_PATHS: Readonly<Record<IconName, readonly string[]>> = {
  bolt: ['M13 2L4 14h7l-1 8 9-12h-7l1-8z'],
  home: ['M3 10.5L12 3l9 7.5', 'M5 9.5V20h5v-6h4v6h5V9.5'],
  at: ['M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z', 'M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-4 7.5'],
  pin: ['M12 17v5', 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76z'],
  scale: ['M12 3v18', 'M5 7h14', 'M5 7l-2.5 6h5L5 7z', 'M19 7l-2.5 6h5L19 7z', 'M8 21h8'],
  bug: ['M8 9h8v6a4 4 0 0 1-8 0V9z', 'M9 9V7a3 3 0 0 1 6 0v2', 'M4 11h4', 'M16 11h4', 'M4 15h4', 'M16 15h4', 'M5 7l3 2', 'M19 7l-3 2'],
  hash: ['M4 9h16', 'M4 15h16', 'M10 3L8 21', 'M16 3l-2 18'],
  forum: ['M4 5h16v11H8l-4 4V5z', 'M8 9h8', 'M8 12h5'],
  tasks: ['M9 11l2 2 4-4', 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z'],
  megaphone: ['M3 11v2a1 1 0 0 0 1 1h3l6 4V6l-6 4H4a1 1 0 0 0-1 1z', 'M17 8a5 5 0 0 1 0 8', 'M7 14l1.5 5'],
  lock: ['M7 11V7a5 5 0 0 1 10 0v4', 'M5 11h14v9H5z'],
  dm: ['M21 12a8 8 0 0 1-8 8H5l2-3.5A8 8 0 1 1 21 12z'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.35-4.35'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2v2', 'M12 20v2', 'M4.93 4.93l1.41 1.41', 'M17.66 17.66l1.41 1.41', 'M2 12h2', 'M20 12h2', 'M4.93 19.07l1.41-1.41', 'M17.66 6.34l1.41-1.41'],
  moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
  plus: ['M12 5v14', 'M5 12h14'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  quote: ['M10 7H6a2 2 0 0 0-2 2v4h4v4H4', 'M20 7h-4a2 2 0 0 0-2 2v4h4v4h-4'],
  flag: ['M5 21V4', 'M5 4h11l-1.5 4L16 12H5'],
  smile: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01'],
  edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'],
  check: ['M5 13l4 4L19 7'],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4 20-7z'],
  refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3.6 9h16.8', 'M3.6 15h16.8', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
  swarm: ['M12 3l4 2.3v4.6L12 12.2 8 9.9V5.3L12 3z', 'M7 11.8l4 2.3v4.6L7 21l-4-2.3v-4.6l4-2.3z', 'M17 11.8l4 2.3v4.6L17 21l-4-2.3v-4.6l4-2.3z'],
}

export function svgIcon(name: IconName, size = 16, cls = 'cb-icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', cls)
  const paths = ICON_PATHS[name] ?? ICON_PATHS.hash
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

export const EMOJI_GLYPHS: Readonly<Record<string, string>> = {
  thumbs_up: '👍',
  thumbsup: '👍',
  '+1': '👍',
  thumbs_down: '👎',
  thumbsdown: '👎',
  '-1': '👎',
  eyes: '👀',
  rocket: '🚀',
  party: '🎉',
  tada: '🎉',
  heart: '❤️',
  check: '✅',
  white_check_mark: '✅',
  x: '❌',
  fire: '🔥',
  warning: '⚠️',
  thinking: '🤔',
  clap: '👏',
  sparkles: '✨',
  star: '⭐',
  bug: '🐛',
  pin: '📌',
  ship: '🚢',
  100: '💯',
}

export const QUICK_REACTION_CODES: readonly string[] = [
  'thumbs_up',
  'eyes',
  'check',
  'rocket',
  'party',
  'fire',
  'heart',
  'thinking',
]

export function emojiDisplay(code: string): string {
  return EMOJI_GLYPHS[code.toLowerCase()] ?? `:${code}:`
}

export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return iso
  const diffS = Math.max(0, Math.floor((nowMs - ts) / 1000))
  if (diffS < 45) return 'just now'
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`
  if (diffS < 7 * 86400) return `${Math.floor(diffS / 86400)}d ago`
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return iso.slice(0, 10)
  }
}

export function formatFullTime(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return iso
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

const CANONICAL_MENTION_RE = /@\[([^\]\s]+)\]/g

export function formatCanonicalActorHandle(
  actorId: string,
  actorLabels?: ReadonlyMap<string, string>,
): string {
  const known = actorLabels?.get(actorId)
  if (known !== undefined && known.trim() !== '') return known
  const stripped = actorId.replace(/^(?:local|tailscale):user:/i, '')
  const plusIdx = stripped.indexOf('+')
  if (plusIdx > 0) {
    return `${stripped.slice(0, plusIdx)}/${stripped.slice(plusIdx + 1)}`
  }
  return stripped
}

export function formatCanonicalMentionsText(
  text: string,
  actorLabels?: ReadonlyMap<string, string>,
): string {
  if (!text.includes('@[')) return text
  CANONICAL_MENTION_RE.lastIndex = 0
  return text.replace(CANONICAL_MENTION_RE, (_full, actorId: string) => {
    return `@${formatCanonicalActorHandle(actorId, actorLabels)}`
  })
}

export function firstLineTitle(
  text: string,
  maxLen = 110,
  actorLabels?: ReadonlyMap<string, string>,
): string {
  const cleaned = formatCanonicalMentionsText(text.replace(/\r\n/g, '\n'), actorLabels).trim()
  const first = cleaned.split('\n')[0]?.replace(/^#+\s*/, '').trim() ?? ''
  if (first.length <= maxLen) return first || '(untitled)'
  return `${first.slice(0, maxLen - 1)}…`
}

export function excerptText(
  text: string,
  maxLen = 160,
  actorLabels?: ReadonlyMap<string, string>,
): string {
  const flat = formatCanonicalMentionsText(text, actorLabels)
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= maxLen) return flat
  return `${flat.slice(0, maxLen - 1)}…`
}

export function avatarMonogram(label: string): string {
  const clean = label.replace(/^local:user:/, '').replace(/^.*[/+]/, '').trim()
  if (!clean) return '?'
  const parts = clean.split(/[-_\s]+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
  }
  return clean.slice(0, 2).toUpperCase()
}

export function avatarHue(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  return h % 360
}

export function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export interface RichTextHandlers {
  readonly knownGroups?: ReadonlySet<string>
  readonly actorLabels?: ReadonlyMap<string, string>
  readonly onChannelClick?: (channel: string) => void
  readonly onMentionClick?: (handle: string, isGroup: boolean) => void
}

export interface InlineToken {
  readonly kind: 'text' | 'code' | 'mention' | 'group' | 'channel' | 'url'
  readonly raw: string
  readonly value: string
}

const INLINE_TOKEN_RE =
  /(`[^`\n]+`)|(https?:\/\/[^\s<>"'`)\]]+)|((?:^|[\s([{"'])@\[[^\]\s]+\])|((?:^|[\s([{"'])@[a-zA-Z0-9_][a-zA-Z0-9_.:/+-]*)|((?:^|[\s([{"'])#[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*)/g

export function tokenizeInlineRichText(
  line: string,
  knownGroups?: ReadonlySet<string>,
  actorLabels?: ReadonlyMap<string, string>,
): InlineToken[] {
  const out: InlineToken[] = []
  let lastIdx = 0
  INLINE_TOKEN_RE.lastIndex = 0
  for (const m of line.matchAll(INLINE_TOKEN_RE)) {
    const start = m.index ?? 0
    if (start > lastIdx) {
      out.push({ kind: 'text', raw: line.slice(lastIdx, start), value: line.slice(lastIdx, start) })
    }
    if (m[1] !== undefined) {
      const code = m[1].slice(1, -1)
      out.push({ kind: 'code', raw: m[1], value: code })
    } else if (m[2] !== undefined) {
      let url = m[2]
      let trail = ''
      while (url.length > 0 && /[.,!?;:]$/.test(url)) {
        trail = url.slice(-1) + trail
        url = url.slice(0, -1)
      }
      if (isSafeHttpUrl(url)) {
        out.push({ kind: 'url', raw: url, value: url })
      } else {
        out.push({ kind: 'text', raw: url, value: url })
      }
      if (trail) out.push({ kind: 'text', raw: trail, value: trail })
    } else if (m[3] !== undefined) {
      const rawMatch = m[3]
      const atIdx = rawMatch.indexOf('@')
      if (atIdx > 0) {
        const prefix = rawMatch.slice(0, atIdx)
        out.push({ kind: 'text', raw: prefix, value: prefix })
      }
      const token = rawMatch.slice(atIdx)
      const actorId = token.slice(2, -1)
      const displayHandle = formatCanonicalActorHandle(actorId, actorLabels)
      const targetHandle = displayHandle.includes('/') ? displayHandle.slice(displayHandle.lastIndexOf('/') + 1) : displayHandle
      out.push({ kind: 'mention', raw: `@${displayHandle}`, value: targetHandle || displayHandle })
    } else if (m[4] !== undefined) {
      const rawMatch = m[4]
      const atIdx = rawMatch.indexOf('@')
      if (atIdx > 0) {
        const prefix = rawMatch.slice(0, atIdx)
        out.push({ kind: 'text', raw: prefix, value: prefix })
      }
      let token = rawMatch.slice(atIdx)
      let trail = ''
      while (token.length > 1 && /[.,!?;:)]$/.test(token)) {
        trail = token.slice(-1) + trail
        token = token.slice(0, -1)
      }
      const handle = token.slice(1)
      const lower = handle.toLowerCase()
      const isGroup =
        lower === 'channel' ||
        lower === 'here' ||
        lower === 'all' ||
        lower === 'everyone' ||
        (knownGroups !== undefined && knownGroups.has(lower))
      out.push({ kind: isGroup ? 'group' : 'mention', raw: token, value: handle })
      if (trail) out.push({ kind: 'text', raw: trail, value: trail })
    } else if (m[5] !== undefined) {
      const rawMatch = m[5]
      const hashIdx = rawMatch.indexOf('#')
      if (hashIdx > 0) {
        const prefix = rawMatch.slice(0, hashIdx)
        out.push({ kind: 'text', raw: prefix, value: prefix })
      }
      const token = rawMatch.slice(hashIdx)
      out.push({ kind: 'channel', raw: token, value: token.slice(1) })
    }
    lastIdx = start + m[0].length
  }
  if (lastIdx < line.length) {
    const rest = line.slice(lastIdx)
    out.push({ kind: 'text', raw: rest, value: rest })
  }
  return out
}

/**
 * Renders untrusted message markdown/text into pure DOM nodes (ZERO innerHTML).
 * Supports fenced code blocks, blockquotes, inline code, safe http(s) links,
 * `@agent` / `@group` pills, and clickable `#channel` pills.
 */
export function renderRichText(text: string, handlers: RichTextHandlers = {}): DocumentFragment {
  const frag = document.createDocumentFragment()
  const normalized = text.replace(/\r\n/g, '\n')
  const parts = normalized.split(/(```[^\n]*\n[\s\S]*?```)/g)

  for (const part of parts) {
    if (part === '') continue
    if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
      const newline = part.indexOf('\n')
      const lang = newline > 3 ? part.slice(3, newline).trim() : ''
      const body = newline >= 0 ? part.slice(newline + 1, -3) : part.slice(3, -3)
      const pre = el('pre', { className: 'cb-code-block' })
      if (lang) {
        pre.appendChild(el('div', { className: 'cb-code-lang', textContent: lang }))
      }
      pre.appendChild(el('code', { textContent: body.replace(/\n$/, '') }))
      frag.appendChild(pre)
      continue
    }

    const lines = part.split('\n')
    let paragraphLines: string[] = []
    const flushParagraph = (): void => {
      if (paragraphLines.length === 0) return
      const p = el('p', { className: 'cb-msg-p' })
      paragraphLines.forEach((ln, idx) => {
        if (idx > 0) p.appendChild(document.createElement('br'))
        appendInlineTokens(p, ln, handlers)
      })
      frag.appendChild(p)
      paragraphLines = []
    }

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') {
        flushParagraph()
        continue
      }
      if (line.startsWith('> ')) {
        flushParagraph()
        const bq = el('blockquote', { className: 'cb-inline-quote' })
        appendInlineTokens(bq, line.slice(2), handlers)
        frag.appendChild(bq)
        continue
      }
      paragraphLines.push(line)
    }
    flushParagraph()
  }

  return frag
}

function appendInlineTokens(parent: HTMLElement, line: string, handlers: RichTextHandlers): void {
  const tokens = tokenizeInlineRichText(line, handlers.knownGroups, handlers.actorLabels)
  for (const tok of tokens) {
    switch (tok.kind) {
      case 'text':
        parent.appendChild(document.createTextNode(tok.value))
        break
      case 'code':
        parent.appendChild(el('code', { className: 'cb-inline-code', textContent: tok.value }))
        break
      case 'url':
        parent.appendChild(
          el('a', {
            className: 'cb-link',
            href: tok.value,
            target: '_blank',
            rel: 'noopener noreferrer',
            textContent: tok.value,
          }),
        )
        break
      case 'mention':
      case 'group': {
        const isGroup = tok.kind === 'group'
        const pill = el('button', {
          type: 'button',
          className: isGroup ? 'cb-pill cb-pill-group' : 'cb-pill cb-pill-mention',
          textContent: tok.raw,
        })
        if (handlers.onMentionClick) {
          pill.addEventListener('click', (ev) => {
            ev.stopPropagation()
            handlers.onMentionClick!(tok.value, isGroup)
          })
        }
        parent.appendChild(pill)
        break
      }
      case 'channel': {
        const pill = el('button', {
          type: 'button',
          className: 'cb-pill cb-pill-channel',
          textContent: tok.raw,
        })
        if (handlers.onChannelClick) {
          pill.addEventListener('click', (ev) => {
            ev.stopPropagation()
            handlers.onChannelClick!(tok.value)
          })
        }
        parent.appendChild(pill)
        break
      }
    }
  }
}
