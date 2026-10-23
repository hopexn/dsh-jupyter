/**
 * Registration and tool-level test against the real DeepSeek Harness runtime.
 *
 * This mounts the plugin into a live Cordis context with the actual `@deepseek-ai/dsh-tools`
 * registry from the running DSH installation, so it verifies what a unit test cannot: that the
 * `Config` schema validates, that every `defineTool` definition is accepted by the registry
 * (parameter specs, output schemas, presenters), and that tool arguments and canonical outputs
 * pass the registry's own validation.
 *
 * It needs the DSH packages to be resolvable from this directory, so it is meant to run with the
 * harness `node_modules` link described in README.md ("Verifying a change"):
 *
 *   node test/register.mjs
 *
 * Environment: same as test/e2e.mjs.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { Context, Service } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

import * as plugin from '../lib/index.js'

const URL_UNDER_TEST = process.env.JUPYTER_TEST_URL ?? 'http://127.0.0.1:9003/lab'
// Only fall back to the local throwaway token when the address does not already carry one;
// otherwise the default would override the credential under test.
const PASSWORD = process.env.JUPYTER_TEST_PASSWORD
const TOKEN = PASSWORD !== undefined
  ? undefined
  : process.env.JUPYTER_TEST_TOKEN ?? (URL_UNDER_TEST.includes('token=') ? undefined : 'dsh-test-token')

/** Minimal stand-in for the runtime's prompt service, which `ToolRuntime` injects. */
class SystemPromptStub extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
    this.sections = []
    this.toolProviders = []
  }

  section(section) {
    this.sections.push(section)
    return () => {}
  }

  tools(provider) {
    this.toolProviders.push(provider)
    return () => {}
  }

  getSectionOrder() {
    return undefined
  }
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 40))

