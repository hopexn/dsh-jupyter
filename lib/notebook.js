/**
 * The notebook model behind the right-side panel.
 *
 * A notebook is a list of cells owned by one DeepSeek Harness session. Running a cell sends its
 * code to **the same kernel the agent uses** for that session, so the user and the agent share one
 * namespace: a variable defined in a cell is visible to `jupyter_execute`, and vice versa.
 *
 * The model is deliberately separate from the HTTP routes that expose it, so it can be tested
 * without a browser, and separate from the kernel client, so a run is just an injected async
 * function.
 *
 * Notebooks are mirrored to `$DSH_HOME/jupyterlab/notebooks/<session>.json` and restored on the
 * next read, so a page reload — or an app restart — does not lose the user's work.
 *
 * @module dsh-jupyterlab/notebook
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

/** Rich outputs sent to the browser: enough for a plot, small enough to keep the payload sane. */
const MAX_IMAGES_PER_CELL = 8
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_TEXT_PER_CELL = 200_000

/**
 * How long a *large* mirror waits before it is written.
 *
 * Every panel click mutates the notebook, and the mirror is the whole notebook including any
 * base64 images in it. Writing megabytes on the click path put a serialization of that payload
 * between the click and its response, on the same event loop that streams the conversation. Small
 * notebooks are written immediately — they cost nothing and durability is worth more — and only a
 * heavy one is coalesced, so a burst of edits costs one write and a click costs no I/O at all.
 */
const PERSIST_DELAY_MS = 60

/** Above this much cell payload, the mirror write is deferred and coalesced. */
const HEAVY_MIRROR_BYTES = 256 * 1024

/** MIME types the panel can render as an image. */
const RENDERABLE_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Cell kinds the model accepts. */
const CELL_KINDS = new Set(['code', 'markdown'])

/**
 * Shape of one cell as the browser sees it.
 *
 * @typedef {object} CellView
 * @property {string} id - Stable cell id.
 * @property {'code'|'markdown'} kind - Cell language.
 * @property {string} source - Cell text.
 * @property {'idle'|'running'|'ok'|'error'|'aborted'} status - Last run outcome.
 * @property {number|null} executionCount - Kernel execution counter, when reported.
 * @property {number|null} durationMs - How long the last run took.
 * @property {Array<object>} outputs - Renderable outputs, newest run only.
 * @property {string|null} error - Failure of the DSH-side call (not the cell's own traceback).
 */

/** A new, empty code cell. */
function newCell(kind = 'code', source = '') {
  return {
    id: randomUUID(),
    kind: CELL_KINDS.has(kind) ? kind : 'code',
    source: String(source ?? ''),
    status: 'idle',
    executionCount: null,
    durationMs: null,
    outputs: [],
    error: null,
  }
}

/**
 * Turn one execution result's normalized outputs into renderable entries.
 *
 * Streams, text results, tracebacks and images survive; anything else is summarized as text so the
 * user is never shown an empty box where the kernel did produce something.
 *
 * @param outputs - Entries from the kernel connection.
 * @returns Browser-renderable output entries.
 */
export function renderableOutputs(outputs = []) {
  const rendered = []
  let textBudget = MAX_TEXT_PER_CELL
  let images = 0
  const pushText = (entry) => {
    if (textBudget <= 0) return
    const text = entry.text.length > textBudget ? `${entry.text.slice(0, textBudget)}\n… [truncated]` : entry.text
    textBudget -= text.length
    rendered.push({ ...entry, text })
  }
  for (const output of outputs) {
    if (output.kind === 'stream') {
      pushText({ type: 'stream', name: output.name === 'stderr' ? 'stderr' : 'stdout', text: String(output.text ?? '') })
      continue
    }
    if (output.kind === 'error') {
      const traceback = Array.isArray(output.traceback) && output.traceback.length > 0
        ? output.traceback.join('\n')
        : `${output.ename ?? 'Error'}: ${output.evalue ?? ''}`
      // eslint-disable-next-line no-control-regex
      pushText({ type: 'error', text: traceback.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '') })
      continue
    }
    const data = output.data ?? {}
    const plain = typeof data['text/plain'] === 'string' ? data['text/plain'] : undefined
    if (plain !== undefined && plain.trim().length > 0) pushText({ type: 'text', text: plain })
    for (const mime of RENDERABLE_IMAGES) {
      const payload = data[mime]
      if (typeof payload !== 'string' || images >= MAX_IMAGES_PER_CELL) continue
      if (payload.length > MAX_IMAGE_BYTES) {
        pushText({ type: 'text', text: `[${mime} output omitted: ${Math.round(payload.length / 1024)} KiB]` })
        continue
      }
      images += 1
      rendered.push({ type: 'image', mime, dataUrl: `data:${mime};base64,${payload.replace(/\s+/g, '')}` })
      break
    }
    if (output.kind === 'display' && plain === undefined && !RENDERABLE_IMAGES.some((mime) => typeof data[mime] === 'string')) {
      const summary = Object.keys(data).join(', ')
      if (summary.length > 0) pushText({ type: 'text', text: `[${summary} output]` })
    }
  }
  return rendered
}

