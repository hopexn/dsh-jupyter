/**
 * Jupyter's own notebook format, in and out.
 *
 * The panel keeps a deliberately small model — two cell kinds, a handful of renderable output
 * types — while `.ipynb` is a document format with more of everything: raw cells, output types no
 * browser can draw, cell metadata, attachments. A conversion between the two is lossy in both
 * directions, and the loss has to be **named** rather than silent: a notebook that quietly dropped
 * its plots on export would be worse than one that refused, and an import that skipped a cell
 * without saying so would make the panel look like it ate the user's work.
 *
 * Both functions are pure and synchronous: the caller owns the file system, the asset store and the
 * network, and passes them in as two small callbacks. That is what lets the format be tested
 * without a notebook, a kernel, or a browser.
 *
 * Budgets mirror `lib/notebook.js` (an import cannot create a cell the panel is unable to render,
 * and those limits live with the renderer). They are duplicated rather than imported because
 * `notebook.js` imports this module, and a cycle between two modules this small is not worth the
 * exported-indirection it would take to avoid.
 *
 * @module dsh-jupyterlab/ipynb
 */

/** The notebook format this module speaks. Version 4 has been the current one since 2011. */
export const IPYNB_MAJOR = 4
export const IPYNB_MINOR = 5

/** Image types a cell can hold, in the renderer's priority order. */
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Same budgets as the renderer; see the module comment. */
const MAX_TEXT_PER_CELL = 200_000
const MAX_HTML_BYTES = 256 * 1024
const MAX_IMAGES_PER_CELL = 8
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
/** A document with thousands of cells has no virtual scrolling to survive in; say so instead. */
const MAX_CELLS = 500

/** Appended to text a budget shortened. */
const TRUNCATION_MARK = '\n… [truncated]'

/** Strip the colour codes a traceback carries before it becomes a cell's text. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => String(text ?? '').replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')

/**
 * Split text into nbformat's line array.
 *
 * The format stores `source` as a list of lines that each keep their trailing newline, except
 * possibly the last. Readers accept a plain string too, which is why imports have to handle both —
 * and why the output of this function is checked in the round-trip test rather than assumed.
 *
 * @param text - Cell source or output text.
 * @returns Lines, empty for empty text.
 */
function sourceLines(text) {
  const value = String(text ?? '')
  if (value.length === 0) return []
  const parts = value.split('\n')
  const lines = []
  for (let index = 0; index < parts.length; index += 1) {
    const last = index === parts.length - 1
    // `a\n` splits into ['a', '']: the empty tail is not a line, it is the newline of the one above.
    if (last && parts[index] === '') break
    lines.push(last ? parts[index] : `${parts[index]}\n`)
  }
  return lines
}

/**
 * Join nbformat's `source` back into one string.
 *
 * @param source - A list of lines, a plain string, or nothing.
 * @returns The cell's text.
 */
function joinSource(source) {
  if (typeof source === 'string') return source
  if (!Array.isArray(source)) return ''
  return source.map((line) => String(line ?? '')).join('')
}

/** Keep at most `limit` characters, marking the cut. */
function clip(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - TRUNCATION_MARK.length))}${TRUNCATION_MARK}`
}

/** One decimal place, for a warning that quotes a size. */
const mib = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`

/**
 * The bytes behind an image output, for export.
 *
 * A stored image is a URL — the notebook document holds a hash, not a picture — so the export has
 * to ask the store for the payload back. An inline data URL carries its own bytes and needs no
 * lookup.
 *
 * @param output - A renderable image output.
 * @param readAsset - `(name) => {mime, data} | undefined`.
 * @returns `{mime, base64}`, or undefined when the bytes are gone.
 */
function imageBytes(output, readAsset) {
  if (typeof output.dataUrl === 'string') {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(output.dataUrl)
    if (match === null) return undefined
    return { mime: match[1], base64: match[2] }
  }
  if (typeof output.url === 'string' && typeof readAsset === 'function') {
    // The URL is `api/jupyterlab/asset?name=<hash>.<ext>`; the name is all the store needs.
    let name
    try {
      name = new URL(output.url, 'http://x/').searchParams.get('name')
    } catch {
      return undefined
    }
    if (name === null) return undefined
    const asset = readAsset(name)
    if (asset?.data === undefined) return undefined
    return { mime: asset.mime ?? output.mime ?? 'image/png', base64: Buffer.from(asset.data).toString('base64') }
  }
  return undefined
}

/**
 * One renderable output as an nbformat output.
 *
 * `text/html` and `text/markdown` become `display_data`, not `execute_result`: the model does not
 * remember whether a given bundle was the value of the last expression or a `display()` call, and
 * claiming the former would put a wrong `Out[n]` in front of it in JupyterLab.
 *
 * @param output - Renderable output from a cell.
 * @param readAsset - Image lookup.
 * @returns An nbformat output object, or undefined when it cannot be represented.
 */
