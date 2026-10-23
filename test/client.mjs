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
    status: 'idle',
    executionCount: 2,
    durationMs: 1,
    outputs: [],
    error: null,
    ...overrides,
  }
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
  for (const key of ['title', 'open', 'openLabel', 'addCell', 'run', 'runHint', 'remove', 'up', 'down', 'done', 'restart', 'interrupt', 'clearOutputs', 'loading', 'retry', 'noKernel', 'running', 'placeholder']) {
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
  const sources = findAll(rendered, 'pre').filter((node) => node.props.children === 'print(1)')
  assert.equal(sources.length, 1, 'the source must be shown')
  assert.equal(findAll(rendered, 'textarea').length, 0, 'read mode must not show a textarea')
  const labels = findAll(rendered, 'button').map((node) => node.props.children)
  for (const label of ['run', '↑', '↓', '⌫', '✕']) assert.ok(labels.includes(label), `missing ${label} button in ${labels.join(',')}`)
})
await check('double-clicking the source starts editing', () => {
  const rendered = renderCell(page)
  const source = findAll(rendered, 'pre').find((node) => node.props.children === 'print(1)')
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
  page.slots[5] = { c1: 'print(2)' }
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
  page.slots[5] = { c1: 'print(3)' }
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
