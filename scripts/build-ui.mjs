#!/usr/bin/env node
// Zero-dependency static asset bundler for Swarmboard Command Center Web UI (HOST-12).
// Compiles src/ui/** TypeScript + CSS + HTML + SVG favicon into a self-contained TypeScript module
// at src/ui/bundle.ts (< 60 KB gzipped) using only Node >= 22 built-ins.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const UI_DIR = resolve(ROOT, 'src', 'ui')
const OUT_FILE = resolve(UI_DIR, 'bundle.ts')

const MAX_GZIP_BYTES = 60 * 1024 // 60 KiB gzipped hard budget

const TS_MODULES = [
  'dom.ts',
  'api.ts',
  'state.ts',
  'components/sidebar.ts',
  'components/topbar.ts',
  'components/forum.ts',
  'components/thread.ts',
  'components/drawer.ts',
  'components/views.ts',
  'app.ts',
]

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#ededed"/><path d="M35 12L17 36h13l-2 16 19-24H34l1-16z" fill="#171717"/></svg>`

/**
 * Strips local static ES `import` statements and top-level `export` keywords from JS output
 * produced by Node's built-in `stripTypeScriptTypes(..., { mode: 'strip' })`.
 */
function stripModuleSyntax(jsCode) {
  // Remove static `import ... from '...'` (handles multi-line named imports and side-effect imports).
  let cleaned = jsCode.replace(
    /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"][^'"]+['"]\s*;?\s*$/gm,
    '',
  )
  // Remove leading `export ` before declarations (function, async function, const, let, class).
  cleaned = cleaned.replace(
    /^(\s*)export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm,
    '$1',
  )
  // Collapse whitespace-only lines and trim trailing spaces without altering string/regex literals.
  const lines = cleaned
    .split('\n')
    .map((ln) => ln.replace(/[ \t]+$/g, ''))
    .filter((ln) => ln.trim().length > 0)
  return lines.join('\n')
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*([{}:;,>~])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim()
}

function minifyHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n\s+/g, '\n')
    .trim()
}

function sha256Etag(text) {
  const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
  return `"${hash}"`
}

function build() {
  const jsParts = []
  for (const rel of TS_MODULES) {
    const abs = resolve(UI_DIR, rel)
    const rawTs = readFileSync(abs, 'utf8')
    const stripped = stripTypeScriptTypes(rawTs, { mode: 'strip' })
    const moduleFree = stripModuleSyntax(stripped)
    jsParts.push(`// --- ${rel}\n${moduleFree}`)
  }

  const appJs = `(() => {\n'use strict';\n${jsParts.join('\n')}\n})();\n`

  // Syntax-verify emitted JS bundle using V8 parser (compile-only, never executes).
  try {
    new vm.Script(appJs, { filename: 'assets/app.js' })
  } catch (err) {
    console.error('[build-ui] Syntax error in bundled app.js:', err)
    process.exit(1)
  }

  // Static XSS hygiene guard: refuse build if unsafe DOM sinks appear in UI bundle.
  if (/\.(?:innerHTML|outerHTML|insertAdjacentHTML)\b|\bdocument\.write\s*\(/.test(appJs)) {
    console.error('[build-ui] Security refusal: unsafe HTML sink detected in UI bundle!')
    process.exit(1)
  }

  const appCss = minifyCss(readFileSync(resolve(UI_DIR, 'styles.css'), 'utf8'))
  const indexHtml = minifyHtml(readFileSync(resolve(UI_DIR, 'index.html'), 'utf8'))
  const faviconSvg = FAVICON_SVG

  const assets = [
    { path: '/', contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', body: indexHtml },
    {
      path: '/assets/app.js',
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: 'public, max-age=300, must-revalidate',
      body: appJs,
    },
    {
      path: '/assets/app.css',
      contentType: 'text/css; charset=utf-8',
      cacheControl: 'public, max-age=300, must-revalidate',
      body: appCss,
    },
    {
      path: '/assets/favicon.svg',
      contentType: 'image/svg+xml; charset=utf-8',
      cacheControl: 'public, max-age=86400',
      body: faviconSvg,
    },
  ]

  let totalRawBytes = 0
  let totalGzipBytes = 0
  const assetRecords = {}

  for (const a of assets) {
    const rawBuf = Buffer.from(a.body, 'utf8')
    const gzBuf = gzipSync(rawBuf, { level: 9 })
    totalRawBytes += rawBuf.byteLength
    totalGzipBytes += gzBuf.byteLength
    assetRecords[a.path] = {
      contentType: a.contentType,
      cacheControl: a.cacheControl,
      etag: sha256Etag(a.body),
      rawBytes: rawBuf.byteLength,
      gzipBytes: gzBuf.byteLength,
      body: a.body,
    }
  }

  if (totalGzipBytes >= MAX_GZIP_BYTES) {
    console.error(
      `[build-ui] Bundle exceeds 60 KiB gzipped budget: ${totalGzipBytes} bytes >= ${MAX_GZIP_BYTES} bytes`,
    )
    process.exit(1)
  }

  const lines = [
    '// AUTO-GENERATED by scripts/build-ui.mjs — do not edit manually.',
    '// Self-contained static asset bundle for Swarmboard Command Center Web UI (HOST-12).',
    '',
    'export interface UiBundledAsset {',
    '  readonly contentType: string',
    '  readonly cacheControl: string',
    '  readonly etag: string',
    '  readonly rawBytes: number',
    '  readonly gzipBytes: number',
    '  readonly body: string',
    '}',
    '',
    'export interface UiBundleStats {',
    '  readonly totalRawBytes: number',
    '  readonly totalGzipBytes: number',
    '  readonly assetCount: number',
    '}',
    '',
    `export const UI_BUNDLE_STATS: UiBundleStats = Object.freeze(${JSON.stringify({
      totalRawBytes,
      totalGzipBytes,
      assetCount: assets.length,
    })})`,
    '',
    `export const UI_ASSETS: Readonly<Record<string, UiBundledAsset>> = Object.freeze(${JSON.stringify(assetRecords, null, 2)})`,
    '',
  ]

  writeFileSync(OUT_FILE, lines.join('\n'), 'utf8')

  const kbRaw = (totalRawBytes / 1024).toFixed(1)
  const kbGz = (totalGzipBytes / 1024).toFixed(2)
  console.log(
    `[build-ui] Wrote src/ui/bundle.ts (${assets.length} assets, ${kbRaw} KiB raw, ${kbGz} KiB gzipped < 60 KiB budget)`,
  )
  for (const a of assets) {
    const rec = assetRecords[a.path]
    console.log(
      `  ${a.path.padEnd(20)} ${(rec.rawBytes / 1024).toFixed(1).padStart(6)} KiB raw | ${(rec.gzipBytes / 1024).toFixed(2).padStart(6)} KiB gz | ETag ${rec.etag}`,
    )
  }
}

build()
