// Reads the .jsonl audit copy against board_events (HOST0_DESIGN 3.2). The file is a set keyed by each
// line's `index`, not an ordered log (C8): this scan classifies lines and finds the events it lacks.
import * as fs from 'node:fs'

/** What `SqliteUnifiedStore.auditJsonl` found. */
export type JsonlAudit = {
  /** The audited file, or null when the store has no .jsonl. */
  path: string | null
  /** The log's head when the scan began. */
  head: number
  /** Non-empty lines read. */
  lines: number
  /** Distinct events 1..head that the file holds. */
  present: number
  /** Events 1..head the file lacks. */
  missing: number
  firstMissing: number | null
  /** Extra lines of an event the file already holds. */
  duplicates: number
  /** Lines whose id differs from the log's event at that index. */
  conflicts: number
  /** Lines naming an index above the head that was still above it when the scan ended. */
  beyondHead: number
  /** Lines that are not JSON, lack a positive integer `index` and a string `id`, or are a torn tail. */
  malformed: number
  /** Valid lines whose index is lower than the previous valid line's. */
  inversions: number
  /** The file's last line had no trailing newline. */
  tornTail: boolean
  /** Lines appended by a repair. */
  repaired: number
}

export type JsonlScan = {
  lines: number
  present: number
  duplicates: number
  conflicts: number
  malformed: number
  inversions: number
  tornTail: boolean
  /** Indices above the head that the scan set aside, to be judged against the head after the scan. */
  setAside: number[]
  /** `present[i] === 1` when event i is in the file (length head + 1). */
  seen: Uint8Array
  /** Whether the file's last byte is a newline (true for an empty file). */
  endsWithNewline: boolean
  size: number
}

const CHUNK = 1024 * 1024

/**
 * Scans `path` in 1 MiB chunks split on `\n`. `idAt` answers the id the log holds at an index (or
 * undefined). A missing file scans as empty.
 * @internal
 */
export function scanJsonl(path: string, head: number, idAt: (index: number) => string | undefined): JsonlScan {
  const scan: JsonlScan = {
    lines: 0,
    present: 0,
    duplicates: 0,
    conflicts: 0,
    malformed: 0,
    inversions: 0,
    tornTail: false,
    setAside: [],
    seen: new Uint8Array(head + 1),
    endsWithNewline: true,
    size: 0,
  }
  let fd: number
  try {
    fd = fs.openSync(path, 'r')
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') return scan
    throw error
  }
  let last = 0
  const line = (text: string): void => {
    if (text.trim() === '') return
    scan.lines += 1
    let index: number
    let id: unknown
    try {
      const parsed = JSON.parse(text) as { index?: unknown; id?: unknown } | null
      index = parsed?.index as number
      id = parsed?.id
    } catch {
      scan.malformed += 1
      return
    }
    if (!Number.isSafeInteger(index) || index < 1 || typeof id !== 'string') {
      scan.malformed += 1
      return
    }
    if (index < last) scan.inversions += 1
    last = index
    if (index > head) {
      scan.setAside.push(index)
      return
    }
    if (idAt(index) !== id) {
      scan.conflicts += 1
      return
    }
    if (scan.seen[index] === 1) scan.duplicates += 1
    else {
      scan.seen[index] = 1
      scan.present += 1
    }
  }
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    let carry = Buffer.alloc(0)
    let lastByte = 0x0a
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null)
      if (n === 0) break
      scan.size += n
      lastByte = buf[n - 1]!
      let data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let from = 0
      for (let at = data.indexOf(0x0a, from); at !== -1; at = data.indexOf(0x0a, from)) {
        line(data.toString('utf8', from, at))
        from = at + 1
      }
      carry = Buffer.from(data.subarray(from))
      data = Buffer.alloc(0)
    }
    scan.endsWithNewline = lastByte === 0x0a
    if (carry.length > 0 && carry.toString('utf8').trim() !== '') {
      // A last line with no newline: torn, so malformed whatever it holds.
      scan.lines += 1
      scan.malformed += 1
      scan.tornTail = true
    }
  } finally {
    fs.closeSync(fd)
  }
  return scan
}
