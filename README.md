# JupyterLab for DeepSeek Harness

English · [简体中文](README.zh-CN.md)

A DeepSeek Harness bundle that connects the harness to **one or more Jupyter servers**. Point it at
a JupyterLab address and the agent can run code in a **persistent remote kernel**: variables,
imports and the working directory survive between tool calls. A local server and a remote machine
can be connected at once, and every notebook page in the right sidebar runs on the server it is
bound to.

Nothing runs locally: the plugin speaks Jupyter Server's REST API and kernel protocol directly,
with no Python and no npm dependencies beyond the packages DeepSeek Harness ships.

## What the agent gets

| Tool | Purpose |
| --- | --- |
| `jupyter_connect` | Add a JupyterLab connection and verify its credentials. Other connections stay connected; the new one becomes the default. |
| `jupyter_status` | Every connected server, the default one's version and kernels, and the kernel this conversation is bound to. |
| `jupyter_execute` | Run code in the panel page's kernel (or a named connection). Returns stdout, the last expression, errors and saved image/PDF paths. The run is recorded as an `Agent` cell. |
| `jupyter_notebook` | Read, add, update, delete or run a cell in the panel's notebook. An update leaves a reviewable diff instead of silently replacing your code. |
| `jupyter_kernel` | List, start, restart, interrupt, shutdown or attach kernels on a server. |

Kernels are bound per conversation and per server, and the bindings are mirrored to
`$DSH_HOME/jupyterlab/kernels.json`, so a reload or app restart re-attaches instead of starting an
empty kernel.

## The panel

The notebook lives in the **right sidebar**, beside the conversation:

- **Cells**: add, delete, insert below, reorder, clear output; code and markdown; syntax
  highlighting in the kernel's own language.
- **Edit in place**: `Shift+Enter` runs and leaves, `Ctrl/Cmd+Enter` runs in place, `Ctrl/Cmd+S`
  saves, `Tab`/`Shift+Tab` indent, `Enter` keeps indentation, `Esc` leaves. IME composition is left
  to the IME.
- **Run**: `Run` answers as soon as the kernel has the code and streams the output as it is
  produced. `Run all` executes the code cells in order; the button turns into `Stop`.
- **Rich output**: images, `text/html` (sanitized, mounted in a shadow root), markdown, plain text.
  Long output folds.
- **Reviewable edits**: when the agent rewrites a cell, it gets a `Changed` chip with a line diff;
  `Keep` accepts it, `Undo` restores your version.
- **Several notebooks per session**: up to twelve, each with its own cells, output and export; they
  share the kernel of the server they are bound to.
- **Several servers per session**: the header picker chooses where the visible page runs, and
  `Connect…` adds a connection (name, address, password/token/proxy cookie). Each connection can be
  `Edit`ed (rename, replace a credential) or `Forget`ed. A loopback server is shown as `localhost`.
- **Drafts survive a reload**: uncommitted text is parked in the tab's `sessionStorage`.
- **Portable**: `Export` downloads the page as `.ipynb`; `Import` loads one.
- **Live**: runs the agent performs appear as `Agent` cells, and what you edit or run reaches the
  model as context on its next step (the header badge shows what is queued).

## Install

From a checkout of this repository, in a DeepSeek Harness session:

```
plugin_manager { action: "install_bundle", target: "<path to this repository>" }
```

The bundle is installed into the current profile and activated. A **first** install needs one app
restart. After that, host-side edits need a restart and browser-side edits only need a page refresh.

## Configure

`url` is the only field that matters to get started; everything else has a default.

**Let the agent do it.** The plugin loads with no configuration at all. Say "connect to
`http://jupyter.example.com:9002/lab` with token XYZ" and the agent calls `jupyter_connect`.
Runtime-added connections are remembered in `$DSH_HOME/jupyterlab/servers.json`.

**Or use the panel.** `Connect…` in the notebook header opens the connection list and a short form:
an optional name, the address, the auth mode (`Password` by default, `Token`, or `Proxy cookie
only`) and the credential.

**Or write it into the profile.** Add a `config:` mapping to the plugin's row in
`$DSH_PROFILE_DIR/cordis.patch.yml`, which overrides the bundle's own patch:

```yaml
- id: jupyterlab
  name: '@local/dsh-jupyterlab'
  config:
    name: local
    url: http://jupyter.example.com:9002/lab
    token: <your token>
    kernelName: python3
    # Optional: a second connection, ready before the panel is opened. Credentials belong to the
    # host they were entered for, so a token here is never sent to another server.
    servers:
      - name: GPU box
        url: http://gpu-box.example.com:9003/lab
        password: <the plaintext password>
        kernelName: python3
```

### Credentials

Jupyter accepts a token or a password, and both are supported:

- **token** — the `?token=...` from `jupyter server list`, the server's console output, or the URL
  JupyterLab opens with.
- **password** — the plaintext password you type into the JupyterLab login page. A password *hash*
  from `jupyter_server_config.json` cannot be replayed and is rejected.
- **proxy cookie** — see below, for deployments behind a corporate access gateway.

Credentials belong to the host they were entered for. Connections added at run time are stored in
`$DSH_HOME/jupyterlab/servers.json` (mode `0600`, plaintext like your profile config); servers named
in the profile are re-created from the profile on every start and are not copied there.

### Behind an SSO / access proxy

