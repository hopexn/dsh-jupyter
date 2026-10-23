/**
 * Tests for the browser half of the plugin.
 *
 * There is no browser automation in this environment, so this file runs `lib/client.js` the way the
 * page's module table does: it installs a fake `window.__ModuleLoader__`, materializes the factory
 * with a minimal React, and renders the panel with a tiny hook harness. That catches the failures
 * that would otherwise only show up in the browser console — a bad registration, a missing
 * translator, an undefined reference inside a render path, a broken click handler.
 *
 * What it cannot prove is layout, styling, or interaction feel; those need a human looking at the
 * page.
 *
 *   node test/client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
const failures = []

/**
 * Run one named check, recording failures instead of aborting the run.
 *
 * Awaited by every caller: a sync-only helper would report an async body as passing even when its
 * assertion rejected.
 */
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

/** Collect every host element in a rendered tree, depth-first, flattening nested child arrays. */
function flatten(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  const children = node.props?.children
  for (const child of Array.isArray(children) ? children : [children]) flatten(child, out)
  return out
}

/** Every element rendered by a component type. */
function findAll(tree, type) {
  return flatten(tree).filter((node) => node.type === type)
}

/** Find the first element of a component type, so its own render can be inspected. */
function findComponent(tree, predicate) {
  return flatten(tree).find((node) => typeof node.type === 'function' && predicate(node.props ?? {}))
}

/**
 * Render every output element of a cell tree.
 *
 * The harness does not run React, so a child component stays an element until it is called. Output
 * is hook-free, which makes rendering it here exact rather than approximate.
 */
function renderOutputs(tree) {
  return flatten(tree)
    .filter((node) => typeof node.type === 'function' && node.props?.output !== undefined)
    .flatMap((node) => flatten(node.type(node.props)))
}

/** All text under a rendered node, the way the browser would concatenate it. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/** Minimal DOM so the bundle's style injection has somewhere to go. */
function installDom() {
  const head = { children: [], appendChild(node) { head.children.push(node) } }
  globalThis.document = {
    head,
    querySelector: (selector) => (head.children.length > 0 && selector.includes('dsh-jupyterlab') ? head.children[0] : null),
    createElement: (tag) => ({
      tag,
      textContent: '',
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value },
    }),
  }
  return head
}

/** React stand-in: elements are plain objects, hooks are a single-pass render harness. */
function makeReact(slots) {
  let index = 0
  const effects = []
  return {
    effects,
    reset() { index = 0; effects.length = 0 },
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
    useRef: (initial) => ({ current: initial ?? null }),
    useEffect: (fn) => { effects.push(fn()) },
    // The real component tree bails out of re-rendering on equal props; here the memo wrapper is
    // transparent, so the render paths stay directly callable from the tests.
    memo: (component) => component,
    useState(initial) {
      const slot = index
      index += 1
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      return [slots[slot], (value) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    },
    useCallback: (fn) => fn,
  }
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Materialize the bundle exactly as a page load does, with its own module instance.
 * @returns The materialized exports plus everything its `apply` registered.
 */
function loadBundle() {
  const head = installDom()
  let registration
  globalThis.window = { __ModuleLoader__: { load: (spec) => { registration = spec } } }
  // eslint-disable-next-line no-eval
  eval(source)
  const slots = []
  const React = makeReact(slots)
  const bundle = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error(`the bundle required "${name}", which is not in the page's module table`)
  })
  const registered = { locales: [], tabTypes: [], slots: [], effects: [] }
  const opened = []
  const ctx = {
    effect: (fn, label) => { registered.effects.push(label); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    locale: {
      register: (ns, dicts) => { registered.locales.push({ ns, dicts }); return () => {} },
      bind: (ns) => (key) => `${ns}.${key}`,
    },
    sidebarRightTabs: { register: (definition) => { registered.tabTypes.push(definition); return () => {} } },
    sidebarRight: { openTab: (kind) => { opened.push(kind) } },
    slots: {
      inject: (name, callback) => { callback(); return () => {} },
      register: (spec, Component) => { registered.slots.push({ spec, Component }); return () => {} },
    },
  }
  bundle.apply(ctx)
  const component = (name) => registered.slots.find((entry) => entry.spec.name === name)?.Component
  return { registration, bundle, registered, opened, React, slots, head, component, ctx }
}

/** A view payload shaped exactly like the host's. */
function viewOf(cells, extra = {}) {
  return {
    sessionId: 's1',
    revision: 3,
    path: null,
    // A session holds a desk of notebooks; the view always names the page it is showing.
    notebook: 'main',
    notebooks: ['main'],
    cells,
    kernel: { id: 'kernel-abcd1234', name: 'python3', state: 'idle' },
    ...extra,
  }
}

/** One cell payload. */
function cellOf(overrides = {}) {
  return {
    id: 'c1',
    kind: 'code',
    source: 'print(1)',
    rev: 1,
    status: 'idle',
    executionCount: 2,
    durationMs: 1,
    outputs: [],
    error: null,
    ...overrides,
  }
}

/** Let queued promises settle, so an effect's async work lands in the harness slots. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A stand-in for the page's `EventSource`, recording every stream the panel opens. */
function installEventSource() {
  const instances = []
  class FakeEventSource {
    constructor(url) {
      this.url = String(url)
      this.closed = false
      this.onopen = null
      this.onmessage = null
      this.onerror = null
      instances.push(this)
    }

    close() { this.closed = true }

    /** Deliver one server frame. */
    emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }

    /** Pretend the connection came up. */
    open() { this.onopen?.({}) }
  }
  globalThis.EventSource = FakeEventSource
  return { instances, restore: () => { delete globalThis.EventSource } }
}

/**
 * A recording `fetch`, so a click can be inspected without a host.
 *
 * Answers with the view it was given, at a revision high enough to pass the panel's "older than
 * what I already have" guard — the guard is module-level state shared by every test in this file.
 */
function installFetch(view) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const command = options.body === undefined ? null : JSON.parse(options.body)
    calls.push({ url: String(url), command })
    return { status: 200, json: async () => ({ ...view, revision: (view.revision ?? 0) + (calls.length) }) }
  }
  return { calls, restore: () => { delete globalThis.fetch } }
}

/** A stand-in for the tab's `sessionStorage`, which a draft is written to. */
function installSessionStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  globalThis.sessionStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
  return { map, restore: () => { delete globalThis.sessionStorage } }
}

/**
 * Render the panel with a primed view, then render one of its cells directly.
 * @returns The cell's rendered tree.
 */
function renderCell(page, cell = cellOf(), channel = {}) {
  const Notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cell])
  const tree = Notebook({ sessionId: 's1', t: (key) => key, ...channel })
  const node = findComponent(tree, (props) => props.cell?.id === cell.id)
  assert.ok(node !== undefined, 'the cell element must appear in the panel tree')
  page.React.reset()
  return node.type(node.props)
}

console.log('client bundle')

const page = loadBundle()

