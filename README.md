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
  output, and the toolbar's `Clear outputs` empties them all. The `Py`/`MD` chip in a cell's header
  switches it between code and markdown; a markdown cell renders instead of running, and never
  touches the kernel.
- **Edit**: double-click a cell's source to edit it in place; `Done`, `Escape` or running it commits
  the change. Clicking `Run` runs the cell as it stands. Code is syntax-highlighted both at rest
  and while typing: the editor is a transparent textarea over a coloured copy of its own text, so
  the caret, selection and IME stay native (the layer steps aside while an IME composes).
- **Run**: `Shift+Enter` in the editor saves and runs — the same gesture as JupyterLab, and one
  request: the cell's draft travels with the run instead of being saved first. Outputs render
  beneath the cell: stdout, stderr, the value of the last expression, tracebacks, images
  (PNG/JPEG/GIF/WebP), markdown, and HTML.
- **Rich output**: a MIME bundle is rendered by its richest representation the panel can draw.
  `text/html` — what pandas, polars and Styler emit — mounts as a real table inside a shadow root,
  so its own CSS applies while it cannot reach the panel; the HTML is stripped of scripts and event
  handlers first. `text/markdown` renders through the panel's own markdown parser (headings, lists,
  tables, code fences with highlighting). `text/plain` is the fallback, and anything past 256 KiB
  of markup falls back to it deliberately.

- **Watched while it runs**: `Run` answers as soon as the kernel has the code, and the output is
  pushed to the panel over a stream as it is produced. A cell that prints for a minute shows its
  first line after a second, and closing or reloading the page does not stop it.
- **Told to the agent**: an edit, a run (with its outcome and the tail of what it printed), a
  deletion, a cleared output — each is queued for the model and delivered with its next step as a
  context note attributed to this plugin, not as something the user typed. The header shows how
  many notes are waiting (`2 queued`). A run's start is replaced by its result, so the model sees
  one accurate note per cell rather than a stream of them.
- **Live**: while the panel is visible it also polls the host, carrying the revision it already has,
  so a cell the agent ran in the shared kernel appears without a click. When nothing changed the
  answer is two fields and never reaches Jupyter.
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

### If the address is a `.local` name

On macOS, resolving a `host.local` name takes about five seconds: `mDNSResponder` multicasts first
and only then falls back to `/etc/hosts`. The plugin pays that once per process (the cache is warmed
at mount, and every later request or kernel handshake reuses it), never per click. To remove even
that one, give the machine a name without the `.local` suffix:

```bash
sudo scripts/alias-host.sh aimax395 192.168.5.200   # /etc/hosts: 192.168.5.200 aimax395
```

then set `url: http://aimax395:9002/lab`. The script is idempotent and backs up `/etc/hosts` before
touching it. It is a convenience for this machine, not part of the package.

## How it works

```
lib/index.js     Cordis plugin: Config schema, system-prompt guidance, the four tool definitions
lib/runtime.js   Connection + kernel-session state: one kernel per DSH session, re-attach, mirror to disk
lib/server.js    Jupyter Server REST client: URL normalization, token/password auth, XSRF, cookie jar
lib/transport.js HTTP over node:http/https: keep-alive sockets, buffered responses, abort handling
lib/dns-cache.js Process-wide name-resolution cache, plugged into http and the kernel socket
lib/websocket.js Minimal RFC 6455 client for the kernel channel: masking, fragmentation, ping/pong
lib/kernel.js    Kernel messaging protocol over that socket: execute, stream iopub outputs, interrupt
lib/notebook.js  The panel's model: cells, incremental output rendering, background runs, mirror
lib/activity.js  What the user did in the panel, buffered and handed to the model at its next step
lib/assets.js    Content-addressed image store: one file per unique picture, served immutable
lib/routes.js    The panel's three authenticated same-origin routes (view/command, stream, assets)
lib/client.js    Browser half: the right-sidebar tab type and the notebook UI (no build step)
```

Design notes worth knowing:

- **The transport is `node:http`, not `fetch`, because `fetch` re-resolves the hostname.** A Jupyter
  server addressed by a mDNS name (`http://aimax395.local:9002/lab`) costs **about five seconds per
  `getaddrinfo` call** on macOS — `mDNSResponder` multicasts first and only then falls back to
  `/etc/hosts`. `fetch` and the built-in `WebSocket` both resolve the name themselves, per
  connection, with no way to pass a resolver, and connecting to the raw IP instead is refused by
  Jupyter, which checks the `Host` header (a valid token plus a mismatched `Host` is a 403).
  `node:http` solves all of it: a custom `lookup` goes through `dns-cache.js`, the name still
  arrives as `Host` and as TLS SNI, and a keep-alive agent means a second request costs only the
  round trip. Measured against the server above: a panel click went from **5 020 ms to 6 ms**, and
  a warm `jupyter_execute` from **10 122 ms to 83 ms**.
- **The kernel channel uses its own WebSocket client** for the same reason, plus one more: the
  handshake is the one place where the `Host` header must stay correct *and* the resolver must be
  ours. `lib/websocket.js` implements only what the kernel protocol needs.
- **Name resolution is warmed at mount.** The single five-second lookup is unavoidable per process,
  so `runtime` starts it when the plugin mounts instead of leaving it for the first tool call; the
  result lands in the cache the transport reads.
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
- **A panel run is owned by the model, not by the request.** `POST runCell` answers in milliseconds
  and the execution continues without an HTTP request attached to it. Output leaves the kernel's
  iopub channel as it is produced, is coalesced for 60 ms (one frame per message would cost more
  than the rendering it feeds), and travels to the browser over SSE on
  `/api/jupyterlab/notebook/stream`. A `cell` event closes the run with the authoritative state.
  This is also why reloading the page no longer interrupts the cell: previously the abort of the
  POST was wired all the way to `POST /api/kernels/<id>/interrupt`.
