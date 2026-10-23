/**
 * Tests for the `.ipynb` conversion.
 *
 * The format is the only part of the plugin whose input is a file someone else wrote, so the
 * checks are about what survives and what is *reported*: a round trip has to keep the text, the
 * outputs and the execution counts, and anything the panel cannot hold has to come back as a
 * warning rather than as a quiet gap.
 *
 *   node test/ipynb.mjs
 */

import assert from 'node:assert/strict'

import { IPYNB_MAJOR, ipynbToCells, notebookToIpynb } from '../lib/ipynb.js'

let passed = 0
const failures = []

/** Run one named check, recording failures instead of aborting the run. */
async function check(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`FAIL  ${label}\n      ${error?.message ?? error}`)
  }
}

/** A cell shaped like the panel's model, with only the fields the format cares about. */
function cell(overrides) {
  return {
    id: 'c0ffee00-0000-4000-8000-000000000000',
    kind: 'code',
    source: '',
    outputs: [],
    executionCount: null,
    ...overrides,
  }
}

console.log('ipynb')

await check('a code cell keeps its source, count and outputs', async () => {
  const document = notebookToIpynb([cell({
    source: 'print(1)\nprint(2)',
    executionCount: 7,
    outputs: [
      { type: 'stream', name: 'stdout', text: '1\n2\n' },
      { type: 'error', text: 'Traceback\nValueError: boom' },
      { type: 'text', text: '42' },
    ],
  })])
  assert.equal(document.nbformat, IPYNB_MAJOR)
  const [entry] = document.cells
  assert.equal(entry.cell_type, 'code')
  assert.equal(entry.execution_count, 7)
  // Every line keeps its newline, except the last; a trailing newline is not a line of its own.
  assert.deepEqual(entry.source, ['print(1)\n', 'print(2)'])
  assert.deepEqual(entry.outputs[0], { output_type: 'stream', name: 'stdout', text: ['1\n', '2\n'] })
  assert.deepEqual(entry.outputs[1].traceback, ['Traceback\n', 'ValueError: boom'])
  assert.deepEqual(entry.outputs[2].data, { 'text/plain': '42' })
})

await check('a markdown cell exports as markdown and never as code', async () => {
  const document = notebookToIpynb([cell({ kind: 'markdown', source: '# Title' })])
  assert.deepEqual(document.cells[0], {
    cell_type: 'markdown',
    id: 'c0ffee00-0000-4000-8000-000000000000',
    metadata: {},
    source: ['# Title'],
  })
})

await check('an image references the asset store instead of carrying bytes', async () => {
  const asked = []
  const document = notebookToIpynb([cell({
    outputs: [{ type: 'image', mime: 'image/png', url: 'api/jupyterlab/asset?name=abc123.png' }],
  })], {
    readAsset: (name) => { asked.push(name); return { mime: 'image/png', data: Buffer.from('hello') } },
  })
  assert.deepEqual(asked, ['abc123.png'])
  assert.deepEqual(document.cells[0].outputs[0].data, { 'image/png': Buffer.from('hello').toString('base64') })
})

await check('a data URL needs no store, and a lost asset is dropped rather than faked', async () => {
  const inline = notebookToIpynb([cell({
    outputs: [{ type: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }],
  })])
  assert.deepEqual(inline.cells[0].outputs[0].data, { 'image/png': 'aGVsbG8=' })
  const lost = notebookToIpynb([cell({
    outputs: [{ type: 'image', mime: 'image/png', url: 'api/jupyterlab/asset?name=gone.png' }],
  })], { readAsset: () => undefined })
  assert.deepEqual(lost.cells[0].outputs, [])
})

await check('a round trip keeps the text, the outputs and the counts', async () => {
  const original = [
    cell({ kind: 'markdown', source: 'Some prose\nand more' }),
    cell({ source: 'df.head()', executionCount: 3, outputs: [{ type: 'html', text: '<table><tr><td>1</td></tr></table>' }] }),
    cell({ source: 'print("x")', outputs: [{ type: 'stream', name: 'stderr', text: 'warn\n' }] }),
  ]
  const { cells, warnings } = ipynbToCells(notebookToIpynb(original))
  assert.deepEqual(warnings, [])
  assert.deepEqual(cells.map((entry) => entry.kind), ['markdown', 'code', 'code'])
  assert.equal(cells[0].source, 'Some prose\nand more')
  assert.equal(cells[1].executionCount, 3)
  assert.deepEqual(cells[1].outputs, [{ type: 'html', text: '<table><tr><td>1</td></tr></table>' }])
  assert.deepEqual(cells[2].outputs, [{ type: 'stream', name: 'stderr', text: 'warn\n' }])
})

await check('a document that is not nbformat 4 is refused, not guessed at', async () => {
  assert.throws(() => ipynbToCells({ nbformat: 3, cells: [] }), /nbformat 3 is not supported/)
  assert.throws(() => ipynbToCells(null), /not a notebook document/)
})

