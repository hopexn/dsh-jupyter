/**
 * Tests for the panel-to-model context notes.
 *
 * Two things are covered: what a note says (a diff, an outcome, a deletion), and when it is handed
 * over (`agent/pre-step`, exactly once, never for a step that did not happen). Neither needs a
 * DSH host: the buffer is a plain object and the hook is a waterfall listener called directly.
 *
 *   node test/activity.mjs
 */

import assert from 'node:assert/strict'

import {
  NotebookActivity,
  boundSummary,
  messageForNotes,
  registerContextInjection,
} from '../lib/activity.js'

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

/** Record events for one session and take the notes they produce. */
function notesOf(events, session = 'session-a') {
  const activity = new NotebookActivity()
  for (const event of events) activity.record(session, event)
  return activity.drain(session)
}

/** A code-cell edit at index 1 (one-based: cell 2). */
const edit = {
  type: 'edit',
  index: 1,
  id: 'cell-b',
  kind: 'code',
  source: 'x = 2\ny = 3',
  before: { kind: 'code', source: 'x = 1\ny = 3' },
}

console.log('notes')

await check('an edit is quoted as the changed lines', async () => {
  const notes = notesOf([edit])
  assert.equal(notes.length, 1)
  assert.equal(notes[0].summary, 'Edited cell 2 (code)')
  assert.equal(notes[0].key, 'cell:cell-b')
  assert.match(notes[0].text, /The user edited cell 2 \(code\)/)
  assert.match(notes[0].text, /- x = 1/)
  assert.match(notes[0].text, /\+ x = 2/)
  assert.doesNotMatch(notes[0].text, /\+ y = 3/, 'unchanged lines are context, not additions')
})

await check('an edit that changes nothing says nothing', async () => {
  const activity = new NotebookActivity()
  activity.record('session-a', { ...edit, source: edit.before.source })
  assert.equal(activity.pending('session-a'), 0)
})

await check('switching a cell to markdown quotes the prose', async () => {
  const [note] = notesOf([{
    type: 'edit',
    index: 0,
    id: 'cell-a',
    kind: 'markdown',
    source: '# Findings\n\nAll good.',
    before: { kind: 'code', source: 'df.head()' },
  }])
  assert.equal(note.summary, 'Switched cell 1 to markdown')
  assert.match(note.text, /It now holds:/)
  assert.match(note.text, /# Findings/)
})

await check('a run start is replaced by its outcome', async () => {
  const activity = new NotebookActivity()
  const session = 'session-a'
  activity.record(session, { type: 'run-start', index: 0, id: 'cell-a', kind: 'code', source: '1/0' })
  assert.equal(activity.pending(session), 1)
  activity.record(session, {
    type: 'run-end',
    index: 0,
    id: 'cell-a',
    kind: 'code',
    source: '1/0',
    execution: {
      status: 'error',
      executionCount: 3,
      durationMs: 12,
      outputs: [{ type: 'error', text: 'Traceback (most recent call last):\nZeroDivisionError: division by zero' }],
    },
  })
  const notes = activity.drain(session)
  assert.equal(notes.length, 1, 'start and end share one key')
  assert.equal(notes[0].summary, 'Ran cell 1 (code): error')
  assert.match(notes[0].text, /as execution 3; it raised an error in 12 ms/)
  assert.match(notes[0].text, /ZeroDivisionError/)
  assert.doesNotMatch(notes[0].text, /still running/)
})

await check('a run that printed quotes the end of its output', async () => {
  const [note] = notesOf([{
    type: 'run-end',
    index: 0,
    id: 'cell-a',
    kind: 'code',
    source: 'print("done")',
    execution: {
      status: 'ok',
      executionCount: 4,
      durationMs: 1400,
      outputs: [{ type: 'stream', name: 'stdout', text: 'step 1\nstep 2\ndone\n' }],
    },
  }])
  assert.match(note.text, /it succeeded in 1\.4 s/)
  assert.match(note.text, /step 2\ndone/)
})

await check('a run with no kernel output falls back to the call message', async () => {
  const [note] = notesOf([{
    type: 'run-end',
    index: 0,
    id: 'cell-a',
    kind: 'code',
    source: 'import time; time.sleep(600)',
    execution: { status: 'timeout', message: 'interrupted after 180000 ms', outputs: [] },
  }])
  assert.match(note.text, /timed out and was interrupted/)
  assert.match(note.text, /interrupted after 180000 ms/)
})

await check('an image-only run says what was rendered', async () => {
  const [note] = notesOf([{
    type: 'run-end',
    index: 0,
    id: 'cell-a',
    kind: 'code',
    source: 'plt.plot([1, 2])',
    execution: { status: 'ok', executionCount: 5, durationMs: 30, outputs: [{ type: 'image', url: 'a.png' }] },
  }])
  assert.match(note.text, /\[also rendered: 1 image\]/)
})

await check('structural actions each get one line', async () => {
  const notes = notesOf([
    { type: 'add', index: 2, id: 'cell-c', kind: 'code', source: '' },
    { type: 'delete', index: 1, id: 'cell-b', kind: 'code', source: 'old = 1' },
    { type: 'clear', index: 0, id: 'cell-a', kind: 'code' },
    { type: 'clear-all', count: 2 },
  ])
  assert.deepEqual(notes.map((note) => note.summary), [
    'Added cell 3 (code)',
    'Deleted cell 2 (code)',
    'Cleared the output of cell 1 (code)',
    'Cleared all outputs',
  ])
  assert.match(notes[1].text, /old = 1/)
  assert.match(notes[3].text, /2 cells/)
})

await check('a reset drops the notes it invalidates', async () => {
  const activity = new NotebookActivity()
  const session = 'session-a'
  activity.record(session, edit)
  activity.record(session, { type: 'reset', count: 4 })
  const notes = activity.drain(session)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].summary, 'Reset the notebook')
  assert.match(notes[0].text, /4 cells and their outputs are gone/)
  assert.match(notes[0].text, /variables were not touched/)
})

