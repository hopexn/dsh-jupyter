/**
 * Jupyter kernel-protocol client over a WebSocket channel.
 *
 * One {@link KernelConnection} owns one kernel's `/api/kernels/<id>/channels` socket and speaks
 * the Jupyter messaging protocol directly (no `jupyter_client`, no Python on this side):
 * an `execute_request` goes out on the shell channel, and `stream` / `execute_result` /
 * `display_data` / `error` messages come back on iopub until the matching `execute_reply` and
 * the `idle` status arrive.
 *
 * Execution is serialized per connection, because iopub carries no request id on the wire and
 * interleaved executions would otherwise mix their outputs.
 *
 * @module dsh-jupyterlab/kernel
 */

import { randomUUID } from 'node:crypto'

import { KernelSocket } from './websocket.js'

/** MIME types whose payloads the runtime can persist as files. */
export const ARTIFACT_MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
}

/** MIME types carrying base64 rather than UTF-8 text. */
const BASE64_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'])

/**
 * One execution's normalized outcome.
 *
 * @typedef {object} ExecutionResult
 * @property {'ok'|'error'|'timeout'|'aborted'|'disconnected'} status - How the execution ended.
 *   `aborted` means the kernel dropped the cell before executing it: nothing ran.
 * @property {string} [message] - Why a non-`ok` execution ended that way.
 * @property {number|null} executionCount - Kernel execution counter, when reported.
 * @property {Array<object>} outputs - Normalized iopub output entries in arrival order.
 * @property {number} durationMs - Wall-clock duration of the call.
 */

/**
 * A live (or reconnectable) connection to one Jupyter kernel.
 */
export class KernelConnection {
  /** @type {KernelSocket|undefined} */
  #ws
  /** In-flight handshake, so concurrent callers share one socket. */
  #connecting
  /** Executions awaiting completion, keyed by parent message id. */
  #executions = new Map()
  /** Tail of the serialization chain; every execution appends to it. */
  #queue = Promise.resolve()
  /** Set once the connection is deliberately closed. */
  #closed = false

  /**
   * @param options - Connection target.
   * @param options.server - Authenticated REST client used for the upgrade URL and interrupts.
   * @param options.kernelId - Kernel this channel is bound to.
   * @param options.sessionId - Client session id sent in message headers and the query string.
   * @param options.connectTimeoutMs - Handshake budget.
   */
  constructor({ server, kernelId, sessionId = randomUUID(), connectTimeoutMs = 15000 }) {
    this.server = server
    /** Kernel id this channel speaks to. */
    this.kernelId = kernelId
    /** Client session id; stable for the life of the connection. */
    this.sessionId = sessionId
    this.connectTimeoutMs = connectTimeoutMs
  }

  /** Whether the channel is open and usable. */
  get isOpen() {
    return this.#ws !== undefined && this.#ws.readyState === 1
  }

  /**
   * Open the channel if it is not already open.
   *
   * @returns This connection, once the socket is usable.
   * @throws {Error} When the handshake fails — usually because the kernel no longer exists.
   */
  async connect() {
    if (this.isOpen) return this
    if (this.#closed) throw new Error(`jupyter: channel for kernel ${this.kernelId} was closed.`)
    if (this.#connecting !== undefined) return await this.#connecting
    this.#connecting = this.#handshake().finally(() => { this.#connecting = undefined })
    return await this.#connecting
  }

  /** Perform the WebSocket handshake and install the message handlers. */
  async #handshake() {
    const path = `/api/kernels/${encodeURIComponent(this.kernelId)}/channels?session_id=${encodeURIComponent(this.sessionId)}`
    // `wsTarget` carries the resolver, so the handshake shares the REST client's DNS cache instead
    // of paying a fresh `getaddrinfo` — five seconds on a mDNS name — just to open the channel.
    const { url, headers, lookup } = this.server.wsTarget(path)
    const ws = new KernelSocket(url, { headers, lookup, connectTimeoutMs: this.connectTimeoutMs })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        safeClose(ws)
        reject(new Error(`jupyter: timed out opening the kernel channel for ${this.kernelId}.`))
      }, this.connectTimeoutMs)
      const onOpen = () => { cleanup(); resolve() }
      const onError = (event) => {
        cleanup()
        reject(new Error(`jupyter: cannot open the kernel channel for ${this.kernelId} — ${event?.message ?? 'websocket error'}. The kernel may have been shut down.`))
      }
      const onClose = () => {
        cleanup()
        reject(new Error(`jupyter: the kernel channel for ${this.kernelId} closed during the handshake. The kernel may have been shut down.`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        ws.removeEventListener('close', onClose)
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
      ws.addEventListener('close', onClose)
    })
    this.#ws = ws
    ws.onmessage = (event) => this.#dispatch(event.data)
    ws.onclose = () => {
      this.#ws = undefined
      this.#settleAll('disconnected', `the kernel channel closed (kernel ${this.kernelId} may have exited or restarted)`)
    }
    ws.onerror = () => {}
    return this
  }

