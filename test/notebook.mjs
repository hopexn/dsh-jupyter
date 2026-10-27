/**
 * Tests for the right-side panel's data plane: the notebook model and its HTTP route.
 *
 * Both halves are exercised without a browser — the route is registered against a fake Connection
 * service and driven with real `Request`/`Response` objects, so the contract the client bundle
 * depends on is covered even when no page is open.
 *
 *   node test/notebook.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Notebooks, OutputRenderer, renderableOutputs } from '../lib/notebook.js'
import { ASSET_ROUTE, DOWNLOAD_ROUTE, NOTEBOOK_ROUTE, STREAM_ROUTE, registerNotebookRoutes } from '../lib/routes.js'
import { AssetStore } from '../lib/assets.js'

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

const directory = mkdtempSync(path.join(tmpdir(), 'dsh-notebook-test-'))
const SESSION = 'session-under-test'

/** Deterministic stand-in for the kernel, recording what it was asked to run and where. */
function fakeRuntime() {
  const calls = []
  /** `{sessionId, code, server}` per execution: which page ran on which connection. */
  const runs = []
  /** `{sessionId, server}` per kernel-status read: the header must describe the page's kernel. */
  const kernelQueries = []
  let kernel = { id: 'kernel-1', name: 'python3', state: 'idle' }
  let next = 1
  const reply = (code, options = {}) => {
    if (code.includes('raise')) {
      return {
        status: 'error',
        executionCount: next++,
        durationMs: 12,
        outputs: [{ kind: 'error', ename: 'ValueError', evalue: 'boom', traceback: ['Traceback', 'ValueError: boom'] }],
      }
    }
    if (code.includes('image')) {
      return {
        status: 'ok',
        executionCount: next++,
        durationMs: 20,
        outputs: [{ kind: 'result', data: { 'text/plain': '<Figure>', 'image/png': 'aGVsbG8=' } }],
      }
    }
    if (code.includes('frame')) {
      return {
        status: 'ok',
        executionCount: next++,
        durationMs: 9,
        outputs: [{
          kind: 'result',
          data: {
            'text/plain': '   a  b\n0  1  2',
            'text/html': '<table class="dataframe"><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
          },
        }],
      }
    }
    if (code.includes('richmarkdown')) {
      return {
        status: 'ok',
        executionCount: next++,
        durationMs: 9,
        outputs: [{ kind: 'result', data: { 'text/plain': '# Title', 'text/markdown': '# Title' } }],
      }
    }
    if (code.includes('slow')) {
      return { status: 'timeout', message: 'no result within 2000ms; the kernel was interrupted', executionCount: null, durationMs: 2000, outputs: [{ kind: 'stream', name: 'stdout', text: 'partial\n' }] }
    }
    if (code.includes('streamy')) {
      // Two chunks in the same channel: the panel must see them grow, not appear all at once.
      options.onOutput?.({ kind: 'stream', name: 'stdout', text: 'first\n' })
      options.onOutput?.({ kind: 'stream', name: 'stdout', text: 'second\n' })
      return {
        status: 'ok',
        executionCount: next++,
        durationMs: 30,
        outputs: [{ kind: 'stream', name: 'stdout', text: 'first\nsecond\n' }],
      }
    }
    return {
      status: 'ok',
      executionCount: next++,
      durationMs: 5,
      outputs: [
        { kind: 'stream', name: 'stdout', text: `ran ${code}\n` },
        { kind: 'stream', name: 'stderr', text: 'warning\n' },
        { kind: 'result', data: { 'text/plain': '42' } },
      ],
    }
  }
  return {
    calls,
    runs,
    kernelQueries,
    runtime: {
      execute: async (sessionId, code, options) => {
        calls.push(code)
        runs.push({ sessionId, code, server: options?.server })
        return reply(code, options)
      },
      kernelInfo: async (sessionId, options) => {
        kernelQueries.push({ sessionId, server: options?.server })
        return kernel
      },
    },
    setKernel: (value) => { kernel = value },
  }
}

const fake = fakeRuntime()
const notebooks = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: fake.runtime.kernelInfo })
notebooks.setKernelAction(async (action) => `kernel ${action} done`)

console.log('notebook model')

await check('a fresh session starts with one empty cell and no kernel requirement', async () => {
  const view = await notebooks.view(SESSION)
  assert.equal(view.cells.length, 1)
  assert.equal(view.cells[0].source, '')
  assert.equal(view.cells[0].status, 'idle')
  assert.deepEqual(view.cells[0].outputs, [])
  assert.equal(view.kernel.name, 'python3')
})

await check('addCell appends, and afterId inserts', async () => {
  const first = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'updateCell', id: first.id, source: 'a = 1' })
  const inserted = await notebooks.command(SESSION, { action: 'addCell', afterId: first.id })
  assert.equal(inserted.cells.length, 2)
  assert.equal(inserted.cells[0].id, first.id)
  assert.equal(inserted.cells[1].source, '')
  const appended = await notebooks.command(SESSION, { action: 'addCell' })
  assert.equal(appended.cells.length, 3)
})

await check('updateCell replaces the source', async () => {
  const cells = (await notebooks.view(SESSION)).cells
  const view = await notebooks.command(SESSION, { action: 'updateCell', id: cells[1].id, source: 'b = 2' })
  assert.equal(view.cells[1].source, 'b = 2')
})

await check('a model rewrite keeps what it replaced; a user edit clears it', async () => {
  const session = 'diff-session'
  const first = (await notebooks.view(session)).cells[0]
  await notebooks.command(session, { action: 'updateCell', id: first.id, source: 'x = 1\ny = 2' })
  const rewritten = await notebooks.command(session, {
    action: 'updateCell',
    id: first.id,
    source: 'x = 1\ny = 3',
    origin: 'agent',
  }, {}, { note: false })
  assert.equal(rewritten.cells[0].source, 'x = 1\ny = 3')
  assert.equal(rewritten.cells[0].previousSource, 'x = 1\ny = 2', 'the replaced text is kept for the diff')
  // A second rewrite keeps the first baseline: the diff is everything that changed since the user
  // last touched the cell, not just the last hop.
  const again = await notebooks.command(session, {
    action: 'updateCell',
    id: first.id,
    source: 'x = 1\ny = 4',
    origin: 'agent',
  }, {}, { note: false })
  assert.equal(again.cells[0].previousSource, 'x = 1\ny = 2')
  // The model-facing snapshot is a summary, not the panel state: the extra field would be noise.
  assert.equal(notebooks.snapshot(session).cells[0].previousSource, undefined)

  const edited = await notebooks.command(session, { action: 'updateCell', id: first.id, source: 'x = 9' })
  assert.equal(edited.cells[0].previousSource, null, 'typing over it accepts it')
})

await check('dismissDiff keeps the model version, revertCell puts the old one back', async () => {
  const session = 'diff-revert'
  const first = (await notebooks.view(session)).cells[0]
  await notebooks.command(session, { action: 'updateCell', id: first.id, source: 'print(1)' })
  await notebooks.command(session, { action: 'updateCell', id: first.id, source: 'print(2)', origin: 'agent' }, {}, { note: false })

  const accepted = await notebooks.command(session, { action: 'dismissDiff', id: first.id })
  assert.equal(accepted.cells[0].source, 'print(2)')
  assert.equal(accepted.cells[0].previousSource, null)
  await assert.rejects(() => notebooks.command(session, { action: 'revertCell', id: first.id }), /no earlier version/)

  await notebooks.command(session, { action: 'updateCell', id: first.id, source: 'print(3)', origin: 'agent' }, {}, { note: false })
  const reverted = await notebooks.command(session, { action: 'revertCell', id: first.id })
  assert.equal(reverted.cells[0].source, 'print(2)', 'undo is one command, not a second edit')
  assert.equal(reverted.cells[0].previousSource, null)
})

await check('moveCell reorders and refuses to fall off either end', async () => {
  const cells = (await notebooks.view(SESSION)).cells
  const moved = await notebooks.command(SESSION, { action: 'moveCell', id: cells[2].id, delta: -1 })
  assert.deepEqual(moved.cells.map((cell) => cell.id), [cells[0].id, cells[2].id, cells[1].id])
  const clamped = await notebooks.command(SESSION, { action: 'moveCell', id: cells[0].id, delta: -1 })
  assert.deepEqual(clamped.cells.map((cell) => cell.id), [cells[0].id, cells[2].id, cells[1].id])
})

await check('deleteCell removes it, and never leaves the notebook empty', async () => {
  const cells = (await notebooks.view(SESSION)).cells
  const view = await notebooks.command(SESSION, { action: 'deleteCell', id: cells[0].id })
  assert.equal(view.cells.length, 2)
  await notebooks.command(SESSION, { action: 'deleteCell', id: view.cells[0].id })
  const last = await notebooks.command(SESSION, { action: 'deleteCell', id: (await notebooks.view(SESSION)).cells[0].id })
  assert.equal(last.cells.length, 1, 'the notebook must always keep one cell')
})

await check('runCell sends the code to the kernel and stores its outputs', async () => {
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'updateCell', id: cell.id, source: 'print(1)' })
  await notebooks.command(SESSION, { action: 'runCell', id: cell.id })
  await notebooks.idle(SESSION)
  const view = await notebooks.view(SESSION)
  const ran = view.cells[0]
  assert.equal(ran.status, 'ok')
  assert.equal(ran.executionCount, 1)
  assert.equal(ran.durationMs, 5)
  assert.deepEqual(ran.outputs, [
    { type: 'stream', name: 'stdout', text: 'ran print(1)\n' },
    { type: 'stream', name: 'stderr', text: 'warning\n' },
    { type: 'text', text: '42' },
  ])
  assert.deepEqual(fake.calls, ['print(1)'])
})

await check('a cell traceback becomes a renderable error output', async () => {
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'updateCell', id: cell.id, source: 'raise ValueError("boom")' })
  await notebooks.command(SESSION, { action: 'runCell', id: cell.id })
  await notebooks.idle(SESSION)
  const view = await notebooks.view(SESSION)
  assert.equal(view.cells[0].status, 'error')
  assert.equal(view.cells[0].outputs[0].type, 'error')
  assert.match(view.cells[0].outputs[0].text, /ValueError: boom/)
})