await check('it registers under the package name the host declares', () => {
  assert.equal(page.registration.id, '@local/dsh-jupyterlab')
  assert.equal(typeof page.registration.factory, 'function')
})
await check('it materializes to a cordis plugin and requires only seeded modules', () => {
  assert.deepEqual(Object.keys(page.bundle).sort(), ['apply', 'inject'])
  assert.deepEqual(page.bundle.inject, ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'])
})

console.log('\nregistrations')

await check('apply() runs without throwing and injects its stylesheet once', () => {
  assert.equal(page.head.children.length, 1, 'expected exactly one <style> tag')
  assert.equal(page.head.children[0].tag, 'style')
  assert.match(page.head.children[0].textContent, /--dsw-alias-label-primary/, 'styles must use theme tokens')
  assert.doesNotMatch(page.head.children[0].textContent, /#[0-9a-fA-F]{3,6}\b/, 'no hard-coded colours in the chrome')
})
await check('it registers both dictionaries with every key the UI asks for', () => {
  assert.equal(page.registered.locales.length, 1)
  assert.equal(page.registered.locales[0].ns, 'jupyterlab')
  assert.deepEqual(Object.keys(page.registered.locales[0].dicts).sort(), ['en', 'zh'])
  const english = page.registered.locales[0].dicts.en
  for (const key of ['title', 'open', 'openLabel', 'addCell', 'run', 'runHint', 'remove', 'up', 'down', 'done', 'restart', 'interrupt', 'clearOutputs', 'loading', 'retry', 'noKernel', 'running', 'placeholder', 'notesTitle', 'discardNotes', 'agent', 'agentCell', 'runAll', 'runAllHint', 'stopRunAll', 'stopRunAllHint', 'exportIpynb', 'exportHint', 'importIpynb', 'importHint', 'importBad', 'insertBelow', 'showMore', 'showLess', 'dismiss', 'cellLabel', 'outputLabel', 'toCode', 'toMarkdown', 'editorHint', 'changed', 'changedByAgent', 'keepChange', 'undoChange']) {
    assert.equal(typeof english[key], 'string', `missing translation "${key}"`)
  }
})
await check('it registers a kind-only notebook tab type', () => {
  assert.equal(page.registered.tabTypes.length, 1)
  const type = page.registered.tabTypes[0]
  assert.equal(type.id, '@local/dsh-jupyterlab/notebook')
  assert.equal(type.kind, 'jupyter-notebook')
  assert.equal(type.priority, 'extension')
  assert.equal(type.patterns, undefined, 'a page type must not claim resource patterns')
  assert.equal(typeof type.title(), 'string')
  assert.equal(type.keepMounted, true, 'a visited notebook should survive a tab switch')
})
await check('the type offers a guide entry so the panel add control can launch it', () => {
  const guide = page.registered.tabTypes[0].guide
  assert.ok(Array.isArray(guide) && guide.length === 1, 'expected one guide entry')
  assert.equal(guide[0].id, 'notebook')
  assert.equal(typeof guide[0].order, 'number')
  assert.equal(typeof guide[0].title(), 'string')
  assert.equal(typeof guide[0].description(), 'string')
})
await check('it registers the tab body, its chip title, and a composer entry point', () => {
  const byName = (name) => page.registered.slots.filter((entry) => entry.spec.name === name)
  const body = byName('sidebar.right.pane.tab')
  assert.equal(body.length, 1)
  assert.equal(body[0].spec.key, '@local/dsh-jupyterlab/notebook', 'the body is keyed by the type id')
  assert.equal(body[0].spec.locale, 'jupyterlab')
  assert.equal(typeof body[0].Component, 'function')
  assert.equal(byName('sidebar.right.pane.tab.title').length, 1)
  const opener = byName('conversation.input.left')
  assert.equal(opener.length, 1)
  assert.equal(opener[0].spec.id, 'jupyterlab-notebook')
})

console.log('\npanel rendering')

await check('the loading state renders before any view arrives', () => {
  const Notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  const tree = Notebook({ sessionId: 's2', t: (key) => key })
  assert.match(JSON.stringify(flatten(tree).map((node) => node.props?.children)), /loading/)
})
await check('an idle notebook renders its kernel row and the toolbar', () => {
  const Notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf({ source: '' })])
  const text = JSON.stringify(flatten(Notebook({ sessionId: 's1', t: (key) => key })).map((node) => node.props?.children))
  assert.match(text, /python3/)
  assert.match(text, /addCell/)
  assert.match(text, /restart/)
})
await check('a notebook with no kernel explains that running a cell starts one', () => {
  const Notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()], { kernel: undefined })
  const text = JSON.stringify(flatten(Notebook({ sessionId: 's1', t: (key) => key })).map((node) => node.props?.children))
  assert.match(text, /noKernel/)
})
await check('a run cell renders its execution count and every output kind', () => {
  const rendered = renderCell(page, cellOf({
    status: 'ok',
    outputs: [
      { type: 'stream', name: 'stdout', text: 'hello\n' },
      { type: 'stream', name: 'stderr', text: 'warning\n' },
      { type: 'text', text: '42' },
      { type: 'error', text: 'ValueError: boom' },
      { type: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' },
    ],
  }))
  const text = JSON.stringify(flatten(rendered).map((node) => node.props?.children))
  assert.match(text, /\[2\]/, 'the execution count must be visible')
  const outputs = renderOutputs(rendered)
  const outputText = JSON.stringify(outputs.map((node) => node.props?.children))
  assert.match(outputText, /hello\\n/, 'stdout must be rendered')
  assert.match(outputText, /warning\\n/, 'stderr must be rendered')
  assert.match(outputText, /42/, 'a text result must be rendered')
  assert.match(outputText, /ValueError: boom/, 'a traceback must be rendered')
  const images = outputs.filter((node) => node.type === 'img')
  assert.equal(images.length, 1, `expected one image, got ${JSON.stringify(outputs.map((node) => node.type))}`)
  assert.equal(images[0].props.src, 'data:image/png;base64,AAA')
})
await check('stderr, errors and plain output are styled differently', () => {
  const rendered = renderCell(page, cellOf({
    outputs: [
      { type: 'stream', name: 'stderr', text: 'w' },
      { type: 'error', text: 'e' },
      { type: 'text', text: 't' },
    ],
  }))
  const classes = renderOutputs(rendered).filter((node) => node.type === 'pre').map((node) => node.props.className)
  assert.ok(classes.some((name) => name.includes('dshj-stderr')), classes.join('|'))
  assert.ok(classes.some((name) => name.includes('dshj-error')), classes.join('|'))
  assert.ok(classes.some((name) => name === 'dshj-pre'), classes.join('|'))
})
await check('a cell with a DSH-side failure shows it next to the cell', () => {
  const rendered = renderCell(page, cellOf({ error: 'cannot reach the kernel' }))
  assert.match(JSON.stringify(flatten(rendered).map((node) => node.props?.children)), /cannot reach the kernel/)
})

console.log('\ncell interaction')

await check('a read-mode cell shows its source and offers the full action row', () => {
  const rendered = renderCell(page)
  const sources = findAll(rendered, 'pre').filter((node) => node.props.className === 'dshj-source')
  assert.equal(sources.length, 1, 'the source must be shown')
  assert.equal(textOf(sources[0]), 'print(1)', 'the highlighted source must still read as its own text')
  assert.equal(findAll(rendered, 'textarea').length, 0, 'read mode must not show a textarea')
  const labels = findAll(rendered, 'button').map((node) => node.props.children)
  for (const label of ['run', '↑', '↓', '⌫', '✕']) assert.ok(labels.includes(label), `missing ${label} button in ${labels.join(',')}`)
})
await check('double-clicking the source starts editing', () => {
  const rendered = renderCell(page)
  const source = findAll(rendered, 'pre').find((node) => node.props.className === 'dshj-source')
  assert.equal(typeof source.props.onDoubleClick, 'function', 'the source must be double-clickable')
  source.props.onDoubleClick()
})
await check('the run button runs the cell with its own source', () => {
  let ran = null
  const rendered = renderCell(page, cellOf(), {})
  const notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()])
  const tree = notebook({ sessionId: 's1', t: (key) => key })
  const node = findComponent(tree, (props) => props.cell?.id === 'c1')
  const withRun = node.type({ ...node.props, onRun: (id, source) => { ran = { id, source } } })
  findAll(withRun, 'button').find((button) => button.props.children === 'run').props.onClick()
  assert.deepEqual(ran, { id: 'c1', source: 'print(1)' })
  assert.equal(rendered !== null, true)
})
await check('delete, move and clear-output callbacks are wired to the cell id', () => {
  const notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()])
  const node = findComponent(notebook({ sessionId: 's1', t: (key) => key }), (props) => props.cell?.id === 'c1')
  const seen = []
  const rendered = node.type({
    ...node.props,
    onDelete: (id) => seen.push(['delete', id]),
    onMove: (id, delta) => seen.push(['move', id, delta]),
    onClear: (id) => seen.push(['clear', id]),
  })
  const buttons = findAll(rendered, 'button')
  buttons.find((button) => button.props.children === '✕').props.onClick()
  buttons.find((button) => button.props.children === '↓').props.onClick()
  buttons.find((button) => button.props.children === '⌫').props.onClick()
  assert.deepEqual(seen, [['delete', 'c1'], ['move', 'c1', 1], ['clear', 'c1']])
})
await check('edit mode renders a textarea holding the draft', () => {
  const notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()])
  page.slots[4] = 'c1'
  page.slots[5] = { main: { c1: 'print(2)' } }
  const node = findComponent(notebook({ sessionId: 's1', t: (key) => key }), (props) => props.cell?.id === 'c1')
  const textareas = findAll(node.type(node.props), 'textarea')
  assert.equal(textareas.length, 1)
  assert.equal(textareas[0].props.value, 'print(2)')
  assert.equal(typeof textareas[0].props.onChange, 'function')
  assert.equal(typeof textareas[0].props.onKeyDown, 'function')
  assert.equal(textareas[0].props.spellCheck, false)
})
await check('Shift+Enter in the editor runs the cell and suppresses the newline', () => {
  const notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()])
  page.slots[4] = 'c1'
  page.slots[5] = { main: { c1: 'print(3)' } }
  const node = findComponent(notebook({ sessionId: 's1', t: (key) => key }), (props) => props.cell?.id === 'c1')
  let ran = null
  const editing = node.type({ ...node.props, editing: 'c1', draft: 'print(3)', onRun: (id, source) => { ran = { id, source } } })
  let prevented = false
  findAll(editing, 'textarea')[0].props.onKeyDown({ key: 'Enter', shiftKey: true, preventDefault: () => { prevented = true } })
  assert.deepEqual(ran, { id: 'c1', source: 'print(3)' })
  assert.equal(prevented, true)
})
await check('Escape leaves edit mode without running', () => {
  const notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()])
  page.slots[4] = 'c1'
  const node = findComponent(notebook({ sessionId: 's1', t: (key) => key }), (props) => props.cell?.id === 'c1')
  let cancelled = false
  const editing = node.type({ ...node.props, editing: 'c1', onCancel: () => { cancelled = true } })
  findAll(editing, 'textarea')[0].props.onKeyDown({ key: 'Escape', preventDefault: () => {} })
  assert.equal(cancelled, true)
})
await check('move buttons are disabled at the ends of the notebook', () => {
  const Notebook = page.component('sidebar.right.pane.tab')
  const first = cellOf({ id: 'a' })
  const middle = cellOf({ id: 'b' })
  const last = cellOf({ id: 'c' })
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([first, middle, last])
  const tree = Notebook({ sessionId: 's1', t: (key) => key })
  const arrows = (id) => {
    const node = findComponent(tree, (props) => props.cell?.id === id)
    const buttons = findAll(node.type(node.props), 'button')
    return {
      up: buttons.find((button) => button.props.children === '↑').props.disabled,
      down: buttons.find((button) => button.props.children === '↓').props.disabled,
    }
  }
  assert.deepEqual(arrows('a'), { up: true, down: false }, 'the first cell cannot move up')
  assert.deepEqual(arrows('b'), { up: false, down: false }, 'a middle cell can move both ways')
  assert.deepEqual(arrows('c'), { up: false, down: true }, 'the last cell cannot move down')
})

