// Static Command Center Web UI handler for Swarmboard server (HOST-12).
// Serves `/` and `/assets/*` from the pre-built self-contained bundle with strict CSP,
// security headers, ETag / If-None-Match 304 support, and HEAD support.
import { UI_ASSETS, UI_BUNDLE_STATS, type UiBundledAsset, type UiBundleStats } from '../ui/bundle.ts'
import type { ServerListenerContext, UiHandler } from './types.ts'

export const UI_CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false
  const trimmed = ifNoneMatch.trim()
  if (trimmed === '*') return true
  const normalize = (tag: string): string => tag.trim().replace(/^W\//i, '')
  const target = normalize(etag)
  return trimmed.split(',').some((candidate) => normalize(candidate) === target)
}

function lookupAsset(pathname: string): UiBundledAsset | null {
  if (pathname === '/favicon.ico') {
    return UI_ASSETS['/assets/favicon.svg'] ?? null
  }
  if (Object.prototype.hasOwnProperty.call(UI_ASSETS, pathname)) {
    return UI_ASSETS[pathname] ?? null
  }
  return null
}

/** Returns bundle size metadata for diagnostics and tests. */
export function getUiBundleStats(): UiBundleStats {
  return UI_BUNDLE_STATS
}

/**
 * Creates the Fetch-native static UI handler mounted on `GET/HEAD /`, `/assets/*`, and `/favicon.ico`.
 * Returns `null` for unrecognized paths so the router emits a standard `404 not_found`.
 */
export function createUiHandler(): UiHandler {
  return (req: Request, _ctx: ServerListenerContext): Response | null => {
    const method = req.method.toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return null

    let pathname: string
    try {
      pathname = new URL(req.url).pathname
    } catch {
      return null
    }

    const asset = lookupAsset(pathname)
    if (asset === null) return null

    const headers = new Headers({
      'content-type': asset.contentType,
      'cache-control': asset.cacheControl,
      etag: asset.etag,
      'content-security-policy': UI_CSP_HEADER,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    })

    if (etagMatches(req.headers.get('if-none-match'), asset.etag)) {
      return new Response(null, { status: 304, headers })
    }

    headers.set('content-length', String(asset.rawBytes))
    return new Response(method === 'HEAD' ? null : asset.body, { status: 200, headers })
  }
}
