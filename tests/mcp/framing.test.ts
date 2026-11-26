import { describe, expect, it } from 'vitest'
import { encodeFrame, FrameParser, JSONRPC_ERRORS } from '../../src/mcp/framing.ts'

describe('MCP stdio framing (NDJSON + Content-Length)', () => {
  it('parses NDJSON single, multi-line, CRLF, blank lines, and split UTF-8 chunks', () => {
    const parser = new FrameParser()
    const msg1 = { jsonrpc: '2.0', id: 1, method: 'ping' }
    const msg2 = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'board_post', arguments: { text: 'hello 🚀✨' } } }

    const wire = Buffer.concat([
      Buffer.from('\r\n  \n', 'utf8'),
      encodeFrame(msg1, 'ndjson'),
      Buffer.from(`${JSON.stringify(msg2)}\r\n`, 'utf8'),
    ])

    // Feed 3 bytes at a time to split across multi-byte UTF-8 rocket emoji
    const frames = []
    for (let i = 0; i < wire.length; i += 3) {
      frames.push(...parser.push(wire.subarray(i, i + 3)))
    }
    frames.push(...parser.flush())

    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ kind: 'message', mode: 'ndjson', value: msg1 })
    expect(frames[1]).toEqual({ kind: 'message', mode: 'ndjson', value: msg2 })
    expect(parser.detectedMode).toBe('ndjson')
  })

  it('flushes a trailing NDJSON message without a final newline on EOF', () => {
    const parser = new FrameParser()
    expect(parser.push('{"jsonrpc":"2.0","id":7,"method":"ping"}')).toEqual([])
    expect(parser.flush()).toEqual([
      { kind: 'message', mode: 'ndjson', value: { jsonrpc: '2.0', id: 7, method: 'ping' } },
    ])
  })

  it('parses Content-Length frames with exact UTF-8 byte lengths and extra headers', () => {
    const parser = new FrameParser()
    const payload = { jsonrpc: '2.0', id: 'req-1', method: 'tools/call', params: { text: 'emoji 🎉🚀日本語' } }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const raw = Buffer.concat([
      Buffer.from(`Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`, 'ascii'),
      body,
      encodeFrame({ jsonrpc: '2.0', id: 'req-2', method: 'ping' }, 'content-length'),
    ])

    const frames = []
    for (let i = 0; i < raw.length; i += 5) {
      frames.push(...parser.push(raw.subarray(i, i + 5)))
    }
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ kind: 'message', mode: 'content-length', value: payload })
    expect(frames[1]).toEqual({
      kind: 'message',
      mode: 'content-length',
      value: { jsonrpc: '2.0', id: 'req-2', method: 'ping' },
    })
    expect(parser.detectedMode).toBe('content-length')
  })

  it('supports mixed Content-Length and NDJSON frames on the same stream', () => {
    const parser = new FrameParser()
    const wire = Buffer.concat([
      encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'content-length'),
      encodeFrame({ jsonrpc: '2.0', id: 2, method: 'ping' }, 'ndjson'),
    ])
    const frames = parser.push(wire)
    expect(frames).toEqual([
      { kind: 'message', mode: 'content-length', value: { jsonrpc: '2.0', id: 1, method: 'ping' } },
      { kind: 'message', mode: 'ndjson', value: { jsonrpc: '2.0', id: 2, method: 'ping' } },
    ])
  })

  it('reports parse error on invalid JSON and oversized frames without crashing', () => {
    const parser = new FrameParser(64)
    const badJson = parser.push('{not-json}\n')
    expect(badJson).toHaveLength(1)
    expect(badJson[0]).toMatchObject({ kind: 'error', mode: 'ndjson', code: JSONRPC_ERRORS.PARSE_ERROR })

    const tooBig = parser.push(`${'x'.repeat(80)}\n`)
    expect(tooBig).toHaveLength(1)
    expect(tooBig[0]).toMatchObject({ kind: 'error', mode: 'ndjson', code: JSONRPC_ERRORS.INVALID_REQUEST })

    const bigCl = parser.push('Content-Length: 999\r\n\r\n')
    expect(bigCl).toHaveLength(1)
    expect(bigCl[0]).toMatchObject({ kind: 'error', mode: 'content-length', code: JSONRPC_ERRORS.INVALID_REQUEST })

    // Parser recovers cleanly for subsequent valid messages
    const ok = parser.push('{"jsonrpc":"2.0","id":3,"method":"ping"}\n')
    expect(ok).toEqual([{ kind: 'message', mode: 'ndjson', value: { jsonrpc: '2.0', id: 3, method: 'ping' } }])
  })

  it('reports truncated Content-Length frame on EOF', () => {
    const parser = new FrameParser()
    expect(parser.push('Content-Length: 100\r\n\r\n{"partial":true')).toEqual([])
    const flushed = parser.flush()
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toMatchObject({ kind: 'error', mode: 'content-length', code: JSONRPC_ERRORS.PARSE_ERROR })
  })
})
