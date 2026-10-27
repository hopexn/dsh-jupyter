/**
 * Connection and kernel-session orchestration for the JupyterLab plugin.
 *
 * The runtime owns three things the tools above it should not have to think about:
 *
 * 1. **A registry of authenticated servers.** A session may be connected to several at once (a
 *    local one and a remote one), each with its own credentials; {@link ServerRegistry} builds the
 *    REST clients lazily, so a wrong or missing address never prevents the plugin from loading —
 *    it surfaces as a readable error on the first call that needs that server. Every method that
 *    talks to a server takes an optional `server` (a key or any URL spelling) and defaults to the
 *    registry's default connection.
 * 2. **One kernel per server, per DeepSeek Harness session.** The binding is memoized in memory
 *    (`'<serverKey>::<sessionId>'`) and mirrored to `$DSH_HOME/jupyterlab/kernels.json`, so a
 *    plugin remount or app restart re-attaches to the same kernel instead of silently starting a
 *    fresh one with no variables in it. The mirror key stays `'<url>::<sessionId>'` with the url
 *    being the normalized server key; keys written by the single-server build (a raw configured
 *    address) are still found on read and rewritten canonically on the next write.
 * 3. **Liveness checks before execution.** A kernel that died is detected and replaced before any
 *    code is sent, so "execute" never reports a confusing disconnect for a stale binding.
 *
 * Server identity and persistence live in `connections.js`; this module is the layer that binds
 * kernels, executes code and closes channels.
 *
 * @module dsh-jupyterlab/runtime
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { JUPYTER_ERROR_CODES, JupyterError } from './server.js'
import { KernelConnection } from './kernel.js'
import { ServerRegistry, serverKey } from './connections.js'

/**
 * Settings keys the compatibility `configure()` call may carry. Server-level settings are merged
 * into the connection by the registry; the rest update the defaults every connection inherits.
 */
const GLOBAL_SETTINGS = ['autoStartKernel', 'requestTimeoutMs', 'executeTimeoutMs', 'maxOutputChars', 'artifactDirectory']

/**
 * Reduce a Jupyter kernel model to the fields the tools report.
 *
 * @param model - Kernel model from the Jupyter REST API.
 * @returns A compact, JSON-safe kernel descriptor.
 */
export function summarizeKernel(model = {}) {
  const summary = {
    id: String(model.id ?? ''),
    name: String(model.name ?? 'unknown'),
    state: String(model.execution_state ?? model.state ?? 'unknown'),
  }
  if (typeof model.connections === 'number') summary.connections = model.connections
  if (typeof model.last_activity === 'string') summary.lastActivity = model.last_activity
  return summary
}

/**
 * Pick the server version out of whichever endpoint reported it.
 *
 * @param status - Body of `/api/status`, when it answered.
 * @param api - Body of `/api`, when it answered.
 * @returns The version string, or undefined when neither document carries one.
 */
function firstVersion(status, api) {
  for (const document of [status, api]) {
    if (typeof document?.version === 'string' && document.version.length > 0) return document.version
  }
  return undefined
}