await check('an image result is delivered as a data URL beside its text', async () => {
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'updateCell', id: cell.id, source: 'show image' })
  await notebooks.command(SESSION, { action: 'runCell', id: cell.id })
  await notebooks.idle(SESSION)
  const view = await notebooks.view(SESSION)
  const types = view.cells[0].outputs.map((output) => output.type)
  assert.deepEqual(types, ['text', 'image'])
  assert.equal(view.cells[0].outputs[1].dataUrl, 'data:image/png;base64,aGVsbG8=')
})

await check('a DataFrame result renders as HTML instead of its plain-text repr', async () => {
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'updateCell', id: cell.id, source: 'frame' })
  await notebooks.command(SESSION, { action: 'runCell', id: cell.id })
  await notebooks.idle(SESSION)
  const view = await notebooks.view(SESSION)
  assert.deepEqual(view.cells[0].outputs.map((output) => output.type), ['html'])
  assert.match(view.cells[0].outputs[0].text, /<table class="dataframe">/)
  assert.equal(view.cells[0].outputs[0].text.includes('   a  b'), false, 'the plain repr must not be shown beside the table')
})

await check('a text/markdown result renders as markdown', async () => {
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'updateCell', id: cell.id, source: 'richmarkdown' })
  await notebooks.command(SESSION, { action: 'runCell', id: cell.id })
  await notebooks.idle(SESSION)
  const view = await notebooks.view(SESSION)
  assert.deepEqual(view.cells[0].outputs, [{ type: 'markdown', text: '# Title' }])
})

await check('markup past the HTML cap falls back to the text it came with', () => {
  const huge = `<table>${'<tr><td>x</td></tr>'.repeat(20_000)}</table>`
  const outputs = renderableOutputs([{ kind: 'result', data: { 'text/plain': 'too big', 'text/html': huge } }])
  assert.equal(outputs.length, 2, JSON.stringify(outputs.map((output) => output.type)))
  assert.equal(outputs[0].type, 'text')
  assert.match(outputs[0].text, /text\/html output omitted/)
  assert.equal(outputs[1].text, 'too big')
})

await check('a markdown cell renders without waking the kernel', async () => {
  const notebook = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: fake.runtime.kernelInfo })
  const cell = (await notebook.view(SESSION)).cells[0]
  await notebook.command(SESSION, { action: 'updateCell', id: cell.id, kind: 'markdown' })
  const before = fake.calls.length
  await notebook.command(SESSION, { action: 'runCell', id: cell.id, source: '# Title' })
  await notebook.idle(SESSION)
  const view = await notebook.view(SESSION)
  assert.equal(view.cells[0].kind, 'markdown')
  assert.equal(view.cells[0].status, 'ok')
  assert.deepEqual(view.cells[0].outputs, [])
  assert.equal(fake.calls.length, before, 'markdown must never reach the kernel')
  notebook.dispose()
})

await check('a timeout keeps the partial output and explains itself', async () => {
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'updateCell', id: cell.id, source: 'slow cell' })
  await notebooks.command(SESSION, { action: 'runCell', id: cell.id })
  await notebooks.idle(SESSION)
  const view = await notebooks.view(SESSION)
  assert.equal(view.cells[0].status, 'timeout')
  const texts = view.cells[0].outputs.map((output) => output.text)
  assert.ok(texts.includes('partial\n'), JSON.stringify(view.cells[0].outputs))
  assert.ok(texts.some((text) => /interrupted/.test(text)))
})

await check('an execution failure is reported on the cell instead of thrown', async () => {
  const failing = new Notebooks({
    directory,
    execute: async () => { throw new Error('cannot reach the kernel') },
    kernelInfo: async () => undefined,
  })
  const cell = (await failing.view(SESSION)).cells[0]
  await failing.command(SESSION, { action: 'runCell', id: cell.id })
  await failing.idle(SESSION)
  const view = await failing.view(SESSION)
  assert.equal(view.cells[0].status, 'error')
  assert.equal(view.cells[0].error, 'cannot reach the kernel')
  failing.dispose()
})

await check('runCell answers before the kernel is done, and the run outlives the request', async () => {
  let release
  const pending = new Notebooks({
    directory,
    execute: () => new Promise((resolve) => { release = resolve }),
    kernelInfo: async () => undefined,
  })
  const cell = (await pending.view('session-async')).cells[0]
  // The old shape awaited the execution here, which is exactly why a 60-second cell left the panel
  // blank for 60 seconds and why a page reload (an aborted POST) killed it.
  const view = await pending.command('session-async', { action: 'runCell', id: cell.id, source: 'sleep(60)' })
  assert.equal(view.cells[0].status, 'running', 'the command must not wait for the execution')
  assert.equal(pending.isRunning('session-async'), true)
  release({ status: 'ok', executionCount: 7, durationMs: 60_000, outputs: [{ kind: 'stream', name: 'stdout', text: 'done\n' }] })
  await pending.idle('session-async')
  const after = await pending.view('session-async')
  assert.equal(after.cells[0].status, 'ok')
  assert.equal(after.cells[0].executionCount, 7)
  assert.deepEqual(after.cells[0].outputs, [{ type: 'stream', name: 'stdout', text: 'done\n' }])
  pending.dispose()
})

await check('output streams to subscribers as it is produced, ending with the whole cell', async () => {
  const events = []
  const off = notebooks.subscribe(SESSION, (event) => events.push(event))
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'runCell', id: cell.id, source: 'streamy' })
  await notebooks.idle(SESSION)
  off()
  const kinds = events.map((event) => event.type)
  assert.equal(kinds[0], 'cell', 'the start of a run is announced first')
  const texts = events.filter((event) => event.type === 'text')
  assert.deepEqual(texts.map((event) => event.text), ['first\n', 'second\n'])
  assert.deepEqual(texts.map((event) => event.index), [0, 0], 'both chunks belong to one output')
  const last = events[events.length - 1]
  assert.equal(last.type, 'cell')
  assert.equal(last.cell.status, 'ok')
  assert.deepEqual(last.cell.outputs, [{ type: 'stream', name: 'stdout', text: 'first\nsecond\n' }])
})

await check('unsubscribing stops the events', async () => {
  const seen = []
  notebooks.subscribe(SESSION, (event) => seen.push(event))()
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'runCell', id: cell.id, source: 'print(2)' })
  await notebooks.idle(SESSION)
  assert.deepEqual(seen, [])
})

await check('an image is stored once by content and referenced by URL', async () => {
  const assets = new AssetStore({ directory: path.join(directory, 'assets'), maxCachedBytes: 4 })
  const stored = new Notebooks({
    directory,
    execute: fake.runtime.execute,
    asset: (mime, base64) => assets.put(mime, base64),
  })
  const first = async () => {
    const cell = (await stored.view('session-image')).cells[0]
    await stored.command('session-image', { action: 'runCell', id: cell.id, source: 'show image' })
    await stored.idle('session-image')
    return (await stored.view('session-image')).cells[0]
  }
  const cell = await first()
  const image = cell.outputs.find((output) => output.type === 'image')
  assert.ok(image !== undefined, JSON.stringify(cell.outputs))
  assert.equal(image.dataUrl, undefined, 'the bytes must not travel inside the notebook document')
  assert.match(image.url, /^api\/jupyterlab\/asset\?name=[0-9a-f]{20}\.png$/)
  const name = image.url.split('name=')[1]
  assert.equal(assets.get(name)?.data.toString(), 'hello')
  // Running it again stores nothing new: the name is the hash of the bytes.
  await first()
  assert.equal(assets.size, 1)
  // The store refuses anything that is not one of its own names.
  assert.equal(assets.get('../../etc/passwd'), undefined)
  assert.equal(assets.get('nope.png'), undefined)
  stored.dispose()
})

await check('the asset directory is bounded on a schedule, not once per process', () => {
  const assets = new AssetStore({
    directory: path.join(directory, 'assets-prune'),
    maxDiskBytes: 5,
    // Zero makes every write measure the directory, which is the point under test: the old code
    // set a "pruned" flag on the very first call and never looked again.
    pruneIntervalMs: 0,
  })
  for (const payload of ['aaaa', 'bbbb', 'cccc']) assets.put('image/png', Buffer.from(payload).toString('base64'))
  const files = readdirSync(path.join(directory, 'assets-prune')).filter((name) => name.endsWith('.png'))
  assert.equal(files.length, 2, `expected the oldest file to be pruned, found ${files.join(', ')}`)
})

await check('clearOutput and clearAllOutputs empty the outputs', async () => {
  const before = await notebooks.view(SESSION)
  assert.ok(before.cells[0].outputs.length > 0)
  const one = await notebooks.command(SESSION, { action: 'clearOutput', id: before.cells[0].id })
  assert.deepEqual(one.cells[0].outputs, [])
  assert.equal(one.cells[0].status, 'idle')
})

await check('kernel commands are delegated and their message returned', async () => {
  const view = await notebooks.command(SESSION, { action: 'restartKernel' })
  assert.equal(view.message, 'kernel restartKernel done')
})

await check('an unknown action is rejected', async () => {
  await assert.rejects(() => notebooks.command(SESSION, { action: 'explode' }), /unknown notebook action/)
})

await check('a cell id from another notebook is rejected', async () => {
  await assert.rejects(() => notebooks.command(SESSION, { action: 'updateCell', id: 'nope', source: 'x' }), /not in this notebook/)
})

await check('edits are mirrored to disk and restored by a fresh model', async () => {
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'updateCell', id: cell.id, source: 'persisted = True' })
  const restored = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: fake.runtime.kernelInfo })
  const view = await restored.view(SESSION)
  assert.equal(view.cells[0].source, 'persisted = True')
  restored.dispose()
})

await check('the mirror never carries a stale running status', async () => {
  const file = path.join(directory, `${SESSION}.json`)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  // The mirror holds every notebook plus the active name, so the cells under test are on the page
  // that was open, not at the top level.
  const cells = raw.notebooks[raw.active].cells
  assert.ok(cells.length > 0, 'expected the active notebook to hold cells')
  for (const cell of cells) assert.equal(cell.status, 'idle')
})

