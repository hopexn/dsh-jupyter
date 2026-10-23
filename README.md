# JupyterLab for DeepSeek Harness

A DeepSeek Harness bundle that connects the harness to a Jupyter server. Give it a JupyterLab
address — `http://aimax395.local:9002/lab` — and the agent can run code in a **persistent remote
kernel**: variables, imports and the working directory survive between tool calls, so a
conversation can build up an analysis the way a notebook session does.

Nothing runs locally: the plugin speaks Jupyter Server's REST API and kernel messaging protocol
directly over `fetch` and a WebSocket, with no Python, no `jupyter_client`, and no npm
dependencies beyond the packages DSH itself ships.

## What the agent gets

| Tool | Purpose |
| --- | --- |
| `jupyter_connect` | Point the harness at a JupyterLab address and verify the credentials. Normalizes `/lab`, `/tree` and `?token=...`; reports the server version, kernelspecs and running kernels. |
| `jupyter_status` | Connection, server version, kernelspecs, running kernels, and which kernel this conversation is bound to. |
| `jupyter_execute` | Run code in the session's kernel; returns stdout, the value of the last expression, stderr, tracebacks, and paths of saved image/PDF outputs. |
| `jupyter_kernel` | `list`, `start`, `restart`, `interrupt`, `shutdown`, or `attach` to a kernel that already exists on the server. |

Sessions are bound per DeepSeek Harness conversation, so two chats do not share a namespace. The
binding is mirrored to `$DSH_HOME/jupyterlab/kernels.json`, which means a plugin reload or an app
restart re-attaches to the same kernel instead of silently starting an empty one.

## The notebook panel

The plugin also puts a notebook in the **right sidebar**, beside the conversation:

- **Cells**: `+ Cell` adds one below the last, `✕` deletes, `↑`/`↓` reorder, `⌫` clears one cell's
  output, and the toolbar's `Clear outputs` empties them all.
- **Edit**: double-click a cell's source to edit it in place; `Done`, `Escape` or running it commits
  the change. Clicking `Run` runs the cell as it stands.
- **Run**: `Shift+Enter` in the editor saves and runs — the same gesture as JupyterLab. Outputs
  render beneath the cell: stdout, stderr, the value of the last expression, tracebacks, and images
  (PNG/JPEG/GIF/WebP) inline.
- **Kernel**: the header shows the bound kernel and offers `Interrupt` and `Restart kernel`.

**The panel and the agent share one kernel.** A variable defined in a cell is visible to
`jupyter_execute` and vice versa, in both directions and immediately — there is no separate
"notebook kernel". Concurrency is handled by the same per-kernel queue, so a cell you run while the
agent is executing simply waits its turn.

Cells are mirrored to `$DSH_HOME/jupyterlab/notebooks/<session>.json`, so a page reload or an app
restart restores them.

### Opening it

The panel opens itself once when a session first mounts. After that:

- the **Notebook** button in the composer's tool row reopens it;
- the right sidebar's **+** control lists it as a page (the guide entry);
- once opened, the layout is remembered per session and restored on the next page load.

Closing it costs nothing: the right column collapses, and the same button brings it back.

`attach` is the bridge to interactive work: start a kernel in JupyterLab, then have the agent
attach to it and pick up the variables you already defined.

## Install

From this directory, in a DeepSeek Harness session:

```
plugin_manager { action: "install_bundle", target: "/Users/yanhaopeng/MyProjects/dsh-jupyterlab" }
```

The bundle is installed into the current profile, added to `dsh.profile.bundles`, and activated
through HMR. Read the result's `application` field — `applied` means it is live.

A **first** install needs one app restart, for two independent reasons: the host half imports
nothing, but Node caches an already-imported module by URL, so a running process keeps the code it
first loaded; and the host resolves a package's client bundle from the manifest it read at boot.
After that restart, host-half edits still need a restart while client-half edits are picked up by a
page refresh. If the host half's
imports of `@deepseek-ai/*` packages cannot be resolved in the running process, restart the
DeepSeek Harness app once; after that, source edits are picked up from this directory.

## Configure

`url` is the only field that matters to get started; everything else has a default.

