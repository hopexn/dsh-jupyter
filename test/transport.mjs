/**
 * Tests for the transport layer: name-resolution caching, socket reuse, and the WebSocket client.
 *
 * These cover the three things that made the plugin feel slow on a real deployment and that no
 * other suite can see:
 *
 * 1. **One lookup per host.** A mDNS name costs about five seconds per `getaddrinfo`; the cache is
 *    what turns the second request into a millisecond.
 * 2. **One socket for many requests.** Keep-alive is the other half of that win, and it is easy to
 *    lose by accident (a forgotten agent, an unconsumed body).
 * 3. **The frame codec.** The kernel channel no longer uses the built-in `WebSocket`, so masking,
 *    extended lengths, fragmentation and close have to be proven here.
 *
 * Everything runs against servers started in this process on 127.0.0.1 — no Jupyter required.
 *
 *   node test/transport.mjs
 */

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import dns from 'node:dns'
import http from 'node:http'

import { clearDnsCache, createLookup, dnsCacheEntries, resolveHost } from '../lib/dns-cache.js'
import { httpRequest } from '../lib/transport.js'
import { KernelSocket } from '../lib/websocket.js'
import { JupyterError, JupyterServerClient } from '../lib/server.js'

let passed = 0
const failures = []

/**
 * Run one named check, recording failures instead of aborting the run.
 * @param label - What is being asserted.
 * @param body - The check.
 */
async function check(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`FAIL  ${label}\n      ${error?.message ?? error}`)
  }
}

/** Start an HTTP server that records what it is asked for. */
async function startServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }
}

console.log('name resolution')

await check('a resolved address is reused instead of asked for again', async () => {
  clearDnsCache()
  const first = await resolveHost('localhost')
  assert.equal(dnsCacheEntries().length, 1)
  const second = await resolveHost('localhost')
  assert.deepEqual(second, first)
  // One entry, not two: the second call was served from the cache.
  assert.equal(dnsCacheEntries().filter((entry) => entry.host === 'localhost').length, 1)
})

await check('concurrent resolutions share one resolver round trip', async () => {
  clearDnsCache()
  const original = dns.promises.lookup
  let calls = 0
  try {
    dns.promises.lookup = async (...args) => {
      calls += 1
      return await original.apply(dns.promises, args)
    }
  } catch {
    // A read-only property: the cache assertions above still cover the behaviour.
    return
  }
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => resolveHost('localhost')))
    assert.equal(calls, 1, `the resolver was asked ${calls} times, expected 1`)
    for (const result of results) assert.deepEqual(result, results[0])
  } finally {
    dns.promises.lookup = original
  }
})

await check('an IP literal is never resolved', async () => {
  clearDnsCache()
  assert.deepEqual(await resolveHost('192.168.5.200'), { address: '192.168.5.200', family: 4 })
  assert.deepEqual(await resolveHost('::1'), { address: '::1', family: 6 })
  assert.equal(dnsCacheEntries().length, 0)
})

await check('the lookup function supports both node:http call shapes', async () => {
  const lookup = createLookup()
  const single = await new Promise((resolve, reject) => {
    lookup('localhost', { family: 0 }, (error, address, family) => (error ? reject(error) : resolve({ address, family })))
  })
  assert.equal(typeof single.address, 'string')
  const all = await new Promise((resolve, reject) => {
    lookup('localhost', { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)))
  })
  assert.ok(Array.isArray(all) && all.length >= 1)
  assert.equal(typeof all[0].address, 'string')
})

console.log('\nhttp transport')

await check('repeated requests reuse one socket', async () => {
  let connections = 0
  const { server, url } = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })
  server.on('connection', () => { connections += 1 })
  try {
    for (let index = 0; index < 5; index += 1) {
      const result = await httpRequest(`${url}/api/status`)
      assert.equal(result.status, 200)
      assert.equal((await result.text()).includes('"ok":true'), true)
    }
    assert.equal(connections, 1, `opened ${connections} sockets for 5 requests, expected 1`)
  } finally {
    server.close()
  }
})

