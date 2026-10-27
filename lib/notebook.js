/**
 * The notebook model behind the right-side panel.
 *
 * A notebook is a list of cells owned by one DeepSeek Harness session. Running a cell sends its
 * code to **the same kernel the agent uses** for that session, so the user and the agent share one
 * namespace: a variable defined in a cell is visible to `jupyter_execute`, and vice versa.
 *
 * **A page is bound to a server.** One session can be connected to several Jupyter servers at once
 * (a local one and a remote one), so every notebook record carries a `server` key — the normalised
 * base URL of the connection its code runs on — or `null`, meaning "follow the default connection".
 * Executions, kernel status and kernel lifecycle commands all receive that key, which is what makes
 * two pages of the same desk run against two different host processes. The panel can add
 * (token/password) and forget connections without restarting the host; the registry itself lives
 * behind the injected `servers` / `connectServer` / `forgetServer` callbacks, so this model can be
 * tested without a network and never touches a credential. Secrets stay host-side: the view only
 * ever carries a key, a URL, a label and an auth mode.
 *
 * The model is deliberately separate from the HTTP routes that expose it, so it can be tested
 * without a browser, and separate from the kernel client, so a run is just an injected async
 * function.
 *
 * **A run is owned by the model, not by a request.** Clicking Run starts the execution and answers
 * immediately; output arrives through {@link Notebooks.subscribe} as it is produced, and the final
 * state is written back into the cell regardless of whether anyone is still listening. That is what
 * lets a 60-second cell show its first line after a second, and what keeps a page reload from
 * cancelling work the user asked for.
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

import { ipynbToCells, notebookToIpynb } from './ipynb.js'

/** Rich outputs sent to the browser: enough for a plot, small enough to keep the payload sane. */
const MAX_IMAGES_PER_CELL = 8
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_TEXT_PER_CELL = 200_000
/**
 * Largest `text/html` bundle forwarded to the panel.
 *
 * A DataFrame is a few kilobytes; a Styler over a large frame or a library that renders a whole
 * figure as markup can be megabytes, and that would be re-sent with every full view. Past the cap
 * the plain-text repr is shown instead, which is smaller and still readable.
 */
const MAX_HTML_BYTES = 256 * 1024

/** What a cell's text is cut off with once its budget is spent. */
const TRUNCATION_MARK = '\n… [truncated]'

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

/** Longest name a notebook may have, in characters. */
const NOTEBOOK_NAME_MAX = 40

/**
 * How many notebooks one session may hold.
 *
 * A cap rather than a limit on the UI: every notebook is a document in one mirror file, and an
 * unbounded list would make that file grow with abandoned pages nobody can find again.
 */
const MAX_NOTEBOOKS = 12

/**
 * A fresh notebook record.
 * @param name - Its name in the session's desk.
 * @param server - Key of the connection its code runs on; `null` follows the default connection.
 */
function freshNotebook(name = 'main', server = null) {
  return { name, cells: [newCell('code')], path: null, revision: 0, server }
}

/** A fresh session: one empty notebook, shown. */
function freshDesk() {
  return { active: 'main', docs: new Map([['main', freshNotebook('main')]]) }
}

/** Restore one stored cell: unknown fields survive, live state does not. */
function hydrateCell(cell) {
  return { ...newCell(cell.kind, cell.source, cell.origin), ...cell, status: 'idle', error: null }
}

/**
 * A name no notebook in the desk is using.
 *
 * The user does not type names — the panel asks for a new notebook and gets one — so the only job
 * here is to keep "Untitled", "Untitled 2", … distinct without asking anyone.
 */
