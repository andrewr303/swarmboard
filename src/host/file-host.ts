// FileHost: composes layout (openBoardStore), WakeBridge, and Ticker for Mode 1 SharedFileTransport
// (HOST123_DESIGN 3, 6.6, 7.3, 7.4; HS-186).
//
// Host-layer composition only: never imports ../core/internal.ts, never re-exports any internal value,
// never exposes Ticker's private SystemCaller/SystemOps on the attachment or in status/reports,
// and never closes the store (WakeBridge closes it on `replaced`; SharedFileTransport closes it at refs === 0).
import type { BoardService, SqliteStoreOptions, SqliteUnifiedStore } from '../core/public.ts'
import { clientError } from '../client/errors.ts'
import type { BoardTarget } from '../client/resolve.ts'
import type { FileHost, FileHostAttachment } from '../client/transport-file.ts'
import { openBoardStore, type OpenBoardOptions } from './layout.ts'
import { Ticker, type TickErrorSite, type TickerOptions } from './tick.ts'
import { WakeBridge, type WakeBridgeOptions, type WakeErrorSite } from './wake-bridge.ts'

export interface FileHostOptions {
  readonly target: Extract<BoardTarget, { kind: 'file' }>
  readonly allowUnsafeFs: boolean
  readonly wake: { readonly watch: boolean; readonly safetyPollMs: number }
  /** 'owner-only' = no Ticker in Mode 1 clients (a daemon ticks, HOST-10). */
  readonly tick: 'lease' | 'owner-only' | 'off'
  readonly ticker?: Pick<TickerOptions, 'intervalMs' | 'ttlMs' | 'jitter' | 'onReport'>
  readonly onError?: (error: unknown, site: string) => void
  readonly layout?: Pick<OpenBoardOptions, 'platform' | 'home' | 'env' | 'uid' | 'probe' | 'testHooks'>
  readonly bridgeTestHooks?: WakeBridgeOptions['testHooks']
}

export function createFileHost(options: FileHostOptions): FileHost {
  const onError = options.onError

  return {
    open(path: string, storeOptions?: Pick<SqliteStoreOptions, 'testHooks'>) {
      if (path !== options.target.db) {
        throw clientError('invalid_db_path', `FileHost was configured for ${options.target.db}, not ${path}`)
      }
      const opened = openBoardStore(options.target, {
        ...options.layout,
        allowUnsafeFs: options.allowUnsafeFs,
        ...(storeOptions !== undefined ? { storeOptions } : {}),
      })
      return {
        store: opened.store,
        warnings: opened.warnings,
      }
    },

    attach(store: SqliteUnifiedStore): FileHostAttachment {
      const bridge = new WakeBridge(store, {
        safetyPollMs: options.wake.safetyPollMs,
        watch: options.wake.watch,
        ...(onError !== undefined ? { onError: (error: unknown, site: WakeErrorSite) => onError(error, site) } : {}),
        ...(options.bridgeTestHooks !== undefined ? { testHooks: options.bridgeTestHooks } : {}),
      })
      const safetyPollMs = bridge.serviceOptions().eventsWaitPollMs

      let ticker: Ticker | null = null
      let bound = false
      let closed = false

      // If the bridge stops on its own (e.g. `replaced` or external store close), stop the ticker promptly.
      bridge.onStop(() => {
        ticker?.stop()
      })

      const attachment: FileHostAttachment = {
        get wake(): 'fs-watch' | 'poll' {
          return bridge.status().mode ?? 'poll'
        },
        get safetyPollMs(): number {
          return safetyPollMs
        },
        get ticking(): boolean {
          return ticker !== null && ticker.status().state === 'running'
        },
        serviceOptions() {
          return bridge.serviceOptions()
        },
        bindBoard(board: BoardService): void {
          if (bound) {
            throw new TypeError('FileHostAttachment.bindBoard has already been called')
          }
          if (closed) return
          bound = true
          bridge.start()
          if (options.tick === 'lease') {
            try {
              ticker = new Ticker(board, {
                ...options.ticker,
                ...(onError !== undefined
                  ? { onError: (error: unknown, site: TickErrorSite) => onError(error, site) }
                  : {}),
              })
              ticker.start()
            } catch (error) {
              ticker?.stop()
              ticker = null
              bridge.stop()
              throw error
            }
          }
        },
        onReset(listener) {
          return bridge.onReset((reset) => {
            listener({
              epoch: reset.epoch,
              reason: reset.reason,
              identity: reset.identity,
              cursor: reset.cursor,
            })
          })
        },
        onStop(listener) {
          return bridge.onStop((stop) => {
            listener({
              reason: stop.reason,
              error: stop.error,
            })
          })
        },
        status() {
          return Object.freeze({
            wake: bridge.status(),
            tick: ticker !== null ? ticker.status() : null,
          })
        },
        async close(): Promise<void> {
          if (closed) return
          closed = true
          // Teardown order is normative (HOST123_DESIGN 6.6, 7.3): release the tick lease while the store is still
          // open, then stop the bridge; NEVER close the store here.
          ticker?.stop()
          bridge.stop()
        },
      }

      return attachment
    },
  }
}