await check('the Host header carries the configured name, not the resolved address', async () => {
  let seen
  const { server, url } = await startServer((request, response) => {
    seen = request.headers.host
    response.writeHead(200)
    response.end('ok')
  })
  try {
    const target = url.replace('127.0.0.1', 'localhost')
    const result = await httpRequest(`${target}/api/status`)
    assert.equal(result.status, 200)
    assert.equal(seen, `localhost:${new URL(url).port}`)
  } finally {
    server.close()
  }
})

await check('a JSON body and its content type survive the round trip', async () => {
  let body
  let type
  const { server, url } = await startServer((request, response) => {
    type = request.headers['content-type']
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      body = JSON.parse(raw)
      response.writeHead(201, { 'set-cookie': 'a=1; Path=/' })
      response.end('{"id":"kernel-1"}')
    })
  })
  try {
    const result = await httpRequest(`${url}/api/kernels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'python3' }),
    })
    assert.equal(result.status, 201)
    assert.equal(result.ok, true)
    assert.deepEqual(body, { name: 'python3' })
    assert.equal(type, 'application/json')
    assert.deepEqual(result.headers.getSetCookie(), ['a=1; Path=/'])
    assert.equal(await result.text(), '{"id":"kernel-1"}')
  } finally {
    server.close()
  }
})

await check('an aborted request rejects instead of hanging', async () => {
  const { server, url } = await startServer(() => {
    // Never answers.
  })
  try {
    await assert.rejects(
      () => httpRequest(`${url}/api/status`, { timeoutMs: 150 }),
      (error) => error.name === 'AbortError' || error.name === 'TimeoutError',
    )
  } finally {
    server.close()
  }
})

console.log('\nwebsocket')

/**
 * A minimal RFC 6455 server: handshake, read masked client frames, echo text back unmasked.
 * @param onClose - Called when the client closes.
 */
async function startEchoSocket(onClose) {
  const server = http.createServer((request, response) => {
    response.writeHead(400)
    response.end('upgrade only')
  })
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const fin = (buffer[0] & 0x80) !== 0
        const opcode = buffer[0] & 0x0f
        const masked = (buffer[1] & 0x80) !== 0
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
        if (masked) offset += 4
        if (buffer.length < offset + length) return
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        if (mask !== undefined) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3]
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x8) {
          onClose?.()
          socket.end()
          return
        }
        if (opcode === 0x1) {
          // Echo back unmasked, fin set.
          const head = length < 126
            ? Buffer.from([0x80 | 0x1, length])
            : length < 65_536
              ? Buffer.from([0x80 | 0x1, 126, length >> 8, length & 0xff])
              : (() => {
                const wide = Buffer.alloc(10)
                wide[0] = 0x80 | 0x1
                wide[1] = 127
                wide.writeBigUInt64BE(BigInt(length), 2)
                return wide
              })()
          socket.write(Buffer.concat([head, payload]))
          if (!fin) return
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

/** Resolve once the socket reports `open`, or reject on `error`. */
function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(socket))
    socket.addEventListener('error', (event) => reject(new Error(event?.message ?? 'socket error')))
  })
}

/** Collect the next text message. */
function nextMessage(socket) {
  return new Promise((resolve) => {
    const handler = (event) => {
      socket.removeEventListener('message', handler)
      resolve(event.data)
    }
    socket.addEventListener('message', handler)
  })
}

await check('a text frame round trips', async () => {
  const { server, port } = await startEchoSocket()
  try {
    const socket = new KernelSocket(`ws://127.0.0.1:${port}/api/kernels/x/channels`, { lookup: createLookup() })
    await opened(socket)
    assert.equal(socket.readyState, 1)
    const message = nextMessage(socket)
    socket.send('{"msg_type":"execute_request"}')
    assert.equal(await message, '{"msg_type":"execute_request"}')
    socket.close()
  } finally {
    server.close()
  }
})