- **A run's output is rendered twice, on purpose.** Incrementally while it runs, so the panel grows;
  then once more from the kernel's final output list, so the cell the user keeps — and the mirror on
  disk — is byte-identical to what a non-streamed run would have produced.
- **Panel activity reaches the model as context, not as a chat message.** The user edits and runs
  cells in the very kernel the agent uses, so without a note the agent's next request describes a
  notebook that no longer exists — a variable redefined, an output cleared, a cell deleted. Notes
  are buffered per session and appended to the step's messages in `agent/pre-step`, the same
  waterfall `time-context` and `agent-instructions` use, with
  `source: { kind: 'plugin', plugin: 'jupyterlab', form: 'notice' }`; the transcript shows them as
  a collapsed context row instead of user speech. Two guards matter: a rejected or aborted step
  keeps its notes, and a first step with no message is never turned into a model call by a note —
  an edit is context for a conversation, not a reason to start one. A run's start and end share
  one key, so only the outcome survives.
- **Images are addressed by their content.** `lib/assets.js` hashes the bytes and writes one file
  per unique picture; the cell keeps `api/jupyterlab/asset?name=<hash>.png` and the route answers
  with `immutable`. Running the same plot again re-uses the URL, a notebook with ten figures costs
  ten files instead of a multi-megabyte document, and every click no longer re-serializes the
  pictures. (The route takes the name in a query parameter because `connection.fetch` matches
  **exact** pathnames — a path segment would 404.)
- **`React.memo` needs stable props, so the panel provides them.** Each cell carries a `rev`
  counter; a view fetched from the host reuses the previous cell object when the `rev` still
  matches, and every handler is created once and reads current state from a ref. Without that,
  re-rendering a hundred cells on every poll was the cost the transport work had just removed
  from the host.
- **The highlighter is a tokenizer, not a parser.** There is no build step and no client package,
  so one regex pass with a deliberate priority — IPython magic at a line start, then comments, then
  strings, then numbers, names and operators — produces the coloured runs the editor draws. It
  cannot be wrong about a string that contains a `#`, which is the failure that matters; it does not
  try to colour f-string expressions or parenthesis depth. The markdown parser follows the same
  principle: block structure by line, inline spans by one regex, every node built through
  `createElement` rather than an HTML string.
- **Kernel HTML is mounted, not injected.** An output is whatever the cell decided to print, so it
  is parsed with `DOMParser`, stripped of `script`/`iframe`/`object`/`link`/`meta`/`base`/`form`,
  every `on*` attribute, `srcdoc`, and `javascript:` URLs, then appended to a **shadow root** on its
  own host element. A shadow root gives the table its natural height and full CSS isolation: pandas'
  `style scoped` and a Styler's rules apply to it, and neither they nor `body { display: none }`
  can affect the panel. It is the same trick JupyterLab uses an iframe for, without the iframe's
  fixed height.

## Documentation

- **`docs/design.md`** — the design and the index: how the two halves fit together, where each
  concern lives (file + symbol), and the reasons behind the decisions that look odd. **Read it
  first when changing code**; `AGENTS.md` gives agents the same instruction.
- **`docs/performance-review.md`** — what was slow, what was measured, what changed, and the
  headroom that is still open.
- **`docs/dsh-client-plugin-contract.md`** — the host/plugin contract this panel was built
  against, extracted from the shipped packages as reference.

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
node test/notebook.mjs   # the panel's model, its three routes, streaming events and the asset store
node test/activity.mjs   # activity notes: wording, batching, and the agent/pre-step delivery guards
node test/client.mjs     # the browser bundle: registrations, render paths, clicks, stream patches
node test/transport.mjs  # DNS cache, socket reuse, Host header, and the WebSocket frame codec

# The password path (login form, XSRF, cookie session) — run this before trusting a deployment:
JUPYTER_TEST_URL=http://127.0.0.1:9004/lab JUPYTER_TEST_PASSWORD=dsh-test-password node test/e2e.mjs

# Any other server, including the real one:
JUPYTER_TEST_URL=http://host:9002/lab JUPYTER_TEST_PASSWORD=... node test/e2e.mjs
JUPYTER_TEST_URL='http://host:9002/lab?token=...' node test/e2e.mjs
```

`test/transport.mjs` needs no Jupyter server: it starts its own HTTP and WebSocket peers on
127.0.0.1, counts the sockets the client opens, and round-trips frames of every length class.

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
  reimplementation of the notebook surface instead. It supports code and markdown cells with add,
  edit, delete, run, reorder and type switching — no completion, no variable inspector, no `.ipynb`
  import or export yet.
- **Output support is a chosen subset.** Images, `text/html`, `text/markdown` and text are rendered;
  `application/json`, LaTeX and arbitrary MIME types are not (a `display_data` carrying only those
  names its MIME types instead of drawing them). HTML is sanitized rather than trusted, so an output
  that relies on its own `<script>` — an interactive widget, a plotly figure — renders its static
  markup only.
- **A cell's output streams while it runs.** `Run` answers as soon as the kernel has the code, and
  iopub output is pushed to the panel as it is produced, so a cell that prints for a minute shows
  its first line after a second. The interrupt button stays reachable throughout.
- **Panel notes arrive at the next step.** A queued note is context for the next model request, not
  a message sent on the user's behalf: editing a cell while the agent is idle updates the badge and
  sends nothing until the conversation continues. Nothing is injected into a request already in
  flight.
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