console.log('\nhost calls')

await check('the panel reads the host route for its session', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    return { status: 200, json: async () => viewOf([]) }
  }
  try {
    const fresh = loadBundle()
    const Notebook = fresh.component('sidebar.right.pane.tab')
    fresh.React.reset()
    fresh.slots.length = 0
    Notebook({ sessionId: 'session/with spaces', t: (key) => key })
    assert.equal(calls.length, 1, 'the mount effect must issue exactly one read')
    // Document-relative, as shipped clients do, so the app still works behind a path prefix.
    assert.equal(calls[0].url, 'api/jupyterlab/notebook?sessionId=session%2Fwith%20spaces')
    assert.equal(calls[0].method, 'GET')
  } finally {
    globalThis.fetch = original
  }
})

await check('a command posts to the same document-relative route', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
    return { status: 200, json: async () => viewOf([]) }
  }
  try {
    const fresh = loadBundle()
    const Notebook = fresh.component('sidebar.right.pane.tab')
    fresh.React.reset()
    fresh.slots.length = 0
    fresh.slots[0] = viewOf([cellOf()])
    const tree = Notebook({ sessionId: 's1', t: (key) => key })
    const node = findComponent(tree, (props) => props.cell?.id === 'c1')
    // The run callback lives on the panel, not the cell, so drive it through a button press.
    const withRun = node.type({ ...node.props })
    void withRun
    const addButton = findAll(tree, 'button').find((button) => button.props.children === 'addCell')
    await addButton.props.onClick()
    // The mount effect reads the view first; the press is the only POST.
    const posts = calls.filter((call) => call.method === 'POST')
    assert.equal(posts.length, 1, `expected one POST, got ${JSON.stringify(calls)}`)
    assert.equal(posts[0].url, 'api/jupyterlab/notebook')
    assert.deepEqual(JSON.parse(posts[0].body), { action: 'addCell', sessionId: 's1' })
  } finally {
    globalThis.fetch = original
  }
})

console.log('\nstreaming')

await check('an image output renders from its stored URL', () => {
  const rendered = renderCell(page, cellOf({
    outputs: [{ type: 'image', mime: 'image/png', url: 'api/jupyterlab/asset?name=abc.png' }],
  }))
  const images = renderOutputs(rendered).filter((node) => node.type === 'img')
  assert.equal(images.length, 1)
  assert.equal(images[0].props.src, 'api/jupyterlab/asset?name=abc.png')
  assert.equal(images[0].props.loading, 'lazy', 'a long notebook must not fetch every plot at once')
})

await check('the panel opens one stream per session and renders what it pushes', async () => {
  const sources = installEventSource()
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, json: async () => viewOf([cellOf()]) })
  try {
    const fresh = loadBundle()
    const Notebook = fresh.component('sidebar.right.pane.tab')
    fresh.React.reset()
    fresh.slots.length = 0
    fresh.slots[0] = viewOf([cellOf()])
    Notebook({ sessionId: 's1', t: (key) => key })
    const opened = sources.instances.filter((source) => !source.closed)
    assert.equal(opened.length, 1, `expected one stream, got ${sources.instances.length}`)
    // Document-relative, like every other call the panel makes.
    assert.equal(opened[0].url, 'api/jupyterlab/notebook/stream?sessionId=s1')

    const stream = opened[0]
    stream.open()
    await tick()
    stream.emit({ type: 'cell', revision: 4, cell: cellOf({ status: 'running', rev: 2, outputs: [] }) })
    stream.emit({ type: 'append', cellId: 'c1', output: { type: 'stream', name: 'stdout', text: 'hello' } })
    stream.emit({ type: 'text', cellId: 'c1', index: 0, text: ' world' })
    fresh.React.reset()
    const tree = Notebook({ sessionId: 's1', t: (key) => key })
    const node = findComponent(tree, (props) => props.cell?.id === 'c1')
    assert.equal(node.props.cell.status, 'running', 'the run is visible before the command answers')
    const text = JSON.stringify(renderOutputs(node.type(node.props)).map((child) => child.props?.children))
    assert.match(text, /hello world/, `streamed text must grow in one entry, got ${text}`)
  } finally {
    globalThis.fetch = original
    sources.restore()
  }
})

await check('a clear event wipes the cell before the next chunk', async () => {
  const sources = installEventSource()
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, json: async () => viewOf([cellOf()]) })
  try {
    const fresh = loadBundle()
    const Notebook = fresh.component('sidebar.right.pane.tab')
    fresh.React.reset()
    fresh.slots.length = 0
    fresh.slots[0] = viewOf([cellOf({ outputs: [{ type: 'stream', name: 'stdout', text: 'old' }] })])
    Notebook({ sessionId: 's1', t: (key) => key })
    const stream = sources.instances[0]
    stream.emit({ type: 'clear', cellId: 'c1' })
    stream.emit({ type: 'append', cellId: 'c1', output: { type: 'stream', name: 'stdout', text: 'new' } })
    fresh.React.reset()
    const tree = Notebook({ sessionId: 's1', t: (key) => key })
    const node = findComponent(tree, (props) => props.cell?.id === 'c1')
    assert.deepEqual(node.props.cell.outputs, [{ type: 'stream', name: 'stdout', text: 'new' }])
  } finally {
    globalThis.fetch = original
    sources.restore()
  }
})

