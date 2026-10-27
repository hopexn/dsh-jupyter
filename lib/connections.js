/**
 * The set of Jupyter servers one session may be connected to at the same time.
 *
 * Before this module there was exactly one address in the runtime and `jupyter_connect` replaced
 * it. A session now keeps a *registry*: several servers, each with its own credentials, and the
 * panel's pages choose which of them a run reaches. Two rules shape everything below:
 *
 * 1. **A credential belongs to the host it was entered for.** A link is created for one server
 *    key and its token/password never travel to another link, so adding a second connection can
 *    never disclose the first one's secret.
 * 2. **The key is the identity.** `serverKey(url)` — the normalized base URL, e.g.
 *    `http://host:9002` — is the registry key, what a notebook page stores, and what the tools
 *    accept. Every URL spelling resolves through the same normalization, so a user may paste
 *    `/lab`, a trailing slash or a `?token=...` address and still reach the same connection.
 *
 * Persistence is deliberately small: one JSON file (`$DSH_HOME/jupyterlab/servers.json`, mode
 * `0600`) written atomically, only when the set of connections changes. It holds what someone
 * added **at run time** (the panel's form, `jupyter_connect`); a connection that comes from the
 * profile config stays config-owned and is never mirrored, because the config is re-applied on
 * every boot and would otherwise be shadowed by a stale copy (removing it from the config would
 * then silently keep it connected). A corrupt or unreadable file is an empty registry — a broken
 * config file must not keep the plugin from loading.
 *
 * @module dsh-jupyterlab/connections
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { JUPYTER_ERROR_CODES, JupyterError, JupyterServerClient, normalizeJupyterUrl } from './server.js'
import { resolveHost } from './dns-cache.js'

/** Settings keys a per-server override may replace. */
const OVERRIDABLE = [
  'url', 'name', 'token', 'password', 'username', 'cookie', 'kernelName', 'workingDirectory',
  'requestTimeoutMs', 'executeTimeoutMs', 'autoStartKernel', 'maxOutputChars', 'artifactDirectory',
]

/** Settings keys bound to the server they authenticate against. */
const CREDENTIALS = ['token', 'password', 'username', 'cookie']

/** Fields a new link inherits from the plugin config; credentials are never inherited. */
const INHERITED = [
  'kernelName', 'workingDirectory', 'requestTimeoutMs', 'executeTimeoutMs',
  'autoStartKernel', 'maxOutputChars', 'artifactDirectory',
]

/**
 * Fields written to `servers.json`: everything else comes from the config on every boot.
 *
 * The proxy/SSO `cookie` **is** written, like every other credential: a user who connected once
 * should not have to paste a browser header after every app restart. The file is `0600` and
 * atomically replaced; a cookie that has expired server-side simply fails the next request with
 * the readable 302/401, and pasting a fresh one replaces it.
 */
const PERSISTED = ['url', 'name', 'token', 'password', 'username', 'cookie', 'kernelName', 'workingDirectory']

/**
 * The token embedded in an address as `?token=...`, if any.
 *
 * @param url - A user-supplied Jupyter address.
 * @returns The embedded token, or undefined when there is none or the address is unparseable.
 */
function tokenIn(url) {
  try {
    return normalizeJupyterUrl(url).token
  } catch {
    return undefined
  }
}

/**
 * Whether two addresses denote the same Jupyter server.
 *
 * @param left - Current address.
 * @param right - Candidate address.
 * @returns True when both normalize to the same origin and base path.
 */
function sameServer(left, right) {
  try {
    return normalizeJupyterUrl(left).baseUrl === normalizeJupyterUrl(right).baseUrl
  } catch {
    return left === right
  }
}

/**
 * Pick the fields of a patch that are actually meant to replace something.
 *
 * Blank strings mean "not supplied", not "clear this": the panel's connection form sends only the
 * inputs the user filled in, and an empty token must not wipe the one already stored.
 *
 * @param patch - Raw settings patch.
 * @returns A plain object with only meaningful values.
 */
