/**
 * Minimal, dependency-free Jupyter Server REST client.
 *
 * Talks to the Jupyter Server 2.x HTTP API (`/api/...`) over `node:http`/`node:https` — through
 * `transport.js`, which caches name resolution and reuses sockets, because `fetch` re-resolves the
 * hostname per connection and a mDNS name costs five seconds per lookup. It supports both
 * authentication styles a Jupyter deployment may use:
 *
 * - **token** — sent as `Authorization: token <token>` (and `?token=` on WebSocket upgrades).
 * - **password** — the `/login` form flow, with the resulting session cookie replayed on every
 *   request and on the WebSocket upgrade.
 * - **cookie** — a `Cookie` header copied from a browser request, for a Jupyter deployment behind
 *   an SSO/access proxy (openresty, oauth2-proxy, a corporate gateway). Nothing else in the plugin
 *   can get past such a proxy: it answers every unauthenticated path with a 302 to its login page,
 *   so neither a token nor a Jupyter password is ever seen. A pasted cookie can be the only
 *   credential (the proxy authenticates the request) or ride along with a token/password (the
 *   proxy gets its cookie, Jupyter gets its token). `_xsrf` inside the pasted cookie is used for
 *   the XSRF header on mutating requests, and the cookie is sent on kernel WebSocket upgrades too.
 *
 * The class is intentionally transport-only: it normalizes the server address, owns the cookie
 * jar, maps HTTP failures onto readable {@link JupyterError}s, and exposes one method per REST
 * endpoint the plugin needs. Kernel-protocol concerns live in `kernel.js`.
 *
 * @module dsh-jupyterlab/server
 */

import { createLookup } from './dns-cache.js'
import { combineSignals, httpRequest } from './transport.js'

/** Path segments JupyterLab/Notebook insert between the server root and its API. */
const APP_SEGMENTS = new Set([
  'lab', 'tree', 'notebooks', 'edit', 'terminals', 'consoles', 'files', 'nbclassic', 'voila', 'doc', 'retro',
])

/**
 * Stable failure codes surfaced through `HarnessError.info.code` when thrown from a tool.
 * @readonly
 * @enum {string}
 */
export const JUPYTER_ERROR_CODES = {
  INVALID_URL: 'JUPYTER_INVALID_URL',
  NOT_CONFIGURED: 'JUPYTER_NOT_CONFIGURED',
  UNREACHABLE: 'JUPYTER_UNREACHABLE',
  NOT_JUPYTER: 'JUPYTER_NOT_A_SERVER',
  AUTH: 'JUPYTER_AUTH_FAILED',
  HTTP: 'JUPYTER_HTTP_ERROR',
  NOT_FOUND: 'JUPYTER_NOT_FOUND',
  KERNEL_GONE: 'JUPYTER_KERNEL_GONE',
  DISCONNECTED: 'JUPYTER_DISCONNECTED',
  TIMEOUT: 'JUPYTER_TIMEOUT',
}

/** An error whose `code` is one of {@link JUPYTER_ERROR_CODES}. */
export class JupyterError extends Error {
  /**
   * @param message - Human-readable, model-facing failure description.
   * @param code - Stable machine-routing code.
   * @param options - Optional HTTP status and a lower-level cause.
   */
  constructor(message, code = JUPYTER_ERROR_CODES.HTTP, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JupyterError'
    this.code = code
    /** HTTP status that produced this failure, when one was involved. */
    this.status = options.status
  }
}

/**
 * Turn any user-supplied JupyterLab address into the origin + base path of the Jupyter Server,
 * and recover a token embedded in the URL (the form `jupyter server list` prints).
 *
 * Accepts `http://host:9002/lab`, `http://host:9002/lab/tree/x.ipynb`, `host:9002`,
 * `http://host/jupyter/lab?token=abc`, and a bare origin.
 *
 * @param input - Address as typed by the user.
 * @returns The normalized base URL (no trailing slash) and any embedded token.
 * @throws {JupyterError} When the address cannot be parsed as an http(s) URL.
 */