function outputToIpynb(output, readAsset) {
  switch (output?.type) {
    case 'stream':
      return {
        output_type: 'stream',
        name: output.name === 'stderr' ? 'stderr' : 'stdout',
        text: sourceLines(output.text),
      }
    case 'error':
      // The panel keeps a rendered traceback, not the (ename, evalue, traceback) triple. Putting
      // the whole text in `traceback` is what a reader colours; `ename` stays generic because
      // inventing one would be a lie the panel cannot back up.
      return { output_type: 'error', ename: 'Error', evalue: '', traceback: sourceLines(stripAnsi(output.text)) }
    case 'image': {
      const payload = imageBytes(output, readAsset)
      if (payload === undefined) return undefined
      return { output_type: 'display_data', data: { [payload.mime]: payload.base64 }, metadata: {} }
    }
    case 'html':
      return { output_type: 'display_data', data: { 'text/html': String(output.text ?? '') }, metadata: {} }
    case 'markdown':
      return { output_type: 'display_data', data: { 'text/markdown': String(output.text ?? '') }, metadata: {} }
    case 'text':
      return { output_type: 'display_data', data: { 'text/plain': String(output.text ?? '') }, metadata: {} }
    default:
      return undefined
  }
}

/** A cell id nbformat will accept: `^[A-Za-z0-9_-]{1,64}$`, and stable across exports. */
function cellId(cell, index) {
  const cleaned = String(cell?.id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  return cleaned.length > 0 ? cleaned : `cell-${index + 1}`
}

/**
 * Build an `nbformat` 4 document from the panel's cells.
 *
 * Execution counts travel with the cells, so an exported notebook still shows `Out[7]` where the
 * user saw it — the outputs are the point of the file, and a notebook whose counts were reset
 * looks like it never ran.
 *
 * @param cells - The notebook's cells.
 * @param options - Export controls.
 * @param options.language - Kernel language, written to `language_info`.
 * @param options.readAsset - `(name) => {mime, data}` for the images a cell references.
 * @returns The document, ready to be written as JSON.
 */
export function notebookToIpynb(cells, { language = 'python', readAsset } = {}) {
  const document = {
    // No `kernelspec`: the panel knows the kernel's *name* at most, and a wrong kernelspec makes
    // JupyterLab offer to start a kernel that does not exist. `language_info` is enough to open.
    nbformat: IPYNB_MAJOR,
    nbformat_minor: IPYNB_MINOR,
    metadata: { language_info: { name: String(language) } },
    cells: [],
  }
  let index = 0
  for (const cell of cells ?? []) {
    const source = sourceLines(cell?.source)
    const id = cellId(cell, index)
    index += 1
    if (cell?.kind === 'markdown') {
      document.cells.push({ cell_type: 'markdown', id, metadata: {}, source })
      continue
    }
    const outputs = []
    for (const output of cell?.outputs ?? []) {
      const mapped = outputToIpynb(output, readAsset)
      if (mapped !== undefined) outputs.push(mapped)
    }
    document.cells.push({
      cell_type: 'code',
      id,
      metadata: {},
      execution_count: Number.isInteger(cell?.executionCount) ? cell.executionCount : null,
      source,
      outputs,
    })
  }
  return document
}

/**
 * Turn one nbformat MIME bundle into renderable outputs.
 *
 * The order is the renderer's (image, then html, then markdown, then plain text) because the panel
 * draws one representation per bundle and it should be the richest one, exactly as a live run does.
 *
 * @param data - The bundle's `data` map.
 * @param context - Caps, warnings and the asset store.
 */
function bundleOutputs(data, context) {
  const { putAsset, warnings, label } = context
  const outputs = []
  const bundle = data !== null && typeof data === 'object' ? data : {}
  let image
  for (const mime of IMAGE_MIMES) {
    if (typeof bundle[mime] === 'string') {
      image = mime
      break
    }
  }
  if (image !== undefined) {
    const base64 = String(bundle[image]).replace(/\s+/g, '')
    if (base64.length === 0) {
      warnings.push(`${label}: an ${image} output was empty and was dropped`)
    } else if (base64.length > MAX_IMAGE_BYTES) {
      warnings.push(`${label}: an ${image} output is over ${mib(MAX_IMAGE_BYTES)} and was dropped`)
    } else if (context.images >= MAX_IMAGES_PER_CELL) {
      warnings.push(`${label}: kept the first ${MAX_IMAGES_PER_CELL} images, the rest were dropped`)
    } else {
      context.images += 1
      const stored = putAsset?.(image, base64)
      outputs.push(stored === undefined
        ? { type: 'image', mime: image, dataUrl: `data:${image};base64,${base64}` }
        : { type: 'image', mime: image, url: stored.url })
    }
  }
  const html = typeof bundle['text/html'] === 'string' ? bundle['text/html'] : ''
  const markdown = typeof bundle['text/markdown'] === 'string' ? bundle['text/markdown'] : ''
  const plain = typeof bundle['text/plain'] === 'string' ? bundle['text/plain'] : ''
  if (html.trim().length > 0) {
    if (html.length <= MAX_HTML_BYTES) outputs.push({ type: 'html', text: html })
    else outputs.push({ type: 'text', text: clip(html, MAX_TEXT_PER_CELL) })
  } else if (markdown.trim().length > 0) {
    outputs.push({ type: 'markdown', text: clip(markdown, MAX_TEXT_PER_CELL) })
  } else if (plain.trim().length > 0) {
    outputs.push({ type: 'text', text: clip(plain, MAX_TEXT_PER_CELL) })
  } else {
    const known = Object.keys(bundle)
    if (known.length > 0) {
      // `application/json`, `text/latex`, widgets: the panel cannot draw these, but saying which
      // MIME was there is more useful than an empty box.
      warnings.push(`${label}: dropped a ${known.join(', ')} output the panel cannot render`)
    }
  }
  return outputs
}

/**
 * One nbformat output as renderable entries.
 *
 * @param output - An entry of a code cell's `outputs`.
 * @param context - Caps, warnings and the asset store.
 * @returns Renderable outputs, possibly empty.
 */
function outputFromIpynb(output, context) {
  const kind = String(output?.output_type ?? '')
  if (kind === 'stream') {
    return [{
      type: 'stream',
      name: output.name === 'stderr' ? 'stderr' : 'stdout',
      text: clip(joinSource(output.text), MAX_TEXT_PER_CELL),
    }]
  }
  if (kind === 'error') {
    const traceback = Array.isArray(output.traceback) && output.traceback.length > 0
      ? output.traceback.join('\n')
      : `${output.ename ?? 'Error'}: ${output.evalue ?? ''}`
    return [{ type: 'error', text: clip(stripAnsi(traceback), MAX_TEXT_PER_CELL) }]
  }
  if (kind === 'execute_result' || kind === 'display_data') {
    return bundleOutputs(output.data, context)
  }
  if (kind.length > 0) context.warnings.push(`${context.label}: dropped an "${kind}" output`)
  return []
}

/**
 * Parse an `nbformat` 4 document into cells this model can hold.
 *
 * @param document - Parsed JSON of a `.ipynb` file.
 * @param options - Import controls.
 * @param options.putAsset - `(mime, base64) => {url}`; without it images stay inline as data URLs.
 * @returns `{cells, warnings, title}`; `cells` is never empty.
 * @throws {Error} When the document is not an `nbformat` 4 notebook.
 */
export function ipynbToCells(document, { putAsset } = {}) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('not a notebook document')
  }
  if (Number(document.nbformat) !== IPYNB_MAJOR) {
    throw new Error(`nbformat ${document.nbformat ?? '(missing)'} is not supported; save the notebook as nbformat ${IPYNB_MAJOR}`)
  }
  const source = Array.isArray(document.cells) ? document.cells : []
  const warnings = []
  const cells = []
  for (let index = 0; index < source.length; index += 1) {
    if (cells.length >= MAX_CELLS) {
      warnings.push(`the document has more than ${MAX_CELLS} cells; the rest were not imported`)
      break
    }
    const entry = source[index] ?? {}
    const label = `cell ${index + 1}`
    const type = String(entry.cell_type ?? '')
    const text = joinSource(entry.source)
    if (type === 'markdown') {
      cells.push({ kind: 'markdown', source: text, outputs: [], executionCount: null })
      continue
    }
    if (type === 'code') {
      const context = { putAsset, warnings, label, images: 0 }
      const outputs = []
      for (const output of Array.isArray(entry.outputs) ? entry.outputs : []) {
        outputs.push(...outputFromIpynb(output, context))
      }
      cells.push({
        kind: 'code',
        source: text,
        outputs,
        executionCount: Number.isInteger(entry.execution_count) ? entry.execution_count : null,
      })
      continue
    }
    if (type === 'raw') {
      // Raw cells are unrendered text by definition; markdown is the closest thing the panel has
      // and shows the content instead of hiding it.
      cells.push({ kind: 'markdown', source: text, outputs: [], executionCount: null })
      warnings.push(`${label} is a raw cell and was imported as markdown`)
      continue
    }
    warnings.push(`${label} has an unknown type "${type}" and was skipped`)
  }
  if (cells.length === 0) cells.push({ kind: 'code', source: '', outputs: [], executionCount: null })
  return { cells, warnings }
}
