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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Notebooks, OutputRenderer, renderableOutputs } from '../lib/notebook.js'
import { ASSET_ROUTE, NOTEBOOK_ROUTE, STREAM_ROUTE, registerNotebookRoutes } from '../lib/routes.js'
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

/** Deterministic stand-in for the kernel, recording what it was asked to run. */
function fakeRuntime() {
  const calls = []
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
    runtime: {
      execute: async (_sessionId, code, options) => { calls.push(code); return reply(code, options) },
      kernelInfo: async () => kernel,
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
  for (const cell of raw.cells) assert.equal(cell.status, 'idle')
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
  assert.equal(routes.length, 3, 'the notebook route, its output stream, and the asset route')
  assert.deepEqual(routes.map((entry) => entry.path).sort(), [ASSET_ROUTE, NOTEBOOK_ROUTE, STREAM_ROUTE].sort())
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

await check('the registered route carries the panel protocol', () => {
  assert.equal(registered.length, 3)
  assert.deepEqual([...route.methods].sort(), ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.deepEqual([...streamRoute.methods], ['GET'])
  assert.deepEqual([...assetRoute.methods], ['GET'])
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

notebooks.dispose()
rmSync(directory, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`\n${label}\n${error?.stack ?? error}`)
  process.exit(1)
}
process.exit(0)