export function normalizeJupyterUrl(input) {
  const raw = String(input ?? '').trim()
  if (raw.length === 0) {
    throw new JupyterError('jupyter: the server address is empty.', JUPYTER_ERROR_CODES.INVALID_URL)
  }
  let url
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`)
  } catch (error) {
    throw new JupyterError(`jupyter: "${raw}" is not a valid URL (expected e.g. http://host:9002/lab).`, JUPYTER_ERROR_CODES.INVALID_URL, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new JupyterError(`jupyter: unsupported protocol "${url.protocol}" — use http or https.`, JUPYTER_ERROR_CODES.INVALID_URL)
  }
  const token = url.searchParams.get('token') ?? undefined
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  const appIndex = segments.findIndex((segment) => APP_SEGMENTS.has(segment))
  // Everything from the first application segment on belongs to the UI, not the API root.
  if (appIndex !== -1) segments.length = appIndex
  const basePath = segments.length > 0 ? `/${segments.join('/')}` : ''
  return { baseUrl: `${url.protocol}//${url.host}${basePath}`, token }
}

/**
 * A REST client bound to one Jupyter Server address and credential set.
 *
 * Instances are cheap; `runtime.js` recreates one whenever the address or credentials change.
 */
export class JupyterServerClient {
  /** Session cookies replayed on every request, keyed by cookie name. */
  #cookies = new Map()
  /** Whether {@link JupyterServerClient#ensureLoggedIn} already succeeded. */
  #loggedIn = false
  /** In-flight login, so concurrent tool calls share one `/login` round trip. */
  #loginPromise

  /**
   * @param options - Connection settings.
   * @param options.url - JupyterLab address as typed by the user.
   * @param options.token - API token; takes precedence over `password`.
   * @param options.password - Login password (hashed server-side by Jupyter).
   * @param options.username - Username sent with a password login; Jupyter usually ignores it.
   * @param options.cookie - Raw `Cookie` header value for an SSO/access proxy in front of Jupyter.
   * @param options.requestTimeoutMs - Per-request budget for REST calls.
   */
  constructor({ url, token, password, username, cookie, requestTimeoutMs = 20000 } = {}) {
    const { baseUrl, token: embeddedToken } = normalizeJupyterUrl(url)
    /** Normalized server root, e.g. `http://host:9002`. */
    this.baseUrl = baseUrl
    /** Token credential, if any. */
    this.token = nonEmpty(token) ?? embeddedToken
    /** Password credential, if any. */
    this.password = nonEmpty(password)
    /** Username presented during a password login. */
    this.username = nonEmpty(username) ?? 'dsh'
    /**
     * Raw `Cookie` header for an SSO/access proxy, when one was supplied.
     *
     * Kept separately from the jar so the WebSocket upgrade and every REST call can seed from it,
     * and so `reconfigure()` can tell "no proxy cookie" from "an empty jar after a login".
     */
    this.cookie = nonEmpty(cookie)
    /** REST timeout budget in milliseconds. */
    this.requestTimeoutMs = requestTimeoutMs
    /** Name resolution for REST calls *and* kernel channels; the cache is process-wide. */
    this.lookup = createLookup()
    if (this.cookie !== undefined) this.#seedCookies(this.cookie)
    if (this.token === undefined && this.password === undefined && this.cookie === undefined) {
      throw new JupyterError(
        `jupyter: no credentials for ${this.baseUrl}. In the notebook panel open the connection `
        + 'list, press Edit on this connection and add a password, a token or the browser Cookie '
        + 'header (a proxied deployment wants the Cookie); or set the plugin "token" / "password" / '
        + '"cookie" option. A full URL from `jupyter server list` also carries ?token=...',
        JUPYTER_ERROR_CODES.AUTH,
      )
    }
  }

  /** How this client authenticates, for display in tool output. */
  get authMode() {
    if (this.token !== undefined) return 'token'
    if (this.password !== undefined) return 'password'
    if (this.cookie !== undefined) return 'cookie'
    return 'none'
  }

  /**
   * Build an absolute API URL.
   * @param path - API path beginning with `/api/...`.
   * @returns The absolute URL.
   */
  apiUrl(path) {
    return `${this.baseUrl}${path}`
  }