await check('an insert event adds the agent\'s cell to the list', async () => {
  const sources = installEventSource()
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, json: async () => viewOf([cellOf()]) })
  try {
    const fresh = loadBundle()
    const Notebook = fresh.component('sidebar.right.pane.tab')
    fresh.React.reset()
    fresh.slots.length = 0
    fresh.slots[0] = viewOf([cellOf()])
    Notebook({ sessionId: 's-insert', t: (key) => key })
    const stream = sources.instances[0]
    stream.emit({
      type: 'insert',
      revision: 4,
      index: 1,
      cell: cellOf({ id: 'c2', origin: 'agent', source: 'print(2)', rev: 1 }),
    })
    fresh.React.reset()
    const tree = Notebook({ sessionId: 's-insert', t: (key) => key })
    const order = flatten(tree)
      .filter((node) => typeof node.type === 'function' && node.props?.cell !== undefined)
      .map((node) => node.props.cell.id)
    assert.deepEqual(order, ['c1', 'c2'], 'an insert must grow the list, not be dropped like an unknown event')
  } finally {
    globalThis.fetch = original
    sources.restore()
  }
})

await check('a full view older than a streamed event does not move the notebook backwards', async () => {
  const sources = installEventSource()
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => viewOf([cellOf({ status: 'running', rev: 2 })], { revision: 4 }),
  })
  try {
    const fresh = loadBundle()
    const Notebook = fresh.component('sidebar.right.pane.tab')
    fresh.React.reset()
    fresh.slots.length = 0
    fresh.slots[0] = viewOf([cellOf()])
    Notebook({ sessionId: 's-stale', t: (key) => key })
    const stream = sources.instances[0]
    stream.emit({
      type: 'cell',
      revision: 6,
      cell: cellOf({ status: 'ok', rev: 3, outputs: [{ type: 'text', text: 'done' }] }),
    })
    // A slow fetch, started before the event, answers with revision 4.
    stream.open()
    await tick()
    fresh.React.reset()
    const tree = Notebook({ sessionId: 's-stale', t: (key) => key })
    const cell = findComponent(tree, (props) => props.cell?.id === 'c1').props.cell
    assert.equal(cell.rev, 3, 'the older snapshot must be ignored')
    assert.equal(cell.status, 'ok')
  } finally {
    globalThis.fetch = original
    sources.restore()
  }
})

await check('a poll that changed nothing keeps the cell objects, so memo can skip them', async () => {
  const original = globalThis.fetch
  const payload = JSON.stringify(viewOf([cellOf()]))
  // Parsed per response on purpose: a fresh document must not defeat the identity check.
  globalThis.fetch = async () => ({ status: 200, json: async () => JSON.parse(payload) })
  try {
    const fresh = loadBundle()
    const Notebook = fresh.component('sidebar.right.pane.tab')
    fresh.React.reset()
    fresh.slots.length = 0
    Notebook({ sessionId: 's1', t: (key) => key })
    await tick()
    fresh.React.reset()
    const first = Notebook({ sessionId: 's1', t: (key) => key })
    const before = findComponent(first, (props) => props.cell?.id === 'c1').props.cell
    await tick()
    fresh.React.reset()
    const second = Notebook({ sessionId: 's1', t: (key) => key })
    const after = findComponent(second, (props) => props.cell?.id === 'c1').props.cell
    assert.equal(after, before, 'an unchanged cell must keep its identity across a poll')
  } finally {
    globalThis.fetch = original
  }
})

await check('the header shows how many panel changes are waiting for the agent', () => {
  const Notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()], { pendingNotes: 2 })
  const tree = Notebook({ sessionId: 's-badge', t: (key) => key })
  const badge = flatten(tree).find((node) => node.props?.className === 'dshj-sync')
  assert.ok(badge !== undefined, 'a queued count must be visible')
  assert.equal(textOf(badge), '2 syncLabel')
  assert.equal(badge.props.title, 'syncHint')
})

await check('the badge disappears when nothing is queued', () => {
  const Notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()], { pendingNotes: 0 })
  const tree = Notebook({ sessionId: 's-badge', t: (key) => key })
  assert.equal(flatten(tree).find((node) => node.props?.className === 'dshj-sync'), undefined)
})

await check('the badge opens the list of what will be sent, not just a number', () => {
  const Notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()], {
    pendingNotes: 2,
    notes: [{ key: 'a', summary: 'Edited cell 1 (code)' }, { key: 'b', summary: 'Ran cell 2 (code)' }],
  })
  const tree = Notebook({ sessionId: 's-notes', t: (key) => key })
  const badge = flatten(tree).find((node) => node.props?.className === 'dshj-sync')
  assert.equal(badge.type, 'button', 'the badge must be openable')
  assert.equal(badge.props['aria-expanded'], 'false')
  badge.props.onClick()
  page.React.reset()
  const opened = Notebook({ sessionId: 's-notes', t: (key) => key })
  const panel = flatten(opened).find((node) => node.props?.className === 'dshj-notes')
  assert.ok(panel !== undefined, 'clicking the badge must reveal the queued notes')
  assert.match(textOf(panel), /Edited cell 1 \(code\)/)
  assert.match(textOf(panel), /Ran cell 2 \(code\)/)
})

await check('an agent-created cell is marked, a user cell is not', () => {
  const agentCell = renderCell(page, cellOf({ origin: 'agent' }))
  const chip = flatten(agentCell).find((node) => node.props?.className === 'dshj-origin')
  assert.ok(chip !== undefined, 'an agent cell must say so')
  assert.equal(textOf(chip), 'agent')
  const userCell = renderCell(page, cellOf())
  assert.equal(flatten(userCell).find((node) => node.props?.className === 'dshj-origin'), undefined)
})

console.log('\nthe model\'s rewrite')

await check('a rewritten cell offers its diff; an ordinary cell does not', () => {
  const rewritten = renderCell(page, cellOf({ source: 'x = 2', previousSource: 'x = 1' }))
  const chip = flatten(rewritten).find((node) => node.props?.className === 'dshj-changed')
  assert.ok(chip !== undefined, 'the change must be visible without opening anything')
  assert.equal(chip.type, 'button', 'and openable')
  assert.equal(chip.props['aria-expanded'], 'false')
  const plain = renderCell(page, cellOf({ source: 'x = 2' }))
  assert.equal(flatten(plain).find((node) => node.props?.className === 'dshj-changed'), undefined)
})

await check('the diff says which lines were removed and which were added', () => {
  const rendered = renderCellIn(page, cellOf({ source: 'x = 1\ny = 3', previousSource: 'x = 1\ny = 2' }), {
    props: { diffOpen: true },
  })
  const rows = flatten(rendered).filter((node) => typeof node.props?.className === 'string'
    && node.props.className.startsWith('dshj-diff-row'))
  assert.equal(rows.length, 3, 'one unchanged line, one removal, one addition')
  assert.match(rows[0].props.className, /dshj-diff-same/)
  assert.match(rows[1].props.className, /dshj-diff-del/)
  assert.equal(textOf(rows[1]), '-y = 2')
  assert.match(rows[2].props.className, /dshj-diff-add/)
  assert.equal(textOf(rows[2]), '+y = 3')
})

await check('a closed diff renders no rows at all', () => {
  const rendered = renderCellIn(page, cellOf({ source: 'x = 2', previousSource: 'x = 1' }), { props: { diffOpen: false } })
  assert.equal(flatten(rendered).filter((node) => node.props?.className === 'dshj-diff').length, 0)
})

await check('keep and undo are the two endings, and both are one command', () => {
  const calls = []
  const rendered = renderCellIn(page, cellOf({ source: 'x = 2', previousSource: 'x = 1' }), {
    props: {
      diffOpen: true,
      onAcceptDiff: (id) => calls.push(['accept', id]),
      onRevertDiff: (id) => calls.push(['revert', id]),
    },
  })
  const keep = flatten(rendered).find((node) => node.type === 'button' && textOf(node) === 'keepChange')
  const undo = flatten(rendered).find((node) => node.type === 'button' && textOf(node) === 'undoChange')
  assert.ok(keep !== undefined && undo !== undefined, 'the diff needs a way to end')
  keep.props.onClick()
  undo.props.onClick()
  assert.deepEqual(calls, [['accept', 'c1'], ['revert', 'c1']])
})

