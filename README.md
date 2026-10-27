# JupyterLab for DeepSeek Harness

English · [简体中文](README.zh-CN.md)

Connect DeepSeek Harness to one or more Jupyter servers. The agent runs code in a **persistent
remote kernel**: variables, imports and the working directory survive between tool calls. You also
get a notebook panel in the right sidebar, where every page runs on the server it is bound to.

Nothing runs on your machine: the plugin speaks Jupyter Server's REST API and kernel protocol
directly, with no Python and no extra dependencies.

## Install

From a checkout of this repository, in a DeepSeek Harness session:

```
plugin_manager { action: "install_bundle", target: "<path to this repository>" }
```

The bundle is installed into the current profile and activated. A **first** install needs one app
restart. After that, a page refresh picks up panel changes.

## Configure

`url` is the only field you need; everything else has a default. Pick one of three ways.

**1. Ask the agent.** Say "connect to `http://jupyter.example.com:9002/lab` with token XYZ" and it
calls `jupyter_connect`. Runtime-added connections are remembered across restarts.

**2. Use the panel.** `Connect…` in the notebook header opens a short form:

- **Name** (optional) — what the picker shows instead of the address;
- **Server address** — the JupyterLab URL;
- **Authentication** — `Password` (default), `Token`, or `Proxy cookie only` for SSO gateways;
- **Credential** — the password, the token, or the browser cookie.

Each connection in the list can be `Edit`ed (rename it or replace its credential; a blank field
keeps the stored one) or `Forget`ed. A loopback server is shown as `localhost`.

**3. Write it into the profile.** Add a `config:` mapping to the plugin's row in
`$DSH_PROFILE_DIR/cordis.patch.yml`:

```yaml
- id: jupyterlab
  name: '@local/dsh-jupyterlab'
  config:
    name: local
    url: http://jupyter.example.com:9002/lab
    token: <your token>
    kernelName: python3
    # Optional: more connections. Credentials belong to the host they were entered for.
    servers:
      - name: GPU box
        url: http://gpu-box.example.com:9003/lab
        password: <the plaintext password>
```

### Credentials

Jupyter accepts a token or a password, and both are supported:

- **token** — the `?token=...` from `jupyter server list`, the server's console output, or the URL
  JupyterLab opens with.
- **password** — the plaintext password you type into the JupyterLab login page. A password *hash*
  from `jupyter_server_config.json` cannot be replayed and is rejected.
- **proxy cookie** — see the next section, for deployments behind a corporate access gateway.

Credentials belong to the host they were entered for. Connections added at run time are stored in
`$DSH_HOME/jupyterlab/servers.json` (mode `0600`, plaintext — the same as your profile config).

### Behind an SSO / access proxy

Some deployments put an SSO/access gateway in front of Jupyter. It redirects every unauthenticated
path — `/lab`, `/api/status`, even Jupyter's own `/login` — to its login page, so a token or password
never reaches Jupyter. Sign in through the browser and bring its cookie along:

1. Open the address in your browser and sign in as usual.
2. DevTools → **Network** → any request to that host → **Request Headers** → copy the `Cookie:` value.
3. In the panel: `Connect…` → address → auth mode `Proxy cookie only` (or `Password`/`Token` when
   Jupyter itself also wants one) → paste into **Proxy cookie** → `Connect`.

The cookie is stored with the connection, so a restart keeps it until the gateway session expires;
when it does, `Edit` the connection and paste a fresh one. If a fresh cookie is still redirected, the
gateway is rejecting the replay — use a directly reachable address, or ask for a service token.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | — | JupyterLab address. `/lab`, `/tree`, trailing slashes and `?token=...` are understood. |
| `name` | — | Label shown in the panel instead of the address. |
| `token` / `password` / `username` | — | Credentials; `token` wins. |
| `cookie` | — | Cookie header for an SSO/access proxy. |
| `servers` | — | Extra connections: `{url, name?, token?, password?, cookie?, kernelName?, workingDirectory?}`. |
| `kernelName` | `python3` | Kernelspec started for a new kernel. |
| `workingDirectory` | server root | Server-relative directory the kernel starts in. |
| `requestTimeoutMs` | `20000` | Budget for one REST call. |
| `executeTimeoutMs` | `180000` | Budget for one execution before the kernel is interrupted. |
| `autoStartKernel` | `true` | Start a kernel on first execution. |
| `maxOutputChars` | `20000` | Streamed output kept per execution. |
| `artifactDirectory` | `$DSH_HOME/jupyterlab/artifacts` | Where image/PDF outputs are written. |

## What you get

The agent has five tools:

| Tool | Purpose |
| --- | --- |
| `jupyter_connect` | Add a connection and verify its credentials. Other connections stay connected. |
| `jupyter_status` | Connected servers, their kernels, and the kernel this conversation uses. |
| `jupyter_execute` | Run code in the panel page's kernel; returns output, errors and saved image/PDF paths. The run appears as an `Agent` cell. |
| `jupyter_notebook` | Read, add, update, delete or run a cell in the panel's notebook. An update leaves a reviewable diff. |
| `jupyter_kernel` | List, start, restart, interrupt, shutdown or attach kernels. |

The notebook panel:

- **Cells** — add, delete, insert below, reorder, clear output; code and markdown; syntax
  highlighting in the kernel's own language.
- **Editing** — `Shift+Enter` runs and leaves, `Ctrl/Cmd+Enter` runs in place, `Ctrl/Cmd+S` saves,
  `Tab`/`Shift+Tab` indent, `Esc` leaves; IME composition is left to the IME.
- **Running** — `Run` answers immediately and streams the output as it is produced. `Run all` runs
  the code cells in order, and the button becomes `Stop`.
- **Output** — images, `text/html` (sanitized), markdown, plain text; long output folds.
- **Agent edits** — a rewritten cell gets a `Changed` chip with a line diff; `Keep` accepts, `Undo`
  restores your version.
- **Several notebooks per session** (up to twelve) and **several servers** — the picker switches the
  page's server; `localhost` is shown for a loopback server.
- **Drafts** — uncommitted text survives a page reload.
- **Import / Export** — `.ipynb` in and out.
- **Live** — runs the agent performs appear as `Agent` cells, and what you edit or run reaches the
  model as context on its next step.

## Limitations

- **The panel is a notebook, not JupyterLab.** No completion, variable inspector or debugger.
- **Several notebooks can be open, but not managed.** None can be renamed, closed or deleted.
- **Output support is a subset.** `application/json`, LaTeX and arbitrary MIME types show a
  placeholder; HTML is sanitized, so interactive widgets render statically.
- **The remote server must be reachable from the harness machine.** There is no SSH tunnel or port
  forwarding: a Jupyter listening only on another machine's `127.0.0.1` cannot be reached by name.
- **`.ipynb` import and export are lossy.** Every dropped item is reported.
- **Credentials are plaintext files** (`servers.json`, mode `0600`); there is no keychain.
- **Panel notes arrive at the next step** — they are context for the next request, not chat messages.
- Kernels keep running when a conversation ends; shut them down with `jupyter_kernel`.

## For developers

Design notes, repository layout, development constraints and the verification commands live in
[`AGENTS.md`](AGENTS.md) and [`docs/design.md`](docs/design.md). The README stays user-facing on
purpose.
