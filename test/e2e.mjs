/**
 * End-to-end test of the runtime against a real Jupyter server.
 *
 * Runs on plain Node (no DSH runtime needed) and exercises the parts that actually talk to
 * Jupyter: URL normalization, authentication, kernel start/re-attach, execution, output
 * normalization, artifact persistence, interrupt-on-timeout, kernel management — and, since a
 * session may hold several connections at once, a second server key against the same live server
 * (a `localhost` vs `127.0.0.1` spelling) proving that kernels, bindings, `servers.json` and the
 * describe list stay per-connection.
 *
 *   node test/e2e.mjs
 *
 * Environment:
 *   JUPYTER_TEST_URL       default http://127.0.0.1:9003/lab
 *   JUPYTER_TEST_TOKEN     default dsh-test-token
 *   JUPYTER_TEST_PASSWORD  set to exercise the password/login flow instead of a token
 *   JUPYTER_TEST_URL_2     optional second connection; defaults to the `localhost` spelling of
 *                          JUPYTER_TEST_URL (the same server reached through another name)
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { collectArtifacts, summarizeOutputs } from '../lib/kernel.js'
import { JupyterRuntime } from '../lib/runtime.js'
import { ServerLink, serverLabel, serverKey } from '../lib/connections.js'
import { JupyterError, JupyterServerClient, normalizeJupyterUrl } from '../lib/server.js'

const URL_UNDER_TEST = process.env.JUPYTER_TEST_URL ?? 'http://127.0.0.1:9003/lab'
// Only fall back to the local throwaway token when the address does not already carry one;
// otherwise the default would override the credential under test.
const EMBEDDED_TOKEN = normalizeJupyterUrl(URL_UNDER_TEST).token
const TOKEN = process.env.JUPYTER_TEST_PASSWORD !== undefined
  ? undefined
  : process.env.JUPYTER_TEST_TOKEN ?? (URL_UNDER_TEST.includes('token=') ? undefined : 'dsh-test-token')
const PASSWORD = process.env.JUPYTER_TEST_PASSWORD

const FIRST_KEY = serverKey(URL_UNDER_TEST)
const SECOND_URL = process.env.JUPYTER_TEST_URL_2 ?? alternateSpelling(URL_UNDER_TEST)
const SECOND_KEY = SECOND_URL === undefined ? undefined : serverKey(SECOND_URL)
const SECOND_TOKEN = process.env.JUPYTER_TEST_TOKEN_2 ?? TOKEN ?? EMBEDDED_TOKEN
const SECOND_PASSWORD = process.env.JUPYTER_TEST_PASSWORD_2 ?? PASSWORD

/**
 * The same live server reached through its other loopback name.
 *
 * Two spellings are two registry keys, so this proves the multi-connection bookkeeping without
 * needing a second deployment — while still running real kernels over real sockets.
 *
 * @param url - Configured Jupyter address.
 * @returns The alternate spelling, or undefined when the host has no loopback alias.
 */
