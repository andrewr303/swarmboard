// The transport import boundary (HOST0_DESIGN 3.9, HT-75; closeout SEC-R1-1): a transport source file may reach
// the core only through `src/core/public.ts` or the package's `./core` entry. The scan is conservative on
// purpose, so that no spelling of an import slips past it (a false alarm costs a reviewed edit; a miss costs the
// fence):
//
// - every relative path token in the file (`./…`, `../…`), wherever it stands and whatever quotes it, is resolved
//   against the file: this covers static `import`/`export … from` in any quote style, side-effect imports,
//   `import type`, dynamic `import(…)`, `require(…)`, `import x = require(…)`, a path kept in a variable first,
//   and a template's static prefix (`../core/${x}` resolves into the core);
// - every string literal ('…', "…", `…`) is also read with its escapes decoded (`'\x2e\x2e/core/index.ts'`),
//   and absolute paths and `file:` URLs in it are resolved too;
// - every `swarmboard…` module specifier other than `swarmboard/core` is a violation;
// - a dynamic `import(…)` or `require(…)` (also `module.require`) whose argument is not one plain string
//   literal is a violation, because nothing can say where it goes; so are `createRequire`, `eval(…)` and
//   `Function(…)`, which can import under any name;
// - paths compare case-insensitively: the default macOS and Windows filesystems resolve `../Core/Index.ts` to
//   the core's own barrel.
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** File extensions a transport may be written in; every one is scanned. */
export const SCANNED_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']

/** A relative path token: `./` or `../` not glued to a name before it, up to a quote, space or bracket. */
const RELATIVE = /(?<![\w$./\\-])\.{1,2}\/[^\s'"`;,(){}[\]]*/g
/** Module specifier literals in import/export/require positions. */
const MODULE_SPEC = /(?:\bfrom\s+|\bimport\s+|\b(?:import|require)\s*\(\s*)(['"`])((?:\\[\s\S]|(?!\1)[^\\\n])*)\1/g
/** The package's own name, with any subpath. */
const PACKAGE = /^swarmboard(?:\/.*)?$/i
/** One quoted literal: the quote, then escapes or characters that are neither that quote nor a newline. */
const LITERAL = /(['"`])((?:\\[\s\S]|(?!\1)[^\\\n])*)\1/g
/** A dynamic import or require whose argument is not a lone plain literal closed by `)` or `,`. */
const DYNAMIC = /(?<![\w$])(?:import|require)\s*\(\s*(?!(['"])(?:\\[\s\S]|(?!\1)[^\\\n])*\1\s*[),]|`[^`$\\]*`\s*[),])/g
/** Ways to import under another name. */
const INDIRECT = /\b(?:createRequire\b|eval\s*\(|Function\s*\()/g

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }

/** A literal's text with its JavaScript escapes decoded. */
function unescape(body: string): string {
  return body.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|([\s\S]))/g, (_, x, braced, u, ch) => {
    const hex = (x ?? braced ?? u) as string | undefined
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16))
    const c = ch as string
    return SIMPLE_ESCAPES[c] ?? (c === '\n' ? '' : c)
  })
}

/** The import-boundary violations of `text`, the source of `file`, in a repository rooted at `root`. */
export function importBoundaryViolations(root: string, file: string, text: string): string[] {
  const core = join(root, 'src', 'core').toLowerCase()
  const publicEntry = join(core, 'public.ts')
  const out = new Set<string>()
  const intoCore = (target: string): boolean => {
    const t = target.toLowerCase()
    return (t === core || t.startsWith(core + sep)) && t !== publicEntry
  }
  const scanPaths = (source: string): void => {
    for (const m of source.matchAll(RELATIVE)) if (intoCore(resolve(dirname(file), m[0]))) out.add(`${file}: ${m[0]}`)
  }
  scanPaths(text)
  for (const m of text.matchAll(MODULE_SPEC)) {
    const spec = unescape(m[2]!)
    if (PACKAGE.test(spec) && spec !== 'swarmboard/core') out.add(`${file}: ${spec}`)
  }
  for (const m of text.matchAll(LITERAL)) {
    const spec = unescape(m[2]!)
    scanPaths(spec)
    let absolute: string | null = null
    if (/^file:/i.test(spec)) {
      try {
        absolute = fileURLToPath(spec)
      } catch {
        absolute = null
      }
    } else if (spec.startsWith('/')) {
      absolute = spec
    }
    if (absolute !== null && intoCore(resolve(absolute))) out.add(`${file}: ${spec}`)
  }
  for (const m of text.matchAll(DYNAMIC)) out.add(`${file}: a non-literal ${m[0].trim()}…`)
  for (const m of text.matchAll(INDIRECT)) out.add(`${file}: ${m[0].trim()}`)
  return [...out]
}
