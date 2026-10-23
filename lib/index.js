/**
 * JupyterLab / Jupyter Server plugin for DeepSeek Harness.
 *
 * Point the harness at any Jupyter server — `jupyter_connect` takes an address like
 * `http://aimax395.local:9002/lab` — and the agent gains four tools that operate on it:
 * execute code in a persistent remote kernel, inspect the connection, and manage kernels.
 *
 * The kernel is bound per DeepSeek Harness session, so a conversation keeps its variables,
 * imports and working directory between tool calls, and re-attaches to the same kernel after a
 * plugin reload or an app restart.
 *
 * ## Why this file imports nothing
 *
 * A profile-installed bundle normally resolves `@deepseek-ai/*` through the host's own module
 * interception, which is snapshotted when the process boots: a bundle linked into a *running*
 * profile cannot rely on it (this plugin's first install failed with `failed to import` for
 * exactly that reason). The host-plugin contract needs no packages at all — `Config` is any
 * Standard Schema and a tool definition is plain data — so this module is deliberately
 * dependency-free and loads in any profile, on any installation, without a restart.
 *
 * @module dsh-jupyterlab
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { collectArtifacts, summarizeOutputs } from './kernel.js'
import { Notebooks } from './notebook.js'
import { registerNotebookRoutes } from './routes.js'
import { JupyterRuntime } from './runtime.js'

/** Cordis plugin name, used for loader diagnostics and logger names. */
export const name = 'jupyterlab'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

/** Placement of this plugin's system-prompt guidance (between TOOL_LSP and TOOL_SESSION_QUERY). */
const PROMPT_ORDER = 2250

/** Config values applied when the row omits them. Mirrors `normalizeSettings` in runtime.js. */
const CONFIG_DEFAULTS = {
  kernelName: 'python3',
  requestTimeoutMs: 20000,
  executeTimeoutMs: 180000,
  autoStartKernel: true,
  maxOutputChars: 20000,
}

/** Config fields kept verbatim as strings. */
const CONFIG_STRINGS = ['url', 'token', 'password', 'username', 'workingDirectory', 'artifactDirectory']

/** Config fields that must be positive finite numbers. */
const CONFIG_NUMBERS = ['requestTimeoutMs', 'executeTimeoutMs', 'maxOutputChars']

/**
 * Plugin config, as a Standard Schema.
 *
 * Cordis validates this before `apply` and passes the returned value through, so the defaults
 * below are what an empty `config: {}` row resolves to. Credentials are never logged or echoed
 * back in tool output.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-jupyterlab',
    /**
     * Validate and default the row's config mapping.
     * @param value - Raw config from the loader patch.
     * @returns `{ value }` with defaults applied, or `{ issues }` describing every problem.
     */
    validate(value) {
      const raw = value === undefined || value === null ? {} : value
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'config must be an object' }] }
      }
      const issues = []
      const settings = { ...CONFIG_DEFAULTS }
      for (const key of CONFIG_STRINGS) {
        const field = raw[key]
        if (field === undefined || field === null) continue
        if (typeof field !== 'string') {
          issues.push({ message: `"${key}" must be a string`, path: [key] })
          continue
        }
        settings[key] = field
      }
      for (const key of CONFIG_NUMBERS) {
        const field = raw[key]
        if (field === undefined || field === null) continue
        if (typeof field !== 'number' || !Number.isFinite(field) || field <= 0) {
          issues.push({ message: `"${key}" must be a positive number`, path: [key] })
          continue
        }
        settings[key] = field
      }
      if (raw.kernelName !== undefined && raw.kernelName !== null) {
        if (typeof raw.kernelName !== 'string') issues.push({ message: '"kernelName" must be a string', path: ['kernelName'] })
        else settings.kernelName = raw.kernelName
      }
      if (raw.autoStartKernel !== undefined && raw.autoStartKernel !== null) {
        if (typeof raw.autoStartKernel !== 'boolean') issues.push({ message: '"autoStartKernel" must be a boolean', path: ['autoStartKernel'] })
        else settings.autoStartKernel = raw.autoStartKernel
      }
      return issues.length > 0 ? { issues } : { value: settings }
    },
  },
}