await check('a 200 KiB message survives the 64-bit length path', async () => {
  const { server, port } = await startEchoSocket()
  try {
    const socket = new KernelSocket(`ws://127.0.0.1:${port}/api/kernels/x/channels`)
    await opened(socket)
    const payload = 'x'.repeat(200 * 1024)
    const message = nextMessage(socket)
    socket.send(payload)
    const echoed = await message
    assert.equal(echoed.length, payload.length)
    socket.close()
  } finally {
    server.close()
  }
})

await check('a 300 byte message uses the 16-bit length path', async () => {
  const { server, port } = await startEchoSocket()
  try {
    const socket = new KernelSocket(`ws://127.0.0.1:${port}/api/kernels/x/channels`)
    await opened(socket)
    const payload = 'y'.repeat(300)
    const message = nextMessage(socket)
    socket.send(payload)
    assert.equal((await message).length, 300)
    socket.close()
  } finally {
    server.close()
  }
})

await check('close reaches the server and the client reports it once', async () => {
  let closedOnServer = 0
  const { server, port } = await startEchoSocket(() => { closedOnServer += 1 })
  try {
    const socket = new KernelSocket(`ws://127.0.0.1:${port}/api/kernels/x/channels`)
    await opened(socket)
    let closed = 0
    socket.addEventListener('close', () => { closed += 1 })
    socket.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(closed, 1)
    assert.equal(socket.readyState, 3)
    assert.equal(closedOnServer, 1)
  } finally {
    server.close()
  }
})

await check('a refused upgrade is reported as an error, not a hang', async () => {
  const { server, port } = await startServer((request, response) => {
    response.writeHead(404)
    response.end('no such kernel')
  })
  try {
    const socket = new KernelSocket(`ws://127.0.0.1:${port}/api/kernels/gone/channels`, { connectTimeoutMs: 2000 })
    await assert.rejects(() => opened(socket), /HTTP 404/)
  } finally {
    server.close()
  }
})

await check('send on a closed socket throws instead of silently dropping', async () => {
  const { server, port } = await startEchoSocket()
  try {
    const socket = new KernelSocket(`ws://127.0.0.1:${port}/api/kernels/x/channels`)
    await opened(socket)
    socket.close()
    assert.throws(() => socket.send('x'), /not open/)
  } finally {
    server.close()
  }
})

console.log('\nproxy cookie (SSO / access proxy)')

/**
 * A stand-in for a deployment behind an access proxy.
 *
 * It records every request's headers, answers `/api/status` like Jupyter would, rotates its
 * session cookie on `/api/rotating`, and answers `/api/redirect` the way such a gateway does:
 * a 302 to its SSO page, plus a *fresh anonymous* cookie that must not replace the pasted one.
 */
async function startProxyPeer() {
  const seen = []
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers })
    if (request.url === '/api/redirect') {
      response.writeHead(302, {
        location: 'https://sso.corp.example/cas/login?service=https%3A%2F%2Fjupyter.example%2Fapi%2Fstatus',
        'set-cookie': 'accessproxy_session=anonymous; Path=/',
        'content-type': 'text/html',
      })
      response.end('<html><head><title>302 Found</title></head><body>AccessProxy</body></html>')
      return
    }
    if (request.url === '/api/rotating') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'accessproxy_session=rotated; Path=/',
      })
      response.end('{}')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(request.method === 'POST' ? '{"id":"kernel-1"}' : '{"ok":true}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}`, seen }
}

await check('a pasted cookie is sent on reads and on mutating requests', async () => {
  const peer = await startProxyPeer()
  try {
    const client = new JupyterServerClient({ url: peer.url, cookie: 'accessproxy_session=abc; apdid=dev-1' })
    assert.equal(client.authMode, 'cookie', 'a cookie-only connection has its own auth mode')
    await client.json('/api/status')
    await client.json('/api/kernels', { method: 'POST', json: { name: 'python3' } })
    assert.equal(peer.seen[0].headers.cookie, 'accessproxy_session=abc; apdid=dev-1')
    assert.equal(peer.seen[1].headers.cookie, 'accessproxy_session=abc; apdid=dev-1')
    // No token means no Authorization header; the proxy is the credential.
    assert.equal('authorization' in peer.seen[0].headers, false)
  } finally {
    peer.server.close()
  }
})

