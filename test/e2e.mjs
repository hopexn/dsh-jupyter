/**
 * End-to-end test of the runtime against a real Jupyter server.
 *
 * Runs on plain Node (no DSH runtime needed) and exercises the parts that actually talk to
 * Jupyter: URL normalization, authentication, kernel start/re-attach, execution, output
 * normalization, artifact persistence, interrupt-on-timeout, and kernel management.
 *
 *   node test/e2e.mjs
 *
 * Environment:
 *   JUPYTER_TEST_URL    default http://127.0.0.1:9003/lab
 *   JUPYTER_TEST_TOKEN  default dsh-test-token
 *   JUPYTER_TEST_PASSWORD  set to exercise the password/login flow instead of a token
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { collectArtifacts, summarizeOutputs } from '../lib/kernel.js'
import { JupyterRuntime } from '../lib/runtime.js'
import { JupyterError, normalizeJupyterUrl } from '../lib/server.js'

const URL_UNDER_TEST = process.env.JUPYTER_TEST_URL ?? 'http://127.0.0.1:9003/lab'
// Only fall back to the local throwaway token when the address does not already carry one;
// otherwise the default would override the credential under test.
const TOKEN = process.env.JUPYTER_TEST_PASSWORD !== undefined
  ? undefined
  : process.env.JUPYTER_TEST_TOKEN ?? (URL_UNDER_TEST.includes('token=') ? undefined : 'dsh-test-token')
const PASSWORD = process.env.JUPYTER_TEST_PASSWORD

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

console.log(`Jupyter connector end-to-end test\n  server: ${URL_UNDER_TEST}\n  auth:   ${PASSWORD === undefined ? 'token' : 'password'}\n`)

console.log('url normalization')
await check('bare origin is unchanged', () => {
  assert.equal(normalizeJupyterUrl('http://host:9002').baseUrl, 'http://host:9002')
})
await check('/lab is stripped', () => {
  assert.equal(normalizeJupyterUrl('http://host:9002/lab').baseUrl, 'http://host:9002')
})
await check('/lab/tree/... is stripped, keeping a base path', () => {
  assert.equal(normalizeJupyterUrl('http://host/jupyter/lab/tree/x.ipynb').baseUrl, 'http://host/jupyter')
})
await check('a ?token= is recovered and removed from the path', () => {
  const result = normalizeJupyterUrl('http://host:9002/lab?token=abc123')
  assert.equal(result.baseUrl, 'http://host:9002')
  assert.equal(result.token, 'abc123')
})
await check('a scheme-less address is accepted', () => {
  assert.equal(normalizeJupyterUrl('host:9002/lab').baseUrl, 'http://host:9002')
})
await check('nonsense is rejected as an invalid URL', () => {
  assert.throws(() => normalizeJupyterUrl('not a url'), (error) => error instanceof JupyterError && error.code === 'JUPYTER_INVALID_URL')
})

const stateDirectory = mkdtempSync(path.join(tmpdir(), 'dsh-jupyter-e2e-'))
const runtime = new JupyterRuntime({
  url: URL_UNDER_TEST,
  token: TOKEN,
  password: PASSWORD,
  artifactDirectory: stateDirectory,
  executeTimeoutMs: 60000,
})

console.log('\nconnection')
await check('an unconfigured runtime reports how to connect', async () => {
  const empty = new JupyterRuntime({})
  assert.throws(() => empty.client(), (error) => error instanceof JupyterError && error.code === 'JUPYTER_NOT_CONFIGURED')
})
await check('probe returns the version, kernelspecs and kernels', async () => {
  const probe = await runtime.probe()
  assert.ok(probe.kernelspecs.includes('python3'), `expected python3 in ${JSON.stringify(probe.kernelspecs)}`)
  assert.ok(Array.isArray(probe.kernels))
  assert.equal(probe.url, normalizeJupyterUrl(URL_UNDER_TEST).baseUrl)
})
await check('bad credentials produce an authentication error', async () => {
  const wrong = new JupyterRuntime({ url: URL_UNDER_TEST, token: 'definitely-wrong', requestTimeoutMs: 10000 })
  await assert.rejects(() => wrong.probe(), (error) => error instanceof JupyterError && error.code === 'JUPYTER_AUTH_FAILED')
})
// Deliberately unrelated to the server under test: the rule must hold regardless of which
// server this suite happens to run against.
const FIRST_SERVER = 'http://first.invalid:9000/lab'
const SECOND_SERVER = 'http://second.invalid:9000/lab'
await check('a credential is never carried across to a different server', () => {
  const switching = new JupyterRuntime({ url: FIRST_SERVER, token: 'secret-token', password: 'secret-password' })
  assert.equal(switching.settings.token, 'secret-token')
  // Same server reached through a different UI path: the credentials stay.
  switching.configure({ url: 'http://first.invalid:9000/tree', kernelName: 'python3' })
  assert.equal(switching.settings.token, 'secret-token')
  assert.equal(switching.settings.password, 'secret-password')
  // Different host: the credentials must be dropped rather than disclosed to it.
  switching.configure({ url: SECOND_SERVER })
  assert.equal(switching.settings.token, undefined)
  assert.equal(switching.settings.password, undefined)
  assert.equal(switching.settings.url, SECOND_SERVER)
})
await check('supplying a credential with the new address keeps it', () => {
  const switching = new JupyterRuntime({ url: FIRST_SERVER, token: 'old-token' })
  switching.configure({ url: SECOND_SERVER, token: 'new-token' })
  assert.equal(switching.settings.token, 'new-token')
})
await check('a password session is exercised end to end when one is configured', async () => {
  if (PASSWORD === undefined) return // token mode: the login flow is covered by the local suite
  const session = 'e2e-password-session'
  const result = await runtime.execute(session, 'print("password session works")')
  assert.equal(result.status, 'ok', result.message ?? '')
  assert.equal(summarizeOutputs(result.outputs).stdout, 'password session works\n')
  await runtime.kernelAction(session, 'shutdown')
})
await check('an unreachable host produces an unreachable error', async () => {
  const dead = new JupyterRuntime({ url: 'http://127.0.0.1:9/lab', token: 'x', requestTimeoutMs: 3000 })
  await assert.rejects(() => dead.probe(), (error) => error instanceof JupyterError && error.code === 'JUPYTER_UNREACHABLE')
})

console.log('\nexecution')
const session = 'e2e-session'
let firstKernel
await check('first execution starts a kernel and returns stdout plus the final value', async () => {
  const result = await runtime.execute(session, 'x = 41\nprint("hello from the kernel")\nx')
  firstKernel = result.kernelId
  assert.equal(result.status, 'ok', result.message ?? '')
  const summary = summarizeOutputs(result.outputs)
  assert.equal(summary.stdout, 'hello from the kernel\n')
  assert.equal(summary.result, '41')
  assert.equal(typeof result.executionCount, 'number')
})
await check('state persists across calls on the same kernel', async () => {
  const result = await runtime.execute(session, 'print("x is", x + 1)')
  assert.equal(result.kernelId, firstKernel, 'a new kernel was silently started')
  assert.equal(summarizeOutputs(result.outputs).stdout, 'x is 42\n')
})
await check('a traceback comes back as an error with the kernel still alive', async () => {
  const result = await runtime.execute(session, 'raise ValueError("boom")')
  assert.equal(result.status, 'error')
  const summary = summarizeOutputs(result.outputs)
  assert.match(summary.error ?? '', /ValueError: boom/)
  const after = await runtime.execute(session, 'print("still here")')
  assert.equal(after.status, 'ok')
  assert.equal(summarizeOutputs(after.outputs).stdout, 'still here\n')
})
await check('stderr is separated from stdout', async () => {
  const result = await runtime.execute(session, 'import sys\nprint("to stderr", file=sys.stderr)\nprint("to stdout")')
  const summary = summarizeOutputs(result.outputs)
  assert.equal(summary.stdout, 'to stdout\n')
  assert.equal(summary.stderr, 'to stderr\n')
})
await check('rich outputs are saved as artifacts', async () => {
  const result = await runtime.execute(session, [
    'from IPython.display import display',
    'png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="',
    'display({"image/png": png}, raw=True)',
  ].join('\n'))
  assert.equal(result.status, 'ok', result.message ?? '')
  const files = collectArtifacts(result.outputs, {
    directory: stateDirectory,
    prefix: 'test',
    writeFile: (file, payload, encoding) => writeFileSync(file, payload, encoding),
  })
  assert.equal(files.length, 1, `expected one artifact, got ${JSON.stringify(files)}`)
  assert.ok(existsSync(files[0]), 'artifact file missing')
  assert.ok(readFileSync(files[0]).length > 0, 'artifact file empty')
})
await check('a long-running cell is interrupted at the timeout', async () => {
  const started = Date.now()
  const result = await runtime.execute(session, 'import time\nprint("starting")\ntime.sleep(60)\nprint("never")', { timeoutMs: 2000 })
  const elapsed = Date.now() - started
  assert.equal(result.status, 'timeout')
  assert.ok(elapsed < 20000, `interrupt took ${elapsed}ms`)
  assert.match(summarizeOutputs(result.outputs).stdout, /starting/)
})
await check('the kernel survives an interrupt', async () => {
  const result = await runtime.execute(session, 'print("recovered")')
  assert.equal(result.status, 'ok', result.message ?? '')
  assert.equal(summarizeOutputs(result.outputs).stdout, 'recovered\n')
})

console.log('\nkernel management')
await check('list reports the running kernel', async () => {
  const outcome = await runtime.kernelAction(session, 'list')
  assert.ok(outcome.kernels.some((kernel) => kernel.id === firstKernel), JSON.stringify(outcome.kernels))
  assert.ok(outcome.kernelspecs.includes('python3'))
})
await check('restart keeps the id but clears the state', async () => {
  const outcome = await runtime.kernelAction(session, 'restart')
  assert.equal(outcome.kernelId, firstKernel)
  const result = await runtime.execute(session, 'print(x)')
  assert.equal(result.status, 'error')
  assert.match(summarizeOutputs(result.outputs).error ?? '', /NameError/)
})
await check('shutdown stops the kernel, and the next execution starts a new one', async () => {
  const outcome = await runtime.kernelAction(session, 'shutdown')
  assert.equal(outcome.kernelId, firstKernel)
  const listed = await runtime.kernelAction(session, 'list')
  assert.ok(!listed.kernels.some((kernel) => kernel.id === firstKernel), 'kernel still listed after shutdown')
  const result = await runtime.execute(session, 'print("fresh")')
  assert.equal(result.status, 'ok', result.message ?? '')
  assert.notEqual(result.kernelId, firstKernel)
})
await check('attach binds the session to an existing kernel', async () => {
  const started = await runtime.kernelAction(session, 'start')
  const other = new JupyterRuntime({ url: URL_UNDER_TEST, token: TOKEN, password: PASSWORD })
  await other.kernelAction('other-session', 'attach', { kernelId: started.kernelId })
  const seeded = await other.execute('other-session', 'marker = "shared"')
  assert.equal(seeded.status, 'ok', seeded.message ?? '')
  const outcome = await runtime.kernelAction(session, 'attach', { kernelId: started.kernelId })
  assert.equal(outcome.kernelId, started.kernelId)
  const result = await runtime.execute(session, 'print(marker)')
  assert.equal(summarizeOutputs(result.outputs).stdout, 'shared\n')
  other.dispose()
})
await check('an unknown action is rejected with the valid list', async () => {
  await assert.rejects(() => runtime.kernelAction(session, 'explode'), /unknown kernel action/)
})
await check('attaching to a missing kernel fails clearly', async () => {
  await assert.rejects(
    () => runtime.kernelAction(session, 'attach', { kernelId: '00000000-0000-0000-0000-000000000000' }),
    /does not exist/,
  )
})

await check('session kernels are cleaned up', async () => {
  await runtime.kernelAction(session, 'shutdown')
})

runtime.dispose()
rmSync(stateDirectory, { recursive: true, force: true })

// A disposed runtime must not leave kernel channels open behind it: this plugin lives in a
// long-running host process, and a forgotten channel would keep a remote kernel attached forever.
// (Sockets held by the global fetch agent's keep-alive pool are expected and drain on their own.)
await new Promise((resolve) => setTimeout(resolve, 5000))
const lingering = process.getActiveResourcesInfo().filter((kind) => kind !== 'Timeout')
await check('no kernel channel outlives the runtime', () => {
  assert.equal(runtime.openChannelCount, 0, 'the runtime still holds an open kernel channel')
})
await check('no sockets outlive the runtime', () => {
  assert.deepEqual(lingering, [], `still active: ${lingering.join(', ')}`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`\n${label}\n${error?.stack ?? error}`)
  process.exit(1)
}