  /**
   * Execute code in the kernel and collect its outputs.
   *
   * Calls are serialized: the returned promise resolves after every earlier execution settled.
   * Caller cancellation and the internal timeout both send an `interrupt_request`, so a runaway
   * cell stops rather than continuing to burn the remote CPU.
   *
   * @param code - Source to run.
   * @param options - Execution controls.
   * @param options.timeoutMs - Budget before the kernel is interrupted.
   * @param options.signal - Caller cancellation.
   * @param options.storeHistory - Whether the kernel increments its execution counter.
   * @param options.onOutput - Called for every output as it arrives, before the execution ends, so
   *   a long cell can be watched while it runs. Gets the same normalized entries the result will
   *   carry, plus `{ kind: 'clear' }` when the kernel asked to wipe what came before.
   * @returns The normalized {@link ExecutionResult}.
   */
  async execute(code, { timeoutMs = 180000, signal, storeHistory = true, onOutput } = {}) {
    const run = async () => {
      if (signal?.aborted) throw abortError()
      await this.connect()
      return await this.#runOne(code, { timeoutMs, signal, storeHistory, onOutput })
    }
    const result = this.#queue.then(run, run)
    // Keep the chain alive regardless of this execution's outcome.
    this.#queue = result.then(() => undefined, () => undefined)
    return await result
  }

  /** Send one `execute_request` and await its terminal condition. */
  async #runOne(code, { timeoutMs, signal, storeHistory, onOutput }) {
    const msgId = randomUUID()
    const started = Date.now()
    // A listener that throws must not break the protocol handler: the outputs are still collected
    // for the caller, and the failure is the listener's own business.
    const notify = (entry) => {
      if (onOutput === undefined) return
      try {
        onOutput(entry)
      } catch {
        // Ignored on purpose.
      }
    }
    const record = {
      msgId,
      outputs: [],
      reply: undefined,
      idle: false,
      settled: false,
      timer: undefined,
      idleGrace: undefined,
      interruptTimer: undefined,
    }
    const finished = new Promise((resolve) => { record.resolve = resolve })
    this.#executions.set(msgId, record)

    const settle = (status, message) => {
      if (record.settled) return
      record.settled = true
      clearTimeout(record.timer)
      clearTimeout(record.idleGrace)
      clearTimeout(record.interruptTimer)
      signal?.removeEventListener('abort', onAbort)
      this.#executions.delete(msgId)
      record.resolve({
        status,
        message,
        executionCount: typeof record.reply?.execution_count === 'number' ? record.reply.execution_count : null,
        outputs: record.outputs,
        durationMs: Date.now() - started,
      })
    }

    /** Complete once the reply is in and the kernel reported idle (with a short grace). */
    const maybeComplete = () => {
      if (record.settled || record.reply === undefined) return
      if (record.idle) {
        settle(statusForReply(record.reply))
        return
      }
      record.idleGrace ??= setTimeout(() => {
        // Some kernels answer a silent/failed request without a trailing idle status.
        settle(statusForReply(record.reply), 'completed without an idle status')
      }, 2000)
    }

    /** Interrupt the kernel, then give it a moment to report the final state. */
    const interruptAndSettle = (status, message) => {
      if (record.settled) return
      record.interruptTimer = setTimeout(() => settle(status, message), 3000)
      this.interrupt().catch(() => {})
      // A well-behaved kernel replies to the interrupt; settle as soon as it does.
      record.pendingStatus = { status, message }
      if (record.reply !== undefined) settle(status, message)
    }

    const onAbort = () => interruptAndSettle('aborted', 'the tool call was cancelled')