await check('source may be a string or a list, and code reads both', async () => {
  const { cells } = ipynbToCells({
    nbformat: 4,
    cells: [
      { cell_type: 'code', source: 'a = 1\nb = 2', outputs: [], execution_count: 1 },
      { cell_type: 'code', source: ['a = 1\n', 'b = 2'], outputs: [], execution_count: 2 },
    ],
  })
  assert.equal(cells[0].source, 'a = 1\nb = 2')
  assert.equal(cells[1].source, 'a = 1\nb = 2')
})

await check('an empty document still yields one editable cell', async () => {
  const { cells, warnings } = ipynbToCells({ nbformat: 4, cells: [] })
  assert.deepEqual(warnings, [])
  assert.equal(cells.length, 1)
  assert.equal(cells[0].kind, 'code')
  assert.equal(cells[0].source, '')
})

await check('imported images go to the asset store when there is one', async () => {
  const stored = []
  const { cells } = ipynbToCells({
    nbformat: 4,
    cells: [{ cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': 'aGVsbG8=' }, metadata: {} }], execution_count: 1 }],
  }, { putAsset: (mime, base64) => { stored.push([mime, base64]); return { url: 'api/jupyterlab/asset?name=abc.png' } } })
  assert.deepEqual(stored, [['image/png', 'aGVsbG8=']])
  assert.deepEqual(cells[0].outputs, [{ type: 'image', mime: 'image/png', url: 'api/jupyterlab/asset?name=abc.png' }])
  const inline = ipynbToCells({
    nbformat: 4,
    cells: [{ cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': 'aGVsbG8=' } }], execution_count: 1 }],
  })
  assert.equal(inline.cells[0].outputs[0].dataUrl, 'data:image/png;base64,aGVsbG8=')
})

await check('what cannot be imported is reported, not dropped quietly', async () => {
  const { cells, warnings } = ipynbToCells({
    nbformat: 4,
    cells: [
      { cell_type: 'raw', source: 'raw text' },
      { cell_type: 'heading', source: 'old style' },
      { cell_type: 'code', source: 'x', outputs: [{ output_type: 'display_data', data: { 'application/json': { a: 1 } } }] },
    ],
  })
  assert.equal(cells[0].kind, 'markdown')
  assert.equal(cells[0].source, 'raw text')
  assert.equal(cells.length, 2)
  assert.match(warnings[0], /cell 1 is a raw cell/)
  assert.match(warnings[1], /cell 2 has an unknown type "heading"/)
  assert.match(warnings[2], /cell 3: dropped a application\/json output/)
})

await check('an output over the image budget is dropped with its size quoted', async () => {
  const big = 'A'.repeat(3 * 1024 * 1024)
  const { cells, warnings } = ipynbToCells({
    nbformat: 4,
    cells: [{ cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': big } }] }],
  })
  assert.deepEqual(cells[0].outputs, [])
  assert.match(warnings[0], /over 2\.0 MiB and was dropped/)
})

await check('an html bundle over the budget falls back to text instead of disappearing', async () => {
  const html = `<table>${'x'.repeat(300 * 1024)}</table>`
  const { cells } = ipynbToCells({
    nbformat: 4,
    cells: [{ cell_type: 'code', source: 'df', outputs: [{ output_type: 'execute_result', data: { 'text/html': html } }] }],
  })
  assert.equal(cells[0].outputs.length, 1)
  assert.equal(cells[0].outputs[0].type, 'text')
  assert.match(cells[0].outputs[0].text, /\[truncated\]$/)
})

await check('execution counts survive, and "never run" stays null', async () => {
  const { cells } = ipynbToCells({
    nbformat: 4,
    cells: [
      { cell_type: 'code', source: 'a', execution_count: 12, outputs: [] },
      { cell_type: 'code', source: 'b', execution_count: null, outputs: [] },
    ],
  })
  assert.equal(cells[0].executionCount, 12)
  assert.equal(cells[1].executionCount, null)
})

await check('a document with too many cells stops at the cap and says so', async () => {
  const many = Array.from({ length: 620 }, (_, index) => ({ cell_type: 'code', source: `x${index}`, outputs: [] }))
  const { cells, warnings } = ipynbToCells({ nbformat: 4, cells: many })
  assert.equal(cells.length, 500)
  assert.match(warnings[0], /more than 500 cells/)
})

await check('the exported document is valid JSON, and parses back', async () => {
  const document = notebookToIpynb([cell({ source: 'a = 1', executionCount: 1 })])
  const parsed = JSON.parse(JSON.stringify(document))
  assert.equal(parsed.nbformat, 4)
  assert.equal(parsed.nbformat_minor, 5)
  assert.equal(parsed.metadata.language_info.name, 'python')
})

console.log(failures.length === 0 ? `\n${passed} passed` : `\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAILED ${failure.label}`)
  process.exit(1)
}

export { check, passed, failures }
