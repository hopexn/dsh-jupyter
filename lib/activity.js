/**
 * What the user did in the notebook panel, told to the model.
 *
 * The panel and the agent share one kernel, so a cell the user runs changes the state the agent is
 * reasoning about: a variable redefined, a module reloaded, an output cleared, a cell deleted. With
 * no note, the agent's next request describes a notebook that no longer exists, and its answer is
 * quietly wrong about code the user just changed.
 *
 * Notes are buffered per session and handed to the model at its **next step**, through
 * `agent/pre-step` — the same place `time-context` and `agent-instructions` add their context.
 * That timing is the point: a note is model-visible context, not a chat message, so an edit cannot
 * start a turn on its own, and a burst of edits arrives as one message instead of five.
 *
 * The message is attributed to this plugin (`source.kind: 'plugin'`, `form: 'notice'`), so the
 * transcript shows it as a collapsed context row rather than as something the user typed, and the
 * model can tell it apart from an instruction.
 *
 * Note *keys* make the buffer self-cleaning: a run start and its end share one key, so only the
 * outcome survives, and an edit followed by a run of the same cell collapses into the run.
 *
 * @module dsh-jupyterlab/activity
 */

import { randomUUID } from 'node:crypto'

/** Notes kept per session before the oldest is dropped. */
const MAX_NOTES = 8

/** Characters of note text kept per session. */
const MAX_CHARS = 6000

/** Bound on the one-line summary the transcript shows. */
const MAX_SUMMARY = 120

/** Characters of cell source quoted in one note. */
const MAX_SOURCE = 900

/** Characters of output quoted in one note. */
const MAX_OUTPUT = 800

/** Lines a diff may occupy before the note falls back to quoting the new source. */
const MAX_DIFF_LINES = 40

/** Context lines shown around a changed region. */
const DIFF_CONTEXT = 2

/** How an execution ended, in words the model reads as a sentence. */
const OUTCOME = {
  ok: 'succeeded',
  error: 'raised an error',
  timeout: 'timed out and was interrupted',
  aborted: 'was aborted before it ran',
  disconnected: 'lost the kernel connection',
}

/**
 * Buffer of pending notes, keyed by session.
 *
 * One instance lives for the plugin's lifetime. It holds text only — no cells, no promises — so a
 * note cannot keep a notebook alive after it is gone.
 */
export class NotebookActivity {
  /** @type {Map<string, {notes: Map<string, object>, order: string[]}>} */
  #sessions = new Map()

  /**
   * Record one thing the user did.
   *
   * @param sessionId - Owning DSH session.
   * @param event - Structured activity emitted by the notebook model.
   */
  record(sessionId, event) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const note = noteFor(event)
    if (note === undefined) return
    let entry = this.#sessions.get(sessionId)
    if (entry === undefined) {
      entry = { notes: new Map(), order: [] }
      this.#sessions.set(sessionId, entry)
    }
    // A reset is about the whole notebook, so anything queued describes cells that no longer exist.
    if (event.type === 'reset') {
      entry.notes.clear()
      entry.order.length = 0
    }
    if (!entry.notes.has(note.key)) entry.order.push(note.key)
    entry.notes.set(note.key, note)
    this.#trim(entry)
  }

  /**
   * How many notes are waiting for one session.
   *
   * @param sessionId - Owning DSH session.
   * @returns The pending count, for the panel's badge.
   */
  pending(sessionId) {
    return this.#sessions.get(sessionId)?.notes.size ?? 0
  }

  /**
   * The pending notes, as the short one-line summaries the panel shows.
   *
   * The panel's badge used to be a bare count, which told the user that something would be handed
   * to the model but not what. These entries are the same strings the transcript shows, so the
   * preview cannot drift from the delivery.
   *
   * @param sessionId - Owning DSH session.
   * @returns `{key, summary}` per pending note, oldest first.
   */
  list(sessionId) {
    const entry = this.#sessions.get(sessionId)
    if (entry === undefined) return []
    const notes = []
    for (const key of entry.order) {
      const note = entry.notes.get(key)
      if (note !== undefined) notes.push({ key: note.key, summary: note.summary })
    }
    return notes
  }

  /**
   * Take every pending note, oldest first, and forget them.
   *
   * Draining is what makes delivery happen exactly once: the caller is the pre-step hook, and a
   * step that never reaches a model call keeps nothing queued for later by accident.
   *
   * @param sessionId - Owning DSH session.
   * @returns The notes, in the order they happened.
   */
  drain(sessionId) {
    const entry = this.#sessions.get(sessionId)
    if (entry === undefined || entry.order.length === 0) return []
    const notes = entry.order.map((key) => entry.notes.get(key)).filter((note) => note !== undefined)
    this.#sessions.delete(sessionId)
    return notes
  }

  /** Drop everything queued for one session, without delivering it. */
  forget(sessionId) {
    this.#sessions.delete(sessionId)
  }

  /** Keep the buffer bounded: newest notes win, but a single note is never split here. */
  #trim(entry) {
    while (entry.order.length > MAX_NOTES) {
      entry.notes.delete(entry.order.shift())
    }
    const total = () => entry.order.reduce((sum, key) => sum + (entry.notes.get(key)?.text.length ?? 0), 0)
    while (entry.order.length > 1 && total() > MAX_CHARS) {
      entry.notes.delete(entry.order.shift())
    }
  }
}