function selectSettings(patch = {}) {
  const selected = {}
  if (patch === null || typeof patch !== 'object') return selected
  for (const key of OVERRIDABLE) {
    const value = patch[key]
    if (value === undefined || value === null) continue
    if (key === 'autoStartKernel') {
      if (typeof value === 'boolean') selected[key] = value
      continue
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value) && value > 0) selected[key] = value
      continue
    }
    const text = String(value).trim()
    if (text.length > 0) selected[key] = text
  }
  return selected
}

/** Keep just the named keys of a settings object. */
function pick(source, keys) {
  const selected = {}
  for (const key of keys) {
    if (source?.[key] !== undefined) selected[key] = source[key]
  }
  return selected
}

/**
 * Coerce the plugin config into the runtime's internal settings shape.
 *
 * This is the shape the single-server runtime used to own; it lives here now because a
 * {@link ServerLink} is the thing that needs it. Per-server entries inherit the non-credential
 * fields from this base, never the credentials.
 *
 * @param config - Raw plugin config as validated by the `Config` schema.
 * @returns A settings object with every field present and typed.
 */
export function normalizeServerSettings(config = {}) {
  const text = (value) => {
    if (value === undefined || value === null) return undefined
    const trimmed = String(value).trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  const positive = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : fallback
  }
  return {
    url: text(config.url),
    /** A short label the panel shows instead of the raw address. */
    name: text(config.name),
    token: text(config.token),
    password: text(config.password),
    username: text(config.username),
    /** A pasted proxy/SSO Cookie header; a credential, so it never leaves the host side. */
    cookie: text(config.cookie),
    kernelName: text(config.kernelName) ?? 'python3',
    workingDirectory: text(config.workingDirectory),
    requestTimeoutMs: positive(config.requestTimeoutMs, 20000),
    executeTimeoutMs: positive(config.executeTimeoutMs, 180000),
    autoStartKernel: config.autoStartKernel !== false,
    maxOutputChars: positive(config.maxOutputChars, 20000),
    artifactDirectory: text(config.artifactDirectory),
  }
}

/**
 * The stable identity of a Jupyter server: its normalized base URL.
 *
 * @param url - Any spelling of a Jupyter address.
 * @returns The normalized base URL, e.g. `http://host:9002`.
 * @throws {JupyterError} With `JUPYTER_INVALID_URL` when the address cannot be parsed.
 */
export function serverKey(url) {
  return normalizeJupyterUrl(url).baseUrl
}

/**
 * A short human label for a server: `host[:port][/path]`, without the scheme.
 *
 * @param url - Any spelling of a Jupyter address.
 * @returns The label shown in the panel's server picker.
 */
export function serverLabel(url) {
  const parsed = new URL(serverKey(url))
  const suffix = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')
  return `${parsed.host}${suffix}`
}

/**
 * One configured connection: settings plus a lazily built REST client.
 *
 * Construction is local and synchronous; a link with no credentials is perfectly valid. The
 * "no credentials" failure deliberately waits until `client()` is called, so a panel can list a
 * half-configured connection and its describe list still works.
 */
export class ServerLink {
  /** @type {ReturnType<typeof normalizeServerSettings>} */
  #settings
  /** Normalized base URL; the identity used by the registry. */
  #key
  /** @type {JupyterServerClient|undefined} */
  #client
  /** Identity of {@link ServerLink#client}; a change rebuilds it. */
  #clientKey