console.log('\noutput rendering')
await check('oversized text is truncated rather than sent whole', () => {
  const rendered = renderableOutputs([{ kind: 'stream', name: 'stdout', text: 'x'.repeat(500_000) }])
  assert.equal(rendered.length, 1)
  assert.ok(rendered[0].text.length < 500_000)
  assert.match(rendered[0].text, /truncated/)
})
await check('an oversized image is summarized instead of embedded', () => {
  const big = 'a'.repeat(3 * 1024 * 1024)
  const rendered = renderableOutputs([{ kind: 'result', data: { 'image/png': big } }])
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /omitted/)
})

console.log('\nagent runs and inspection')

await check('a run the agent performs becomes a cell, streamed like the user\'s own', async () => {
  const SESSION = 'agent-run-session'
  const isolated = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: fake.runtime.kernelInfo })
  const events = []
  isolated.subscribe(SESSION, (event) => events.push(event))
  const recorder = isolated.beginAgentRun(SESSION, 'streamy')
  assert.equal(events[0].type, 'insert')
  assert.equal(events[0].cell.origin, 'agent')
  assert.equal(events[0].cell.status, 'running')
  const execution = await fake.runtime.execute(SESSION, 'streamy', { onOutput: recorder.onOutput })
  recorder.finish(execution)
  assert.ok(events.some((event) => event.type === 'text'), 'output has to stream, not only land at the end')
  assert.equal(events.at(-1).type, 'cell')
  const cell = (await isolated.view(SESSION)).cells.at(-1)
  assert.equal(cell.origin, 'agent')
  assert.equal(cell.status, 'ok')
  assert.equal(cell.outputs[0].text, 'first\nsecond\n')
})

await check('a host-side failure of an agent run is shown on its cell', async () => {
  const SESSION = 'agent-fail-session'
  const isolated = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: fake.runtime.kernelInfo })
  const recorder = isolated.beginAgentRun(SESSION, 'boom')
  recorder.fail(new Error('socket closed'))
  const cell = (await isolated.view(SESSION)).cells.at(-1)
  assert.equal(cell.status, 'error')
  assert.equal(cell.error, 'socket closed')
})

await check('runCellNow waits and returns what the cell printed', async () => {
  const SESSION = 'run-now-session'
  const isolated = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: fake.runtime.kernelInfo })
  const cell = (await isolated.view(SESSION)).cells[0]
  await isolated.command(SESSION, { action: 'updateCell', id: cell.id, source: 'print(7)' })
  const outcome = await isolated.runCellNow(SESSION, cell.id)
  assert.equal(outcome.status, 'ok')
  assert.match(outcome.output, /ran print\(7\)/)
  assert.equal(isolated.isRunning(SESSION), false)
  assert.equal(typeof outcome.executionCount, 'number')
})

await check('a tool-driven run produces no "the user ran" note', async () => {
  const SESSION = 'tool-run-session'
  const notes = []
  const isolated = new Notebooks({
    directory,
    execute: fake.runtime.execute,
    kernelInfo: fake.runtime.kernelInfo,
    activity: { record: (_sessionId, event) => notes.push(event), pending: () => notes.length, list: () => [] },
  })
  const cell = (await isolated.view(SESSION)).cells[0]
  await isolated.command(SESSION, { action: 'updateCell', id: cell.id, source: 'print(1)' })
  const before = notes.length
  await isolated.runCellNow(SESSION, cell.id)
  assert.equal(notes.length, before, 'the model already has the output; a user note would be a lie')
})

await check('the snapshot is bounded and carries the revision needed for a safe edit', async () => {
  const SESSION = 'snapshot-session'
  const isolated = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: fake.runtime.kernelInfo })
  const cell = (await isolated.view(SESSION)).cells[0]
  await isolated.command(SESSION, { action: 'updateCell', id: cell.id, source: `x = 1\n${'y'.repeat(5000)}` })
  const snapshot = isolated.snapshot(SESSION, { maxSource: 100, maxOutput: 100 })
  assert.equal(snapshot.cells[0].sourceTruncated, true)
  assert.match(snapshot.cells[0].source, /characters omitted/)
  assert.equal(typeof snapshot.cells[0].rev, 'number')
  assert.equal(snapshot.cells[0].index, 1)
})

await check('reading a session that never opened a panel creates nothing', () => {
  const isolated = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: fake.runtime.kernelInfo })
  const snapshot = isolated.snapshot('never-opened')
  assert.deepEqual(snapshot.cells, [])
  assert.equal(isolated.size, 0)
})

await check('the outline names the cell, its kind and its last execution', async () => {
  const SESSION = 'outline-session'
  const isolated = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: fake.runtime.kernelInfo })
  const cell = (await isolated.view(SESSION)).cells[0]
  await isolated.command(SESSION, { action: 'updateCell', id: cell.id, source: 'import pandas as pd\nx = 1' })
  await isolated.command(SESSION, { action: 'runCell', id: cell.id })
  await isolated.idle(SESSION)
  const outline = isolated.outline(SESSION)
  assert.match(outline, /revision \d+/)
  assert.match(outline, /1\. \[code\] Out\[\d+\].*import pandas as pd/)
})

console.log('\npanel activity')

// A recorder instead of the real buffer: this file is about what the model reports, not about how
// a note is worded (that is `test/activity.mjs`).
const events = []
const watched = new Notebooks({
  directory,
  execute: fake.runtime.execute,
  kernelInfo: fake.runtime.kernelInfo,
  activity: {
    record: (sessionId, event) => events.push({ sessionId, event }),
    pending: (sessionId) => events.filter((entry) => entry.sessionId === sessionId).length,
    list: (sessionId) => events
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry, index) => ({ key: `note-${index}`, summary: entry.event.type })),
    forget: (sessionId) => {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].sessionId === sessionId) events.splice(index, 1)
      }
    },
  },
})
const WATCHED = 'watched-session'
const lastEvent = () => events[events.length - 1]

await check('editing a cell reports the cell, its position, and both versions', async () => {
  const first = (await watched.view(WATCHED)).cells[0]
  await watched.command(WATCHED, { action: 'updateCell', id: first.id, source: 'a = 1' })
  const entry = lastEvent()
  assert.equal(entry.sessionId, WATCHED)
  assert.equal(entry.event.type, 'edit')
  assert.equal(entry.event.index, 0)
  assert.equal(entry.event.id, first.id)
  assert.deepEqual(entry.event.before, { kind: 'code', source: '' })
  assert.equal(entry.event.source, 'a = 1')
})

await check('a run reports its start and then its outcome', async () => {
  const cell = (await watched.view(WATCHED)).cells[0]
  const before = events.length
  await watched.command(WATCHED, { action: 'runCell', id: cell.id, source: 'print(2)' })
  assert.equal(events[before].event.type, 'run-start')
  assert.match(events[before].event.source, /print\(2\)/)
  await watched.idle(WATCHED)
  const end = lastEvent()
  assert.equal(end.event.type, 'run-end')
  assert.equal(end.event.execution.status, 'ok')
  assert.equal(end.event.index, 0)
  assert.match(end.event.source, /print\(2\)/, 'the note quotes what actually ran')
})

await check('structural actions are reported in order', async () => {
  const start = events.length
  const added = await watched.command(WATCHED, { action: 'addCell' })
  const addedCell = added.cells[added.cells.length - 1]
  await watched.command(WATCHED, { action: 'clearOutput', id: addedCell.id })
  await watched.command(WATCHED, { action: 'clearAllOutputs' })
  await watched.command(WATCHED, { action: 'deleteCell', id: addedCell.id })
  await watched.command(WATCHED, { action: 'reset' })
  assert.deepEqual(
    events.slice(start).map((entry) => entry.event.type),
    ['add', 'clear', 'clear-all', 'delete', 'reset'],
  )
  assert.ok(lastEvent().event.count >= 1, 'a reset reports how much it discarded')
})

await check('reordering is not worth a note', async () => {
  await watched.command(WATCHED, { action: 'addCell' })
  const cells = (await watched.view(WATCHED)).cells
  const before = events.length
  await watched.command(WATCHED, { action: 'moveCell', id: cells[0].id, delta: 1 })
  assert.equal(events.length, before)
})

await check('the view counts what is waiting for the model, and names it', async () => {
  const view = await watched.view(WATCHED)
  assert.ok(view.pendingNotes > 0)
  assert.equal(watched.pendingNotes(WATCHED), view.pendingNotes)
  assert.equal(view.notes.length, view.pendingNotes)
  assert.equal(typeof view.notes[0].summary, 'string')
})

await check('a notebook with no buffer says nothing about notes', async () => {
  const view = await notebooks.view(SESSION)
  assert.equal('pendingNotes' in view, false)
  assert.equal(notebooks.pendingNotes(SESSION), 0)
})

await check('discarding notes empties the queue without touching the notebook', async () => {
  const before = await watched.view(WATCHED)
  assert.ok(before.pendingNotes > 0)
  const after = await watched.command(WATCHED, { action: 'discardNotes' })
  assert.equal(after.revision, before.revision, 'a discard changes no cell')
  assert.equal('pendingNotes' in after, false)
  assert.equal(watched.pendingNotes(WATCHED), 0)
})

console.log('\nrun all')

// Its own instance and a gated kernel: a sequence is about ordering and about stopping, and both
// are only observable while something is still running.
const sequence = []
let gateOpen = () => {}
let gate = Promise.resolve()
const sequenced = new Notebooks({
  directory,
  execute: async (sessionId, code) => {
    sequence.push(code)
    await gate
    return { status: 'ok', executionCount: sequence.length, durationMs: 1, outputs: [{ kind: 'stream', name: 'stdout', text: `${code}\n` }] }
  },
  kernelInfo: fake.runtime.kernelInfo,
})
const RUNALL = 'run-all-session'
/** Resolve when the sequence announces that it stopped. */
function whenSettled(instance, sessionId) {
  return new Promise((resolve) => {
    const unsubscribe = instance.subscribe(sessionId, (event) => {
      if (event.type === 'runall' && event.running === false) {
        unsubscribe()
        resolve()
      }
    })
  })
}