await check('an import says the whole notebook changed, and points at the dropped items', async () => {
  const [note] = notesOf([{ type: 'import', count: 12, mode: 'replace', dropped: 2 }])
  assert.equal(note.summary, 'Imported a notebook')
  assert.equal(note.key, 'import')
  assert.match(note.text, /12 cells replaced the notebook/)
  assert.match(note.text, /2 item\(s\) could not be represented/)
  assert.match(note.text, /read the notebook again/)
  const [appended] = notesOf([{ type: 'import', count: 3, mode: 'append', dropped: 0 }])
  assert.equal(appended.summary, 'Appended a notebook')
  assert.match(appended.text, /3 cells appended to the notebook/)
  assert.doesNotMatch(appended.text, /could not be represented/)
})

await check('a rendered markdown cell is announced without touching the kernel', async () => {
  const [note] = notesOf([{ type: 'markdown', index: 4, id: 'cell-e', source: '# Findings' }])
  assert.equal(note.summary, 'Rendered markdown cell 5')
  assert.match(note.text, /does not touch the kernel/)
  assert.match(note.text, /# Findings/)
})

await check('a switch says the cell numbers in older notes now point elsewhere', async () => {
  const [note] = notesOf([{ type: 'switchNotebook', name: 'Untitled', count: 3 }])
  assert.equal(note.summary, 'Switched to “Untitled”')
  assert.equal(note.key, 'notebook-switch')
  assert.match(note.text, /switched the panel to the notebook "Untitled"/)
  assert.match(note.text, /It holds 3 cell\(s\)/)
  // The reason the note exists at all: every earlier note numbered cells in another notebook.
  assert.match(note.text, /read the notebook again before naming a cell by number/)
})

await check('a new notebook is announced as empty, with the old one still there', async () => {
  const [note] = notesOf([{ type: 'newNotebook', name: 'Untitled 2' }])
  assert.equal(note.summary, 'Started “Untitled 2”')
  assert.equal(note.key, 'notebook-new')
  assert.match(note.text, /new, empty notebook named "Untitled 2"/)
  assert.match(note.text, /previous notebook still exists/)
})

await check('deleting the last cell says the notebook kept an empty one', async () => {
  const [note] = notesOf([{ type: 'delete', index: 0, id: 'cell-a', kind: 'code', source: 'x = 1', replaced: true }])
  assert.match(note.text, /The notebook keeps one empty cell/)
})

await check('the buffer keeps the newest notes', async () => {
  const activity = new NotebookActivity()
  const session = 'session-a'
  for (let index = 0; index < 12; index += 1) {
    activity.record(session, {
      type: 'edit',
      index,
      id: `cell-${index}`,
      kind: 'code',
      source: `value = ${index + 2}`,
      before: { kind: 'code', source: `value = ${index + 1}` },
    })
  }
  assert.equal(activity.pending(session), 8, 'older notes are dropped, not the newest')
  const notes = activity.drain(session)
  assert.equal(notes[0].summary, 'Edited cell 5 (code)')
  assert.equal(notes[7].summary, 'Edited cell 12 (code)')
})

console.log('\nseveral servers')

const localServer = 'http://127.0.0.1:9002'
const remoteServer = 'http://aimax395.local:9003'

await check('a new connection is one note, and it never quotes the credential', async () => {
  const [note] = notesOf([{ type: 'connectServer', url: remoteServer, authMode: 'token', token: 'sekret-token' }])
  assert.equal(note.key, 'server')
  assert.equal(note.summary, `Connected to ${remoteServer} (token auth)`)
  assert.match(note.text, /connected the panel to the Jupyter server at http:\/\/aimax395\.local:9003/)
  assert.match(note.text, /token auth/)
  // The activity event carries no credential by design; this is the second line of defence.
  assert.doesNotMatch(note.text, /sekret-token/)
  assert.match(note.text, /stay connected/, 'connecting B must not read as disconnecting A')
  const [password] = notesOf([{ type: 'connectServer', url: remoteServer, authMode: 'password' }])
  assert.match(password.summary, /\(password auth\)$/)
  const [none] = notesOf([{ type: 'connectServer', url: localServer, authMode: 'none' }])
  assert.match(none.summary, /\(no authentication\)$/)
})

await check('rebinding the page says the kernel and its variables are not shared', async () => {
  const [note] = notesOf([{ type: 'bindServer', url: remoteServer }])
  assert.equal(note.key, 'server')
  assert.equal(note.summary, `Switched this notebook to ${remoteServer}`)
  assert.match(note.text, /bound the notebook on screen to the Jupyter server at http:\/\/aimax395\.local:9003/)
  assert.match(note.text, /different server means a different kernel/)
  assert.match(note.text, /variables, imports and open files .* are not shared/)
})

await check('a forgotten connection says its pages are not connected any more', async () => {
  const [note] = notesOf([{ type: 'forgetServer', url: localServer }])
  assert.equal(note.key, 'server')
  assert.equal(note.summary, `Disconnected from ${localServer}`)
  assert.match(note.text, /disconnected the panel from the Jupyter server at http:\/\/127\.0\.0\.1:9002/)
  assert.match(note.text, /no longer reachable/)
  assert.match(note.text, /not connected/)
})

await check('server notes use the name the user gave, keeping the address for precision', async () => {
  const [connected] = notesOf([{ type: 'connectServer', url: remoteServer, name: 'GPU box', authMode: 'password' }])
  assert.equal(connected.summary, 'Connected to GPU box (password auth)')
  assert.match(connected.text, /“GPU box” at http:\/\/aimax395\.local:9003/)
  const [bound] = notesOf([{ type: 'bindServer', url: remoteServer, name: 'GPU box' }])
  assert.equal(bound.summary, 'Switched this notebook to GPU box')
  assert.match(bound.text, /different server means a different kernel/)
  const [forgotten] = notesOf([{ type: 'forgetServer', url: remoteServer, name: 'GPU box' }])
  assert.equal(forgotten.summary, 'Disconnected from GPU box')
  assert.match(forgotten.text, /“GPU box” at http:\/\/aimax395\.local:9003/)
})

await check('the three server notes collapse into one, newest wins', async () => {
  const notes = notesOf([
    { type: 'connectServer', url: localServer, authMode: 'token' },
    { type: 'bindServer', url: remoteServer },
    { type: 'forgetServer', url: localServer },
  ])
  assert.equal(notes.length, 1, 'the connection list is one piece of state, so one note')
  assert.equal(notes[0].key, 'server')
  assert.equal(notes[0].summary, `Disconnected from ${localServer}`)
})

await check('a page switch mentions the server only when it changed', async () => {
  // Same server as the page that was open: the kernel is the same one, so saying anything is noise.
  const activity = new NotebookActivity()
  activity.record('session-a', { type: 'bindServer', url: localServer })
  activity.record('session-a', { type: 'switchNotebook', name: 'Untitled', count: 2, server: localServer })
  const [same] = activity.drain('session-a').filter((note) => note.key === 'notebook-switch')
  assert.ok(same !== undefined, 'the switch note itself is always sent')
  assert.doesNotMatch(same.text, /bound to the Jupyter server/)

  // A different server means a different kernel; the note has to say so, and name both sides.
  const [changed] = notesOf([
    { type: 'bindServer', url: localServer },
    { type: 'switchNotebook', name: 'Untitled', count: 2, server: remoteServer },
  ]).filter((note) => note.key === 'notebook-switch')
  assert.match(changed.text, /bound to the Jupyter server at http:\/\/aimax395\.local:9003/)
  assert.match(changed.text, /http:\/\/127\.0\.0\.1:9002, a different server/)
  assert.match(changed.text, /different kernel/)
  assert.match(changed.text, /variables and imports are not available here/)
})

await check('the host\'s own previousServer field is what a switch compares against', async () => {
  // The notebook model knows exactly which page it left, so it names both sides. That beats the
  // buffer's memory, and it is the shape the real host emits.
  const [changed] = notesOf([{
    type: 'switchNotebook',
    name: 'Untitled',
    count: 2,
    server: remoteServer,
    previousServer: localServer,
  }])
  assert.match(changed.text, new RegExp(`bound to the Jupyter server at ${remoteServer.replace(/\./g, '\\.')}`))
  assert.match(changed.text, new RegExp(`${localServer.replace(/\./g, '\\.')}, a different server`))

  const [same] = notesOf([{
    type: 'switchNotebook',
    name: 'Untitled',
    count: 2,
    server: localServer,
    previousServer: localServer,
  }])
  assert.doesNotMatch(same.text, /bound to the Jupyter server/)
})

await check('a new notebook names its server when it is not the previous page\'s', async () => {
  const [note] = notesOf([
    { type: 'bindServer', url: localServer },
    { type: 'newNotebook', name: 'Untitled 2', server: remoteServer },
  ]).filter((entry) => entry.key === 'notebook-new')
  assert.ok(note !== undefined)
  assert.match(note.text, /bound to the Jupyter server at http:\/\/aimax395\.local:9003/)
  assert.match(note.text, /different kernel/)
})

await check('the last page\'s server survives delivery, so the next switch compares against it', async () => {
  const activity = new NotebookActivity()
  activity.record('session-a', { type: 'bindServer', url: localServer })
  assert.equal(activity.drain('session-a').length, 1, 'the note was handed over')
  // Delivering notes must not erase where the panel points; otherwise this switch could not tell
  // that it is crossing a server boundary.
  activity.record('session-a', { type: 'switchNotebook', name: 'Untitled', count: 1, server: remoteServer })
  const [note] = activity.drain('session-a')
  assert.match(note.text, /a different server/)
  assert.match(note.text, /http:\/\/127\.0\.0\.1:9002/)
})

console.log('\nmessage')

await check('the message is attributed to the plugin, not to the user', async () => {
  const message = messageForNotes(notesOf([edit]))
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length >= 16)
  // Format v4 admits any nonempty producer-owned kind and refuses `'plugin'`; a plugin's kind is
  // its own name. The `form: 'notice'` is what makes the transcript read it as context.
  assert.deepEqual(message.source, {
    kind: 'jupyterlab',
    form: 'notice',
    summary: 'Edited cell 2 (code)',
  })
  assert.equal(message.content[0].type, 'text')
  assert.match(message.content[0].text, /Notebook panel activity since your previous step/)
  assert.match(message.content[0].text, /share one kernel/)
})

