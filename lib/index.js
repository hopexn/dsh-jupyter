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
import { AssetStore } from './assets.js'
import { NotebookActivity, registerContextInjection } from './activity.js'
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
  // Images are stored once by content hash and served from their own route, so a notebook document
  // stays kilobytes even when it is full of plots.
  const assets = new AssetStore()
  // What the user does in the panel is context for the model: a cell they ran changed the kernel
  // the agent is reasoning about. Notes are buffered here and handed over at the agent's next step.
  const activity = new NotebookActivity()
  const notebooks = new Notebooks({
    execute: (sessionId, code, options) => runtime.execute(sessionId, code, options),
    // The panel re-reads this on every click; a short memo keeps that off the network without
    // making the header lie for longer than a couple of seconds.
    kernelInfo: (sessionId) => runtime.sessionKernel(sessionId, { maxAgeMs: 2000 }),
    asset: (mime, base64) => assets.put(mime, base64),
    // An exported `.ipynb` needs the bytes back: a cell keeps a hash, not a picture.
    readAsset: (name) => assets.get(name),
    activity,
  })
  notebooks.setKernelAction(async (action, sessionId) => {
    const verb = action === 'restartKernel' ? 'restart' : action === 'interrupt' ? 'interrupt' : 'start'
    return (await runtime.kernelAction(sessionId, verb, {})).message
  })
  ctx.effect(() => () => notebooks.dispose(), 'jupyterlab.notebooks')
  // The outline rides along with the first note, so the model has a map before it is told that
  // "cell 3" changed.
  registerContextInjection(ctx, { activity, notebooks })
  // The panel route registers only once Connection is actually provided, which is later than this
  // plugin's own mount on a cold boot. Its outcome is reported by `jupyter_status`, so a route that
  // never registered is visible instead of appearing as a 404 in the browser.
  const panel = { state: 'pending' }
  registerNotebookRoutes(ctx, {
    notebooks,
    assets,
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
  ctx.tools.register(executeTool(runtime, notebooks))
  ctx.tools.register(notebookTool(notebooks))
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
  'JupyterLab address. `jupyter_notebook` reads and edits the notebook in the user\'s side panel —',
  'call it when the user refers to cells they wrote, instead of guessing their contents.',
  'When the user names a JupyterLab address, pass it to `jupyter_connect`',
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
      // Both lookups are independent network round trips, so they overlap. The probe result is
      // captured rather than thrown so a slow-but-failing probe never becomes an unhandled
      // rejection while the kernel lookup is still in flight.
      const kernelProbe = runtime.sessionKernel(sessionKey(exec), { signal: exec.signal }).catch(() => undefined)
      if (args.probe === false) {
        const sessionKernel = await kernelProbe
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
      const serverProbe = runtime.probe({ signal: exec.signal }).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
      const [sessionKernel, probed] = await Promise.all([kernelProbe, serverProbe])
      if (probed.ok) {
        const probe = probed.value
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
      }
      return {
        panel: panel.state,
        configured: settings.url !== undefined,
        reachable: false,
        ...(settings.url === undefined ? {} : { url: settings.url }),
        kernels: [],
        ...(sessionKernel === undefined ? {} : { sessionKernel }),
        message: 'the Jupyter server could not be reached',
        error: probed.error instanceof Error ? probed.error.message : String(probed.error),
      }
    },
  })
}

