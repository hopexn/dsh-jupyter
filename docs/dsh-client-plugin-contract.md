# DSH client-plugin contract (reference notes)

Provenance: extracted from the shipped DeepSeek Harness 0.2.0-rc.2 packages and the bundled
`cordis-plugin-development` skill while building `lib/client.js`. Points marked UNVERIFIED were
read from shipped source rather than observed in a live page. This file is development
documentation for the panel; nothing imports it.

---

# DSH 0.2.0-rc.2 — Client-half (browser) plugin reference for a right-side notebook panel

Research only. No plugin files written. Sources: the shipped authoring skill + shipped packages,
read out of `app.asar` via the extracted plain tree at `/tmp/asar-dsh/<pkg>/`.

Authoritative docs (plain-copy paths; the asar originals live under
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`):

- `SKILL.md`
- `references/ui-plugin.md` (13 lines)
- `references/practices.md`, `references/host-plugin.md`, `references/user-actions.md`, `references/verification.md`
- `templates/decoration/{package.json,cordis.patch.yml,index.js,client.js}`

---

## 1. MANIFEST — dual-plane (host + client) package.json

### 1a. The template, verbatim

`/tmp/asar-dsh/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/package.json` (whole file, 15 lines):

```json
{
  "name": "@local/my-decoration",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

`references/ui-plugin.md:3` (verbatim):

> Read `templates/decoration/` with the file-read tool and write its files into your bundle directory: its `package.json` adds a `dsh.client` section (`platform`, `immediately`, `inject`) and a `./client` export beside the bundle patch.

### 1b. Real shipped dual-plane package — `@deepseek-ai/dsh-client-ui-settings-general`

`/tmp/asar-dsh/dsh-client-ui-settings-general/package.json:16-43`:

```json
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "types": "./lib/types/client/index.d.ts",
      "default": "./lib/client.js"
    },
    "./types": {
      "types": "./lib/types/types.d.ts"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-shortcuts"
      ],
      "platform": "web"
    }
  },
```

`/tmp/asar-dsh/dsh-client-ui-settings-general/package.json:73-77`:

```json
  "files": [
    "lib/index.js",
    "lib/client.js",
    "lib/types/**/*.d.ts"
  ]
```

Same shape in `/tmp/asar-dsh/dsh-client-ui-sidebar-right/package.json:16-40` and `:73-77`.
`/tmp/asar-dsh/dsh-client-ui-sidebar-documentpreview/package.json:85-90` adds chunks:
`"files": ["lib/index.js","lib/client.js","lib/client.*.js","lib/types/**/*.d.ts"]`.

Real `immediately: true` (`/tmp/asar-dsh/dsh-client-ui-theme/package.json`):

```json
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-locale",
                 "@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-settings",
                 "@deepseek-ai/dsh-api-remotes"],
      "platform": "web",
      "immediately": true
    }
  }
```

Real `external` (`/tmp/asar-dsh/dsh-experimental-client-ui-voice-input/package.json`):

```json
    "client": {
      "inject": [ "...8 ids..." ],
      "platform": "web",
      "external": ["@deepseek-ai/dsh-api-gateway/client"]
    }
```

(The `/client` suffix is stripped by the resolver — see `stripClientSuffix` below.)

### 1c. `icon`, `meta`, `locale` — display metadata without activation

`references/host-plugin.md:31-45` (verbatim):

```
Plugin Manager cards, bundle details, component rows, and the Settings plugin inventory read display text and an icon from the manifest without activating the plugin. Put the title and description in `locale/en.json` (other languages such as `locale/zh.json` use the same fields), and declare the icon as a top-level `icon` in `package.json`:
```
```json
{ "meta": { "title": "My Decoration", "description": "Draws a badge under the composer." } }
```
```json
{
  "icon": "./icon.svg",
  "exports": { "./package.json": "./package.json", "./locale/*.json": "./locale/*.json" },
  "files": ["locale/*.json", "icon.svg"]
}
```
> `icon` is a path relative to the manifest directory; SVG, PNG, JPEG, and WebP up to 256 KiB are accepted, while absolute paths, URLs, paths outside the directory, and symlinks leaving it are rejected. Missing fields fall back to `package.json` `name` and `description` and to the panel's default artwork; malformed metadata produces a diagnostic and keeps the valid text.

Real shipped `icon` example — `/tmp/asar-dsh/dsh-experimental-schedule-bundle/package.json` (`:5` `"icon": "./icon.svg"`, `:17-26` exports incl. `"./cordis.patch.yml"` and `"./locale/*.json"`, `:27-33` files, `:48-52` `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`).

**UNVERIFIED / negative result:** scanning every `package.json` in the extraction, **72 packages declare `dsh.client`, 4 declare `icon`, and 0 declare `meta`.** `meta` is documented but not used by any shipped package in this build. `icon` is only used by host-only bundle packages here.

### 1d. What `dsh.client.inject` actually does (it is NOT cordis injection)

Three code sites, in order:

1. Host parser — `/tmp/asar-dsh/dsh-client-modules/lib/client.js:61-75` (`parseDshClient`), shared by the node scan and the roster generator:
```js
const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
return { platform: decl.platform, ...inject !== void 0 ? { inject } : {}, ... };
```
2. Graph row — `/tmp/asar-dsh/dsh-client-modules/lib/index.js:394-404`:
```js
function graphRow(id, rev, fields) {
	return { id, url: comboReference([id], rev), rev,
		...fields.inject !== void 0 ? { inject: fields.inject } : {},
		...fields.immediately ? { immediately: true } : {},
		...fields.external.length > 0 ? { external: fields.external } : {} };
}
```
3. Browser arrival — `/tmp/asar-dsh/dsh-client-modules/lib/client.js:643-661`:
```js
/** Register each injected package and unresolved dynamic request before its consumer. */
async arriveGraphRow(row, open = [], visited = /* @__PURE__ */ new Set()) {
	...
	for (const request of row.external) { ... await this.arriveDependency(row.id, dependency, next, visited); }
	for (const packageName of row.inject) {
		const dependency = this.graphRows.get(packageName);
		if (dependency !== void 0) await this.arriveDependency(row.id, dependency, [], visited);
	}
	await this.arrive(row);
}
```
It is also retained by the prune pass (`lib/client.js:801-814`).

**Meaning:** `dsh.client.inject` is a **bundle-arrival ordering list** — "load and register these plugin packages' browser bundles before mine". It does **not**:
- create cordis service injection (that comes from the bundle's own `exports.inject`, e.g. `/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:9234` `exports.inject = inject;`, or the template's inline `return { inject: ['slots'], apply(ctx) {...} }`);
- make the package `require()`-able by itself (require resolves only the 9 seed words + already-materialized modules + already-**registered** factories, `lib/client.js:696-706`). In practice `inject` does get its dependency's factory registered, but the documented/correct way to *import* another plugin package is `dsh.client.external`.

`references/practices.md:35` (verbatim, about the related field):
> `dsh.client.inject` entries only order activation and stay allowed.

`immediately: true` is a separate axis: the shell prefetches those bundles at boot —
`/tmp/asar-dsh/dsh-web-frontend/dist/assets/index-5SrrfWpU.js`:
```js
async prefetchImmediateTier(){await Promise.all(this.manifest.plugins.filter(e=>e.immediately).map(e=>this.modules.prefetch(e.id).catch(n=>{})))}
```
`entries.start` itself uses only `{ id }` from the plugins view (`/tmp/asar-dsh/dsh-client-modules/lib/client.js:263-269`), so cordis `inject` never comes from `package.json`.

### 1e. What happens if `"./client"` is missing

Hard host-side error at Loader scan time — `/tmp/asar-dsh/dsh-client-modules/lib/index.js:713-719`:
```js
const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
if (decl === void 0 || decl.platform !== "web") { this.pkgMeta.set(sourceKey, null); return null; }
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
```
`clientExportOf` (`lib/index.js:170-181`) accepts `"./client": "./lib/client.js"` or `{ default: "..." }`; anything else throws
`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`.
Two consequences:
- `platform` must be exactly the string `"web"`. Any other value (including a missing platform → the parser throws first) makes the package look like it has **no** client half — silently no browser bundle.
- Declaring `dsh.client` without `exports["./client"]` **throws and fails that plugin's activation**; it is not a warning.

Also: the built file must exist. `initialBundleSnapshot` throws `MissingClientBundleError` on `ENOENT` (`lib/index.js:804-822`), described in `/tmp/asar-dsh/dsh-client-modules/README.md` as "a missing bundle fails activation loudly with one build instruction and a package/path list".

---

## 2. CLIENT BUNDLE FORMAT — the lazy-CJS wrapper

### 2a. The template, verbatim (whole file, 22 lines)

`/tmp/asar-dsh/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js`:

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() {
      return h('svg', {
        viewBox: '0 0 64 64', width: 48, height: 48,
        'aria-hidden': true,
        style: { display: 'block', pointerEvents: 'none' },
      }, h('circle', { cx: 32, cy: 32, r: 24, fill: '#247bbf' }));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
```

`templates/decoration/index.js` (whole file): host half is a stub.
```js
/** Host half of the decoration bundle; the Client module owns the rendering. */
export function apply() {}
```

### 2b. A real shipped bundle — head and tail

`/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:1-6`:
```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-sidebar-right",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
```
requires (`:30-35`):
```js
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_dockkit = require("@deepseek-ai/dsh-client-ui-dockkit");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_dom = require("react-dom");
```
tail (`:9233-9239`):
```js
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
```

**Skeleton you must emit (hand-written plain JS):**
```js
window.__ModuleLoader__.load({
  id: '<exact package.json "name">',   // MUST equal the package name
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ... all module bodies, CSS injection, component definitions ...
    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'connection'],
      apply(ctx) { /* ctx.effect(...) registrations */ },
    };
  },
});
```
`references/ui-plugin.md:9` (verbatim):
> The browser artifact registers a lazy factory whose id equals the package name. React comes from the browser module table; no duplicate React installation, CDN script, or UMD search is needed.

Id enforcement, `/tmp/asar-dsh/dsh-client-modules/lib/client.js:625` and `:739`:
```js
failures.push(`${url}: loaded without registering "${id}" via __ModuleLoader__.load`);
```
```js
if (!this.factories.has(id)) throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`);
```