/**
 * Build the user-role message that carries a batch of notes.
 *
 * The shape is the one `createUserMessage` produces in `@deepseek-ai/dsh-llm`, written out here on
 * purpose: this bundle imports no DSH package, so a host-side import is not an option. The session
 * log snapshots and freezes the payload itself.
 *
 * @param notes - Notes taken from {@link NotebookActivity.drain}.
 * @param options - Extra context for the batch.
 * @param options.outline - A one-shot map of the notebook, attached to the first delivery of a
 *   session. Without it the notes say "cell 3" to a model that has never seen the notebook.
 * @returns A message to append to a step's decision, or `undefined` for an empty batch.
 */
export function messageForNotes(notes, { outline } = {}) {
  if (!Array.isArray(notes) || notes.length === 0) return undefined
  const shared = 'The notebook panel and this session share one kernel.'
  const heading = notes.length === 1
    ? `Notebook panel activity since your previous step. ${shared}`
    : `Notebook panel activity since your previous step (${notes.length} actions). ${shared}`
  const body = notes.map((note, index) => `${index + 1}. ${note.text}`).join('\n\n')
  const map = typeof outline === 'string' && outline.length > 0 ? `${outline}\n\n` : ''
  let text = `${heading}\n\n${map}${body}`
  if (text.length > MAX_CHARS + 400) text = `${text.slice(0, MAX_CHARS + 399)}…`
  const summary = notes.length === 1
    ? notes[0].summary
    : `${notes.length} notebook actions: ${notes.map((note) => note.summary.toLowerCase()).join(', ')}`
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'jupyterlab',
      form: 'notice',
      summary: boundSummary(summary),
    },
  }
}

/**
 * Hand buffered notes to the model at the start of its next step.
 *
 * Registered on the plugin's own context, like `agent-instructions`: `agent/pre-step` is a
 * waterfall, so `next()` first lets every other producer decide what the step carries, and this
 * listener only appends its notice to that decision.
 *
 * Two guards matter. A rejected step must not consume notes (the notes would be lost), and a first
 * step with no message must not be turned into a model call — a panel edit is context for a
 * conversation, never a reason to start one.
 *
 * @param ctx - Plugin context.
 * @param options - Wiring.
 * @param options.activity - The buffer to drain.
 * @param options.notebooks - The panel model, used for the one-shot outline; optional so the hook
 *   can be tested (and mounted) without a panel.
 */
