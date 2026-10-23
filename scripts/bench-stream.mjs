/**
 * Measure a real kernel's streaming latency: how fast `runCell` answers, and when the first line
 * of output reaches a subscriber.
 *
 * Needs a running Jupyter server:
 *
 *   JUPYTER_URL=http://127.0.0.1:9003/lab JUPYTER_TOKEN=... node scripts/bench-stream.mjs
 *
 * It prints one line per streamed chunk with its arrival time, then the cell's final state.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { JupyterRuntime } from '../lib/runtime.js'
import { Notebooks } from '../lib/notebook.js'

const url = process.env.JUPYTER_URL ?? 'http://127.0.0.1:9003/lab'
const token = process.env.JUPYTER_TOKEN
const password = process.env.JUPYTER_PASSWORD

const runtime = new JupyterRuntime({ url, token, password })
const notebooks = new Notebooks({
  execute: (sessionId, code, options) => runtime.execute(sessionId, code, options),
  kernelInfo: (sessionId) => runtime.sessionKernel(sessionId),
  directory: mkdtempSync(path.join(tmpdir(), 'dsh-bench-notebooks-')),
})

const sessionId = `bench-stream-${process.pid}`
const cell = (await notebooks.view(sessionId)).cells[0]
const started = performance.now()
const events = []
const stop = notebooks.subscribe(sessionId, (event) => {
  events.push({
    at: Math.round(performance.now() - started),
    type: event.type,
    detail: event.text ?? event.cell?.status ?? '',
  })
})

const code = ['import time', 'for i in range(5):', '    print(i, flush=True)', '    time.sleep(0.6)', '"done"'].join('\n')
await notebooks.command(sessionId, { action: 'runCell', id: cell.id, source: code })
const answered = Math.round(performance.now() - started)
console.log(`runCell answered after ${answered} ms (still running: ${notebooks.isRunning(sessionId)})`)

await notebooks.idle(sessionId)
stop()
const total = Math.round(performance.now() - started)
for (const event of events) {
  console.log(`${String(event.at).padStart(6)} ms  ${event.type.padEnd(6)} ${JSON.stringify(event.detail).slice(0, 70)}`)
}

const streamed = events.filter((event) => event.type === 'text')
const final = (await notebooks.view(sessionId)).cells[0]
console.log(`\n${streamed.length} chunk(s) over ${total} ms; first at ${streamed[0]?.at ?? '—'} ms; status=${final.status}`)
console.log(`outputs: ${JSON.stringify(final.outputs)}`)

notebooks.dispose()
runtime.dispose()
process.exit(0)