Some deployments put an SSO/access gateway in front of Jupyter. It answers every unauthenticated
path — `/lab`, `/api/status`, even Jupyter's own `/login` — with a redirect to its login page, so
neither a token nor a password ever reaches Jupyter. Sign in through the browser, then bring the
browser's cookie along:

1. Open the address in your browser and sign in as usual.
2. DevTools → **Network** → any request to that host → **Request Headers** → copy the `Cookie:`
   value.
3. In the panel: `Connect…` → address → auth mode `Proxy cookie only` (or `Password`/`Token` when
   Jupyter itself also wants one) → paste into **Proxy cookie** → `Connect`.

The cookie is sent on REST calls and on the kernel WebSocket upgrade, and its `_xsrf` value becomes
the XSRF header. It is stored with the connection, so a restart keeps it until the gateway session
expires; when it does, `Edit` the connection and paste a fresh one.

If a freshly pasted cookie is still redirected, the gateway is rejecting the replay (some bind the
session to a device or browser fingerprint). In that case use an address that is reachable directly,
or ask the deployment for a service token.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | — | JupyterLab address. `/lab`, `/tree`, trailing slashes and `?token=...` are understood. |
| `name` | — | Label shown in the panel instead of the address. Not part of the connection's identity. |
| `token` / `password` / `username` | — | Credentials; `token` wins. |
| `cookie` | — | Cookie header for an SSO/access proxy. |
| `servers` | — | Extra connections: `{url, name?, token?, password?, cookie?, kernelName?, workingDirectory?}`. |
| `kernelName` | `python3` | Kernelspec started for a new kernel. |
| `workingDirectory` | server root | Server-relative directory the kernel starts in. |
| `requestTimeoutMs` | `20000` | Budget for one REST call. |
| `executeTimeoutMs` | `180000` | Budget for one execution before the kernel is interrupted. |
| `autoStartKernel` | `true` | Start a kernel on first execution. |
| `maxOutputChars` | `20000` | Streamed output kept per execution (head and tail). |
| `artifactDirectory` | `$DSH_HOME/jupyterlab/artifacts` | Where image/PDF outputs are written. |

## Notes

- **The remote server must be reachable from the harness's own machine.** There is no SSH tunnel or
  port forwarding: a Jupyter that listens only on another machine's `127.0.0.1` cannot be reached
  through that machine's name. A DNS name, a routed IP or a gateway is fine.
- **A `.local` address costs one slow lookup per process.** On macOS, mDNS resolves such a name in
  about five seconds; the plugin pays it once at mount and caches it. An `/etc/hosts` alias avoids
  even that — `scripts/alias-host.sh` is a convenience for that, not part of the package.
- **`.ipynb` import and export are lossy.** Raw cells become markdown, output types the panel cannot
  draw are dropped, and oversized images or markup fall back or are dropped. Every loss is reported.
- **Credentials are plaintext files.** `servers.json` is mode `0600`; there is no keychain
  integration.

## Documentation

- **`docs/design.md`** — how the plugin is put together and why: transport, connections, kernel
  lifecycle, panel protocol, and the decisions behind them.
- **`docs/performance-review.md`** — measurements and the headroom that remains.
- **`docs/dsh-client-plugin-contract.md`** — the host/plugin contract the panel was built against.

## Verifying a change

```bash
npm test                  # offline suites, plus e2e and register when JUPYTER_TEST_URL is set
npm run test:offline      # transport, ipynb, notebook, activity, client
```

The e2e suites need a live Jupyter server. Start a throwaway one without weakening its security
defaults (a server started with `disable_check_xsrf` hides real authentication bugs):

```bash
# Token auth.
jupyter server --no-browser --port=9003 --IdentityProvider.token=<token> \
  --ServerApp.root_dir=/tmp/jupyter-test

# Password auth. The trait is `IdentityProvider.hashed_password`; a bare `password`
# option is silently ignored, which looks exactly like a wrong password.
python -c "from jupyter_server.auth import passwd; print(passwd('<password>'))"
jupyter server --no-browser --port=9004 \
  --IdentityProvider.hashed_password='<hash from above>' --ServerApp.root_dir=/tmp/jupyter-test
```

Then:

```bash
JUPYTER_TEST_URL=http://127.0.0.1:9003/lab JUPYTER_TEST_TOKEN=<token> node test/e2e.mjs
JUPYTER_TEST_URL=http://127.0.0.1:9004/lab JUPYTER_TEST_PASSWORD=<password> node test/e2e.mjs
```

`test/register.mjs` additionally needs `node_modules` linked to the DeepSeek Harness packages (a
development-only link, never part of the installed plugin).

## Limitations

- **The panel is a notebook, not JupyterLab.** No completion, variable inspector or debugger; it
  cannot be framed because JupyterLab sends `frame-ancestors 'self'`.
- **Several notebooks can be open, but not managed.** None can be renamed, closed or deleted; export
  writes the page you are looking at.
- **Output support is a chosen subset.** `application/json`, LaTeX and arbitrary MIME types are shown
  as placeholders; HTML is sanitized, so outputs that rely on their own scripts render statically.
- **Panel notes arrive at the next step.** A queued note is context for the next model request, not a
  message sent on the user's behalf.
- **Code execution only.** The Contents API (reading and writing notebook files on the server) is not
  exposed.
- Kernels are left running when a conversation ends; shut them down with `jupyter_kernel`.