  /**
   * Describe the WebSocket upgrade target for a kernel channel.
   *
   * The token rides both the query string and the `Authorization` header, because reverse
   * proxies in front of Jupyter sometimes drop one or the other; the session cookie is added
   * for password-authenticated servers.
   *
   * @param path - API path beginning with `/api/...`.
   * @returns The absolute `ws(s)://` URL, the headers to send with the upgrade, and the lookup to
   *   connect through — the channel socket must resolve through the same cache as the REST calls,
   *   or opening a kernel costs one `getaddrinfo` (five seconds on a mDNS name) per handshake.
   */
  wsTarget(path) {
    const url = new URL(this.apiUrl(path))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const headers = {}
    if (this.token !== undefined) {
      url.searchParams.set('token', this.token)
      headers.authorization = `token ${this.token}`
    }
    if (this.#cookies.size > 0) headers.cookie = this.#cookieHeader()
    return { url: url.toString(), headers, lookup: this.lookup }
  }

  /** Serialize the cookie jar into a `Cookie` header value. */
  #cookieHeader() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  /**
   * Seed the jar from a pasted `Cookie` header.
   *
   * The value is whatever the browser sent, so it may be one pair or a dozen, may be wrapped in
   * quotes, and may carry a leading `Cookie:` label if it was copied from a header pane. Names are
   * kept verbatim; a `=` inside a value is part of the value, not a second separator.
   *
   * @param header - Raw cookie header value.
   */
  #seedCookies(header) {
    const text = header.replace(/^\s*cookie\s*:\s*/i, '').replace(/\s+/g, ' ')
    for (const part of splitCookieHeader(text)) {
      const index = part.indexOf('=')
      if (index <= 0) continue
      const name = part.slice(0, index).trim()
      const value = part.slice(index + 1).trim().replace(/^"(.*)"$/, '$1')
      if (name.length === 0 || value.length === 0) continue
      this.#cookies.set(name, value)
    }
  }

