/**
 * Browser half of the JupyterLab plugin: the notebook panel in the right sidebar.
 *
 * Served as-is to the page, so this file is a plain script in the harness's lazy-CJS module format:
 * it registers a factory with `window.__ModuleLoader__`, and only `react` and the slots/locale
 * services are available to it. No build step, no JSX, no client packages — styling uses the
 * theme's own custom properties so the panel follows light and dark themes.
 *
 * The panel owns no state of its own beyond drafts: every mutation is a command sent to the host
 * half, and the host returns the whole new view, so the browser never guesses what the kernel did.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-jupyterlab',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Implementation id: names the tab type and keys both slot registrations. */
    const TYPE_ID = '@local/dsh-jupyterlab/notebook'
    /** Kind the tab is opened by. */
    const KIND = 'jupyter-notebook'
    /** Locale namespace. */
    const NS = 'jupyterlab'
    /**
     * The host route the panel talks to, written document-relative: shipped clients do the same so
     * the request still resolves when the app is served under a path prefix.
     */
    const ROUTE = 'api/jupyterlab/notebook'
    /**
     * The output stream, same base as {@link ROUTE}.
     *
     * Running a cell answers immediately and the output arrives here, so a cell that prints for a
     * minute shows its first line after a second instead of a blank box.
     */
    const STREAM_ROUTE = 'api/jupyterlab/notebook/stream'
    /**
     * How often a visible panel asks whether anything changed.
     *
     * The stream pushes every change the model makes, so the poll exists only to repair a dropped
     * connection and to pick up the kernel row. While the stream is up it is a slow safety net;
     * without one it is the only way the panel learns anything.
     */
    const POLL_INTERVAL_MS = 4000
    const POLL_INTERVAL_LIVE_MS = 15000

    /**
     * The revision each panel has already rendered, keyed by session id.
     *
     * Module-level rather than a ref so the poll code stays honest about what it holds, and so a
     * remount does not resend a whole notebook when nothing changed.
     */
    const panelRevisions = new Map()

    const en = {
      title: 'Notebook',
      open: 'Notebook',
      openLabel: 'Open the Jupyter notebook panel',
      addCell: '+ Cell',
      run: 'Run',
      runHint: 'Run this cell (Shift+Enter)',
      remove: 'Delete',
      up: 'Up',
      down: 'Down',
      done: 'Done',
      editHint: 'Double-click to edit',
      empty: 'No cells yet.',
      restart: 'Restart kernel',
      interrupt: 'Interrupt',
      clearOutputs: 'Clear outputs',
      loading: 'Loading notebook…',
      retry: 'Retry',
      noKernel: 'no kernel yet — running a cell starts one',
      kernel: 'kernel',
      running: 'running…',
      placeholder: 'Write code, then press Shift+Enter to run it.',
      toggleKind: 'Switch between a code cell and a markdown cell',
      render: 'Render',
      mdPlaceholder: 'Markdown: write prose, then press Shift+Enter to render it.',
      syncLabel: 'queued',
      syncHint: 'These panel changes are handed to the agent at its next step.',
      notesTitle: 'Queued for the agent',
      discardNotes: 'Discard',
      agent: 'Agent',
      agentCell: 'Run by the agent in the shared kernel',
    }
    const zh = {
      title: '笔记本',
      open: '笔记本',
      openLabel: '打开 Jupyter 笔记本面板',
      addCell: '+ 单元格',
      run: '运行',
      runHint: '运行此单元格（Shift+Enter）',
      remove: '删除',
      up: '上移',
      down: '下移',
      done: '完成',
      editHint: '双击编辑',
      empty: '还没有单元格。',
      restart: '重启内核',
      interrupt: '中断',
      clearOutputs: '清空输出',
      loading: '正在加载笔记本…',
      retry: '重试',
      noKernel: '尚无内核 —— 运行任一单元格即可启动',
      kernel: '内核',
      running: '运行中…',
      placeholder: '写代码，然后按 Shift+Enter 运行。',
      toggleKind: '在代码单元格与 markdown 单元格之间切换',
      render: '渲染',
      mdPlaceholder: 'Markdown：写正文，然后按 Shift+Enter 渲染。',
      syncLabel: '条待同步',
      syncHint: '这些面板改动会在 agent 下一步时一并交给它。',
      notesTitle: '待交给 agent',
      discardNotes: '丢弃',
      agent: '模型',
      agentCell: '由 agent 在共享内核中运行',
    }

    /** Panel styles: theme tokens only, so light and dark both come out right. */
    const CSS = `
.dshj-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); font-size:13px; }
.dshj-bar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:8px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); position:sticky; top:0; background:var(--dsw-specific-sidebar-fill); z-index:2; }
.dshj-kernel { color:var(--dsw-alias-label-secondary); font-size:12px; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshj-sync { flex:0 0 auto; font:inherit; font-size:11px; line-height:16px; padding:0 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary); white-space:nowrap; cursor:pointer; }
.dshj-sync:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-label-secondary); }
.dshj-notes { border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); padding:8px 10px; font-size:12px; }
.dshj-notes-head { display:flex; align-items:center; gap:6px; margin-bottom:6px; color:var(--dsw-alias-label-secondary); }
.dshj-notes-head > span { flex:1; }
.dshj-note-row { padding:4px 0; border-top:1px dashed var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.dshj-origin { font-size:10px; line-height:16px; padding:0 5px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dshj-dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px; background:var(--dsw-alias-state-idle-primary); vertical-align:middle; }
.dshj-dot[data-busy="true"] { background:var(--dsw-alias-state-warn-primary); }
.dshj-dot[data-ready="true"] { background:var(--dsw-alias-state-success-primary); }
.dshj-btn { font:inherit; font-size:12px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:3px 8px; cursor:pointer; }
.dshj-btn:hover { background:var(--dsw-alias-bg-layer-2); }
.dshj-btn[disabled] { opacity:.5; cursor:default; }
.dshj-btn-primary { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dshj-cells { overflow:auto; flex:1; min-height:0; padding:10px; display:flex; flex-direction:column; gap:10px; }
.dshj-cell { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.dshj-cell[data-editing="true"] { border-color:var(--dsw-alias-brand-primary); }
.dshj-cell[data-status="error"] { border-color:var(--dsw-alias-state-error-primary); }
.dshj-cell-head { display:flex; align-items:center; gap:6px; padding:4px 6px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
.dshj-count { color:var(--dsw-alias-label-secondary); font-size:11px; min-width:26px; font-variant-numeric:tabular-nums; }
.dshj-head-spacer { margin-left:auto; }
.dshj-source { margin:0; padding:8px 10px; white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; line-height:1.5; cursor:text; min-height:18px; }
.dshj-source[data-empty="true"] { color:var(--dsw-alias-label-secondary); font-style:italic; }
.dshj-editor { width:100%; box-sizing:border-box; border:0; outline:none; resize:vertical; padding:8px 10px; min-height:64px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; line-height:1.5; }
.dshj-out { border-top:1px solid var(--dsw-alias-border-l1); padding:6px 10px; display:flex; flex-direction:column; gap:6px; background:var(--dsw-alias-bg-base); }
.dshj-pre { margin:0; white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.45; }
.dshj-stderr { color:var(--dsw-alias-state-warn-primary); }
.dshj-error { color:var(--dsw-alias-state-error-primary); }
.dshj-img { max-width:100%; border-radius:4px; background:var(--dsw-alias-bg-layer-2); }
.dshj-note { color:var(--dsw-alias-label-secondary); font-size:12px; padding:10px; }
.dshj-err { color:var(--dsw-alias-state-error-primary); font-size:12px; padding:8px 10px; }
.dshj-running { color:var(--dsw-alias-state-warn-primary); font-size:12px; }
.dshj-kind { font:inherit; font-size:10px; font-weight:600; letter-spacing:.04em; padding:1px 5px; border-radius:4px; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dshj-kind:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-label-secondary); }

/* Syntax highlighting. Every colour is mixed towards the label colour, so a token stays legible
   when the theme flips: on a light background the mix darkens, on a dark one it lightens. */
.dshj-t-kw { color:color-mix(in srgb, var(--dsw-alias-brand-primary) 78%, var(--dsw-alias-label-primary)); }
.dshj-t-str { color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 78%, var(--dsw-alias-label-primary)); }
.dshj-t-num { color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 82%, var(--dsw-alias-label-primary)); }
.dshj-t-com { color:var(--dsw-alias-label-secondary); font-style:italic; }
.dshj-t-fn { color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-label-primary)); }
.dshj-t-def { color:color-mix(in srgb, var(--dsw-alias-brand-primary) 78%, var(--dsw-alias-label-primary)); font-weight:600; }
.dshj-t-bi { color:color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, var(--dsw-alias-label-primary)); }
.dshj-t-op { color:var(--dsw-alias-label-secondary); }
.dshj-t-dec, .dshj-t-magic { color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 82%, var(--dsw-alias-label-primary)); }

/* The editor is a transparent textarea over the highlighted copy of its own text, so the caret,
   selection and IME all stay native. Both layers must agree on every metric that moves a glyph. */
.dshj-editor-wrap { position:relative; display:block; background:var(--dsw-alias-bg-base); }
.dshj-hl, .dshj-editor { margin:0; border:0; box-sizing:border-box; padding:8px 10px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; line-height:1.5; white-space:pre-wrap; overflow-wrap:break-word; word-break:break-word; tab-size:4; }
.dshj-hl { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
.dshj-editor { position:relative; display:block; width:100%; min-height:64px; resize:none; overflow:hidden; outline:none; background:transparent; color:transparent; caret-color:var(--dsw-alias-label-primary); }
.dshj-editor::placeholder { color:var(--dsw-alias-label-secondary); }
.dshj-editor::selection { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }
.dshj-editor-wrap[data-composing="true"] .dshj-hl { visibility:hidden; }
.dshj-editor-wrap[data-composing="true"] .dshj-editor { color:var(--dsw-alias-label-primary); }

/* Markdown, both for markdown cells and for text/markdown output. */
.dshj-md { font-size:12.5px; line-height:1.6; word-break:break-word; white-space:normal; }
.dshj-md > :first-child { margin-top:0; }
.dshj-md > :last-child { margin-bottom:0; }
.dshj-md h1, .dshj-md h2, .dshj-md h3, .dshj-md h4, .dshj-md h5, .dshj-md h6 { margin:.75em 0 .35em; font-weight:600; line-height:1.3; }
.dshj-md h1 { font-size:1.45em; }
.dshj-md h2 { font-size:1.28em; }
.dshj-md h3 { font-size:1.12em; }
.dshj-md p { margin:.45em 0; }
.dshj-md ul, .dshj-md ol { margin:.35em 0; padding-left:1.5em; }
.dshj-md li { margin:.15em 0; }
.dshj-md blockquote { margin:.45em 0; padding:.1em 0 .1em .7em; border-left:2px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.dshj-md hr { border:0; border-top:1px solid var(--dsw-alias-border-l1); margin:.8em 0; }
.dshj-md code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.94em; }
.dshj-md-inline { background:var(--dsw-alias-markdown-inline-code, var(--dsw-alias-bg-layer-2)); border-radius:4px; padding:.1em .35em; }
.dshj-md-code { margin:.5em 0; padding:8px 10px; border-radius:6px; background:var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2)); overflow:auto; font-family:var(--dsw-font-markdown-code-block-font-family, ui-monospace,SFMono-Regular,Menlo,Consolas,monospace); font-size:12px; line-height:1.5; }
.dshj-md-code code { background:transparent; padding:0; }
.dshj-md-tablewrap { overflow:auto; margin:.5em 0; }
.dshj-md table { border-collapse:collapse; font-size:12px; }
.dshj-md th, .dshj-md td { border:1px solid var(--dsw-alias-border-l1); padding:3px 7px; text-align:left; }
.dshj-md th { background:var(--dsw-alias-bg-layer-2); font-weight:600; }
.dshj-md img { max-width:100%; }
.dshj-md a { color:var(--dsw-alias-brand-primary); text-decoration:none; }
.dshj-md a:hover { text-decoration:underline; }

/* Kernel HTML (pandas, Styler, …) gets its own shadow root: its CSS cannot reach the page and the
   page's cannot reach its table. */
.dshj-html { display:block; overflow:auto; max-height:520px; font-size:12px; line-height:1.45; }
`

    /** Inject the stylesheet once per page. */
    function ensureStyles() {
      if (document.querySelector('style[data-plugin-css="dsh-jupyterlab"]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin', '@local/dsh-jupyterlab')
      style.setAttribute('data-plugin-css', 'dsh-jupyterlab')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /**
     * Call the host route.
     * @param sessionId - Session the panel belongs to.
     * @param command - Command to apply; omitted for a plain read.
     * @param since - Revision already rendered; the host answers `unchanged` when it still matches.
     */
    async function callHost(sessionId, command, since) {
      let response
      if (command === undefined) {
        // `encodeURIComponent` rather than `URLSearchParams`: a session id is opaque, and this keeps
        // the query readable in a network panel instead of turning every space into a `+`.
        let path = `${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`
        if (typeof since === 'number' && Number.isFinite(since)) path += `&since=${since}`
        response = await fetch(path, { headers: { accept: 'application/json' } })
      } else {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ ...command, sessionId }),
        })
      }
      let body
      try {
        body = await response.json()
      } catch {
        if (response.status === 404) {
          throw new Error("the notebook route is not registered on the harness (HTTP 404), so the panel's host half is not active — check that the plugin is enabled, then restart the app")
        }
        throw new Error(`the harness did not answer with JSON (HTTP ${response.status})`)
      }
      if (body?.error !== undefined && body?.cells === undefined) throw new Error(body.error)
      return body
    }

    // -------------------------------------------------------------------------------------------
    // Syntax highlighting
    //
    // There is no build step and no client package to lean on, so this is a tokenizer rather than
    // a parser: one regex pass, ordered so that a string beats a comment and a comment beats
    // everything else. That is enough for Python as it is written in a notebook, and it costs one
    // pass per visible cell instead of a grammar the size of the app.
    // -------------------------------------------------------------------------------------------

    /** Python keywords. */
    const PY_KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '))
    /** Names that exist without an import: worth a colour, but not the keyword's colour. */
    const PY_BUILTINS = new Set('abs all any ascii bin bool bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __name__ __file__ self cls'.split(' '))

    /**
     * One token, in priority order.
     *
     * IPython magics and `!shell` are only recognised at the start of a line (a `%` in an
     * expression is the modulo operator), strings are matched before comments so a `#` inside a
     * string stays a string, and every alternative consumes at least one character, so the scan
     * always advances.
     */
    const PY_TOKEN_SOURCE = '(^[ \\t]*[%!][^\\n]*)|(#[^\\n]*)|([rRbBuUfF]{0,2}(?:\'\'\'[\\s\\S]*?\'\'\'|"""[\\s\\S]*?"""|\'(?:\\\\.|[^\'\\\\\\n])*\'|"(?:\\\\.|[^"\\\\\\n])*"))|(@[A-Za-z_][\\w.]*)|(\\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d+)?[jJ]?)\\b)|([A-Za-z_]\\w*)|([+\\-*/%=<>!&|^~]+|:=|->)'

    /**
     * Split Python source into coloured runs.
     *
     * @param source - Cell text.
     * @returns `{ text, cls }` entries, in order, covering the input exactly.
     */
    function tokenizePython(source) {
      const text = String(source ?? '')
      const token = new RegExp(PY_TOKEN_SOURCE, 'gm')
      const tokens = []
      let cursor = 0
      let match = token.exec(text)
      while (match !== null) {
        if (match.index > cursor) tokens.push({ text: text.slice(cursor, match.index), cls: 'txt' })
        cursor = match.index + match[0].length
        tokens.push({ text: match[0], cls: tokenClass(match) })
        match = token.exec(text)
      }
      if (cursor < text.length) tokens.push({ text: text.slice(cursor), cls: 'txt' })
      return nameTokens(tokens)
    }

    /** Which group of {@link PY_TOKEN_SOURCE} matched. */
    function tokenClass(match) {
      if (match[1] !== undefined) return 'magic'
      if (match[2] !== undefined) return 'com'
      if (match[3] !== undefined) return 'str'
      if (match[4] !== undefined) return 'dec'
      if (match[5] !== undefined) return 'num'
      if (match[7] !== undefined) return 'op'
      const word = match[6]
      if (PY_KEYWORDS.has(word)) return 'kw'
      if (PY_BUILTINS.has(word)) return 'bi'
      return 'id'
    }

    /** Second pass: a name after `def`/`class` is a definition, a name before `(` is a call. */
    function nameTokens(tokens) {
      for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i].cls !== 'id') continue
        let before = i - 1
        while (before >= 0 && tokens[before].cls === 'txt' && tokens[before].text.trim() === '') before -= 1
        if (before >= 0 && tokens[before].cls === 'kw' && (tokens[before].text === 'def' || tokens[before].text === 'class')) {
          tokens[i].cls = 'def'
          continue
        }
        let after = i + 1
        while (after < tokens.length && tokens[after].cls === 'txt' && tokens[after].text.trim() === '') after += 1
        if (after < tokens.length && tokens[after].text.trimStart().startsWith('(')) tokens[i].cls = 'fn'
      }
      return tokens
    }

    /** Colour runs as React nodes. `txt` stays uncoloured, so the caret colour shows through it. */
    function tokenNodes(tokens) {
      return tokens.map((token, index) => (token.cls === 'txt'
        ? token.text
        : h('span', { key: `t${index}`, className: `dshj-t-${token.cls}` }, token.text)))
    }

    // -------------------------------------------------------------------------------------------
    // Markdown
    //
    // Block structure is parsed line by line and inline spans by a single regex; everything is
    // built as React nodes, never as an HTML string, so a cell that contains markup shows it
    // instead of executing it.
    // -------------------------------------------------------------------------------------------

    /** Inline spans: code, bold, strike, italic, images, links, autolinks. */
    const MD_INLINE_SOURCE = '(`[^`\\n]+`)|(\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__)|(~~[^~\\n]+~~)|(\\*[^*\\n]+\\*|_[^_\\n]+_)|(!\\[[^\\]\\n]*\\]\\([^)\\s]+\\))|(\\[[^\\]\\n]+\\]\\([^)\\s]+\\))|(<https?:\\/\\/[^>\\s]+>)|(https?:\\/\\/[^\\s<>()]+)'

    /**
     * An href only when it cannot execute anything.
     *
     * @param url - Candidate from a link or image.
     * @returns The URL, or `undefined` when it has a scheme that runs code.
     */
    function safeUrl(url) {
      const value = String(url ?? '').trim()
      if (/^(?:https?:|mailto:)/i.test(value)) return value
      if (/^(?:#|\/(?!\/)|\.{1,2}\/)/.test(value)) return value
      return undefined
    }

    /**
     * Render inline markdown.
     *
     * @param text - One paragraph, heading, or table cell.
     * @returns React children.
     */
    function mdInline(text) {
      const source = String(text ?? '')
      const pattern = new RegExp(MD_INLINE_SOURCE, 'g')
      const nodes = []
      let cursor = 0
      let index = 0
      let match = pattern.exec(source)
      while (match !== null) {
        if (match.index > cursor) nodes.push(source.slice(cursor, match.index))
        cursor = match.index + match[0].length
        const token = match[0]
        const key = `i${index}`
        index += 1
        if (match[1] !== undefined) {
          nodes.push(h('code', { key, className: 'dshj-md-inline' }, token.slice(1, -1)))
        } else if (match[2] !== undefined) {
          nodes.push(h('strong', { key }, mdInline(token.slice(2, -2))))
        } else if (match[3] !== undefined) {
          nodes.push(h('del', { key }, mdInline(token.slice(2, -2))))
        } else if (match[4] !== undefined) {
          nodes.push(h('em', { key }, mdInline(token.slice(1, -1))))
        } else if (match[5] !== undefined || match[6] !== undefined) {
          const parts = /^!?\[([^\]]*)\]\(([^)]*)\)$/.exec(token)
          const href = parts === null ? undefined : safeUrl(parts[2])
          if (parts === null || href === undefined) {
            nodes.push(token)
          } else if (match[5] !== undefined) {
            nodes.push(h('img', { key, className: 'dshj-md-img', src: href, alt: parts[1] }))
          } else {
            nodes.push(h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, mdInline(parts[1])))
          }
        } else {
          const href = token.startsWith('<') ? token.slice(1, -1) : token
          nodes.push(h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, href))
        }
        match = pattern.exec(source)
      }
      if (cursor < source.length) nodes.push(source.slice(cursor))
      return nodes
    }

    /** Split one table row into trimmed cells. */
    function mdCells(line) {
      let text = line.trim()
      if (text.startsWith('|')) text = text.slice(1)
      if (text.endsWith('|')) text = text.slice(0, -1)
      return text.split('|').map((cell) => cell.trim())
    }

    /** Whether a GFM table starts here: pipes above, a `---|---` separator below. */
    function mdTableAt(lines, index) {
      if (index + 1 >= lines.length || !lines[index].includes('|')) return false
      return /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[index + 1])
    }

    /** Block starts that end a paragraph. */
    const MD_BLOCK_START = /^\s{0,3}(?:#{1,6}\s|>|(?:[-*+]|\d{1,9}[.)])\s|(?:`{3,}|~{3,}))/

    /**
     * Parse markdown lines into block nodes.
     *
     * @param lines - Source split on newlines.
     * @param from - First line.
     * @param to - One past the last line.
     * @returns React children.
     */
    function mdBlocks(lines, from = 0, to = lines.length) {
      const nodes = []
      // One counter for every block in this call: two blocks must never share a key, and nesting
      // (`mdBlocks` inside a quote or a list) starts its own count in its own array.
      let next = 0
      const key = () => `b${next++}`
      let i = from
      while (i < to) {
        const line = lines[i]
        if (line.trim() === '') {
          i += 1
          continue
        }
        const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line)
        if (fence !== null) {
          const indent = fence[1].length
          const marker = fence[2][0]
          const language = fence[3].trim().split(/\s+/)[0] ?? ''
          const body = []
          const closing = new RegExp(`^\\s*${marker}{3,}\\s*$`)
          i += 1
          while (i < to && !closing.test(lines[i])) {
            body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''))
            i += 1
          }
          if (i < to) i += 1
          const code = body.join('\n')
          nodes.push(h('pre', { key: key(), className: 'dshj-md-code' },
            h('code', null, /^(?:py|python|python3)$/i.test(language) ? tokenNodes(tokenizePython(code)) : code)))
          continue
        }
        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
        if (heading !== null) {
          nodes.push(h(`h${heading[1].length}`, { key: key() }, mdInline(heading[2])))
          i += 1
          continue
        }
        if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
          nodes.push(h('hr', { key: key() }))
          i += 1
          continue
        }
        if (/^\s{0,3}>/.test(line)) {
          const body = []
          while (i < to && /^\s{0,3}>/.test(lines[i])) {
            body.push(lines[i].replace(/^\s{0,3}>\s?/, ''))
            i += 1
          }
          nodes.push(h('blockquote', { key: key() }, mdBlocks(body)))
          continue
        }
        if (mdTableAt(lines, i)) {
          const head = mdCells(lines[i])
          i += 2
          const rows = []
          while (i < to && lines[i].includes('|') && lines[i].trim() !== '') {
            rows.push(mdCells(lines[i]))
            i += 1
          }
          nodes.push(h('div', { key: key(), className: 'dshj-md-tablewrap' },
            h('table', null,
              h('thead', null, h('tr', null, head.map((cell, column) => h('th', { key: `h${column}` }, mdInline(cell))))),
              h('tbody', null, rows.map((row, rowIndex) => h('tr', { key: `r${rowIndex}` },
                row.map((cell, column) => h('td', { key: `c${column}` }, mdInline(cell)))))))))
          continue
        }
        if (/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/.test(line)) {
          const list = mdList(lines, i, to, key())
          nodes.push(list.node)
          i = list.next
          continue
        }
        const body = []
        while (i < to && lines[i].trim() !== '' && !MD_BLOCK_START.test(lines[i]) && !mdTableAt(lines, i)) {
          body.push(lines[i].trim())
          i += 1
        }
        // A line that begins a block but reached none of the branches above still has to advance,
        // or this loop would never end.
        if (body.length === 0) {
          body.push(line.trim())
          i += 1
        }
        nodes.push(h('p', { key: key() }, mdInline(body.join(' '))))
      }
      return nodes
    }

    /**
     * Parse one list and the blocks indented under its items.
     *
     * @param lines - Source split on newlines.
     * @param from - The list's first marker.
     * @param to - One past the last line.
     * @param key - Key assigned to the list element, which lives in its parent's array.
     * @returns The list node plus the line it stopped at.
     */
    function mdList(lines, from, to, key) {
      const ordered = /^\s{0,3}\d{1,9}[.)]\s/.test(lines[from])
      const baseIndent = /^(\s*)/.exec(lines[from])[1].length
      const items = []
      const strip = (text, count) => text.replace(new RegExp(`^ {0,${count}}`), '')
      let i = from
      while (i < to) {
        const marker = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i])
        if (marker === null) break
        const indent = marker[1].length
        if (indent !== baseIndent) break
        if (/^\s*\d/.test(lines[i]) !== ordered) break
        let text = marker[3]
        i += 1
        const nested = []
        while (i < to) {
          const next = lines[i]
          if (next.trim() === '') break
          const child = /^(\s*)([-*+]|\d{1,9}[.)])\s+/.exec(next)
          if (child !== null && child[1].length > indent) {
            nested.push(strip(next, indent + 4))
            i += 1
            continue
          }
          if (child !== null) break
          if (/^\s{2,}/.test(next)) {
            nested.push(strip(next, indent + 4))
            i += 1
            continue
          }
          // A plain continuation line belongs to the item's own paragraph.
          text += ` ${next.trim()}`
          i += 1
        }
        items.push(h('li', { key: `l${items.length}` }, mdInline(text), nested.length > 0 ? mdBlocks(nested) : null))
      }
      return { node: h(ordered ? 'ol' : 'ul', { key }, items), next: i }
    }

    /** A markdown document rendered with the panel's own styling. */
    function Markdown(props) {
      const lines = String(props.source ?? '').replace(/\r\n?/g, '\n').split('\n')
      return h('div', { className: 'dshj-md' }, mdBlocks(lines))
    }

    // -------------------------------------------------------------------------------------------
    // Kernel HTML (pandas DataFrames, Styler, …)
    //
    // An output is untrusted: it is whatever the cell decided to print. It is sanitized to remove
    // anything that can execute or navigate, then rendered inside a shadow root so its CSS and its
    // DOM cannot reach the panel — while its table still lays out at its natural height.
    // -------------------------------------------------------------------------------------------

    /** Tags that can execute, navigate, or replace the document: dropped before rendering. */
    const HTML_BLOCKED = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'base', 'form'])
    /** Attributes that carry a URL, and therefore need a scheme check. */
    const HTML_URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'xlink:href'])

    /** Base presentation, so a bare DataFrame looks like it does in JupyterLab. */
    const HTML_BASE_CSS = `
:host { display:block; color:var(--dsw-alias-label-primary); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.45; }
table { border-collapse:collapse; }
th, td { border:1px solid var(--dsw-alias-border-l1); padding:3px 8px; text-align:right; font-weight:normal; }
th { background:var(--dsw-alias-bg-layer-2); font-weight:600; }
th:first-child, td:first-child { text-align:left; }
a { color:var(--dsw-alias-brand-primary); }
img { max-width:100%; }
`

    /**
     * Remove CSS that would make the panel fetch something.
     *
     * A shadow root isolates layout and selectors, not the network: `url(https://…)` inside a
     * style attribute still loads, which tells whoever produced the output that it was opened and
     * from which address. `@import` would pull an entire remote sheet. `data:` URLs are kept —
     * they carry their bytes with them and fetch nothing.
     *
     * @param text - CSS text or a `style` attribute value.
     * @returns The same CSS with every remote reference removed.
     */
    function scrubCss(text) {
      return String(text ?? '')
        .replace(/@import[^;]*;?/gi, '')
        .replace(/url\s*\(\s*(['"]?)(?!data:)[^)]*\)/gi, 'none')
    }

    /**
     * Parse kernel HTML into nodes that are safe to mount.
     *
     * @param html - The `text/html` payload from an execute_result or display_data.
     * @returns A parsed `<body>`, or `null` when there is no DOM to parse with.
     */
    function sanitizeHtml(html) {
      if (typeof DOMParser === 'undefined') return null
      let doc
      try {
        doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html')
      } catch {
        return null
      }
      const walker = doc.createTreeWalker(doc.body, 1)
      const doomed = []
      while (walker.nextNode()) {
        const element = walker.currentNode
        const tag = element.tagName.toLowerCase()
        if (HTML_BLOCKED.has(tag)) {
          doomed.push(element)
          continue
        }
        for (const attribute of Array.from(element.attributes)) {
          const name = attribute.name.toLowerCase()
          const value = String(attribute.value ?? '').replace(/[\u0000-\u0020]+/g, '')
          if (name.startsWith('on') || name === 'srcdoc') element.removeAttribute(attribute.name)
          else if (HTML_URL_ATTRS.has(name) && /^(?:javascript|vbscript|data:text\/html)/i.test(value)) element.removeAttribute(attribute.name)
          // A shadow root already scopes this CSS, but it does not stop it from fetching.
          else if (name === 'style') element.setAttribute(attribute.name, scrubCss(attribute.value))
        }
        if (tag === 'style') element.textContent = scrubCss(element.textContent)
        // A link inside an output must not navigate the app away from the conversation.
        if (tag === 'a' && element.hasAttribute('href')) {
          element.setAttribute('target', '_blank')
          element.setAttribute('rel', 'noreferrer noopener')
        }
      }
      for (const element of doomed) element.remove()
      return doc.body
    }

    /** Render one HTML output without letting it into the panel's document. */
    function HtmlOutput(props) {
      const host = React.useRef(null)
      React.useEffect(() => {
        const element = host.current
        if (element === null || element === undefined) return
        const body = sanitizeHtml(props.html)
        if (body === null) {
          // No parser at all: text is a better answer than an empty box.
          element.textContent = String(props.html ?? '').replace(/<[^>]*>/g, ' ')
          return
        }
        if (typeof element.attachShadow !== 'function') {
          element.textContent = String(body.textContent ?? '')
          return
        }
        const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' })
        shadow.textContent = ''
        const base = document.createElement('style')
        base.textContent = HTML_BASE_CSS
        shadow.appendChild(base)
        for (const node of Array.from(body.childNodes)) shadow.appendChild(node)
      }, [props.html])
      return h('div', { className: 'dshj-html', ref: host })
    }

    /** One output entry. */
    function Output(props) {
      const output = props.output ?? {}
      // A stored image carries a URL (the host serves it with an immutable cache header); the
      // fallback is an inline data URL, which only appears when no store is configured.
      if (output.type === 'image') return h('img', { className: 'dshj-img', src: output.url ?? output.dataUrl, alt: 'cell output', loading: 'lazy' })
      if (output.type === 'html') return h(HtmlOutput, { html: output.text })
      if (output.type === 'markdown') return h(Markdown, { source: output.text })
      const className = output.type === 'error' ? 'dshj-pre dshj-error' : output.type === 'stream' && output.name === 'stderr' ? 'dshj-pre dshj-stderr' : 'dshj-pre'
      return h('pre', { className }, output.text)
    }

    /**
     * One cell: read mode, edit mode, outputs, and its action row.
     *
     * Memoized because a notebook is a list of independent cells and a run touches one of them:
     * without this, every streamed chunk re-rendered every other cell in the notebook, and a
     * hundred-cell document with plots in it made the browser the bottleneck the host had just
     * stopped being. The parent keeps the props shallow-equal for untouched cells — same cell
     * object, same callbacks, same translator.
     */
    const Cell = React.memo(function Cell(props) {
      const { cell, index, count, t, busy, editing, draft, onEdit, onDraft, onCommit, onCancel, onRun, onDelete, onMove, onClear, onKind } = props
      const isEditing = editing === cell.id
      const isMarkdown = cell.kind === 'markdown'
      const textarea = React.useRef(null)
      const editorWrap = React.useRef(null)

      /** Grow the editor to its content, so both layers keep the same height and nothing scrolls. */
      const fit = () => {
        const element = textarea.current
        if (element === null || element === undefined || !element.style) return
        element.style.height = 'auto'
        element.style.height = `${element.scrollHeight}px`
      }

      /**
       * While an IME is composing, the textarea's own text has to be visible.
       *
       * The textarea is transparent so the coloured copy underneath shows through — but the pinyin
       * a Chinese user is still choosing lives only in the textarea, so during composition the
       * highlight layer is hidden and the textarea's colour is restored.
       */
      const composing = (active) => () => {
        const element = editorWrap.current
        if (element === null || element === undefined || typeof element.setAttribute !== 'function') return
        if (active) element.setAttribute('data-composing', 'true')
        else element.removeAttribute('data-composing')
      }

      React.useEffect(() => {
        if (!isEditing) return
        fit()
        if (textarea.current !== null) {
          textarea.current.focus()
          // Put the caret at the end rather than selecting everything.
          const value = textarea.current.value
          textarea.current.setSelectionRange(value.length, value.length)
        }
      }, [isEditing, cell.kind])

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && (event.shiftKey || event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          onRun(cell.id, draft)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }

      const head = h('div', { className: 'dshj-cell-head' },
        h('button', {
          type: 'button',
          className: 'dshj-kind',
          title: t('toggleKind'),
          onClick: () => onKind(cell.id, isMarkdown ? 'code' : 'markdown'),
        }, isMarkdown ? 'MD' : 'Py'),
        cell.origin === 'agent' ? h('span', { className: 'dshj-origin', title: t('agentCell') }, t('agent')) : null,
        h('span', { className: 'dshj-count' }, cell.executionCount === null || cell.executionCount === undefined ? (busy ? '…' : '') : `[${cell.executionCount}]`),
        cell.status === 'running' || busy ? h('span', { className: 'dshj-running' }, t('running')) : null,
        h('span', { className: 'dshj-head-spacer' }),
        isEditing
          ? h('button', { type: 'button', className: 'dshj-btn dshj-btn-primary', onClick: () => onCommit(cell.id, draft) }, t('done'))
          : h('button', { type: 'button', className: 'dshj-btn dshj-btn-primary', title: t('runHint'), onClick: () => onRun(cell.id, cell.source) }, isMarkdown ? t('render') : t('run')),
        h('button', { type: 'button', className: 'dshj-btn', title: t('up'), disabled: index === 0, onClick: () => onMove(cell.id, -1) }, '↑'),
        h('button', { type: 'button', className: 'dshj-btn', title: t('down'), disabled: index === count - 1, onClick: () => onMove(cell.id, 1) }, '↓'),
        h('button', { type: 'button', className: 'dshj-btn', title: t('clearOutputs'), onClick: () => onClear(cell.id) }, '⌫'),
        h('button', { type: 'button', className: 'dshj-btn', title: t('remove'), onClick: () => onDelete(cell.id) }, '✕'))

      const editor = h('textarea', {
        ref: textarea,
        className: 'dshj-editor',
        value: draft,
        spellCheck: false,
        placeholder: isMarkdown ? t('mdPlaceholder') : t('placeholder'),
        onChange: (event) => {
          onDraft(event.target.value)
          fit()
        },
        onCompositionStart: composing(true),
        onCompositionEnd: composing(false),
        onKeyDown,
      })

      const body = isEditing
        // A code cell edits as a transparent textarea over its own highlighted copy: native
        // caret, selection and IME, with the colours underneath. A markdown cell edits plainly,
        // because Python's tokenizer would colour prose nonsense.
        ? (isMarkdown
          ? editor
          : h('div', { className: 'dshj-editor-wrap', ref: editorWrap },
            h('pre', { className: 'dshj-hl', 'aria-hidden': 'true' }, tokenNodes(tokenizePython(draft)), '\n'),
            editor))
        : (isMarkdown
          ? h('div', {
            className: 'dshj-source',
            'data-empty': cell.source.trim().length === 0,
            title: t('editHint'),
            onDoubleClick: () => onEdit(cell.id, cell.source),
          }, cell.source.trim().length === 0 ? t('mdPlaceholder') : h(Markdown, { source: cell.source }))
          : h('pre', {
            className: 'dshj-source',
            'data-empty': cell.source.trim().length === 0,
            title: t('editHint'),
            onDoubleClick: () => onEdit(cell.id, cell.source),
          }, cell.source.trim().length === 0 ? t('placeholder') : tokenNodes(tokenizePython(cell.source))))

      const outputs = []
      if (cell.error !== null && cell.error !== undefined) outputs.push(h('div', { className: 'dshj-err', key: 'err' }, cell.error))
      for (let i = 0; i < (cell.outputs ?? []).length; i += 1) {
        outputs.push(h(Output, { key: `o${i}`, output: cell.outputs[i] }))
      }

      return h('div', { className: 'dshj-cell', 'data-editing': String(isEditing), 'data-status': cell.status },
        head,
        body,
        outputs.length > 0 ? h('div', { className: 'dshj-out' }, outputs) : null)
    })

    /**
     * Merge a freshly fetched view into the one on screen.
     *
     * A view is JSON, so every fetch produces new objects for cells that did not change. Keeping
     * the previous object when a cell's `rev` still matches is what lets `React.memo` skip it: the
     * alternative — re-rendering a hundred cells because a poll came back — is exactly the cost
     * this panel cannot afford. A running cell is never reused: its outputs change without a `rev`
     * bump, so its identity must change with them.
     */
    function mergeView(current, next) {
      if (current === null || !Array.isArray(current.cells) || !Array.isArray(next?.cells)) return next
      const previous = new Map(current.cells.map((cell) => [cell.id, cell]))
      return {
        ...next,
        cells: next.cells.map((cell) => {
          const old = previous.get(cell.id)
          return old !== undefined && old.rev === cell.rev && cell.status !== 'running' ? old : cell
        }),
      }
    }

    /** Apply one streamed event to the view on screen. */
    function applyEvent(current, event) {
      if (current === null || event === null || typeof event !== 'object') return current
      const cells = current.cells ?? []
      if (event.type === 'insert') {
        // A cell the host added on its own — today, a run the agent performed. Unlike a `cell`
        // event this one is allowed to grow the list; a repeated id replaces instead of doubling.
        const cell = event.cell
        if (cell === undefined || cell === null) return current
        const revision = event.revision ?? current.revision
        const existing = cells.findIndex((candidate) => candidate.id === cell.id)
        if (existing !== -1) {
          const next = [...cells]
          next[existing] = cell
          return { ...current, revision, cells: next }
        }
        const at = Number.isInteger(event.index) ? Math.min(Math.max(event.index, 0), cells.length) : cells.length
        return { ...current, revision, cells: [...cells.slice(0, at), cell, ...cells.slice(at)] }
      }
      if (event.type === 'cell') {
        const cell = event.cell
        if (cell === undefined || cell === null) return current
        const index = cells.findIndex((candidate) => candidate.id === cell.id)
        // A cell deleted while it was running still reports; there is nothing to show it in.
        if (index === -1) return current
        const next = [...cells]
        next[index] = cell
        return { ...current, revision: event.revision ?? current.revision, cells: next }
      }
      if (event.type !== 'append' && event.type !== 'text' && event.type !== 'clear') return current
      const index = cells.findIndex((candidate) => candidate.id === event.cellId)
      if (index === -1) return current
      const cell = cells[index]
      const outputs = cell.outputs ?? []
      let updated
      if (event.type === 'clear') {
        updated = []
      } else if (event.type === 'append') {
        updated = [...outputs, event.output]
      } else {
        const target = outputs[event.index]
        if (target === undefined) return current
        updated = [...outputs]
        updated[event.index] = { ...target, text: `${target.text ?? ''}${event.text}` }
      }
      const next = [...cells]
      next[index] = { ...cell, outputs: updated }
      return { ...current, cells: next }
    }

    /** Flip one cell to `running` before the host has answered, so the click feels immediate. */
    function markRunning(current, id) {
      if (current === null) return current
      const cells = current.cells ?? []
      const index = cells.findIndex((cell) => cell.id === id)
      if (index === -1) return current
      const next = [...cells]
      next[index] = { ...cells[index], status: 'running' }
      return { ...current, cells: next }
    }

    /** The panel body registered into the right sidebar's tab seat. */
    function Notebook(props) {
      ensureStyles()
      const { sessionId, t, useTabInfo } = props
      const [view, setView] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [runningId, setRunningId] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [drafts, setDrafts] = React.useState({})
      const [live, setLive] = React.useState(false)
      const [notesOpen, setNotesOpen] = React.useState(false)

      /**
       * Latest values, for the callbacks that must stay identical across renders.
       *
       * `Cell` is memoized, which only pays off if its props are shallow-equal for cells that did
       * not change — and an inline arrow function is never equal to the last one. The handlers
       * therefore have empty dependency lists and read what they need from here.
       */
      const stateRef = React.useRef(null)
      const sendRef = React.useRef(null)
      stateRef.current = { editing, drafts, cells: view?.cells ?? [] }

      /**
       * Adopt a view returned by the host and remember its revision.
       *
       * A full view is a snapshot taken when the request was handled, and it travels over a
       * different connection than the stream. It can therefore land *after* a newer streamed
       * event and, without this guard, replace the panel with an older notebook. Ignoring a view
       * older than the highest revision already seen keeps the stream authoritative; the next
       * poll fetches whatever was actually missed.
       */
      const adopt = React.useCallback((next) => {
        const known = panelRevisions.get(sessionId)
        if (typeof next?.revision === 'number' && typeof known === 'number' && next.revision < known) return
        panelRevisions.set(sessionId, next.revision)
        setView((current) => mergeView(current, next))
        setError(null)
      }, [sessionId])

      const load = React.useCallback(async () => {
        try {
          adopt(await callHost(sessionId))
        } catch (cause) {
          setError(cause.message)
        }
      }, [sessionId, adopt])

      React.useEffect(() => { load() }, [load])

      // If the agent ran something in the shared kernel, this picks it up. `since` keeps the steady
      // state down to a two-field answer, and a failed poll never replaces a working panel with an
      // error banner — the next successful poll, or a click, will repair it.
      const poll = React.useCallback(async () => {
        try {
          const next = await callHost(sessionId, undefined, panelRevisions.get(sessionId))
          if (next?.unchanged !== true) {
            adopt(next)
          } else if (typeof next.pendingNotes === 'number') {
            // The notes were handed to the agent: that changes no cell, so the badge is the only
            // thing the short answer has to correct.
            setView((current) => current === null || current.pendingNotes === next.pendingNotes
              ? current
              : { ...current, pendingNotes: next.pendingNotes, notes: next.notes ?? [] })
          }
        } catch {
          // Deliberately silent.
        }
      }, [sessionId, adopt])

      // The stream is the primary path: output arrives here as the kernel produces it. Opening it
      // also re-syncs, because a reconnect may have missed events while the connection was down —
      // and `EventSource` reconnects by itself, so a dropped stream heals without the user.
      React.useEffect(() => {
        if (typeof EventSource === 'undefined') return undefined
        const source = new EventSource(`${STREAM_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`)
        source.onopen = () => {
          setLive(true)
          load()
        }
        source.onmessage = (message) => {
          let event
          try {
            event = JSON.parse(message.data)
          } catch {
            return
          }
          // Keep the poll's `since` in step with what the stream delivered, or the next poll would
          // fetch the whole notebook just to learn what it already has.
          if (typeof event?.revision === 'number') panelRevisions.set(sessionId, event.revision)
          setView((current) => applyEvent(current, event))
        }
        source.onerror = () => {
          setLive(false)
        }
        return () => {
          source.close()
          setLive(false)
        }
      }, [sessionId, load])

      React.useEffect(() => {
        // Only a visible panel polls: a hidden one would spend the user's battery to learn nothing.
        if (typeof document === 'undefined' || document.visibilityState !== 'visible') return undefined
        const interval = live ? POLL_INTERVAL_LIVE_MS : POLL_INTERVAL_MS
        const timer = setInterval(poll, interval)
        const wake = () => { if (document.visibilityState === 'visible') poll() }
        window.addEventListener('focus', wake)
        document.addEventListener('visibilitychange', wake)
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', wake)
          document.removeEventListener('visibilitychange', wake)
        }
      }, [poll, live])

      const send = React.useCallback(async (command, label, options) => {
        const silent = options?.silent === true
        if (!silent) setBusy(label)
        try {
          adopt(await callHost(sessionId, command))
        } catch (cause) {
          setError(cause.message)
        } finally {
          if (!silent) setBusy(null)
        }
      }, [sessionId, adopt])
      sendRef.current = send

      const onEdit = React.useCallback((id, source) => {
        setEditing(id)
        setDrafts((current) => ({ ...current, [id]: source }))
      }, [])

      const onDraft = React.useCallback((value) => {
        const id = stateRef.current.editing
        setDrafts((current) => ({ ...current, [id]: value }))
      }, [])

      const onCommit = React.useCallback((id, source) => {
        setEditing(null)
        const cell = stateRef.current.cells.find((candidate) => candidate.id === id)
        if (cell !== undefined && cell.source === source) return
        sendRef.current({ action: 'updateCell', id, source }, 'updateCell')
      }, [])

      const onCancel = React.useCallback(() => setEditing(null), [])

      // `Shift+Enter` carries the source with the run: one request instead of two, and the cell
      // starts executing immediately rather than after a full round trip spent saving it. The host
      // answers as soon as the kernel has the code; everything after that arrives on the stream.
      // A markdown cell skips the "running" state: rendering prose is not an execution.
      const onRun = React.useCallback(async (id, source) => {
        setEditing(null)
        const cell = stateRef.current.cells.find((candidate) => candidate.id === id)
        const markdown = cell?.kind === 'markdown'
        if (!markdown) {
          setRunningId(id)
          setView((current) => markRunning(current, id))
        }
        try {
          await sendRef.current({ action: 'runCell', id, source }, 'runCell', { silent: true })
        } finally {
          if (!markdown) setRunningId(null)
        }
      }, [])

      const onDelete = React.useCallback((id) => { sendRef.current({ action: 'deleteCell', id }, 'deleteCell') }, [])
      const onMove = React.useCallback((id, delta) => { sendRef.current({ action: 'moveCell', id, delta }, 'moveCell') }, [])
      const onClear = React.useCallback((id) => { sendRef.current({ action: 'clearOutput', id }, 'clearOutput') }, [])
      const onKind = React.useCallback((id, kind) => { sendRef.current({ action: 'updateCell', id, kind }, 'updateCell') }, [])

      if (view === null && error === null) return h('div', { className: 'dshj-note' }, t('loading'))
      if (view === null) {
        return h('div', { className: 'dshj-root' },
          h('div', { className: 'dshj-err' }, error),
          h('div', { className: 'dshj-note' }, h('button', { type: 'button', className: 'dshj-btn', onClick: load }, t('retry'))))
      }

      const cells = view.cells ?? []
      const kernel = view.kernel
      const busyCell = busy !== null || runningId !== null
      const kernelText = kernel === undefined || kernel === null
        ? t('noKernel')
        : `${t('kernel')} ${kernel.name} · ${kernel.state} · ${String(kernel.id).slice(0, 8)}`

      return h('div', { className: 'dshj-root' },
        h('div', { className: 'dshj-bar' },
          h('span', { className: 'dshj-kernel', title: kernelText },
            h('span', { className: 'dshj-dot', 'data-ready': String(kernel !== undefined && kernel !== null), 'data-busy': String(busyCell) }),
            kernelText),
          (view.pendingNotes ?? 0) > 0
            ? h('button', {
              type: 'button',
              className: 'dshj-sync',
              title: t('syncHint'),
              'aria-expanded': String(notesOpen),
              onClick: () => setNotesOpen((open) => !open),
            }, `${view.pendingNotes} ${t('syncLabel')}`)
            : null,
          h('button', { type: 'button', className: 'dshj-btn', disabled: busy !== null, onClick: () => send({ action: 'addCell' }, 'addCell') }, t('addCell')),
          h('button', { type: 'button', className: 'dshj-btn', disabled: kernel === undefined || kernel === null, onClick: () => send({ action: 'interrupt' }, 'interrupt') }, t('interrupt')),
          h('button', { type: 'button', className: 'dshj-btn', disabled: busy !== null, onClick: () => send({ action: 'restartKernel' }, 'restartKernel') }, t('restart')),
          h('button', { type: 'button', className: 'dshj-btn', disabled: busy !== null, onClick: () => send({ action: 'clearAllOutputs' }, 'clearAllOutputs') }, t('clearOutputs'))),
        notesOpen && (view.pendingNotes ?? 0) > 0
          ? h('div', { className: 'dshj-notes' },
            h('div', { className: 'dshj-notes-head' },
              h('span', null, t('notesTitle')),
              h('button', {
                type: 'button',
                className: 'dshj-btn',
                onClick: () => {
                  setNotesOpen(false)
                  send({ action: 'discardNotes' }, 'discardNotes')
                },
              }, t('discardNotes'))),
            (view.notes ?? []).map((note, index) => h('div', {
              key: note.key ?? `note-${index}`,
              className: 'dshj-note-row',
            }, note.summary)))
          : null,
        error !== null ? h('div', { className: 'dshj-err' }, error) : null,
        h('div', { className: 'dshj-cells' },
          cells.length === 0 ? h('div', { className: 'dshj-note' }, t('empty')) : null,
          cells.map((cell, index) => h(Cell, {
            key: cell.id,
            cell,
            index,
            count: cells.length,
            t,
            busy: runningId === cell.id,
            editing,
            draft: drafts[cell.id] ?? cell.source,
            onEdit,
            onDraft,
            onCommit,
            onCancel,
            onRun,
            onDelete,
            onMove,
            onClear,
            onKind,
          }))))
    }

    /** The tab chip, so a background notebook still shows its name. */
    function NotebookTitle(props) {
      return h('span', null, props.t('title'))
    }

    /** Composer button that opens the panel, and opens it once on first load. */
    function OpenButton(props) {
      const { t, sidebarRight } = props
      React.useEffect(() => {
        if (openRequested) return
        openRequested = true
        // Best effort: the seat exists only once a Session is on screen, which is exactly when
        // this component mounts, but the runtime may still be minting its store.
        try {
          sidebarRight.openTab(KIND)
        } catch {
          const timer = setTimeout(() => {
            try {
              sidebarRight.openTab(KIND)
            } catch {
              // The user can always open it from the button below.
            }
          }, 1000)
          return () => clearTimeout(timer)
        }
      }, [sidebarRight, t])
      return h('button', {
        type: 'button',
        className: 'dshj-btn',
        title: t('openLabel'),
        onClick: () => {
          try {
            sidebarRight.openTab(KIND)
          } catch {
            // Nothing more to do; the sidebar controller rejects an unmounted session.
          }
        },
      }, t('open'))
    }

    /** Whether this page already auto-opened the panel. */
    let openRequested = false

    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']

    function apply(ctx) {
      ensureStyles()
      // Register the dictionaries before binding a translator to the namespace.
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'jupyterlab: dictionaries')
      const t = ctx.locale.bind(NS)

      // 1. The page type: a kind-only tab, so it is opened by name and never claims a resource.
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TYPE_ID,
        kind: KIND,
        priority: 'extension',
        title: () => t('title'),
        keepMounted: true,
        // The panel's own add control lists this, which is the idiomatic way back in after closing.
        guide: [{ id: 'notebook', order: 30, title: () => t('title'), description: () => t('openLabel') }],
      }), 'jupyterlab: notebook tab type')

      // 2. The body and the chip title, both under the type's id.
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TYPE_ID,
        locale: NS,
        inject: (sessionId) => ({ sessionId }),
      }, Notebook))

      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TYPE_ID,
        locale: NS,
      }, NotebookTitle))

      // 3. An entry point in the composer row that also opens the panel on first load.
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'jupyterlab-notebook',
        order: 40,
        locale: NS,
        inject: () => ({ sidebarRight: ctx.sidebarRight }),
      }, OpenButton))
    }

    return { inject, apply }
  },
})