**Let the agent do it.** The plugin loads with no configuration at all. Say "connect to
http://aimax395.local:9002/lab with token XYZ" and the agent calls `jupyter_connect`. Runtime
settings last until the plugin remounts.

**Or write it into the profile.** Add a `config:` mapping to the plugin's row in
`$DSH_PROFILE_DIR/cordis.patch.yml`, which overrides the bundle's own patch:

```yaml
- id: jupyterlab
  name: '@local/dsh-jupyterlab'
  config:
    url: http://aimax395.local:9002/lab
    token: <your token>
    kernelName: python3
```

### Credentials

Jupyter accepts either a token or a password, and both are supported:

- **token** — the `?token=...` from `jupyter server list`, the server's console output, or the URL
  JupyterLab opens with. Highest priority; if the `url` itself carries `?token=...`, it is used
  automatically.
- **password** — the plaintext password you type into the JupyterLab login page. The plugin
  performs the `/login` form flow (including `_xsrf`) and replays the session cookie on REST calls
  and on the kernel WebSocket upgrade.

A password *hash* from `jupyter_server_config.json` (the `argon2:$argon2id$...` value) is not a
credential: it cannot be replayed and will be rejected. Use the plaintext password, or a token.

A credential belongs to the host it was entered for. Pointing the harness at a **different**
address drops the previous token/password unless the same call supplies a replacement, so a
connect to a new server can never disclose the old server's secret to it.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | — | JupyterLab address. `/lab`, `/tree`, trailing slashes and `?token=...` are understood. |
| `token` / `password` / `username` | — | Credentials; `token` wins. |
| `kernelName` | `python3` | Kernelspec started for a new session kernel. |
| `workingDirectory` | server root | Server-relative directory the kernel starts in. |
| `requestTimeoutMs` | `20000` | Budget for one REST call. |
| `executeTimeoutMs` | `180000` | Budget for one execution before the kernel is interrupted. |
| `autoStartKernel` | `true` | Start a kernel on first execution. |
| `maxOutputChars` | `20000` | Streamed output kept per execution (head and tail). |
| `artifactDirectory` | `$DSH_HOME/jupyterlab/artifacts` | Where image/PDF outputs are written. |

## How it works

```
lib/index.js    Cordis plugin: Config schema, system-prompt guidance, the four tool definitions
lib/runtime.js  Connection + kernel-session state: one kernel per DSH session, re-attach, mirror to disk
lib/server.js   Jupyter Server REST client: URL normalization, token/password auth, XSRF, cookie jar
lib/kernel.js   Kernel messaging protocol over WebSocket: execute, collect iopub outputs, interrupt
lib/notebook.js The panel's model: cells, outputs, run, and the on-disk mirror
lib/routes.js   The one authenticated same-origin route the panel talks to
lib/client.js   Browser half: the right-sidebar tab type and the notebook UI (no build step)
```

Design notes worth knowing:

- **The plugin never fails to load.** `url` is optional and the REST client is built lazily, so a
  missing or wrong address surfaces as one readable tool error instead of an activation failure.
- **Execution is serialized per kernel.** iopub carries no request id, so concurrent executions on
  one kernel would interleave their output. Each call queues behind the previous one.
- **Cancellation interrupts the kernel.** `exec.signal` (from the tool timeout policy or the user)
  and the execution budget both send `POST /api/kernels/<id>/interrupt`, then return whatever the
  cell printed before stopping. The kernel and its variables stay alive.
- **A dead kernel is detected before code is sent.** If the channel is closed, the binding is
  verified against `GET /api/kernels/<id>` and either re-attached or replaced. A transient
  reconnect failure never shuts a kernel down; only an explicit `jupyter_kernel start` does.
- **Errors are readable, not stack traces.** Wrong credentials report `authentication failed`;
  an unreachable host reports the address and the routing hint; a non-Jupyter URL reports that the
  response was not JSON. A rejected password (401) is reported differently from a rejected XSRF
  token (403), because the two need different fixes.
- **Cookie sessions carry an XSRF token.** Jupyter checks XSRF on every mutating request, and
  skips that check only for header-authenticated (token) calls. A password session therefore sends
  the `_xsrf` value as an `X-XSRFToken` header on every POST and DELETE — without it, login
  succeeds and reads work, but starting a kernel fails with `'_xsrf' argument missing from POST`.