  /** Absorb every `Set-Cookie` header of a response into the jar. */
  #absorbCookies(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';')
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
  }

  /**
   * Perform a request against the server, returning the raw response.
   *
   * @param path - API path beginning with `/api/...`.
   * @param init - Fetch options; `json` is serialized and content-typed automatically.
   * @param init.json - JSON request body.
   * @param init.signal - Optional caller cancellation.
   * @returns The raw fetch response, with status handling left to the caller.
   */
  async request(path, init = {}) {
    await this.ensureLoggedIn(init.signal)
    const { json, headers, ...rest } = init
    const merged = { ...headers }
    if (this.token !== undefined) merged.authorization = `token ${this.token}`
    if (this.#cookies.size > 0) merged.cookie = this.#cookieHeader()
    // Jupyter skips its XSRF check for header-authenticated (token) requests but enforces it for
    // cookie sessions, where every POST/DELETE must echo the `_xsrf` cookie as a header. Without
    // this, a password-authenticated session can read but never start a kernel.
    if (isMutating(rest.method)) {
      const xsrf = this.#cookies.get('_xsrf')
      if (xsrf !== undefined) merged['x-xsrftoken'] = xsrf
    }
    let body = rest.body
    if (json !== undefined) {
      merged['content-type'] = 'application/json'
      body = JSON.stringify(json)
    }
    try {
      const response = await httpRequest(this.apiUrl(path), {
        method: rest.method ?? 'GET',
        headers: merged,
        body,
        signal: init.signal,
        timeoutMs: this.requestTimeoutMs,
      })
      // An access proxy (and Jupyter itself) rotates its session cookie on some replies. Only a
      // successful reply may do that: an unauthenticated 302 carries a *fresh anonymous* cookie,
      // and absorbing it would throw away the one the user pasted.
      if (response.ok) this.#absorbCookies(response)
      return response
    } catch (error) {
      throw this.#mapTransportError(error, path)
    }
  }

  /**
   * Perform a request and decode a JSON body, mapping failures onto readable errors.
   *
   * @param path - API path beginning with `/api/...`.
   * @param init - Same options as {@link JupyterServerClient#request}.
   * @param init.allowStatus - HTTP statuses to accept instead of throwing.
   * @returns The decoded JSON body, or `undefined` for an accepted empty response.
   */
  async json(path, init = {}) {
    const { allowStatus = [], ...rest } = init
    const response = await this.request(path, rest)
    if (response.status === 404 && !allowStatus.includes(404)) {
      throw new JupyterError(
        `jupyter: ${this.baseUrl}${path} returned 404 — the address may point at something other than a Jupyter Server, or the resource is gone.`,
        JUPYTER_ERROR_CODES.NOT_FOUND,
        { status: 404 },
      )
    }
    if (!response.ok && !allowStatus.includes(response.status)) throw await this.#httpError(response, path)
    const text = await response.text()
    if (text.trim().length === 0) return undefined
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new JupyterError(
        `jupyter: ${this.baseUrl}${path} did not return JSON (got "${text.slice(0, 80).replace(/\s+/g, ' ')}…"). `
        + 'Check that the address is the Jupyter Server root, not another web application.',
        JUPYTER_ERROR_CODES.NOT_JUPYTER,
        { cause: error, status: response.status },
      )
    }
  }

  /** Convert a non-OK response into a {@link JupyterError} with a readable reason. */
  async #httpError(response, path) {
    // A redirect is the one failure whose *body* is useless: it is the proxy's login page. Say
    // where it pointed instead, because that is the difference between "wrong password" and
    // "your browser is signed in and this process is not".
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? ''
      let host = ''
      try {
        host = new URL(location).host
      } catch {
        // A relative or unparseable Location still means "somewhere else".
      }
      return new JupyterError(
        `jupyter: ${this.baseUrl}${path} was redirected (HTTP ${response.status}${host ? ` to ${host}` : ''}) — `
        + 'the request never reached Jupyter, so this is an SSO/access proxy in front of it rather than a '
        + 'wrong credential. If the address opens in your browser, copy that request\'s Cookie header into '
        + 'the connection\'s "proxy cookie" field; otherwise use an address that is reachable directly.',
        JUPYTER_ERROR_CODES.AUTH,
        { status: response.status },
      )
    }
    const body = await response.text().catch(() => '')
    const detail = body.slice(0, 300).replace(/\s+/g, ' ').trim()
    if (response.status === 403 && /_xsrf/i.test(detail)) {
      return new JupyterError(
        `jupyter: ${this.baseUrl}${path} was rejected by the server's XSRF check (HTTP 403). `
        + 'The session cookie was accepted but the request carried no usable XSRF token — retry, '
        + 'and check that this Jupyter deployment does not disable cookie authentication.',
        JUPYTER_ERROR_CODES.AUTH,
        { status: 403 },
      )
    }
    if (response.status === 401 || response.status === 403) {
      return new JupyterError(
        `jupyter: authentication failed at ${this.baseUrl} (HTTP ${response.status}). `
        + `The ${this.authMode} credential was rejected — check the "token"/"password" plugin option. `
        + `Server said: ${detail || 'Forbidden'}`,
        JUPYTER_ERROR_CODES.AUTH,
        { status: response.status },
      )
    }
    return new JupyterError(
      `jupyter: HTTP ${response.status} from ${this.baseUrl}${path}${detail ? ` — ${detail}` : ''}`,
      JUPYTER_ERROR_CODES.HTTP,
      { status: response.status },
    )
  }

  /** Convert a thrown transport failure into a {@link JupyterError}. */
  #mapTransportError(error, path) {
    if (error instanceof JupyterError) return error
    const timedOut = error?.name === 'TimeoutError'
      || error?.name === 'AbortError'
      || error?.code === 'ABORT_ERR'
    if (timedOut) {
      return new JupyterError(
        `jupyter: ${this.baseUrl}${path} timed out after ${this.requestTimeoutMs}ms.`,
        JUPYTER_ERROR_CODES.TIMEOUT,
        { cause: error },
      )
    }
    const cause = error?.cause ?? error
    const code = typeof cause?.code === 'string' ? ` (${cause.code})` : ''
    const hint = cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN'
      ? ` The name "${new URL(this.baseUrl).hostname}" does not resolve from this machine — try the address Jupyter prints, or add the host to ~/.dsh settings with its IP.`
      : ' Check the address, that the server is running, and that this machine can route to it.'
    return new JupyterError(
      `jupyter: cannot reach ${this.baseUrl}${path} — ${cause?.message ?? error?.message ?? 'network error'}${code}.${hint}`,
      JUPYTER_ERROR_CODES.UNREACHABLE,
      { cause: error },
    )
  }

  /**
   * Complete the `/login` form flow when password credentials are configured.
   *
   * Tokens skip this entirely.
   *
   * Two details make this work against a default (XSRF-protected) server, and both were learned
   * the hard way:
   *
   * - The `_xsrf` cookie **must travel with the POST**. Jupyter compares the submitted `_xsrf`
   *   form field against the `_xsrf` *cookie*; posting the field without the cookie is rejected
   *   with 403 no matter how correct the password is. A server started with `disable_check_xsrf`
   *   accepts it anyway, which is exactly how such a bug survives a test suite.
   * - A rejected password is **401**, not 403. The two are reported differently so that "wrong
   *   password" never masquerades as a broken login flow.
   *
   * @param signal - Optional caller cancellation.
   */
  async ensureLoggedIn(signal) {
    if (this.token !== undefined || this.#loggedIn) return
    if (this.password === undefined) {
      // A proxy cookie can be the whole credential: the proxy authenticated the request and the
      // Jupyter behind it runs without a token/password of its own.
      if (this.cookie !== undefined) return
      throw new JupyterError('jupyter: no token, password or proxy cookie configured.', JUPYTER_ERROR_CODES.AUTH)
    }
    this.#loginPromise ??= (async () => {
      const page = await httpRequest(`${this.baseUrl}/login`, {
        headers: { accept: 'text/html', ...this.#cookieHeaders() },
        signal,
        timeoutMs: this.requestTimeoutMs,
      })
      this.#absorbCookies(page)
      const html = await page.text().catch(() => '')
      const xsrf = this.#cookies.get('_xsrf') ?? /name=["']_xsrf["'][^>]*value=["']([^"']+)["']/.exec(html)?.[1]
      const form = new URLSearchParams()
      if (xsrf !== undefined) form.set('_xsrf', xsrf)
      form.set('password', this.password)
      form.set('username', this.username)
      const login = await httpRequest(`${this.baseUrl}/login?next=%2F`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...this.#cookieHeaders() },
        body: form.toString(),
        signal,
        timeoutMs: this.requestTimeoutMs,
      })
      this.#absorbCookies(login)
      if (login.status === 401) {
        throw new JupyterError(
          `jupyter: the password for ${this.baseUrl} was rejected (HTTP 401). Check the "password" plugin option.`,
          JUPYTER_ERROR_CODES.AUTH,
          { status: 401 },
        )
      }
      if (login.status === 403) {
        throw new JupyterError(
          `jupyter: the login to ${this.baseUrl} was rejected by the server's XSRF check (HTTP 403). `
          + 'The XSRF cookie was missing or stale — retry, and check that the server accepts cookie logins.',
          JUPYTER_ERROR_CODES.AUTH,
          { status: 403 },
        )
      }
      if (login.status >= 400) {
        throw new JupyterError(
          `jupyter: password login to ${this.baseUrl} failed with HTTP ${login.status}.`,
          JUPYTER_ERROR_CODES.AUTH,
          { status: login.status },
        )
      }
      // Some deployments redirect back to the form with an error flag instead of a status code.
      if (/[?&]error=/.test(login.headers.get('location') ?? '')) {
        throw new JupyterError(
          `jupyter: the password for ${this.baseUrl} was rejected. Check the "password" plugin option.`,
          JUPYTER_ERROR_CODES.AUTH,
          { status: login.status },
        )
      }
      this.#loggedIn = true
    })().finally(() => { this.#loginPromise = undefined })
    return this.#loginPromise
  }

  /** Cookie header for an outbound request, or an empty object when the jar is empty. */
  #cookieHeaders() {
    return this.#cookies.size > 0 ? { cookie: this.#cookieHeader() } : {}
  }

  /**
   * Reset cached credentials state after a configuration change.
   * @param patch - Credential fields to replace.
   */
  reconfigure(patch) {
    if ('token' in patch) this.token = nonEmpty(patch.token) ?? this.token
    if ('cookie' in patch) {
      this.cookie = nonEmpty(patch.cookie)
      this.#loggedIn = false
      this.#cookies.clear()
      if (this.cookie !== undefined) this.#seedCookies(this.cookie)
    }
    if ('password' in patch) {
      this.password = nonEmpty(patch.password)
      this.#loggedIn = false
      this.#cookies.clear()
      if (this.cookie !== undefined) this.#seedCookies(this.cookie)
    }
  }

  /** `GET /api/status` — liveness plus connection and kernel counters. */
  async status(signal) {
    return await this.json('/api/status', { signal })
  }

  /** `GET /api/status` — server version string, when the deployment exposes it. */
  async version(signal) {
    const body = await this.json('/api/status', { signal })
    return body?.version ?? undefined
  }

  /** `GET /api/kernelspecs` — installed kernelspecs keyed by name. */
  async kernelspecs(signal) {
    const body = await this.json('/api/kernelspecs', { signal })
    return Object.keys(body?.kernelspecs ?? {}).sort()
  }

  /** `GET /api/kernels` — every kernel the server currently tracks. */
  async listKernels(signal) {
    const body = await this.json('/api/kernels', { signal })
    return Array.isArray(body) ? body : []
  }

  /**
   * `GET /api/kernels/{id}`.
   * @returns The kernel model, or `undefined` when it no longer exists.
   */
  async getKernel(kernelId, signal) {
    return await this.json(`/api/kernels/${encodeURIComponent(kernelId)}`, { signal, allowStatus: [404] })
  }

  /**
   * `POST /api/kernels` — start a new kernel.
   * @param options - Kernel name and optional server-relative working directory.
   */
  async startKernel({ name, path } = {}, signal) {
    const body = { name }
    if (path !== undefined && path !== '') body.path = path
    return await this.json('/api/kernels', { method: 'POST', json: body, signal })
  }

  /**
   * `POST /api/kernels/{id}/restart` — restart the kernel process, keeping the kernel id.
   * @param kernelId - Kernel to restart.
   */
  async restartKernel(kernelId, signal) {
    return await this.json(`/api/kernels/${encodeURIComponent(kernelId)}/restart`, { method: 'POST', signal })
  }

  /**
   * `POST /api/kernels/{id}/interrupt` — interrupt the running cell.
   * @param kernelId - Kernel to interrupt.
   */
  async interruptKernel(kernelId, signal) {
    return await this.json(`/api/kernels/${encodeURIComponent(kernelId)}/interrupt`, { method: 'POST', signal, allowStatus: [404] })
  }

  /**
   * `DELETE /api/kernels/{id}` — shut the kernel down. A 404 counts as success.
   * @param kernelId - Kernel to shut down.
   */
  async shutdownKernel(kernelId, signal) {
    const response = await this.request(`/api/kernels/${encodeURIComponent(kernelId)}`, { method: 'DELETE', signal })
    if (response.status === 404) return false
    if (!response.ok) throw await this.#httpError(response, `/api/kernels/${kernelId}`)
    return true
  }
}

/**
 * Whether an HTTP method changes server state, and so needs an XSRF token on a cookie session.
 *
 * @param method - Request method, defaulting to GET.
 * @returns True for anything other than the safe read methods.
 */
function isMutating(method) {
  const normalized = String(method ?? 'GET').toUpperCase()
  return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS'
}

/** Normalize an optional credential string, treating blank input as absent. */
function nonEmpty(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text.length > 0 ? text : undefined
}

/**
 * Split a pasted `Cookie` header into its `name=value` parts.
 *
 * A request `Cookie` header is `;`-separated; commas inside an `Expires` value only appear in
 * `Set-Cookie`, which this never parses. Empty parts are dropped so a trailing `;` is harmless.
 *
 * @param text - Cookie header value.
 * @returns The trimmed parts.
 */
function splitCookieHeader(text) {
  return String(text ?? '').split(';').map((part) => part.trim()).filter((part) => part.length > 0)
}

/**
 * Compose an optional caller signal with a request deadline.
 *
 * Re-exported from the transport layer so existing importers keep their entry point.
 */
export { combineSignals }