The HTML façade, `/tmp/asar-dsh/dsh-client-modules/lib/index.js:453-475` (verbatim):
```js
const queue = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){ ... }
}
})()`;
```

### 2c. The EXACT set of module names allowed in `require(...)`

Seed table (frozen), `/tmp/asar-dsh/dsh-web-frontend/dist/assets/index-5SrrfWpU.js` (function `rM`):
```js
function rM(){return{
  "react": Ef,
  "react/jsx-runtime": If,
  "react-dom": Rf,
  "react-dom/client": Df,
  "@deepseek-ai/cordis": sf,
  "@deepseek-ai/dsh-client-store": lh,
  "@deepseek-ai/dsh-client-ui-slots": hh,
  "@deepseek-ai/dsh-client-ui-primitives": sE,
  "@deepseek-ai/dsh-client-ui-dockkit": XS
}}
```
Resolved bindings verified in the same file: `Ef` = React 18.3.1 namespace (`default` + all), `If` = `react/jsx-runtime`, `Rf` = `react-dom`, `Df` = `react-dom/client`, `sf` = `@deepseek-ai/cordis`, `lh` = `dsh-client-store` (`createSnapshotStore,defineStore,notifySubscribers,shallowEqual`), `hh` = `dsh-client-ui-slots` (`SlotCore,SlotOwnershipError,StaleAuthorizationError,resolveSlotLabel,standardHookPropName`), `sE` = `dsh-client-ui-primitives` (282 exports), `XS` = `dsh-client-ui-dockkit`.

**`@deepseek-ai/dsh-client-ui-primitives` is a seed word, so `require` would work — but the skill forbids it (see §6/§GOTCHAS).**

Beyond the 9 seed words, `require(spec)` resolves, in order (`lib/client.js:696-706`):
1. seed table,
2. already-materialized modules (`loadCache`),
3. any **registered** plugin factory whose id equals `stripClientSuffix(spec)` (i.e. another plugin package that has already arrived).

Anything else throws:
```js
throw new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`);
```
`require.async(spec)` exists for compiler-generated package-local chunks (`lib/client.js:707`). Resolution branch order including the async load branch is documented at `lib/client.js:25-31`.

### 2d. CSS handling

Real bundle pattern — `/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:539-552`:
```js
		const css$1 = ".wmirxG_button{width:28px;...}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-sidebar-right/ExpandButton.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-sidebar-right";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
```
Ownership / cleanup — `/tmp/asar-dsh/dsh-client-modules/lib/client.js:487-498`:
```js
const claimStyles = (id) => {
	if (typeof document === "undefined") return [];
	for (const el of document.querySelectorAll("style:not([data-plugin])")) el.setAttribute("data-plugin", id);
	const owned = [];
	for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) owned.push(el.getAttribute("data-plugin-css") ?? id);
	return owned;
};
```
```js
function removeOwnedStyles(id) {
	if (typeof document === "undefined") return;
	for (const el of document.querySelectorAll("style[data-plugin]")) if (el.getAttribute("data-plugin") === id) el.remove();
}
```
Rules that follow:
- **Put CSS injection inside the factory closure** (i.e. at materialization), never at script top level: "executing a plugin bundle only REGISTERS its factory; every module body side effect — including CSS injection — lives inside the factory closure and runs at materialization" (`lib/client.js:16-23`). `styles: claimStyles(ownerId)` runs right after `factory(require)` returns (`lib/client.js:681-694`).
- Tag your styles with `data-plugin="<pkg>"`; untagged `<style>` elements present at materialization get claimed by your plugin anyway.
- Alternative for component-local styles, `references/ui-plugin.md:13`: "Component-local styles can render as React elements so unmounting removes them."
- On unload/HMR the module system removes your owned `<style>` tags (`removeOwnedStyles`).

### 2e. Is `sourceMappingURL` required? Is the file bundled/minified?