/**
 * Build an object-rooted JSON Schema for a tool's canonical output.
 *
 * @param properties - Property schemas.
 * @param required - Property names the value must always carry.
 * @returns The raw schema handed to the tool registry.
 */
function objectSchema(properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** Output schema for one kernel in an inventory listing. */
const KERNEL_SCHEMA = objectSchema({
  id: { type: 'string' },
  name: { type: 'string' },
  state: { type: 'string' },
  connections: { type: 'integer' },
  lastActivity: { type: 'string' },
}, ['id', 'name', 'state'])

/**
 * Validate model-supplied arguments against a compact per-property spec.
 *
 * The registry only enforces `output.schema` for a hand-written definition, so argument checking
 * is this module's job. Every violation is reported at once, matching what the model would see
 * from a first-party tool.
 *
 * @param args - Arguments as produced by the model.
 * @param spec - Per-property rules: `type`, optional `required` and `enum`.
 * @returns Violation messages; empty means valid.
 */
function validateArguments(args, spec) {
  if (args === undefined || args === null) args = {}
  if (typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object']
  const violations = []
  for (const [key, rule] of Object.entries(spec)) {
    const value = args[key]
    if (value === undefined || value === null) {
      if (rule.required === true) violations.push(`"${key}" is required`)
      continue
    }
    if (rule.type === 'string' && typeof value !== 'string') violations.push(`"${key}" must be a string`)
    else if (rule.type === 'boolean' && typeof value !== 'boolean') violations.push(`"${key}" must be a boolean`)
    else if (rule.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`"${key}" must be a finite number`)
    if (rule.enum !== undefined && !rule.enum.includes(value)) {
      violations.push(`"${key}" must be one of ${rule.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
    }
  }
  return violations
}

/**
 * Define one registry-ready tool, validating arguments before the body runs.
 *
 * @param options - Tool definition.
 * @param options.name - Tool name.
 * @param options.description - Model-facing description.
 * @param options.spec - Argument rules, also published as the parameter schema.
 * @param options.output - Canonical output `{ schema, render }`.
 * @param options.timeoutMs - Cooperative timeout budget.
 * @param options.execute - Body receiving validated arguments.
 * @returns A tool definition for `ctx.tools.register`.
 */
function defineJupyterTool({ name, description, spec, output, timeoutMs, execute }) {
  const properties = {}
  for (const [key, rule] of Object.entries(spec)) {
    properties[key] = {
      type: rule.type,
      ...(rule.description === undefined ? {} : { description: rule.description }),
      ...(rule.enum === undefined ? {} : { enum: [...rule.enum] }),
    }
  }
  const required = Object.entries(spec).filter(([, rule]) => rule.required === true).map(([key]) => key)
  return {
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    timeoutMs,
    output,
    async execute(args, exec) {
      const violations = validateArguments(args, spec)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return await execute(args ?? {}, exec)
    },
  }
}

/**
 * Register the Jupyter tools and their system-prompt guidance.
 *
 * @param ctx - Context whose `tools` registry receives the definitions.
 * @param config - Validated plugin config.
 */
export function apply(ctx, config) {
  const runtime = new JupyterRuntime(config, { logger: ctx.logger?.('jupyterlab') })
  // Channels are per-plugin effects; the kernels themselves keep running on the server.
  ctx.effect(() => () => runtime.dispose(), 'jupyterlab.channels')

  // The right-side panel's data plane: one notebook per session whose cells run in the very same
  // kernel the agent uses, exposed to the browser through an authenticated same-origin route.
  const notebooks = new Notebooks({
    execute: (sessionId, code, options) => runtime.execute(sessionId, code, options),
    kernelInfo: (sessionId) => runtime.sessionKernel(sessionId),
  })
  notebooks.setKernelAction(async (action, sessionId) => {
    const verb = action === 'restartKernel' ? 'restart' : action === 'interrupt' ? 'interrupt' : 'start'
    return (await runtime.kernelAction(sessionId, verb, {})).message
  })
  ctx.effect(() => () => notebooks.dispose(), 'jupyterlab.notebooks')
  // The panel route registers only once Connection is actually provided, which is later than this
  // plugin's own mount on a cold boot. Its outcome is reported by `jupyter_status`, so a route that
  // never registered is visible instead of appearing as a 404 in the browser.
  const panel = { state: 'pending' }
  registerNotebookRoutes(ctx, {
    notebooks,
    connectionInfo: () => {
      const settings = runtime.settings
      return { configured: settings.url !== undefined, url: settings.url ?? null }
    },
    onState: (state) => { panel.state = state },
  })

  // Dynamic injection for the same reason as the panel route: reading the service once at mount
  // silently skips the guidance when the service is not up yet.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'tool:jupyter',
      order: PROMPT_ORDER,
      text: () => PROMPT_TEXT,
    }), 'jupyterlab.prompt')
  })

  ctx.tools.register(connectTool(runtime))
  ctx.tools.register(statusTool(runtime, panel))
  ctx.tools.register(executeTool(runtime))
  ctx.tools.register(kernelTool(runtime))
}

/** Guidance injected while the Jupyter tools are visible to the agent. */
const PROMPT_TEXT = [
  '## Jupyter',
  'A Jupyter server can be reached with the jupyter_* tools. `jupyter_execute` runs code in a',
  'persistent remote kernel: variables, imports and the working directory survive between calls,',
  'so define state once instead of repeating it, and prefer one larger cell over many tiny ones.',
  '`jupyter_status` shows the connection and the bound kernel; `jupyter_kernel` starts, restarts,',
  'interrupts, shuts down or attaches kernels; `jupyter_connect` points the harness at another',
  'JupyterLab address. When the user names a JupyterLab address, pass it to `jupyter_connect`',
  'verbatim — a trailing /lab or ?token=... is handled. If a call fails with an authentication or',
  'reachability error, report it instead of retrying blindly.',
].join(' ')

/** `jupyter_connect` — set the address and credentials, then verify them. */
function connectTool(runtime) {
  return defineJupyterTool({
    name: 'jupyter_connect',
    description: [
      'Connect DeepSeek Harness to a Jupyter server and verify the credentials.',
      'Pass the JupyterLab address the user gave you, for example http://host:9002/lab;',
      'a trailing /lab, /tree or a ?token=... query is understood and normalized.',
      'Returns the server version, installed kernelspecs and running kernels.',
      'Call this first whenever the user names a JupyterLab address or switches servers.',
      'Switching to a different address drops the previous token and password unless this call',
      'supplies a replacement, so ask the user for the credential of the new server.',
    ].join(' '),
    spec: {
      url: { type: 'string', description: 'JupyterLab address, e.g. http://host:9002/lab. Omit to reuse the configured address.' },
      token: { type: 'string', description: 'API token, for servers configured with token auth.' },
      password: { type: 'string', description: 'Login password, for servers configured with a password.' },
      username: { type: 'string', description: 'Username for a password login.' },
      kernelName: { type: 'string', description: 'Kernelspec to start for this session, e.g. python3.' },
      forgetKernels: { type: 'boolean', description: 'Drop the kernels currently bound to DSH sessions. They keep running on the server; the next execution starts or attaches again.' },
    },
    output: {
      schema: objectSchema({
        connected: { type: 'boolean' },
        url: { type: 'string' },
        authMode: { type: 'string' },
        version: { type: 'string' },
        kernelspecs: { type: 'array', items: { type: 'string' } },
        kernels: { type: 'array', items: KERNEL_SCHEMA },
        message: { type: 'string' },
      }, ['connected', 'kernels', 'message']),
      render: (_args, value) => [{ type: 'text', text: renderConnect(value) }],
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      runtime.configure(
        { url: args.url, token: args.token, password: args.password, username: args.username, kernelName: args.kernelName },
        { forgetKernels: args.forgetKernels === true },
      )
      const probe = await runtime.probe({ signal: exec.signal })
      return {
        connected: true,
        url: probe.url,
        authMode: probe.authMode,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        kernelspecs: probe.kernelspecs,
        kernels: probe.kernels,
        message: `connected to ${probe.url} (${probe.authMode} auth); ${probe.kernelspecs.length} kernelspec(s), ${probe.kernels.length} running kernel(s)`,
      }
    },
  })
}

/** `jupyter_status` — report the connection, the session's kernel, and the panel's wiring. */
function statusTool(runtime, panel) {
  return defineJupyterTool({
    name: 'jupyter_status',
    description: [
      'Report the Jupyter connection used by this session: configured address, whether it is',
      'reachable, the server version, installed kernelspecs, running kernels, and which kernel',
      'this session is bound to. Use it to diagnose failures or to see what is already running.',
    ].join(' '),
    spec: {
      probe: { type: 'boolean', description: 'Contact the server for live information. Defaults to true; false reports only local state.' },
    },
    output: {
      schema: objectSchema({
        configured: { type: 'boolean' },
        reachable: { type: 'boolean' },
        url: { type: 'string' },
        version: { type: 'string' },
        kernelspecs: { type: 'array', items: { type: 'string' } },
        kernels: { type: 'array', items: KERNEL_SCHEMA },
        sessionKernel: KERNEL_SCHEMA,
        panel: { type: 'string' },
        message: { type: 'string' },
        error: { type: 'string' },
      }, ['configured', 'reachable', 'kernels', 'message']),
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      const settings = runtime.settings
      const sessionKernel = await runtime.sessionKernel(sessionKey(exec), { signal: exec.signal })
      if (args.probe === false) {
        return {
          panel: panel.state,
          configured: settings.url !== undefined,
          reachable: false,
          ...(settings.url === undefined ? {} : { url: settings.url }),
          kernels: [],
          ...(sessionKernel === undefined ? {} : { sessionKernel }),
          message: settings.url === undefined
            ? 'no Jupyter server configured; call jupyter_connect with the JupyterLab address'
            : `configured for ${settings.url}; live state not requested`,
        }
      }
      try {
        const probe = await runtime.probe({ signal: exec.signal })
        return {
          panel: panel.state,
          configured: true,
          reachable: true,
          url: probe.url,
          ...(probe.version === undefined ? {} : { version: probe.version }),
          kernelspecs: probe.kernelspecs,
          kernels: probe.kernels,
          ...(sessionKernel === undefined ? {} : { sessionKernel }),
          message: `${probe.url} is reachable; ${probe.kernels.length} running kernel(s)${sessionKernel === undefined ? ', none bound to this session yet' : `, this session uses ${sessionKernel.id}`}`,
        }
      } catch (error) {
        return {
          panel: panel.state,
          configured: settings.url !== undefined,
          reachable: false,
          ...(settings.url === undefined ? {} : { url: settings.url }),
          kernels: [],
          ...(sessionKernel === undefined ? {} : { sessionKernel }),
          message: 'the Jupyter server could not be reached',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}

/** `jupyter_execute` — run code in the session's persistent kernel. */
function executeTool(runtime) {
  return defineJupyterTool({
    name: 'jupyter_execute',
    description: [
      'Execute code in the Jupyter kernel bound to this session and return its outputs:',
      'stdout, the value of the final expression, errors, and the paths of any saved image',
      'outputs. The kernel is persistent, so variables, imports and the working directory stay',
      'alive between calls — keep state in the kernel rather than redefining it. The first call',
      'starts a kernel (python3 by default). A timed-out or cancelled call interrupts the kernel,',
      'which keeps the session and its variables.',
    ].join(' '),
    spec: {
      code: { type: 'string', required: true, description: 'Source to run, e.g. Python for the python3 kernelspec. Multi-line code is fine.' },
      timeoutMs: { type: 'number', description: 'Execution budget in milliseconds before the kernel is interrupted. Defaults to the plugin setting.' },
      storeHistory: { type: 'boolean', description: 'Let the kernel count this execution (default true). Set false to run without touching execution_count.' },
    },
    output: {
      schema: objectSchema({
        status: { type: 'string' },
        kernelId: { type: 'string' },
        kernelspec: { type: 'string' },
        executionCount: { type: 'integer' },
        stdout: { type: 'string' },
        result: { type: 'string' },
        stderr: { type: 'string' },
        error: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'string' } },
        truncated: { type: 'boolean' },
        durationMs: { type: 'integer' },
        note: { type: 'string' },
        message: { type: 'string' },
      }, ['status', 'kernelId']),
      render: (_args, value) => [{ type: 'text', text: renderExecute(value) }],
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const settings = runtime.settings
      const limit = settings.maxOutputChars
      const execution = await runtime.execute(sessionKey(exec), args.code, {
        timeoutMs: args.timeoutMs,
        signal: exec.signal,
        storeHistory: args.storeHistory !== false,
      })
      const summary = summarizeOutputs(execution.outputs)
      const stdout = truncateMiddle(summary.stdout, limit)
      const stderr = truncateMiddle(summary.stderr, limit)
      const result = summary.result === undefined ? undefined : truncateMiddle(summary.result, limit)
      const errorText = summary.error === undefined ? undefined : truncateMiddle(summary.error, limit)
      const artifacts = saveArtifacts(execution.outputs, settings)
      const truncated = stdout.truncated || stderr.truncated || (result?.truncated ?? false) || (errorText?.truncated ?? false)
      return {
        status: execution.status,
        kernelId: execution.kernelId,
        kernelspec: execution.kernelspec,
        ...(execution.executionCount === null ? {} : { executionCount: execution.executionCount }),
        ...(stdout.text.length === 0 ? {} : { stdout: stdout.text }),
        ...(result === undefined || result.text.length === 0 ? {} : { result: result.text }),
        ...(stderr.text.length === 0 ? {} : { stderr: stderr.text }),
        ...(errorText === undefined || errorText.text.length === 0 ? {} : { error: errorText.text }),
        ...(artifacts.length === 0 ? {} : { artifacts }),
        ...(truncated ? { truncated: true } : {}),
        durationMs: execution.durationMs,
        ...(execution.note === undefined ? {} : { note: execution.note }),
        ...(execution.message === undefined ? {} : { message: execution.message }),
      }
    },
  })
}

/** `jupyter_kernel` — manage kernels, including attaching to someone else's. */
function kernelTool(runtime) {
  return defineJupyterTool({
    name: 'jupyter_kernel',
    description: [
      'Manage Jupyter kernels. Actions: "list" shows every kernel running on the server;',
      '"start" replaces this session\'s kernel with a fresh one; "restart" restarts the bound',
      'kernel, discarding all its state; "interrupt" stops the running cell but keeps the kernel;',
      '"shutdown" stops a kernel; "attach" binds this session to a kernel that already exists',
      '(for example one the user started in JupyterLab) so jupyter_execute runs in it.',
    ].join(' '),
    spec: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'start', 'restart', 'interrupt', 'shutdown', 'attach'],
        description: 'Which kernel operation to perform.',
      },
      kernelId: { type: 'string', description: 'Target kernel id. Required for "attach"; optional for "shutdown", "restart" and "interrupt", which otherwise use this session\'s kernel.' },
    },
    output: {
      schema: objectSchema({
        action: { type: 'string' },
        message: { type: 'string' },
        kernelId: { type: 'string' },
        state: { type: 'string' },
        kernels: { type: 'array', items: KERNEL_SCHEMA },
        kernelspecs: { type: 'array', items: { type: 'string' } },
      }, ['action', 'message', 'kernels']),
      render: (_args, value) => [{ type: 'text', text: renderKernel(value) }],
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      const outcome = await runtime.kernelAction(sessionKey(exec), args.action, { kernelId: args.kernelId, signal: exec.signal })
      return {
        action: args.action,
        message: outcome.message,
        ...(outcome.kernelId === undefined ? {} : { kernelId: outcome.kernelId }),
        ...(outcome.state === undefined ? {} : { state: outcome.state }),
        kernels: outcome.kernels,
        ...(outcome.kernelspecs === undefined ? {} : { kernelspecs: outcome.kernelspecs }),
      }
    },
  })
}

/**
 * Identify the Harness session a tool call belongs to.
 *
 * @param exec - Tool execution context.
 * @returns The session id, or `shared` when the call has no owning agent.
 */
function sessionKey(exec) {
  return exec?.agent?.session?.header?.id ?? 'shared'
}

/**
 * Persist rich outputs (images, PDFs) and return their paths.
 *
 * @param outputs - Normalized execution outputs.
 * @param settings - Runtime settings supplying the destination directory.
 * @returns Absolute paths of the files written.
 */
function saveArtifacts(outputs, settings) {
  const directory = settings.artifactDirectory ?? path.join(
    process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    'jupyterlab',
    'artifacts',
  )
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    return []
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return collectArtifacts(outputs, {
    directory,
    prefix: `jupyter-${stamp}`,
    writeFile: (file, payload, encoding) => writeFileSync(file, payload, encoding),
  })
}

/**
 * Keep the head and the tail of an over-long output.
 *
 * @param text - Raw text.
 * @param limit - Maximum characters to keep.
 * @returns The possibly shortened text plus whether anything was dropped.
 */
function truncateMiddle(text, limit) {
  if (text.length <= limit) return { text, truncated: false }
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  return {
    text: `${text.slice(0, head)}\n… [${text.length - limit} characters omitted] …\n${text.slice(-tail)}`,
    truncated: true,
  }
}

/** Model-facing text for {@link connectTool}. */
function renderConnect(value) {
  const lines = [value.message]
  if (value.version !== undefined) lines.push(`server version: ${value.version}`)
  if (value.kernelspecs !== undefined && value.kernelspecs.length > 0) lines.push(`kernelspecs: ${value.kernelspecs.join(', ')}`)
  if (value.kernels.length > 0) lines.push('running kernels:', ...value.kernels.map(renderKernelLine))
  return lines.join('\n')
}

/** Model-facing text for {@link statusTool}. */
function renderStatus(value) {
  const lines = [value.message]
  if (value.panel !== undefined) lines.push(`notebook panel route: ${value.panel}`)
  if (value.url !== undefined) lines.push(`address: ${value.url}`)
  if (value.version !== undefined) lines.push(`server version: ${value.version}`)
  if (value.kernelspecs !== undefined && value.kernelspecs.length > 0) lines.push(`kernelspecs: ${value.kernelspecs.join(', ')}`)
  if (value.kernels.length > 0) lines.push('running kernels:', ...value.kernels.map(renderKernelLine))
  if (value.sessionKernel !== undefined) lines.push(`bound to this session: ${value.sessionKernel.id} (${value.sessionKernel.name}, ${value.sessionKernel.state})`)
  else lines.push('bound to this session: none yet — the first jupyter_execute starts one')
  if (value.error !== undefined) lines.push(`error: ${value.error}`)
  return lines.join('\n')
}

/** Model-facing text for {@link kernelTool}. */
function renderKernel(value) {
  const lines = [value.message]
  if (value.kernelId !== undefined) lines.push(`kernel: ${value.kernelId}${value.state === undefined ? '' : ` (${value.state})`}`)
  if (value.kernelspecs !== undefined && value.kernelspecs.length > 0) lines.push(`kernelspecs: ${value.kernelspecs.join(', ')}`)
  if (value.kernels.length > 0) lines.push('running kernels:', ...value.kernels.map(renderKernelLine))
  else lines.push('running kernels: none')
  return lines.join('\n')
}

/** One line of kernel inventory. */
function renderKernelLine(kernel) {
  const connections = kernel.connections === undefined ? '' : `, ${kernel.connections} client(s)`
  return `  - ${kernel.id} · ${kernel.name} · ${kernel.state}${connections}`
}

/** Model-facing text for {@link executeTool}. */
function renderExecute(value) {
  const parts = []
  const meta = [value.kernelspec ?? 'kernel', value.kernelId]
  if (value.executionCount !== undefined) meta.push(`execution_count ${value.executionCount}`)
  if (value.durationMs !== undefined) meta.push(`${(value.durationMs / 1000).toFixed(2)}s`)
  parts.push(`${value.status} · ${meta.join(' · ')}`)
  if (value.note !== undefined) parts.push(`note: ${value.note}`)
  if (value.message !== undefined && value.status !== 'ok' && value.status !== 'error') parts.push(`detail: ${value.message}`)
  if (value.stdout !== undefined) parts.push('', 'stdout:', value.stdout.replace(/\n+$/, ''))
  if (value.result !== undefined) parts.push('', 'result:', value.result)
  if (value.stderr !== undefined) parts.push('', 'stderr:', value.stderr.replace(/\n+$/, ''))
  if (value.error !== undefined) parts.push('', 'error:', value.error)
  if (value.artifacts !== undefined) parts.push('', 'saved outputs:', ...value.artifacts.map((file) => `  ${file}`))
  if (value.truncated === true) parts.push('', '(output truncated; raise maxOutputChars or write results to a file to see everything)')
  return parts.join('\n')
}