await check('a batch is numbered and its summary is bounded', async () => {
  const notes = notesOf([
    edit,
    { type: 'add', index: 0, id: 'cell-a', kind: 'code', source: '' },
    { type: 'clear-all', count: 3 },
  ])
  const message = messageForNotes(notes)
  assert.match(message.content[0].text, /\(3 actions\)/)
  assert.match(message.content[0].text, /1\. The user edited/)
  assert.match(message.content[0].text, /3\. The user cleared/)
  assert.ok(message.source.summary.length <= 120)
  assert.match(message.source.summary, /^3 notebook actions:/)
})

await check('summary text is collapsed and ellipsized', async () => {
  assert.equal(boundSummary('  a\n b  '), 'a b')
  const long = boundSummary('x'.repeat(200))
  assert.equal(long.length, 120)
  assert.ok(long.endsWith('…'))
})

await check('an empty batch produces no message', async () => {
  assert.equal(messageForNotes([]), undefined)
})

await check('queued notes can be listed without consuming them', async () => {
  const activity = new NotebookActivity()
  activity.record('session-a', edit)
  activity.record('session-a', { type: 'clear', index: 2, id: 'cell-c', kind: 'code' })
  const list = activity.list('session-a')
  assert.equal(list.length, 2)
  assert.equal(list[0].summary, 'Edited cell 2 (code)')
  assert.equal(typeof list[0].key, 'string')
  assert.equal(activity.pending('session-a'), 2, 'listing must not drain')
  assert.equal(activity.drain('session-a').length, 2)
  assert.deepEqual(activity.list('session-a'), [])
})