/** One stored notebook, keyed by DSH session id. */
export class Notebooks {
  /** @type {Map<string, {cells: object[], path: string|null, revision: number}>} */
  #notebooks = new Map()
  /** Notebooks whose mirror write is scheduled, keyed by session. */
  #pendingPersistence = new Map()
  /** @type {string} */
  #directory
  /** Executes code in the session's kernel; injected so tests can drive the model directly. */
  #execute
  /** Reports the session's kernel, for the panel's status row. */
  #kernelInfo

  /**
   * @param options - Wiring.
   * @param options.directory - Directory for the on-disk mirror; defaults under `$DSH_HOME`.
   * @param options.execute - `(sessionId, code, options) => Promise<execution result>`.
   * @param options.kernelInfo - `(sessionId) => Promise<{id, name, state}|undefined>`.
   */
  constructor({ directory, execute, kernelInfo } = {}) {
    this.#directory = directory ?? path.join(
      process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
      'jupyterlab',
      'notebooks',
    )
    this.#execute = execute
    this.#kernelInfo = kernelInfo
  }

  /**
   * The session's notebook, loading it from disk on first use.
   *
   * @param sessionId - Owning DSH session.
   * @returns The mutable notebook record.
   */
  #notebook(sessionId) {
    let notebook = this.#notebooks.get(sessionId)
    if (notebook === undefined) {
      notebook = this.#load(sessionId)
      this.#notebooks.set(sessionId, notebook)
    }
    return notebook
  }

  /** Restore a mirrored notebook, or start one with a single empty cell. */
  #load(sessionId) {
    try {
      const raw = JSON.parse(readFileSync(this.#file(sessionId), 'utf8'))
      if (Array.isArray(raw?.cells)) {
        return {
          cells: raw.cells.map((cell) => ({ ...newCell(cell.kind, cell.source), ...cell, status: 'idle', error: null })),
          path: typeof raw.path === 'string' ? raw.path : null,
          revision: Number.isFinite(raw.revision) ? raw.revision : 0,
        }
      }
    } catch {
      // No mirror yet, or it is unreadable: a fresh notebook is the correct fallback.
    }
    return { cells: [newCell('code')], path: null, revision: 0 }
  }

  /** Best-effort mirror of one notebook: immediate when cheap, coalesced when heavy. */
  #persist(sessionId, notebook) {
    if (!isHeavy(notebook)) {
      this.#flushPersistence(sessionId, notebook)
      return
    }
    // A pending timer already holds this notebook object, so it will write the newest state.
    if (this.#pendingPersistence.has(sessionId)) return
    const timer = setTimeout(() => {
      this.#pendingPersistence.delete(sessionId)
      this.#write(sessionId, notebook)
    }, PERSIST_DELAY_MS)
    // A pending mirror write must never hold the host process open.
    if (typeof timer.unref === 'function') timer.unref()
    this.#pendingPersistence.set(sessionId, timer)
  }

  /** Write the mirror immediately, cancelling any scheduled write. */
  #flushPersistence(sessionId, notebook) {
    const timer = this.#pendingPersistence.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.#pendingPersistence.delete(sessionId)
    }
    this.#write(sessionId, notebook)
  }

  /** Serialize and atomically replace one notebook's mirror. */
  #write(sessionId, notebook) {
    try {
      mkdirSync(this.#directory, { recursive: true })
      const file = this.#file(sessionId)
      const temporary = `${file}.${process.pid}.tmp`
      // Compact on purpose: this file is machine state, and pretty-printing a base64 image costs
      // roughly twice the bytes and twice the time for no benefit.
      writeFileSync(temporary, JSON.stringify({
        cells: notebook.cells.map((cell) => ({ ...cell, status: 'idle', error: null })),
        path: notebook.path,
        revision: notebook.revision,
        updatedAt: new Date().toISOString(),
      }))
      renameSync(temporary, file)
    } catch {
      // A read-only or missing home directory must never break editing.
    }
  }

  /** Mirror file for a session. */
  #file(sessionId) {
    return path.join(this.#directory, `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  }

  /** Find a cell by id, or throw a message the UI can show. */
  #cell(notebook, id) {
    const cell = notebook.cells.find((candidate) => candidate.id === id)
    if (cell === undefined) throw new Error(`cell ${id} is not in this notebook`)
    return cell
  }

  /** Bump the revision every mutation so the client can tell states apart. */
  #touch(sessionId, notebook) {
    notebook.revision += 1
    this.#persist(sessionId, notebook)
  }

  /**
   * Render the notebook for the browser, including live kernel status.
   *
   * @param sessionId - Owning DSH session.
   * @param options - Extra top-level fields, such as connection state.
   * @returns The JSON payload the panel renders.
   */
  async view(sessionId, options = {}) {
    const notebook = this.#notebook(sessionId)
    let kernel
    try {
      kernel = await this.#kernelInfo?.(sessionId)
    } catch {
      kernel = undefined
    }
    return {
      sessionId,
      revision: notebook.revision,
      path: notebook.path,
      // A shallow copy per cell is enough: the route serializes this immediately, and a deep clone
      // would copy every base64 image a second time on the way to the socket.
      cells: notebook.cells.map((cell) => ({ ...cell })),
      ...(kernel === undefined ? {} : { kernel }),
      ...options,
    }
  }

  /**
   * The notebook's current revision, which is what the panel's cheap poll compares against.
   *
   * @param sessionId - Owning DSH session.
   * @returns The revision counter.
   */
  revision(sessionId) {
    return this.#notebook(sessionId).revision
  }

  /**
   * Apply one panel command.
   *
   * @param sessionId - Owning DSH session.
   * @param command - `{ action, ... }` as sent by the panel.
   * @param options - Extra fields merged into the returned view.
   * @returns The updated view.
   */
  async command(sessionId, command, options = {}) {
    const notebook = this.#notebook(sessionId)
    const action = String(command?.action ?? '')
    switch (action) {
      case 'addCell': {
        const cell = newCell(command.kind, command.source)
        const index = command.afterId === undefined ? notebook.cells.length : notebook.cells.findIndex((c) => c.id === command.afterId) + 1
        notebook.cells.splice(index <= 0 ? notebook.cells.length : index, 0, cell)
        this.#touch(sessionId, notebook)
        break
      }
      case 'updateCell': {
        const cell = this.#cell(notebook, command.id)
        if (typeof command.source === 'string') cell.source = command.source
        if (command.kind !== undefined && CELL_KINDS.has(command.kind)) cell.kind = command.kind
        this.#touch(sessionId, notebook)
        break
      }
      case 'deleteCell': {
        const index = notebook.cells.findIndex((c) => c.id === command.id)
        if (index === -1) throw new Error(`cell ${command.id} is not in this notebook`)
        notebook.cells.splice(index, 1)
        if (notebook.cells.length === 0) notebook.cells.push(newCell('code'))
        this.#touch(sessionId, notebook)
        break
      }
      case 'moveCell': {
        const index = notebook.cells.findIndex((c) => c.id === command.id)
        if (index === -1) throw new Error(`cell ${command.id} is not in this notebook`)
        const target = index + (command.delta < 0 ? -1 : 1)
        if (target < 0 || target >= notebook.cells.length) break
        const [cell] = notebook.cells.splice(index, 1)
        notebook.cells.splice(target, 0, cell)
        this.#touch(sessionId, notebook)
        break
      }
      case 'clearOutput': {
        const cell = this.#cell(notebook, command.id)
        cell.outputs = []
        cell.status = 'idle'
        cell.error = null
        this.#touch(sessionId, notebook)
        break
      }
      case 'clearAllOutputs': {
        for (const cell of notebook.cells) {
          cell.outputs = []
          cell.status = 'idle'
          cell.error = null
        }
        this.#touch(sessionId, notebook)
        break
      }
      case 'runCell': {
        const cell = this.#cell(notebook, command.id)
        // The editor sends its draft with the run, so `Shift+Enter` is one request instead of an
        // update followed by a run — every avoided round trip is a visible delay on a click.
        if (typeof command.source === 'string' && command.source !== cell.source) {
          cell.source = command.source
          notebook.revision += 1
        }
        cell.status = 'running'
        cell.outputs = []
        cell.error = null
        // Persist the source before running so a reload mid-execution keeps the edit. This write
        // is synchronous on purpose: the cell may run for minutes.
        this.#flushPersistence(sessionId, notebook)
        try {
          const execution = await this.#execute(sessionId, cell.source, { signal: options.signal })
          cell.status = execution.status === 'ok' ? 'ok' : execution.status
          cell.executionCount = execution.executionCount ?? null
          cell.durationMs = execution.durationMs ?? null
          cell.outputs = renderableOutputs(execution.outputs)
          // A non-ok DSH-side outcome (timeout, abort, disconnect) is worth showing next to the
          // cell even when the kernel produced no traceback of its own.
          if (execution.status !== 'ok' && execution.status !== 'error' && execution.message !== undefined) {
            cell.outputs.push({ type: 'error', text: execution.message })
          }
        } catch (error) {
          cell.status = 'error'
          cell.error = error instanceof Error ? error.message : String(error)
        }
        this.#touch(sessionId, notebook)
        break
      }
      case 'restartKernel':
      case 'interrupt':
      case 'startKernel': {
        const outcome = await this.#kernelCommand(action, sessionId, options)
        return await this.view(sessionId, { ...options, message: outcome })
      }
      case 'setPath': {
        notebook.path = command.path === undefined || command.path === null ? null : String(command.path)
        this.#touch(sessionId, notebook)
        break
      }
      case 'reset': {
        this.#notebooks.delete(sessionId)
        const timer = this.#pendingPersistence.get(sessionId)
        if (timer !== undefined) {
          clearTimeout(timer)
          this.#pendingPersistence.delete(sessionId)
        }
        try {
          unlinkSync(this.#file(sessionId))
        } catch {
          // Nothing to remove.
        }
        break
      }
      default:
        throw new Error(`unknown notebook action "${action}"`)
    }
    return await this.view(sessionId, options)
  }

  /** Delegate a kernel-level command; the caller injects the implementation. */
  #kernelCommand(action, sessionId, options) {
    if (this.#kernelAction === undefined) return 'kernel commands are unavailable'
    return this.#kernelAction(action, sessionId, options)
  }

  /** Kernel lifecycle commands, injected by the plugin (`jupyter_kernel`'s own verbs). */
  #kernelAction
  /**
   * Supply the kernel-lifecycle implementation.
   * @param handler - `(action, sessionId, options) => Promise<string>` returning a status message.
   */
  setKernelAction(handler) {
    this.#kernelAction = handler
  }

  /** How many notebooks are held in memory; used by tests. */
  get size() {
    return this.#notebooks.size
  }

  /** Mirror directory, for diagnostics. */
  get directory() {
    return this.#directory
  }

  /** Forget every in-memory notebook without touching the mirrors. */
  dispose() {
    // A scheduled write holds the newest edits; losing it on a plugin remount would undo them.
    for (const sessionId of [...this.#pendingPersistence.keys()]) {
      const notebook = this.#notebooks.get(sessionId)
      const timer = this.#pendingPersistence.get(sessionId)
      if (timer !== undefined) clearTimeout(timer)
      this.#pendingPersistence.delete(sessionId)
      if (notebook !== undefined) this.#write(sessionId, notebook)
    }
    this.#notebooks.clear()
  }
}

/** List mirrored notebook files; used by tests and diagnostics. */
export function listMirroredNotebooks(directory) {
  try {
    return readdirSync(directory).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}

/**
 * Whether a notebook's cell payload is big enough that serializing it on the click path hurts.
 *
 * Walks the payload lengths instead of stringifying, so the check itself is cheap: this runs on
 * every mutation, and the thing it is protecting against is exactly the cost of a stringify.
 *
 * @param notebook - The notebook record.
 * @returns True when the mirror should be deferred.
 */
function isHeavy(notebook) {
  let total = 0
  for (const cell of notebook.cells) {
    total += cell.source.length
    for (const output of cell.outputs ?? []) {
      total += output.text?.length ?? 0
      total += output.dataUrl?.length ?? 0
    }
    if (total > HEAVY_MIRROR_BYTES) return true
  }
  return false
}