await check('run all executes code cells in order and leaves prose and blanks alone', async () => {
  const first = (await sequenced.view(RUNALL)).cells[0]
  await sequenced.command(RUNALL, { action: 'updateCell', id: first.id, source: 'x = 1' })
  const withMarkdown = await sequenced.command(RUNALL, { action: 'addCell', kind: 'markdown', source: '# Notes' })
  const markdownId = withMarkdown.cells[1].id
  const blank = await sequenced.command(RUNALL, { action: 'addCell' })
  const blankId = blank.cells[2].id
  const last = await sequenced.command(RUNALL, { action: 'addCell', source: 'print(x)' })
  sequence.length = 0
  assert.equal(await sequenced.runAll(RUNALL), true)
  assert.deepEqual(sequence, ['x = 1', 'print(x)'])
  const view = await sequenced.view(RUNALL)
  assert.equal(view.cells[0].status, 'ok')
  assert.equal(view.cells[1].status, 'idle', 'markdown is prose, not an execution')
  assert.equal(view.cells[1].id, markdownId)
  assert.equal(view.cells[2].status, 'idle', 'an empty cell is a blank line')
  assert.equal(view.cells[2].id, blankId)
  assert.equal(view.cells[3].status, 'ok')
  assert.equal(view.cells[3].id, last.cells[3].id)
})

await check('a sequence announces itself while it runs, and only one can run', async () => {
  const session = 'run-all-flag'
  const seen = []
  const unsubscribe = sequenced.subscribe(session, (event) => { if (event.type === 'runall') seen.push(event.running) })
  gate = new Promise((resolve) => { gateOpen = resolve })
  const cell = (await sequenced.view(session)).cells[0]
  await sequenced.command(session, { action: 'updateCell', id: cell.id, source: 'slow()' })
  const run = sequenced.runAll(session)
  // Let the first cell reach the kernel, then look at the flag.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sequenced.isRunningAll(session), true)
  assert.equal(sequenced.isRunning(session), true, 'a cell is executing, not just the sequence')
  assert.equal(await sequenced.runAll(session), false, 'a second sequence is refused, not queued')
  gateOpen()
  await run
  assert.equal(sequenced.isRunningAll(session), false)
  assert.deepEqual(seen, [true, false])
  unsubscribe()
})

await check('stopping a sequence lets the running cell finish and starts no other', async () => {
  const session = 'run-all-stop'
  const cell = (await sequenced.view(session)).cells[0]
  await sequenced.command(session, { action: 'updateCell', id: cell.id, source: 'one()' })
  await sequenced.command(session, { action: 'addCell', source: 'two()' })
  await sequenced.command(session, { action: 'addCell', source: 'three()' })
  sequence.length = 0
  gate = new Promise((resolve) => { gateOpen = resolve })
  const settled = whenSettled(sequenced, session)
  const view = await sequenced.command(session, { action: 'runAll' })
  assert.equal(view.runningAll, true, 'the command answers at once, with the stop button armed')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sequenced.stopRunAll(session), true)
  gateOpen()
  await settled
  assert.deepEqual(sequence, ['one()'], 'the current cell finishes, the next one never starts')
  assert.equal(sequenced.stopRunAll(session), false, 'nothing left to stop')
})

await check('an interrupt during a sequence stops the next cell too', async () => {
  const session = 'run-all-interrupt'
  const cell = (await sequenced.view(session)).cells[0]
  await sequenced.command(session, { action: 'updateCell', id: cell.id, source: 'alpha()' })
  await sequenced.command(session, { action: 'addCell', source: 'beta()' })
  sequence.length = 0
  gate = new Promise((resolve) => { gateOpen = resolve })
  const settled = whenSettled(sequenced, session)
  sequenced.command(session, { action: 'runAll' })
  await new Promise((resolve) => setImmediate(resolve))
  await sequenced.command(session, { action: 'interrupt' })
  gateOpen()
  await settled
  assert.deepEqual(sequence, ['alpha()'], 'interrupt is a decision about the whole sequence')
})

console.log('\n.ipynb')

await check('export produces an nbformat 4 document with every cell', async () => {
  const session = 'export-session'
  const cell = (await notebooks.view(session)).cells[0]
  await notebooks.command(session, { action: 'updateCell', id: cell.id, source: 'df.head()' })
  await notebooks.command(session, { action: 'runCell', id: cell.id, source: 'frame' })
  await notebooks.idle(session)
  const ran = (await notebooks.view(session)).cells[0]
  await notebooks.command(session, { action: 'addCell', kind: 'markdown', source: '## Results' })
  const document = await notebooks.exportDocument(session)
  assert.equal(document.nbformat, 4)
  assert.equal(document.nbformat_minor, 5)
  assert.equal(document.metadata.language_info.name, 'python3', 'the bound kernel names the language')
  assert.equal(document.cells.length, 2)
  assert.equal(document.cells[0].cell_type, 'code')
  assert.equal(document.cells[0].execution_count, ran.executionCount, 'the count the user saw survives')
  assert.ok(document.cells[0].outputs.some((output) => output.data?.['text/html'] !== undefined))
  assert.deepEqual(document.cells[1], { cell_type: 'markdown', id: document.cells[1].id, metadata: {}, source: ['## Results'] })
})

await check('import replaces the notebook, and says what it could not keep', async () => {
  const session = 'import-session'
  const document = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { cell_type: 'code', source: 'a = 1', execution_count: 4, outputs: [{ output_type: 'stream', name: 'stdout', text: 'hi\n' }] },
      { cell_type: 'raw', source: 'raw' },
    ],
  }
  const view = await notebooks.command(session, { action: 'importNotebook', document })
  assert.equal(view.cells.length, 2)
  assert.equal(view.cells[0].source, 'a = 1')
  assert.equal(view.cells[0].executionCount, 4)
  assert.equal(view.cells[0].status, 'ok', 'imported output means the cell has run')
  assert.equal(view.cells[1].kind, 'markdown')
  assert.match(view.message, /raw cell/)
})

await check('import can append instead of replacing', async () => {
  const session = 'import-append'
  const document = { nbformat: 4, cells: [{ cell_type: 'code', source: 'b = 2', outputs: [] }] }
  await notebooks.command(session, { action: 'importNotebook', document })
  const view = await notebooks.command(session, { action: 'importNotebook', document, mode: 'append' })
  assert.deepEqual(view.cells.map((cell) => cell.source), ['b = 2', 'b = 2'])
})

await check('a bad document fails the command instead of emptying the notebook', async () => {
  const session = 'import-bad'
  const before = await notebooks.view(session)
  await notebooks.command(session, { action: 'updateCell', id: before.cells[0].id, source: 'keep me' })
  await assert.rejects(
    () => notebooks.command(session, { action: 'importNotebook', document: { nbformat: 3 } }),
    /nbformat 3 is not supported/,
  )
  const after = await notebooks.view(session)
  assert.equal(after.cells[0].source, 'keep me', 'a refused import must not have half-applied')
})

await check('an imported notebook is announced as one replace, and the model is told', async () => {
  const session = 'import-events'
  const streamed = []
  const unsubscribe = watched.subscribe(session, (event) => streamed.push(event.type))
  const document = { nbformat: 4, cells: [{ cell_type: 'code', source: 'c = 3', outputs: [] }, { cell_type: 'markdown', source: 'x' }] }
  await watched.command(session, { action: 'importNotebook', document })
  unsubscribe()
  assert.deepEqual(streamed.filter((type) => type === 'replace').length, 1, 'one frame, not one per cell')
  const note = lastEvent()
  assert.equal(note.event.type, 'import')
  assert.equal(note.event.mode, 'replace')
  assert.equal(note.event.count, 2)
})

await check('an exported notebook imports back with its sources and outputs', async () => {
  const from = 'round-trip-from'
  const cell = (await notebooks.view(from)).cells[0]
  await notebooks.command(from, { action: 'updateCell', id: cell.id, source: 'round_trip = True' })
  await notebooks.command(from, { action: 'addCell', kind: 'markdown', source: 'prose *here*' })
  const document = await notebooks.exportDocument(from)
  const to = 'round-trip-to'
  const view = await notebooks.command(to, { action: 'importNotebook', document })
  assert.deepEqual(view.cells.map((entry) => [entry.kind, entry.source]), [['code', 'round_trip = True'], ['markdown', 'prose *here*']])
})

console.log('\nseveral notebooks in one session')

/** A model of its own, so a desk under test is not shared with the checks above. */
function desk(session) {
  const model = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: fake.runtime.kernelInfo })
  return { model, session }
}

await check('a new notebook is empty, on screen, and named rather than numbered twice', async () => {
  const { model, session } = desk('desk-new')
  try {
    const first = await model.view(session)
    assert.equal(first.notebook, 'main')
    assert.deepEqual(first.notebooks, ['main'])
    await model.command(session, { action: 'updateCell', id: first.cells[0].id, source: 'main_only = True' })
    const second = await model.command(session, { action: 'newNotebook' })
    assert.equal(second.notebook, 'Untitled', 'the panel asks for a notebook, not for a name')
    assert.deepEqual(second.notebooks, ['main', 'Untitled'])
    assert.equal(second.cells.length, 1)
    assert.equal(second.cells[0].source, '', 'a new page starts empty')
    const third = await model.command(session, { action: 'newNotebook' })
    assert.equal(third.notebook, 'Untitled 2', 'the same default name twice would be unfindable')
  } finally {
    model.dispose()
  }
})

await check('switching back finds the page exactly as it was left', async () => {
  const { model, session } = desk('desk-switch')
  try {
    const main = await model.view(session)
    await model.command(session, { action: 'updateCell', id: main.cells[0].id, source: 'kept = 1' })
    await model.command(session, { action: 'newNotebook' })
    const back = await model.command(session, { action: 'switchNotebook', notebook: 'main' })
    assert.equal(back.notebook, 'main')
    assert.equal(back.cells[0].source, 'kept = 1')
    assert.deepEqual(back.notebooks, ['main', 'Untitled'], 'the list is every page, not only the open one')
    assert.equal(back.cells.some((cell) => cell.source === ''), false)
  } finally {
    model.dispose()
  }
})