console.log('\npre-step delivery')

/** A plugin context that only records the listeners it is given. */
function captureContext() {
  const listeners = new Map()
  return {
    ctx: { on: (name, listener) => { listeners.set(name, listener) } },
    handlerFor: (name) => listeners.get(name),
  }
}

/** One pre-step call against a fake agent. */
async function step(handler, { sessionId = 'session-a', step: index = 2, aborted = false, decision } = {}) {
  const payload = {
    agent: { session: { header: { id: sessionId } } },
    step: index,
    signal: { aborted },
  }
  const base = decision ?? { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'why?' }] }] }
  return await handler(payload, async () => base)
}

await check('a pending note rides with the next step, once', async () => {
  const activity = new NotebookActivity()
  const { ctx, handlerFor } = captureContext()
  registerContextInjection(ctx, { activity })
  const handler = handlerFor('agent/pre-step')
  assert.equal(typeof handler, 'function', 'the hook must be registered')

  activity.record('session-a', edit)
  const first = await step(handler)
  assert.equal(first.messages.length, 2)
  assert.equal(first.messages[1].source.kind, 'jupyterlab', 'a producer-owned kind, never "plugin"')
  assert.equal(activity.pending('session-a'), 0)

  const second = await step(handler)
  assert.equal(second.messages.length, 1, 'the note is not repeated')
})