function alternateSpelling(url) {
  try {
    const parsed = new URL(normalizeJupyterUrl(url).baseUrl)
    const alternate = parsed.hostname === '127.0.0.1'
      ? 'localhost'
      : parsed.hostname === 'localhost' ? '127.0.0.1' : undefined
    if (alternate === undefined) return undefined
    parsed.hostname = alternate
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

// Keep every mirror — kernels.json *and* the new servers.json — out of the developer's real
// `~/.dsh`: a test run must not add connections or rebind kernels in the app they are using.
const stateDirectory = mkdtempSync(path.join(tmpdir(), 'dsh-jupyter-e2e-'))
const homeDirectory = path.join(stateDirectory, 'home')
process.env.DSH_HOME = homeDirectory
const kernelsFile = () => path.join(homeDirectory, 'jupyterlab', 'kernels.json')
const serversFile = () => path.join(homeDirectory, 'jupyterlab', 'servers.json')

/** The mirrored kernel bindings, or an empty object when the mirror was never written. */
function readKernels() {
  try {
    return JSON.parse(readFileSync(kernelsFile(), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

/** Credentials for a throwaway runtime pointed at one of the two test servers. */
function credentialFields(url) {
  const fields = {}
  if (url === SECOND_URL) {
    if (SECOND_PASSWORD !== undefined) fields.password = SECOND_PASSWORD
    else if (SECOND_TOKEN !== undefined) fields.token = SECOND_TOKEN
    return fields
  }
  if (PASSWORD !== undefined) fields.password = PASSWORD
  else if (TOKEN !== undefined) fields.token = TOKEN
  return fields
}

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

const runtime = new JupyterRuntime({
  url: URL_UNDER_TEST,
  token: TOKEN,
  password: PASSWORD,
  artifactDirectory: stateDirectory,
  executeTimeoutMs: 60000,
})

console.log('\nconnection')
await check('a server label drops the scheme and the UI path', () => {
  assert.equal(serverLabel('http://host:9002/lab/tree/x.ipynb'), 'host:9002')
  assert.equal(serverLabel('https://host/jupyter/lab'), 'host/jupyter')
  assert.equal(serverKey('http://host:9002/lab?token=abc'), 'http://host:9002')
})
await check('a connection without credentials still describes itself', () => {
  const link = new ServerLink({ url: 'http://credential-less.invalid:9000/lab' })
  const description = link.describe()
  assert.equal(description.authMode, 'none')
  assert.equal(description.hasCredentials, false)
  assert.equal(description.label, 'credential-less.invalid:9000')
  // The failure belongs to the client, not the description: the panel may list a half-configured
  // connection and report it as unauthenticated instead of having the list itself throw.
  assert.throws(() => link.client(), (error) => error instanceof JupyterError && error.code === 'JUPYTER_AUTH_FAILED')
  link.dispose()
})
await check('an unconfigured runtime reports how to connect', async () => {
  const empty = new JupyterRuntime({})
  assert.throws(() => empty.client(), (error) => error instanceof JupyterError && error.code === 'JUPYTER_NOT_CONFIGURED')
})
await check('probe returns the version, kernelspecs and kernels', async () => {
  const probe = await runtime.probe()
  assert.ok(probe.kernelspecs.includes('python3'), `expected python3 in ${JSON.stringify(probe.kernelspecs)}`)
  assert.ok(Array.isArray(probe.kernels))
  assert.equal(probe.url, normalizeJupyterUrl(URL_UNDER_TEST).baseUrl)
  assert.equal(probe.key, normalizeJupyterUrl(URL_UNDER_TEST).baseUrl)
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
  switching.dispose()
})
await check('supplying a credential with the new address keeps it', () => {
  const switching = new JupyterRuntime({ url: FIRST_SERVER, token: 'old-token' })
  switching.configure({ url: SECOND_SERVER, token: 'new-token' })
  assert.equal(switching.settings.token, 'new-token')
  switching.dispose()
})
await check('a connection description never carries a credential', () => {
  // A describe entry is what travels to the browser; a credential in it would be a token on the
  // wire. The password case has no readable representation at all, so only presence is checked.
  const link = new ServerLink({ url: 'http://hidden.invalid:9000', token: 'describe-secret', password: 'describe-password' })
  const description = JSON.stringify(link.describe())
  assert.ok(!description.includes('describe-secret'), 'a token reached describe()')
  assert.ok(!description.includes('describe-password'), 'a password reached describe()')
  assert.equal(link.authMode, 'token')
  const panelVisible = JSON.stringify(runtime.servers())
  if (TOKEN !== undefined) assert.ok(!panelVisible.includes(TOKEN), 'a token reached the panel describe list')
  if (PASSWORD !== undefined) assert.ok(!panelVisible.includes(PASSWORD), 'a password reached the panel describe list')
  link.dispose()
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
  dead.dispose()
})

console.log('\nexecution')
const session = 'e2e-session'
let firstKernel
await check('first execution starts a kernel and returns stdout plus the final value', async () => {
  const result = await runtime.execute(session, 'x = 41\nprint("hello from the kernel")\nx')
  firstKernel = result.kernelId
  assert.equal(result.status, 'ok', result.message ?? '')
  assert.equal(result.server, FIRST_KEY)
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

console.log('\nproxy cookie (SSO / access proxy)')
await check('a pasted cookie rides along with token/password auth', async () => {
  // A deployment behind an SSO gateway wants *both*: the gateway's cookie and Jupyter's own
  // credential. The server ignores an unknown cookie, so the proof here is that nothing breaks.
  const client = new JupyterServerClient({
    url: URL_UNDER_TEST,
    token: TOKEN,
    password: PASSWORD,
    cookie: 'accessproxy_session=opaque-session; apdid=device',
  })
  const status = await client.status()
  assert.equal(typeof status, 'object', 'a proxied client could not read /api/status')
  const specs = await client.kernelspecs()
  assert.ok(Array.isArray(specs), 'a proxied client could not read kernelspecs')
})
await check('cookie-only auth reports the server\'s rejection instead of "no credentials"', async () => {
  // The cookie authenticated the proxy, not Jupyter; on a token/password-protected server the
  // request reaches Jupyter and is rejected — which must read as an auth failure, not as a
  // configuration mistake in the plugin.
  const client = new JupyterServerClient({ url: URL_UNDER_TEST, cookie: 'accessproxy_session=opaque' })
  assert.equal(client.authMode, 'cookie')
  await assert.rejects(
    () => client.status(),
    (error) => error instanceof JupyterError
      && error.code === 'JUPYTER_AUTH_FAILED'
      && /authentication failed/.test(error.message),
  )
})
await check('a cookie-authenticated connection is described without its cookie', () => {
  const cookieRuntime = new JupyterRuntime({ url: URL_UNDER_TEST, cookie: 'accessproxy_session=opaque' })
  try {
    const described = cookieRuntime.servers()
    // The mirror may still hold a run-time added connection from an earlier check; the configured
    // one is what this test is about.
    const entry = described.find((item) => item.key === FIRST_KEY)
    assert.notEqual(entry, undefined, 'the configured server is missing from the describe list')
    assert.equal(entry.authMode, 'cookie')
    assert.equal(entry.hasCredentials, true)
    assert.equal(JSON.stringify(described).includes('opaque'), false, 'the cookie leaked into describe()')
  } finally {
    cookieRuntime.dispose()
  }
})

await check('a proxy cookie is persisted like any other credential, and never described', async () => {
  const saved = process.env.DSH_HOME
  const isolated = mkdtempSync(path.join(tmpdir(), 'dsh-jupyter-cookie-'))
  process.env.DSH_HOME = isolated
  try {
    const proxied = new JupyterRuntime({})
    try {
      proxied.addServer({ url: 'http://proxied.invalid:9010/lab', cookie: 'accessproxy_session=opaque-secret' })
    } finally {
      proxied.dispose()
    }
    const file = path.join(isolated, 'jupyterlab', 'servers.json')
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(persisted.servers.length, 1)
    assert.equal(persisted.servers[0].url, 'http://proxied.invalid:9010')
    // The cookie is a credential: persisted (0600, like the rest), so a restart does not ask the
    // user to copy a browser header again. Its expiry is reported by the server, not by us.
    assert.equal(persisted.servers[0].cookie, 'accessproxy_session=opaque-secret')
    const restarted = new JupyterRuntime({})
    try {
      const entry = restarted.servers().find((item) => item.key === 'http://proxied.invalid:9010')
      assert.notEqual(entry, undefined)
      assert.equal(entry.authMode, 'cookie')
      assert.equal(JSON.stringify(restarted.servers()).includes('opaque-secret'), false, 'the describe list leaked the cookie')
      assert.equal(restarted.settingsFor('http://proxied.invalid:9010').cookie, 'accessproxy_session=opaque-secret',
        'the persisted cookie did not come back on the host side')
    } finally {
      restarted.dispose()
    }
  } finally {
    process.env.DSH_HOME = saved
    rmSync(isolated, { recursive: true, force: true })
  }
})

await check('a server name travels with the connection and is never mistaken for a credential', async () => {
  const named = new JupyterRuntime({ url: URL_UNDER_TEST, name: 'local box', token: TOKEN, password: PASSWORD })
  try {
    const entry = named.servers().find((server) => server.key === FIRST_KEY)
    assert.notEqual(entry, undefined)
    assert.equal(entry.name, 'local box')
    assert.equal(entry.hasCredentials, true)
    const secrets = [TOKEN, PASSWORD].filter((value) => typeof value === 'string' && value.length > 0)
    for (const secret of secrets) {
      assert.equal(JSON.stringify(named.servers()).includes(secret), false, 'the describe list leaked a credential')
    }
  } finally {
    named.dispose()
  }
})
await check('a connection name survives a restart', () => {
  const saved = process.env.DSH_HOME
  const isolated = mkdtempSync(path.join(tmpdir(), 'dsh-jupyter-name-'))
  process.env.DSH_HOME = isolated
  try {
    const named = new JupyterRuntime({})
    try {
      named.addServer({ url: 'http://named.invalid:9012/lab', name: 'GPU box' })
    } finally {
      named.dispose()
    }
    const file = path.join(isolated, 'jupyterlab', 'servers.json')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).servers[0].name, 'GPU box')
    const restarted = new JupyterRuntime({})
    try {
      assert.equal(restarted.servers().find((entry) => entry.key === 'http://named.invalid:9012')?.name, 'GPU box')
    } finally {
      restarted.dispose()
    }
  } finally {
    process.env.DSH_HOME = saved
    rmSync(isolated, { recursive: true, force: true })
  }
})

console.log('\nmultiple connections')
/** Kernel ids started on the second connection, so they can be shut down after its removal. */
const secondServerKernels = []

await check('a second connection is added without moving the default', async () => {
  if (SECOND_URL === undefined) {
    console.log('      (no second spelling for this host and no JUPYTER_TEST_URL_2 — skipped)')
    return
  }
  const link = runtime.addServer({ url: SECOND_URL, ...credentialFields(SECOND_URL) })
  assert.equal(link.key, SECOND_KEY)
  const described = runtime.servers()
  assert.deepEqual(described.map((entry) => entry.key).sort(), [FIRST_KEY, SECOND_KEY].sort())
  assert.equal(runtime.defaultServer(), FIRST_KEY, 'adding a connection must not move the default')
  assert.equal(described.find((entry) => entry.key === FIRST_KEY)?.default, true)
  assert.equal(described.find((entry) => entry.key === SECOND_KEY)?.default, false)
  assert.equal(link.authMode, PASSWORD === undefined ? 'token' : 'password')
})
await check('a server argument accepts a key or any URL spelling', async () => {
  if (SECOND_URL === undefined) return
  // Scheme-less, with a UI path: everything normalizes to the same key, so it is the same kernel.
  const viaSpelling = await runtime.execute('e2e-multi-spelling', 'print("spelling")', {
    server: SECOND_URL.replace(/^https?:\/\//, '') + '/tree',
  })
  assert.equal(viaSpelling.status, 'ok', viaSpelling.message ?? '')
  assert.equal(viaSpelling.server, SECOND_KEY)
  assert.equal(summarizeOutputs(viaSpelling.outputs).stdout, 'spelling\n')
  const viaKey = await runtime.execute('e2e-multi-spelling', 'print("key")', { server: SECOND_KEY })
  assert.equal(viaKey.kernelId, viaSpelling.kernelId, 'a spelling of the same server started a second kernel')
  secondServerKernels.push(viaSpelling.kernelId)
})
await check('one session has independent kernels on two connections', async () => {
  if (SECOND_URL === undefined) return
  const first = await runtime.execute('e2e-multi-same', 'marker = "one"\nprint("first")\nmarker', { server: FIRST_KEY })
  assert.equal(first.status, 'ok', first.message ?? '')
  const second = await runtime.execute('e2e-multi-same', 'print(marker)', { server: SECOND_KEY })
  // Same physical server, different registry key: the binding is per connection, so the variable
  // defined through the first key must not exist through the second.
  assert.equal(second.status, 'error')
  assert.match(summarizeOutputs(second.outputs).error ?? '', /NameError/)
  assert.notEqual(first.kernelId, second.kernelId)
  const [kernelA, kernelB] = await Promise.all([
    runtime.sessionKernel('e2e-multi-same', { server: FIRST_KEY }),
    runtime.sessionKernel('e2e-multi-same', { server: SECOND_KEY }),
  ])
  assert.notEqual(kernelA?.id, kernelB?.id)
  assert.ok(runtime.openChannelCount >= 2, 'expected a channel per connection')
  secondServerKernels.push(second.kernelId)
})
await check('an unknown server argument fails readably', async () => {
  assert.throws(
    () => runtime.client('http://not-connected.invalid:9000'),
    (error) => error instanceof JupyterError
      && error.code === 'JUPYTER_NOT_CONFIGURED'
      && /not a connected Jupyter server/.test(error.message),
  )
  await assert.rejects(
    () => runtime.execute('e2e-multi-unknown', '1', { server: 'http://not-connected.invalid:9000' }),
    (error) => error instanceof JupyterError && error.code === 'JUPYTER_NOT_CONFIGURED',
  )
})
await check('a run-time connection persists, a config-provided one is the config\'s to re-create', async () => {
  if (SECOND_URL === undefined) return
  // `servers.json` holds what was added at run time. A server that came from the profile config is
  // re-applied on every boot, so mirroring it would let it outlive its own removal from the config
  // (and would write a second plaintext copy of its credential for no benefit).
  const withoutConfig = new JupyterRuntime({})
  try {
    assert.deepEqual(withoutConfig.servers().map((entry) => entry.key).sort(), [SECOND_KEY].sort())
    assert.equal(withoutConfig.defaultServer(), SECOND_KEY)
    // The credential comes back on the host side (it was written to the private file) but never in
    // the describe list.
    const settings = withoutConfig.settingsFor(SECOND_KEY)
    assert.equal(settings.url !== undefined, true)
    if (PASSWORD !== undefined) assert.equal(settings.password !== undefined, true)
  } finally {
    withoutConfig.dispose()
  }
  const withConfig = new JupyterRuntime({ url: URL_UNDER_TEST, token: TOKEN, password: PASSWORD })
  try {
    assert.deepEqual(withConfig.servers().map((entry) => entry.key).sort(), [FIRST_KEY, SECOND_KEY].sort())
    assert.equal(withConfig.defaultServer(), FIRST_KEY)
  } finally {
    withConfig.dispose()
  }
  const file = JSON.parse(readFileSync(serversFile(), 'utf8'))
  assert.deepEqual(file.servers.map((entry) => entry.url), [SECOND_KEY], 'a config-provided connection was mirrored')
  const stat = statSync(serversFile())
  assert.equal(stat.mode & 0o777, 0o600, 'servers.json must be readable by its owner only')
})
await check('removing a server closes its channels and drops its bindings', async () => {
  if (SECOND_URL === undefined) return
  const live = await runtime.execute('e2e-multi-remove', 'print("bound")', { server: SECOND_KEY })
  assert.equal(live.status, 'ok', live.message ?? '')
  const openBefore = runtime.openChannelCount
  assert.equal(runtime.setDefaultServer(SECOND_KEY), SECOND_KEY)
  const removed = runtime.removeServer(SECOND_KEY)
  assert.equal(removed.removed, true)
  assert.equal(removed.key, SECOND_KEY)
  assert.ok(runtime.openChannelCount < openBefore, 'the channel to the removed server stayed open')
  assert.ok(!runtime.servers().some((entry) => entry.key === SECOND_KEY))
  assert.equal(runtime.defaultServer(), FIRST_KEY, 'the default must move to the first remaining connection')
  await assert.rejects(
    () => runtime.execute('e2e-multi-remove', 'print("again")', { server: SECOND_KEY }),
    (error) => error instanceof JupyterError && error.code === 'JUPYTER_NOT_CONFIGURED',
  )
  const mirrored = readKernels()
  assert.ok(
    !Object.keys(mirrored).some((key) => key.startsWith(`${SECOND_KEY}::`)),
    'kernels.json still has an entry for the removed server',
  )
  // The kernels themselves keep running on the server; clean up the ones this test started.
  secondServerKernels.push(live.kernelId)
  for (const kernelId of secondServerKernels) await shutdownKernelOn(SECOND_URL, kernelId)
  secondServerKernels.length = 0
})
await check('legacy kernels.json keys are found and rewritten canonically', async () => {
  // The single-server build keyed the mirror by the raw configured address (often with /lab), not
  // by the normalized server key. Such an entry must still re-attach — and be migrated on write.
  if (URL_UNDER_TEST === FIRST_KEY) {
    console.log('      (the configured spelling is already canonical — nothing to migrate)')
    return
  }
  const legacySession = 'e2e-multi-legacy'
  const before = new JupyterRuntime({ url: URL_UNDER_TEST, token: TOKEN, password: PASSWORD })
  let kernelId
  try {
    const started = await before.kernelAction(legacySession, 'start')
    kernelId = started.kernelId
  } finally {
    // Drop the channel without touching the mirror, exactly like a plugin reload.
    before.dispose()
  }
  const mirrored = readKernels()
  const canonical = `${FIRST_KEY}::${legacySession}`
  assert.notEqual(mirrored[canonical], undefined, 'the canonical mirror entry was not written')
  const legacyKey = `${URL_UNDER_TEST}::${legacySession}`
  mirrored[legacyKey] = mirrored[canonical]
  delete mirrored[canonical]
  writeFileSync(kernelsFile(), JSON.stringify(mirrored, null, 2))

  const after = new JupyterRuntime({ url: URL_UNDER_TEST, token: TOKEN, password: PASSWORD })
  try {
    const revived = await after.ensureKernel(legacySession)
    assert.equal(revived.entry.kernelId, kernelId, 'the legacy mirror entry did not re-attach to the same kernel')
    assert.match(revived.note ?? '', /re-attached/)
    const migrated = readKernels()
    assert.notEqual(migrated[canonical], undefined, 'the write did not use the canonical key')
    assert.equal(migrated[legacyKey], undefined, 'the legacy key survived the write')
    await after.kernelAction(legacySession, 'shutdown')
  } finally {
    after.dispose()
  }
})

console.log('\nconfiguration-provided connections')
await check('config.servers loads in order, inherits no credential, and is not mirrored', async () => {
  const saved = process.env.DSH_HOME
  const isolated = mkdtempSync(path.join(tmpdir(), 'dsh-jupyter-config-'))
  process.env.DSH_HOME = isolated
  const secondUrl = SECOND_URL ?? 'http://second.invalid:9009/lab'
  let configured
  try {
    configured = new JupyterRuntime({
      url: URL_UNDER_TEST,
      token: TOKEN,
      password: PASSWORD,
      kernelName: 'python3',
      servers: [{ url: secondUrl }],
    })
    const described = configured.servers()
    assert.equal(described.length, 2)
    // `config.servers` loads before the single `config.url` fields, so list order is config.servers
    // first; what matters is which one is the default.
    const first = described.find((entry) => entry.key === FIRST_KEY)
    assert.notEqual(first, undefined, 'config.url was not loaded')
    assert.equal(first.default, true, 'config.url must stay the default')
    const second = described.find((entry) => entry.key === serverKey(secondUrl))
    assert.notEqual(second, undefined, 'config.servers was not loaded')
    // Credentials are per host: the top-level token must not travel to a second server.
    assert.equal(second.authMode, 'none', 'a config.servers entry inherited the top-level credential')
    assert.equal(existsSync(path.join(isolated, 'jupyterlab', 'servers.json')), false,
      'config-provided connections were written to servers.json on boot')
  } finally {
    configured?.dispose()
    process.env.DSH_HOME = saved
    rmSync(isolated, { recursive: true, force: true })
  }
})

await check('configure(forgetKernels) closes only the named server\'s channels', async () => {
  const outcome = await runtime.execute('e2e-forget-kernels', 'marker = 1', { server: FIRST_KEY })
  assert.equal(outcome.status, 'ok', outcome.message ?? '')
  assert.ok(runtime.openChannelCount >= 1, 'the execution did not open a channel')
  // `jupyter_connect` with forgetKernels is the "drop the bindings of this server" path: the
  // kernel keeps running on the server, only this host's channels go away.
  runtime.configure({ url: URL_UNDER_TEST, ...credentialFields(URL_UNDER_TEST) }, { forgetKernels: true })
  assert.equal(runtime.openChannelCount, 0, 'a forgotten kernel still holds a channel')
})

await check('multi-connection kernels are cleaned up', async () => {
  for (const name of ['e2e-multi-same', 'e2e-multi-spelling']) {
    await runtime.kernelAction(name, 'shutdown', { server: FIRST_KEY }).catch(() => {})
  }
})

await check('session kernels are cleaned up', async () => {
  await runtime.kernelAction(session, 'shutdown')
})

runtime.dispose()
rmSync(stateDirectory, { recursive: true, force: true })

// A disposed runtime must not leave kernel channels open behind it: this plugin lives in a
// long-running host process, and a forgotten channel would keep a remote kernel attached forever.
// (Sockets held by the keep-alive agents are expected and drain on their own; the process's own
// stdio pipes are `PipeWrap` handles and were never the plugin's to close.)
await new Promise((resolve) => setTimeout(resolve, 5000))
const lingering = process.getActiveResourcesInfo().filter((kind) => kind !== 'Timeout' && kind !== 'PipeWrap')
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

/** Shut down one kernel on a server that is no longer (or not yet) in a registry. */
async function shutdownKernelOn(url, kernelId) {
  if (url === undefined || kernelId === undefined) return
  const credentials = credentialFields(url)
  const cleanup = new JupyterRuntime({ url, ...credentials })
  try {
    await cleanup.kernelAction('cleanup', 'shutdown', { kernelId })
  } catch {
    // A kernel the server already reaped is fine.
  } finally {
    cleanup.dispose()
  }
}
