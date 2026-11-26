import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaimCache, normalizeTaskCacheKey } from '../../src/mcp/claim-cache.ts'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cb-mcp-claims-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('ClaimCache', () => {
  it('normalizes task IDs across numeric, #, msg_, thr_ numeric, and thread UUID forms', () => {
    expect(normalizeTaskCacheKey(42)).toBe('42')
    expect(normalizeTaskCacheKey('42')).toBe('42')
    expect(normalizeTaskCacheKey('#42')).toBe('42')
    expect(normalizeTaskCacheKey('msg_42')).toBe('42')
    expect(normalizeTaskCacheKey('thr_42')).toBe('42')
    expect(normalizeTaskCacheKey('thr_abc-123')).toBe('thr_abc-123')
  })

  it('persists proofs with 0700/0600 modes, survives restarts, isolates across actors & boards, and supports thread UUID aliases', () => {
    const claimsDir = join(tempDir(), 'claims')
    const boardKey = 'file:///tmp/example/board.db'
    const actorA = 'local:user:alice+agy'
    const actorB = 'local:user:alice+codex'
    const cache1 = new ClaimCache({ boardKey, actorKey: actorA, claimsDir })

    cache1.set('17', {
      epoch: 2,
      token: 'secret-token-43-chars-xxxxxxxxxxxxxxxxxxxxx',
      until: new Date(Date.now() + 300_000).toISOString(),
      thread: 'thr_task17',
    })

    expect(cache1.filePath).not.toBeNull()
    if (process.platform !== 'win32') {
      expect(statSync(claimsDir).mode & 0o777).toBe(0o700)
      expect(statSync(cache1.filePath!).mode & 0o777).toBe(0o600)
    }

    // Lookup by all ref spellings on cache1
    expect(cache1.get(17)?.token).toBe('secret-token-43-chars-xxxxxxxxxxxxxxxxxxxxx')
    expect(cache1.get('#17')?.epoch).toBe(2)
    expect(cache1.get('msg_17')?.epoch).toBe(2)
    expect(cache1.get('thr_17')?.epoch).toBe(2)
    expect(cache1.get('thr_task17')?.epoch).toBe(2)

    // New ClaimCache instance for the SAME actor reads persisted file from disk
    const cache2 = new ClaimCache({ boardKey, actorKey: actorA, claimsDir })
    expect(cache2.get('#17')).toMatchObject({ epoch: 2, token: 'secret-token-43-chars-xxxxxxxxxxxxxxxxxxxxx' })
    expect(cache2.get('thr_task17')).toMatchObject({ epoch: 2, token: 'secret-token-43-chars-xxxxxxxxxxxxxxxxxxxxx' })

    // Sibling actor on the SAME board + claimsDir CANNOT read or evict actorA's bearer token (MCP-F1)
    const siblingActor = new ClaimCache({ boardKey, actorKey: actorB, claimsDir })
    expect(siblingActor.filePath).not.toBe(cache1.filePath)
    expect(siblingActor.get('17')).toBeNull()
    expect(siblingActor.get('thr_task17')).toBeNull()
    siblingActor.delete('17')
    expect(new ClaimCache({ boardKey, actorKey: actorA, claimsDir }).get('17')).toMatchObject({
      epoch: 2,
      token: 'secret-token-43-chars-xxxxxxxxxxxxxxxxxxxxx',
    })

    // Different boardKey is isolated
    const otherBoard = new ClaimCache({ boardKey: 'file:///tmp/other/board.db', actorKey: actorA, claimsDir })
    expect(otherBoard.get('17')).toBeNull()

    // Deleting by thread UUID removes entry from memory and disk
    cache2.delete('thr_task17')
    expect(cache2.get('17')).toBeNull()
    expect(cache2.get('thr_task17')).toBeNull()
    const cache3 = new ClaimCache({ boardKey, actorKey: actorA, claimsDir })
    expect(cache3.get('17')).toBeNull()
  })

  it('prunes proofs older than 24h past lease expiry', () => {
    const claimsDir = join(tempDir(), 'claims')
    const boardKey = 'file:///tmp/prune/board.db'
    const cache = new ClaimCache({ boardKey, actorKey: 'local:user:alice+agy', claimsDir })

    const oldUntil = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString()
    cache.set('1', { epoch: 1, token: 'expired-token', until: oldUntil })
    cache.set('2', { epoch: 1, token: 'fresh-token', until: new Date(Date.now() + 60_000).toISOString() })

    const persisted = JSON.parse(readFileSync(cache.filePath!, 'utf8')) as { claims: Record<string, unknown> }
    expect(persisted.claims['1']).toBeUndefined()
    expect(persisted.claims['2']).toBeDefined()
  })

  it('refuses symlinked or group-writable claim files on POSIX and stays memory-safe', () => {
    if (process.platform === 'win32') return
    const base = tempDir()
    const claimsDir = join(base, 'claims')
    const logs: string[] = []
    const cache = new ClaimCache({
      boardKey: 'file:///tmp/hygiene/board.db',
      actorKey: 'local:user:alice+agy',
      claimsDir,
      log: (l) => logs.push(l),
    })

    // First write creates dir + file cleanly
    cache.set('5', { epoch: 1, token: 'tok-5' })
    const filePath = cache.filePath!

    // Make file group-writable -> fresh reader must refuse disk read and warn
    chmodSync(filePath, 0o660)
    const reader = new ClaimCache({
      boardKey: 'file:///tmp/hygiene/board.db',
      actorKey: 'local:user:alice+agy',
      claimsDir,
      log: (l) => logs.push(l),
    })
    expect(reader.get('5')).toBeNull()
    expect(logs.some((l) => l.includes('group/world-writable'))).toBe(true)

    // Replace file with symlink -> refused cleanly
    const decoy = join(base, 'decoy.json')
    writeFileSync(
      decoy,
      '{"version":1,"boardKey":"file:///tmp/hygiene/board.db","actorKey":"local:user:alice+agy","claims":{"9":{"epoch":1,"token":"evil","savedAt":"2026-01-01T00:00:00Z"}}}',
    )
    rmSync(filePath)
    symlinkSync(decoy, filePath)
    const reader2 = new ClaimCache({
      boardKey: 'file:///tmp/hygiene/board.db',
      actorKey: 'local:user:alice+agy',
      claimsDir,
      log: (l) => logs.push(l),
    })
    expect(reader2.get('9')).toBeNull()
    expect(logs.some((l) => l.includes('symlink'))).toBe(true)
  })
})
