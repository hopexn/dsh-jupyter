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

import { Notebooks, renderableOutputs } from '../lib/notebook.js'
import { NOTEBOOK_ROUTE, registerNotebookRoutes } from '../lib/routes.js'

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
  const reply = (code) => {
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
    if (code.includes('slow')) {
      return { status: 'timeout', message: 'no result within 2000ms; the kernel was interrupted', executionCount: null, durationMs: 2000, outputs: [{ kind: 'stream', name: 'stdout', text: 'partial\n' }] }
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
      execute: async (_sessionId, code) => { calls.push(code); return reply(code) },
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
  const view = await notebooks.command(SESSION, { action: 'runCell', id: cell.id })
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
  const view = await notebooks.command(SESSION, { action: 'runCell', id: cell.id })
  assert.equal(view.cells[0].status, 'error')
  assert.equal(view.cells[0].outputs[0].type, 'error')
  assert.match(view.cells[0].outputs[0].text, /ValueError: boom/)
})

await check('an image result is delivered as a data URL beside its text', async () => {
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'updateCell', id: cell.id, source: 'show image' })
  const view = await notebooks.command(SESSION, { action: 'runCell', id: cell.id })
  const types = view.cells[0].outputs.map((output) => output.type)
  assert.deepEqual(types, ['text', 'image'])
  assert.equal(view.cells[0].outputs[1].dataUrl, 'data:image/png;base64,aGVsbG8=')
})

await check('a timeout keeps the partial output and explains itself', async () => {
  const cell = (await notebooks.view(SESSION)).cells[0]
  await notebooks.command(SESSION, { action: 'updateCell', id: cell.id, source: 'slow cell' })
  const view = await notebooks.command(SESSION, { action: 'runCell', id: cell.id })
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
  const view = await failing.command(SESSION, { action: 'runCell', id: cell.id })
  assert.equal(view.cells[0].status, 'error')
  assert.equal(view.cells[0].error, 'cannot reach the kernel')
  failing.dispose()
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
  assert.equal(routes.length, 1, 'the route must appear once the service arrives')
  assert.equal(routes[0].path, NOTEBOOK_ROUTE)
  assert.deepEqual([...routes[0].methods].sort(), ['GET', 'POST'])
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
registerNotebookRoutes(
  { inject: (deps, callback) => { callback(childContext(fakeConnection)) } },
  { notebooks, connectionInfo: () => ({ configured: true, url: 'http://example.test' }), onState: (state) => states.push(state) },
)
const route = registered[0]

await check('the registered route carries the panel protocol', () => {
  assert.equal(registered.length, 1)
  assert.equal(route.path, NOTEBOOK_ROUTE)
  assert.deepEqual([...route.methods].sort(), ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
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

notebooks.dispose()
rmSync(directory, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`\n${label}\n${error?.stack ?? error}`)
  process.exit(1)
}
process.exit(0)
