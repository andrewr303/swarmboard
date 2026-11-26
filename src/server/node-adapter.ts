// Zero-dependency Node `node:http` adapter for the Fetch-native Swarmboard server handler (HOST-9).
// Enforces the 8 MiB request body cap while streaming (413 too_large), wires client disconnect
// to Request.signal, streams SSE responses with immediate header flush, and preserves multi-value
// Set-Cookie headers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tooLarge } from '../core/public.ts'
import { clientErrorPayload } from '../client/normalize.ts'
import { DEFAULT_MAX_BODY_BYTES } from './router.ts'
import type { ServerListenerContext } from './types.ts'

export interface NodeAdapterOptions {
  readonly maxBodyBytes?: number
  readonly onRequestStart?: () => void
  readonly onRequestEnd?: () => void
}

function buildRequestUrl(req: IncomingMessage, ctx: ServerListenerContext): string {
  const scheme = ctx.listener === 'https' ? 'https' : 'http'
  const fallbackHost = ctx.port !== undefined ? `127.0.0.1:${ctx.port}` : 'localhost'
  const hostHeader = req.headers.host
  let authority = fallbackHost
  if (typeof hostHeader === 'string' && hostHeader.trim() !== '') {
    const candidate = hostHeader.trim()
    try {
      const parsed = new URL(`${scheme}://${candidate}/`)
      if (parsed.username === '' && parsed.password === '' && parsed.host !== '') {
        authority = candidate
      }
    } catch {
      // Malformed Host header (e.g. evil.example:99999): keep safe authority for Request
      // construction while preserving the raw Host header for router loopback guards -> 403.
      authority = fallbackHost
    }
  }
  const rawUrl = req.url ?? '/'
  const safePath = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`
  try {
    return new URL(safePath, `${scheme}://${authority}`).toString()
  } catch {
    return `${scheme}://${fallbackHost}/`
  }
}

function copyHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, val] of Object.entries(req.headers)) {
    if (val === undefined) continue
    if (Array.isArray(val)) {
      for (const item of val) headers.append(key, item)
    } else {
      headers.set(key, val)
    }
  }
  return headers
}

function readNodeBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const contentLength = req.headers['content-length']
    if (typeof contentLength === 'string') {
      const parsed = Number(contentLength)
      if (Number.isFinite(parsed) && parsed > maxBodyBytes) {
        req.resume()
        reject(tooLarge(`request body exceeds ${Math.round(maxBodyBytes / 1024 / 1024)} MiB limit`))
        return
      }
    }

    const chunks: Buffer[] = []
    let total = 0
    let done = false

    const finishErr = (err: unknown): void => {
      if (done) return
      done = true
      reject(err)
    }

    req.on('data', (chunk: Buffer | string) => {
      if (done) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.byteLength
      if (total > maxBodyBytes) {
        req.pause()
        finishErr(tooLarge(`request body exceeds ${Math.round(maxBodyBytes / 1024 / 1024)} MiB limit`))
        return
      }
      chunks.push(buf)
    })

    req.on('end', () => {
      if (done) return
      done = true
      resolve(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total))
    })

    req.on('error', finishErr)
  })
}

async function writeWebResponse(webRes: Response, nodeRes: ServerResponse, signal: AbortSignal): Promise<void> {
  const headersObj: Record<string, string | string[]> = {}
  const setCookies =
    typeof webRes.headers.getSetCookie === 'function' ? webRes.headers.getSetCookie() : []
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return
    headersObj[key] = value
  })
  if (setCookies.length > 0) {
    headersObj['set-cookie'] = setCookies
  }

  nodeRes.writeHead(webRes.status, headersObj)
  const contentType = webRes.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    nodeRes.flushHeaders()
  }

  if (webRes.body === null) {
    nodeRes.end()
    return
  }

  const reader = webRes.body.getReader()
  const onAbort = (): void => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      if (nodeRes.destroyed || nodeRes.writableEnded) break
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      const ok = nodeRes.write(value)
      if (!ok && !nodeRes.destroyed) {
        await new Promise<void>((resolve) => {
          const cleanup = (): void => {
            nodeRes.off('drain', cleanup)
            nodeRes.off('close', cleanup)
            resolve()
          }
          nodeRes.once('drain', cleanup)
          nodeRes.once('close', cleanup)
        })
      }
    }
  } catch {
    // Client closed stream mid-response
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
    if (!nodeRes.destroyed && !nodeRes.writableEnded) {
      nodeRes.end()
    }
  }
}

export function attachNodeHandler(
  server: Server,
  handler: (req: Request, ctx: ServerListenerContext) => Promise<Response>,
  ctxOrFactory: ServerListenerContext | (() => ServerListenerContext),
  opts: NodeAdapterOptions = {},
): void {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const getCtx = typeof ctxOrFactory === 'function' ? ctxOrFactory : () => ctxOrFactory

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    opts.onRequestStart?.()
    const abortController = new AbortController()
    let finished = false
    const markFinished = (): void => {
      if (finished) return
      finished = true
      opts.onRequestEnd?.()
    }
    res.once('finish', markFinished)
    res.once('close', () => {
      if (!res.writableFinished) {
        abortController.abort(new Error('client disconnected'))
      }
      markFinished()
    })

    void (async () => {
      try {
        const ctx = getCtx()
        const method = (req.method ?? 'GET').toUpperCase()
        const headers = copyHeaders(req)
        const url = buildRequestUrl(req, ctx)

        let body: Uint8Array | undefined
        if (method !== 'GET' && method !== 'HEAD') {
          const buf = await readNodeBody(req, maxBodyBytes)
          if (buf.byteLength > 0) {
            body = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          }
        }

        const init: RequestInit = {
          method,
          headers,
          signal: abortController.signal,
          ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
        }
        const webReq = new Request(url, init)
        const webRes = await handler(webReq, ctx)
        await writeWebResponse(webRes, res, abortController.signal)
      } catch (err) {
        if (!res.headersSent && !res.destroyed) {
          const { status, payload, retryAfter } = clientErrorPayload(err)
          const hdrs: Record<string, string> = {
            'content-type': 'application/json; charset=utf-8',
            'x-content-type-options': 'nosniff',
          }
          if (retryAfter !== undefined) hdrs['retry-after'] = String(retryAfter)
          res.writeHead(status, hdrs)
          res.end(JSON.stringify(payload))
        } else if (!res.destroyed && !res.writableEnded) {
          res.end()
        }
      } finally {
        markFinished()
      }
    })()
  })
}

export function createNodeHttpServer(
  handler: (req: Request, ctx: ServerListenerContext) => Promise<Response>,
  ctxOrFactory: ServerListenerContext | (() => ServerListenerContext),
  opts: NodeAdapterOptions = {},
): Server {
  const server = createServer()
  attachNodeHandler(server, handler, ctxOrFactory, opts)
  return server
}