    record.process = (message) => {
      const type = message.header?.msg_type
      if (message.channel === 'shell') {
        if (type === 'execute_reply') {
          record.reply = message.content ?? {}
          if (record.pendingStatus !== undefined) {
            settle(record.pendingStatus.status, record.pendingStatus.message)
          } else if (record.reply.status === 'aborted') {
            // The kernel dropped this request before running it — normally because the previous
            // cell was interrupted and the interrupt was still settling. No output is coming, so
            // settle now rather than waiting out the idle grace.
            settle('aborted', 'the kernel dropped this cell before running it, so nothing was executed')
          } else {
            maybeComplete()
          }
        }
        return
      }
      if (message.channel !== 'iopub') return
      switch (type) {
        case 'status':
          if (message.content?.execution_state === 'idle') {
            record.idle = true
            if (record.pendingStatus !== undefined) settle(record.pendingStatus.status, record.pendingStatus.message)
            else maybeComplete()
          }
          break
        case 'stream': {
          const entry = { kind: 'stream', name: message.content?.name ?? 'stdout', text: message.content?.text ?? '' }
          record.outputs.push(entry)
          notify(entry)
          break
        }
        case 'execute_result': {
          const entry = { kind: 'result', data: message.content?.data ?? {}, executionCount: message.content?.execution_count }
          record.outputs.push(entry)
          notify(entry)
          break
        }
        case 'display_data': {
          const entry = { kind: 'display', data: message.content?.data ?? {} }
          record.outputs.push(entry)
          notify(entry)
          break
        }
        case 'error': {
          const entry = {
            kind: 'error',
            ename: message.content?.ename ?? 'Error',
            evalue: message.content?.evalue ?? '',
            traceback: Array.isArray(message.content?.traceback) ? message.content.traceback : [],
          }
          record.outputs.push(entry)
          notify(entry)
          break
        }
        case 'clear_output':
          record.outputs.length = 0
          notify({ kind: 'clear' })
          break
        default:
          break
      }
    }

    if (signal !== undefined && signal !== null) signal.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs > 0) {
      record.timer = setTimeout(() => interruptAndSettle('timeout', `no result within ${timeoutMs}ms; the kernel was interrupted`), timeoutMs)
    }

    this.#send({
      header: this.#header('execute_request'),
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: false,
        store_history: storeHistory,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      },
      channel: 'shell',
      buffers: [],
    }, msgId)

    return await finished
  }

  /**
   * Ask the kernel to stop the running cell (`POST /api/kernels/<id>/interrupt`).
   * @returns Whether the interrupt request was delivered.
   */
  async interrupt() {
    try {
      await this.server.interruptKernel(this.kernelId)
      return true
    } catch {
      return false
    }
  }

  /** Close the channel; pending executions settle as `disconnected`. */
  close() {
    this.#closed = true
    this.#settleAll('disconnected', 'the connection was closed')
    safeClose(this.#ws)
    this.#ws = undefined
  }

  /** Build an outbound message header. */
  #header(msgType) {
    return {
      msg_id: randomUUID(),
      username: 'dsh',
      session: this.sessionId,
      msg_type: msgType,
      version: '5.3',
      date: new Date().toISOString(),
    }
  }

  /** Serialize and send one protocol message. */
  #send(message, msgId) {
    if (message.header !== undefined) message.header.msg_id = msgId
    try {
      this.#ws?.send(JSON.stringify(message))
    } catch (error) {
      const record = this.#executions.get(msgId)
      if (record !== undefined && !record.settled) {
        record.settled = true
        clearTimeout(record.timer)
        clearTimeout(record.idleGrace)
        clearTimeout(record.interruptTimer)
        this.#executions.delete(msgId)
        record.resolve({ status: 'disconnected', message: `send failed: ${error.message}`, executionCount: null, outputs: [], durationMs: 0 })
      }
    }
  }

  /** Route one inbound frame to its execution record. */
  #dispatch(raw) {
    if (this.#executions.size === 0) return
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      return
    }
    const parentId = message.parent_header?.msg_id
    if (typeof parentId !== 'string') return
    this.#executions.get(parentId)?.process?.(message)
  }

  /** Settle every pending execution with the same outcome. */
  #settleAll(status, message) {
    for (const record of [...this.#executions.values()]) {
      if (record.settled) continue
      record.settled = true
      clearTimeout(record.timer)
      clearTimeout(record.idleGrace)
      clearTimeout(record.interruptTimer)
      record.resolve({ status, message, executionCount: null, outputs: record.outputs, durationMs: 0 })
    }
    this.#executions.clear()
  }
}