/** Call a tool through the registry, exactly as the agent loop does. */
async function callTool(ctx, name, args, callId = name) {
  return await ctx.tools.execute({
    callId,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

/** The model-facing text of a tool result. */
function textOf(result) {
  return (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

/** Tear down a Cordis context and everything mounted in it. */
async function disposeContext(context) {
  await context?.fiber?.dispose?.()
}

console.log(`DeepSeek Harness registration test\n  plugin: ${plugin.name}\n  server: ${URL_UNDER_TEST}\n`)

console.log('config schema')
/** Validate a raw config the way Cordis does. */
const validateConfig = (raw) => plugin.Config['~standard'].validate(raw)

await check('the config schema speaks the Standard Schema protocol', () => {
  assert.equal(plugin.Config['~standard'].version, 1)
  assert.equal(typeof plugin.Config['~standard'].validate, 'function')
})
await check('the schema applies its documented defaults', () => {
  const { value, issues } = validateConfig({ url: URL_UNDER_TEST })
  assert.equal(issues, undefined)
  assert.equal(value.kernelName, 'python3')
  assert.equal(value.requestTimeoutMs, 20000)
  assert.equal(value.executeTimeoutMs, 180000)
  assert.equal(value.autoStartKernel, true)
  assert.equal(value.maxOutputChars, 20000)
})
await check('an empty config is accepted, so the plugin loads unconfigured', () => {
  const { value, issues } = validateConfig({})
  assert.equal(issues, undefined)
  assert.equal(value.url, undefined)
})
await check('bad options are reported together as validation issues', () => {
  const { issues } = validateConfig({ requestTimeoutMs: -5, kernelName: 7, autoStartKernel: 'yes' })
  assert.equal(issues.length, 3, JSON.stringify(issues))
  assert.match(issues.map((issue) => issue.message).join(' '), /positive number/)
})
await check('the plugin declares the tool registry as its only dependency', () => {
  assert.deepEqual([...plugin.inject], ['tools'])
})
await check('the plugin imports no host packages', () => {
  // A profile-installed bundle cannot rely on the running host's module interception, so the
  // plugin must be importable with nothing but Node builtins and its own relative modules.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  for (const match of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
    const specifier = match[1]
    assert.ok(
      specifier.startsWith('node:') || specifier.startsWith('.'),
      `lib/index.js imports the bare specifier "${specifier}"`,
    )
  }
})

const ctx = new Context()
ctx.plugin(SystemPromptStub)
ctx.plugin(ToolRuntime)
await tick()

console.log('\nregistration')
await check('the plugin mounts into a live runtime', async () => {
  ctx.plugin(
    { apply: plugin.apply, name: plugin.name, Config: plugin.Config, inject: plugin.inject },
    { url: URL_UNDER_TEST, ...(TOKEN === undefined ? {} : { token: TOKEN }), ...(PASSWORD === undefined ? {} : { password: PASSWORD }) },
  )
  await tick()
  await tick()
})
await check('all four tools are visible to the model', () => {
  for (const name of ['jupyter_connect', 'jupyter_status', 'jupyter_execute', 'jupyter_kernel']) {
    assert.notEqual(ctx.tools.get(name), undefined, `${name} was not registered`)
  }
})
await check('the execute tool exposes its parameters and hides its timeout budget', () => {
  const schemas = ctx.tools.schemas()
  const schema = schemas.find((entry) => entry.name === 'jupyter_execute')
  assert.notEqual(schema, undefined, 'jupyter_execute missing from the model-facing schema list')
  assert.equal(schema.parameters.type, 'object')
  assert.deepEqual(schema.parameters.required, ['code'])
  assert.ok(schema.parameters.properties.code.description.length > 0)
  assert.equal(schema.timeoutMs, undefined, 'timeoutMs must not be sent to the model')
})
await check('the kernel tool constrains its action to the supported set', () => {
  const schema = ctx.tools.schemas().find((entry) => entry.name === 'jupyter_kernel')
  assert.deepEqual(schema.parameters.properties.action.enum, ['list', 'start', 'restart', 'interrupt', 'shutdown', 'attach'])
})
await check('the plugin contributed system-prompt guidance', () => {
  const prompt = ctx.get('systemPrompt')
  assert.equal(prompt.sections.length, 1, 'expected exactly one prompt section')
  assert.equal(prompt.sections[0].name, 'tool:jupyter')
  assert.match(prompt.sections[0].text(), /jupyter_execute/)
})

console.log('\ntool calls through the registry')
await check('jupyter_status reports a reachable server', async () => {
  const result = await callTool(ctx, 'jupyter_status', {})
  assert.notEqual(result.isError, true, textOf(result))
  assert.match(textOf(result), /is reachable/)
  assert.match(textOf(result), /python3/)
})
await check('jupyter_execute runs code and returns stdout', async () => {
  const result = await callTool(ctx, 'jupyter_execute', { code: 'print("from a tool call")\n6 * 7' })
  assert.notEqual(result.isError, true, textOf(result))
  const text = textOf(result)
  assert.match(text, /^ok · /, text)
  assert.match(text, /from a tool call/)
  assert.match(text, /result:\n42/)
})
await check('kernel state persists between tool calls', async () => {
  await callTool(ctx, 'jupyter_execute', { code: 'shared_state = "kept"' }, 'seed')
  const result = await callTool(ctx, 'jupyter_execute', { code: 'print(shared_state)' }, 'read')
  assert.match(textOf(result), /kept/)
})
await check('a failing cell is reported as an error result, not a crash', async () => {
  const result = await callTool(ctx, 'jupyter_execute', { code: 'raise RuntimeError("tool-level boom")' })
  assert.notEqual(result.isError, true, 'a cell error is a successful tool call carrying the traceback')
  const text = textOf(result)
  assert.match(text, /^error · /, text)
  assert.match(text, /RuntimeError: tool-level boom/)
})
await check('an invalid argument is rejected by the registry before the body runs', async () => {
  const result = await callTool(ctx, 'jupyter_execute', {})
  assert.equal(result.isError, true)
  assert.match(textOf(result), /invalid arguments/)
})
await check('jupyter_kernel lists, then reports the bound kernel', async () => {
  const listed = await callTool(ctx, 'jupyter_kernel', { action: 'list' })
  assert.notEqual(listed.isError, true, textOf(listed))
  assert.match(textOf(listed), /kernel\(s\) running/)
  const started = await callTool(ctx, 'jupyter_kernel', { action: 'start' })
  assert.match(textOf(started), /started|new kernel/)
  const status = await callTool(ctx, 'jupyter_status', {})
  assert.match(textOf(status), /bound to this session: [0-9a-f-]{36}/)
})
await check('jupyter_connect verifies an address given at runtime', async () => {
  // Arguments must be losslessly JSON-serializable, so absent credentials are omitted rather
  // than passed as `undefined`.
  const args = { url: `${URL_UNDER_TEST}${URL_UNDER_TEST.includes('?') ? '&' : '?'}probe=1`, kernelName: 'python3' }
  if (TOKEN !== undefined) args.token = TOKEN
  if (PASSWORD !== undefined) args.password = PASSWORD
  const result = await callTool(ctx, 'jupyter_connect', args)
  assert.notEqual(result.isError, true, textOf(result))
  assert.match(textOf(result), /connected to http/)
  assert.match(textOf(result), /kernelspecs: .*python3/)
})
await check('a bad token surfaces as a readable authentication failure', async () => {
  const bad = new Context()
  bad.plugin(SystemPromptStub)
  bad.plugin(ToolRuntime)
  await tick()
  bad.plugin(
    { apply: plugin.apply, name: plugin.name, Config: plugin.Config, inject: plugin.inject },
    { url: URL_UNDER_TEST, token: 'wrong-token' },
  )
  await tick()
  await tick()
  const result = await callTool(bad, 'jupyter_status', {})
  assert.match(textOf(result), /authentication failed/)
  await disposeContext(bad)
})
await check('jupyter_kernel rejects an unknown action', async () => {
  const result = await callTool(ctx, 'jupyter_kernel', { action: 'detonate' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /invalid arguments|unknown kernel action/)
})

console.log('\ncleanup')
await check('the mounted plugin disposes cleanly', async () => {
  await disposeContext(ctx)
  await tick()
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`\n${label}\n${error?.stack ?? error}`)
  process.exit(1)
}
process.exit(0)
