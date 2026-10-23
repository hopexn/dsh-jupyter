/**
 * Connection and kernel-session orchestration for the JupyterLab plugin.
 *
 * The runtime owns three things the tools above it should not have to think about:
 *
 * 1. **One authenticated REST client**, rebuilt only when the address or credentials change and
 *    always constructed lazily, so a wrong or missing address never prevents the plugin from
 *    loading — it surfaces as a readable error on the first tool call instead.
 * 2. **One kernel per DeepSeek Harness session.** The binding is memoized in memory and mirrored
 *    to `$DSH_HOME/jupyterlab/kernels.json`, so a plugin remount or app restart re-attaches to
 *    the same kernel instead of silently starting a fresh one with no variables in it.
 * 3. **Liveness checks before execution.** A kernel that died is detected and replaced before any
 *    code is sent, so "execute" never reports a confusing disconnect for a stale binding.
 *
 * @module dsh-jupyterlab/runtime
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { JUPYTER_ERROR_CODES, JupyterError, JupyterServerClient, normalizeJupyterUrl } from './server.js'
import { KernelConnection } from './kernel.js'
import { resolveHost } from './dns-cache.js'

/** Settings keys a runtime override may replace. */
const OVERRIDABLE = ['url', 'token', 'password', 'username', 'kernelName', 'workingDirectory']

/** Settings keys bound to the server they authenticate against. */
const CREDENTIALS = ['token', 'password', 'username']

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
 * Coerce the plugin config into the runtime's internal settings shape.
 *
 * @param config - Raw plugin config as validated by the `Config` schema.
 * @returns A settings object with every field present and typed.
 */