export function registerContextInjection(ctx, { activity, notebooks } = {}) {
  /**
   * The notebook revision each session has already been mapped at.
   *
   * A note references cells by number, and a model that has never seen the notebook has no idea
   * what "cell 3" holds. The first batch therefore carries a one-line-per-cell outline. Later
   * batches do not: the model has the map, and repeating it would dwarf the actual change. A
   * `reset` starts a new notebook at a lower revision, which is what re-arms the outline.
   */
  const mapped = new Map()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind === 'reject') return decision
      if (payload?.signal?.aborted === true) return decision
      const messages = Array.isArray(decision?.messages) ? decision.messages : []
      if (payload?.step === 1 && messages.length === 0) return decision
      const sessionId = payload?.agent?.session?.header?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return decision
      const notes = activity.drain(sessionId)
      if (notes.length === 0) return decision
      let outline
      try {
        const revision = notebooks?.revision?.(sessionId)
        const previous = mapped.get(sessionId)
        if (typeof revision === 'number' && (previous === undefined || revision < previous)) {
          outline = notebooks.outline(sessionId)
          mapped.set(sessionId, revision)
        }
      } catch {
        // A missing outline must not cost the notes themselves.
      }
      return { ...decision, messages: [...messages, messageForNotes(notes, { outline })] }
    } catch {
      // A note is never worth failing a model request over.
      return decision
    }
  })
}

/** Bound a summary to the transcript's one-line budget. */
export function boundSummary(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= MAX_SUMMARY ? value : `${value.slice(0, MAX_SUMMARY - 1)}…`
}

// ---------------------------------------------------------------------------------------------
// Notes, one per kind of activity
// ---------------------------------------------------------------------------------------------

/**
 * Turn one activity event into a note, or nothing when the change is not worth telling.
 *
 * @param event - Structured activity from the notebook model.
 * @returns `{key, summary, text}` or `undefined`.
 */
function noteFor(event) {
  switch (event?.type) {
    case 'edit': return editNote(event)
    case 'run-start': return runStartNote(event)
    case 'run-end': return runEndNote(event)
    case 'markdown': return markdownNote(event)
    case 'add': return addNote(event)
    case 'delete': return deleteNote(event)
    case 'clear': return clearNote(event)
    case 'clear-all': return clearAllNote(event)
    case 'reset': return resetNote(event)
    case 'import': return importNote(event)
    // `moveCell` and `setPath` are deliberately silent: reordering changes no cell's content, and
    // the path is not yet backed by a file the agent could read.
    default: return undefined
  }
}

/** `cell 3 (code)`, or `the code cell` when its position is unknown. */
function cellLabel(event) {
  const index = Number.isInteger(event.index) && event.index >= 0 ? event.index + 1 : undefined
  const kind = event.kind === 'markdown' ? 'markdown' : 'code'
  return index === undefined ? `the ${kind} cell` : `cell ${index} (${kind})`
}

/** A fenced block that cannot be misread as the note's own prose. */
function fence(text, language = '') {
  const body = String(text ?? '')
  return `\`\`\`${language}\n${body}\n\`\`\``
}

/** Shorten text on a character budget, marking that it was cut. */
function snippet(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** `412 ms` below a second, `1.2 s` above it. */
function duration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return undefined
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
}

/**
 * A changed region with up to {@link DIFF_CONTEXT} lines of context on each side.
 *
 * Not a general diff: the point is to show the model what changed, not to be mergeable. Returns
 * `undefined` when the change is too large to be worth quoting, which makes the caller fall back to
 * the new source.
 */
function changedLines(before, after) {
  const left = String(before ?? '').split('\n')
  const right = String(after ?? '').split('\n')
  let head = 0
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1
  let tailLeft = left.length - 1
  let tailRight = right.length - 1
  while (tailLeft >= head && tailRight >= head && left[tailLeft] === right[tailRight]) {
    tailLeft -= 1
    tailRight -= 1
  }
  const lines = [
    ...left.slice(Math.max(0, head - DIFF_CONTEXT), head).map((line) => `  ${line}`),
    ...left.slice(head, tailLeft + 1).map((line) => `- ${line}`),
    ...right.slice(head, tailRight + 1).map((line) => `+ ${line}`),
  ]
  if (lines.length > MAX_DIFF_LINES) return undefined
  return lines.join('\n')
}

