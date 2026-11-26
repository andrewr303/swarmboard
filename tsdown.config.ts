import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const SHEBANG = '#!/usr/bin/env node\n'
const BIN_OUTPUTS = [
  'dist/bin/swarmboard.mjs',
  'dist/bin/swarmboard-mcp.mjs',
  'dist/bin/swarmboard-daemon.mjs',
] as const

function finalizeBinScripts(): void {
  for (const rel of BIN_OUTPUTS) {
    const abs = resolve(process.cwd(), rel)
    const raw = readFileSync(abs, 'utf8')
    const stripped = raw.replace(/^(?:#![^\n]*\r?\n)+/, '')
    if (!raw.startsWith(SHEBANG) || raw.slice(SHEBANG.length).startsWith('#!')) {
      writeFileSync(abs, `${SHEBANG}${stripped}`, 'utf8')
    }
    chmodSync(abs, 0o755)
  }
}

export default defineConfig([
  {
    entry: {
      core: 'src/core/public.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: false,
    outDir: 'dist',
  },
  {
    entry: {
      client: 'src/client/index.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: false,
    outDir: 'dist',
  },
  {
    entry: {
      host: 'src/host/index.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: false,
    outDir: 'dist',
    outputOptions: {
      chunkFileNames: 'host-chunks/[name]-[hash].mjs',
    },
  },
  {
    entry: {
      'bin/swarmboard': 'src/host/bin/swarmboard.ts',
      'bin/swarmboard-mcp': 'src/host/bin/swarmboard-mcp.ts',
      'bin/swarmboard-daemon': 'src/host/bin/swarmboard-daemon.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: false,
    outDir: 'dist',
    outputOptions: {
      chunkFileNames: 'bin-chunks/[name]-[hash].mjs',
    },
    onSuccess: finalizeBinScripts,
  },
])