await check('which diff is open belongs to the panel, not to the cell', async () => {
  const view = viewOf([cellOf({ source: 'x = 2', previousSource: 'x = 1' })], { revision: 160 })
  const fetchState = installFetch(view)
  try {
    page.React.reset()
    page.slots.length = 0
    page.slots[0] = view
    const Notebook = page.component('sidebar.right.pane.tab')
    const tree = Notebook({ sessionId: 's-diff', t: (key) => key })
    const cellNode = findComponent(tree, (props) => props.cell?.id === 'c1')
    assert.equal(cellNode.props.diffOpen, false)
    // One diff at a time: the panel keeps the id, so a second cell cannot open a second one.
    cellNode.props.onToggleDiff('c1')
    page.React.reset()
    const opened = Notebook({ sessionId: 's-diff', t: (key) => key })
    assert.equal(findComponent(opened, (props) => props.cell?.id === 'c1').props.diffOpen, true,
      'the click must survive the next render')
  } finally {
    fetchState.restore()
  }
})

console.log('\nrun all, import, and drafts')

/** Render the panel twice so effects that set state have landed, the way a real re-render would. */
function panelTree(props) {
  const Notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  Notebook(props)
  page.React.reset()
  return Notebook(props)
}

/** A button or link by its visible text. */
function byText(tree, text) {
  return flatten(tree).find((node) => (node.type === 'button' || node.type === 'a') && textOf(node) === text)
}

await check('the toolbar runs every cell, and turns into a stop while a sequence is going', async () => {
  const fetchState = installFetch(viewOf([cellOf()], { revision: 90 }))
  try {
    const idle = panelTree({ sessionId: 's1', t: (key) => key })
    const runAll = byText(idle, 'runAll')
    assert.ok(runAll !== undefined, 'an idle panel offers "run all"')
    assert.equal(byText(idle, 'stopRunAll'), undefined)
    await runAll.props.onClick()
    await tick()
    // The first call is the panel's initial read; only commands carry an action.
    assert.deepEqual(fetchState.calls.filter((call) => call.command !== null).map((call) => call.command.action), ['runAll'])

    // The host says a sequence is going: the same slot becomes the way out of it.
    page.React.reset()
    page.slots.length = 0
    page.slots[0] = viewOf([cellOf()], { revision: 96, runningAll: true })
    page.React.reset()
    const stopping = page.component('sidebar.right.pane.tab')({ sessionId: 's1', t: (key) => key })
    const stop = byText(stopping, 'stopRunAll')
    assert.ok(stop !== undefined, 'a running sequence must offer a stop')
    assert.equal(byText(stopping, 'runAll'), undefined)
    await stop.props.onClick()
    await tick()
    assert.equal(fetchState.calls[fetchState.calls.length - 1].command.action, 'interrupt')
  } finally {
    fetchState.restore()
  }
})

await check('a cell can add another one directly below it', async () => {
  const fetchState = installFetch(viewOf([cellOf()], { revision: 91 }))
  try {
    const rendered = renderCell(page, cellOf({ id: 'c9' }))
    const insert = flatten(rendered).find((node) => node.props?.['aria-label'] === 'insertBelow')
    assert.ok(insert !== undefined, 'every cell offers an insert-below control')
    await insert.props.onClick()
    await tick()
    const commands = fetchState.calls.filter((call) => call.command !== null).map((call) => call.command)
    assert.deepEqual(commands[commands.length - 1], { action: 'addCell', afterId: 'c9', sessionId: 's1' })
  } finally {
    fetchState.restore()
  }
})

await check('a long output starts folded, and unfolds on one click', () => {
  const text = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n')
  const rendered = renderCell(page, cellOf({ outputs: [{ type: 'text', text }] }))
  const outputNode = findComponent(rendered, (props) => props.output?.type === 'text')
  assert.ok(outputNode !== undefined)
  page.React.reset()
  const fold = outputNode.type(outputNode.props)
  // Output wraps the pre in a Collapsible element; rendering that gives the host nodes. Its state
  // is the first slot, so it has to start from an empty one.
  page.React.reset()
  page.slots.length = 0
  const closed = fold.type(fold.props)
  assert.equal(closed.props['data-open'], 'false', 'a 60-line output is folded')
  const more = flatten(closed).find((node) => node.type === 'button')
  assert.equal(textOf(more), 'showMore')
  more.props.onClick()
  page.React.reset()
  const opened = fold.type(fold.props)
  assert.equal(opened.props['data-open'], 'true')
  assert.equal(textOf(flatten(opened).find((node) => node.type === 'button')), 'showLess')
})

await check('a short output is not folded at all', () => {
  const rendered = renderCell(page, cellOf({ outputs: [{ type: 'text', text: 'ok' }] }))
  const outputNode = findComponent(rendered, (props) => props.output?.type === 'text')
  page.React.reset()
  const fold = outputNode.type(outputNode.props)
  assert.equal(fold.props.long, false)
  page.React.reset()
  page.slots.length = 0
  const host = fold.type(fold.props)
  assert.equal(host.props['data-open'], 'true', 'nothing to open')
  assert.equal(flatten(host).filter((node) => node.type === 'button').length, 0)
})

await check('an import replaces the whole list in one streamed event', () => {
  const source = installEventSource()
  try {
    const props = { sessionId: 's1', t: (key) => key }
    page.React.reset()
    page.slots.length = 0
    page.slots[0] = viewOf([cellOf()], { revision: 70 })
    page.component('sidebar.right.pane.tab')(props)
    assert.equal(source.instances.length, 1, 'the panel opens one stream')
    source.instances[0].emit({ type: 'replace', revision: 71, cells: [cellOf({ id: 'z1', source: 'imported = True' }), cellOf({ id: 'z2', kind: 'markdown', source: 'prose' })] })
    page.React.reset()
    const tree = page.component('sidebar.right.pane.tab')(props)
    const cells = flatten(tree).filter((node) => node.props?.cell !== undefined && typeof node.type === 'function')
    assert.deepEqual(cells.map((node) => node.props.cell.id), ['z1', 'z2'])
    assert.equal(cells[1].props.cell.kind, 'markdown')
  } finally {
    source.restore()
  }
})

await check('a run-all event flips the toolbar without a revision bump', () => {
  const source = installEventSource()
  try {
    const props = { sessionId: 's1', t: (key) => key }
    page.React.reset()
    page.slots.length = 0
    page.slots[0] = viewOf([cellOf()], { revision: 80 })
    page.component('sidebar.right.pane.tab')(props)
    source.instances[0].emit({ type: 'runall', running: true, revision: 80 })
    page.React.reset()
    const tree = page.component('sidebar.right.pane.tab')(props)
    assert.ok(byText(tree, 'stopRunAll') !== undefined)
    assert.equal(byText(tree, 'runAll'), undefined)
  } finally {
    source.restore()
  }
})

await check('an unsaved draft is back after a reload, in its editor', () => {
  const storage = installSessionStorage({
    'dshj:draft:s1': JSON.stringify({ notebook: 'main', editing: 'c1', drafts: { main: { c1: 'print("half written' } } }),
  })
  const fetchState = installFetch(viewOf([cellOf()], { revision: 92 }))
  try {
    const tree = panelTree({ sessionId: 's1', t: (key) => key })
    const node = findComponent(tree, (props) => props.cell?.id === 'c1')
    assert.equal(node.props.draft, 'print("half written', 'the text the host never received')
    assert.equal(node.props.editing, 'c1', 'and the editor reopened where the user left it')
    // Writing the draft never went through a command: it is client state, not notebook state.
    assert.ok(fetchState.calls.every((call) => call.command === null), 'no draft ever reaches the host')
  } finally {
    fetchState.restore()
    storage.restore()
  }
})

await check('a draft for a cell that no longer exists is dropped, not resurrected', async () => {
  const storage = installSessionStorage({
    'dshj:draft:s1': JSON.stringify({ notebook: 'main', editing: null, drafts: { main: { gone: 'orphan text' } } }),
  })
  const fetchState = installFetch(viewOf([cellOf({ id: 'c1' })], { revision: 93 }))
  try {
    panelTree({ sessionId: 's1', t: (key) => key })
    await tick()
    const saved = storage.map.get('dshj:draft:s1')
    // Either removed, or stored without the orphan — never carried into a later session.
    assert.equal(saved === undefined || JSON.parse(saved).drafts.main === undefined, true)
  } finally {
    fetchState.restore()
    storage.restore()
  }
})