- **The panel route registers on a dynamic injection.** The `connection` entry that owns `/api`
  waits on its own inject chain, so on a cold boot it is routinely *not yet provided* when a plugin
  mounting later runs `apply`. Reading the service once and giving up silently produced the worst
  possible symptom — a panel that loads and then answers 404 to everything — so the route goes
  through `ctx.inject(['connection'], …)`, and `jupyter_status` reports whether it registered.
- **A cell the kernel dropped is retried once.** Immediately after an interrupt, Jupyter answers
  the next `execute_request` with `status: "aborted"` — the cell never ran. That is reported as
  `aborted` (never as a silent empty success) and retried once, which is safe precisely because
  nothing executed the first time.

## Verifying a change

Two test suites run against a live Jupyter server. Start a throwaway one **without** weakening
its security defaults — a server started with `disable_check_xsrf` hides real authentication bugs,
which is exactly how the missing `X-XSRFToken` header survived the first round of testing here:

```bash
# Token auth.
jupyter server --no-browser --port=9003 \
  --IdentityProvider.token=dsh-test-token --ServerApp.root_dir=/tmp/dsh-jupyter-test

# Password auth (the configuration a typical deployment uses). The trait is
# `IdentityProvider.hashed_password`; a bare `password` option is silently ignored, which looks
# exactly like a wrong password.
python -c "from jupyter_server.auth import passwd; print(passwd('dsh-test-password'))"
jupyter server --no-browser --port=9004 \
  --IdentityProvider.hashed_password='<hash from above>' --ServerApp.root_dir=/tmp/dsh-jupyter-test
```

Then:

```bash
node test/e2e.mjs        # protocol and runtime: auth, execute, persistence, timeout, kernel lifecycle
node test/register.mjs   # mounts the plugin in a real cordis context with the real dsh-tools registry
node test/notebook.mjs   # the panel's model and its HTTP route, driven with real Request objects
node test/client.mjs     # the browser bundle: registrations, render paths, click and key handlers

# The password path (login form, XSRF, cookie session) — run this before trusting a deployment:
JUPYTER_TEST_URL=http://127.0.0.1:9004/lab JUPYTER_TEST_PASSWORD=dsh-test-password node test/e2e.mjs

# Any other server, including the real one:
JUPYTER_TEST_URL=http://host:9002/lab JUPYTER_TEST_PASSWORD=... node test/e2e.mjs
JUPYTER_TEST_URL='http://host:9002/lab?token=...' node test/e2e.mjs
```

`test/e2e.mjs` needs no DSH packages. `test/register.mjs` imports `@deepseek-ai/cordis` and
`@deepseek-ai/dsh-tools`, which resolve inside a DSH host process; outside one, link them (this is
a development-only link, never part of the installed plugin):

```bash
ln -s <extracted-dsh-packages>/node_modules node_modules
```

Both suites take `JUPYTER_TEST_URL`, `JUPYTER_TEST_TOKEN`, and `JUPYTER_TEST_PASSWORD`.

## Limitations

- **The panel is a notebook, not JupyterLab.** JupyterLab sends `Content-Security-Policy:
  frame-ancestors 'self'`, so it cannot be framed in the Harness UI; the panel is a native
  reimplementation of the notebook surface instead. It supports code cells with add, edit, delete,
  run and reorder — no markdown cells, no completion, no variable inspector, no `.ipynb` import or
  export yet.
- **Configuration has no form.** A packaged profile has no schema-driven settings UI without a
  hand-built client bundle, so the address and credentials come from the profile YAML or a
  `jupyter_connect` call.
- **The config schema is validated but not projected.** Because the plugin is import-free, its
  `Config` is a hand-written Standard Schema rather than a schemastery one, so Cordis still
  validates and defaults every option (a bad value fails activation with a readable message), but
  the `Config` inspect provider reports `unsupported` instead of rendering a JSON Schema.
- **One server at a time.** The runtime holds a single connection; `jupyter_connect` switches it.
- **Code execution only.** The Contents API (reading and writing notebook files on the server) is
  not exposed yet.
- Kernels are left running when a DSH session ends; shut them down with `jupyter_kernel` or in
  JupyterLab.