- **Not required.** `prepareSource` strips it — `/tmp/asar-dsh/dsh-client-modules/lib/index.js:165` and `:253-268`:
```js
const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/;
...
source = source.replace(SOURCE_URL_TRAILER, "").replace(SOURCE_MAP_TRAILER, "");
if (!source.endsWith("\n")) source += "\n";
```
```js
function comboScript(input, sourceMapUrl) { return Buffer.from(sourceMapUrl === void 0 ? input : `${input}//# sourceMappingURL=${sourceMapUrl}\n`); }
```
If no `lib/client.js.map` exists, the host synthesizes an Indexed Source Map v3 with an identity section (`lib/index.js:306-316` `identitySectionMap`, `:336-360` `buildComboSourceMap`).
- **Not bundled and not minified by the host.** `buildComboScript` concatenates the raw file bytes — `/tmp/asar-dsh/dsh-client-modules/lib/index.js:329-334`:
```js
function buildComboScript(resources, sourceMapUrl) {
	let source = "";
	for (const resource of resources) source += `${prepareSource(resource).source};\n`;
	return comboScript(source, sourceMapUrl);
}
```
So your `lib/client.js` is served verbatim: it must be **self-contained** (or resolve only via the seed table / declared externals). A hand-written plain-JS `lib/client.js` needs no build step at all.

### 2f. How the host decides a client bundle changed (revision)

`/tmp/asar-dsh/dsh-client-modules/lib/index.js:192-199`:
```js
/** Identify an entry's build from filesystem metadata without hashing its contents. */
function artifactRevision(baseline) {
	return framedHash("plugin-artifact", [ String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size) ]);
}
```
Combo revision derives from the ordered row revisions (`lib/index.js:325-328`). The HMR host half stat-polls each row's bundle every `pollIntervalMs` (default **500**, `/tmp/asar-dsh/dsh-client-hmr/lib/index.js:22`) and on a metadata change calls `ctx.clientModules.rebuilt(id)` (`:50`), broadcasting a `rebuilt` frame on the `/plugins/events` SSE channel (`:156`). The browser half (`/tmp/asar-dsh/dsh-client-hmr/lib/client.js:56-81`) calls `entries.reload(frame.id, frame.rev)`, which invalidates the module, prefetches the new revisioned single-resource script, tears down the old fiber, removes its owned styles, and remounts with **fresh React state**.
`/tmp/asar-dsh/dsh-client-hmr/README.md`: "The entry's mtime, ctime, and size identify the revision without hashing its contents"; "React state inside the reloaded plugin is lost, while session, workspace, and connection state survives."

---

## 3. RIGHT-SIDE PANEL — exact slot names and registration

### 3a. The frame's root slot catalog (who owns what)

`/tmp/asar-dsh/dsh-client-ui-layout/lib/client.js:601-627` (verbatim, the frame's own registration):
```js
const disposeRegistration = ctx.slots.register({
	name: "root",
	locale: "common",
	children: {
		"sidebar": { kind: "single", scope: "root" },
		"main": { kind: "keyed", scope: "root" },
		"rightbar": { kind: "single", scope: "root" },
		"shell.overlay": { kind: "list", scope: "root" },
		"shell.leading": { kind: "single", scope: "root" }
	},
	store
}, AppFrame);
```
Rendered at `/tmp/asar-dsh/dsh-client-ui-layout/lib/client.js:338`:
```js
(0, react_jsx_runtime.jsx)(RightbarColumn, { children: renderSlot("rightbar", { width: normal.rightbar, ... })
```

**`rightbar` is `single` and already taken by `@deepseek-ai/dsh-client-ui-sidebar-right`. A plugin cannot register into it.** You contribute a **tab type** and a **tab body**.

### 3b. The panel's own nested catalog

`/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:9138-9186` (verbatim):
```js
const disposeSeat = ctx.slots.inject("rightbar", function* () {
	yield ctx.slots.register({
		name: "rightbar",
		children: { "rightbar.session": { kind: "single", scope: "session" } },
		inject: () => ({ hooks: { views: views.source }, mountView: (reference) => views.mount(reference) })
	}, RightbarRoot);
	yield ctx.slots.register({
		name: "rightbar.session",
		locale: NS,
		children: {
			"sidebar.right.pane.tab": {
				kind: "keyed",
				scope: "session",
				inject: { hooks: { tabInfo: tabInfoFactory } }
			},
			"sidebar.right.pane.tab.title": {
				kind: "keyed",
				scope: "session",
				inject: { hooks: { tabInfo: tabInfoFactory } }
			},
			"sidebar.right.tab.menu.item": {
				kind: "list",
				scope: "session"
			}
		},
		store,
		inject: (sessionId) => ({ ...injected, closeTab: (tabId) => {...}, keyedHooks: {...}, occurrence: (tab) => ... })
	}, RightbarSeat);
});
```
And the guide seats, `:9200-9220`:
```js
const disposeGuide = ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
	name: "sidebar.right.pane.tab",
	key: GUIDE_ID,
	children: {
		"sidebar.right.tab.guide.entry": { kind: "keyed", scope: "session", inject: { hooks: { tabInfo: guideTabInfoFactory } } },
		"sidebar.right.tab.guide": { kind: "chain", scope: "session", inject: { hooks: { tabInfo: guideTabInfoFactory } } }
	},
	inject: () => guideInjected
}, GuideBody));
const disposeGuideTitle = ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
	name: "sidebar.right.pane.tab.title", key: GUIDE_ID
}, GuideTitle));
```

**The slot you register your notebook body into: `sidebar.right.pane.tab` — kind `keyed`, scope `session`, key = your tab type's `id`.**
Title chip (optional, falls back to the text captured at open time): `sidebar.right.pane.tab.title`, same `key`.
Extra seats: `sidebar.right.tab.menu.item` (`list`), `sidebar.right.tab.guide` (`chain`), `sidebar.right.tab.guide.entry` (`keyed`).

### 3c. The two-stage public registration path

`/tmp/asar-dsh/dsh-client-ui-sidebar-right/README.md:81-88` (verbatim, the authoritative statement):
> A tab type registers in two stages, and the shipped guide type goes through exactly the same public path a type from another package does (`ui-sidebar-documentpreview` is the live proof). Both stages sit inside the type's own `ctx.effect`, so the registration lives exactly as long as the plugin that made it.
>
> 1. **The type** — `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`, a static declaration with no runtime hook, returning a disposer. `id` is this implementation's identity in the tab system, unique across every registration (a package name is the natural value; the shipped guide is `@deepseek-ai/dsh-client-ui-sidebar-right/guide`): a kind is not unique once an extension may take a builtin's over, so the implementation names itself, and a second registration of an `id` throws. … A page type — the guide, a file tree — names none [`patterns`] and is opened by kind. `canOpen(address)` vetoes a match. `title(address)` is the tab chip's text, captured when the tab opens. `guide` lists entry boxes for the guide page; picking one opens the contributing type as a page. A `kind` carries at most one `builtin` and one `extension` registration … The `id` is also the key the type's body and title register under, so an extension and the builtin it takes over hold distinct cells and the seat renders the one in force.
>
> 2. **The body** — `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)` reads `{ sidebar, panel, tab }` through the framework-injected `useTabInfo()`. `sidebar` supplies expansion and fullscreen information; `panel.id` identifies its pane; `tab` contains the record fields, `visible`, `navigation`, `signal`, and `actions`. These are not parallel owner props; the type's own store still uses `useStore`/`actions`. Optional title registrations and guide replacements share this hook; an absent title registration uses the text captured at open time.

Registry validation (verbatim), `/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:8690-8697`:
```js
register(definition) {
	const { id, kind } = definition;
	const entries = definition.guide ?? [];
	if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error(`sidebarRight: duplicate guide entry id in "${id}"`);
	const band = definition.priority ?? DEFAULT_BAND;
	if (this.ids.has(id)) throw new Error(`sidebarRight: tab type id "${id}" is already registered`);
	const held = this.kinds.get(kind);
	if (held !== void 0 && !coexists(held, band)) throw new Error(`sidebarRight: tab kind "${kind}" is already registered (${held.inForce.band})`);
```
Bands, `/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:8620-8632`: `{ extension: 3, builtin: 2, fallback: 1 }`, `DEFAULT_BAND = "extension"`, and `fallback` shares its kind with nothing.

### 3d. Real, smallest right-side panel registration — `@deepseek-ai/dsh-client-ui-subagent`

`/tmp/asar-dsh/dsh-client-ui-subagent/lib/client.js:808-826` (verbatim; a *page* type, no `patterns`, no title seat):
```js
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: SUBAGENT_CHAT_ID,
				kind: "subagentchat",
				patterns: [`${SUBAGENT_CHAT_ADDRESS}**`],
				priority: "builtin",
				canOpen: (address) => parseSubagentChatAddress(address) !== undefined,
				title: (address) => { ... }
			}), "ui-subagent: Sidebar chat type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: SUBAGENT_CHAT_ID,
				children: { "sidebar.chat.conversation": {
					kind: "single",
					scope: "session"
				} }
			}, SidebarChatTab)), "ui-subagent: Sidebar chat body");
```
`/tmp/asar-dsh/dsh-client-ui-plan/lib/client.js:631-700` shows the same two-stage pair plus a title seat:
```js
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: previewId, kind: "plan",
				patterns: ["dsh-resource://plan/**", "dsh-resource://plan-review/**"],
				priority: "builtin",
				canOpen: (address) => parsePlanAddress(address) !== undefined || isReviewPreviewAddress(address),
				title: () => t("preview.title")
			}), "ui-plan: sidebar type");
			...
			ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab", key: previewId, locale: NS
			}, PlanPreview));
			ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
				name: "sidebar.right.pane.tab.title", key: previewId
			}, PlanTitle));
```

### 3e. Guide entries — how the user gets a launcher for a page type

Real declaration, `/tmp/asar-dsh/dsh-client-ui-sidebar-files/lib/client.js:22-37` (verbatim):
```js
		function filesDefinition(t) {
			return {
				id: FILES_ID,
				kind: FILES_KIND,
				priority: "builtin",
				title: () => t("type.label"),
				guide: [{
					id: "workspace",
					commandId: "workspace.files",
					order: 10,
					title: () => t("guide.title"),
					description: () => t("guide.description"),
					icon: _deepseek_ai_dsh_client_ui_primitives.GuideArtworkFiles
				}]
			};
		}