await check('a rejected step keeps its notes for later', async () => {
  const activity = new NotebookActivity()
  const { ctx, handlerFor } = captureContext()
  registerContextInjection(ctx, { activity })
  activity.record('session-a', edit)
  const decision = { kind: 'reject' }
  const result = await step(handlerFor('agent/pre-step'), { decision })
  assert.equal(result, decision, 'a rejection passes through untouched')
  assert.equal(activity.pending('session-a'), 1)
})

await check('an aborted step keeps its notes', async () => {
  const activity = new NotebookActivity()
  const { ctx, handlerFor } = captureContext()
  registerContextInjection(ctx, { activity })
  activity.record('session-a', edit)
  const result = await step(handlerFor('agent/pre-step'), { aborted: true })
  assert.equal(result.messages.length, 1)
  assert.equal(activity.pending('session-a'), 1)
})

await check('a first step with nothing to say is not turned into a model call', async () => {
  const activity = new NotebookActivity()
  const { ctx, handlerFor } = captureContext()
  registerContextInjection(ctx, { activity })
  activity.record('session-a', edit)
  const decision = { kind: 'enter', messages: [] }
  const result = await step(handlerFor('agent/pre-step'), { step: 1, decision })
  assert.equal(result.messages.length, 0)
  assert.equal(activity.pending('session-a'), 1)
})