/** An edit, as a diff when it is small and as the new source when it is not. */
function editNote(event) {
  const before = String(event.before?.source ?? '')
  const after = String(event.source ?? '')
  const kindChanged = event.before?.kind !== undefined && event.before.kind !== event.kind
  if (!kindChanged && before === after) return undefined
  const label = cellLabel(event)
  if (kindChanged) {
    return {
      key: `cell:${event.id}`,
      summary: `Switched ${label.replace(/ \(.*\)$/, '')} to ${event.kind === 'markdown' ? 'markdown' : 'code'}`,
      text: `The user switched ${label} to ${event.kind === 'markdown' ? 'markdown' : 'code'}. It now holds:\n${fence(snippet(after, MAX_SOURCE))}`,
    }
  }
  const diff = changedLines(before, after)
  const body = diff === undefined
    ? `The new source:\n${fence(snippet(after, MAX_SOURCE))}`
    : `The change:\n${fence(diff, 'diff')}`
  return {
    key: `cell:${event.id}`,
    summary: `Edited ${label}`,
    text: `The user edited ${label}. ${body}`,
  }
}

/** A run that has started but not finished — only interesting if the agent is asked mid-run. */
function runStartNote(event) {
  const label = cellLabel(event)
  return {
    key: `cell:${event.id}`,
    summary: `Running ${label}`,
    text: `The user ran ${label}; it is still running. Its source:\n${fence(snippet(event.source, MAX_SOURCE))}`,
  }
}

/** A finished run: outcome first, then the code, then the tail of what it printed. */
function runEndNote(event) {
  const execution = event.execution ?? {}
  const label = cellLabel(event)
  const status = typeof execution.status === 'string' ? execution.status : 'ok'
  const count = typeof execution.executionCount === 'number' ? ` as execution ${execution.executionCount}` : ''
  const took = duration(execution.durationMs)
  const outcome = OUTCOME[status] ?? status
  const sentence = `The user ran ${label}${count}; it ${outcome}${took === undefined ? '' : ` in ${took}`}.`
  const excerpt = outputExcerpt(execution.outputs)
  // A DSH-side failure (a disconnect, an interrupt) can end the call with no kernel output at
  // all; its message is then the only account of what happened.
  if (excerpt.text === '(no output)' && typeof execution.message === 'string' && execution.message.length > 0) {
    excerpt.text = snippet(execution.message, MAX_OUTPUT)
  }
  const summaryStatus = status === 'ok' ? (took === undefined ? 'ok' : `ok in ${took}`) : status
  return {
    key: `cell:${event.id}`,
    summary: `Ran ${label}: ${summaryStatus}`,
    text: [
      sentence,
      `Source:\n${fence(snippet(event.source, MAX_SOURCE))}`,
      `${excerpt.error === true ? 'Output (traceback)' : 'Output'}:\n${fence(excerpt.text)}`,
    ].join('\n\n'),
  }
}

/** A markdown cell that was rendered rather than executed. */
function markdownNote(event) {
  const index = Number.isInteger(event.index) && event.index >= 0 ? event.index + 1 : undefined
  const where = index === undefined ? 'a markdown cell' : `markdown cell ${index}`
  const body = String(event.source ?? '').trim()
  const content = body.length === 0 ? '' : ` It now reads:\n${fence(snippet(body, MAX_SOURCE))}`
  return {
    key: `cell:${event.id}`,
    summary: `Rendered ${where}`,
    text: `The user rendered ${where} in the panel. Rendering prose does not touch the kernel.${content}`,
  }
}

/** A new cell. */
function addNote(event) {
  const label = cellLabel(event)
  const body = String(event.source ?? '').trim()
  return {
    key: `add:${event.id}`,
    summary: `Added ${label}`,
    text: `The user added ${label}${body.length === 0 ? ', currently empty' : `, holding:\n${fence(snippet(body, MAX_SOURCE))}`}.`,
  }
}