await check('a draft record from before several notebooks existed still opens', () => {
  // The old shape was one flat map of cell id to text. Losing it on upgrade would lose exactly
  // the paragraph a draft exists to protect, so it is read as the page it belonged to.
  const storage = installSessionStorage({
    'dshj:draft:s1': JSON.stringify({ editing: null, drafts: { c1: 'legacy draft' } }),
  })
  const fetchState = installFetch(viewOf([cellOf()], { revision: 96 }))
  try {
    const tree = panelTree({ sessionId: 's1', t: (key) => key })
    const node = findComponent(tree, (props) => props.cell?.id === 'c1')
    assert.equal(node.props.draft, 'legacy draft')
  } finally {
    fetchState.restore()
    storage.restore()
  }
})

console.log('\nseveral notebooks')

/** Render the panel on a view that is already on screen, the way a reloaded page would be. */
function primedTree(extra = {}) {
  const view = viewOf([cellOf()], { revision: 99, ...extra })
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = view
  return page.component('sidebar.right.pane.tab')({ sessionId: 's1', t: (key) => key })
}

await check('the picker names every notebook and marks the one on screen', () => {
  const fetchState = installFetch(viewOf([cellOf()], { revision: 94, notebook: 'Untitled', notebooks: ['main', 'Untitled'] }))
  try {
    const tree = primedTree({ notebook: 'Untitled', notebooks: ['main', 'Untitled'] })
    const picker = findAll(tree, 'select').find((node) => node.props.className === 'dshj-picker')
    assert.ok(picker !== undefined, 'the toolbar must offer a way between pages')
    assert.equal(picker.props.value, 'Untitled', 'the open notebook is the selected one')
    assert.deepEqual(picker.props.children.map((option) => option.props.value), ['main', 'Untitled'])
    assert.equal(picker.props['aria-label'], 'notebookPicker')
  } finally {
    fetchState.restore()
  }
})

await check('choosing another notebook asks the host to switch, once', async () => {
  const fetchState = installFetch(viewOf([cellOf()], { revision: 95, notebooks: ['main', 'Untitled'] }))
  try {
    const tree = primedTree({ notebooks: ['main', 'Untitled'] })
    const picker = findAll(tree, 'select').find((node) => node.props.className === 'dshj-picker')
    await picker.props.onChange({ target: { value: 'Untitled' } })
    const sent = fetchState.calls.map((call) => call.command).filter((command) => command !== null)
    assert.equal(sent.length, 1, 'one switch, not one per render')
    assert.equal(sent[0].action, 'switchNotebook')
    assert.equal(sent[0].notebook, 'Untitled')
  } finally {
    fetchState.restore()
  }
})

await check('the new-notebook button asks the host for a page, not for a name', async () => {
  const fetchState = installFetch(viewOf([cellOf()], { revision: 96 }))
  try {
    const tree = primedTree({})
    const button = byText(tree, 'newNotebook')
    assert.ok(button !== undefined, 'a session with one notebook still needs a way to start another')
    assert.equal(button.props.title, 'newNotebookHint')
    await button.props.onClick()
    const sent = fetchState.calls.map((call) => call.command).filter((command) => command !== null)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].action, 'newNotebook', 'the host picks the name')
  } finally {
    fetchState.restore()
  }
})

await check('a switch in another window reloads this one instead of patching it', async () => {
  const source = installEventSource()
  const fetchState = installFetch(viewOf([cellOf({ id: 'c1', source: 'main_cell = 1' })], { revision: 97 }))
  try {
    const props = { sessionId: 's1', t: (key) => key }
    page.React.reset()
    page.slots.length = 0
    page.slots[0] = viewOf([cellOf({ id: 'c1', source: 'main_cell = 1' })], { revision: 97 })
    page.component('sidebar.right.pane.tab')(props)
    const before = fetchState.calls.length
    source.instances[0].emit({ type: 'notebook', notebook: 'Untitled' })
    // A reload, because the cell list belongs to a document that is no longer on screen.
    assert.equal(fetchState.calls.length, before + 1)
    assert.equal(fetchState.calls.at(-1).command, null, 'a read, not a command')
    // A window that missed the frame still gets there through the poll, so the switch is not lost.
    assert.equal(fetchState.calls.at(-1).url.includes('since='), false, 'the whole view, not a delta')
  } finally {
    fetchState.restore()
    source.restore()
  }
})

await check('drafts survive a switch away from the page they belong to', () => {
  const storage = installSessionStorage({})
  const fetchState = installFetch(viewOf([cellOf()], { revision: 98 }))
  try {
    const props = { sessionId: 's1', t: (key) => key }
    page.React.reset()
    page.slots.length = 0
    page.slots[0] = viewOf([cellOf()], { revision: 98 })
    // A draft typed on `main`, then the host's answer to a switch: a different document.
    page.slots[5] = { main: { c1: 'only in main' } }
    page.component('sidebar.right.pane.tab')(props)
    const saved = JSON.parse(storage.map.get('dshj:draft:s1'))
    assert.deepEqual(saved.drafts, { main: { c1: 'only in main' } }, 'the text is stored per page')
    assert.equal(saved.notebook, 'main')
  } finally {
    fetchState.restore()
    storage.restore()
  }
})

console.log('\nhighlighting')

await check('code is highlighted without changing its text', () => {
  const source = 'def area(r):  # circle\n    return 3.14 * r ** 2\nprint(area("x"))'
  const rendered = renderCell(page, cellOf({ source }))
  const pre = findAll(rendered, 'pre').find((node) => node.props.className === 'dshj-source')
  assert.equal(textOf(pre), source, 'highlighting must not alter what the cell says')
  const classes = findAll(pre, 'span').map((node) => node.props.className)
  for (const cls of ['dshj-t-kw', 'dshj-t-def', 'dshj-t-com', 'dshj-t-num', 'dshj-t-str', 'dshj-t-fn']) {
    assert.ok(classes.includes(cls), `missing ${cls} in ${classes.join('|')}`)
  }
})
await check('a hash inside a string stays a string, and the comment after it is a comment', () => {
  const rendered = renderCell(page, cellOf({ source: 'x = "# not a comment"  # comment' }))
  const pre = findAll(rendered, 'pre').find((node) => node.props.className === 'dshj-source')
  const spans = findAll(pre, 'span')
  assert.deepEqual(spans.filter((node) => node.props.className === 'dshj-t-str').map(textOf), ['"# not a comment"'])
  assert.deepEqual(spans.filter((node) => node.props.className === 'dshj-t-com').map(textOf), ['# comment'])
})
await check('an IPython magic is recognised at a line start only', () => {
  const rendered = renderCell(page, cellOf({ source: '%timeit sum(range(10))\nrem = 10 % 3' }))
  const pre = findAll(rendered, 'pre').find((node) => node.props.className === 'dshj-source')
  const magic = findAll(pre, 'span').filter((node) => node.props.className === 'dshj-t-magic').map(textOf)
  assert.equal(magic.length, 1, `only the magic line may be coloured: ${JSON.stringify(magic)}`)
  assert.match(magic[0], /^%timeit/)
})
await check('edit mode puts the highlight layer under a transparent textarea', () => {
  const notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()])
  page.slots[4] = 'c1'
  page.slots[5] = { main: { c1: 'x = 1' } }
  const node = findComponent(notebook({ sessionId: 's1', t: (key) => key }), (props) => props.cell?.id === 'c1')
  const rendered = node.type({ ...node.props, editing: 'c1', draft: 'x = 1' })
  const layer = findAll(rendered, 'pre').find((node) => node.props.className === 'dshj-hl')
  assert.ok(layer !== undefined, 'a highlight layer must sit under the editor')
  assert.equal(textOf(layer).trimEnd(), 'x = 1')
  const areas = findAll(rendered, 'textarea')
  assert.equal(areas.length, 1)
  assert.equal(areas[0].props.value, 'x = 1')
  assert.equal(areas[0].props.className, 'dshj-editor')
  assert.equal(typeof areas[0].props.onCompositionStart, 'function', 'an IME must be able to reveal the textarea text')
})
await check('tokenizing preserves every character of a tricky snippet', () => {
  const corpus = [
    'x = f"{a!r:>{w}}"',
    's = """triple\nquoted # not a comment"""',
    "t = r'\\d+' + 'it\\'s'",
    '%matplotlib inline\nimport numpy as np',
    '!ls -la',
    'def f(x: int = 0x1F) -> None:\n    """doc"""\n    return x',
    'a = 1_000.5e-3 + 2j',
    '@decorator(arg)\nclass C(Base): ...',
    'ünïcode = "∑"  # 中文注释',
    'values = [i ** 2 for i in range(10) if i % 2]',
  ]
  for (const source of corpus) {
    const rendered = renderCell(page, cellOf({ source }))
    const pre = findAll(rendered, 'pre').find((node) => node.props.className === 'dshj-source')
    assert.equal(textOf(pre), source, `tokenizing changed ${JSON.stringify(source)}`)
  }
})