await check('notes are scoped to their own session', async () => {
  const activity = new NotebookActivity()
  activity.record('session-a', edit)
  activity.record('session-b', { type: 'clear', index: 0, id: 'cell-z', kind: 'code' })
  assert.equal(activity.pending('session-a'), 1)
  assert.equal(activity.pending('session-b'), 1)
  assert.equal(activity.drain('session-a').length, 1)
  assert.equal(activity.pending('session-a'), 0)
  assert.equal(activity.pending('session-b'), 1)
})

await check('an agent without a session id is left alone', async () => {
  const activity = new NotebookActivity()
  const { ctx, handlerFor } = captureContext()
  registerContextInjection(ctx, { activity })
  activity.record('session-a', edit)
  const payload = { agent: { session: { header: {} } }, step: 2, signal: { aborted: false } }
  const result = await handlerFor('agent/pre-step')(payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(result.messages.length, 0)
  assert.equal(activity.pending('session-a'), 1)
})

await check('a decision without a messages array still gets the note', async () => {
  const activity = new NotebookActivity()
  const { ctx, handlerFor } = captureContext()
  registerContextInjection(ctx, { activity })
  activity.record('session-a', edit)
  const result = await step(handlerFor('agent/pre-step'), { decision: { kind: 'enter' } })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].source.kind, 'jupyterlab', 'a producer-owned kind, never "plugin"')
})

await check('the first note carries a map of the notebook, and later ones do not', async () => {
  const activity = new NotebookActivity()
  const { ctx, handlerFor } = captureContext()
  let revision = 7
  let maps = 0
  registerContextInjection(ctx, {
    activity,
    notebooks: {
      revision: () => revision,
      outline: () => { maps += 1; return 'The notebook holds:\n1. [code] x = 1' },
    },
  })
  const handler = handlerFor('agent/pre-step')

  activity.record('session-a', edit)
  const first = await step(handler)
  assert.match(first.messages.at(-1).content[0].text, /The notebook holds/)
  assert.match(first.messages.at(-1).content[0].text, /1\. \[code\] x = 1/)

  activity.record('session-a', edit)
  const second = await step(handler)
  assert.doesNotMatch(second.messages.at(-1).content[0].text, /The notebook holds/)
  assert.equal(maps, 1, 'the map is sent once, not on every batch')

  // A reset starts a new notebook at a lower revision; the model has never seen that one either.
  revision = 0
  activity.record('session-a', edit)
  const third = await step(handler)
  assert.match(third.messages.at(-1).content[0].text, /The notebook holds/)
  assert.equal(maps, 2)
})

await check('a broken outline still delivers the notes', async () => {
  const activity = new NotebookActivity()
  const { ctx, handlerFor } = captureContext()
  registerContextInjection(ctx, {
    activity,
    notebooks: { revision: () => 1, outline: () => { throw new Error('no notebook') } },
  })
  activity.record('session-a', edit)
  const result = await step(handlerFor('agent/pre-step'))
  assert.match(result.messages.at(-1).content[0].text, /edited cell 2/)
})

await check('a failing buffer never breaks the step', async () => {
  const { ctx, handlerFor } = captureContext()
  registerContextInjection(ctx, {
    activity: { drain: () => { throw new Error('buffer is broken') } },
  })
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [] }] }
  const result = await step(handlerFor('agent/pre-step'), { decision })
  assert.equal(result, decision)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`\n${label}\n${error?.stack ?? error}`)
  process.exit(1)
}
process.exit(0)