function uniqueName(desk, requested) {
  const cleaned = String(requested ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, NOTEBOOK_NAME_MAX)
  const base = cleaned.length > 0 ? cleaned : 'Untitled'
  if (!desk.docs.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`
    if (!desk.docs.has(candidate)) return candidate
  }
  return `${base} ${Date.now()}`
}

/**
 * Shape of one cell as the browser sees it.
 *
 * @typedef {object} CellView
 * @property {string} id - Stable cell id.
 * @property {'code'|'markdown'} kind - Cell language.
 * @property {'user'|'agent'} origin - Who created the cell. The panel marks agent cells so a
 *   conversation's work is distinguishable from the user's own edits; it changes nothing else.
 * @property {string} source - Cell text.
 * @property {string|null} previousSource - What the source was before the model last rewrote it.
 *   Set only for a change the agent made through `jupyter_notebook`, so the panel can show what it
 *   did instead of silently swapping the text under the user. Cleared by the user's next edit, by
 *   `dismissDiff`, and by `revertCell`.
 * @property {number} rev - Per-cell revision: changes whenever the cell does. The panel uses it to
 *   keep the object identity of untouched cells, which is what makes `React.memo` worthwhile.
 * @property {'idle'|'running'|'ok'|'error'|'aborted'} status - Last run outcome.
 * @property {number|null} executionCount - Kernel execution counter, when reported.
 * @property {number|null} durationMs - How long the last run took.
 * @property {Array<object>} outputs - Renderable outputs, newest run only.
 * @property {string|null} error - Failure of the DSH-side call (not the cell's own traceback).
 */

/** A new, empty code cell. */
function newCell(kind = 'code', source = '', origin = 'user') {
  return {
    id: randomUUID(),
    kind: CELL_KINDS.has(kind) ? kind : 'code',
    origin: origin === 'agent' ? 'agent' : 'user',
    source: String(source ?? ''),
    // Only a change *to an existing cell* has a previous source; a fresh cell has nothing to diff.
    previousSource: null,
    rev: 0,
    status: 'idle',
    executionCount: null,
    durationMs: null,
    outputs: [],
    error: null,
  }
}

/**
 * Turn a run's normalized outputs into renderable entries in one pass.
 *
 * Kept as a function because it is the reference behaviour: {@link OutputRenderer} produces the
 * same result incrementally, and the two are covered by the same tests.
 *
 * @param outputs - Entries from the kernel connection.
 * @param options - Rendering controls.
 * @param options.asset - `(mime, base64) => { url } | undefined`; without it images are inlined as
 *   data URLs, which is only appropriate for a one-off payload, never for a document that is
 *   re-sent on every click.
 * @returns Browser-renderable output entries.
 */
export function renderableOutputs(outputs = [], options = {}) {
  const renderer = new OutputRenderer(options)
  for (const output of outputs) renderer.push(output)
  return renderer.finish()
}

/** Keep at most `limit` characters, saying how many were dropped. */
function clip(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… [${value.length - limit} characters omitted]`
}

/** The visible text of an HTML fragment, for a model that wants to read a rendered table. */
function stripMarkup(html) {
  return String(html ?? '')
    .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Summarize stored outputs as the text a model can read.
 *
 * The cell keeps renderable entries, not kernel messages: a `text/html` table has no plain-text
 * twin by the time it is stored, so markup is stripped rather than skipped — otherwise reading a
 * cell that printed a DataFrame would report nothing at all.
 */
function summarizeCellOutputs(outputs, limit) {
  const parts = []
  for (const output of outputs ?? []) {
    if (output.type === 'image') parts.push(`[${output.mime ?? 'image'} image]`)
    else if (output.type === 'html') {
      const text = stripMarkup(output.text)
      parts.push(text.length > 0 ? text : '[text/html output]')
    } else if (typeof output.text === 'string') parts.push(output.text)
  }
  return clip(parts.join('\n').trim(), limit)
}

/**
 * A patch the panel can apply without re-reading the cell.
 *
 * @typedef {{kind:'append', output: object}|{kind:'text', index: number, text: string}} OutputPatch
 */

/**
 * Incremental renderer for one cell's outputs.
 *
 * Streaming needs the panel's view to grow as the kernel produces bytes, which rules out rendering
 * the whole list at the end. It also rules out *appending one entry per iopub message*: a loop that
 * prints in a thousand chunks would become a thousand `<pre>` elements and a thousand reflows.
 * Consecutive chunks of the same stream are therefore merged into one entry, and the caller is told
 * exactly what changed.
 */
export class OutputRenderer {
  /** Renderable entries, in arrival order. Handed straight to the cell. */
  outputs = []
  /** Decoded images already emitted for this cell. */
  #images = 0
  /** Characters of text still allowed. */
  #budget = MAX_TEXT_PER_CELL
  /** Whether anything was dropped, so `finish()` can say so once. */
  #truncated = false
  #asset

  /**
   * @param options - Rendering controls.
   * @param options.asset - `(mime, base64) => { url } | undefined` image store, when available.
   */
  constructor({ asset } = {}) {
    this.#asset = asset
  }

  /** Drop everything rendered so far; the kernel asked to clear its output. */
  clear() {
    this.outputs = []
    this.#images = 0
    this.#budget = MAX_TEXT_PER_CELL
    this.#truncated = false
  }

  /**
   * Render one kernel output, mutating {@link OutputRenderer#outputs}.
   *
   * @param output - Normalized kernel output, or `{ kind: 'clear' }`.
   * @returns The patches describing the change, if any.
   */
  push(output) {
    switch (output.kind) {
      case 'stream':
        return this.#text({
          type: 'stream',
          name: output.name === 'stderr' ? 'stderr' : 'stdout',
          text: String(output.text ?? ''),
        })
      case 'error': {
        const traceback = Array.isArray(output.traceback) && output.traceback.length > 0
          ? output.traceback.join('\n')
          : `${output.ename ?? 'Error'}: ${output.evalue ?? ''}`
        // eslint-disable-next-line no-control-regex
        return this.#text({ type: 'error', text: traceback.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '') })
      }
      case 'result':
      case 'display':
        return this.#bundle(output)
      default:
        return undefined
    }
  }

  /**
   * Finish rendering: mark truncated text once, and hand back the list.
   *
   * @returns The renderable outputs.
   */
  finish() {
    if (this.#truncated) {
      const last = this.outputs[this.outputs.length - 1]
      if (last !== undefined && typeof last.text === 'string' && !last.text.endsWith(TRUNCATION_MARK)) {
        last.text += TRUNCATION_MARK
      }
    }
    return this.outputs
  }

  /** Render a text-bearing output, merging consecutive streams from the same channel. */
  #text(entry) {
    const last = this.outputs[this.outputs.length - 1]
    if (entry.type === 'stream' && last?.type === 'stream' && last.name === entry.name) {
      return this.#appendText(last, entry.text, this.outputs.length - 1)
    }
    if (this.#budget <= 0) {
      this.#truncated = true
      return undefined
    }
    const fresh = { ...entry, text: '' }
    this.outputs.push(fresh)
    return this.#appendText(fresh, entry.text, this.outputs.length - 1)
  }

  /** Move text into one entry, respecting the cell's remaining budget. */
  #appendText(target, text, index) {
    if (text.length === 0) return undefined
    if (this.#budget <= 0) {
      this.#truncated = true
      return undefined
    }
    const allowed = text.length > this.#budget ? text.slice(0, this.#budget) : text
    if (allowed.length < text.length) this.#truncated = true
    target.text += allowed
    this.#budget -= allowed.length
    return [{ kind: 'text', index, text: allowed }]
  }

  /** Render a MIME bundle: its richest representation the panel can draw, plus its images. */
  #bundle(output) {
    const data = output.data ?? {}
    const plain = typeof data['text/plain'] === 'string' ? data['text/plain'] : undefined
    const patches = []
    let image
    for (const mime of RENDERABLE_IMAGES) {
      const payload = data[mime]
      if (typeof payload !== 'string' || this.#images >= MAX_IMAGES_PER_CELL) continue
      if (payload.length > MAX_IMAGE_BYTES) {
        patches.push(...(this.#text({ type: 'text', text: `[${mime} output omitted: ${Math.round(payload.length / 1024)} KiB]` }) ?? []))
        continue
      }
      this.#images += 1
      const base64 = payload.replace(/\s+/g, '')
      const stored = this.#asset?.(mime, base64)
      // With a store the cell keeps a URL that the browser caches forever; without one the bytes
      // ride along inside the notebook document.
      image = stored === undefined
        ? { type: 'image', mime, dataUrl: `data:${mime};base64,${base64}` }
        : { type: 'image', mime, url: stored.url }
      break
    }
    if (image !== undefined) {
      // A figure's own `<Figure size …>` repr is what a text-only client sees; keep it, then the
      // picture — the pair is what a notebook has always shown.
      if (plain !== undefined && plain.trim().length > 0) patches.push(...(this.#text({ type: 'text', text: plain }) ?? []))
      this.outputs.push(image)
      patches.push({ kind: 'append', output: image })
      return patches.length === 0 ? undefined : patches
    }

    // No picture: prefer markup the panel can render. `text/html` is what pandas, polars, and
    // Styler produce; `text/markdown` is what IPython.display.Markdown and many libraries produce.
    const html = typeof data['text/html'] === 'string' ? data['text/html'] : undefined
    if (html !== undefined && html.trim().length > 0) {
      if (html.length <= MAX_HTML_BYTES && html.length <= this.#budget) {
        return [...patches, ...(this.#rich('html', html) ?? [])]
      }
      patches.push(...(this.#text({ type: 'text', text: `[text/html output omitted: ${Math.round(html.length / 1024)} KiB — showing the plain text]` }) ?? []))
    }
    const markdown = typeof data['text/markdown'] === 'string' ? data['text/markdown'] : undefined
    if (markdown !== undefined && markdown.trim().length > 0) {
      if (markdown.length <= this.#budget) return [...patches, ...(this.#rich('markdown', markdown) ?? [])]
      patches.push(...(this.#text({ type: 'text', text: markdown }) ?? []))
      return patches.length === 0 ? undefined : patches
    }
    if (plain !== undefined && plain.trim().length > 0) {
      patches.push(...(this.#text({ type: 'text', text: plain }) ?? []))
    } else if (output.kind === 'display') {
      const summary = Object.keys(data).join(', ')
      if (summary.length > 0) patches.push(...(this.#text({ type: 'text', text: `[${summary} output]` }) ?? []))
    }
    return patches.length === 0 ? undefined : patches
  }

  /**
   * Push a rich output that arrives whole (html or markdown) and report it as one append.
   *
   * These are not streamed: the kernel sends a MIME bundle in one message, and a half-written
   * `<table>` is not worth rendering. They still draw on the cell's text budget, so one cell
   * cannot flood the panel with markup.
   */
  #rich(type, text) {
    if (this.#budget <= 0) {
      this.#truncated = true
      return undefined
    }
    const output = { type, text }
    this.#budget -= text.length
    this.outputs.push(output)
    return [{ kind: 'append', output }]
  }
}

/**
 * One spelling of a server address, reduced to what two spellings of the same server share.
 *
 * A connection's identity is `normalizeJupyterUrl(url).baseUrl` (`http://host:9002`), but the panel
 * and the tools may hand back that string with a trailing slash, with the `/lab` application path,
 * or without a scheme. Normalising properly is the registry's job (`lib/connections.js`); this is
 * only enough to match a spelling against the describe list the panel model is given, and it is
 * deliberately conservative — no lower-casing, because a gateway prefix can be case-sensitive.
 */
function serverSpelling(url) {
  const trimmed = String(url ?? '').trim().replace(/\/+$/, '')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/(?:lab|tree|notebooks)(?:\/.*)?$/i, '').replace(/\/+$/, '')
}

/** One session's notebooks, and which of them the panel is showing. */
export class Notebooks {
  /** @type {Map<string, {active: string, docs: Map<string, {name: string, cells: object[], path: string|null, revision: number, server: string|null}>}>} */
  #notebooks = new Map()
  /** Notebooks whose mirror write is scheduled, keyed by session. */
  #pendingPersistence = new Map()
  /** Streaming listeners, keyed by session. */
  #listeners = new Map()
  /** Runs still in flight, keyed by session, so tests and `dispose` can wait for them. */
  #runs = new Map()
  /**
   * Sequences of "run every cell" still going, keyed by session.
   *
   * The value is the stop flag the loop checks between cells: an interrupt has to stop the *next*
   * cell too, otherwise interrupting one cell of a run-all only makes the following one start.
   */
  #runningAll = new Map()
  /** @type {string} */
  #directory
  /** Executes code in the session's kernel; injected so tests can drive the model directly. */
  #execute
  /** Reports the session's kernel, for the panel's status row. */
  #kernelInfo
  /** Image store, when the host half provided one. */
  #asset
  /** Reads an image back out of the store, for `.ipynb` export. */
  #readAsset
  /** Buffer of user activity destined for the model, when the host half provided one. */
  #activity
  /**
   * The connection registry, as `() => {configured, default, servers}`.
   *
   * A function rather than a snapshot: the panel adds and forgets connections while it is open, and
   * a view rendered a second later must not describe the world from before the change.
   */
  #servers
  /** `async (patch) => {key, url, authMode, version?, kernelspecs}`; adds and probes a connection. */
  #connectServer
  /** `async (server) => {key, url, removed}`; forgets a connection without touching the desk. */
  #forgetServer

  /**
   * @param options - Wiring.
   * @param options.directory - Directory for the on-disk mirror; defaults under `$DSH_HOME`.
   * @param options.execute - `(sessionId, code, options) => Promise<execution result>`; `options.server`
   *   is the resolved key of the page's connection (undefined when none is configured).
   * @param options.kernelInfo - `(sessionId, {server}) => Promise<{id, name, state}|undefined>`.
   * @param options.asset - `(mime, base64) => { url } | undefined` image store.
   * @param options.readAsset - `(name) => {mime, data}` reverse lookup, for export.
   * @param options.activity - `{ record(sessionId, event), pending(sessionId) }` context buffer.
   * @param options.servers - `() => ({configured, default, servers})`; the describe list carries no
   *   secret. Absent in tests and in headless hosts: the panel then offers no connection at all.
   * @param options.connectServer - `async (patch)`; patch is `{url, token?, password?, username?,
   *   kernelName?}`. The token never comes back: only a key, URL motion and probes do.
   * @param options.forgetServer - `async (server) => {key, url, removed}`.
   */
  constructor({
    directory, execute, kernelInfo, asset, readAsset, activity,
    servers, connectServer, forgetServer,
  } = {}) {
    this.#directory = directory ?? path.join(
      process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
      'jupyterlab',
      'notebooks',
    )
    this.#execute = execute
    this.#kernelInfo = kernelInfo
    this.#asset = asset
    this.#readAsset = readAsset
    this.#activity = activity
    this.#servers = servers
    this.#connectServer = connectServer
    this.#forgetServer = forgetServer
  }

  /**
   * The connection registry as the panel model needs it: a default key plus a describe list.
   *
   * Read live on every call, and projected to the fields the contract allows: the registry is the
   * host's, but the view is the browser's, and a stray credential in a describe entry would be a
   * token on the wire. Defensive mapping here means that cannot happen by accident.
   */
  #registry() {
    let info
    try {
      info = this.#servers?.()
    } catch {
      info = undefined
    }
    const servers = []
    for (const entry of Array.isArray(info?.servers) ? info.servers : []) {
      const key = typeof entry?.key === 'string' && entry.key.length > 0
        ? entry.key
        : (typeof entry?.url === 'string' && entry.url.length > 0 ? entry.url : undefined)
      if (key === undefined) continue
      servers.push({
        key,
        url: typeof entry?.url === 'string' && entry.url.length > 0 ? entry.url : key,
        // The panel shows this instead of the raw address; the address stays in the tooltip.
        ...(typeof entry?.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {}),
        label: typeof entry?.label === 'string' && entry.label.length > 0 ? entry.label : key,
        authMode: entry?.authMode === 'token' || entry?.authMode === 'password' || entry?.authMode === 'cookie'
          ? entry.authMode
          : 'none',
        hasCredentials: entry?.hasCredentials === true,
        default: entry?.default === true,
      })
    }
    const requested = typeof info?.default === 'string' && info.default.length > 0 ? info.default : undefined
    return {
      configured: info?.configured === true || servers.length > 0,
      defaultServer: requested ?? servers.find((entry) => entry.default === true)?.key,
      servers,
    }
  }

  /**
   * Resolve one page's connection: the page's own binding wins, `null` follows the default.
   *
   * `connected` is deliberately separate from `key`: a page bound to a connection somebody forgot
   * still renders (and still reports the key it was bound to), it just cannot run — the host's
   * execution layer answers with a readable "not configured" error instead of quietly running on
   * the default server, which is the one thing a user must never see happen.
   *
   * @param notebook - The notebook record, when one exists.
   * @returns `{key, url, connected, registry}`; `key`/`url` are null when nothing is configured.
   */
  #pageServer(notebook) {
    const registry = this.#registry()
    const bound = typeof notebook?.server === 'string' && notebook.server.length > 0 ? notebook.server : null
    const key = bound ?? registry.defaultServer ?? null
    // An exact key match is the normal case; the spelling comparison only repairs a mirror whose
    // key was written by an older/simpler normaliser (a trailing slash, a `/lab` path). The
    // registry's key wins when they differ, so the run reaches the connection that exists.
    const entry = key === null
      ? undefined
      : registry.servers.find((candidate) => candidate.key === key)
        ?? registry.servers.find((candidate) => serverSpelling(candidate.key) === serverSpelling(key))
    const resolved = entry?.key ?? key
    return {
      key: resolved,
      // The key *is* the normalised base URL, so a forgotten connection is still nameable. Only a
      // page with no binding at all — nothing configured anywhere — has no URL to show.
      url: resolved === null ? null : (entry?.url ?? resolved),
      connected: entry !== undefined,
      registry,
    }
  }

  /**
   * Turn a key or URL spelling into the key of a live connection, or fail readably.
   *
   * The panel sends the picker's value (a key), but a URL with `/lab`, a trailing slash or no scheme
   * is the same server; matching through {@link serverSpelling} keeps that promise. The registry
   * does the authoritative normalisation — this only has to agree with its describe list.
   */
  #matchServer(registry, value) {
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error('a server is required')
    const wanted = serverSpelling(value)
    const match = registry.servers.find((entry) =>
      serverSpelling(entry.key) === wanted || serverSpelling(entry.url) === wanted)
    if (match === undefined) throw new Error(`"${value.trim()}" is not a connected Jupyter server`)
    return match
  }

  /**
   * Tell the model what the user just did in the panel.
   *
   * Best effort by design: a note is a courtesy to the next model step, and no edit may fail
   * because the buffer threw.
   */
  #note(sessionId, event) {
    try {
      this.#activity?.record(sessionId, event)
    } catch {
      // Deliberately ignored.
    }
  }

  /** How many panel actions are waiting to be handed to the model. */
  pendingNotes(sessionId) {
    try {
      return this.#activity?.pending(sessionId) ?? 0
    } catch {
      return 0
    }
  }

  /** The pending notes themselves, so the badge can be opened instead of guessed at. */
  pendingNoteList(sessionId) {
    try {
      return this.#activity?.list?.(sessionId) ?? []
    } catch {
      return []
    }
  }

  /** Throw away everything queued for the model. */
  discardNotes(sessionId) {
    try {
      this.#activity?.forget?.(sessionId)
    } catch {
      // A missing buffer is not a failure.
    }
  }

  /**
   * Watch every change to one session's notebook.
   *
   * Events are deliberately small: a run start or end sends the cell, and the output produced in
   * between arrives as `append` / `text` / `clear` deltas. A `cell` event at the end carries the
   * authoritative final state, so a client that dropped a delta repairs itself.
   *
   * @param sessionId - Owning DSH session.
   * @param listener - Called with `{ type, revision, ... }`.
   * @returns Unsubscribe function.
   */
  subscribe(sessionId, listener) {
    let listeners = this.#listeners.get(sessionId)
    if (listeners === undefined) {
      listeners = new Set()
      this.#listeners.set(sessionId, listeners)
    }
    listeners.add(listener)
    return () => {
      const current = this.#listeners.get(sessionId)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.#listeners.delete(sessionId)
    }
  }

  /**
   * Wait for every run of one session to finish.
   *
   * @param sessionId - Owning DSH session.
   * @returns A promise resolved when nothing is executing.
   */
  async idle(sessionId) {
    const runs = this.#runs.get(sessionId)
    if (runs === undefined || runs.size === 0) return
    await Promise.all([...runs])
  }

  /** Whether a cell is executing right now. */
  isRunning(sessionId) {
    return (this.#runs.get(sessionId)?.size ?? 0) > 0
  }

  /**
   * Whether a "run every cell" sequence is still going.
   *
   * Different from {@link Notebooks.isRunning}: between two cells of a sequence nothing is
   * executing, yet the sequence owns the queue and the panel must still offer a stop. The answer
   * is scoped to the notebook the sequence belongs to: after a switch the panel is looking at a
   * different page, and a stop button for work it cannot see would be a riddle.
   */
  isRunningAll(sessionId) {
    const state = this.#runningAll.get(sessionId)
    if (state === undefined) return false
    return state.notebook === this.#peek(sessionId)?.name
  }

  /** Deliver one event to every listener, without letting one of them break the others. */
  #emit(sessionId, event) {
    const listeners = this.#listeners.get(sessionId)
    if (listeners === undefined) return
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // A dead stream is removed by its own abort handler, not by failing this one.
      }
    }
  }

  /**
   * The session's desk, loading it from disk on first use.
   *
   * A desk is everything one conversation's panel can hold: several notebooks and the name of the
   * one on screen. Keeping the active pointer on the host — rather than in every request — is what
   * lets "cell 3" mean the same thing to the panel, the model and a run that is already in flight.
   *
   * @param sessionId - Owning DSH session.
   * @returns The mutable desk record.
   */
  #desk(sessionId) {
    let desk = this.#notebooks.get(sessionId)
    if (desk === undefined) {
      desk = this.#load(sessionId)
      this.#notebooks.set(sessionId, desk)
    }
    return desk
  }

  /**
   * The notebook the panel is showing, creating a session if needed.
   *
   * @param sessionId - Owning DSH session.
   * @returns The mutable notebook record.
   */
  #notebook(sessionId) {
    const desk = this.#desk(sessionId)
    return desk.docs.get(desk.active)
  }

  /** The active notebook without creating one, for readers that must not have side effects. */
  #peek(sessionId) {
    const desk = this.#notebooks.get(sessionId)
    return desk === undefined ? undefined : desk.docs.get(desk.active)
  }

  /** Restore a mirrored desk, or start one with a single empty notebook. */
  #load(sessionId) {
    try {
      const raw = JSON.parse(readFileSync(this.#file(sessionId), 'utf8'))
      // The current shape: several notebooks and the active name.
      if (raw !== null && typeof raw === 'object' && raw.notebooks !== null && typeof raw.notebooks === 'object') {
        const docs = new Map()
        for (const [name, doc] of Object.entries(raw.notebooks)) {
          if (!Array.isArray(doc?.cells)) continue
          docs.set(name, {
            name,
            cells: doc.cells.map(hydrateCell),
            path: typeof doc.path === 'string' ? doc.path : null,
            revision: Number.isFinite(doc.revision) ? doc.revision : 0,
            // A mirror written before servers were bindable has no `server`; following the default
            // connection is exactly what the single-server behaviour was.
            server: typeof doc.server === 'string' && doc.server.length > 0 ? doc.server : null,
          })
        }
        if (docs.size > 0) {
          return { active: docs.has(raw.active) ? raw.active : [...docs.keys()][0], docs }
        }
      }
      // A mirror written before a session could hold more than one: it is the `main` notebook.
      if (Array.isArray(raw?.cells)) {
        return {
          active: 'main',
          docs: new Map([['main', {
            name: 'main',
            cells: raw.cells.map(hydrateCell),
            path: typeof raw.path === 'string' ? raw.path : null,
            revision: Number.isFinite(raw.revision) ? raw.revision : 0,
            server: null,
          }]]),
        }
      }
    } catch {
      // No mirror yet, or it is unreadable: a fresh notebook is the correct fallback.
    }
    return freshDesk()
  }

  /** Best-effort mirror of one session: immediate when cheap, coalesced when heavy. */
  #persist(sessionId, notebook) {
    if (!isHeavy(notebook)) {
      this.#flushPersistence(sessionId)
      return
    }
    // A pending timer already holds this notebook object, so it will write the newest state.
    if (this.#pendingPersistence.has(sessionId)) return
    const timer = setTimeout(() => {
      this.#pendingPersistence.delete(sessionId)
      this.#write(sessionId)
    }, PERSIST_DELAY_MS)
    // A pending mirror write must never hold the host process open.
    if (typeof timer.unref === 'function') timer.unref()
    this.#pendingPersistence.set(sessionId, timer)
  }

  /** Write the mirror immediately, cancelling any scheduled write. */
  #flushPersistence(sessionId) {
    const timer = this.#pendingPersistence.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.#pendingPersistence.delete(sessionId)
    }
    this.#write(sessionId)
  }

  /** Serialize and atomically replace one session's mirror. */
  #write(sessionId) {
    const desk = this.#notebooks.get(sessionId)
    if (desk === undefined) return
    try {
      mkdirSync(this.#directory, { recursive: true })
      const file = this.#file(sessionId)
      const temporary = `${file}.${process.pid}.tmp`
      // One file per session, every notebook in it: the active pointer has to be written atomically
      // with the documents, or a crash between two files would open the wrong page.
      const notebooks = {}
      for (const [name, doc] of desk.docs) {
        notebooks[name] = {
          cells: doc.cells.map((cell) => ({ ...cell, status: 'idle', error: null })),
          path: doc.path,
          revision: doc.revision,
          // Which connection this page runs on travels with the page, not with the process: after a
          // restart, reopening the panel must not silently move the user's notebook to another
          // server. `null` means "follow the default", and is written as such.
          server: typeof doc.server === 'string' && doc.server.length > 0 ? doc.server : null,
        }
      }
      // Compact on purpose: this file is machine state, and pretty-printing a base64 image costs
      // roughly twice the bytes and twice the time for no benefit.
      writeFileSync(temporary, JSON.stringify({
        active: desk.active,
        notebooks,
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
   * The connection fields are part of the view, not a separate endpoint: the header's server picker,
   * the "not connected" row and the kernel status row are all rendered from one payload, and a
   * second optional request would let them disagree for a frame.
   *
   * @param sessionId - Owning DSH session.
   * @param options - Extra top-level fields, such as connection state.
   * @returns The JSON payload the panel renders.
   */
  async view(sessionId, options = {}) {
    const desk = this.#desk(sessionId)
    const notebook = desk.docs.get(desk.active)
    const page = this.#pageServer(notebook)
    let kernel
    try {
      kernel = await this.#kernelInfo?.(sessionId, { server: page.key ?? undefined })
    } catch {
      kernel = undefined
    }
    const notes = this.pendingNoteList(sessionId)
    return {
      sessionId,
      // Which page the panel is on, and what else this session holds. Both are needed by the
      // picker: the name is what the client compares before it trusts a revision.
      notebook: notebook.name,
      notebooks: [...desk.docs.keys()],
      // Which connection this page runs on, and everything the picker can offer. `server` is the
      // resolved key (`doc.server` or the registry default), so a page that follows the default
      // still tells the client exactly which host its next run will reach.
      server: page.key,
      serverUrl: page.url,
      serverConnected: page.connected,
      defaultServer: page.registry.defaultServer ?? null,
      configured: page.registry.configured,
      // Describe entries only: key, URL, label, auth mode. A credential never becomes a view field.
      servers: page.registry.servers,
      revision: notebook.revision,
      path: notebook.path,
      // A sequence that is between two cells still has to show its stop button, and that state
      // changes without a revision bump.
      runningAll: this.isRunningAll(sessionId),
      // A shallow copy per cell is enough: the route serializes this immediately, and a deep clone
      // would copy every base64 image a second time on the way to the socket.
      cells: notebook.cells.map((cell) => ({ ...cell })),
      ...(kernel === undefined ? {} : { kernel }),
      // Only present when there is something to say, so the steady-state payload stays unchanged.
      ...(notes.length > 0 ? { pendingNotes: notes.length, notes } : {}),
      ...options,
    }
  }

  /**
   * Where one page's code runs, for callers that need the key without the whole view.
   *
   * The tools use this as their default server, so the model's `jupyter_execute` lands in the same
   * kernel the user is looking at. A peek on purpose: reading this must not create a desk, and a
   * session that never opened a panel has no page to speak for.
   *
   * @param sessionId - Owning DSH session.
   * @returns `{key, url, connected}`, or undefined when the session has no page or no connection.
   */
  activeServer(sessionId) {
    const notebook = this.#peek(sessionId)
    if (notebook === undefined) return undefined
    const page = this.#pageServer(notebook)
    if (page.key === null) return undefined
    return { key: page.key, url: page.url, connected: page.connected }
  }

  /**
   * A compact, synchronous view of the notebook for the model.
   *
   * Deliberately not {@link Notebooks.view}: that one asks the kernel for its status, which is a
   * network round trip a tool call does not need, and it carries image URLs. This one is bounded
   * per cell so a notebook with a megabyte of output cannot flood the transcript.
   *
   * @param sessionId - Owning DSH session.
   * @param options - Windowing and truncation.
   * @returns `{notebook, revision, path, server, total, cells}`; `cells` is empty before the panel
   *   has been used, and `server` is the page's server URL (null when none is known).
   */
  snapshot(sessionId, { from = 1, count = 40, maxSource = 2000, maxOutput = 1200 } = {}) {
    const notebook = this.#peek(sessionId)
    if (notebook === undefined) return { notebook: null, revision: 0, path: null, server: null, total: 0, cells: [] }
    const start = Math.max(0, Math.trunc(from) - 1)
    const size = Math.max(1, Math.trunc(count))
    return {
      notebook: notebook.name,
      revision: notebook.revision,
      path: notebook.path,
      // Which host the cells last ran on: two pages of one desk can be two different servers, and a
      // summary that omitted this would let the model assume the variables are shared.
      server: this.#pageServer(notebook).url,
      total: notebook.cells.length,
      cells: notebook.cells.slice(start, start + size).map((cell, offset) => {
        const source = String(cell.source ?? '')
        return {
          index: start + offset + 1,
          id: cell.id,
          kind: cell.kind,
          origin: cell.origin ?? 'user',
          rev: cell.rev,
          status: cell.status,
          // Omitted rather than null: the model-facing schema says integer, and "never run" is
          // already carried by `status: 'idle'` and the absent execution count.
          ...(cell.executionCount === null || cell.executionCount === undefined ? {} : { executionCount: cell.executionCount }),
          ...(cell.durationMs === null || cell.durationMs === undefined ? {} : { durationMs: cell.durationMs }),
          source: clip(source, maxSource),
          sourceTruncated: source.length > maxSource,
          output: summarizeCellOutputs(cell.outputs, maxOutput),
        }
      }),
    }
  }

  /**
   * One line per cell, attached to the first context note of a session.
   *
   * @param sessionId - Owning DSH session.
   * @returns A short map of the notebook, or undefined when there is nothing to describe.
   */
  outline(sessionId) {
    const notebook = this.#peek(sessionId)
    if (notebook === undefined) return undefined
    // The first line has to say which server the cell numbers belong to: cell 3 of a second page is
    // a different kernel, and a model that assumed one namespace would reason about stale variables.
    const page = this.#pageServer(notebook)
    const where = page.url === null
      ? ''
      : page.connected
        ? `, running on ${page.url}`
        : `, bound to ${page.url} (not connected)`
    const lines = [`The notebook "${notebook.name}" this session's panel currently holds (revision ${notebook.revision}${where}):`]
    notebook.cells.forEach((cell, index) => {
      const first = String(cell.source ?? '').split('\n').map((line) => line.trim()).find((line) => line.length > 0)
      const label = first === undefined ? '(empty)' : (first.length > 80 ? `${first.slice(0, 79)}…` : first)
      const bits = [`[${cell.kind}${cell.origin === 'agent' ? ', agent' : ''}]`]
      if (cell.executionCount !== null && cell.executionCount !== undefined) bits.push(`Out[${cell.executionCount}]`)
      if ((cell.outputs ?? []).length > 0) bits.push(`${cell.outputs.length} output block(s)`)
      lines.push(`${index + 1}. ${bits.join(' ')} ${label}`)
    })
    return lines.join('\n')
  }

  /**
   * Create a cell for a run the model is about to perform.
   *
   * The panel and the agent share one kernel, but until now only the user's half of the
   * conversation left a trace there. Recording the model's runs makes the notebook a complete
   * record of the analysis instead of a document with holes in it. The cell is inserted before
   * execution and filled as output arrives, exactly like a user's run.
   *
   * @param sessionId - Owning DSH session.
   * @param source - Code about to run.
   * @returns A recorder: `{cellId, onOutput, finish, fail}`.
   */
  beginAgentRun(sessionId, source) {
    const notebook = this.#notebook(sessionId)
    const cell = newCell('code', source, 'agent')
    cell.status = 'running'
    cell.rev = 1
    notebook.cells.push(cell)
    this.#touch(sessionId, notebook)
    this.#emit(sessionId, {
      type: 'insert',
      revision: notebook.revision,
      index: notebook.cells.length - 1,
      cell: { ...cell },
    })
    const renderer = new OutputRenderer({ asset: this.#asset })
    cell.outputs = renderer.outputs
    const stream = this.#streamInto(sessionId, cell, renderer)
    return {
      cellId: cell.id,
      onOutput: stream,
      finish: (execution) => {
        this.#settle(sessionId, notebook, cell, execution)
        return { ...cell }
      },
      fail: (error) => {
        // A host-side failure never reached the kernel, so it has no output of its own; the
        // message belongs in `error`, which the panel already renders as its own line.
        cell.status = 'error'
        cell.error = error instanceof Error ? error.message : String(error)
        cell.outputs = renderer.outputs
        cell.rev += 1
        notebook.revision += 1
        this.#persist(sessionId, notebook)
        this.#emit(sessionId, { type: 'cell', revision: notebook.revision, cell: { ...cell } })
        return { ...cell }
      },
    }
  }

  /**
   * Run one stored cell and wait for it.
   *
   * `runCell` answers as soon as the kernel has the code, which is right for a click and wrong for
   * a tool call: the model asked what the cell prints. This shares the same run path, including
   * the streamed output and the note, and resolves with the execution outcome.
   *
   * @param sessionId - Owning DSH session.
   * @param id - Cell id.
   * @returns The execution outcome, or a rendered-markdown result.
   */
  async runCellNow(sessionId, id) {
    const notebook = this.#notebook(sessionId)
    const cell = this.#cell(notebook, id)
    if (cell.kind === 'markdown') {
      cell.status = 'ok'
      cell.outputs = []
      cell.error = null
      cell.rev += 1
      this.#touch(sessionId, notebook)
      this.#emit(sessionId, { type: 'cell', revision: notebook.revision, cell: { ...cell } })
      return { status: 'ok', executionCount: null, durationMs: 0, output: '' }
    }
    await this.#beginCodeRun(sessionId, notebook, cell, { note: false })
    // The user may delete the cell while it runs; the execution still belongs to the kernel, but
    // there is no cell left to report it on.
    const settled = notebook.cells.find((candidate) => candidate.id === id)
    if (settled === undefined) {
      return { status: 'error', executionCount: null, durationMs: null, output: '', error: 'the cell was deleted while it ran' }
    }
    return {
      status: settled.status,
      executionCount: settled.executionCount,
      durationMs: settled.durationMs,
      output: summarizeCellOutputs(settled.outputs, 4000),
      ...(settled.error === null || settled.error === undefined ? {} : { error: settled.error }),
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
   * The notebook's own path, when the panel was told one; used to name an export.
   *
   * @param sessionId - Owning DSH session.
   * @returns The stored path, or the notebook's name when it is not `main`, or null. Does not
   *   create a notebook.
   */
  notebookPath(sessionId) {
    const notebook = this.#peek(sessionId)
    if (notebook === undefined) return null
    if (notebook.path !== null) return notebook.path
    // `main` exporting as `notebook.ipynb` is the old, predictable name; a second notebook called
    // "Untitled 2" should not overwrite it in the downloads folder.
    return notebook.name === 'main' ? null : notebook.name
  }

  /**
   * Render the notebook as an `nbformat` 4 document.
   *
   * The language comes from the bound kernel so an export from a Julia or R session does not claim
   * to be Python — it is metadata, but it is the metadata JupyterLab uses to pick a kernel back up.
   * A missing or failing kernel costs the field, never the export.
   *
   * @param sessionId - Owning DSH session.
   * @returns The document, ready to serialize.
   */
  async exportDocument(sessionId) {
    const notebook = this.#notebook(sessionId)
    let language = 'python'
    try {
      // The language comes from the kernel of *this page's* server: a second page bound to another
      // host may run a different kernelspec, and metadata that names the wrong one is worse than
      // none. A missing or failing kernel costs the field, never the export.
      const kernel = await this.#kernelInfo?.(sessionId, { server: this.#pageServer(notebook).key ?? undefined })
      if (typeof kernel?.name === 'string' && kernel.name.length > 0) language = kernel.name
    } catch {
      // Metadata only: an unreachable kernel must not stop the user from saving their work.
    }
    return notebookToIpynb(notebook.cells, { language, readAsset: this.#readAsset })
  }

  /**
   * Load cells from an `nbformat` 4 document.
   *
   * `mode: 'replace'` is the default because that is what opening a file means; `'append'` exists
   * for folding a downloaded notebook into the one on screen. Imported cells are always marked
   * `origin: 'user'` — the file is the user's, whoever wrote it originally.
   *
   * The whole list is announced as one `replace` event rather than a burst of inserts: the client
   * can apply that without tracking indices, and a partially applied import would be worse than a
   * slightly larger frame.
   *
   * @param sessionId - Owning DSH session.
   * @param document - Parsed `.ipynb` JSON.
   * @param options - Import controls.
   * @param options.mode - `'replace'` (default) or `'append'`.
   * @returns Warnings about everything the panel could not keep; empty when nothing was lost.
   * @throws {Error} When the document is not a supported notebook.
   */
  importDocument(sessionId, document, { mode = 'replace' } = {}) {
    const notebook = this.#notebook(sessionId)
    const parsed = ipynbToCells(document, { putAsset: this.#asset })
    const cells = parsed.cells.map((entry) => {
      const cell = newCell(entry.kind, entry.source, 'user')
      cell.outputs = entry.outputs ?? []
      cell.executionCount = entry.executionCount ?? null
      // A file's outputs are history: show the cells as having run, including a failed one, so a
      // traceback does not appear next to a cell labelled idle.
      if (cell.outputs.some((output) => output.type === 'error')) cell.status = 'error'
      else if (cell.outputs.length > 0) cell.status = 'ok'
      return cell
    })
    if (mode === 'append') notebook.cells.push(...cells)
    else notebook.cells = cells
    this.#touch(sessionId, notebook)
    this.#emit(sessionId, {
      type: 'replace',
      revision: notebook.revision,
      cells: notebook.cells.map((cell) => ({ ...cell })),
    })
    this.#note(sessionId, {
      type: 'import',
      count: cells.length,
      mode,
      dropped: parsed.warnings.length,
    })
    return parsed.warnings
  }

  /**
   * Run every code cell, one after another, in the order they appear.
   *
   * Sequential on purpose: the whole point of a run-all is that cell 3 sees what cell 2 defined.
   * The kernel queue would enforce the ordering anyway, but then a cell deleted mid-sequence would
   * still be executed from a stale list — this walks ids and re-checks the notebook before each
   * one, so what runs is what exists.
   *
   * Cells added while the sequence runs are not picked up (the list is a snapshot), because a cell
   * that appends cells would otherwise never let the run end.
   *
   * @param sessionId - Owning DSH session.
   * @param options - Run controls.
   * @param options.stopOnError - Stop after the first failing cell instead of continuing.
   * @returns False when a sequence was already running.
   */
  async runAll(sessionId, { stopOnError = false } = {}) {
    if (this.#runningAll.has(sessionId)) return false
    const notebook = this.#notebook(sessionId)
    this.#runningAll.set(sessionId, { stop: false, notebook: notebook.name })
    this.#emit(sessionId, { type: 'runall', running: true, revision: notebook.revision })
    try {
      for (const id of notebook.cells.map((cell) => cell.id)) {
        const state = this.#runningAll.get(sessionId)
        // `reset` throws the record away, and the ids below then belong to a notebook nobody can
        // see. A switch leaves the page in place, so this check does not end the loop — the
        // `stopRunAll` a switch performs does, which is the difference between "gone" and "hidden".
        const desk = this.#notebooks.get(sessionId)
        if (state === undefined || state.stop || desk?.docs.get(notebook.name) !== notebook) break
        const cell = notebook.cells.find((candidate) => candidate.id === id)
        // An empty cell is a blank line in the document, not a thing to execute.
        if (cell === undefined || cell.kind !== 'code' || cell.source.trim().length === 0) continue
        await this.#beginCodeRun(sessionId, notebook, cell)
        if (stopOnError && cell.status === 'error') break
      }
    } finally {
      this.#runningAll.delete(sessionId)
      this.#emit(sessionId, { type: 'runall', running: false, revision: notebook.revision })
    }
    return true
  }

  /**
   * Ask a running sequence to stop after the cell that is executing.
   *
   * The executing cell is not interrupted here: `interrupt` already sends that to the kernel, and a
   * user pressing stop wants "stop after this one" or "kill this one" as two separate decisions.
   *
   * @param sessionId - Owning DSH session.
   * @returns Whether a sequence was running.
   */
  stopRunAll(sessionId) {
    const state = this.#runningAll.get(sessionId)
    if (state === undefined) return false
    state.stop = true
    return true
  }

  /**
   * Apply one panel command.
   *
   * `runCell` answers as soon as the run has started: the output arrives through
   * {@link Notebooks.subscribe}. Everything else is synchronous enough to answer with the new view.
   *
   * @param sessionId - Owning DSH session.
   * @param command - `{ action, ... }` as sent by the panel.
   * @param options - Extra fields merged into the returned view.
   * @param controls - Extra behaviour.
   * @param controls.note - Set false for a command the model issued: its own action must not come
   *   back to it as a note about what the user did.
   * @returns The updated view.
   */
  async command(sessionId, command, options = {}, { note = true } = {}) {
    const notebook = this.#notebook(sessionId)
    const action = String(command?.action ?? '')
    // A command sent by `jupyter_notebook` is the model acting, not the user: telling the model
    // about its own edit on the next step would read as if the user had made it.
    const notify = note ? (event) => this.#note(sessionId, event) : () => {}
    switch (action) {
      case 'addCell': {
        // The panel never sends `origin`; `jupyter_notebook` does, so a cell the model wrote is
        // marked the same way as a cell it ran.
        const cell = newCell(command.kind, command.source, command.origin)
        const index = command.afterId === undefined ? notebook.cells.length : notebook.cells.findIndex((c) => c.id === command.afterId) + 1
        const at = index <= 0 ? notebook.cells.length : index
        notebook.cells.splice(at, 0, cell)
        this.#touch(sessionId, notebook)
        notify({ type: 'add', index: at, id: cell.id, kind: cell.kind, source: cell.source })
        break
      }
      case 'updateCell': {
        const cell = this.#cell(notebook, command.id)
        const index = notebook.cells.indexOf(cell)
        const before = { kind: cell.kind, source: cell.source }
        if (typeof command.source === 'string') {
          if (command.source !== cell.source) {
            // A rewrite by the model keeps the text it replaced, so the panel can show what it did
            // instead of swapping the user's code out from under them. A second rewrite keeps the
            // *first* baseline: the diff should show everything the model changed since the user
            // last touched the cell, and undo should restore the user's own text. The user's edit
            // is the new baseline and clears any marker still sitting on the cell.
            cell.previousSource = command.origin === 'agent' ? (cell.previousSource ?? cell.source) : null
            cell.source = command.source
          } else if (command.origin !== 'agent') {
            cell.previousSource = null
          }
        }
        if (command.kind !== undefined && CELL_KINDS.has(command.kind) && command.kind !== cell.kind) {
          cell.kind = command.kind
          // What a code cell printed says nothing about the prose that replaces it.
          if (cell.kind === 'markdown') {
            cell.outputs = []
            cell.status = 'idle'
            cell.executionCount = null
            cell.error = null
          }
        }
        cell.rev += 1
        this.#touch(sessionId, notebook)
        notify({
          type: 'edit',
          index,
          id: cell.id,
          kind: cell.kind,
          source: cell.source,
          before,
        })
        break
      }
      case 'dismissDiff': {
        // The user has read the model's version and accepts it: drop the baseline, keep the text.
        const cell = this.#cell(notebook, command.id)
        if (cell.previousSource !== null) {
          cell.previousSource = null
          cell.rev += 1
          this.#touch(sessionId, notebook)
        }
        break
      }
      case 'revertCell': {
        const cell = this.#cell(notebook, command.id)
        if (typeof cell.previousSource !== 'string') throw new Error('this cell has no earlier version to restore')
        const index = notebook.cells.indexOf(cell)
        const before = { kind: cell.kind, source: cell.source }
        cell.source = cell.previousSource
        cell.previousSource = null
        cell.rev += 1
        this.#touch(sessionId, notebook)
        // The revert is the user's edit, so it is reported as one; the model should know that the
        // text it wrote is no longer what the notebook holds.
        notify({
          type: 'edit',
          index,
          id: cell.id,
          kind: cell.kind,
          source: cell.source,
          before,
        })
        break
      }
      case 'deleteCell': {
        const index = notebook.cells.findIndex((c) => c.id === command.id)
        if (index === -1) throw new Error(`cell ${command.id} is not in this notebook`)
        const [removed] = notebook.cells.splice(index, 1)
        const replaced = notebook.cells.length === 0
        if (replaced) notebook.cells.push(newCell('code'))
        this.#touch(sessionId, notebook)
        notify({
          type: 'delete',
          index,
          id: removed.id,
          kind: removed.kind,
          source: removed.source,
          replaced,
        })
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
        const index = notebook.cells.indexOf(cell)
        cell.outputs = []
        cell.status = 'idle'
        cell.error = null
        cell.rev += 1
        this.#touch(sessionId, notebook)
        notify({ type: 'clear', index, id: cell.id, kind: cell.kind })
        break
      }
      case 'clearAllOutputs': {
        const count = notebook.cells.length
        for (const cell of notebook.cells) {
          cell.outputs = []
          cell.status = 'idle'
          cell.error = null
          cell.rev += 1
        }
        this.#touch(sessionId, notebook)
        notify({ type: 'clear-all', count })
        break
      }
      case 'runCell': {
        const cell = this.#cell(notebook, command.id)
        // The editor sends its draft with the run, so `Shift+Enter` is one request instead of an
        // update followed by a run — every avoided round trip is a visible delay on a click.
        if (typeof command.source === 'string' && command.source !== cell.source) {
          cell.source = command.source
        }
        // A markdown cell is prose: running it renders it. Nothing goes to the kernel, and no
        // kernel is started for it — which is also why it never fails on a server that has none.
        if (cell.kind === 'markdown') {
          cell.status = 'ok'
          cell.outputs = []
          cell.error = null
          cell.rev += 1
          this.#touch(sessionId, notebook)
          this.#emit(sessionId, { type: 'cell', revision: notebook.revision, cell: { ...cell } })
          notify({
            type: 'markdown',
            index: notebook.cells.indexOf(cell),
            id: cell.id,
            source: cell.source,
          })
          break
        }
        // The run is owned by the notebook, so the command answers now and the output streams.
        this.#beginCodeRun(sessionId, notebook, cell).catch(() => {})
        break
      }
      case 'restartKernel':
      case 'interrupt':
      case 'startKernel': {
        // Stopping the cell that is running is also a decision about the sequence around it;
        // without this, interrupting one cell of a run-all starts the next one a moment later.
        if (action === 'interrupt') this.stopRunAll(sessionId)
        // Kernel lifecycle follows the page too: restarting "the kernel" of a remote page must not
        // restart the local one. The handler receives the resolved key the same way `execute` does.
        const server = this.#pageServer(notebook).key ?? undefined
        const outcome = await this.#kernelCommand(action, sessionId, { ...options, server })
        return await this.view(sessionId, { ...options, message: outcome })
      }
      case 'runAll': {
        // The sequence runs in the background like any other run: the panel needs the stop button
        // now, and the output arrives on the stream cell by cell.
        this.runAll(sessionId, { stopOnError: command.stopOnError === true }).catch(() => {})
        break
      }
      case 'importNotebook': {
        const warnings = this.importDocument(sessionId, command.document, { mode: command.mode })
        // The message is what the panel shows after the file lands: a count, plus one line per
        // thing that could not be kept.
        return await this.view(sessionId, {
          ...options,
          message: warnings.length === 0
            ? undefined
            : `${warnings.length} item(s) could not be imported:\n${warnings.slice(0, 6).join('\n')}`,
        })
      }
      case 'discardNotes': {
        // Dropping queued notes changes no cell, so there is deliberately no revision bump: the
        // next view simply has nothing to report.
        this.discardNotes(sessionId)
        break
      }
      case 'setPath': {
        notebook.path = command.path === undefined || command.path === null ? null : String(command.path)
        this.#touch(sessionId, notebook)
        break
      }
      case 'newNotebook': {
        const desk = this.#desk(sessionId)
        if (desk.docs.size >= MAX_NOTEBOOKS) {
          throw new Error(`this session already holds ${MAX_NOTEBOOKS} notebooks; reset it before adding another`)
        }
        // A sequence belongs to the page it was started on; leaving it running unseen would strand
        // a kernel at work with no stop button anywhere.
        this.stopRunAll(sessionId)
        // The new page inherits the server of the page it was opened from unless the caller names
        // one: "+" means "another page of what I am doing", and it already runs on a host.
        const previous = this.#pageServer(desk.docs.get(desk.active))
        const requested = command.server === undefined || command.server === null ? '' : String(command.server).trim()
        const server = requested.length === 0
          ? previous.key
          : this.#matchServer(previous.registry, requested).key
        const name = uniqueName(desk, command.notebook)
        const page = freshNotebook(name, server ?? null)
        desk.docs.set(name, page)
        desk.active = name
        this.#persist(sessionId, page)
        // A second window is looking at the same desk: the page changed under it, and a patch to
        // the cell list cannot express that. It reads the whole view again instead.
        this.#emit(sessionId, { type: 'notebook', notebook: name, server: page.server })
        notify({
          type: 'newNotebook',
          name,
          server: this.#pageServer(page).url,
          previousServer: previous.url,
        })
        break
      }
      case 'switchNotebook': {
        const desk = this.#desk(sessionId)
        const name = String(command.notebook ?? '').trim()
        if (name.length === 0) throw new Error('switching needs a notebook name')
        if (!desk.docs.has(name)) throw new Error(`there is no notebook named "${name}"`)
        const previous = this.#pageServer(desk.docs.get(desk.active))
        this.stopRunAll(sessionId)
        desk.active = name
        const target = desk.docs.get(name)
        const page = this.#pageServer(target)
        this.#persist(sessionId, target)
        // See newNotebook: switching is a different document, not an edit to this one. The server
        // rides along because the page's kernel lives on it, and the client has to re-read the
        // whole view anyway (a patch cannot express "different document, possibly different host").
        this.#emit(sessionId, { type: 'notebook', notebook: name, server: page.key })
        notify({
          type: 'switchNotebook',
          name,
          count: target.cells.length,
          server: page.url,
          previousServer: previous.url,
        })
        break
      }
      case 'connectServer': {
        const url = typeof command.url === 'string' ? command.url.trim() : ''
        if (url.length === 0) throw new Error('adding a connection needs a server url')
        if (typeof this.#connectServer !== 'function') throw new Error('adding a server connection is unavailable')
        const patch = { url }
        // Only fields the panel actually filled in travel: a blank input means "not given", not an
        // empty credential that would overwrite the ones already stored for that address.
        for (const field of ['name', 'token', 'password', 'username', 'cookie', 'kernelName']) {
          if (typeof command[field] === 'string' && command[field].trim().length > 0) patch[field] = command[field]
        }
        const result = await this.#connectServer(patch)
        // The registry is read again after the add: the probe may have taken a second, and the
        // describe list is what the picker will show.
        const registry = this.#registry()
        const key = typeof result?.key === 'string' && result.key.length > 0
          ? result.key
          : registry.servers.find((entry) => serverSpelling(entry.url) === serverSpelling(url))?.key
        const serverUrl = typeof result?.url === 'string' && result.url.length > 0 ? result.url : (key ?? url)
        const knownModes = new Set(['token', 'password', 'cookie'])
        const authMode = knownModes.has(result?.authMode)
          ? result.authMode
          : (registry.servers.find((entry) => entry.key === key)?.authMode ?? 'none')
        const specs = Array.isArray(result?.kernelspecs) ? result.kernelspecs.length : 0
        const name = typeof result?.name === 'string' && result.name.length > 0
          ? result.name
          : registry.servers.find((entry) => entry.key === key)?.name
        // The set of connections changed, and no cell revision can express that: every open window
        // re-reads the view so the picker and the "not connected" rows are true again.
        this.#emit(sessionId, { type: 'notebook', notebook: notebook.name, server: this.#pageServer(notebook).key })
        notify({ type: 'connectServer', url: serverUrl, ...(name === undefined ? {} : { name }), authMode })
        return await this.view(sessionId, {
          ...options,
          message: `connected to ${serverUrl} (${authMode} auth); ${specs} kernelspec(s)`,
        })
      }
      case 'forgetServer': {
        const value = typeof command.server === 'string' ? command.server.trim() : ''
        if (value.length === 0) throw new Error('forgetting a connection needs a server')
        if (typeof this.#forgetServer !== 'function') throw new Error('forgetting a server connection is unavailable')
        // Read the name before the removal: afterwards the registry no longer describes it.
        const known = this.#registry().servers.find((entry) =>
          serverSpelling(entry.key) === serverSpelling(value) || serverSpelling(entry.url) === serverSpelling(value))
        const result = await this.#forgetServer(value)
        const serverUrl = typeof result?.url === 'string' && result.url.length > 0 ? result.url : value
        // Pages bound to the removed key keep it: they still say which host they belong to and
        // simply report themselves as not connected (a run raises the host's readable error).
        // Silently repointing them at the default server would move the user's notebook to a host
        // they never chose.
        this.#emit(sessionId, { type: 'notebook', notebook: notebook.name, server: this.#pageServer(notebook).key })
        notify({
          type: 'forgetServer',
          url: serverUrl,
          ...(known?.name === undefined ? {} : { name: known.name }),
        })
        const removed = result?.removed !== false
        return await this.view(sessionId, {
          ...options,
          message: removed ? `disconnected from ${serverUrl}` : `${serverUrl} was not connected`,
        })
      }
      case 'bindServer': {
        const value = typeof command.server === 'string' ? command.server.trim() : ''
        if (value.length === 0) throw new Error('binding needs a server')
        const match = this.#matchServer(this.#registry(), value)
        const previous = this.#pageServer(notebook)
        // A sequence belongs to the page — and so to the kernel — it was started on: letting it
        // continue after a rebind would report results from another host into these cells.
        this.stopRunAll(sessionId)
        notebook.server = match.key
        // Flush rather than defer: a binding that does not survive a reload would run tomorrow's
        // cells on the default server while the header still showed the chosen one.
        this.#flushPersistence(sessionId)
        this.#emit(sessionId, { type: 'notebook', notebook: notebook.name, server: match.key })
        notify({
          type: 'bindServer',
          url: match.url,
          ...(match.name === undefined ? {} : { name: match.name }),
          previousServer: previous.url,
        })
        return await this.view(sessionId, { ...options, message: `this notebook now runs on ${match.url}` })
      }
      case 'reset': {
        const desk = this.#desk(sessionId)
        let count = 0
        for (const doc of desk.docs.values()) count += doc.cells.length
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
        notify({ type: 'reset', count })
        break
      }
      default:
        throw new Error(`unknown notebook action "${action}"`)
    }
    return await this.view(sessionId, options)
  }

  /**
   * Start one cell's execution and return immediately.
   *
   * The run is tracked so `idle()` can wait for it, and every outcome — including a thrown
   * execution error — is written back into the cell and announced.
   *
   * @param sessionId - Owning DSH session.
   * @param notebook - The notebook record the cell belongs to.
   * @param cell - The cell to run.
   * @returns The tracked run promise; callers that need the result can await it.
   */
  #startRun(sessionId, notebook, cell, { note = true } = {}) {
    const renderer = new OutputRenderer({ asset: this.#asset })
    cell.outputs = renderer.outputs
    // `#run` handles its own failures, but a promise that nobody awaits still has to be safe to
    // reject: this is a long-lived process, and an unhandled rejection would take the host down.
    const run = this.#run(sessionId, notebook, cell, renderer, { note }).catch(() => undefined)
    let runs = this.#runs.get(sessionId)
    if (runs === undefined) {
      runs = new Set()
      this.#runs.set(sessionId, runs)
    }
    runs.add(run)
    run.finally(() => {
      runs.delete(run)
      if (runs.size === 0 && this.#runs.get(sessionId) === runs) this.#runs.delete(sessionId)
    })
    return run
  }

  /**
   * Mark a code cell as running, announce it, and launch it.
   *
   * Shared by the panel's `runCell` (which ignores the promise) and the `jupyter_notebook` tool
   * (which awaits it), so both produce the same streaming events, notes and final state.
   *
   * @param sessionId - Owning DSH session.
   * @param notebook - The notebook record.
   * @param cell - The cell to run.
   * @returns The run promise.
   */
  #beginCodeRun(sessionId, notebook, cell, { note = true } = {}) {
    cell.status = 'running'
    cell.outputs = []
    cell.error = null
    cell.rev += 1
    notebook.revision += 1
    // Persist the source before running so a reload mid-execution keeps the edit. This write
    // is synchronous on purpose: the cell may run for minutes.
    this.#flushPersistence(sessionId)
    this.#emit(sessionId, { type: 'cell', revision: notebook.revision, cell: { ...cell } })
    // The note is replaced by the outcome when the run settles, so a step in between sees
    // "running" and a later one sees what it printed.
    if (note) {
      this.#note(sessionId, {
        type: 'run-start',
        index: notebook.cells.indexOf(cell),
        id: cell.id,
        kind: cell.kind,
        source: cell.source,
      })
    }
    return this.#startRun(sessionId, notebook, cell, { note })
  }

  /**
   * Translate kernel output into stream events for one cell.
   *
   * @param sessionId - Owning DSH session.
   * @param cell - The cell the output belongs to.
   * @param renderer - Its incremental renderer.
   * @returns The `onOutput` callback handed to the execution layer.
   */
  #streamInto(sessionId, cell, renderer) {
    return (output) => {
      if (output.kind === 'clear') {
        renderer.clear()
        cell.outputs = renderer.outputs
        this.#emit(sessionId, { type: 'clear', cellId: cell.id })
        return
      }
      for (const patch of renderer.push(output) ?? []) {
        if (patch.kind === 'append') {
          this.#emit(sessionId, { type: 'append', cellId: cell.id, output: patch.output })
        } else if (patch.kind === 'text') {
          this.#emit(sessionId, { type: 'text', cellId: cell.id, index: patch.index, text: patch.text })
        }
      }
    }
  }

  /**
   * Write one execution's outcome back into its cell and announce the final state.
   *
   * Rebuilds from the authoritative output list: the incremental view exists to be watched, but
   * the cell that is kept (and mirrored to disk) has to match a non-streamed run exactly.
   *
   * @param sessionId - Owning DSH session.
   * @param notebook - The notebook record.
   * @param cell - The cell that ran.
   * @param execution - Normalized execution result.
   * @returns The settled cell.
   */
  #settle(sessionId, notebook, cell, execution) {
    cell.status = execution.status === 'ok' ? 'ok' : execution.status
    cell.executionCount = execution.executionCount ?? null
    cell.durationMs = execution.durationMs ?? null
    cell.outputs = renderableOutputs(execution.outputs, { asset: this.#asset })
    // A non-ok DSH-side outcome (timeout, abort, disconnect) is worth showing next to the
    // cell even when the kernel produced no traceback of its own.
    if (execution.status !== 'ok' && execution.status !== 'error' && execution.message !== undefined) {
      cell.outputs.push({ type: 'error', text: execution.message })
    }
    cell.rev += 1
    notebook.revision += 1
    this.#persist(sessionId, notebook)
    this.#emit(sessionId, { type: 'cell', revision: notebook.revision, cell: { ...cell } })
    return cell
  }

  /**
   * Execute one cell, streaming its output as it arrives.
   *
   * @param sessionId - Owning DSH session.
   * @param notebook - The notebook record.
   * @param cell - The cell being run.
   * @param renderer - The incremental renderer the cell's outputs are built with.
   * @returns The normalized execution outcome.
   */
  async #run(sessionId, notebook, cell, renderer, { note = true } = {}) {
    // The source as it was when the run started: the user may edit the cell while it executes,
    // and a note that quoted the newer text next to the older output would mislead the model.
    const source = cell.source
    // The server is resolved once, at the start: rebinding the page while a cell runs must not move
    // the execution that was already handed to a kernel (the binding only affects the next run).
    const server = this.#pageServer(notebook).key ?? undefined
    /** How this run ended, normalized for the note written below. */
    let outcome
    const onOutput = this.#streamInto(sessionId, cell, renderer)
    try {
      const execution = await this.#execute(sessionId, source, {
        // No `signal`: a run belongs to the notebook, not to the request that started it. A page
        // refresh used to abort the POST, and that abort was wired all the way to an interrupt,
        // so reloading the page killed the cell the user was waiting for.
        onOutput,
        // Which connection this page runs on. Undefined means "nothing is configured"; a key that
        // is no longer connected is passed as-is on purpose, so the host raises its readable
        // "not configured" error instead of falling back to another server behind the user's back.
        server,
      })
      outcome = execution
      this.#settle(sessionId, notebook, cell, execution)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      cell.status = 'error'
      cell.error = message
      cell.outputs = renderer.outputs
      cell.rev += 1
      notebook.revision += 1
      this.#persist(sessionId, notebook)
      this.#emit(sessionId, { type: 'cell', revision: notebook.revision, cell: { ...cell } })
      outcome = { status: 'error', message, outputs: cell.outputs }
    }
    // Same key as the `run-start` note, so only the outcome is left for the next model step.
    if (note) {
      this.#note(sessionId, {
        type: 'run-end',
        index: notebook.cells.indexOf(cell),
        id: cell.id,
        kind: cell.kind,
        source,
        execution: outcome,
      })
    }
    return outcome
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

  /** How many sessions are held in memory; used by tests. */
  get size() {
    return this.#notebooks.size
  }

  /** Mirror directory, for diagnostics. */
  get directory() {
    return this.#directory
  }

  /** Forget every in-memory notebook without touching the mirrors. */
  dispose() {
    // Ask every run-all to stop before dropping the records it is walking; the loop checks the
    // flag before the next cell, so nothing new starts after the plugin is gone.
    for (const state of this.#runningAll.values()) state.stop = true
    this.#runningAll.clear()
    // A scheduled write holds the newest edits; losing it on a plugin remount would undo them.
    for (const sessionId of [...this.#pendingPersistence.keys()]) {
      const timer = this.#pendingPersistence.get(sessionId)
      if (timer !== undefined) clearTimeout(timer)
      this.#pendingPersistence.delete(sessionId)
      this.#write(sessionId)
    }
    this.#notebooks.clear()
    this.#listeners.clear()
    this.#runs.clear()
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
