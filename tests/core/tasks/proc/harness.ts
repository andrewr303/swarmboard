// The parent side of the multi-process tests: forks tests/core/tasks/proc/child.ts as separate OS
// processes on one WAL file, and talks to each over its IPC channel.
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url))

export type Failure = { status: number; code: string; message: string }
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: Failure }

export class Child {
  readonly proc: ChildProcess
  readonly pid: number
  /** Settles with the exit code and signal once the process is gone. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private next = 1
  private readonly pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>()

  private constructor(proc: ChildProcess, pid: number, exited: Child['exited']) {
    this.proc = proc
    this.pid = pid
    this.exited = exited
    proc.on('message', (raw) => {
      const m = raw as { id?: number } & Reply
      if (m.id === undefined) return
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      p.resolve(m)
    })
    void exited.then(({ code, signal }) => {
      for (const p of this.pending.values()) p.reject(new Error(`child ${pid} exited (${code ?? signal}) before it answered`))
      this.pending.clear()
    })
  }

  /** Forks a child on `path` and waits until its board is open. */
  static start(path: string, extra: Record<string, unknown> = {}): Promise<Child> {
    const proc = fork(CHILD, [JSON.stringify({ path, ...extra })], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once('exit', (code, signal) => resolve({ code, signal })),
    )
    return new Promise((resolve, reject) => {
      const onMessage = (raw: unknown): void => {
        const m = raw as { ready?: boolean; pid?: number }
        if (!m.ready) return
        proc.off('message', onMessage)
        resolve(new Child(proc, m.pid ?? proc.pid ?? 0, exited))
      }
      proc.on('message', onMessage)
      void exited.then(({ code, signal }) => reject(new Error(`child exited (${code ?? signal}) before it opened the board`)))
    })
  }

  /** Sends one request; resolves with its reply. */
  send<T = unknown>(op: string, fields: Record<string, unknown> = {}): Promise<Reply<T>> {
    const id = this.next++
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.send({ id, op, ...fields })
    }) as Promise<Reply<T>>
  }

  /** Sends one request and fails unless it went through. */
  async ask<T = unknown>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    const reply = await this.send<T>(op, fields)
    if (!reply.ok) throw new Error(`${op} failed in child ${this.pid}: ${JSON.stringify(reply.error)}`)
    return reply.value
  }

  /** `board.tasks[method](caller, ...args)` in the child. */
  call<T = unknown>(caller: string, method: string, args: unknown[] = [], retry = false): Promise<Reply<T>> {
    return this.send<T>('call', { caller, method, args, retry })
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return
    try {
      await this.send('exit')
    } catch {
      // It went first.
    }
    await this.exited
  }

  kill(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.proc.kill('SIGKILL')
    return this.exited
  }
}

/** A fresh directory for one test's board file. */
export function tempBoard(): { path: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-proc-'))
  return { path: join(dir, 'board.db'), dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Starts `n` children on `path`, in parallel. */
export const startAll = (path: string, n: number, extra: Record<string, unknown> = {}): Promise<Child[]> =>
  Promise.all(Array.from({ length: n }, () => Child.start(path, extra)))
