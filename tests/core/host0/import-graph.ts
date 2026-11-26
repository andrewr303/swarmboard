// Gate residual F-1 (HOST123_DESIGN HS-01, HS-02; OD-4): the transport import boundary seen three more ways, with
// no parser and no new dependency.
//
// - `importGraph` loads files in a child node process with `module.registerHooks({resolve})` and returns every
//   (parent, child) edge Node actually resolved, so a path built at run time (`['..','core','internal.ts'].join('/')`)
//   shows up as the edge it is. `graphViolations` applies the two rules to those edges.
// - `transportFiles` walks the transport directories with lstat and reports files and symlinks: a symlink could
//   alias a forbidden module under an allowed name, so any symlink is a finding.
// - `stripComments` removes comments (best effort, string-aware) so a comment between tokens cannot split
//   `import /* c */ (p)` out of the regex scanner's reach; `scanBoth` unions the violations of the text and of the
//   stripped text.
//
// None of it is a boundary against a determined author (the closed-world fence is `TRANSPORT_ALLOW` plus the
// unexported system caller); it catches mistakes and the lazy bypasses.
import { execFile } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importBoundaryViolations, SCANNED_EXTENSIONS } from './import-boundary.ts'

export type Edge = readonly [parent: string, child: string]

/** The directories under `src/` whose files are transports or client code and are held to the fence. */
export const TRANSPORT_DIRS: readonly string[] = ['client', 'server', 'mcp', 'cli']

const CHILD = `
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
const edges = []
const errors = []
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context)
    if (context.parentURL && r.url.startsWith('file:')) edges.push([context.parentURL, r.url])
    return r
  },
})
for (const f of JSON.parse(process.env.GRAPH_FILES)) {
  try {
    await import(pathToFileURL(f).href)
  } catch (e) {
    errors.push(f + ': ' + (e && e.message ? e.message : String(e)))
  }
}
process.stdout.write('\\n@@GRAPH@@' + JSON.stringify({ edges, errors }) + '\\n')
`

/**
 * Loads each file (absolute paths) in a fresh node process and returns every resolution edge as file URLs. A file
 * that fails to load rejects the call: an unloadable file is not a clean one.
 */
export function importGraph(files: readonly string[], opts: { timeoutMs?: number } = {}): Promise<Edge[]> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', CHILD],
      { env: { ...process.env, GRAPH_FILES: JSON.stringify(files) }, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`import graph child failed: ${error.message}\n${stderr}`))
        const marker = stdout.lastIndexOf('@@GRAPH@@')
        if (marker < 0) return reject(new Error(`import graph child printed no result\n${stdout}\n${stderr}`))
        const parsed = JSON.parse(stdout.slice(marker + '@@GRAPH@@'.length)) as { edges: Edge[]; errors: string[] }
        if (parsed.errors.length > 0) return reject(new Error(`import graph: ${parsed.errors.join('; ')}`))
        resolvePromise(parsed.edges)
      },
    )
  })
}

const urlPath = (u: string): string => resolve(fileURLToPath(u))
const norm = (p: string): string => resolve(p).toLowerCase()
const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep)

/**
 * The two rules over a graph, in a repository rooted at `root`:
 * 1. every edge from a transport file (anywhere under `src/` but not `src/core` and not `src/host`, which may use
 *    the internals) into `src/core/` ends at `src/core/public.ts`;
 * 2. no edge from a transport directory (`src/{client,server,mcp,cli}`) reaches `src/host/**`.
 * Edges whose parent is not under `<root>/src` (the loader itself) are not judged.
 */
export function graphViolations(edges: readonly Edge[], root: string, transportDirs: readonly string[] = TRANSPORT_DIRS): string[] {
  const src = norm(join(root, 'src'))
  const core = norm(join(src, 'core'))
  const publicEntry = norm(join(core, 'public.ts'))
  const host = norm(join(src, 'host'))
  const transports = transportDirs.map((d) => norm(join(src, d)))
  const out = new Set<string>()
  for (const [parentUrl, childUrl] of edges) {
    const parentRaw = urlPath(parentUrl)
    const childRaw = urlPath(childUrl)
    const parent = parentRaw.toLowerCase()
    const child = childRaw.toLowerCase()
    if (!inside(parent, src)) continue
    if (!inside(parent, core) && !inside(parent, host) && inside(child, core) && child !== publicEntry) {
      out.add(`rule 1: ${parentRaw} reaches ${childRaw}`)
    }
    if (transports.some((t) => inside(parent, t)) && inside(child, host)) {
      out.add(`rule 2: ${parentRaw} reaches ${childRaw}`)
    }
  }
  return [...out]
}

/**
 * The files under `<root>/src/<dir>` for each dir (scanned extensions only) and every symlink met on the way
 * (files or directories), found with lstat and never followed. Missing directories are skipped.
 */
