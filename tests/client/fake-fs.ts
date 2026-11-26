// An in-memory ResolverFs for the resolver and config tests. Paths are posix and absolute. It records every call so a
// test can assert what the resolver looked at.
import type { ResolverFs } from '../../src/client/resolve.ts'

export type FakeEntry = string | { kind?: 'file' | 'dir' | 'symlink' | 'other'; text?: string; mode?: number; uid?: number }

export interface FakeFsOptions {
  /** `path -> target`: realpathish follows these (whole-path prefixes). */
  readonly links?: Readonly<Record<string, string>>
  readonly uid?: number
}

export class FakeFs implements ResolverFs {
  readonly reads: string[] = []
  readonly stats: string[] = []
  readonly #entries = new Map<string, FakeEntry>()
  readonly #links: Readonly<Record<string, string>>
  readonly #uid: number

  constructor(files: Readonly<Record<string, FakeEntry>> = {}, options: FakeFsOptions = {}) {
    for (const [p, e] of Object.entries(files)) this.#entries.set(p, e)
    this.#links = options.links ?? {}
    this.#uid = options.uid ?? 501
  }

  readText(path: string): string | null {
    this.reads.push(path)
    const e = this.#entries.get(path)
    if (e === undefined) return null
    if (typeof e === 'string') return e
    return e.text ?? ''
  }

  lstat(path: string): { kind: 'file' | 'dir' | 'symlink' | 'other'; mode: number; uid: number } | null {
    this.stats.push(path)
    const e = this.#entries.get(path)
    if (e === undefined) return null
    if (typeof e === 'string') return { kind: 'file', mode: 0o644, uid: this.#uid }
    return { kind: e.kind ?? 'file', mode: e.mode ?? 0o644, uid: e.uid ?? this.#uid }
  }

  realpathish(path: string): string {
    let current = path
    for (let round = 0; round < 8; round++) {
      let changed = false
      const parts = current.split('/')
      for (let i = parts.length; i >= 1; i--) {
        const prefix = parts.slice(0, i).join('/')
        const target = this.#links[prefix]
        if (target !== undefined && prefix !== '') {
          current = [target, ...parts.slice(i)].join('/')
          changed = true
          break
        }
      }
      if (!changed) break
    }
    return current
  }

  /** Every path that was read or stat-ed. */
  touched(): string[] {
    return [...this.reads, ...this.stats]
  }
}