/**
 * Translate a Jupyter `execute_reply` status into an execution status.
 *
 * The protocol has three: `ok`, `error`, and `aborted` — the last meaning the kernel discarded
 * the request without running it, which is **not** a silent success.
 *
 * @param reply - The `execute_reply` content.
 * @returns The execution status.
 */
function statusForReply(reply) {
  if (reply.status === 'error') return 'error'
  if (reply.status === 'aborted') return 'aborted'
  return 'ok'
}

/** Close a socket without letting a teardown error escape. */
function safeClose(ws) {
  try { ws?.close() } catch { /* already gone */ }
}

/** A standard abort error distinguishable by the tool runtime. */
function abortError() {
  const error = new Error('jupyter: the tool call was cancelled before it started.')
  error.name = 'AbortError'
  return error
}

/**
 * Fold normalized execution outputs into the model-facing pieces of a tool result.
 *
 * @param outputs - Entries produced by {@link KernelConnection#execute}.
 * @returns Aggregated stdout, stderr, last `text/plain` result, and the first error traceback.
 */
export function summarizeOutputs(outputs) {
  const stdout = []
  const stderr = []
  let result
  let error
  const rich = []
  for (const output of outputs) {
    if (output.kind === 'stream') {
      ;(output.name === 'stderr' ? stderr : stdout).push(output.text)
      continue
    }
    if (output.kind === 'error') {
      error ??= formatError(output)
      continue
    }
    const data = output.data ?? {}
    const plain = plainText(data)
    if (output.kind === 'result') {
      if (plain !== undefined) result = plain
    } else if (plain !== undefined) {
      rich.push(plain)
    }
    for (const mime of Object.keys(data)) {
      if (ARTIFACT_MIME_EXTENSIONS[mime] !== undefined) rich.push(`[${mime} output]`)
    }
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), result, error, rich }
}

/** Render a Jupyter error message into readable text. */
export function formatError(output) {
  const traceback = Array.isArray(output.traceback) && output.traceback.length > 0
    ? stripAnsi(output.traceback.join('\n'))
    : undefined
  if (traceback !== undefined && traceback.trim().length > 0) return traceback
  return `${output.ename}: ${output.evalue}`
}

/** Pick a text representation out of a MIME bundle. */
export function plainText(data) {
  if (typeof data['text/plain'] === 'string') return data['text/plain']
  if (typeof data['text/markdown'] === 'string') return data['text/markdown']
  if (typeof data['text/html'] === 'string') return stripHtml(data['text/html'])
  if (typeof data['application/json'] === 'string') return data['application/json']
  return undefined
}

/**
 * Save every rich output in a MIME bundle to disk.
 *
 * Images and PDFs are the reason this exists: the model reads text, but the user wants the plot.
 * Files land in the configured artifact directory and their paths are reported in the result.
 *
 * @param outputs - Entries produced by {@link KernelConnection#execute}.
 * @param options - Destination and naming controls.
 * @param options.directory - Absolute directory to write into.
 * @param options.prefix - Filename prefix.
 * @param options.writeFile - Injected writer, so this module stays free of `node:fs`.
 * @returns Absolute paths of every file written.
 */
export function collectArtifacts(outputs, { directory, prefix, writeFile }) {
  const written = []
  let index = 0
  for (const output of outputs) {
    if (output.kind !== 'result' && output.kind !== 'display') continue
    for (const [mime, payload] of Object.entries(output.data ?? {})) {
      const extension = ARTIFACT_MIME_EXTENSIONS[mime]
      if (extension === undefined || typeof payload !== 'string') continue
      const name = `${prefix}-${String(index).padStart(2, '0')}.${extension}`
      const file = `${directory}/${name}`
      try {
        writeFile(file, payload, BASE64_MIME_TYPES.has(mime) ? 'base64' : 'utf8')
        written.push(file)
        index += 1
      } catch {
        // Artifact persistence is best-effort; never fail an execution over it.
      }
    }
  }
  return written
}

/** Remove terminal color escapes so tracebacks read cleanly in a transcript. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
}

/** Crude HTML-to-text for outputs that only ship `text/html`. */
function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