/** `jupyter_execute` — run code in the session's persistent kernel. */
function executeTool(runtime, notebooks) {
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
      const sessionId = sessionKey(exec)
      // The panel is the session's record of the analysis, so a run the model performs belongs in
      // it too — otherwise the notebook shows the user's half of the conversation and silently
      // omits everything the agent did to the shared kernel. A call with no owning agent has no
      // panel to write to, and is left alone.
      let recorder
      if (exec?.agent?.session?.header?.id !== undefined) {
        try {
          recorder = notebooks?.beginAgentRun(sessionId, args.code)
        } catch {
          recorder = undefined
        }
      }
      let execution
      try {
        execution = await runtime.execute(sessionId, args.code, {
          timeoutMs: args.timeoutMs,
          signal: exec.signal,
          storeHistory: args.storeHistory !== false,
          ...(recorder === undefined ? {} : { onOutput: recorder.onOutput }),
        })
      } catch (error) {
        // A failed tool call is still a fact the panel should show; then the error travels on.
        try { recorder?.fail(error) } catch { /* never mask the original failure */ }
        throw error
      }
      // Recording is a convenience, never a reason to fail a successful execution.
      try { recorder?.finish(execution) } catch { /* the cell simply stays as it was */ }
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

/**
 * `jupyter_notebook` — read and edit the notebook shown in the user's panel.
 *
 * `jupyter_execute` runs code the model wrote; this is the other half of the shared document: it
 * can see the cells the user wrote (and the outputs they produced), and change them. Without it a
 * context note saying "cell 3" is a reference into a document the model cannot open.
 */
function notebookTool(notebooks) {
  return defineJupyterTool({
    name: 'jupyter_notebook',
    description: [
      'Read or edit the notebook shown in the user\'s Jupyter panel. It is the same notebook the',
      'user sees, and its code cells run in the same kernel as `jupyter_execute`. Actions:',
      '"read" lists cells with their index, id, source and output; "add" inserts a cell (at the',
      'end, or after `afterId`); "update" rewrites a cell\'s source or kind; "delete" removes one;',
      '"run" executes a stored cell and returns what it printed. Cell ids come from "read". Pass',
      '`ifRevision` (the cell\'s `rev`) with update, delete or run to refuse the change if the user',
      'edited the cell after you read it.',
    ].join(' '),
    spec: {
      action: {
        type: 'string',
        required: true,
        enum: ['read', 'add', 'update', 'delete', 'run'],
        description: 'Which notebook operation to perform.',
      },
      id: { type: 'string', description: 'Cell id from a "read". Required for update, delete and run.' },
      kind: { type: 'string', enum: ['code', 'markdown'], description: 'Cell kind for "add" or "update".' },
      source: { type: 'string', description: 'Cell text for "add" or "update".' },
      afterId: { type: 'string', description: 'Insert the new cell after this cell id; by default it is appended.' },
      ifRevision: { type: 'number', description: 'The cell’s rev from your last "read". The call fails rather than overwriting a newer edit.' },
      from: { type: 'number', description: 'First cell to read, one-based. Defaults to 1.' },
      count: { type: 'number', description: 'How many cells to read. Defaults to 40.' },
    },
    output: {
      schema: objectSchema({
        action: { type: 'string' },
        message: { type: 'string' },
        revision: { type: 'integer' },
        path: { type: 'string' },
        total: { type: 'integer' },
        cells: {
          type: 'array',
          items: objectSchema({
            index: { type: 'integer' },
            id: { type: 'string' },
            kind: { type: 'string' },
            origin: { type: 'string' },
            rev: { type: 'integer' },
            status: { type: 'string' },
            executionCount: { type: 'integer' },
            durationMs: { type: 'integer' },
            source: { type: 'string' },
            sourceTruncated: { type: 'boolean' },
            output: { type: 'string' },
          }),
        },
        id: { type: 'string' },
        status: { type: 'string' },
        executionCount: { type: 'integer' },
        durationMs: { type: 'integer' },
        output: { type: 'string' },
        error: { type: 'string' },
      }, ['action', 'message']),
      render: (_args, value) => [{ type: 'text', text: renderNotebook(value) }],
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const sessionId = sessionKey(exec)
      if (args.action === 'read') {
        const snapshot = notebooks.snapshot(sessionId, { from: args.from ?? 1, count: args.count ?? 40 })
        return {
          action: 'read',
          revision: snapshot.revision,
          ...(snapshot.path === null ? {} : { path: snapshot.path }),
          total: snapshot.total,
          cells: snapshot.cells,
          message: snapshot.total === 0
            ? 'the panel has no notebook for this session yet; opening it starts one empty cell'
            : `${snapshot.total} cell(s), showing ${snapshot.cells.length}`,
        }
      }
      if (args.action === 'add') {
        if (typeof args.source !== 'string') throw new Error('action "add" needs a "source" string (it may be empty)')
        if (args.afterId !== undefined) {
          const exists = notebooks.snapshot(sessionId, { count: Number.MAX_SAFE_INTEGER })
            .cells.some((cell) => cell.id === args.afterId)
          // Without this the command treats an unknown id as "append", and the tool would report
          // the wrong cell as the one it created.
          if (!exists) throw new Error(`cell ${args.afterId} is not in this notebook; read it first`)
        }
        const view = await notebooks.command(sessionId, {
          action: 'addCell',
          source: args.source,
          origin: 'agent',
          ...(args.kind === undefined ? {} : { kind: args.kind }),
          ...(args.afterId === undefined ? {} : { afterId: args.afterId }),
        }, {}, { note: false })
        const index = args.afterId === undefined
          ? view.cells.length - 1
          : view.cells.findIndex((cell) => cell.id === args.afterId) + 1
        const created = view.cells[index]
        return {
          action: 'add',
          message: `added cell ${index + 1}${created === undefined ? '' : ` (${created.kind})`}; run it with action "run"`,
          revision: view.revision,
          ...(created === undefined ? {} : { id: created.id }),
        }
      }

      // Everything else targets one stored cell, so it starts from the same guarded lookup.
      if (typeof args.id !== 'string' || args.id.length === 0) {
        throw new Error(`action "${args.action}" needs a cell "id" from action "read"`)
      }
      const snapshot = notebooks.snapshot(sessionId, { count: Number.MAX_SAFE_INTEGER })
      const cell = snapshot.cells.find((candidate) => candidate.id === args.id)
      if (cell === undefined) {
        throw new Error(`cell ${args.id} is not in this notebook; call action "read" for the current cells`)
      }
      if (typeof args.ifRevision === 'number' && cell.rev !== args.ifRevision) {
        throw new Error(`cell ${cell.index} changed since you read it (rev ${cell.rev}, you passed ${args.ifRevision}); read it again`)
      }

      if (args.action === 'update') {
        if (args.source === undefined && args.kind === undefined) {
          throw new Error('action "update" needs a "source" or a "kind"')
        }
        await notebooks.command(sessionId, {
          action: 'updateCell',
          id: args.id,
          // Marks the rewrite as the model's: the panel keeps the replaced text and shows a diff,
          // rather than swapping the user's code out from under them.
          origin: 'agent',
          ...(args.source === undefined ? {} : { source: args.source }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
        }, {}, { note: false })
        return {
          action: 'update',
          message: `updated cell ${cell.index}`,
          id: args.id,
          revision: notebooks.revision(sessionId),
        }
      }

      if (args.action === 'delete') {
        await notebooks.command(sessionId, { action: 'deleteCell', id: args.id }, {}, { note: false })
        return {
          action: 'delete',
          message: `deleted cell ${cell.index}`,
          revision: notebooks.revision(sessionId),
        }
      }

      // `run`
      const outcome = await notebooks.runCellNow(sessionId, args.id)
      return {
        action: 'run',
        message: `ran cell ${cell.index} (${cell.kind})`,
        id: args.id,
        status: outcome.status,
        ...(outcome.executionCount === null || outcome.executionCount === undefined ? {} : { executionCount: outcome.executionCount }),
        ...(outcome.durationMs === null || outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
        ...(outcome.output === undefined || outcome.output.length === 0 ? {} : { output: outcome.output }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        revision: notebooks.revision(sessionId),
      }
    },
  })
}

/** Model-facing text for {@link notebookTool}. */
function renderNotebook(value) {
  const lines = [value.message]
  if (value.id !== undefined) lines.push(`id: ${value.id}`)
  if (value.path !== undefined) lines.push(`path: ${value.path}`)
  if (value.revision !== undefined) lines.push(`revision: ${value.revision}`)
  if (value.status !== undefined) {
    const meta = [value.status]
    if (value.executionCount !== undefined) meta.push(`execution_count ${value.executionCount}`)
    if (value.durationMs !== undefined) meta.push(`${(value.durationMs / 1000).toFixed(2)}s`)
    lines.push(meta.join(' · '))
  }
  if (value.output !== undefined && value.output.length > 0) lines.push('', 'output:', value.output)
  if (value.error !== undefined) lines.push('', 'error:', value.error)
  for (const cell of value.cells ?? []) {
    const flags = [cell.kind, cell.id]
    if (cell.origin === 'agent') flags.push('agent')
    lines.push('', `--- cell ${cell.index} · ${flags.join(' · ')} ---`)
    const meta = [`rev ${cell.rev}`, cell.status]
    if (cell.executionCount !== null && cell.executionCount !== undefined) meta.push(`Out[${cell.executionCount}]`)
    if (cell.sourceTruncated === true) meta.push('source truncated')
    lines.push(meta.join(' · '))
    lines.push(cell.source.length === 0 ? '(empty)' : cell.source)
    if (typeof cell.output === 'string' && cell.output.length > 0) lines.push('', 'output:', cell.output)
  }
  return lines.join('\n')
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
