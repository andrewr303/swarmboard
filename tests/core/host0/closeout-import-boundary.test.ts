// HOST-0 closeout SEC-R1-1: the import-boundary scan HT-75 runs over the transport directories catches every way
// of writing an import into the core, and lets the public entry through. Each negative control is one spelling
// a transport file could use; the scanner is tests/core/host0/import-boundary.ts.
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importBoundaryViolations, SCANNED_EXTENSIONS } from './import-boundary.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const FILE = join(ROOT, 'src', 'server', 'x.ts')
const DEEP = join(ROOT, 'src', 'server', 'routes', 'tasks.ts')
const scan = (text: string, file = FILE): string[] => importBoundaryViolations(ROOT, file, text)

describe('HOST-0 closeout: the transport import boundary (SEC-R1-1)', () => {
  it('closeout SEC-R1-1 every spelling of an import into the core is caught', () => {
    const caught: Array<[string, string] | [string, string, string]> = [
      ['single quotes', "import { loadRow } from '../core/index.ts'"],
      ['double quotes', 'import { loadRow } from "../core/index.ts"'],
      ['internal barrel', 'import { systemOps } from "../core/internal.ts"'],
      ['a core module', "import { SqliteUnifiedStore } from '../core/sqlite-store.ts'"],
      ['a nested core module', "import { fold } from '../core/tasks/fold.ts'"],
      ['the core directory', "import * as core from '../core'"],
      ['template literal', 'import { loadRow } from `../core/index.ts`'],
      ['import type', "import type { TaskRow } from '../core/tasks/row.ts'"],
      ['side-effect import', 'import "../core/internal.ts"'],
      ['multi-line import', 'import {\n  loadRow,\n  loadAllRows,\n} from\n  "../core/index.ts"'],
      ['export from', "export { loadRow } from '../core/index.ts'"],
      ['export star', 'export * from "../core/internal.ts"'],
      ['export star as', 'export * as internals from `../core/internal.ts`'],
      ['dynamic import, single', "const m = await import('../core/internal.ts')"],
      ['dynamic import, double', 'const m = await import("../core/internal.ts")'],
      ['dynamic import, template', 'const m = await import(`../core/internal.ts`)'],
      ['dynamic import with options', "const m = await import('../core/index.ts', { with: { type: 'module' } })"],
      ['dynamic import, spaced', 'const m = await import (\n  "../core/internal.ts"\n)'],
      ['require, single', "const m = require('../core/index.ts')"],
      ['require, double', 'const m = require("../core/internal.ts")'],
      ['module.require', 'const m = module.require("../core/internal.ts")'],
      ['import = require', 'import core = require("../core/internal.ts")'],
      ['a path kept in a variable', "const p = '../core/internal.ts'\nconst m = await import(p)"],
      ['a dynamic import of a variable', 'const m = await import(where)'],
      ['a concatenated require', "const m = require('../co' + 're/internal.ts')"],
      ['a template with a substitution', 'const m = await import(`../core/${name}.ts`)'],
      ['escaped characters', "import { loadRow } from '\\x2e\\x2e/core/index.ts'"],
      ['unicode escapes', 'import { loadRow } from "..\\u002fcore\\u002findex.ts"'],
      ['another case', "import { loadRow } from '../Core/Index.ts'"],
      ['a stray quote before it on the line', "const q = /'/; import { loadRow } from '../core/index.ts'"],
      ['a detour through the parent', "import { loadRow } from '../../src/core/index.ts'"],
      ['an absolute path', `import { loadRow } from '${join(ROOT, 'src', 'core', 'index.ts')}'`],
      ['a file URL', `const m = await import('file://${join(ROOT, 'src', 'core', 'internal.ts')}')`],
      ['createRequire', "import { createRequire } from 'node:module'\nconst r = createRequire(import.meta.url)\nconst m = r(name)"],
      ['eval', 'const m = eval(code)'],
      ['Function', 'const load = Function("p", "return import(p)")'],
      ['a package subpath', "import { x } from 'swarmboard/internal'"],
      ['the package root', 'import { x } from "swarmboard"'],
      ['a package dist path', 'const m = await import(`swarmboard/dist/core.mjs`)'],
      ['from a nested transport directory', "import { loadRow } from '../../core/index.ts'", DEEP],
    ]
    for (const [name, text, file] of caught) {
      expect(scan(text, file).length, `${name}: ${text}`).toBeGreaterThan(0)
    }
  })

  it('closeout SEC-R1-1 the public entry and everything outside the core are allowed', () => {
    const allowed: Array<[string, string] | [string, string, string]> = [
      ['public, single', "import { BoardService } from '../core/public.ts'"],
      ['public, double', 'import { BoardService } from "../core/public.ts"'],
      ['public, template', 'import { BoardService } from `../core/public.ts`'],
      ['public, type', 'import type { CallerContext } from "../core/public.ts"'],
      ['public, export star', "export * from '../core/public.ts'"],
      ['public, dynamic', 'const m = await import("../core/public.ts")'],
      ['public, dynamic template', 'const m = await import(`../core/public.ts`)'],
      ['public, require', "const m = require('../core/public.ts')"],
      ['public, nested', 'import { BoardService } from "../../core/public.ts"', DEEP],
      ['the package entry', "import { BoardService } from 'swarmboard/core'"],
      ['a sibling', "import { route } from './routes.ts'"],
      ['a sibling directory', 'import { cli } from "../cli/main.ts"'],
      ['node builtins and packages', "import * as fs from 'node:fs'\nimport { z } from \"zod\"\nimport { jwtVerify } from `jose`"],
      ['a core-looking name elsewhere', "import { x } from '../score/index.ts'\nconst s = 'see docs/core/index.md'"],
      ['import.meta', 'const here = import.meta.dirname'],
      ['methods that start with the keywords', 'board.importAttachment(caller, x)\nthis.requireAdmitted(caller)'],
      ['a plain template', 'const t = `${a}/${b}`'],
    ]
    for (const [name, text, file] of allowed) {
      expect(scan(text, file), `${name}: ${text}`).toEqual([])
    }
  })

  it('closeout SEC-R1-1 the scan covers every source extension', () => {
    expect([...SCANNED_EXTENSIONS].sort()).toEqual(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
  })
})