export function transportFiles(root: string, dirs: readonly string[]): { files: string[]; symlinks: string[] } {
  const files: string[] = []
  const symlinks: string[] = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const full = join(dir, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) symlinks.push(full)
      else if (st.isDirectory()) walk(full)
      else if (SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))) files.push(full)
    }
  }
  for (const d of dirs) {
    const top = join(root, 'src', d)
    let st
    try {
      st = lstatSync(top)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) symlinks.push(top)
    else if (st.isDirectory()) walk(top)
  }
  return { files, symlinks }
}

interface Scanned {
  out: string
  end: number
}

/** Copies a quoted string literal (single or double quote) as is; a newline ends it (a regex like /'/ is not a string). */
function scanQuoted(text: string, start: number): Scanned {
  const quote = text[start]!
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') i += 2
    else if (ch === quote) return { out: text.slice(start, i + 1), end: i + 1 }
    else if (ch === '\n') break
    else i += 1
  }
  return { out: text.slice(start, Math.min(i, text.length)), end: Math.min(i, text.length) }
}

function scanTemplate(text: string, start: number): Scanned {
  let out = '`'
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') {
      out += text.slice(i, i + 2)
      i += 2
    } else if (ch === '`') {
      return { out: out + '`', end: i + 1 }
    } else if (ch === '$' && text[i + 1] === '{') {
      const inner = scanCode(text, i + 2, true)
      out += '${' + inner.out
      i = inner.end
      if (text[i] === '}') {
        out += '}'
        i += 1
      }
    } else {
      out += ch
      i += 1
    }
  }
  return { out, end: i }
}

function scanCode(text: string, start: number, inTemplateExpr: boolean): Scanned {
  let out = ''
  let i = start
  let depth = 0
  while (i < text.length) {
    const c = text[i]!
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
    } else if (c === '/' && d === '*') {
      const close = text.indexOf('*/', i + 2)
      const stop = close < 0 ? text.length : close + 2
      out += text.slice(i, stop).replace(/[^\n]/g, '')
      i = stop
    } else if (c === "'" || c === '"') {
      const r = scanQuoted(text, i)
      out += r.out
      i = r.end
    } else if (c === '`') {
      const r = scanTemplate(text, i)
      out += r.out
      i = r.end
    } else if (c === '{') {
      depth += 1
      out += c
      i += 1
    } else if (c === '}') {
      if (inTemplateExpr && depth === 0) return { out, end: i }
      depth -= 1
      out += c
      i += 1
    } else {
      out += c
      i += 1
    }
  }
  return { out, end: i }
}

/**
 * Removes `//` and block comments outside string and template literals (best effort: a regex literal holding a quote
 * can confuse it, which is why the scanners run on the text as well as on this). A block comment leaves nothing
 * behind except its newlines, so `import /* c *\/ (p)` becomes `import  (p)`.
 */
export function stripComments(text: string): string {
  return scanCode(text, 0, false).out
}

/** The import-boundary violations of `text` and of `stripComments(text)`, together. */
export function scanBoth(root: string, file: string, text: string): string[] {
  return [...new Set([...importBoundaryViolations(root, file, text), ...importBoundaryViolations(root, file, stripComments(text))])]
}

const RELATIVE = /(?<![\w$./\\-])\.{1,2}\/[^\s'"`;,(){}[\]]*/g
const LITERAL = /(['"`])((?:\\[\s\S]|(?!\1)[^\\\n])*)\1/g

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }

/** A literal's text with its JavaScript escapes decoded. */
function unescapeLiteral(body: string): string {
  return body.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|([\s\S]))/g, (_, x, braced, u, ch) => {
    const hex = (x ?? braced ?? u) as string | undefined
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16))
    const c = ch as string
    return SIMPLE_ESCAPES[c] ?? (c === '\n' ? '' : c)
  })
}

/**
 * Relative or absolute path tokens in `text` that resolve under `src/host` (a client file must not name the host
 * layer, even in a comment or a string). Looks at the raw text and at every string literal.
 */
export function hostPathViolations(root: string, file: string, text: string): string[] {
  const host = join(root, 'src', 'host').toLowerCase()
  const out = new Set<string>()
  const under = (p: string): boolean => {
    const t = resolve(p).toLowerCase()
    return t === host || t.startsWith(host + sep)
  }
  const scan = (source: string): void => {
    for (const m of source.matchAll(RELATIVE)) if (under(resolve(dirname(file), m[0]))) out.add(`${file}: ${m[0]}`)
    for (const m of source.matchAll(/(?<![\w$./\\-])\/[^\s'"`;,(){}[\]]+/g)) if (under(m[0])) out.add(`${file}: ${m[0]}`)
    for (const m of source.matchAll(/file:\/\/[^\s'"`;,(){}[\]]+/g)) {
      try {
        if (under(fileURLToPath(m[0]))) out.add(`${file}: ${m[0]}`)
      } catch {
        // not a file URL we can read
      }
    }
  }
  scan(text)
  for (const m of text.matchAll(LITERAL)) scan(unescapeLiteral(m[2]!))
  return [...out]
}

/** Convenience for tests: a file URL for a path. */
export const asUrl = (path: string): string => pathToFileURL(path).href