/** The kernel id recorded for one session's binding, if the record is usable. */
function recordedKernelId(entry) {
  const id = entry?.kernelId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Manages the connected servers and one kernel binding per server per Harness session. */
export class JupyterRuntime {
  /** @type {ServerRegistry} */
  #registry
  /**
   * Live kernel bindings.
   * @type {Map<string, {kernelId: string, name: string, server: string, session: string, conn: KernelConnection}>}
   */
  #kernels = new Map()
  /** Short-lived kernel-status memo, keyed like {@link JupyterRuntime#kernels}. */
  #statuses = new Map()
  /** Optional Cordis logger for diagnostics. */
  #logger

  /**
   * @param config - Plugin config.
   * @param options - Optional logger.
   */
  constructor(config = {}, { logger } = {}) {
    this.#logger = logger
    this.#registry = new ServerRegistry(config, { logger })
    for (const link of this.#registry.list()) link.prewarm()
  }

  /** A copy of the default connection's settings. */
  get settings() {
    return this.#registry.settings()
  }

  /** The settings of one connection (default when `server` is omitted). */
  settingsFor(server) {
    return this.#registry.resolve(server).settings
  }

  /** Panel-safe descriptions of every connection, with `default` merged in. */
  servers() {
    return this.#registry.describe()
  }

  /** Key of the default connection, or undefined when nothing is configured. */
  defaultServer() {
    return this.#registry.defaultKey
  }

  /**
   * Make one connection the default.
   *
   * @param server - Connection key or URL spelling.
   * @returns The key it was set to.
   * @throws {JupyterError} When the connection is unknown.
   */
  setDefaultServer(server) {
    return this.#registry.setDefault(server)
  }

  /**
   * Add a connection (or update the one with the same key), as requested by the panel or a tool.
   *
   * The first connection added to an empty registry becomes the default; an existing default is
   * left alone, so adding a remote server does not silently move every unbound page onto it.
   *
   * @param patch - Settings fields; `url` required unless a default connection exists to update.
   * @returns The resulting link.
   */
  addServer(patch = {}) {
    const { link } = this.#registry.add(patch)
    link.prewarm()
    return link
  }

  /**
   * Remove a connection and everything the runtime still holds for it.
   *
   * Closes that server's kernel channels for **every** session (a channel to a server the user just
   * forgot must not stay attached) and drops its `kernels.json` entries. The kernels themselves
   * keep running on the server for a later re-attach, exactly like {@link JupyterRuntime#dispose}.
   *
   * @param server - Connection key or URL spelling.
   * @returns `{key, url, removed}`.
   */
  removeServer(server) {
    const result = this.#registry.remove(server)
    if (result.removed) this.#closeServer(result.key)
    return result
  }

  /**
   * Apply a runtime settings override, as issued by the `jupyter_connect` tool.
   *
   * Compatibility with the single-server build: the address in `patch.url` is added or updated and
   * becomes the default; other connections are left connected. Without a `url` the default
   * connection (or, on an empty registry, the inherited defaults) is updated.
   *
   * @param patch - Fields to replace.
   * @param options - Control over existing kernel bindings.
   * @param options.forgetKernels - Whether to unbind this server's session kernels first.
   * @returns The updated default settings.
   */
  configure(patch = {}, { forgetKernels = false } = {}) {
    const hasAddress = typeof patch?.url === 'string' && patch.url.trim().length > 0
    let link
    if (hasAddress || this.#registry.defaultKey !== undefined) {
      link = this.#registry.add(patch).link
      this.#registry.setDefault(link.key)
    } else {
      // No address anywhere yet: remember the settings (old behaviour) so a later url combines
      // with them instead of having to repeat the credential.
      this.#registry.updateDefaults(patch)
    }
    const globals = {}
    for (const key of GLOBAL_SETTINGS) {
      if (patch?.[key] !== undefined) globals[key] = patch[key]
    }
    if (Object.keys(globals).length > 0) this.#registry.updateDefaults(globals)
    if (forgetKernels && link !== undefined) this.#releaseServer(link.key)
    return this.settings
  }

  /**
   * The REST client for a connection (the default when `server` is omitted).
   *
   * @param server - Connection key or URL spelling.
   * @returns A lazily built, memoized client.
   * @throws {JupyterError} When that connection is not configured or has no credentials.
   */
  client(server) {
    return this.#registry.resolve(server).client()
  }

  /**
   * Read server identity plus every kernel it tracks.
   *
   * @param options - Target server and optional caller cancellation.
   * @param options.server - Connection key or URL spelling; defaults to the default connection.
   * @param options.signal - Optional caller cancellation.
   * @returns The server key, version, installed kernelspecs, and running kernels.
   */
  async probe({ server, signal } = {}) {
    const link = this.#registry.resolve(server)
    const client = link.client()
    const [status, kernelspecs, kernels, api] = await Promise.all([
      client.json('/api/status', { signal }),
      client.kernelspecs(signal),
      client.listKernels(signal),
      // `/api/status` carries no version on jupyter_server 2.x, and `/api/version` is a 404 on
      // those releases. `GET /api` does report it (`{"version": "2.21.1"}`), so that is the real
      // source; it is allowed to fail without failing the whole probe.
      client.json('/api', { signal }).catch(() => undefined),
    ])
    return {
      key: link.key,
      url: client.baseUrl,
      authMode: client.authMode,
      version: firstVersion(status, api),
      kernelspecs,
      kernels: kernels.map(summarizeKernel),
    }
  }

  /**
   * Resolve the session's kernel on one server, starting or re-attaching as needed.
   *
   * Order of preference: the live in-memory binding, the kernel id mirrored to disk (so a plugin
   * remount or app restart resumes the same kernel), then a freshly started kernel.
   *
   * @param sessionKey - Harness session id owning the kernel.
   * @param options - Resolution controls.
   * @param options.server - Connection key or URL spelling; defaults to the default connection.
   * @param options.forceNew - Shut the bound kernel down and start a fresh one.
   * @param options.signal - Optional caller cancellation.
   * @returns The live binding plus a note when it had to be re-established.
   */
  async ensureKernel(sessionKey, { server, forceNew = false, signal } = {}) {
    const link = this.#registry.resolve(server)
    const client = link.client()
    const binding = this.#binding(link.key, sessionKey)
    if (forceNew) await this.#shutdownBound(link.key, sessionKey)
    let entry = this.#kernels.get(binding)
    if (entry?.conn.isOpen === true) return { entry, note: undefined }

    const recordedId = recordedKernelId(entry) ?? this.#readState(link.key, sessionKey)
    if (recordedId !== undefined) {
      const model = await client.getKernel(recordedId, signal).catch(() => undefined)
      if (model?.id !== undefined) {
        const reusable = entry?.conn !== undefined && entry.kernelId === recordedId
          ? entry.conn
          : new KernelConnection({ server: client, kernelId: recordedId })
        try {
          await reusable.connect()
          entry = {
            kernelId: recordedId,
            name: String(model.name ?? link.settings.kernelName),
            server: link.key,
            session: sessionKey,
            conn: reusable,
          }
          this.#kernels.set(binding, entry)
          this.#writeState(link.key, sessionKey, entry)
          return { entry, note: `re-attached to the existing kernel ${recordedId}` }
        } catch {
          reusable.close()
        }
      }
    }

    return await this.#startKernel(link, sessionKey, { signal })
  }

  /**
   * Start a fresh kernel on one server, bind it to the session, and retire any previous binding.
   *
   * @param link - Connection the kernel starts on.
   * @param sessionKey - Harness session id owning the kernel.
   * @param options - Start controls.
   * @param options.signal - Optional caller cancellation.
   * @param options.replace - Also shut the previous kernel down. Set only for an explicit
   *   `jupyter_kernel start`, so that a transient reconnect failure never destroys a kernel the
   *   user still has state in.
   */
  async #startKernel(link, sessionKey, { signal, replace = false } = {}) {
    const client = link.client()
    const binding = this.#binding(link.key, sessionKey)
    const previous = this.#kernels.get(binding)
    if (previous !== undefined) {
      // Always drop the old channel: leaving it open would leak a socket and a kernel binding.
      previous.conn.close()
      this.#kernels.delete(binding)
      this.#statuses.delete(binding)
      this.#writeState(link.key, sessionKey, undefined)
      if (replace) await client.shutdownKernel(previous.kernelId, signal).catch(() => false)
    }
    if (!link.settings.autoStartKernel) {
      throw new JupyterError(
        `jupyter: no kernel is bound to this session on ${link.key} and "autoStartKernel" is off. `
        + 'Call jupyter_kernel with action "start" (or "attach" to an existing kernel id) first.',
        JUPYTER_ERROR_CODES.NOT_CONFIGURED,
      )
    }
    const model = await client.startKernel(
      { name: link.settings.kernelName, path: link.settings.workingDirectory },
      signal,
    )
    if (model?.id === undefined) {
      throw new JupyterError('jupyter: the server did not return a kernel id when starting a kernel.', JUPYTER_ERROR_CODES.HTTP)
    }
    const conn = new KernelConnection({ server: client, kernelId: model.id })
    await conn.connect()
    const entry = {
      kernelId: String(model.id),
      name: String(model.name ?? link.settings.kernelName),
      server: link.key,
      session: sessionKey,
      conn,
    }
    this.#kernels.set(binding, entry)
    this.#writeState(link.key, sessionKey, entry)
    this.#logger?.info?.(`jupyterlab: started kernel ${entry.kernelId} (${entry.name}) on ${link.key}`)
    return { entry, note: `started a new kernel ${entry.kernelId} (${entry.name}); previous state is gone` }
  }

  /**
   * Run code in a session's kernel on one server, establishing it first when necessary.
   *
   * @param sessionKey - Harness session id owning the kernel.
   * @param code - Source to execute.
   * @param options - Execution controls.
   * @param options.server - Connection key or URL spelling; defaults to the default connection.
   * @param options.timeoutMs - Override for the configured execution budget.
   * @param options.signal - Caller cancellation; interrupts the kernel.
   * @param options.storeHistory - Whether the kernel increments its execution counter.
   * @param options.onOutput - Called for each output as it arrives, so a live panel can render a
   *   long cell while it runs. See {@link KernelConnection#execute}.
   * @returns The execution outcome plus the kernel and server it ran on.
   */
  async execute(sessionKey, code, { server, timeoutMs, signal, storeHistory = true, onOutput } = {}) {
    const link = this.#registry.resolve(server)
    const { entry, note } = await this.ensureKernel(sessionKey, { server: link.key, signal })
    const options = { timeoutMs: timeoutMs ?? link.settings.executeTimeoutMs, signal, storeHistory, onOutput }
    let result = await entry.conn.execute(code, options)
    let outcomeNote = note
    if (result.status === 'aborted') {
      // `aborted` means the kernel dropped the cell without running it, usually because the
      // interrupt that ended the previous cell was still settling. Nothing executed, so a single
      // retry is safe — and it spares the caller an empty "ok" that looks like a silent failure.
      const droppedMs = result.durationMs
      // Whatever a listener already rendered belongs to the attempt that never ran; the retry
      // starts from an empty cell rather than appending a second run's output to the first.
      try {
        onOutput?.({ kind: 'clear' })
      } catch {
        // The listener's failure is not the execution's.
      }
      result = await entry.conn.execute(code, options)
      // Report the time the caller actually waited, not just the retry.
      result = { ...result, durationMs: result.durationMs + droppedMs }
      if (result.status !== 'aborted') {
        outcomeNote = [note, 'the kernel dropped the first attempt; retried once'].filter(Boolean).join('; ')
      }
    }
    if (result.status === 'disconnected') {
      // The kernel went away under us; drop the binding so the next call re-establishes it.
      this.#release(link.key, sessionKey)
    }
    return { ...result, kernelId: entry.kernelId, kernelspec: entry.name, server: link.key, note: outcomeNote }
  }

  /**
   * Perform a kernel-management action for the session on one server.
   *
   * @param sessionKey - Harness session id owning the kernel.
   * @param action - One of `list`, `start`, `restart`, `interrupt`, `shutdown`, `attach`.
   * @param options - Action controls.
   * @param options.server - Connection key or URL spelling; defaults to the default connection.
   * @param options.kernelId - Target kernel for `attach`/`shutdown`/`restart`/`interrupt`.
   * @param options.signal - Optional caller cancellation.
   * @returns A descriptive message plus the resulting kernel inventory.
   */
  async kernelAction(sessionKey, action, { server, kernelId, signal } = {}) {
    const link = this.#registry.resolve(server)
    const client = link.client()
    const binding = this.#binding(link.key, sessionKey)
    switch (action) {
      case 'list': {
        const [kernels, kernelspecs] = await Promise.all([client.listKernels(signal), client.kernelspecs(signal)])
        return { message: `${kernels.length} kernel(s) running on ${client.baseUrl}.`, kernels: kernels.map(summarizeKernel), kernelspecs }
      }
      case 'start': {
        const { entry, note } = await this.#startKernel(link, sessionKey, { signal, replace: true })
        return { message: note ?? `started kernel ${entry.kernelId}`, kernels: await this.#inventory(link, signal), kernelId: entry.kernelId, state: 'starting' }
      }
      case 'restart': {
        const target = kernelId ?? (await this.ensureKernel(sessionKey, { server: link.key, signal })).entry.kernelId
        await client.restartKernel(target, signal)
        // The channel must be rebuilt: the process behind it was replaced.
        const bound = this.#kernels.get(binding)
        if (bound !== undefined && bound.kernelId === target) {
          bound.conn.close()
          this.#kernels.delete(binding)
          this.#statuses.delete(binding)
        }
        return { message: `kernel ${target} restarted; every variable, import and open file is gone`, kernels: await this.#inventory(link, signal), kernelId: target, state: 'restarting' }
      }
      case 'interrupt': {
        const target = kernelId ?? (await this.ensureKernel(sessionKey, { server: link.key, signal })).entry.kernelId
        const delivered = await client.interruptKernel(target, signal)
        return { message: delivered === undefined ? `kernel ${target} not found` : `interrupt sent to kernel ${target}`, kernels: await this.#inventory(link, signal), kernelId: target }
      }
      case 'shutdown': {
        const target = kernelId ?? this.#kernels.get(binding)?.kernelId
        if (target === undefined) {
          return { message: 'no kernel is bound to this session and no kernelId was given', kernels: await this.#inventory(link, signal) }
        }
        const stopped = await client.shutdownKernel(target, signal)
        if (this.#kernels.get(binding)?.kernelId === target) this.#release(link.key, sessionKey)
        return { message: stopped ? `kernel ${target} shut down` : `kernel ${target} was already gone`, kernels: await this.#inventory(link, signal), kernelId: target, state: 'dead' }
      }
      case 'attach': {
        if (kernelId === undefined) {
          throw new JupyterError('jupyter: action "attach" needs a kernelId (see action "list").', JUPYTER_ERROR_CODES.HTTP)
        }
        const model = await client.getKernel(kernelId, signal)
        if (model?.id === undefined) {
          throw new JupyterError(
            `jupyter: kernel ${kernelId} does not exist on ${client.baseUrl}. Call jupyter_kernel with action "list" for the running kernels.`,
            JUPYTER_ERROR_CODES.NOT_FOUND,
          )
        }
        // The kernel may already be bound to this session; the channel is still replaced, so the
        // old one must be closed or it would stay attached forever.
        const previous = this.#kernels.get(binding)
        if (previous !== undefined) {
          previous.conn.close()
          this.#kernels.delete(binding)
          this.#statuses.delete(binding)
        }
        const conn = new KernelConnection({ server: client, kernelId })
        await conn.connect()
        const entry = { kernelId, name: String(model.name ?? 'unknown'), server: link.key, session: sessionKey, conn }
        this.#kernels.set(binding, entry)
        this.#writeState(link.key, sessionKey, entry)
        return {
          message: `attached this session to kernel ${kernelId} (${entry.name}); its variables are now yours to use`,
          kernels: await this.#inventory(link, signal),
          kernelId,
          state: 'idle',
        }
      }
      default:
        throw new JupyterError(
          `jupyter: unknown kernel action "${action}". Use one of: list, start, restart, interrupt, shutdown, attach.`,
          JUPYTER_ERROR_CODES.HTTP,
        )
    }
  }

  /**
   * The session's bound kernel on one server, if any, with its liveness confirmed.
   *
   * A panel refresh asks for this on every click, so callers that only need a display value can
   * accept a short-lived memo (`maxAgeMs`). Tool output keeps the default of zero, so
   * `jupyter_status` still reports what the server says right now.
   *
   * @param sessionKey - Harness session id.
   * @param options - Lookup controls.
   * @param options.server - Connection key or URL spelling; defaults to the default connection.
   * @param options.signal - Caller cancellation.
   * @param options.maxAgeMs - Reuse a status younger than this instead of asking the server.
   * @returns The kernel summary, or undefined when nothing is bound.
   */
  async sessionKernel(sessionKey, { server, signal, maxAgeMs = 0 } = {}) {
    const link = this.#registry.resolve(server)
    const binding = this.#binding(link.key, sessionKey)
    const entry = this.#kernels.get(binding)
    if (entry === undefined) return undefined
    if (maxAgeMs > 0) {
      const memo = this.#statuses.get(binding)
      if (memo !== undefined && memo.kernelId === entry.kernelId && memo.expiresAt > Date.now()) {
        return memo.summary
      }
    }
    const model = await link.client().getKernel(entry.kernelId, signal).catch(() => undefined)
    if (model?.id === undefined) {
      this.#release(link.key, sessionKey)
      return undefined
    }
    const summary = summarizeKernel(model)
    if (maxAgeMs > 0) {
      this.#statuses.set(binding, { kernelId: entry.kernelId, summary, expiresAt: Date.now() + maxAgeMs })
    }
    return summary
  }

  /** How many session kernels currently hold an open channel; used by tests and diagnostics. */
  get openChannelCount() {
    return [...this.#kernels.values()].filter((entry) => entry.conn.isOpen).length
  }

  /** List kernels on one server, tolerating a server that has just gone away. */
  async #inventory(link, signal) {
    return (await link.client().listKernels(signal).catch(() => [])).map(summarizeKernel)
  }

  /** Composite map key for one session's binding on one server. */
  #binding(serverKeyText, sessionKey) {
    return `${serverKeyText}::${sessionKey}`
  }

  /** Shut down the session's bound kernel on one server and forget it, when one is bound. */
  async #shutdownBound(serverKeyText, sessionKey) {
    const entry = this.#kernels.get(this.#binding(serverKeyText, sessionKey))
    if (entry === undefined) return
    await this.#registry.resolve(serverKeyText).client().shutdownKernel(entry.kernelId).catch(() => false)
    this.#release(serverKeyText, sessionKey)
  }

  /** Drop the in-memory binding for one session on one server without shutting the kernel down. */
  #release(serverKeyText, sessionKey) {
    const binding = this.#binding(serverKeyText, sessionKey)
    const entry = this.#kernels.get(binding)
    entry?.conn.close()
    this.#kernels.delete(binding)
    this.#statuses.delete(binding)
    this.#writeState(serverKeyText, sessionKey, undefined)
  }

  /** Close and forget every binding on one server, for every session. */
  #closeServer(serverKeyText) {
    for (const [binding, entry] of [...this.#kernels]) {
      if (entry.server !== serverKeyText) continue
      entry.conn.close()
      this.#kernels.delete(binding)
      this.#statuses.delete(binding)
    }
    this.#dropStateForServer(serverKeyText)
  }

  /** Drop one server's kernels.json entries (canonical and legacy spellings). */
  #dropStateForServer(serverKeyText) {
    try {
      const file = this.#statePath()
      const all = this.#readStateFile()
      let changed = false
      for (const key of Object.keys(all)) {
        const prefix = splitStateKey(key)
        if (prefix === undefined) continue
        if (this.#normalizedKey(prefix) !== serverKeyText) continue
        delete all[key]
        changed = true
      }
      if (changed) this.#writeStateFile(all)
    } catch {
      // Best effort, like every other mirror operation.
    }
  }

  /** Release every channel on one server for every session. */
  #releaseServer(serverKeyText) {
    for (const [binding, entry] of [...this.#kernels]) {
      if (entry.server !== serverKeyText) continue
      entry.conn.close()
      this.#kernels.delete(binding)
      this.#statuses.delete(binding)
      this.#writeState(serverKeyText, entry.session, undefined)
    }
  }

  /** Close every channel. Kernels keep running on the server for a later re-attach. */
  dispose() {
    for (const entry of this.#kernels.values()) entry.conn.close()
    this.#kernels.clear()
    this.#statuses.clear()
    this.#registry.dispose()
  }

  /** Absolute path of the kernel-binding mirror. */
  #statePath() {
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    return path.join(home, 'jupyterlab', 'kernels.json')
  }

  /** Normalize a server prefix found in a mirror key; undefined when it is not a URL. */
  #normalizedKey(prefix) {
    try {
      return serverKey(prefix)
    } catch {
      return undefined
    }
  }

  /** Read the mirror file, treating a missing/corrupt file as empty. */
  #readStateFile() {
    try {
      const all = JSON.parse(readFileSync(this.#statePath(), 'utf8'))
      return all !== null && typeof all === 'object' ? all : {}
    } catch {
      return {}
    }
  }

  /** Write the mirror file atomically. Never fatal: a read-only home must not break execution. */
  #writeStateFile(all) {
    try {
      const file = this.#statePath()
      mkdirSync(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      writeFileSync(temporary, JSON.stringify(all, null, 2))
      renameSync(temporary, file)
    } catch {
      // A read-only or missing home directory must not break execution.
    }
  }

  /** Canonical mirror key for a session's binding on one server. */
  #stateKey(serverKeyText, sessionKey) {
    return `${serverKeyText}::${sessionKey}`
  }

  /**
   * Read the mirrored kernel id for a session on one server.
   *
   * The canonical key is the normalized base URL. Mirrors written by the single-server build used
   * the raw configured address (which may carry `/lab` or a query string), so every key ending in
   * `::<sessionId>` whose prefix normalizes to this server is accepted and migrated on next write.
   *
   * @param serverKeyText - Normalized server key.
   * @param sessionKey - Harness session id.
   * @returns The recorded kernel id, if any.
   */
  #readState(serverKeyText, sessionKey) {
    const all = this.#readStateFile()
    const canonical = recordedKernelId(all[this.#stateKey(serverKeyText, sessionKey)])
    if (canonical !== undefined) return canonical
    const suffix = `::${sessionKey}`
    for (const [key, value] of Object.entries(all)) {
      if (key === this.#stateKey(serverKeyText, sessionKey) || !key.endsWith(suffix)) continue
      const id = recordedKernelId(value)
      if (id === undefined) continue
      const prefix = key.slice(0, key.length - suffix.length)
      if (this.#normalizedKey(prefix) === serverKeyText) return id
    }
    return undefined
  }

  /**
   * Mirror (or clear) a session's kernel binding for one server.
   *
   * Writes always use the canonical key and remove any legacy spelling of the same binding, so a
   * cleared binding cannot be resurrected by an old raw-URL entry on the next read.
   *
   * @param serverKeyText - Normalized server key.
   * @param sessionKey - Harness session id.
   * @param entry - Binding to record, or undefined to clear it.
   */
  #writeState(serverKeyText, sessionKey, entry) {
    try {
      const all = this.#readStateFile()
      const suffix = `::${sessionKey}`
      const canonical = this.#stateKey(serverKeyText, sessionKey)
      for (const key of Object.keys(all)) {
        if (key === canonical || !key.endsWith(suffix)) continue
        const prefix = key.slice(0, key.length - suffix.length)
        if (this.#normalizedKey(prefix) === serverKeyText) delete all[key]
      }
      if (entry === undefined) delete all[canonical]
      else all[canonical] = { kernelId: entry.kernelId, name: entry.name, updatedAt: new Date().toISOString() }
      this.#writeStateFile(all)
    } catch {
      // A read-only or missing home directory must not break execution.
    }
  }
}

/** The server prefix of a mirror key (`<url>::<sessionId>`), or undefined when it has none. */
function splitStateKey(key) {
  if (typeof key !== 'string') return undefined
  const index = key.lastIndexOf('::')
  return index > 0 ? key.slice(0, index) : undefined
}

/** Compatibility re-export: settings normalization lived here before `connections.js` existed. */
export { normalizeServerSettings as normalizeSettings } from './connections.js'