  /**
   * @param settings - Normalized or raw settings; `url` is required.
   * @throws {JupyterError} When the address is empty or unparseable.
   */
  constructor(settings = {}) {
    this.#settings = normalizeServerSettings(settings)
    this.#key = serverKey(this.#settings.url)
    // An address pasted from `jupyter server list` carries its own token. Folding it into the
    // settings means `authMode`/`hasCredentials` describe that address correctly before any client
    // is built — and it takes precedence over a stale token passed alongside it, as before.
    const embedded = tokenIn(this.#settings.url)
    if (embedded !== undefined) this.#settings.token = embedded
  }

  /** The normalized base URL — registry key, page binding and tool argument. */
  get key() {
    return this.#key
  }

  /** The normalized base URL, for callers that say "the server's url" rather than "key". */
  get url() {
    return this.#key
  }

  /** A copy of this link's settings. Contains credentials — host-side use only. */
  get settings() {
    return { ...this.#settings }
  }

  /** How this connection authenticates, without constructing a client. */
  get authMode() {
    if (this.#settings.token !== undefined) return 'token'
    if (this.#settings.password !== undefined) return 'password'
    // A pasted proxy/SSO cookie can be the whole credential: the proxy authenticates the request
    // and the Jupyter behind it needs no token of its own.
    if (this.#settings.cookie !== undefined) return 'cookie'
    return 'none'
  }

  /**
   * The REST client for this connection, built on first use.
   *
   * @returns A memoized client bound to this server and its credentials.
   * @throws {JupyterError} When the connection has no credentials yet.
   */
  client() {
    const identity = this.#identity()
    if (this.#client === undefined || this.#clientKey !== identity) {
      this.#client = new JupyterServerClient({
        url: this.#settings.url,
        token: this.#settings.token,
        password: this.#settings.password,
        username: this.#settings.username,
        cookie: this.#settings.cookie,
        requestTimeoutMs: this.#settings.requestTimeoutMs,
      })
      this.#clientKey = identity
    }
    return this.#client
  }

  /** Everything about client construction that a change must invalidate. */
  #identity() {
    const { url, token, password, username, cookie, requestTimeoutMs } = this.#settings
    return [url, token ?? '', password ?? '', username ?? '', cookie ?? '', requestTimeoutMs].join('\u0000')
  }

  /**
   * Merge a settings patch into this link.
   *
   * A change of address to a *different* server drops the previous credentials unless the same
   * patch supplies replacements: a credential belongs to the host it was entered for. The client
   * is rebuilt only when its identity actually changed, so updating a kernel name keeps the cookie
   * jar of a password login alive.
   *
   * @param patch - Fields to replace; blank values are ignored.
   * @returns This link, for chaining.
   */
  update(patch = {}) {
    const provided = selectSettings(patch)
    if (provided.url !== undefined) {
      const embedded = tokenIn(provided.url)
      if (embedded !== undefined) provided.token = embedded
    }
    const next = { ...this.#settings }
    if (provided.url !== undefined && this.#settings.url !== undefined && !sameServer(this.#settings.url, provided.url)) {
      for (const key of CREDENTIALS) {
        if (provided[key] === undefined) delete next[key]
      }
    }
    Object.assign(next, provided)
    this.#settings = normalizeServerSettings(next)
    this.#key = serverKey(this.#settings.url)
    // Only a *changed identity* invalidates the client; updating a kernel name or the default
    // working directory must keep a password session's cookie jar alive.
    if (this.#client !== undefined && this.#clientKey !== this.#identity()) {
      this.#client = undefined
      this.#clientKey = undefined
    }
    return this
  }

  /** The panel-safe description of this connection; never carries a credential. */
  describe() {
    const description = {
      key: this.#key,
      url: this.#key,
      label: serverLabel(this.#key),
      authMode: this.authMode,
      hasCredentials: this.authMode !== 'none',
      kernelName: this.#settings.kernelName,
    }
    // The panel shows the name when there is one; the URL stays for the title attribute and for
    // tools that need the real address. Omitted rather than null so a plain connection stays small.
    if (this.#settings.name !== undefined) description.name = this.#settings.name
    // Omitted rather than present-but-undefined: the describe list is a tool output, and a value
    // that JSON would silently drop is not lossless JSON.
    if (this.#settings.workingDirectory !== undefined) description.workingDirectory = this.#settings.workingDirectory
    return description
  }

  /**
   * Resolve the host in the background so the first call does not pay for a mDNS lookup.
   *
   * A mDNS name costs about five seconds to resolve *once*; doing it when the connection is added
   * (or at mount) moves that cost off the first execution's critical path.
   */
  prewarm() {
    try {
      const host = new URL(this.#key).hostname
      resolveHost(host).catch(() => {})
    } catch {
      // An unusable address is reported by the first call that needs it, with a better message.
    }
  }

  /** Drop the memoized client. The kernel channels belong to the runtime, not to this link. */
  dispose() {
    this.#client = undefined
    this.#clientKey = undefined
  }
}

/** Absolute path of the persisted connection list. */
function serversPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'jupyterlab', 'servers.json')
}

/** Read the persisted connections; a corrupt file is an empty list. */
function readServersFile() {
  try {
    const parsed = JSON.parse(readFileSync(serversPath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return { defaultKey: undefined, servers: [] }
    const servers = Array.isArray(parsed.servers)
      ? parsed.servers.filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        && typeof entry.url === 'string' && entry.url.trim().length > 0)
      : []
    const defaultKey = typeof parsed.default === 'string' && parsed.default.length > 0 ? parsed.default : undefined
    return { defaultKey, servers }
  } catch {
    // Missing, unreadable or corrupt: start empty. A broken file must not prevent the plugin from
    // loading, and the next write replaces it.
    return { defaultKey: undefined, servers: [] }
  }
}

/**
 * The registry of servers one runtime is connected to.
 *
 * Load order is fixed: the persisted file first (so a panel-added connection survives a restart),
 * then `config.servers` in order, then the single `config.url` fields — that last one also becomes
 * the default, preserving the old single-server configuration. A later entry for the same key
 * overrides the earlier credentials.
 */
export class ServerRegistry {
  /** @type {Map<string, ServerLink>} Keyed by normalized base URL. */
  #links = new Map()
  /** Key of the default connection. */
  #defaultKey
  /** Non-credential settings every new link inherits. */
  #base
  /**
   * Keys that came from the profile config and are therefore never written to `servers.json`.
   *
   * The config is re-applied on every boot; mirroring its entries would let a removed config
   * connection outlive its own removal, and would write a credential to a second plaintext file
   * for no benefit. A key leaves this set as soon as something adds or updates it at run time —
   * that is a deliberate override, and it belongs in the persisted list.
   *
   * @type {Set<string>}
   */
  #configKeys = new Set()
  /** Optional Cordis logger for diagnostics. */
  #logger

  /**
   * @param config - Plugin config (including `servers` and the single-server `url` fields).
   * @param options - Optional logger.
   * @param options.logger - Cordis logger; only server keys are logged, never credentials.
   */
  constructor(config = {}, { logger } = {}) {
    this.#logger = logger
    this.#base = normalizeServerSettings(config)

    const persisted = readServersFile()
    for (const entry of persisted.servers) {
      try {
        this.#apply(entry, { persist: false, source: 'persisted' })
      } catch {
        // One bad entry must not drop the rest.
      }
    }
    if (persisted.defaultKey !== undefined && this.#links.has(this.#defaultKeyFor(persisted.defaultKey))) {
      this.#defaultKey = this.#defaultKeyFor(persisted.defaultKey)
    } else if (this.#defaultKey === undefined && this.#links.size > 0) {
      this.#defaultKey = this.#links.keys().next().value
    }

    for (const entry of Array.isArray(config?.servers) ? config.servers : []) {
      try {
        this.#apply(entry, { persist: false, source: 'config' })
      } catch {
        // Config validation reports malformed entries; a bad one must not prevent the rest.
      }
    }

    // The single-server configuration keeps its old meaning: that address is the default.
    if (this.#base.url !== undefined) {
      const fields = pick(this.#base, ['url', 'name', ...CREDENTIALS, 'kernelName', 'workingDirectory'])
      const { link } = this.#apply(fields, { persist: false, source: 'config' })
      this.#defaultKey = link.key
    } else if (this.#defaultKey === undefined && this.#links.size > 0) {
      this.#defaultKey = this.#links.keys().next().value
    }
  }

  /** Normalize a persisted default the same way live keys are, tolerating an old spelling. */
  #defaultKeyFor(spelling) {
    try {
      const key = serverKey(spelling)
      if (this.#links.has(key)) return key
    } catch {
      // Fall through to a direct match.
    }
    return spelling
  }

  /**
   * Create one connection from a settings patch, or update the existing one for the same key.
   *
   * @param patch - At least `url` for a new connection; without one it updates the default.
   * @param options - Internal controls.
   * @param options.persist - Whether to write `servers.json` (construction passes false).
   * @param options.source - Where the entry came from: `'config'` entries are never mirrored,
   *   `'runtime'` (the panel or a tool) wins and is persisted, `'persisted'` keeps its current
   *   ownership.
   * @returns The link plus whether it was newly created.
   * @throws {JupyterError} When there is no default connection to update.
   */
  #apply(patch, { persist = false, source = 'runtime' } = {}) {
    const fields = selectSettings(patch)
    let link
    let created = false
    if (fields.url === undefined) {
      link = this.#defaultKey === undefined ? undefined : this.#links.get(this.#defaultKey)
      if (link === undefined) {
        throw new JupyterError(
          'jupyter: no server address is configured. Call jupyter_connect with the JupyterLab address '
          + '(for example http://host:9002/lab), or set the "url" option in this plugin\'s config.',
          JUPYTER_ERROR_CODES.NOT_CONFIGURED,
        )
      }
      link.update(fields)
    } else {
      const key = serverKey(fields.url)
      link = this.#links.get(key)
      if (link === undefined) {
        link = new ServerLink({ ...pick(this.#base, INHERITED), ...fields })
        this.#links.set(link.key, link)
        created = true
        if (this.#defaultKey === undefined) this.#defaultKey = link.key
        this.#logger?.info?.(`jupyterlab: connected to ${link.key}`)
      } else {
        link.update(fields)
      }
    }
    // Ownership decides the next write: a config entry is re-applied on every boot, a run-time
    // entry is the only thing the persisted file is for, and updating a config key by hand turns
    // it into a run-time entry (the person asked for exactly those credentials).
    if (source === 'config') this.#configKeys.add(link.key)
    else if (source === 'runtime') this.#configKeys.delete(link.key)
    if (persist) this.#persist()
    return { link, created }
  }

  /**
   * Add a connection, or update the one with the same key.
   *
   * The first connection added to an empty registry becomes the default.
   *
   * @param patch - Settings fields; `url` required unless there is a default to update.
   * @returns The resulting link and whether it was newly created.
   */
  add(patch = {}) {
    return this.#apply(patch, { persist: true })
  }

  /**
   * Remove a connection. Its kernel channels are the runtime's business, not the registry's.
   *
   * @param keyOrUrl - Connection key or any spelling of its address.
   * @returns The removed connection's key/url, and whether one was actually removed.
   */
  remove(keyOrUrl) {
    if (keyOrUrl === undefined || keyOrUrl === null || keyOrUrl === '') {
      return { key: undefined, url: undefined, removed: false }
    }
    let key
    try {
      key = serverKey(keyOrUrl)
    } catch {
      key = String(keyOrUrl)
    }
    const link = this.#links.get(key)
    if (link === undefined) {
      return { key, url: key, removed: false }
    }
    this.#links.delete(key)
    this.#configKeys.delete(key)
    if (this.#defaultKey === key) this.#defaultKey = this.#links.keys().next().value
    this.#persist()
    this.#logger?.info?.(`jupyterlab: disconnected from ${key}`)
    return { key, url: link.url, removed: true }
  }

  /**
   * Look a connection up without throwing.
   *
   * @param keyOrUrl - Connection key or any spelling of its address.
   * @returns The link, or undefined when this connection is not configured.
   */
  get(keyOrUrl) {
    if (keyOrUrl === undefined || keyOrUrl === null || keyOrUrl === '') return undefined
    try {
      return this.#links.get(serverKey(keyOrUrl))
    } catch {
      return undefined
    }
  }

  /**
   * Resolve a connection, defaulting to the registry's default when none is named.
   *
   * @param server - Connection key or URL spelling; omitted means the default.
   * @returns The resolved link.
   * @throws {JupyterError} With `JUPYTER_NOT_CONFIGURED` when nothing is configured or the named
   *   connection is unknown — the message lists what is connected so a typo is actionable.
   */
  resolve(server) {
    if (server === undefined || server === null || server === '') {
      const link = this.#defaultKey === undefined ? undefined : this.#links.get(this.#defaultKey)
      if (link !== undefined) return link
      throw new JupyterError(
        'jupyter: no Jupyter server is configured. Call jupyter_connect with the JupyterLab address '
        + '(for example http://host:9002/lab), or open the notebook panel and add a connection.',
        JUPYTER_ERROR_CODES.NOT_CONFIGURED,
      )
    }
    const link = this.get(server)
    if (link !== undefined) return link
    const known = [...this.#links.keys()]
    throw new JupyterError(
      `jupyter: "${String(server)}" is not a connected Jupyter server. `
      + `Connected: ${known.length > 0 ? known.join(', ') : 'none'}. `
      + 'Call jupyter_connect to add it, or use one of the connected addresses.',
      JUPYTER_ERROR_CODES.NOT_CONFIGURED,
    )
  }

  /** Every configured link, in the order they were added. */
  list() {
    return [...this.#links.values()]
  }

  /** Key of the default connection, or undefined when nothing is connected. */
  get defaultKey() {
    return this.#defaultKey
  }

  /**
   * Make one connection the default.
   *
   * @param server - Connection key or URL spelling.
   * @returns The key it was set to.
   * @throws {JupyterError} When the connection is unknown.
   */
  setDefault(server) {
    const link = this.resolve(server)
    if (this.#defaultKey !== link.key) {
      this.#defaultKey = link.key
      this.#persist()
    }
    return link.key
  }

  /** Panel-safe descriptions of every connection, with `default` merged in. */
  describe() {
    return this.list().map((link) => ({ ...link.describe(), default: link.key === this.#defaultKey }))
  }

  /** The default connection's settings, or the config defaults when nothing is connected. */
  settings() {
    const link = this.#defaultKey === undefined ? undefined : this.#links.get(this.#defaultKey)
    if (link !== undefined) return link.settings
    const defaults = normalizeServerSettings(this.#base)
    delete defaults.url
    return defaults
  }

  /**
   * Update the settings every new connection inherits (the `configure()` compatibility path).
   *
   * Credentials are intentionally not inherited by other links; passing one here only changes the
   * defaults used by a later `config.url`-style addition.
   *
   * @param patch - Global settings fields.
   */
  updateDefaults(patch = {}) {
    const provided = selectSettings(patch)
    this.#base = normalizeServerSettings({ ...this.#base, ...provided })
    const inherited = pick(provided, INHERITED)
    if (Object.keys(inherited).length > 0) {
      for (const link of this.#links.values()) link.update(inherited)
    }
  }

  /** Drop every link's client. Kernel channels and the persisted list are left alone. */
  dispose() {
    for (const link of this.#links.values()) link.dispose()
  }

  /**
   * Write the run-time connection list atomically, mode 0600: it contains credentials.
   *
   * Config-owned connections are deliberately left out — see {@link ServerRegistry#configKeys}.
   * The file can therefore be an empty list, which is correct: nothing was added at run time.
   */
  #persist() {
    try {
      const file = serversPath()
      mkdirSync(path.dirname(file), { recursive: true })
      const servers = this.list().filter((link) => !this.#configKeys.has(link.key)).map((link) => {
        const settings = link.settings
        // The canonical key, not the spelling it was typed with: the file is machine state, and a
        // later `?token=` or `/lab` in it would only make two entries for one server.
        const entry = { url: link.key }
        for (const key of PERSISTED) {
          if (key !== 'url' && settings[key] !== undefined) entry[key] = settings[key]
        }
        return entry
      })
      // A default that points at a config-owned link is not written either: the file cannot name a
      // connection it does not carry, and the config re-establishes its own default on every boot.
      const defaultKey = this.#defaultKey !== undefined && !this.#configKeys.has(this.#defaultKey)
        ? this.#defaultKey
        : null
      const payload = { default: defaultKey, servers }
      const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      writeFileSync(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, file)
      // `mode` only applies when the temporary file is created; enforce it once more so a file
      // created by an older build cannot keep a permissive mode after the rename.
      try {
        chmodSync(file, 0o600)
      } catch {
        // Best effort; the rename already used a private file.
      }
    } catch {
      // A read-only or missing home directory must not break connecting to a server.
    }
  }
}