export function normalizeSettings(config = {}) {
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
    token: text(config.token),
    password: text(config.password),
    username: text(config.username),
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

/** Manages the Jupyter connection and one kernel binding per Harness session. */
export class JupyterRuntime {
  /** @type {ReturnType<typeof normalizeSettings>} */
  #settings
  /** @type {JupyterServerClient|undefined} */
  #client
  /** Identity of {@link JupyterRuntime#client}; a change rebuilds it. */
  #clientKey
  /** Live kernel bindings, keyed by Harness session id. */
  #kernels = new Map()
  /** Short-lived kernel-status memo, so a panel refresh does not cost a REST call. */
  #statuses = new Map()
  /** Optional Cordis logger for diagnostics. */
  #logger

  /**
   * @param config - Plugin config.
   * @param options - Optional logger.
   */
  constructor(config = {}, { logger } = {}) {
    this.#settings = normalizeSettings(config)
    this.#logger = logger
    this.#prewarmDns(this.#settings.url)
  }

  /**
   * Resolve the server name in the background so the first tool call does not pay for it.
   *
   * A mDNS name costs about five seconds to resolve *once*; doing it at mount instead of on the
   * first `jupyter_execute` moves that cost off the critical path, and the result lands in the
   * cache the transport reads.
   *
   * @param url - Configured server address, if any.
   */
  #prewarmDns(url) {
    if (url === undefined) return
    try {
      const host = new URL(normalizeJupyterUrl(url).baseUrl).hostname
      resolveHost(host).catch(() => {})
    } catch {
      // An unusable address is reported by the first tool call, with a better message.
    }
  }

  /** A copy of the current settings. */
  get settings() {
    return { ...this.#settings }
  }

  /** How many session kernels currently hold an open channel; used by tests and diagnostics. */
  get openChannelCount() {
    return [...this.#kernels.values()].filter((entry) => entry.conn.isOpen).length
  }

  /**
   * Apply a runtime settings override, as issued by the `jupyter_connect` tool.
   *
   * Blank fields are ignored, so an omitted credential keeps the configured one. The exception is
   * a **change of address**: a credential belongs to the host it was entered for, so pointing the
   * harness at a different server drops the previous token/password/username unless the same call
   * supplies a replacement. Without that rule, connecting to a new server would silently disclose
   * the old server's secret to it.
   *
   * @param patch - Fields to replace.
   * @param options - Control over existing kernel bindings.
   * @param options.forgetKernels - Whether to unbind every session kernel first.
   * @returns The updated settings.
   */
  configure(patch = {}, { forgetKernels = false } = {}) {
    const provided = {}
    for (const key of OVERRIDABLE) {
      const value = patch[key]
      if (value === undefined || value === null) continue
      const trimmed = String(value).trim()
      if (trimmed.length === 0) continue
      provided[key] = trimmed
    }
    // An address pasted from `jupyter server list` carries its own token; treat that as the
    // credential for this address, so it takes effect even when an older token is still stored.
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
    if (typeof patch.autoStartKernel === 'boolean') next.autoStartKernel = patch.autoStartKernel
    const urlChanged = provided.url !== undefined && provided.url !== this.#settings.url
    this.#settings = next
    if (urlChanged) {
      // A different server means every memoized status belongs to the old one.
      this.#statuses.clear()
      this.#prewarmDns(provided.url)
    }
    if (forgetKernels) {
      for (const sessionKey of [...this.#kernels.keys()]) this.#release(sessionKey)
    }
    return this.settings
  }

  /**
   * The REST client for the current settings.
   *
   * @returns A lazily built, memoized client.
   * @throws {JupyterError} When no address has been configured yet.
   */
  client() {
    const { url, token, password, username, requestTimeoutMs } = this.#settings
    if (url === undefined) {
      throw new JupyterError(
        'jupyter: no server address is configured. Call jupyter_connect with the JupyterLab address '
        + '(for example http://host:9002/lab), or set the "url" option in this plugin\'s config.',
        JUPYTER_ERROR_CODES.NOT_CONFIGURED,
      )
    }
    const key = [url, token ?? '', password ?? '', username ?? '', requestTimeoutMs].join('\u0000')
    if (this.#client === undefined || this.#clientKey !== key) {
      this.#client = new JupyterServerClient({ url, token, password, username, requestTimeoutMs })
      this.#clientKey = key
    }
    return this.#client
  }

  /**
   * Read server identity plus every kernel it tracks.
   *
   * @param options - Optional caller cancellation.
   * @returns Server version, installed kernelspecs, and running kernels.
   */
  async probe({ signal } = {}) {
    const client = this.client()
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
      url: client.baseUrl,
      authMode: client.authMode,
      version: firstVersion(status, api),
      kernelspecs,
      kernels: kernels.map(summarizeKernel),
    }
  }

  /**
   * Resolve the session's kernel, starting or re-attaching as needed.
   *
   * Order of preference: the live in-memory binding, the kernel id mirrored to disk (so a plugin
   * remount or app restart resumes the same kernel), then a freshly started kernel.
   *
   * @param sessionKey - Harness session id owning the kernel.
   * @param options - Resolution controls.
   * @param options.forceNew - Shut the bound kernel down and start a fresh one.
   * @param options.signal - Optional caller cancellation.
   * @returns The live binding plus a note when it had to be re-established.
   */
  async ensureKernel(sessionKey, { forceNew = false, signal } = {}) {
    const client = this.client()
    if (forceNew) await this.#shutdownBound(sessionKey)
    let entry = this.#kernels.get(sessionKey)
    if (entry?.conn.isOpen === true) return { entry, note: undefined }

    const recordedId = entry?.kernelId ?? this.#readState(sessionKey)
    if (recordedId !== undefined && recordedId !== null) {
      const model = await client.getKernel(recordedId, signal).catch(() => undefined)
      if (model?.id !== undefined) {
        const reusable = entry?.conn !== undefined && entry.kernelId === recordedId
          ? entry.conn
          : new KernelConnection({ server: client, kernelId: recordedId })
        try {
          await reusable.connect()
          entry = { kernelId: recordedId, name: String(model.name ?? this.#settings.kernelName), conn: reusable }
          this.#kernels.set(sessionKey, entry)
          this.#writeState(sessionKey, entry)
          return { entry, note: `re-attached to the existing kernel ${recordedId}` }
        } catch {
          reusable.close()
        }
      }
    }

    return await this.#startKernel(sessionKey, { signal })
  }

  /**
   * Start a fresh kernel, bind it to the session, and retire any previous binding.
   *
   * @param sessionKey - Harness session id owning the kernel.
   * @param options - Start controls.
   * @param options.signal - Optional caller cancellation.
   * @param options.replace - Also shut the previous kernel down. Set only for an explicit
   *   `jupyter_kernel start`, so that a transient reconnect failure never destroys a kernel the
   *   user still has state in.
   */
  async #startKernel(sessionKey, { signal, replace = false } = {}) {
    const client = this.client()
    const previous = this.#kernels.get(sessionKey)
    if (previous !== undefined) {
      // Always drop the old channel: leaving it open would leak a socket and a kernel binding.
      previous.conn.close()
      this.#kernels.delete(sessionKey)
      this.#statuses.delete(sessionKey)
      this.#writeState(sessionKey, undefined)
      if (replace) await client.shutdownKernel(previous.kernelId, signal).catch(() => false)
    }
    if (!this.#settings.autoStartKernel) {
      throw new JupyterError(
        `jupyter: no kernel is bound to this session and "autoStartKernel" is off. `
        + 'Call jupyter_kernel with action "start" (or "attach" to an existing kernel id) first.',
        JUPYTER_ERROR_CODES.NOT_CONFIGURED,
      )
    }
    const model = await client.startKernel(
      { name: this.#settings.kernelName, path: this.#settings.workingDirectory },
      signal,
    )
    if (model?.id === undefined) {
      throw new JupyterError('jupyter: the server did not return a kernel id when starting a kernel.', JUPYTER_ERROR_CODES.HTTP)
    }
    const conn = new KernelConnection({ server: client, kernelId: model.id })
    await conn.connect()
    const entry = { kernelId: String(model.id), name: String(model.name ?? this.#settings.kernelName), conn }
    this.#kernels.set(sessionKey, entry)
    this.#writeState(sessionKey, entry)
    this.#logger?.info?.(`jupyterlab: started kernel ${entry.kernelId} (${entry.name})`)
    return { entry, note: `started a new kernel ${entry.kernelId} (${entry.name}); previous state is gone` }
  }

  /**
   * Run code in the session's kernel, establishing it first when necessary.
   *
   * @param sessionKey - Harness session id owning the kernel.
   * @param code - Source to execute.
   * @param options - Execution controls.
   * @param options.timeoutMs - Override for the configured execution budget.
   * @param options.signal - Caller cancellation; interrupts the kernel.
   * @param options.storeHistory - Whether the kernel increments its execution counter.
   * @param options.onOutput - Called for each output as it arrives, so a live panel can render a
   *   long cell while it runs. See {@link KernelConnection#execute}.
   * @returns The execution outcome plus the kernel it ran on.
   */
  async execute(sessionKey, code, { timeoutMs, signal, storeHistory = true, onOutput } = {}) {
    const { entry, note } = await this.ensureKernel(sessionKey, { signal })
    const options = { timeoutMs: timeoutMs ?? this.#settings.executeTimeoutMs, signal, storeHistory, onOutput }
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
      this.#release(sessionKey)
    }
    return { ...result, kernelId: entry.kernelId, kernelspec: entry.name, note: outcomeNote }
  }

  /**
   * Perform a kernel-management action for the session.
   *
   * @param sessionKey - Harness session id owning the kernel.
   * @param action - One of `list`, `start`, `restart`, `interrupt`, `shutdown`, `attach`.
   * @param options - Action controls.
   * @param options.kernelId - Target kernel for `attach`/`shutdown`/`restart`/`interrupt`.
   * @param options.signal - Optional caller cancellation.
   * @returns A descriptive message plus the resulting kernel inventory.
   */
  async kernelAction(sessionKey, action, { kernelId, signal } = {}) {
    const client = this.client()
    switch (action) {
      case 'list': {
        const [kernels, kernelspecs] = await Promise.all([client.listKernels(signal), client.kernelspecs(signal)])
        return { message: `${kernels.length} kernel(s) running on ${client.baseUrl}.`, kernels: kernels.map(summarizeKernel), kernelspecs }
      }
      case 'start': {
        const { entry, note } = await this.#startKernel(sessionKey, { signal, replace: true })
        return { message: note ?? `started kernel ${entry.kernelId}`, kernels: await this.#inventory(signal), kernelId: entry.kernelId, state: 'starting' }
      }
      case 'restart': {
        const target = kernelId ?? (await this.ensureKernel(sessionKey, { signal })).entry.kernelId
        await client.restartKernel(target, signal)
        // The channel must be rebuilt: the process behind it was replaced.
        const bound = this.#kernels.get(sessionKey)
        if (bound !== undefined && bound.kernelId === target) {
          bound.conn.close()
          this.#kernels.delete(sessionKey)
          this.#statuses.delete(sessionKey)
        }
        return { message: `kernel ${target} restarted; every variable, import and open file is gone`, kernels: await this.#inventory(signal), kernelId: target, state: 'restarting' }
      }
      case 'interrupt': {
        const target = kernelId ?? (await this.ensureKernel(sessionKey, { signal })).entry.kernelId
        const delivered = await client.interruptKernel(target, signal)
        return { message: delivered === undefined ? `kernel ${target} not found` : `interrupt sent to kernel ${target}`, kernels: await this.#inventory(signal), kernelId: target }
      }
      case 'shutdown': {
        const target = kernelId ?? this.#kernels.get(sessionKey)?.kernelId
        if (target === undefined) {
          return { message: 'no kernel is bound to this session and no kernelId was given', kernels: await this.#inventory(signal) }
        }
        const stopped = await client.shutdownKernel(target, signal)
        if (this.#kernels.get(sessionKey)?.kernelId === target) this.#release(sessionKey)
        return { message: stopped ? `kernel ${target} shut down` : `kernel ${target} was already gone`, kernels: await this.#inventory(signal), kernelId: target, state: 'dead' }
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
        const previous = this.#kernels.get(sessionKey)
        if (previous !== undefined) {
          previous.conn.close()
          this.#kernels.delete(sessionKey)
          this.#statuses.delete(sessionKey)
        }
        const conn = new KernelConnection({ server: client, kernelId })
        await conn.connect()
        const entry = { kernelId, name: String(model.name ?? 'unknown'), conn }
        this.#kernels.set(sessionKey, entry)
        this.#writeState(sessionKey, entry)
        return {
          message: `attached this session to kernel ${kernelId} (${entry.name}); its variables are now yours to use`,
          kernels: await this.#inventory(signal),
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
   * The session's bound kernel, if any, with its liveness confirmed.
   *
   * A panel refresh asks for this on every click, so callers that only need a display value can
   * accept a short-lived memo (`maxAgeMs`). Tool output keeps the default of zero, so
   * `jupyter_status` still reports what the server says right now.
   *
   * @param sessionKey - Harness session id.
   * @param options - Lookup controls.
   * @param options.signal - Caller cancellation.
   * @param options.maxAgeMs - Reuse a status younger than this instead of asking the server.
   * @returns The kernel summary, or undefined when nothing is bound.
   */
  async sessionKernel(sessionKey, { signal, maxAgeMs = 0 } = {}) {
    const entry = this.#kernels.get(sessionKey)
    if (entry === undefined) return undefined
    if (maxAgeMs > 0) {
      const memo = this.#statuses.get(sessionKey)
      if (memo !== undefined && memo.kernelId === entry.kernelId && memo.expiresAt > Date.now()) {
        return memo.summary
      }
    }
    const model = await this.client().getKernel(entry.kernelId, signal).catch(() => undefined)
    if (model?.id === undefined) {
      this.#release(sessionKey)
      return undefined
    }
    const summary = summarizeKernel(model)
    if (maxAgeMs > 0) {
      this.#statuses.set(sessionKey, { kernelId: entry.kernelId, summary, expiresAt: Date.now() + maxAgeMs })
    }
    return summary
  }

  /** List kernels, tolerating a server that has just gone away. */
  async #inventory(signal) {
    return (await this.client().listKernels(signal).catch(() => [])).map(summarizeKernel)
  }

  /** Shut down the session's bound kernel and forget it, when one is bound. */
  async #shutdownBound(sessionKey) {
    const entry = this.#kernels.get(sessionKey)
    if (entry === undefined) return
    await this.client().shutdownKernel(entry.kernelId).catch(() => false)
    this.#release(sessionKey)
  }

  /** Drop the in-memory binding for a session without shutting the kernel down. */
  #release(sessionKey) {
    const entry = this.#kernels.get(sessionKey)
    entry?.conn.close()
    this.#kernels.delete(sessionKey)
    this.#statuses.delete(sessionKey)
    this.#writeState(sessionKey, undefined)
  }

  /** Close every channel. Kernels keep running on the server for a later re-attach. */
  dispose() {
    for (const entry of this.#kernels.values()) entry.conn.close()
    this.#kernels.clear()
    this.#statuses.clear()
  }

  /** Absolute path of the kernel-binding mirror. */
  #statePath() {
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    return path.join(home, 'jupyterlab', 'kernels.json')
  }

  /** Mirror key for a session, scoped to the server it belongs to. */
  #stateKey(sessionKey) {
    return `${this.#settings.url ?? ''}::${sessionKey}`
  }

  /** Read the mirrored kernel id for a session, if any. */
  #readState(sessionKey) {
    try {
      const all = JSON.parse(readFileSync(this.#statePath(), 'utf8'))
      const kernelId = all?.[this.#stateKey(sessionKey)]?.kernelId
      return typeof kernelId === 'string' && kernelId.length > 0 ? kernelId : undefined
    } catch {
      return undefined
    }
  }

  /** Mirror (or clear) a session's kernel binding. Best effort — never fatal. */
  #writeState(sessionKey, entry) {
    try {
      const file = this.#statePath()
      mkdirSync(path.dirname(file), { recursive: true })
      let all = {}
      try {
        all = JSON.parse(readFileSync(file, 'utf8')) ?? {}
      } catch {
        all = {}
      }
      const key = this.#stateKey(sessionKey)
      if (entry === undefined) delete all[key]
      else all[key] = { kernelId: entry.kernelId, name: entry.name, updatedAt: new Date().toISOString() }
      const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      writeFileSync(temporary, JSON.stringify(all, null, 2))
      renameSync(temporary, file)
    } catch {
      // A read-only or missing home directory must not break execution.
    }
  }
}