```
Same shape with `multiple: true`, `/tmp/asar-dsh/dsh-client-ui-sidebar-terminal/lib/client.js:438-452`.
Guide entry fields actually consumed — projection at `/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:8842-8850`:
```js
			refresh() {
				this.cached = this.active().map((entry) => entry.definition);
				this.guideEntries = this.cached.flatMap((definition) => (definition.guide ?? []).map((entry) => ({
					...entry,
					kind: definition.kind,
					providerId: definition.id
				}))).sort((left, right) => left.order - right.order);
```
So: `id` (unique within the provider), `title()` (function), `description?()` (function, shown only while ≤4 entries — `MAX_DESCRIBED_ENTRIES`, `client.js:512-514`), `order` (sort key), `commandId?` (renders keycaps), `icon?` (a React component, rendered with a `size` prop at `client.js:460-478`). **An entry's own `kind` is overwritten by `definition.kind`** — do not set it.
Optional custom card instead of the default button: register into `sidebar.right.tab.guide.entry` keyed by the definition `id`; props are `{ entryId, kind, title, description }` (`client.js:517-524`). README:115 — "A provider can register a custom card under its definition id; otherwise the standard icon/title button renders."

### 3f. Meaning of `id` / `key` / `order` / `label` / `locale` / `children`

| option | meaning | source |
|---|---|---|
| `name` | slot key being registered into | slots `lib/index.js:163-165` |
| `id` | required for **`list`** slots; ledger identity inside the slot | `dsh-client-ui-slots/lib/index.js:181-184` `if (options.id === void 0) throw new Error(\`list slot "${options.name}" requires options.id\`)` |
| `key` | required for **`keyed`** slots; for a tab body it must equal the tab type's `definition.id` | `dsh-client-ui-slots/lib/index.js:175-179`; sidebar-right README:83-84 |
| `order` | list-slot display order (sort: `priority` then `order`) | `dsh-client-ui-slots/lib/index.js:209, 221` |
| `label` | stored label; may be a thunk resolved at read time by the active locale | `dsh-client-ui-slots/lib/index.js:21-28` (`resolveSlotLabel`), `:210` |
| `locale` | dictionary namespace; gives the component a `t` prop | `dsh-client-ui-renderer/lib/client.js:721-725` |
| `children` | declares child slots; **this registration becomes their only authorized renderer** | `dsh-client-ui-slots/lib/index.js:191-194, 224-236` |
| `priority` | shadowing axis; `single` = one occupant per priority (`single slot "x" already has a registration at priority N — register at a different priority to shadow it (lowest renders)`) | `dsh-client-ui-slots/lib/index.js:167-174` |
| `store` | store seat → `useStore` + `actions` props; one handle cannot be mounted under two scopes | `dsh-client-ui-slots/lib/index.js:195-203` |
| `inject` | business props, or a function `(sessionId, actions) => props` | `dsh-client-ui-renderer/lib/client.js:415-422` |
| `select` | required for **`chain`** slots | `dsh-client-ui-slots/lib/index.js:187-189` |

### 3g. Open / close

- **User-driven:** the guide tab is the column's home page; a pane's add control opens it (`openTab('guide', {paneId, revealIfOpened:false})`); picking a capsule calls `tab.actions.openTab(entry.kind, { replaceTab: true })` (`/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:529-531`). Tabs close via the chip's close control / context menu. "The sole docked guide is the only tab that cannot close; closing any other sole tab also collapses the column." (README:119). The collapse control rides the pane tab strip; the way back in is the button in `conversation.session.header.corner` (`ExpandButton`, registered at `client.js:9187-9192`).
- **Programmatic:** `ctx.sidebarRight.openTab(kind, options)` — `/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:6394-6397` and `:6448-6458`:
```js
			openTab(kind, options = {}) {
				const { sessionId, actions } = this.require();
				this.placeTab(sessionId, actions, kind, options);
			}
```
```js
			placeTab(sessionId, actions, kind, options) {
				const definition = this.tabs.get(kind);
				if (definition === void 0) throw new Error(`sidebarRight: no tab type is registered as "${kind}"`);
				const address = definition.multiple === true ? `${pageAddress(kind)}/${randomUUID()}` : pageAddress(kind);
				...
			}
```
Options: `paneId`, `replaceTab`, `revealIfOpened`, `preferNewPane`, `params` (README:93-95). Opening expands the column — "the panel expands, because content the user cannot see is not opened" (README:93).
- **On load / programmatically at startup:** `require()` (`client.js:6744-6752`) throws when no session surface is mounted:
```js
			require() {
				const sessionId = this.mounted.getSnapshot();
				const actions = sessionId === void 0 ? void 0 : this.actionsFor(sessionId);
				if (sessionId === void 0 || actions === void 0) throw new Error("sidebarRight: no session surface is mounted");
				return { sessionId, actions };
			}
```
So gate on the observable `ctx.sidebarRight.mounted` (`client.js:6334-6368`, `{ getSnapshot, subscribe }`) and open when it becomes a session id. Note also README:142 — "**No surface without a session.** State is keyed by session id, so the hero screen shows nothing on the right."
- **Persistence means it re-opens itself:** the layout (including which tabs are open) is saved per session in localStorage `dsh.sidebar-right.v1.<sessionId>` and restored before tab bodies render (README:74). There is no "open at startup" flag in the tab-type registry; I found no shipped plugin that opens its own tab on load → **UNVERIFIED**.

### 3h. Must the same id ALSO be registered into another slot (e.g. a layout `main` slot)?

**No — not for a right-side panel.** `main` is a *different* surface: the keyed root slot that renders a full-page panel in place of the conversation, `/tmp/asar-dsh/dsh-client-ui-layout/lib/client.js:118`:
```js
return renderSlot("main", {}, { entryKey: usePanelInfo((info) => info.activePanelId) ?? "conversation" });
```
Only if you want a notebook **page** as well do you register all three. Real precedent, `/tmp/asar-dsh/dsh-client-ui-schedule/lib/client.js:6774, 6793-6811`:
```js
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main", key: PANEL_ID, locale: MANAGER_NS,
				inject: () => ({ ...detail, onNewTask: () => { ctx.uiWorkspace.startSession(); } })
			}, TaskManagerPage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist", id: PANEL_ID, order: 10, locale: MANAGER_NS,
				label: () => t("panel")
			}, TaskManagerIcon));
```
`sidebar.panellist` is a `list`/root slot declared in `/tmp/asar-dsh/dsh-client-ui-sidebar/lib/client.js:503-506` and rendered as the left rail's launcher row (`SidebarRoot`, `:180-198`).

---

## 4. SLOT REGISTRATION API

### 4a. `ctx.slots.register(options, component) → disposer`

Implementation, `/tmp/asar-dsh/dsh-client-ui-slots/lib/index.js:163-243` (head verbatim):
```js
	register(options, component) {
		const rec = this.records.get(options.name);
		if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
		const spec = rec.spec;
		const priority = options.priority ?? 0;
		const occupantHint = (occupant) => `at priority ${priority}${occupant.registrant !== void 0 ? ` (registered by ${occupant.registrant})` : ""} — register at a different priority to shadow it (lowest renders)`;
		switch (spec.kind) {
			case "single": {
				const occupant = rec.entries.find((e) => (e.options.priority ?? 0) === priority);
				if (occupant) throw new Error(`single slot "${options.name}" already has a registration ${occupantHint(occupant)}`);
				break;
			}
			case "keyed": {
				if (options.key === void 0) throw new Error(`keyed slot "${options.name}" requires options.key`);
				...
			}
			case "list": {
				if (options.id === void 0) throw new Error(`list slot "${options.name}" requires options.id`);
				...
			}
			case "chain":
				if (options.select === void 0) throw new Error(`chain slot "${options.name}" requires options.select`);
				break;
		}
```
Returns an idempotent disposer (`:237-242`). The four slot kinds (`/tmp/asar-dsh/dsh-client-ui-slots/README.md:28`): "`single` (one occupant), `list` (ordered entries), `keyed` (dispatch by a key), and `chain` (entries elect themselves)."

### 4b. `ctx.slots.inject(name, callback) → disposer`

Doc comment + implementation, `/tmp/asar-dsh/dsh-client-ui-renderer/lib/client.js:1328-1402` (verbatim):
```js
			/**
			* Install an effect for each declaration lifetime of a slot. The callback
			* runs synchronously when the declaration already exists; otherwise it runs
			* inside the declaring `register()` call after the declaration is committed.
			* Collapse disposes the effect and a later declaration runs it again.
			* Callback effects are synchronous disposers; iterable effects install
			* transactionally and dispose in reverse order. The controller belongs to
			* the caller's fiber, so plugin unload cancels a pending wait and removes any
			* active contribution.
			*
			* @param key - declared SlotMap key to depend on.
			* @param callback - creates one disposer or an iterable of disposers.
			* @returns idempotent disposer for the wait and active effect.
			* @throws callback setup failures synchronously when the slot is already declared.
			*/
			inject(key, callback) {
				const ctx = this.ctx;
				const disposeController = ctx.effect(() => { ...
						const disposeEffect = ctx.effect(callback, `slots.inject(${JSON.stringify(key)}): declaration`);
						active = () => { disposeEffect(); };
						activeEpoch = epoch;
					...
				}, `slots.inject(${JSON.stringify(key)})`);
				return () => { disposeController(); };
			}
```
That is why shipped code uses a **generator** callback to yield several registrations — e.g. `ctx.slots.inject("rightbar", function* () { yield ctx.slots.register(...); yield ctx.slots.register(...); })` (`/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:9138-9186`).

### 4c. What the component receives as props

`/tmp/asar-dsh/dsh-client-ui-renderer/lib/client.js:703-746` (verbatim, the "five framework props shares"):
```js
		/**
		* Standard-kit synthesis shared by both scope branches: the global
		* useSessions/useWorkspaces hooks, the per-session provide bundle (every
		* `hooks` source becomes a `use<Name>` selector hook — useSession is the
		* runtime's own 'session' contribution, no special case — and `props` spread
		* verbatim), the store pair when declared, the renderSlot binding when
		* children are declared, and the SessionProvider seat when the children
		* declare a session-scope slot. Hosts hand out BARE observable sources
		* (hooks never cross the host contract); every hook is bound HERE, cached
		* per source (observableHook), so spreading a fresh kit object per render
		* never churns child subscriptions.
		*/
		function standardKit(host, entry, scope, rootBinding, scopeBinding) {
			const standard = standardProps(scope, rootBinding, scopeBinding);
			const kit = { ...standard, renderFactorySlot: boundRenderFactorySlot(entry) };
			if (entry.locale !== void 0) { ... kit["t"] = localeSeat(face, entry.locale); }
			const scopedStoreBinding = scopeBinding?.key === void 0 ? void 0 : scopeBinding;
			const store = host.storeOf(entry, scopedStoreBinding);
			if (store !== void 0) { kit["useStore"] = observableHook(store); kit["actions"] = store.actions; }
			if (entry.children !== void 0) {
				kit["renderSlot"] = boundRenderSlot(host, entry);
				if (Object.values(entry.children).some((spec) => spec.kind === "chain")) kit["renderSlotChain"] = boundRenderSlotChain(host, entry);
				if (Object.values(entry.children).some((spec) => spec.scope !== "root")) { ... kit["SessionProvider"] = scopeAreaProvider(adapter); }
			}
			return { kit, standard, actions: store?.actions };
		}
```
So a registered component receives: `renderSlot` (+`renderSlotChain`), `renderFactorySlot`, `t` (from `locale`), `useStore`/`actions` (from `store`), `SessionProvider`, the session standard kit (`sessionId` etc.), your `inject` props, and `use<Name>` hooks.

### 4d. Business "handle" via `inject: () => ({...})` and `props.use<Handle>(selector)`

The mechanism is the **`hooks`** share: a bare snapshot source `{ getSnapshot, subscribe }` named `foo` becomes a React selector hook prop named `useFoo`.
`/tmp/asar-dsh/dsh-client-ui-slots/lib/index.js:1-9` (verbatim):
```js
/**
* Convert one standard source name to its rendered Hook prop name.
* @param name - registered fixed or keyed source name.
* @returns the `use<Name>` prop exposed to Slot components.
*/
function standardHookPropName(name) {
	return `use${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
}
```
`/tmp/asar-dsh/dsh-client-ui-renderer/lib/client.js:424-439` (verbatim):
```js
		/** Bind one entry-owned inject face on its existing cache axis. */
		function bindInjectSources(face) {
			const sources = face["hooks"];
			const keyedSources = face["keyedHooks"];
			if (sources === void 0 && keyedSources === void 0) return face;
			const { hooks: _hooks, keyedHooks: _keyedHooks, ...rest } = face;
			const bound = rest;
			for (const [name, source] of Object.entries(sources ?? {})) {
				const hookName = (0, _deepseek_ai_dsh_client_ui_slots.standardHookPropName)(name);
				bound[hookName] = observableHook(source);
			}
			for (const [name, source] of Object.entries(keyedSources ?? {})) {
				const hookName = (0, _deepseek_ai_dsh_client_ui_slots.standardHookPropName)(name);
				bound[hookName] = keyedObservableHook(source);
			}
			return bound;
		}
```
`inject` args, `/tmp/asar-dsh/dsh-client-ui-renderer/lib/client.js:415-422` (verbatim):
```js
		function runInject(entry, binding, actions) {
			const inject = entry.inject;
			if (!inject) return EMPTY_INJECTED_PROPS;
			const args = [];
			if (binding !== void 0) args.push(binding.key);
			if (actions !== void 0) args.push(actions);
			return bindInjectSources(inject(...args));
		}
```
So for a `session`-scoped slot, `inject` is called as **`inject(sessionId, actions)`**; for a `root`-scoped slot, `inject()`.

**Real small example** — `/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:9193-9220`:
```js
				const guideInjected = { hooks: {
					shortcuts: ctx.shortcuts.catalog,
					guideEntries: {
						subscribe: (listener) => tabs.subscribe(listener),
						getSnapshot: () => tabs.guide()
					}
				} };
				const disposeGuide = ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
					name: "sidebar.right.pane.tab", key: GUIDE_ID, children: {...}, inject: () => guideInjected
				}, GuideBody));