console.log('\nlanguage, keyboard, and landmarks')

/** Render one cell through the panel's own path, with a view whose kernel decides the language. */
function renderCellIn(page, cell = cellOf(), options = {}) {
  const Notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cell], options.view ?? {})
  const tree = Notebook({ sessionId: 's-lang', t: (key) => key, ...(options.channel ?? {}) })
  const node = findComponent(tree, (props) => props.cell?.id === cell.id)
  assert.ok(node !== undefined, 'the cell element must appear in the panel tree')
  page.React.reset()
  return node.type({ ...node.props, ...(options.props ?? {}) })
}

/** Render a cell with its editor open, without going through the double-click. */
function renderEditing(page, options = {}) {
  const cell = options.cell ?? cellOf({ source: 'x = 1' })
  return renderCellIn(page, cell, {
    ...options,
    props: { editing: cell.id, draft: options.draft ?? cell.source, ...(options.props ?? {}) },
  })
}

/** The one textarea of an editing cell. */
function editorOf(tree) {
  const areas = findAll(tree, 'textarea')
  assert.equal(areas.length, 1, 'an editing cell has exactly one editor')
  return areas[0]
}

/** Press one key on an editor, with a cursor selection. */
function press(area, key, options = {}) {
  const prevented = []
  area.props.onKeyDown({
    key,
    shiftKey: options.shiftKey ?? false,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    altKey: false,
    isComposing: options.isComposing ?? false,
    preventDefault: () => prevented.push(key),
    target: { selectionStart: options.start ?? 0, selectionEnd: options.end ?? options.start ?? 0 },
  })
  return prevented
}

await check('an R kernel is coloured with R grammar, not with Python keywords', () => {
  const cell = cellOf({ source: 'f <- function(x) { if (x) TRUE else FALSE }  # note' })
  const rendered = renderCellIn(page, cell, { view: { kernel: { id: 'k1', name: 'ir', state: 'idle' } } })
  const pre = findAll(rendered, 'pre').find((node) => node.props.className === 'dshj-source')
  assert.equal(textOf(pre), cell.source, 'highlighting must not alter what the cell says')
  const spans = findAll(pre, 'span')
  const keywords = spans.filter((node) => node.props.className === 'dshj-t-kw').map(textOf)
  for (const word of ['function', 'if', 'else', 'TRUE', 'FALSE']) {
    assert.ok(keywords.includes(word), `R keyword ${word} missing from ${keywords.join('|')}`)
  }
  assert.ok(!keywords.includes('def'), 'Python keywords must not appear in an R cell')
  assert.deepEqual(spans.filter((node) => node.props.className === 'dshj-t-op' && textOf(node) === '<-').length, 1)
  assert.deepEqual(spans.filter((node) => node.props.className === 'dshj-t-com').map(textOf), ['# note'])
  assert.equal(textOf(flatten(rendered).find((node) => node.props?.className === 'dshj-kind')), 'R')
})

await check('a Julia kernel gets Julia comments, including the block form', () => {
  const cell = cellOf({ source: 'function area(r)\n  #= circle =#\n  r .^ 2\nend' })
  const rendered = renderCellIn(page, cell, { view: { kernel: { id: 'k2', name: 'julia-1.10', state: 'idle' } } })
  const pre = findAll(rendered, 'pre').find((node) => node.props.className === 'dshj-source')
  assert.equal(textOf(pre), cell.source)
  const spans = findAll(pre, 'span')
  assert.deepEqual(spans.filter((node) => node.props.className === 'dshj-t-com').map(textOf), ['#= circle =#'])
  const keywords = spans.filter((node) => node.props.className === 'dshj-t-kw').map(textOf)
  assert.deepEqual(keywords, ['function', 'end'])
  assert.equal(textOf(flatten(rendered).find((node) => node.props?.className === 'dshj-kind')), 'Jl')
})

await check('a kernel nobody wrote a tokenizer for is shown, not guessed at', () => {
  const source = 'def f(x: Int) = x + 1'
  const rendered = renderCellIn(page, cellOf({ source }), { view: { kernel: { id: 'k3', name: 'scala212', state: 'idle' } } })
  const pre = findAll(rendered, 'pre').find((node) => node.props.className === 'dshj-source')
  assert.equal(textOf(pre), source)
  assert.equal(findAll(pre, 'span').length, 0, 'an unknown language is rendered as plain text')
  assert.equal(textOf(flatten(rendered).find((node) => node.props?.className === 'dshj-kind')), '<>')
})

await check('Tab indents the line instead of leaving the editor', () => {
  const drafts = []
  const area = editorOf(renderEditing(page, { cell: cellOf({ source: 'x = 1' }), props: { onDraft: (value) => drafts.push(value) } }))
  const prevented = press(area, 'Tab', { start: 0 })
  assert.deepEqual(prevented, ['Tab'], 'the browser must not move focus')
  assert.deepEqual(drafts, ['  x = 1'])
})

await check('Shift+Tab outdents, one level at a time', () => {
  const drafts = []
  const area = editorOf(renderEditing(page, { cell: cellOf({ source: '    x = 1' }), props: { onDraft: (value) => drafts.push(value) } }))
  press(area, 'Tab', { shiftKey: true, start: 6 })
  assert.deepEqual(drafts, ['  x = 1'])
})

await check('a selection indents every line it touches', () => {
  const drafts = []
  const source = 'a = 1\nb = 2'
  const area = editorOf(renderEditing(page, { cell: cellOf({ source }), props: { onDraft: (value) => drafts.push(value) } }))
  press(area, 'Tab', { start: 0, end: source.length })
  assert.deepEqual(drafts, ['  a = 1\n  b = 2'])
})

await check('Enter carries the indentation, and opens one level after a colon', () => {
  const drafts = []
  const opener = editorOf(renderEditing(page, { cell: cellOf({ source: 'if x:' }), props: { onDraft: (value) => drafts.push(value) } }))
  press(opener, 'Enter', { start: 5 })
  const nested = editorOf(renderEditing(page, { cell: cellOf({ source: '    if x:' }), props: { onDraft: (value) => drafts.push(value) } }))
  press(nested, 'Enter', { start: 9 })
  const plain = editorOf(renderEditing(page, { cell: cellOf({ source: 'x = 1' }), props: { onDraft: (value) => drafts.push(value) } }))
  press(plain, 'Enter', { start: 5 })
  assert.deepEqual(drafts, ['if x:\n  ', '    if x:\n      ', 'x = 1\n'])
})

await check('prose does not open a block at a colon', () => {
  const drafts = []
  const area = editorOf(renderEditing(page, {
    cell: cellOf({ kind: 'markdown', source: 'Note:' }),
    draft: 'Note:',
    props: { onDraft: (value) => drafts.push(value) },
  }))
  press(area, 'Enter', { start: 5 })
  assert.deepEqual(drafts, ['Note:\n'], 'a markdown cell indents, it does not nest')
})

await check('Ctrl+Enter runs in place, Shift+Enter runs and leaves', () => {
  const runs = []
  const area = editorOf(renderEditing(page, { props: { onRun: (id, source, options) => runs.push({ id, source, options }) } }))
  press(area, 'Enter', { ctrlKey: true, start: 5 })
  press(area, 'Enter', { shiftKey: true, start: 5 })
  assert.deepEqual(runs.map((call) => call.id), ['c1', 'c1'])
  assert.equal(runs[0].options.keepEditing, true, 'Ctrl+Enter keeps the editor open')
  assert.equal(runs[1].options.keepEditing, false, 'Shift+Enter closes it')
})