await check('a switch leaves the sequence behind instead of running it unseen', async () => {
  let open
  const gate = new Promise((resolve) => { open = resolve })
  const slow = new Notebooks({ directory, execute: () => gate, kernelInfo: async () => undefined })
  try {
    const session = 'desk-runall-switch'
    const main = await slow.view(session)
    await slow.command(session, { action: 'updateCell', id: main.cells[0].id, source: 'slow()' })
    await slow.command(session, { action: 'newNotebook' })
    await slow.command(session, { action: 'switchNotebook', notebook: 'main' })
    const run = slow.runAll(session)
    // Let the first cell reach the kernel, then leave the page it is running on.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(slow.isRunningAll(session), true)
    const other = await slow.command(session, { action: 'switchNotebook', notebook: 'Untitled' })
    assert.equal(other.notebook, 'Untitled')
    assert.equal(other.runningAll, false, 'the stop button belonged to the page that was left')
    assert.equal(slow.isRunningAll(session), false, 'a second page must not inherit a sequence')
    open({ status: 'ok', executionCount: 1, durationMs: 1, outputs: [] })
    assert.equal(await run, true)
  } finally {
    slow.dispose()
  }
})

await check('a name that is not in the desk is refused instead of starting a stray page', async () => {
  const { model, session } = desk('desk-unknown')
  try {
    await model.view(session)
    await assert.rejects(() => model.command(session, { action: 'switchNotebook', notebook: 'notes' }), /no notebook named "notes"/)
    await assert.rejects(() => model.command(session, { action: 'switchNotebook', notebook: '   ' }), /needs a notebook name/)
  } finally {
    model.dispose()
  }
})

await check('the desk stops at the cap instead of growing without bound', async () => {
  const { model, session } = desk('desk-cap')
  try {
    await model.view(session)
    for (let index = 0; index < 11; index += 1) await model.command(session, { action: 'newNotebook' })
    const full = await model.view(session)
    assert.equal(full.notebooks.length, 12)
    await assert.rejects(() => model.command(session, { action: 'newNotebook' }), /already holds 12 notebooks/)
    // The refusal leaves the desk alone: the cap is a limit, not a state to recover from.
    assert.equal((await model.view(session)).notebooks.length, 12)
  } finally {
    model.dispose()
  }
})

await check('a mirror written before several notebooks existed opens as main', async () => {
  const session = 'desk-legacy-mirror'
  const cells = [{ id: 'old-1', kind: 'code', source: 'legacy = True', origin: 'user', outputs: [], status: 'idle', executionCount: 3, durationMs: 5, error: null, rev: 2 }]
  writeFileSync(path.join(directory, `${session}.json`), JSON.stringify({ cells, path: 'old.ipynb', revision: 9 }))
  const model = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: async () => undefined })
  try {
    const view = await model.view(session)
    assert.equal(view.notebook, 'main')
    assert.deepEqual(view.notebooks, ['main'])
    assert.equal(view.cells[0].source, 'legacy = True', 'the old page becomes the first notebook')
    assert.equal(view.path, 'old.ipynb')
  } finally {
    model.dispose()
  }
})

await check('every notebook is in the mirror, and the active one is the page on screen', async () => {
  const { model, session } = desk('desk-mirror')
  try {
    const main = await model.view(session)
    await model.command(session, { action: 'updateCell', id: main.cells[0].id, source: 'in_main = 1' })
    await model.command(session, { action: 'newNotebook' })
    await model.command(session, { action: 'addCell', source: 'in_second = 2' })
    const raw = JSON.parse(readFileSync(path.join(directory, `${session}.json`), 'utf8'))
    assert.equal(raw.active, 'Untitled')
    assert.deepEqual(Object.keys(raw.notebooks), ['main', 'Untitled'])
    assert.equal(raw.notebooks.main.cells[0].source, 'in_main = 1')
    assert.equal(raw.notebooks.Untitled.cells[1].source, 'in_second = 2')
    // A fresh model reads both pages back, including the one that is not on screen.
    const reopened = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: async () => undefined })
    try {
      const view = await reopened.view(session)
      assert.equal(view.notebook, 'Untitled')
      assert.equal(view.cells[1].source, 'in_second = 2')
      const back = await reopened.command(session, { action: 'switchNotebook', notebook: 'main' })
      assert.equal(back.cells[0].source, 'in_main = 1')
    } finally {
      reopened.dispose()
    }
  } finally {
    model.dispose()
  }
})

await check('the model names the notebook it is looking at', async () => {
  const { model, session } = desk('desk-outline')
  try {
    await model.view(session)
    await model.command(session, { action: 'newNotebook' })
    const outline = model.outline(session)
    assert.match(outline, /The notebook "Untitled"/)
    const snapshot = model.snapshot(session)
    assert.equal(snapshot.notebook, 'Untitled')
  } finally {
    model.dispose()
  }
})

console.log('\nseveral servers in one session')

/** The identity rule from the contract: a server key is the normalised base URL. */
function fakeKey(url) {
  let value = String(url ?? '').trim()
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  return value.replace(/\/(?:lab|tree|notebooks)(?:\/.*)?$/i, '').replace(/\/+$/, '')
}

/**
 * In-memory stand-in for the host's connection registry, with the same seam the plugin wires: a
 * synchronous describe, an async add-and-probe, an async forget.
 *
 * The entries deliberately keep `token` / `password` on them, so a credential that leaked into a
 * view, an event or a note would be caught here rather than assumed away.
 */