```
consumed in the component as `GuideBody({ useTabInfo, useGuideEntries, renderSlot, renderSlotChain, useShortcuts })` with
`const entries = useGuideEntries((entries) => entries);` (`client.js:506-509`).
`inject: { hooks: { tabInfo: tabInfoFactory } }` on the *slot declaration* is the deferred form: a factory `(standard, hookContext) => hook` (`/tmp/asar-dsh/dsh-client-ui-renderer/lib/client.js:456-474`; the hook itself at `/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:8964-8988`).

Keyed variant: `keyedHooks: { plans: (turn) => source }` → `usePlans(turn, selector)` (real: `/tmp/asar-dsh/dsh-client-ui-plan/lib/client.js:658-669`).

---

## 5. TALKING TO THE HOST — `ctx.connection.fetch.register`

### 5a. Host-side signature

`/tmp/asar-dsh/dsh-client-connection/lib/index.js:580-584` (verbatim):
```js
	/** Exact Fetch-route registry scoped to the Context reading this service. */
	get fetch() {
		const owner = this.ctx;
		return { register: (route) => this.registerFetchRoute(owner, route) };
	}
```
`:625-639` (verbatim):
```js
	registerFetchRoute(owner, route) {
		assertFetchRoute(route);
		const registered = {
			methods: new Set(route.methods),
			requestBody: route.requestBody,
			fetch: route.fetch
		};
		return owner.effect(() => {
			if (this.fetchRoutes.has(route.path)) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`);
			this.fetchRoutes.set(route.path, registered);
			return () => { this.fetchRoutes.delete(route.path); };
		}, `client-connection: ${route.path} Fetch route`);
	}
```
`:755-762` (verbatim validation):
```js
function assertFetchRoute(route) {
	if (endpointFromPath("/api", route.path) === void 0) throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`);
	if (route.methods.length === 0) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`);
	if (new Set(route.methods).size !== route.methods.length) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`);
}
```
`:14` `const API_PATH = "/api";`. `endpointFromPath` (`:711-717`) requires `pathname.startsWith("/api/")` and that every remaining path segment passes `ENDPOINT_SEGMENT_PATTERN`.

So the contract is:
```js
ctx.effect(() => ctx.connection.fetch.register({
  path: "/api/notebook.cells",          // MUST start with "/api/"
  methods: ["GET", "POST"],             // non-empty, no duplicates
  requestBody: "buffered",              // or a streaming mode; every shipped caller passes "buffered"
  fetch: (request) => Promise<Response>,
}));
```
Real callers, `/tmp/asar-dsh/dsh-client-ui-deliverables/lib/index.js:48-60`:
```js
	ctx.connection.fetch.register({
		path: PRESENT_HOST_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: () => Promise.resolve(Response.json(ctx.sessionController.workspaceDesktop(), { headers: { "cache-control": "no-store" } }))
	});