await check('Ctrl+S saves without running or leaving', () => {
  const commits = []
  const runs = []
  const area = editorOf(renderEditing(page, {
    props: {
      onCommit: (id, source, options) => commits.push({ id, source, options }),
      onRun: () => runs.push(1),
    },
  }))
  press(area, 's', { ctrlKey: true })
  assert.equal(commits.length, 1)
  assert.equal(commits[0].source, 'x = 1')
  assert.equal(commits[0].options.keepEditing, true)
  assert.deepEqual(runs, [], 'saving must not run the cell')
})

await check('an IME owns the keyboard while it is composing', () => {
  const drafts = []
  const runs = []
  const area = editorOf(renderEditing(page, {
    props: { onDraft: (value) => drafts.push(value), onRun: () => runs.push(1) },
  }))
  press(area, 'Enter', { isComposing: true, start: 5 })
  press(area, 'Tab', { isComposing: true, start: 5 })
  assert.deepEqual(drafts, [])
  assert.deepEqual(runs, [])
})

await check('a cell is a labelled list item, and its output is a group', () => {
  const rendered = renderCell(page, cellOf({ outputs: [{ type: 'text', text: '1' }], error: 'boom' }))
  assert.equal(rendered.props.role, 'listitem')
  assert.equal(rendered.props['aria-label'], 'cellLabel 1')
  assert.equal(rendered.props.tabIndex, -1, 'focus can return to the cell that just closed')
  assert.equal(rendered.props['aria-busy'], 'false')
  const out = flatten(rendered).find((node) => node.props?.className === 'dshj-out')
  assert.equal(out.props.role, 'group')
  assert.equal(out.props['aria-label'], 'outputLabel')
  const banner = flatten(rendered).find((node) => node.props?.className === 'dshj-err')
  assert.equal(banner.props.role, 'alert')
  const running = renderCell(page, cellOf({ status: 'running' }))
  assert.equal(running.props['aria-busy'], 'true')
  const status = flatten(running).find((node) => node.props?.className === 'dshj-running')
  assert.equal(status.props.role, 'status', 'a screen reader should hear that the cell started')
})

await check('the panel announces itself and its list of cells', async () => {
  const fetchState = installFetch(viewOf([cellOf()], { revision: 140 }))
  try {
    const tree = panelTree({ sessionId: 's-a11y', t: (key) => key })
    const root = flatten(tree).find((node) => node.props?.className === 'dshj-root')
    assert.equal(root.props.role, 'region')
    assert.equal(root.props['aria-label'], 'title')
    const list = flatten(tree).find((node) => node.props?.className === 'dshj-cells')
    assert.equal(list.props.role, 'list')
  } finally {
    fetchState.restore()
  }
})

console.log('\nmarkdown and rich output')

await check('a markdown cell renders its markdown and offers Render instead of Run', () => {
  const rendered = renderCell(page, cellOf({ kind: 'markdown', source: '# Title\n\n**bold** text\n\n- one\n- two' }))
  // The harness leaves child components as elements; a markdown block is one, so call it.
  const markdown = flatten(rendered).find((node) => typeof node.type === 'function' && node.props?.source !== undefined)
  assert.ok(markdown !== undefined, 'the cell body must reach the Markdown component')
  const tree = markdown.type(markdown.props)
  assert.equal(findAll(tree, 'h1').length, 1, 'the heading must render as a heading')
  assert.equal(textOf(findAll(tree, 'strong')[0]), 'bold')
  assert.equal(findAll(tree, 'li').length, 2)
  const labels = findAll(rendered, 'button').map((node) => node.props.children)
  assert.ok(labels.includes('render'), `a markdown cell renders: ${labels.join(',')}`)
  assert.ok(!labels.includes('run'), 'it must not offer to run prose through the kernel')
  assert.equal(labels[0], 'MD', 'the kind chip must say what the cell is')
})
await check('a markdown cell edits as plain text rather than highlighted code', () => {
  const notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf({ kind: 'markdown', source: '# Title' })])
  page.slots[4] = 'c1'
  page.slots[5] = { main: { c1: '# Title' } }
  const node = findComponent(notebook({ sessionId: 's1', t: (key) => key }), (props) => props.cell?.id === 'c1')
  const rendered = node.type({ ...node.props, editing: 'c1', draft: '# Title' })
  assert.equal(findAll(rendered, 'pre').filter((node) => node.props.className === 'dshj-hl').length, 0)
  assert.equal(findAll(rendered, 'textarea').length, 1)
})
await check('a text/markdown output renders as markdown, tables included', () => {
  const rendered = renderCell(page, cellOf({
    outputs: [{ type: 'markdown', text: '## Result\n\n| a | b |\n| --- | --- |\n| 1 | 2 |' }],
  }))
  const block = renderOutputs(rendered).find((node) => typeof node.type === 'function' && node.props?.source !== undefined)
  assert.ok(block !== undefined, 'the markdown output must reach a Markdown component')
  const tree = block.type(block.props)
  assert.equal(findAll(tree, 'h2').length, 1)
  assert.equal(findAll(tree, 'table').length, 1)
  assert.equal(findAll(tree, 'td').length, 2)
})
await check('a fenced python block in markdown is highlighted too', () => {
  const rendered = renderCell(page, cellOf({ kind: 'markdown', source: '```python\nx = 1\n```' }))
  const markdown = flatten(rendered).find((node) => typeof node.type === 'function' && node.props?.source !== undefined)
  const tree = markdown.type(markdown.props)
  const code = findAll(tree, 'code')[0]
  assert.ok(code !== undefined, 'the fence must become a code block')
  assert.ok(findAll(code, 'span').some((node) => node.props.className === 'dshj-t-num'), 'its numbers must be coloured')
})
await check('a text/html output is mounted in its own shadow host', () => {
  const rendered = renderCell(page, cellOf({ outputs: [{ type: 'html', text: '<table><tr><td>1</td></tr></table>' }] }))
  const host = renderOutputs(rendered).find((node) => typeof node.type === 'function' && node.props?.html !== undefined)
  assert.ok(host !== undefined, 'html output must go through the sanitizing host')
  const div = host.type(host.props)
  assert.equal(div.type, 'div')
  assert.equal(div.props.className, 'dshj-html')
  assert.notEqual(div.props.ref, undefined, 'the host needs a ref to attach its shadow root to')
})
await check('the kind chip switches a cell between code and markdown', () => {
  const notebook = page.component('sidebar.right.pane.tab')
  page.React.reset()
  page.slots.length = 0
  page.slots[0] = viewOf([cellOf()])
  const node = findComponent(notebook({ sessionId: 's1', t: (key) => key }), (props) => props.cell?.id === 'c1')
  const seen = []
  const rendered = node.type({ ...node.props, onKind: (id, kind) => seen.push([id, kind]) })
  findAll(rendered, 'button').find((button) => button.props.children === 'Py').props.onClick()
  assert.deepEqual(seen, [['c1', 'markdown']])
})

console.log('\nentry point')

await check('the first mount opens the panel', () => {
  const fresh = loadBundle()
  fresh.React.reset()
  fresh.component('conversation.input.left')({ t: (key) => key, sidebarRight: fresh.ctx.sidebarRight })
  assert.deepEqual(fresh.opened, ['jupyter-notebook'])
})
await check('a later mount does not fight the user by reopening it', () => {
  const fresh = loadBundle()
  const Button = fresh.component('conversation.input.left')
  fresh.React.reset()
  Button({ t: (key) => key, sidebarRight: fresh.ctx.sidebarRight })
  fresh.React.reset()
  Button({ t: (key) => key, sidebarRight: fresh.ctx.sidebarRight })
  assert.deepEqual(fresh.opened, ['jupyter-notebook'], 'only the first mount may auto-open')
  const button = findAll(Button({ t: (key) => key, sidebarRight: fresh.ctx.sidebarRight }), 'button')[0]
  button.props.onClick()
  assert.deepEqual(fresh.opened, ['jupyter-notebook', 'jupyter-notebook'], 'clicking must still open it')
})
await check('a controller that rejects the first attempt does not crash the panel', () => {
  const fresh = loadBundle()
  let attempts = 0
  const sidebarRight = { openTab: () => { attempts += 1; if (attempts === 1) throw new Error('no session on screen') } }
  fresh.React.reset()
  fresh.component('conversation.input.left')({ t: (key) => key, sidebarRight })
  assert.equal(attempts, 1, 'the failed attempt is retried on a timer, not synchronously')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`\n${label}\n${error?.stack ?? error}`)
  process.exit(1)
}
process.exit(0)
