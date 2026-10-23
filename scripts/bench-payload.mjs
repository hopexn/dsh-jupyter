/**
 * Measure what a notebook view costs with and without the asset store.
 *
 *   node scripts/bench-payload.mjs
 *
 * The payload stands in for a figure: four 700 KiB base64 blobs in one cell. Inline data URLs put
 * all of them into every `view()`; the store replaces each with a URL, and the bytes are written
 * once and cached by the browser.
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { AssetStore } from '../lib/assets.js'
import { Notebooks } from '../lib/notebook.js'

/** One "figure": an opaque payload of a realistic size (a 600×400 noise PNG is around this). */
const figure = randomBytes(700 * 1024).toString('base64')

/** A kernel that always answers with four figures. */
const execute = async () => ({
  status: 'ok',
  executionCount: 1,
  durationMs: 10,
  outputs: [0, 1, 2, 3].map(() => ({ kind: 'result', data: { 'image/png': figure } })),
})

/** The store the "asset store" row writes into; assigned before the run that uses it. */
let store

for (const [label, asset] of [
  ['inline data URLs', undefined],
  ['asset store', (mime, base64) => store.put(mime, base64)],
]) {
  const directory = mkdtempSync(path.join(tmpdir(), 'dsh-bench-notebooks-'))
  store = new AssetStore({ directory: path.join(directory, 'assets') })
  const notebooks = new Notebooks({ directory, execute, asset })
  const cell = (await notebooks.view('bench')).cells[0]
  await notebooks.command('bench', { action: 'runCell', id: cell.id, source: 'plot' })
  await notebooks.idle('bench')
  const view = await notebooks.view('bench')
  const bytes = Buffer.byteLength(JSON.stringify(view))
  console.log(`${label.padEnd(18)} view = ${(bytes / 1024).toFixed(0)} KiB`)
  notebooks.dispose()
}

console.log(`(each figure is ${(figure.length / 1024).toFixed(0)} KiB of base64, four per cell)`)
process.exit(0)