```
…and `:84-98` wraps the handler with a plugin-owned `AbortController` so in-flight work is cancelled on unload.

### 5b. Mounting, trust, auth

`/tmp/asar-dsh/dsh-client-connection/lib/index.js:829-843`: the shared `/api` prefix handler mounts the fetch handler behind `connection.admit(req)`, which is `requestRejection` (`:585-594`): **403** when the Host/Origin fence fails, **401** when unauthenticated. The fence (`:205-219`, verbatim):
```js
function isTrustedApiRequest(request, trustedHosts) {
	const host = header$1(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header$1(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header$1(request.headers, "origin");
	if (origin === void 0) return true;
	try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}
```
`/tmp/asar-dsh/dsh-client-connection/README.md:41` (verbatim): "Cookies carry an absolute issue/expiry interval, defaulting to 30 days through `cookieMaxAgeDays`, and bind the normalized hostname plus port in both their deterministic name and signed payload. They are host-only, `Path=/`, `HttpOnly`, and `SameSite=Strict`; they deliberately omit `Secure` because the shipped server uses loopback HTTP."
README:19 (verbatim): "The Host half always provides the carrier-neutral RPC and exact `GET`/`HEAD`/`POST` route registries. When a Web carrier is present it also owns the sole `/api` route, Fetch bridge, browser authentication, and Host/Origin checks; a shell-owned carrier dispatches the shared Fetch handler directly." … "unclaimed requests return 404."

### 5c. From the client bundle: is a plain `fetch('/api/...')` allowed?

**Yes, with one important detail: use a *document-relative* URL (no leading slash), not `/api/...`.** Real client code, `/tmp/asar-dsh/dsh-client-ui-deliverables/lib/client.js:276` and `:283` and `:423`:
```js
		const PRESENT_HOST_PATH = "/api/present.host";
```
```js
		const PRESENT_HOST_ROUTE = PRESENT_HOST_PATH.slice(1);
```
```js
					const response = await fetch(PRESENT_HOST_ROUTE, { signal });
```
(the host registers the same absolute `PRESENT_HOST_PATH = "/api/present.host"`, `/tmp/asar-dsh/dsh-client-ui-deliverables/lib/index.js:17`). POST without a body is used the same way at `client.js:448-451`. `dsh-client-hmr` does the same for its SSE channel: `const EVENTS_ROUTE = "/plugins/events".slice(1);` then `new EventSource(EVENTS_ROUTE)` (`/tmp/asar-dsh/dsh-client-hmr/lib/client.js:45, 64`), with the note "Document-relative form of {@link EVENTS_ENDPOINT} used by the browser half" (`:41-44`).

- **Cookies:** sent automatically for same-origin requests; do not pass `credentials: 'omit'`.
- **CSRF:** there is no CSRF token. The defense is the Host/Origin fence plus `SameSite=Strict` host-only cookie. A cross-site page gets 403 (`sec-fetch-site: cross-site`) or 403 (Origin mismatch); an unauthenticated same-origin request gets 401.
- **Prefix:** the single `/api` prefix; path segments are restricted (`/^\/[A-Za-z0-9._~-]+$/`-style, no `//`, `.`, `..`).
- **404 vs 401/403:** an unclaimed path returns 404 (`lib/index.js:620`), so a typo is indistinguishable from "no route".

### 5d. Must the route be registered before the page loads? What about HMR?

- The route lives on the **host** and is registered when the host plugin row activates — independent of any browser page. Nothing requires the page to load after it. What matters: (a) your host plugin row must be active before the browser calls the route, (b) the path must not already be taken (a collision throws at registration), (c) `registerFetchRoute` runs `owner.effect(...)`, so it must be called on a live context (top of `apply`, or inside `ctx.inject(["connection"], ctx => ...)`); a disposed context throws an inactive-effect error.
- **HMR:** a rebuilt **client** bundle reloads only that plugin in the page with fresh React state; the host route and its registration are untouched. A rebuilt **host** half is not hot-swapped: `references/host-plugin.md:59` (verbatim) — "Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation." So keep the route on the host side, and treat the client as a pure consumer; you can iterate on the notebook UI without restarting, but changes to the route's shape need a restart.

---

## 6. AVAILABLE UI PRIMITIVES

`/tmp/asar-dsh/dsh-client-ui-primitives/lib/index.js` — 282 exports, 196 of them icons.

**Useful non-icon exports (exact names):**
`BrandWordmark, Button, CODE_HIGHLIGHT_EXTENSIONS, Checkbox, CodeBlock, ConnectionIndicator, DEFAULT_DIFF_MAX_LINES, DEFAULT_READ_MAX_LINES, DEFAULT_SEARCH_MAX_LINES, DEFAULT_TERMINAL_MAX_LINES, DiffBlock, DisclosureRow, FISH_LOGO_PATH, FISH_LOGO_VIEWBOX, FileTypeIcon, FishLogo, GuideArtworkBrowser, GuideArtworkFiles, HoverCard, ICON_MEDIUM_STROKE, ICON_REGULAR_STROKE, ImageLightbox, Input, JsonBlock, JsonTree, MarkdownDelegateProvider, MarkdownText, Menu, MenuGroup, MenuItemButton, MenuSurface, Modal, PathLabel, Pill, PluginArtworkDefault, PluginArtworkLoop, PluginArtworkSearch, PluginArtworkSubagent, PluginArtworkTerminal, ReadBlock, ReferenceIconMedium, ReferenceIconRegular, RiskConfirmation, SHIELD_OUTLINE_PATH, SearchBlock, SegmentedControl, SegmentedTabs, SettingsForm, SettingsFormModel, SettingsSecretField, SettingsValueField, ShortcutKeys, StateDot, Switch, Tag, TerminalBlock, TextShimmer, Toast, Tooltip, WebBlock, classifyFileType, classifyLinkPath, closeTopModal, diffTotals, extractMarkdownPlainText, fileExtension, fileSizeText, focusWithoutRing, isBehindModal, isDarwinDesktop, languageForPath, modalSelector, observeComposition, observeStickyMenuGroups, pointerModality, projectUserText, rankByName, relativeTime, settingsNumberField, settingsTextField, useAnchoredMaxHeight, useAnchoredPosition, useCodeHighlighter, useDismissOnOutsidePointer, useModalLayer, writeClipboard`

Exact signatures for the ones a notebook panel needs (`/tmp/asar-dsh/dsh-client-ui-primitives/lib/index.js`):

- **Text input** — `:3529`
```js
const Input = forwardRef(function Input({ icon, className, ...rest }, ref) {
	return jsxs("span", { className: clsx(css$11.wrap, className),
		children: [icon != null && jsx("span", { className: css$11.icon, children: icon }),
		           jsx("input", { ref, className: css$11.input, ...rest })] });
});
```
→ `rest` is spread onto the native `<input>` (`value`, `onChange`, `placeholder`, `disabled`, `aria-*`). Single-line only.
- **Button** — `:3216` `const Button = forwardRef(function Button({ variant = "ghost", size = "md", icon, className, children, ...rest }, ref)`; `variant` ∈ `primary | ghost | outline | toolbar`; `size` ∈ `md` (36px) `| sm` (28px). CSS at `/tmp/asar-dsh/dsh-client-ui-primitives/lib/Button.module.css`.
- **Code / monospace** — `CodeBlock` `:10769`:
```js
function CodeBlock({ code, lang, streaming, className, contentRef, lineNumbers = false, showHeader = true, copyLabel, copiedLabel, toolbarLabels, wrap }) {
```
  Also `TerminalBlock`, `ReadBlock`, `DiffBlock`, `SearchBlock`, `WebBlock` (agent-output cards), `JsonTree` / `JsonBlock`.
- **Loading / state** — `StateDot` `:3060` `function StateDot({ state, size, className, appearance = "dot" })`; `state` ∈ `done | warning | error | idle | ongoing`; `ongoing` is a rotating loader. `ConnectionIndicator` for connection recovery; `IconLoadingOutlineRegular` / `IconLoadingOutlineMedium` for a spinner glyph; `TextShimmer` for a running row.
- **Structure** — `DisclosureRow` `:3156` (`{ icon, title, open, expandable, onToggle, running = false, expandOnRowClick = false, previewChevron, keepContentWhenOpen, collapsedContent, children, className, rowClassName, contentClassName, contentLayoutClassName, leadingClassName, chevronClassName, titleClassName }`), `Modal`, `Menu`/`MenuItemButton`/`MenuSurface`/`MenuGroup`, `Toast`, `Tooltip` `:4674`, `Switch` `:3394` (`label` required), `Checkbox` `:3507`, `SegmentedControl` `:3444`, `SegmentedTabs`, `Pill` `:3236`, `Tag` `:3327`, `PathLabel`, `HoverCard`, `ImageLightbox`, `RiskConfirmation`, `SettingsForm` + `SettingsValueField` + `SettingsSecretField` + `SettingsFormModel` + `settingsNumberField` + `settingsTextField`, `ShortcutKeys`.
- **VERIFIED ABSENT:** there is **no** `Textarea`, **no** `ScrollArea`/scroll container, **no** `Spinner` component, **no** `EmptyState`/`ErrorState`, **no** `Card`/generic list. Scrolling is per-feature CSS; `StateDot state="ongoing"` is the built-in loader. (`ScrollArea`/`Textarea`/`EmptyState` confirmed absent from the full 282-name export list.)

Component catalog with prose descriptions: `/tmp/asar-dsh/dsh-client-ui-primitives/README.md:44-70`.

### Is a plain `<textarea>` / `<div>` with theme-token CSS acceptable?

**Yes — it is the *required* route for a plugin.** `references/practices.md:35` (verbatim):
> Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module; `dsh.client.inject` entries only order activation and stay allowed. They change without notice, a plain-JS plugin has no type check, and a throwing component blanks your slot entry (console: `slot entry crashed in '<slot>'`). Write your own controls and match the host instead: copy markup, CSS, and behavior from the primitive into the plugin (`src/*.tsx` and `*.module.css` in a DSH source checkout, or the installed package's `lib/index.js` and `lib/**/*.css`), or inspect the rendered host control in the connected page. Rename copied classes under your plugin's prefix, keep only `--dsw-alias-*` token references, and keep the behavior that users rely on, such as Modal focus and Escape handling, `role="switch"` with `aria-checked`, and Tooltip placement. Tokens then remain the only shared styling dependency.

`SKILL.md:25` makes this a verification gate: "styles use only theme tokens, the plugin imports no Harness Client package such as `@deepseek-ai/dsh-client-ui-primitives`".
`references/practices.md:33`: "Render plugin pages as React components in a slot. Do not serve an HTML page from the Host and embed it in an iframe: an iframe document does not receive the host's theme tokens, light/dark switching, or `ctx.locale`."

Copyable source for a plain textarea/inline-input look — `/tmp/asar-dsh/dsh-client-ui-primitives/lib/Input.module.css` (whole file, 38 lines):
```css
.wrap {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}
.wrap:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.input { flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.input::placeholder { color: var(--dsw-alias-label-dimmed); }
```

### Real theme tokens

`references/practices.md:34` (verbatim): "Style with the theme tokens that `cordis_inspect_query` `Theme` lists (`--dsw-alias-*`); literal colors are for artwork only."

The live `Theme.listTokens` query **timed out in this session** (no page attached) → **UNVERIFIED against the live tree**. The names below are extracted verbatim from the shipped theme/CSS:

`--dsw-alias-*` (55 distinct, from `/tmp/asar-dsh/dsh-web-frontend/dist/assets/index-BPHePDI_.css`):
`bg-base, bg-layer-1, bg-layer-2, bg-layer-3, bg-layer-4, bg-mask-1, bg-module-platform, border-l1, border-l2, border-l2-darkmode-thin, border-l3, border-l4, brand-primary, button-ghost-active-border, button-ghost-active-fill, button-primary-fill, button-primary-hover, button-tool-bar-fill, button-tool-bar-hover, code-diff-added, code-diff-deleted, interactive-bg-active, interactive-bg-hover, interactive-bg-hover-danger, label-caption, label-dimmed, label-error, label-primary, label-primary-foreground, label-secondary, label-shimmer, label-tertiary, link, markdown-code-block, markdown-code-block-banner, markdown-inline-code, markdown-tag, menu-group-header-fill, menu-icon, scrollbar-bg-l2, scrollbar-hover-l2, state-business-primary, state-error-primary, state-idle-primary, state-success-primary, state-success-tertiary, state-warn-label, state-warn-primary, state-warn-tertiary, switch-thumb, toast-bg, toast-label, tooltip-bg, tooltip-key-bg`

Handful most useful for a notebook panel: `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`, `--dsw-alias-border-l2`, `--dsw-alias-border-l4`, `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`, `--dsw-alias-label-tertiary`, `--dsw-alias-label-dimmed`, `--dsw-alias-label-error`, `--dsw-alias-interactive-bg-hover`, `--dsw-alias-state-business-primary`, `--dsw-alias-state-success-primary`, `--dsw-alias-state-error-primary`, `--dsw-alias-state-warn-primary`, `--dsw-alias-markdown-code-block`, `--dsw-alias-scrollbar-bg-l2`, `--dsw-alias-scrollbar-hover-l2`.

Non-`alias` host tokens used by the primitives (also real, from `*.module.css`):
`--dsw-radius-xs|sm|md|lg|panel`, `--dsw-font-xs-13`, `--dsw-font-markdown-code-block`, `--dsw-font-markdown-code-font-family`, `--dsw-shadow-lv3`, `--dsw-elevation-panel|prominent|soft|stroke-color`, `--dsw-focus-ring-color`, `--dsw-focus-ring-width`, `--dsw-menu-surface-fill`, `--dsw-menu-backdrop-filter`, `--dsw-specific-menu`, `--dsw-static-*`, and the frame/content vars `--dsh-content-font-size`, `--dsh-content-font-size-secondary`, `--dsh-content-font-delta`, `--dsh-frame-chrome-top`, `--dsh-frame-overlay-top`, `--dsh-scrollbar-width`, `--dsh-scrollbar-thumb`.
(Tension to note: practices.md says "keep only `--dsw-alias-*` token references", but radius/typography/elevation/focus tokens are host-wide shared non-color tokens and are what the primitives themselves use. Prefer alias tokens for colour; the non-alias structural tokens are safe and stable.)

---

## 7. KEYBOARD / MOUSE INTERACTION

### 7a. Plain React handlers are the norm (use this for Shift+Enter-to-run)

Real composer-style handler, `/tmp/asar-dsh/dsh-client-ui-conversation/lib/client.js:15359-15367` (verbatim):
```js
					onKeyDown: (event) => {
						if (event.key === "Escape") {
							onCancel();
							return;
						}
						if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
						event.preventDefault();
						onSave();
					}
```
Note `event.nativeEvent.isComposing` — the host consistently guards IME composition. The component in that snippet is a plain `<textarea>` with `value` / `onChange: (event) => onChange(event.currentTarget.value)` (`client.js:15356-15358`). Mouse handlers are equally plain: the guide entry is a `<button type="button" … onClick={() => onPick(entry)}>` (`/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:463-470`); the left rail launches a panel with `onClick: () => { selectPanel(id); }` (`/tmp/asar-dsh/dsh-client-ui-sidebar/lib/client.js:184-186`). I found **no** `onDoubleClick` in the client bundles I checked → use ordinary React `onClick` / `onDoubleClick` (UNVERIFIED as a shipped precedent).

### 7b. Yes, there IS a client command/keybinding service: `ctx.shortcuts`

`/tmp/asar-dsh/dsh-client-shortcuts/README.md:29-31`: "The Web app bundle mounts this package automatically. Feature plugins register commands through `ctx.shortcuts` inside `ctx.effect()`. Each command declares defaults for explicit `desktop:macos`, `desktop:windows`, `desktop:linux`, `web:macos`, `web:windows`, and `web:linux` profiles; an omitted profile is unbound. The service accepts physical `code` values, expands `primary` to the device modifier, and rejects duplicate ids and overlapping default combinations across supported profiles."

Signature — `/tmp/asar-dsh/dsh-client-shortcuts/lib/client.js:583-609` (verbatim):
```js
			/**
			* Register atomically after checking defaults for all supported platforms and shells.
			* @param command - feature-owned command definition.
			* @returns idempotent disposer removing both matching and catalog entries.
			*/
			register(command) {
				if (this.commands.has(command.id) || this.fixedCommands.has(command.id)) throw new Error(`Duplicate shortcut command: ${command.id}`);
				... if (bindingIssue(...) !== null) throw new Error(`Reserved shortcut default: ${command.id}`);
				... throw new Error(`Conflicting shortcut defaults: ${command.id} and ${existing.id} (${runtime}:${platform})`);
```
Dispatch and `resolve` result, `/tmp/asar-dsh/dsh-client-shortcuts/lib/client.js:686-709` (verbatim):
```js
				const resolution = command.resolve(context);
				if (resolution.status === "pass") return resolution;
				consume();
				if (resolution.status === "blocked") return { ...resolution, commandId: command.id };
				if (!gesture.repeat) resolution.run();
				return { status: "handled", commandId: command.id };
```
Real command with all six profiles — `/tmp/asar-dsh/dsh-client-ui-sidebar-right/lib/client.js:180-225` (verbatim head):
```js
			const disposers = [shortcuts.register({
				id: "sidebar.right.toggle",
				label: () => t("command.toggle"),
				aliases: ["right sidebar", "toggle right panel"],
				defaults: {
					"desktop:macos": { code: "KeyB", modifiers: ["primary", "alt"] },
					"desktop:windows": { code: "KeyB", modifiers: ["primary", "alt"] },
					"desktop:linux": { code: "KeyB", modifiers: ["primary", "alt"] },
					"web:macos": { code: "KeyB", modifiers: ["primary", "shift"] },
					"web:windows": { code: "KeyB", modifiers: ["primary", "shift"] }
				},
				regions: ["page", "editable", "terminal"],
				modals: [],
				resolve: () => {
					const target = sidebar.commandTarget(null);
					if (target === void 0) return { status: "blocked", reason: t("command.noSession") };
					return { status: "handled", run: () => { if (sidebar.isTargetCurrent(target)) sidebar.toggleExpanded(); } };
				}
			})];
```
Registration is always wrapped: `ctx.effect(() => ctx.shortcuts.register({...}), "ui-plan: ...")` (e.g. `/tmp/asar-dsh/dsh-client-ui-workspace/lib/client.js:108-140`, `/tmp/asar-dsh/dsh-client-ui-layout/lib/client.js:628-662`).
Optional-service form (when a composition may lack it): `/tmp/asar-dsh/dsh-client-ui-sidebar-files/lib/client.js:947-951` `ctx.inject(["shortcuts"], (ctx) => { ctx.effect(() => ctx.shortcuts.register({...})) })`.

**Recommendation for the notebook:** a globally-registered `Shift+Enter`, with `regions: ["editable"]`, competes with the composer and every other editable region, and duplicate/overlapping defaults throw at registration. Bind Shift+Enter-to-run as a **local `onKeyDown` on your own textarea** (7a), and use `ctx.shortcuts` only for a panel-level command such as "open notebook" (with a `guide` entry + `commandId` so the guide shows its keycaps).

---

## GOTCHAS

1. **`rightbar` is not yours.** It is a `single`/root slot already occupied by `dsh-client-ui-sidebar-right` (layout `client.js:613-616`, 9138-9149). Registering into it throws `single slot "rightbar" already has a registration at priority 0`. The right-side panel path is the tab-type registry + `sidebar.right.pane.tab`.
2. **The body `key` must equal the tab type's `id`.** The seat dispatches with `entryKey: definition?.id ?? tab.kind` (sidebar-right `client.js:5550-5554`); a key that does not match renders the fallback "this tab's type is unavailable" paragraph.
3. **Registering into an undeclared slot throws**: `slot "x" is not declared (a parent entry's children table must declare it)`. You cannot invent a slot; you may only declare children of a slot **you** are registering.
4. **Declaring a child twice throws**: `slot "x" is already declared (by ...)`.
5. **One store handle, one scope**: mounting the same `store:` handle under two different scopes throws (`one handle, one scope`).
6. **`chain` needs `select`; `list` needs `id`; `keyed` needs `key`; `single` allows one occupant per priority.** All throw at registration.
7. **Tab-type ids are globally unique** (`tab type id "…" is already registered`), and kind coexistence is band-limited: one `builtin` + one `extension` per kind, `fallback` shares with nothing.
8. **A guide entry's own `kind` is ignored** — it is overwritten by `definition.kind`.
9. **`ctx.sidebarRight.openTab` throws with no session on screen** (`sidebarRight: no session surface is mounted`); gate on the `ctx.sidebarRight.mounted` observable. The hero screen shows nothing on the right at all.
10. **Nothing opens your panel automatically at load** unless you call `openTab` — but a previously opened tab is restored from `dsh.sidebar-right.v1.<sessionId>` in localStorage. (No shipped plugin was found opening its own tab on load → UNVERIFIED.)
11. **`require()` resolves only 9 seed words + materialized modules + registered factories.** There is no node resolution, no npm package lookup. To import another plugin package, declare it in `dsh.client.external` (real: `"@deepseek-ai/dsh-api-gateway/client"`; the `/client` suffix is stripped) and import the bare id. A miss throws `require("…") missed the module table — …`.
12. **Never `require('@deepseek-ai/dsh-client-ui-primitives')`**, even though it is a seed word — the skill's verification explicitly checks that the plugin imports no Harness Client package. Copy the markup/CSS instead and rename classes under your prefix.
13. **Factories must be side-effect free**; all CSS injection, listeners, and timers go inside `apply` via `ctx.effect`/`ctx.on`, returning cleanup. Style tags belong inside the factory closure (materialization), not at script top level.
14. **`lib/client.js` must exist on disk before launch.** The host serves the built artifact; a missing file fails activation loudly (`MissingClientBundleError`). A hand-written plain-JS file needs no build step — but it *is* served verbatim, so it must be self-contained.
15. **Revision = mtime + ctime + size.** Editing content advances it; nothing hashes bytes. `pnpm run dev:web` is required for automatic reloads of rebuilt bundles.
16. **`//# sourceMappingURL=…` is stripped and replaced by the host**, and a missing/invalid `.map` is only warned about (identity map synthesized) — never fatal.
17. **`dsh.client.platform` must be exactly `"web"`**; any other value silently means "no client half".
18. **Declaring `dsh.client` without `exports["./client"]` throws** at scan time and fails activation — not a warning.
19. **HTML-route paths must start with `/api/`**, have non-empty unique `methods`, and cannot collide (`connection: exact Fetch route "…" is already registered`).
20. **An unclaimed path returns 404**, so a path typo looks identical to a missing route. Check 401/403 separately (those mean the trust fence/auth failed).
21. **No CSRF token.** Auth is a `SameSite=Strict`, `HttpOnly`, host-only cookie plus the Host/Origin fence. Do not use `credentials: 'omit'`, and prefer a document-relative URL (`api/foo`, as `dsh-client-ui-deliverables` and `dsh-client-hmr` do) over `/api/foo`.
22. **Host-half changes need a restart**; client-half rebuilds hot-swap but lose React state (`reference/host-plugin.md:59`, `dsh-client-hmr/README.md`).
23. **All visible text must go through the client locale service** (`ctx.locale.register(NS, {zh, en})`, `locale: NS` on the registration → `t` prop). `references/ui-plugin.md:13`: "Route visible UI text through the Client locale service."
24. **Do not write DOM outside your component, do not append to `document.body`, do not replace the app root, and do not read another plugin's DOM/stylesheet/source.** (`references/ui-plugin.md:13`.)
25. **`immediately: true` costs boot time** (prefetch of your whole bundle before first paint) — omit it unless the plugin must be interactive before the first user action.
26. **`meta` is documented but unused by every shipped manifest in this build** (0/72 `dsh.client` packages); `icon` is used by 4 host-only bundles. Title/description come from `locale/en.json`.
27. **UNVERIFIED:** the live Client inspect providers (`Slots.listSubTree`, `Theme.listTokens`) both timed out in this session — the browser page was not attached to this session. Every slot name, option, and token above is quoted from shipped source files, not from a live catalog. Verify the live tree with `cordis_inspect_query` from a session that has the page open before finalizing.
28. **Minor rule tension:** `practices.md:35` says "keep only `--dsw-alias-*` token references", while the host's own primitives also use `--dsw-radius-*`, `--dsw-font-*`, `--dsw-elevation-*`, `--dsw-focus-ring-*`. Those non-alias structural tokens are host-wide and stable; alias tokens are the ones to use for colour.