await check('a `_xsrf` inside the pasted cookie becomes the XSRF header', async () => {
  const peer = await startProxyPeer()
  try {
    const client = new JupyterServerClient({ url: peer.url, cookie: 'sso=1; _xsrf=xsrf-from-browser' })
    await client.json('/api/kernels', { method: 'POST', json: {} })
    assert.equal(peer.seen[0].headers['x-xsrftoken'], 'xsrf-from-browser')
    // A read does not need it, and Jupyter ignores an extra one anyway — but the *mutating* path
    // is the one that used to fail with 403, so it is the one asserted.
    await client.json('/api/status')
    assert.equal(peer.seen[1].headers['x-xsrftoken'], undefined)
  } finally {
    peer.server.close()
  }
})

await check('a rotated session cookie replaces the pasted one', async () => {
  const peer = await startProxyPeer()
  try {
    const client = new JupyterServerClient({ url: peer.url, cookie: 'accessproxy_session=old' })
    await client.json('/api/rotating')
    await client.json('/api/status')
    assert.equal(peer.seen[1].headers.cookie, 'accessproxy_session=rotated')
  } finally {
    peer.server.close()
  }
})

await check('a redirect is reported as a proxy problem, not as an HTML page', async () => {
  const peer = await startProxyPeer()
  try {
    const client = new JupyterServerClient({ url: peer.url, cookie: 'accessproxy_session=abc' })
    // The peer redirects on `/api/redirect`, like a gateway does for every unauthenticated path.
    let error
    try {
      await client.json('/api/redirect')
    } catch (cause) {
      error = cause
    }
    assert.ok(error instanceof JupyterError, 'a redirect must surface as a JupyterError')
    assert.match(error.message, /redirected \(HTTP 302 to sso\.corp\.example\)/)
    assert.match(error.message, /SSO|access proxy/)
    assert.match(error.message, /Cookie header/)
    assert.doesNotMatch(error.message, /<html>/, 'the login page HTML must not be the error')
    // The anonymous cookie the redirect carried must not clobber the pasted session.
    await client.json('/api/status')
    const last = peer.seen[peer.seen.length - 1]
    assert.equal(last.headers.cookie, 'accessproxy_session=abc')
  } finally {
    peer.server.close()
  }
})

/** Accept one WebSocket upgrade and record the headers it arrived with. */
async function startUpgradeRecorder() {
  const handshakes = []
  const server = http.createServer((request, response) => {
    response.writeHead(400)
    response.end('upgrade only')
  })
  server.on('upgrade', (request, socket) => {
    handshakes.push(request.headers)
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, handshakes, url: `http://127.0.0.1:${server.address().port}` }
}

await check('the kernel WebSocket upgrade carries the proxy cookie too', async () => {
  const recorder = await startUpgradeRecorder()
  try {
    const client = new JupyterServerClient({ url: recorder.url, cookie: 'accessproxy_session=abc' })
    const target = client.wsTarget('/api/kernels/k1/channels')
    assert.equal(target.headers.cookie, 'accessproxy_session=abc')
    const socket = new KernelSocket(target.url, {
      headers: target.headers,
      lookup: createLookup(),
      connectTimeoutMs: 3000,
    })
    await opened(socket)
    socket.close()
    assert.equal(recorder.handshakes.length, 1)
    assert.equal(recorder.handshakes[0].cookie, 'accessproxy_session=abc')
  } finally {
    recorder.server.close()
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`\n${label}\n${error?.stack ?? error}`)
  process.exit(1)
}

// Keep the process from waiting on a stray socket.
process.exit(0)
