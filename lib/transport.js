/**
 * HTTP transport for the Jupyter REST client, built on `node:http` / `node:https`.
 *
 * `fetch` was the obvious choice and it is the wrong one here, for two reasons that only show up
 * on a real deployment:
 *
 * 1. **It resolves the name itself, per connection.** Against a mDNS name that is five seconds per
 *    request (see `dns-cache.js`), and there is no way to hand `fetch` a resolved address. Owning
 *    the socket is the only way to own the lookup.
 * 2. **The `Host` header has to stay correct.** Jupyter answers `403` to a request whose `Host`
 *    does not match the address it was configured with, so "just connect to the IP" is not an
 *    option either — verified against a stock Jupyter Server 2.21: a valid token plus
 *    `Host: weird.local` gets `403`.
 *
 * `node:http` solves both: a custom `lookup` keeps the name for DNS-free connections *and* for
 * `Host`/SNI, and a keep-alive agent means the second request on a connection costs nothing but
 * the round trip.
 *
 * The response is intentionally buffered: every call this client makes returns a small JSON
 * document, and consuming the body is what lets the socket go back to the pool. Redirects are not
 * followed — an API call that bounces is answering with an HTML login page, and that needs to be
 * reported as an authentication problem rather than turned into a request to somewhere else.
 *
 * @module dsh-jupyterlab/transport
 */

import http from 'node:http'
import https from 'node:https'

import { createLookup } from './dns-cache.js'

/** Refuse to buffer an absurd response rather than exhausting memory on a wrong address. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** Sockets are reused across requests; that reuse is half the point of this module. */
const AGENTS = {
  'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 8 }),
  'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 8 }),
}

/** Shared by every request: one cache, one lookup. */
const sharedLookup = createLookup()

/** Case-insensitive response headers with the couple of accessors the client uses. */
export class ResponseHeaders {
  /** @param raw - Node's `IncomingHttpHeaders`. */
  constructor(raw) {
    this.raw = raw ?? {}
  }

  /**
   * @param name - Header name.
   * @returns The first value, or undefined.
   */
  get(name) {
    const value = this.raw[String(name).toLowerCase()]
    return Array.isArray(value) ? value[0] : value
  }

  /** Every `Set-Cookie` value, matching the fetch API the client was written against. */
  getSetCookie() {
    const value = this.raw['set-cookie']
    if (Array.isArray(value)) return value
    return typeof value === 'string' ? [value] : []
  }
}

/** The subset of `Response` this client depends on. */
export class HttpResult {
  /**
   * @param status - HTTP status code.
   * @param headers - Wrapped response headers.
   * @param body - Fully buffered body.
   */
  constructor(status, headers, body) {
    /** HTTP status code. */
    this.status = status
    /** Response headers. */
    this.headers = new ResponseHeaders(headers)
    /** Buffered body; `text()` decodes it. */
    this.body = body
  }

  /** Whether the status is 2xx. */
  get ok() {
    return this.status >= 200 && this.status < 300
  }

  /** @returns The body decoded as UTF-8. */
  async text() {
    return this.body.toString('utf8')
  }
}

/**
 * Compose an optional caller signal with a request deadline.
 *
 * @param signal - Caller cancellation, if any.
 * @param timeoutMs - Deadline in milliseconds; `0` or less disables it.
 * @returns A signal that aborts on either condition, or `undefined` when neither applies.
 */
export function combineSignals(signal, timeoutMs) {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
  if (signal === undefined || signal === null) return timeout
  if (timeout === undefined) return signal
  return AbortSignal.any([signal, timeout])
}

/**
 * Perform one HTTP request and buffer its response.
 *
 * @param url - Absolute http(s) URL.
 * @param options - Request controls.
 * @param options.method - HTTP method; defaults to GET.
 * @param options.headers - Request headers.
 * @param options.body - Request body as a string.
 * @param options.signal - Caller cancellation.
 * @param options.timeoutMs - Deadline in milliseconds.
 * @returns The buffered {@link HttpResult}.
 */
export async function httpRequest(url, { method = 'GET', headers = {}, body, signal, timeoutMs = 20_000 } = {}) {
  const target = new URL(url)
  const transport = target.protocol === 'https:' ? https : http
  const agent = AGENTS[target.protocol]
  const deadline = combineSignals(signal, timeoutMs)

  return await new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent,
      // The whole point: resolve through the cache instead of `dns.lookup` per connection. `Host`
      // and TLS SNI still come from `hostname`, so the server sees exactly what it expects.
      lookup: sharedLookup,
      signal: deadline,
    }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          request.destroy(new Error(`response exceeded ${MAX_BODY_BYTES} bytes`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        resolve(new HttpResult(response.statusCode ?? 0, response.headers, Buffer.concat(chunks)))
      })
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('the connection was closed before the response completed')))
    })

    request.on('error', reject)
    request.end(body)
  })
}