function fakeConnections(initial = []) {
  const servers = []
  const probes = []
  const state = { failProbe: false, default: undefined }
  const entryFor = (patch) => {
    const key = fakeKey(patch.url)
    const authMode = typeof patch.token === 'string' && patch.token.length > 0
      ? 'token'
      : typeof patch.password === 'string' && patch.password.length > 0
        ? 'password'
        : (typeof patch.cookie === 'string' && patch.cookie.length > 0 ? 'cookie' : 'none')
    return {
      key,
      url: key,
      name: patch.name,
      label: key.replace(/^https?:\/\//, ''),
      authMode,
      hasCredentials: authMode !== 'none',
      token: patch.token,
      password: patch.password,
      // Deliberately kept here to prove the view projection drops it.
      cookie: patch.cookie,
    }
  }
  for (const patch of initial) servers.push(entryFor(patch))
  // The first loaded connection is the default, the way the host's registry treats `config.url`.
  state.default = servers[0]?.key
  const defaultKey = () => state.default ?? servers[0]?.key
  return {
    state,
    probes,
    servers: () => ({
      configured: servers.length > 0,
      default: defaultKey(),
      servers: servers.map(({ key, url, name, label, authMode, hasCredentials }) => ({
        key,
        url,
        ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
        label,
        authMode,
        hasCredentials,
        default: key === defaultKey(),
      })),
    }),
    connectServer: async (patch) => {
      if (state.failProbe) throw new Error('jupyter authentication failed (401): the token was rejected')
      probes.push(patch)
      const fresh = entryFor(patch)
      const existing = servers.findIndex((server) => server.key === fresh.key)
      if (existing === -1) servers.push(fresh)
      else servers[existing] = fresh
      if (state.default === undefined) state.default = fresh.key
      return { key: fresh.key, url: fresh.url, authMode: fresh.authMode, version: '2.14.0', kernelspecs: ['python3', 'ir'] }
    },
    forgetServer: async (server) => {
      const key = fakeKey(server)
      const index = servers.findIndex((item) => item.key === key)
      if (index === -1) return { key, url: key, removed: false }
      const [removed] = servers.splice(index, 1)
      if (state.default === removed.key) state.default = servers[0]?.key
      return { key: removed.key, url: removed.url, removed: true }
    },
  }
}

/** A model wired to a fake registry and to {@link fakeRuntime}. */
function connectedModel(connections, overrides = {}) {
  return new Notebooks({
    directory,
    execute: fake.runtime.execute,
    kernelInfo: fake.runtime.kernelInfo,
    servers: connections.servers,
    connectServer: connections.connectServer,
    forgetServer: connections.forgetServer,
    ...overrides,
  })
}

/** A note recorder: this file tests which events the model reports, not how they are worded. */
function noteRecorder() {
  const notes = []
  return {
    notes,
    activity: {
      record: (sessionId, event) => notes.push({ sessionId, event }),
      pending: (sessionId) => notes.filter((entry) => entry.sessionId === sessionId).length,
      list: () => [],
      forget: () => {},
    },
  }
}

const LOCAL = { url: 'http://local.test:9003', token: 'local-secret' }
const REMOTE = { url: 'http://remote.test:9002', password: 'remote-secret' }

await check('the view names the page server, the default and every connection', async () => {
  const connections = fakeConnections([LOCAL, REMOTE])
  const model = connectedModel(connections)
  try {
    const view = await model.view('multi-fields')
    assert.equal(view.server, 'http://local.test:9003', 'a fresh page follows the default connection')
    assert.equal(view.serverUrl, 'http://local.test:9003')
    assert.equal(view.serverConnected, true)
    assert.equal(view.defaultServer, 'http://local.test:9003')
    assert.equal(view.configured, true)
    assert.deepEqual(view.servers.map((entry) => entry.key), ['http://local.test:9003', 'http://remote.test:9002'])
    const remote = view.servers[1]
    assert.equal(remote.label, 'remote.test:9002', 'the label drops the scheme')
    assert.equal(remote.authMode, 'password')
    assert.equal(remote.hasCredentials, true)
    assert.equal(remote.default, false)
    // The registry entry carries the credentials; the view is the browser's.
    assert.equal(JSON.stringify(view).includes('local-secret'), false)
    assert.equal(JSON.stringify(view).includes('remote-secret'), false)
  } finally {
    model.dispose()
  }
})

await check('without any connection the page still renders and names no server', async () => {
  const model = new Notebooks({ directory, execute: fake.runtime.execute, kernelInfo: async () => undefined })
  try {
    const view = await model.view('multi-none')
    assert.equal(view.server, null)
    assert.equal(view.serverUrl, null)
    assert.equal(view.serverConnected, false)
    assert.equal(view.defaultServer, null)
    assert.equal(view.configured, false)
    assert.deepEqual(view.servers, [])
    assert.ok(view.cells.length > 0, 'not being connected is not a reason to hide the notebook')
    assert.equal(model.snapshot('multi-none').server, null)
    assert.equal(model.activeServer('multi-none'), undefined)
    assert.doesNotMatch(model.outline('multi-none'), /running on/)
  } finally {
    model.dispose()
  }
})

await check('each page runs its code on the server it is bound to', async () => {
  const connections = fakeConnections([LOCAL, REMOTE])
  const model = connectedModel(connections)
  const session = 'multi-run'
  try {
    const main = await model.view(session)
    await model.command(session, { action: 'updateCell', id: main.cells[0].id, source: 'a = 1' })
    await model.command(session, { action: 'runCell', id: main.cells[0].id })
    await model.idle(session)
    const second = await model.command(session, { action: 'newNotebook', server: REMOTE.url })
    assert.equal(second.server, 'http://remote.test:9002', 'a page opened on a server is bound to it')
    await model.command(session, { action: 'updateCell', id: second.cells[0].id, source: 'b = 2' })
    await model.command(session, { action: 'runCell', id: second.cells[0].id })
    await model.idle(session)
    const runs = fake.runs.filter((run) => run.sessionId === session)
    assert.deepEqual(
      runs.map((run) => run.server),
      ['http://local.test:9003', 'http://remote.test:9002'],
      'code must run on the page\'s server, not on whatever the default is',
    )
    // The header's kernel status is asked from the same server, or it would describe another host.
    const asked = fake.kernelQueries.filter((query) => query.sessionId === session).map((query) => query.server)
    assert.ok(asked.includes('http://local.test:9003'))
    assert.ok(asked.includes('http://remote.test:9002'))
    // Switching back leaves the first page on its own server.
    const back = await model.command(session, { action: 'switchNotebook', notebook: 'main' })
    assert.equal(back.server, 'http://local.test:9003')
  } finally {
    model.dispose()
  }
})

await check('a new page accepts a server, and an unknown one is refused without opening a page', async () => {
  const connections = fakeConnections([LOCAL, REMOTE])
  const model = connectedModel(connections)
  const session = 'multi-new'
  try {
    await model.view(session)
    // A URL spelling (`/lab`, the address the user typed) resolves to the connection's key.
    const bound = await model.command(session, { action: 'newNotebook', server: 'http://remote.test:9002/lab' })
    assert.equal(bound.server, 'http://remote.test:9002')
    assert.equal(bound.serverConnected, true)
    const pages = bound.notebooks.length
    await assert.rejects(
      () => model.command(session, { action: 'newNotebook', server: 'http://typo.test:9009' }),
      /not a connected Jupyter server/,
    )
    const after = await model.view(session)
    assert.equal(after.notebooks.length, pages, 'a refused server must not leave a stray page')
    assert.equal(after.notebook, bound.notebook)
    // A page opened without a server inherits the page it was opened from.
    const inherited = await model.command(session, { action: 'newNotebook' })
    assert.equal(inherited.server, 'http://remote.test:9002')
  } finally {
    model.dispose()
  }
})

await check('binding a page announces it, notes the URL and never leaks a credential', async () => {
  const connections = fakeConnections([LOCAL, REMOTE])
  const recorder = noteRecorder()
  const model = connectedModel(connections, { activity: recorder.activity })
  const session = 'multi-bind'
  const events = []
  try {
    await model.view(session)
    model.subscribe(session, (event) => events.push(event))
    const view = await model.command(session, { action: 'bindServer', server: REMOTE.url })
    assert.equal(view.server, 'http://remote.test:9002')
    assert.equal(view.serverUrl, 'http://remote.test:9002')
    assert.equal(view.serverConnected, true)
    assert.match(view.message, /this notebook now runs on http:\/\/remote\.test:9002/)
    const changed = events.filter((event) => event.type === 'notebook')
    assert.equal(changed.length, 1, 'the client re-reads the whole view when the connection changes')
    assert.equal(changed[0].notebook, 'main')
    assert.equal(changed[0].server, 'http://remote.test:9002')
    const note = recorder.notes.at(-1).event
    assert.equal(note.type, 'bindServer')
    assert.equal(note.url, 'http://remote.test:9002')
    assert.equal(JSON.stringify({ view, events, notes: recorder.notes }).includes('remote-secret'), false)
    // A key that is not connected is refused and leaves the binding alone.
    await assert.rejects(
      () => model.command(session, { action: 'bindServer', server: 'http://typo.test:9009' }),
      /not a connected Jupyter server/,
    )
    assert.equal((await model.view(session)).server, 'http://remote.test:9002')
    await assert.rejects(() => model.command(session, { action: 'bindServer' }), /binding needs a server/)
  } finally {
    model.dispose()
  }
})

await check('binding while a sequence runs stops it instead of reporting into another host', async () => {
  const connections = fakeConnections([LOCAL, REMOTE])
  const sequence = []
  let open = () => {}
  let gate = Promise.resolve()
  const model = new Notebooks({
    directory,
    execute: async (_sessionId, code) => {
      sequence.push(code)
      await gate
      return { status: 'ok', executionCount: sequence.length, durationMs: 1, outputs: [] }
    },
    kernelInfo: async () => undefined,
    servers: connections.servers,
    connectServer: connections.connectServer,
    forgetServer: connections.forgetServer,
  })
  const session = 'multi-bind-stop'
  try {
    const first = await model.view(session)
    await model.command(session, { action: 'updateCell', id: first.cells[0].id, source: 'one()' })
    await model.command(session, { action: 'addCell', source: 'two()' })
    sequence.length = 0
    gate = new Promise((resolve) => { open = resolve })
    const settled = whenSettled(model, session)
    const running = model.runAll(session)
    await new Promise((resolve) => setImmediate(resolve))
    const bound = await model.command(session, { action: 'bindServer', server: REMOTE.url })
    assert.equal(bound.server, 'http://remote.test:9002')
    open()
    await settled
    assert.deepEqual(sequence, ['one()'], 'the next cell must not start on the new server')
    assert.equal(model.isRunningAll(session), false, 'the stop button is gone once the running cell settles')
    assert.equal(await running, true)
  } finally {
    model.dispose()
  }
})

await check('connectServer adds and probes a connection, and no secret reaches the panel', async () => {
  const connections = fakeConnections([LOCAL])
  const recorder = noteRecorder()
  const model = connectedModel(connections, { activity: recorder.activity })
  const session = 'multi-connect'
  const events = []
  try {
    await model.view(session)
    model.subscribe(session, (event) => events.push(event))
    const view = await model.command(session, {
      action: 'connectServer',
      url: 'http://new.test:9005/lab',
      token: 'new-secret',
    })
    assert.deepEqual(connections.probes.map((patch) => patch.url), ['http://new.test:9005/lab'])
    assert.equal(connections.probes[0].token, 'new-secret', 'the host is the only one that gets the token')
    assert.deepEqual(view.servers.map((entry) => entry.key), ['http://local.test:9003', 'http://new.test:9005'])
    assert.equal(view.server, 'http://local.test:9003', 'adding a connection does not move the default page')
    assert.match(view.message, /connected to http:\/\/new\.test:9005 \(token auth\); 2 kernelspec\(s\)/)
    assert.equal(events.filter((event) => event.type === 'notebook').length, 1, 'every window re-reads the view')
    const note = recorder.notes.at(-1).event
    assert.equal(note.type, 'connectServer')
    assert.equal(note.url, 'http://new.test:9005')
    assert.equal(note.authMode, 'token')
    assert.equal(JSON.stringify({ view, events, notes: recorder.notes }).includes('new-secret'), false)
    // Password auth: username and kernel name travel too, and the mode is reported as such.
    const password = await model.command(session, {
      action: 'connectServer',
      url: 'http://pw.test:9006',
      password: 'pw-secret',
      username: 'me',
      kernelName: 'ir',
    })
    assert.equal(connections.probes[1].password, 'pw-secret')
    assert.equal(connections.probes[1].username, 'me')
    assert.equal(connections.probes[1].kernelName, 'ir')
    assert.match(password.message, /\(password auth\)/)
    assert.equal(JSON.stringify(password).includes('pw-secret'), false)
    // A deployment behind an SSO/access proxy: the pasted Cookie header is the credential, and it
    // must be handed to the host while never coming back in the view, the events or a note.
    const proxied = await model.command(session, {
      action: 'connectServer',
      url: 'https://sso.test:9007/lab',
      cookie: 'accessproxy_session=abc; _xsrf=xsrf-value',
    })
    assert.equal(connections.probes[2].cookie, 'accessproxy_session=abc; _xsrf=xsrf-value')
    assert.match(proxied.message, /\(cookie auth\)/)
    assert.ok(proxied.servers.some((entry) => entry.key === 'https://sso.test:9007' && entry.authMode === 'cookie'),
      'the connection list must show the proxy-cookie connection')
    const proxiedJson = JSON.stringify({ view: proxied, events, notes: recorder.notes })
    assert.equal(proxiedJson.includes('accessproxy_session'), false, 'a proxy cookie reached the panel')
    assert.equal(proxiedJson.includes('xsrf-value'), false, 'an XSRF value reached the panel')
    await assert.rejects(() => model.command(session, { action: 'connectServer' }), /needs a server url/)
  } finally {
    model.dispose()
  }
})

await check('a connection name reaches the view, the note and the event, and is not a credential', async () => {
  const connections = fakeConnections([LOCAL])
  const recorder = noteRecorder()
  const model = connectedModel(connections, { activity: recorder.activity })
  const session = 'named-connection'
  try {
    await model.view(session)
    const view = await model.command(session, {
      action: 'connectServer',
      url: 'http://named.test:9008/lab',
      password: 'named-secret',
      name: 'GPU box',
    })
    assert.equal(connections.probes.at(-1).name, 'GPU box')
    const entry = view.servers.find((server) => server.key === 'http://named.test:9008')
    assert.equal(entry.name, 'GPU box', 'the picker needs the name in the describe list')
    assert.equal(recorder.notes.at(-1).event.name, 'GPU box')
    // Binding and forgetting name the same connection, so the model does not have to map a URL.
    await model.command(session, { action: 'bindServer', server: 'http://named.test:9008' })
    assert.equal(recorder.notes.at(-1).event.name, 'GPU box')
    await model.command(session, { action: 'forgetServer', server: 'http://named.test:9008' })
    assert.equal(recorder.notes.at(-1).event.name, 'GPU box')
    // A name is a label; the password still never leaves the host.
    assert.equal(JSON.stringify({ view, notes: recorder.notes }).includes('named-secret'), false)
  } finally {
    model.dispose()
  }
})

await check('a connection that fails its probe is reported and changes nothing', async () => {
  const connections = fakeConnections([LOCAL])
  const recorder = noteRecorder()
  const model = connectedModel(connections, { activity: recorder.activity })
  const session = 'multi-connect-fail'
  const events = []
  try {
    await model.view(session)
    model.subscribe(session, (event) => events.push(event))
    connections.state.failProbe = true
    await assert.rejects(
      () => model.command(session, { action: 'connectServer', url: 'http://typo.test:9009', token: 'nope' }),
      /authentication failed/,
    )
    assert.deepEqual((await model.view(session)).servers.map((entry) => entry.key), ['http://local.test:9003'])
    assert.equal(events.length, 0, 'a failed add is not a notebook change')
    assert.equal(recorder.notes.length, 0, 'a failed add is not something the user did to the notebook')
    assert.equal(JSON.stringify(recorder.notes).includes('nope'), false)
  } finally {
    model.dispose()
  }
})

await check('forgetting a connection leaves its page visible, marked not connected, and a run fails readably', async () => {
  const connections = fakeConnections([LOCAL, REMOTE])
  const recorder = noteRecorder()
  const model = new Notebooks({
    directory,
    // A stand-in for the runtime: executing on a connection that is gone fails the way the host does.
    execute: async (_sessionId, code, options) => {
      const known = connections.servers().servers.some((entry) => entry.key === options?.server)
      if (options?.server !== undefined && !known) {
        throw new Error(`jupyter server ${options.server} is not configured; add it in the panel or with jupyter_connect`)
      }
      return { status: 'ok', executionCount: 1, durationMs: 1, outputs: [{ kind: 'stream', name: 'stdout', text: `${code}\n` }] }
    },
    kernelInfo: async () => undefined,
    servers: connections.servers,
    connectServer: connections.connectServer,
    forgetServer: connections.forgetServer,
    activity: recorder.activity,
  })
  const session = 'multi-forget'
  const events = []
  try {
    await model.view(session)
    await model.command(session, { action: 'bindServer', server: REMOTE.url })
    model.subscribe(session, (event) => events.push(event))
    const view = await model.command(session, { action: 'forgetServer', server: REMOTE.url })
    assert.equal(view.server, 'http://remote.test:9002', 'the page keeps the key it was bound to')
    assert.equal(view.serverUrl, 'http://remote.test:9002')
    assert.equal(view.serverConnected, false, 'the page still renders, marked not connected')
    assert.deepEqual(view.servers.map((entry) => entry.key), ['http://local.test:9003'])
    assert.equal(view.defaultServer, 'http://local.test:9003', 'the default moves to a connection that exists')
    assert.match(view.message, /disconnected from http:\/\/remote\.test:9002/)
    assert.ok(view.cells.length >= 1)
    assert.equal(events.filter((event) => event.type === 'notebook').length, 1)
    const note = recorder.notes.at(-1).event
    assert.equal(note.type, 'forgetServer')
    assert.equal(note.url, 'http://remote.test:9002')
    assert.equal(JSON.stringify({ view, events, notes: recorder.notes }).includes('remote-secret'), false)
    // A run on the forgotten server is a readable error on the cell, never a silent fallback.
    await model.command(session, { action: 'runCell', id: view.cells[0].id, source: 'print(1)' })
    await model.idle(session)
    const ran = (await model.view(session)).cells[0]
    assert.equal(ran.status, 'error')
    assert.match(ran.error, /is not configured/)
    // The model-facing summaries keep naming the host the page belongs to.
    assert.equal(model.snapshot(session).server, 'http://remote.test:9002')
    assert.match(model.outline(session), /bound to http:\/\/remote\.test:9002 \(not connected\)/)
  } finally {
    model.dispose()
  }
})

await check('snapshot and outline name the server the page runs on', async () => {
  const connections = fakeConnections([LOCAL, REMOTE])
  const model = connectedModel(connections)
  const session = 'multi-naming'
  try {
    const first = await model.view(session)
    await model.command(session, { action: 'bindServer', server: REMOTE.url })
    await model.command(session, { action: 'updateCell', id: first.cells[0].id, source: 'import pandas as pd' })
    const snapshot = model.snapshot(session)
    assert.equal(snapshot.server, 'http://remote.test:9002')
    assert.equal(snapshot.notebook, 'main')
    const outline = model.outline(session)
    assert.match(outline, /running on http:\/\/remote\.test:9002/)
    assert.match(outline, /import pandas as pd/)
  } finally {
    model.dispose()
  }
})

await check('activeServer names the page connection without opening a desk', async () => {
  const connections = fakeConnections([LOCAL, REMOTE])
  const model = connectedModel(connections)
  const session = 'multi-active'
  try {
    assert.equal(model.activeServer('never-opened'), undefined)
    assert.equal(model.size, 0, 'a peek must not create a session')
    await model.view(session)
    assert.deepEqual(model.activeServer(session), {
      key: 'http://local.test:9003',
      url: 'http://local.test:9003',
      connected: true,
    })
    await model.command(session, { action: 'bindServer', server: REMOTE.url })
    assert.equal(model.activeServer(session).key, 'http://remote.test:9002')
    await model.command(session, { action: 'forgetServer', server: REMOTE.url })
    assert.deepEqual(model.activeServer(session), {
      key: 'http://remote.test:9002',
      url: 'http://remote.test:9002',
      connected: false,
    })
  } finally {
    model.dispose()
  }
})

await check('switching or opening a page reports the server when it changes', async () => {
  const connections = fakeConnections([LOCAL, REMOTE])
  const recorder = noteRecorder()
  const model = connectedModel(connections, { activity: recorder.activity })
  const session = 'multi-page-notes'
  try {
    await model.view(session)
    await model.command(session, { action: 'bindServer', server: REMOTE.url })
    await model.command(session, { action: 'newNotebook' })
    let note = recorder.notes.at(-1).event
    assert.equal(note.type, 'newNotebook')
    assert.equal(note.server, 'http://remote.test:9002', 'a new page inherits the bound server')
    assert.equal(note.previousServer, 'http://remote.test:9002')
    await model.command(session, { action: 'bindServer', server: LOCAL.url })
    await model.command(session, { action: 'switchNotebook', notebook: 'main' })
    note = recorder.notes.at(-1).event
    assert.equal(note.type, 'switchNotebook')
    assert.equal(note.server, 'http://remote.test:9002', 'the note carries the target page\'s server URL')
    assert.equal(note.previousServer, 'http://local.test:9003', 'and the page it came from, so the change is visible')
    assert.equal(JSON.stringify(recorder.notes).includes('remote-secret'), false)
  } finally {
    model.dispose()
  }
})

await check('a page binding survives the mirror, and a mirror without one follows the default', async () => {
  const connections = fakeConnections([LOCAL, REMOTE])
  const session = 'multi-mirror'
  const model = connectedModel(connections)
  try {
    const view = await model.view(session)
    await model.command(session, { action: 'updateCell', id: view.cells[0].id, source: 'kept = 1' })
    let raw = JSON.parse(readFileSync(path.join(directory, `${session}.json`), 'utf8'))
    assert.equal(raw.notebooks.main.server, null, 'a page that follows the default stores null')
    await model.command(session, { action: 'bindServer', server: REMOTE.url })
  } finally {
    model.dispose()
  }
  const raw = JSON.parse(readFileSync(path.join(directory, `${session}.json`), 'utf8'))
  assert.equal(raw.notebooks.main.server, 'http://remote.test:9002')
  const reopened = connectedModel(connections)
  try {
    const view = await reopened.view(session)
    assert.equal(view.server, 'http://remote.test:9002', 'the binding must not be lost on reload')
    assert.equal(view.serverConnected, true)
  } finally {
    reopened.dispose()
  }
  // A mirror written before servers were bindable has no `server`: the page follows the default.
  const legacy = 'multi-legacy-binding'
  writeFileSync(path.join(directory, `${legacy}.json`), JSON.stringify({
    cells: [{ id: 'legacy-1', kind: 'code', source: 'legacy = True', origin: 'user', outputs: [], status: 'idle', executionCount: null, durationMs: null, error: null, rev: 1 }],
    path: null,
    revision: 3,
  }))
  const fromLegacy = connectedModel(connections)
  try {
    const view = await fromLegacy.view(legacy)
    assert.equal(view.server, 'http://local.test:9003', 'a mirror with no binding follows the default')
    assert.equal(view.serverUrl, 'http://local.test:9003')
    assert.equal(view.cells[0].source, 'legacy = True')
  } finally {
    fromLegacy.dispose()
  }
})

console.log('\nhttp route')

const registered = []
/** A Connection service that records the routes registered against it. */
const fakeConnection = { fetch: { register: (route) => { registered.push(route); return () => {} } } }
/** A child context shaped like the one `ctx.inject` hands a callback. */
const childContext = (connection) => ({
  connection,
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
})
const states = []

await check('the route registers when Connection arrives later, not only at mount', () => {
  // The real bug this guards: on a cold boot `connection` is gated behind its own inject, so it is
  // absent when a later plugin mounts. A one-shot `ctx.get('connection')` silently registered
  // nothing and the panel answered 404 forever.
  const routes = []
  const seen = []
  let deliver
  const ctx = { inject: (deps, callback) => { deliver = callback } }
  registerNotebookRoutes(ctx, { notebooks, connectionInfo: () => ({ configured: true }), onState: (state) => seen.push(state) })
  assert.equal(routes.length, 0, 'nothing may register before the service exists')
  assert.deepEqual(seen, [], 'a pending registration reports nothing yet')

  deliver(childContext({ fetch: { register: (route) => { routes.push(route); return () => {} } } }))
  assert.equal(routes.length, 4, 'the notebook route, its output stream, the asset route, and the export')
  assert.deepEqual(routes.map((entry) => entry.path).sort(), [ASSET_ROUTE, DOWNLOAD_ROUTE, NOTEBOOK_ROUTE, STREAM_ROUTE].sort())
  assert.deepEqual(seen, ['registered'])
})
await check('a headless profile reports the panel as unavailable instead of throwing', () => {
  const seen = []
  let deliver
  registerNotebookRoutes({ inject: (deps, callback) => { deliver = callback } }, {
    notebooks,
    connectionInfo: () => ({}),
    onState: (state) => seen.push(state),
  })
  deliver(childContext(undefined))
  assert.deepEqual(seen, ['unavailable'])
})

// The main context, with the service already present.
const assets = new AssetStore({ directory: path.join(directory, 'assets-route') })
registerNotebookRoutes(
  { inject: (deps, callback) => { callback(childContext(fakeConnection)) } },
  {
    notebooks,
    assets,
    connectionInfo: () => ({ configured: true, url: 'http://example.test' }),
    onState: (state) => states.push(state),
  },
)
const route = registered.find((entry) => entry.path === NOTEBOOK_ROUTE)
const streamRoute = registered.find((entry) => entry.path === STREAM_ROUTE)
const assetRoute = registered.find((entry) => entry.path === ASSET_ROUTE)
const downloadRoute = registered.find((entry) => entry.path === DOWNLOAD_ROUTE)

await check('the registered route carries the panel protocol', () => {
  assert.equal(registered.length, 4)
  assert.deepEqual([...route.methods].sort(), ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.deepEqual([...streamRoute.methods], ['GET'])
  assert.deepEqual([...assetRoute.methods], ['GET'])
  assert.deepEqual([...downloadRoute.methods], ['GET'])
  // The `/api` carrier streams the body of a route that declares no `requestBody`, and a GET
  // Request with a body throws inside the carrier — the browser gets 400 before the handler runs.
  // That is what broke images and the output stream while commands kept working, so every route
  // must declare a body mode the carrier accepts.
  for (const entry of registered) {
    assert.ok(entry.requestBody === 'buffered' || entry.requestBody === 'streaming',
      `${entry.path} declares no requestBody: the carrier's streaming default answers GET with 400`)
  }
  assert.deepEqual(states, ['registered'])
})

const get = async (query) => await route.fetch(new Request(`http://127.0.0.1:19387${NOTEBOOK_ROUTE}?${query}`, { method: 'GET' }))
const post = async (body) => await route.fetch(new Request(`http://127.0.0.1:19387${NOTEBOOK_ROUTE}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))

await check('GET returns the view with connection info and no-store caching', async () => {
  const response = await get(`sessionId=${SESSION}`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.sessionId, SESSION)
  assert.equal(body.configured, true)
  assert.equal(body.url, 'http://example.test')
  assert.ok(Array.isArray(body.cells))
})
await check('GET without a session id fails cleanly', async () => {
  const body = await (await get('')).json()
  assert.match(body.error, /sessionId is required/)
})
await check('a poll that already has the revision gets the short answer', async () => {
  const view = await (await get(`sessionId=${SESSION}`)).json()
  const body = await (await get(`sessionId=${SESSION}&since=${view.revision}`)).json()
  assert.equal(body.unchanged, true)
  assert.equal(body.revision, view.revision)
  assert.equal(body.pendingNotes, 0, 'the badge must be correctable without a revision bump')
  assert.equal(body.cells, undefined, 'the notebook must not be re-sent')
  assert.equal(body.configured, true, 'connection info still rides along')
})
await check('a stale revision still gets the whole view', async () => {
  const view = await (await get(`sessionId=${SESSION}`)).json()
  const body = await (await get(`sessionId=${SESSION}&since=${view.revision - 1}`)).json()
  assert.equal(body.unchanged, undefined)
  assert.ok(Array.isArray(body.cells))
})
await check('POST applies a command and returns the new view', async () => {
  const before = (await (await get(`sessionId=${SESSION}`)).json()).cells.length
  const body = await (await post({ sessionId: SESSION, action: 'addCell' })).json()
  assert.equal(body.cells.length, before + 1)
})
await check('POST with a bad command reports the error without a 500', async () => {
  const response = await post({ sessionId: SESSION, action: 'not-a-thing' })
  assert.equal(response.status, 200)
  assert.match((await response.json()).error, /unknown notebook action/)
})
await check('POST with a malformed body reports it', async () => {
  const response = await route.fetch(new Request(`http://127.0.0.1:19387${NOTEBOOK_ROUTE}`, { method: 'POST', body: 'not json' }))
  assert.equal(response.status, 400)
})

await check('the route carries connection commands and never echoes a secret', async () => {
  const connections = fakeConnections([LOCAL])
  const routed = connectedModel(connections)
  const registeredHere = []
  registerNotebookRoutes(
    { inject: (_deps, callback) => { callback(childContext({ fetch: { register: (entry) => { registeredHere.push(entry); return () => {} } } })) } },
    { notebooks: routed, connectionInfo: () => ({ configured: true }), onState: () => {} },
  )
  const routeHere = registeredHere.find((entry) => entry.path === NOTEBOOK_ROUTE)
  const postHere = async (body) => (await routeHere.fetch(new Request(`http://127.0.0.1:19387${NOTEBOOK_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))).json()
  try {
    const view = await postHere({
      sessionId: 'route-multi',
      action: 'connectServer',
      url: 'http://route.test:9007',
      token: 'route-secret',
    })
    assert.deepEqual(view.servers.map((entry) => entry.key), ['http://local.test:9003', 'http://route.test:9007'])
    assert.match(view.message, /connected to http:\/\/route\.test:9007/)
    assert.equal(JSON.stringify(view).includes('route-secret'), false)
    const bound = await postHere({ sessionId: 'route-multi', action: 'bindServer', server: 'http://route.test:9007' })
    assert.equal(bound.server, 'http://route.test:9007')
    const fetched = await (await routeHere.fetch(new Request(
      `http://127.0.0.1:19387${NOTEBOOK_ROUTE}?sessionId=route-multi`,
      { method: 'GET' },
    ))).json()
    assert.equal(fetched.server, 'http://route.test:9007')
    assert.equal(fetched.serverConnected, true)
    assert.equal(fetched.defaultServer, 'http://local.test:9003')
    assert.equal(JSON.stringify(fetched).includes('route-secret'), false)
  } finally {
    routed.dispose()
  }
})

await check('the asset route serves the bytes with an immutable cache header', async () => {
  const stored = assets.put('image/png', Buffer.from('hello').toString('base64'))
  assert.ok(stored !== undefined)
  const response = await assetRoute.fetch(new Request(`http://127.0.0.1:19387${ASSET_ROUTE}?name=${stored.name}`, { method: 'GET' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.match(response.headers.get('cache-control'), /immutable/)
  assert.equal(await response.text(), 'hello')
})
await check('the asset route answers 404 for a name it never issued', async () => {
  const response = await assetRoute.fetch(new Request(`http://127.0.0.1:19387${ASSET_ROUTE}?name=../../etc/passwd`, { method: 'GET' }))
  assert.equal(response.status, 404)
})

await check('the download route serves the notebook as an nbformat file', async () => {
  await notebooks.command(SESSION, { action: 'setPath', path: 'reports/q3 analysis.ipynb' })
  const response = await downloadRoute.fetch(new Request(`http://127.0.0.1:19387${DOWNLOAD_ROUTE}?sessionId=${SESSION}`, { method: 'GET' }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/x-ipynb\+json/)
  // A space would break the quoted header, so it becomes an underscore; the extension is kept.
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="q3_analysis.ipynb"')
  const document = await response.json()
  assert.equal(document.nbformat, 4)
  assert.ok(document.cells.length > 0)
  assert.equal(document.cells[0].cell_type, 'code')
})

await check('a session without a path still downloads as notebook.ipynb', async () => {
  const response = await downloadRoute.fetch(new Request(`http://127.0.0.1:19387${DOWNLOAD_ROUTE}?sessionId=no-path-session`, { method: 'GET' }))
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="notebook.ipynb"')
})

await check('the download route without a session reports the error', async () => {
  const response = await downloadRoute.fetch(new Request(`http://127.0.0.1:19387${DOWNLOAD_ROUTE}`, { method: 'GET' }))
  assert.equal(response.status, 200, 'a client-visible failure, not a server fault')
  assert.match((await response.json()).error, /sessionId is required/)
})

await check('the stream route pushes a running cell\'s output as it arrives', async () => {
  const response = await streamRoute.fetch(new Request(`http://127.0.0.1:19387${STREAM_ROUTE}?sessionId=${SESSION}`, { method: 'GET' }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  /** Read whatever arrives within `ms`, so the test never depends on exact scheduling. */
  const drain = async (ms) => {
    const deadline = Date.now() + ms
    for (;;) {
      const left = deadline - Date.now()
      if (left <= 0) return
      const result = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve(undefined), left)),
      ])
      if (result === undefined || result.done === true) return
      text += decoder.decode(result.value, { stream: true })
    }
  }
  await drain(50)
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'runCell', id: cell.id, source: 'streamy' })
  await notebooks.idle(SESSION)
  // The deltas are coalesced for 60 ms before they are written; the final cell is sent at once.
  await drain(400)
  await reader.cancel()
  assert.match(text, /: connected/, 'the stream must open immediately')
  assert.match(text, /"type":"cell"/, 'the run start and end are announced')
  assert.match(text, /"type":"text"/, 'streamed chunks arrive as deltas')
  assert.match(text, /first\\nsecond\\n/, 'the final cell carries the coalesced stream')
})

watched.dispose()
notebooks.dispose()
rmSync(directory, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`\n${label}\n${error?.stack ?? error}`)
  process.exit(1)
}
process.exit(0)