/** A deleted cell: its text is the only thing that cannot be recovered. */
function deleteNote(event) {
  const label = cellLabel(event)
  const body = String(event.source ?? '').trim()
  const kept = event.replaced === true ? ' The notebook keeps one empty cell.' : ''
  return {
    key: `delete:${event.id}`,
    summary: `Deleted ${label}`,
    text: `The user deleted ${label}${body.length === 0 ? '.' : `, which held:\n${fence(snippet(body, 400))}`}${kept}`,
  }
}

/** One cell's output cleared. */
function clearNote(event) {
  const label = cellLabel(event)
  return {
    key: `clear:${event.id}`,
    summary: `Cleared the output of ${label}`,
    text: `The user cleared the output of ${label}. The cell's source is unchanged.`,
  }
}

/** Every output cleared. */
function clearAllNote(event) {
  const count = Number.isInteger(event.count) ? ` (${event.count} cells)` : ''
  return {
    key: 'clear-all',
    summary: 'Cleared all outputs',
    text: `The user cleared the output of every cell${count}. No source changed.`,
  }
}

/** The notebook emptied. */
function resetNote(event) {
  const count = Number.isInteger(event.count) ? `${event.count} cells and their outputs` : 'every cell and its output'
  return {
    key: 'reset',
    summary: 'Reset the notebook',
    text: `The user reset the panel: ${count} are gone. The kernel and its variables were not touched.`,
  }
}

/**
 * A `.ipynb` file replaced (or joined) the notebook.
 *
 * This is the largest change a note can describe — every cell may be different — so the model is
 * told to re-read rather than given a list. The dropped-item count matters too: it says the panel
 * on screen is not a faithful copy of the file.
 */
function importNote(event) {
  const count = Number.isInteger(event.count) ? `${event.count} cells` : 'a notebook'
  const append = event.mode === 'append'
  const verb = append ? 'appended to the notebook' : 'replaced the notebook in the panel'
  const dropped = Number.isInteger(event.dropped) && event.dropped > 0
    ? ` ${event.dropped} item(s) could not be represented and were dropped.`
    : ''
  return {
    key: 'import',
    summary: append ? 'Appended a notebook' : 'Imported a notebook',
    text: `The user imported a .ipynb file: ${count} ${verb}.${dropped} The previous cell numbering no longer applies; read the notebook again before referring to a cell by number.`,
  }
}

/**
 * What a run printed, reduced to something a note can quote.
 *
 * A traceback wins over stdout — it is the part the model is expected to act on. Text keeps its
 * tail, because the end of a log is where the failure is.
 *
 * @param outputs - The renderable outputs of one run.
 * @returns The quoted text and whether it is a traceback.
 */
function outputExcerpt(outputs) {
  const list = Array.isArray(outputs) ? outputs : []
  const failure = list.find((output) => output.type === 'error')
  if (failure !== undefined) return { text: snippet(failure.text, MAX_OUTPUT), error: true }
  const chunks = []
  let images = 0
  let html = 0
  let markdown = 0
  for (const output of list) {
    if (output.type === 'stream' || output.type === 'text') chunks.push(String(output.text ?? ''))
    else if (output.type === 'image') images += 1
    else if (output.type === 'html') html += 1
    else if (output.type === 'markdown') markdown += 1
  }
  let text = chunks.join('')
  if (text.length > MAX_OUTPUT) text = `…${text.slice(-MAX_OUTPUT)}`
  const rendered = []
  if (images > 0) rendered.push(`${images} image${images === 1 ? '' : 's'}`)
  if (html > 0) rendered.push('an html table')
  if (markdown > 0) rendered.push('markdown')
  if (rendered.length > 0) text += `${text.length === 0 ? '' : '\n'}[also rendered: ${rendered.join(', ')}]`
  return { text: text.trim().length === 0 ? '(no output)' : text, error: false }
}
