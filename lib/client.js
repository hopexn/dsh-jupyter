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
     * The notebook as a file.
     *
     * A plain link rather than a command: the browser's own save dialog, the server's own file
     * name, and no multi-megabyte JSON body travelling back through the client.
     */
    const DOWNLOAD_ROUTE = 'api/jupyterlab/notebook/download'
    /**
     * Where unsaved edits are parked across a reload.
     *
     * `sessionStorage`, not `localStorage`: a draft belongs to this tab. It survives F5 and a
     * crashed renderer, and it dies with the tab — the alternative leaves someone's abandoned
     * half-written cell waiting behind a cell id that no longer exists in a later session.
     */
    const DRAFT_PREFIX = 'dshj:draft:'
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
      runAll: 'Run all',
      runAllHint: 'Run every code cell, top to bottom',
      stopRunAll: 'Stop',
      stopRunAllHint: 'Interrupt the running cell and stop the sequence',
      exportIpynb: 'Export',
      exportHint: 'Download this notebook as a .ipynb file',
      importIpynb: 'Import',
      importHint: 'Replace this notebook with a .ipynb file',
      importBad: 'That file is not JSON — a notebook is a .ipynb file.',
      insertBelow: 'Insert a cell below',
      showMore: 'Show more',
      showLess: 'Show less',
      dismiss: 'Dismiss',
      cellLabel: 'Cell',
      outputLabel: 'Cell output',
      toCode: 'Turn this into a code cell',
      toMarkdown: 'Turn this into a markdown cell',
      editorHint: 'Shift+Enter runs · Ctrl/Cmd+Enter runs in place · Tab indents · Esc leaves',
      changed: 'Changed',
      changedByAgent: 'The agent changed this cell',
      keepChange: 'Keep',
      undoChange: 'Undo',
      notebookPicker: 'Notebook in this session',
      newNotebook: '+ New',
      newNotebookHint: 'Start another notebook in this session',
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
      runAll: '全部运行',
      runAllHint: '自上而下运行所有代码单元格',
      stopRunAll: '停止',
      stopRunAllHint: '中断当前单元格并停止后续',
      exportIpynb: '导出',
      exportHint: '把本笔记本下载为 .ipynb 文件',
      importIpynb: '导入',
      importHint: '用 .ipynb 文件替换当前笔记本',
      importBad: '这个文件不是 JSON —— 笔记本是 .ipynb 文件。',
      insertBelow: '在下方插入单元格',
      showMore: '展开',
      showLess: '收起',
      dismiss: '关闭',
      cellLabel: '单元格',
      outputLabel: '单元格输出',
      toCode: '转为代码单元格',
      toMarkdown: '转为 markdown 单元格',
      editorHint: 'Shift+Enter 运行 · Ctrl/Cmd+Enter 原地运行 · Tab 缩进 · Esc 退出编辑',
      changed: '有改动',
      changedByAgent: '模型改写了这个单元格',
      keepChange: '保留',
      undoChange: '撤销',
      notebookPicker: '本会话中的笔记本',
      newNotebook: '+ 新建',
      newNotebookHint: '在本会话中再开一个笔记本',
    }

    /** Panel styles: theme tokens only, so light and dark both come out right. */
    const CSS = `
.dshj-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); font-size:13px; }
.dshj-bar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:8px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); position:sticky; top:0; background:var(--dsw-specific-sidebar-fill); z-index:2; }
.dshj-kernel { color:var(--dsw-alias-label-secondary); font-size:12px; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshj-sync { flex:0 0 auto; font:inherit; font-size:11px; line-height:16px; padding:0 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary); white-space:nowrap; cursor:pointer; }
.dshj-sync:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-label-secondary); }
/* A session holds several notebooks; the picker is the only way between them. */
.dshj-picker { flex:0 1 auto; min-width:0; max-width:14em; font:inherit; font-size:11px; line-height:18px; padding:0 4px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dshj-picker:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-label-secondary); }
.dshj-new { flex:0 0 auto; font-size:11px; line-height:16px; padding:0 6px; }
.dshj-notes { border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); padding:8px 10px; font-size:12px; }
.dshj-notes-head { display:flex; align-items:center; gap:6px; margin-bottom:6px; color:var(--dsw-alias-label-secondary); }
.dshj-notes-head > span { flex:1; }
.dshj-note-row { padding:4px 0; border-top:1px dashed var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.dshj-origin { font-size:10px; line-height:16px; padding:0 5px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
/* The model rewrote this cell; the marker is a button because the change is worth reading. */
.dshj-changed { font:inherit; font-size:10px; line-height:16px; padding:0 5px; border-radius:4px; border:1px solid var(--dsw-alias-state-warn-primary); background:transparent; color:var(--dsw-alias-state-warn-primary); white-space:nowrap; cursor:pointer; }
.dshj-diff { border-top:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); padding:6px 10px; max-height:20em; overflow:auto; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.45; }
.dshj-diff-head { display:flex; align-items:center; gap:6px; margin-bottom:6px; font-family:inherit; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dshj-diff-head > span { flex:1; }
.dshj-diff-row { white-space:pre-wrap; word-break:break-word; }
.dshj-diff-sign { display:inline-block; width:1ch; margin-right:1ch; color:var(--dsw-alias-label-secondary); user-select:none; }
.dshj-diff-add .dshj-diff-sign { color:var(--dsw-alias-state-success-primary); }
.dshj-diff-del .dshj-diff-sign { color:var(--dsw-alias-state-error-primary); }
.dshj-diff-add { background:var(--dsw-alias-bg-layer-1); }
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
/* A long output is read by scrolling once you are interested, but it should not push the rest of
   the notebook off the screen while you are not. The fade says "this continues" without a border. */
.dshj-fold { position:relative; }
.dshj-fold[data-open="false"] .dshj-fold-body { max-height:16em; overflow:hidden; }
.dshj-fold[data-open="false"] .dshj-fold-body::after { content:''; position:absolute; left:0; right:0; bottom:0; height:2.5em; pointer-events:none; background:linear-gradient(to bottom,transparent,var(--dsw-alias-bg-base)); }
.dshj-fold-btn { align-self:flex-start; margin-top:2px; font-size:11px; padding:1px 7px; color:var(--dsw-alias-label-secondary); }
.dshj-notice { display:flex; gap:8px; align-items:flex-start; padding:6px 10px; font-size:12px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); border-bottom:1px solid var(--dsw-alias-border-l1); }
.dshj-notice > span { flex:1; white-space:pre-wrap; }
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
    // everything else. That is enough for the languages a kernel actually speaks here, and it
    // costs one pass per visible cell instead of a grammar the size of the app.
    //
    // Which language a cell is written in comes from the kernel, not from the notebook: the same
    // page may be attached to Python, R or Julia. Colouring an R cell with Python's keywords is
    // worse than not colouring it — `function`, `<-` and `TRUE` are the whole vocabulary of an R
    // cell, and none of them is a Python word.
    // -------------------------------------------------------------------------------------------

    /** Python keywords. */
    const PY_KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '))
    /** Names that exist without an import: worth a colour, but not the keyword's colour. */
    const PY_BUILTINS = new Set('abs all any ascii bin bool bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __name__ __file__ self cls'.split(' '))
    /** R keywords, including the constants that read as literals. */
    const R_KEYWORDS = new Set('if else repeat while function for in next break TRUE FALSE NULL NA NA_integer_ NA_real_ NA_character_ Inf NaN'.split(' '))
    /** R's everyday functions, coloured as builtins rather than as user names. */
    const R_BUILTINS = new Set('c list vector matrix data.frame print cat paste paste0 library require length names seq rep sum mean median sd var min max abs round sqrt exp log sin cos tan apply sapply lapply tapply mapply Map Filter Reduce str summary head tail subset merge order sort unique which rm setwd getwd read.csv write.csv ggplot aes'.split(' '))
    /** Julia keywords. */
    const JL_KEYWORDS = new Set('function end if else elseif for while let begin struct mutable return using import export module const global local do try catch finally where abstract primitive type quote macro break continue true false nothing missing'.split(' '))
    /** Julia's base functions, again only for colour. */
    const JL_BUILTINS = new Set('println print show display length size push! pop! map filter reduce sum prod minimum maximum abs sqrt exp log sin cos tan range collect enumerate zip keys values haskey typeof isa convert string Symbol Array Dict Set Vector Matrix Int Float64 String Bool Any'.split(' '))

    /**
     * One token per language, in priority order.
     *
     * Every alternative consumes at least one character, so the scan always advances. Strings are
     * matched before comments (a `#` inside a string is not a comment) and comments before
     * everything else. The groups are numbered so each language can classify its own match.
     */
    /** Python: [1] magic, [2] comment, [3] string, [4] decorator, [5] number, [6] name, [7] operator. */
    const PY_TOKEN = /(^[ \t]*[%!][^\n]*)|(#[^\n]*)|([rRbBuUfF]{0,2}(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"))|(@[A-Za-z_][\w.]*)|(\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?[jJ]?)\b)|([A-Za-z_]\w*)|([+\-*/%=<>!&|^~]+|:=|->)/m
    /** R: [1] comment, [2] string (backticks are names), [3] number, [4] name, [5] operator. */
    const R_TOKEN = /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`[^`\n]*`)|(\b(?:0[xX][0-9a-fA-F]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?[Li]?)\b)|([A-Za-z.][\w.]*)|(<<-|->>|<-|->|%[^%\n]*%|\|>|:::+|[+\-*/^!&|~=<>$@?:]+)/m
    /** Julia: [1] comment (line or `#= =#`), [2] string, [3] number, [4] name (may end in `!`), [5] operator. */
    const JL_TOKEN = /(#[^\n]*|#=[\s\S]*?=#)|("""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b(?:0[xX][0-9a-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)\b)|([A-Za-z_]\w*!?)|(=>|->|\.\.\.|==|!=|<=|>=|&&|\|\||[+\-*/\\^%=<>!&|~?:.]+)/m

    /** Which group of {@link PY_TOKEN} matched. */
    function classOfPython(match) {
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

    /** Which group of {@link R_TOKEN} matched. */
    function classOfR(match) {
      if (match[1] !== undefined) return 'com'
      if (match[2] !== undefined) return 'str'
      if (match[3] !== undefined) return 'num'
      if (match[5] !== undefined) return 'op'
      const word = match[4]
      if (R_KEYWORDS.has(word)) return 'kw'
      if (R_BUILTINS.has(word)) return 'bi'
      return 'id'
    }

    /** Which group of {@link JL_TOKEN} matched. */
    function classOfJulia(match) {
      if (match[1] !== undefined) return 'com'
      if (match[2] !== undefined) return 'str'
      if (match[3] !== undefined) return 'num'
      if (match[5] !== undefined) return 'op'
      const word = match[4]
      if (JL_KEYWORDS.has(word)) return 'kw'
      if (JL_BUILTINS.has(word)) return 'bi'
      return 'id'
    }

    /**
     * The languages the panel can colour, and the chip its cells show.
     *
     * `plain` is not a language: it is the honest answer for a kernel nobody here wrote a
     * tokenizer for, and it means "render the text, claim nothing".
     */
    const LANGUAGES = {
      python: { chip: 'Py', pattern: PY_TOKEN, classOf: classOfPython, definitions: new Set(['def', 'class']) },
      r: { chip: 'R', pattern: R_TOKEN, classOf: classOfR, definitions: null },
      julia: { chip: 'Jl', pattern: JL_TOKEN, classOf: classOfJulia, definitions: new Set(['function', 'struct', 'macro', 'module']) },
      plain: { chip: '<>', pattern: null, classOf: null, definitions: null },
    }

    /**
     * Which language the bound kernel speaks.
     *
     * Kernel names come from kernelspecs, which are conventionally `python3`, `ir`, `julia-1.10`.
     * Everything else — a Scala or a C++ kernel — is deliberately `plain` rather than "probably
     * Python": a wrong colour teaches the user a wrong grammar.
     *
     * @param kernel - The view's `kernel` field, possibly absent before the first run.
     */
    function languageFor(kernel) {
      const name = String(kernel?.name ?? '').toLowerCase()
      if (name === 'ir' || /^r(?:$|[-_.\d])/.test(name)) return 'r'
      if (name.startsWith('julia')) return 'julia'
      // No kernel yet: the panel is advertised as a Python notebook and the placeholder says so.
      if (name === '' || /^(?:python|ipython|py)\d*$/.test(name)) return 'python'
      return 'plain'
    }

    /**
     * Split source into coloured runs.
     *
     * @param source - Cell text.
     * @param language - One of {@link LANGUAGES}; unknown values fall back to Python.
     * @returns `{ text, cls }` entries, in order, covering the input exactly.
     */
    function tokenize(source, language) {
      const text = String(source ?? '')
      const spec = LANGUAGES[language] ?? LANGUAGES.python
      if (spec.pattern === null) return [{ text, cls: 'txt' }]
      const token = new RegExp(spec.pattern.source, 'gm')
      const tokens = []
      let cursor = 0
      let match = token.exec(text)
      while (match !== null) {
        if (match.index > cursor) tokens.push({ text: text.slice(cursor, match.index), cls: 'txt' })
        cursor = match.index + match[0].length
        tokens.push({ text: match[0], cls: spec.classOf(match) })
        match = token.exec(text)
      }
      if (cursor < text.length) tokens.push({ text: text.slice(cursor), cls: 'txt' })
      return nameTokens(tokens, spec.definitions)
    }

    /** Second pass: a name after a definition keyword is a definition, a name before `(` a call. */
    function nameTokens(tokens, definitions) {
      for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i].cls !== 'id') continue
        let before = i - 1
        while (before >= 0 && tokens[before].cls === 'txt' && tokens[before].text.trim() === '') before -= 1
        if (definitions !== null && before >= 0 && tokens[before].cls === 'kw' && definitions.has(tokens[before].text)) {
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
            h('code', null, /^(?:py|python|python3)$/i.test(language) ? tokenNodes(tokenize(code, 'python')) : code)))
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

    /** Above this many lines — or characters — an output starts folded. */
    const FOLD_LINES = 24
    const FOLD_CHARS = 4000
    /** Markup has no line count worth trusting, so a table folds on size alone. */
    const FOLD_HTML_CHARS = 2000

    /**
     * Whether an output is long enough to start folded.
     *
     * Collapsing is a reading aid, not a budget: the text is already in the page, and unfolding is
     * one click. What it buys is that a cell printing a stack trace or a whole log no longer pushes
     * the next cell off the screen by itself.
     */
    function isLong(output) {
      const text = String(output?.text ?? '')
      if (output?.type === 'html') return text.length > FOLD_HTML_CHARS
      if (text.length > FOLD_CHARS) return true
      let lines = 1
      for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10 && (lines += 1) > FOLD_LINES) return true
      }
      return false
    }

    /**
     * A block that starts folded when it is long, with the state kept locally.
     *
     * The hooks rule matters here: `useState` is called before the early return, so a cell that
     * grows past the threshold mid-run keeps its component identity (and its open/closed state)
     * instead of remounting.
     */
    function Collapsible(props) {
      const [open, setOpen] = React.useState(false)
      if (!props.long) return h('div', { className: 'dshj-fold', 'data-open': 'true' }, h('div', { className: 'dshj-fold-body' }, props.children))
      return h('div', { className: 'dshj-fold', 'data-open': String(open) },
        h('div', { className: 'dshj-fold-body' }, props.children),
        h('button', {
          type: 'button',
          className: 'dshj-btn dshj-fold-btn',
          'aria-expanded': String(open),
          onClick: () => setOpen((value) => !value),
        }, open ? (props.less ?? 'Show less') : (props.more ?? 'Show more')))
    }

    /** One output entry. */
    function Output(props) {
      const output = props.output ?? {}
      const t = props.t
      // A stored image carries a URL (the host serves it with an immutable cache header); the
      // fallback is an inline data URL, which only appears when no store is configured.
      if (output.type === 'image') return h('img', { className: 'dshj-img', src: output.url ?? output.dataUrl, alt: 'cell output', loading: 'lazy' })
      const long = isLong(output)
      const labels = { long, more: t?.('showMore'), less: t?.('showLess') }
      if (output.type === 'html') return h(Collapsible, labels, h(HtmlOutput, { html: output.text }))
      if (output.type === 'markdown') return h(Collapsible, labels, h(Markdown, { source: output.text }))
      const className = output.type === 'error' ? 'dshj-pre dshj-error' : output.type === 'stream' && output.name === 'stderr' ? 'dshj-pre dshj-stderr' : 'dshj-pre'
      return h(Collapsible, labels, h('pre', { className }, output.text))
    }

    /** Product of compared line counts above which a diff shows the replacement instead of a table. */
    const DIFF_MAX_CELLS = 400000
    /** Rows a diff may show before it is truncated. */
    const DIFF_MAX_ROWS = 400

    /**
     * A line diff between two versions of one cell.
     *
     * The model rewrites cells; showing the result as a silent swap asks the user to read code
     * they have already read to find out what changed. Unchanged head and tail lines are trimmed
     * first, because an edit in a 200-line cell usually touches three of them — what is left is
     * small enough for a plain LCS table instead of a real diff algorithm.
     *
     * @param before - The source the model replaced.
     * @param after - The source it wrote.
     * @returns `{sign, text}` rows, `sign` being `' '`, `'-'` or `'+'`.
     */
    function diffRows(before, after) {
      const left = String(before ?? '').split('\n')
      const right = String(after ?? '').split('\n')
      if (before === '') return right.map((text) => ({ sign: '+', text }))
      if (after === '') return left.map((text) => ({ sign: '-', text }))
      let head = 0
      while (head < left.length && head < right.length && left[head] === right[head]) head += 1
      let tail = 0
      while (tail < left.length - head && tail < right.length - head
        && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail += 1
      const rows = []
      for (let i = 0; i < head; i += 1) rows.push({ sign: ' ', text: left[i] })
      const a = left.slice(head, left.length - tail)
      const b = right.slice(head, right.length - tail)
      if (a.length * b.length > DIFF_MAX_CELLS) {
        // Not worth a table: say what happened in two blocks instead of hanging the render.
        for (const text of a) rows.push({ sign: '-', text })
        for (const text of b) rows.push({ sign: '+', text })
      } else {
        rows.push(...lcsRows(a, b))
      }
      for (let i = left.length - tail; i < left.length; i += 1) rows.push({ sign: ' ', text: left[i] })
      return rows.length > DIFF_MAX_ROWS
        ? [...rows.slice(0, DIFF_MAX_ROWS - 1), { sign: ' ', text: '…' }]
        : rows
    }

    /** Longest common subsequence of two line arrays, as diff rows. */
    function lcsRows(a, b) {
      const width = b.length + 1
      const table = new Uint32Array((a.length + 1) * width)
      for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
          table[i * width + j] = a[i] === b[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
        }
      }
      const rows = []
      let i = 0
      let j = 0
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
          rows.push({ sign: ' ', text: a[i] })
          i += 1
          j += 1
        } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
          rows.push({ sign: '-', text: a[i] })
          i += 1
        } else {
          rows.push({ sign: '+', text: b[j] })
          j += 1
        }
      }
      while (i < a.length) { rows.push({ sign: '-', text: a[i] }); i += 1 }
      while (j < b.length) { rows.push({ sign: '+', text: b[j] }); j += 1 }
      return rows
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
      const { cell, index, count, t, busy, editing, draft, language, diffOpen, onEdit, onDraft, onCommit, onCancel, onRun, onInsert, onDelete, onMove, onClear, onKind, onToggleDiff, onAcceptDiff, onRevertDiff } = props
      const isEditing = editing === cell.id
      const isMarkdown = cell.kind === 'markdown'
      /** The model rewrote this cell and the panel still holds the text it replaced. */
      const changed = typeof cell.previousSource === 'string'
      const lang = LANGUAGES[language] === undefined ? 'python' : language
      const textarea = React.useRef(null)
      const editorWrap = React.useRef(null)
      /** Caret to restore once React has written the text the keyboard handler produced. */
      const pendingCaret = React.useRef(null)
      /** The cell itself, for the focus that returns here when the editor closes. */
      const host = React.useRef(null)
      const wasEditing = React.useRef(false)

      /** One indentation step. Two spaces: wide enough to read, narrow enough for narrow panels. */
      const INDENT = '  '

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

      // The keyboard handlers below own their edits — Tab indents, Enter carries the indentation —
      // so the caret has to be put back after React has rendered the new text. Doing it in an
      // effect rather than in the handler is what makes it survive the controlled textarea: the
      // value in the DOM is still the old one when the handler returns.
      React.useEffect(() => {
        const target = pendingCaret.current
        const element = textarea.current
        pendingCaret.current = null
        if (target === null || element === null || element === undefined) return
        fit()
        if (typeof element.setSelectionRange === 'function') element.setSelectionRange(target.start, target.end)
      }, [draft])

      // Closing the editor removes the focused textarea from the document, which drops focus on
      // `<body>`: the next Tab then starts at the top of the page instead of the cell the user was
      // working in. `activeElement === body` is what distinguishes a keyboard exit from a click on
      // some other control, which must keep its focus.
      React.useEffect(() => {
        const closed = wasEditing.current && !isEditing
        wasEditing.current = isEditing
        if (!closed) return
        const element = host.current
        if (element === null || element === undefined || typeof element.focus !== 'function') return
        if (typeof document !== 'undefined' && document.activeElement === document.body) element.focus()
      }, [isEditing])

      /** Apply a text edit and place the caret where the edit left it. */
      const edit = (next, start, end = start) => {
        pendingCaret.current = { start, end }
        onDraft(next)
      }

      /** The start of the line the offset is on. */
      const lineStart = (value, offset) => value.lastIndexOf('\n', offset - 1) + 1

      /** Whether a line opens a block, so Enter should indent one level further. */
      const opensBlock = (line) => {
        const text = line.trimEnd()
        if (text.length === 0) return false
        if (lang === 'python') return text.endsWith(':')
        if (lang === 'r' || lang === 'julia') return text.endsWith('{')
        return text.endsWith(':') || text.endsWith('{')
      }

      /**
       * The keyboard of a code editor, not of a form field.
       *
       * `Shift+Enter` runs and leaves; `Ctrl/Cmd+Enter` runs and stays, which is what a user
       * checking one value in a long cell wants. `Tab` indents instead of tabbing away — an editor
       * that moves focus when you press Tab cannot be typed in. `Ctrl/Cmd+S` commits without
       * running, because that is the only "save" the panel has.
       *
       * An IME gets every key: while a composition is open the keystrokes belong to the pinyin.
       */
      const onKeyDown = (event) => {
        if (event?.isComposing === true) return
        const element = event?.target ?? textarea.current ?? {}
        const value = draft
        const start = Number.isInteger(element.selectionStart) ? element.selectionStart : value.length
        const end = Number.isInteger(element.selectionEnd) ? element.selectionEnd : start
        const mod = event.metaKey === true || event.ctrlKey === true
        const stop = () => { if (typeof event.preventDefault === 'function') event.preventDefault() }

        if (event.key === 'Enter') {
          if (event.shiftKey || mod) {
            stop()
            // Run in place keeps the editor open; run-and-leave closes it.
            onRun(cell.id, draft, { keepEditing: mod && !event.shiftKey })
            return
          }
          // Plain Enter: carry the current indentation, and one level deeper after a block opener.
          // Prose is not a block of code, so a markdown line ending in `:` never indents further.
          stop()
          const line = value.slice(lineStart(value, start), start)
          const indent = /^[ \t]*/.exec(line)[0]
          const next = !isMarkdown && opensBlock(line) ? indent + INDENT : indent
          edit(value.slice(0, start) + '\n' + next + value.slice(end), start + 1 + next.length)
          return
        }

        if (event.key === 'Tab') {
          stop()
          const multiline = value.slice(start, end).includes('\n')
          if (!multiline && !event.shiftKey) {
            edit(value.slice(0, start) + INDENT + value.slice(end), start + INDENT.length)
            return
          }
          const from = lineStart(value, start)
          const to = end > start && value[end - 1] === '\n' ? end - 1 : end
          const block = value.slice(from, to)
          const replacement = event.shiftKey ? block.replace(/^(?: {1,2}|\t)/gm, '') : block.replace(/^/gm, INDENT)
          const delta = replacement.length - block.length
          edit(value.slice(0, from) + replacement + value.slice(to), Math.max(from, start + (event.shiftKey ? Math.min(0, delta) : INDENT.length)), Math.max(from, end + delta))
          return
        }

        if (String(event.key).toLowerCase() === 's' && mod) {
          stop()
          onCommit(cell.id, draft, { keepEditing: true })
          return
        }
        if (event.key === 'Escape') {
          stop()
          onCancel()
        }
      }

      const head = h('div', { className: 'dshj-cell-head' },
        h('button', {
          type: 'button',
          className: 'dshj-kind',
          title: t('toggleKind'),
          'aria-label': isMarkdown ? t('toCode') : t('toMarkdown'),
          onClick: () => onKind(cell.id, isMarkdown ? 'code' : 'markdown'),
        }, isMarkdown ? 'MD' : (LANGUAGES[lang]?.chip ?? 'Py')),
        cell.origin === 'agent' ? h('span', { className: 'dshj-origin', title: t('agentCell') }, t('agent')) : null,
        changed
          ? h('button', {
            type: 'button',
            className: 'dshj-changed',
            title: t('changedByAgent'),
            'aria-expanded': String(diffOpen === true),
            onClick: () => onToggleDiff(cell.id),
          }, t('changed'))
          : null,
        h('span', { className: 'dshj-count' }, cell.executionCount === null || cell.executionCount === undefined ? (busy ? '…' : '') : `[${cell.executionCount}]`),
        cell.status === 'running' || busy ? h('span', { className: 'dshj-running', role: 'status' }, t('running')) : null,
        h('span', { className: 'dshj-head-spacer' }),
        isEditing
          ? h('button', { type: 'button', className: 'dshj-btn dshj-btn-primary', onClick: () => onCommit(cell.id, draft) }, t('done'))
          : h('button', { type: 'button', className: 'dshj-btn dshj-btn-primary', title: t('runHint'), onClick: () => onRun(cell.id, cell.source) }, isMarkdown ? t('render') : t('run')),
        // The action row had no way to add a cell in the middle: every new cell went to the end,
        // which made an analysis grow backwards from wherever the user was reading.
        h('button', { type: 'button', className: 'dshj-btn', title: t('insertBelow'), 'aria-label': t('insertBelow'), onClick: () => onInsert(cell.id) }, '+'),
        h('button', { type: 'button', className: 'dshj-btn', title: t('up'), 'aria-label': t('up'), disabled: index === 0, onClick: () => onMove(cell.id, -1) }, '↑'),
        h('button', { type: 'button', className: 'dshj-btn', title: t('down'), 'aria-label': t('down'), disabled: index === count - 1, onClick: () => onMove(cell.id, 1) }, '↓'),
        h('button', { type: 'button', className: 'dshj-btn', title: t('clearOutputs'), 'aria-label': t('clearOutputs'), onClick: () => onClear(cell.id) }, '⌫'),
        h('button', { type: 'button', className: 'dshj-btn', title: t('remove'), 'aria-label': t('remove'), onClick: () => onDelete(cell.id) }, '✕'))

      const editor = h('textarea', {
        ref: textarea,
        className: 'dshj-editor',
        value: draft,
        spellCheck: false,
        title: t('editorHint'),
        'aria-label': isMarkdown ? t('mdPlaceholder') : t('placeholder'),
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
        // because a code tokenizer would colour prose nonsense.
        ? (isMarkdown
          ? editor
          : h('div', { className: 'dshj-editor-wrap', ref: editorWrap },
            h('pre', { className: 'dshj-hl', 'aria-hidden': 'true' }, tokenNodes(tokenize(draft, lang)), '\n'),
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
          }, cell.source.trim().length === 0 ? t('placeholder') : tokenNodes(tokenize(cell.source, lang))))

      const outputs = []
      if (cell.error !== null && cell.error !== undefined) outputs.push(h('div', { className: 'dshj-err', key: 'err', role: 'alert' }, cell.error))
      for (let i = 0; i < (cell.outputs ?? []).length; i += 1) {
        outputs.push(h(Output, { key: `o${i}`, output: cell.outputs[i], t }))
      }

      // What the model replaced, when the user asks to see it. Computed only while open: a closed
      // diff should cost nothing on a cell that is re-rendered by every streamed output.
      const diff = changed && diffOpen === true
        ? h('div', { className: 'dshj-diff', role: 'group', 'aria-label': t('changedByAgent') },
          h('div', { className: 'dshj-diff-head' },
            h('span', null, t('changedByAgent')),
            h('button', { type: 'button', className: 'dshj-btn', onClick: () => onAcceptDiff(cell.id) }, t('keepChange')),
            h('button', { type: 'button', className: 'dshj-btn', onClick: () => onRevertDiff(cell.id) }, t('undoChange'))),
          h('div', { className: 'dshj-diff-body' }, diffRows(cell.previousSource, cell.source).map((row, i) => h('div', {
            key: `diff-${i}`,
            className: `dshj-diff-row dshj-diff-${row.sign === '+' ? 'add' : row.sign === '-' ? 'del' : 'same'}`,
          }, h('span', { className: 'dshj-diff-sign' }, row.sign === ' ' ? '\u00a0' : row.sign), row.text))))
        : null

      return h('div', {
        ref: host,
        className: 'dshj-cell',
        role: 'listitem',
        tabIndex: -1,
        'aria-label': `${t('cellLabel')} ${index + 1}`,
        'aria-busy': String(busy === true || cell.status === 'running'),
        'data-editing': String(isEditing),
        'data-status': cell.status,
      },
        head,
        body,
        diff,
        outputs.length > 0
          ? h('div', { className: 'dshj-out', role: 'group', 'aria-label': t('outputLabel') }, outputs)
          : null)
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
      if (event.type === 'replace') {
        // An import rewrites the whole list. One frame instead of a burst of inserts: the client
        // cannot apply half of it, so it cannot show a notebook that never existed.
        if (!Array.isArray(event.cells)) return current
        return { ...current, revision: event.revision ?? current.revision, cells: event.cells }
      }
      if (event.type === 'runall') {
        // Changes no cell, so it carries no revision bump — only the stop button's meaning.
        return { ...current, runningAll: event.running === true }
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
    function markRunning(current, id) {      if (current === null) return current
      const cells = current.cells ?? []
      const index = cells.findIndex((cell) => cell.id === id)
      if (index === -1) return current
      const next = [...cells]
      next[index] = { ...cells[index], status: 'running' }
      return { ...current, cells: next }
    }

    /**
     * The drafts a reload left behind, or null.
     *
     * Drafts are kept per notebook inside one record: switching pages must not drop the paragraph
     * left in the other one, and a cell id is unique across a session, so nothing collides.
     *
     * Storage is the one API here that can throw for reasons the user did not cause (private
     * mode, a full quota, a disabled third-party-storage policy). A panel that refuses to render
     * because sessionStorage said no would be worse than a panel that forgets a draft.
     */
    function readDrafts(sessionId) {
      try {
        const raw = globalThis.sessionStorage?.getItem(DRAFT_PREFIX + sessionId)
        if (raw === null || raw === undefined) return null
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        const stored = parsed.drafts !== null && typeof parsed.drafts === 'object' ? parsed.drafts : {}
        // Records written before a session could hold several notebooks keep one flat map of
        // cell id to text. That notebook was the only one there was, so the text belongs to
        // `main`; reading it this way means an upgrade does not throw away a half-written cell.
        const legacy = Object.values(stored).some((value) => typeof value === 'string')
        return {
          notebook: typeof parsed.notebook === 'string' ? parsed.notebook : null,
          editing: typeof parsed.editing === 'string' ? parsed.editing : null,
          drafts: legacy ? { main: stored } : stored,
        }
      } catch {
        return null
      }
    }

    /** Replace this tab's stored drafts; null clears them. */
    function writeDrafts(sessionId, value) {
      try {
        const storage = globalThis.sessionStorage
        if (storage === undefined || storage === null) return
        if (value === null) storage.removeItem(DRAFT_PREFIX + sessionId)
        else storage.setItem(DRAFT_PREFIX + sessionId, JSON.stringify(value))
      } catch {
        // See readDrafts: no draft is worth breaking the panel over.
      }
    }

    /** One notebook's drafts out of the session-wide map. */
    function draftsFor(all, notebook) {
      const mine = all?.[notebook]
      return mine !== null && typeof mine === 'object' ? mine : {}
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
      /** Result of the last command that had something to say — an import's dropped items, say. */
      const [notice, setNotice] = React.useState(null)
      /** The cell whose agent diff is open. One at a time, like the editor. */
      const [diffId, setDiffId] = React.useState(null)
      /** The hidden file input the Import button clicks. */
      const fileInput = React.useRef(null)

      /**
       * Latest values, for the callbacks that must stay identical across renders.
       *
       * `Cell` is memoized, which only pays off if its props are shallow-equal for cells that did
       * not change — and an inline arrow function is never equal to the last one. The handlers
       * therefore have empty dependency lists and read what they need from here.
       */
      const stateRef = React.useRef(null)
      const sendRef = React.useRef(null)
      /**
       * The notebook on screen, for the effects that must not run before the view arrives.
       *
       * `null` means "no view yet" — that distinction drives the draft effects, which must not
       * write an empty record over what a reload left behind. Once a view exists the name is
       * always a string, so drafts have a stable key even if an older host forgot to send one.
       */
      const notebook = view === null ? null : (typeof view.notebook === 'string' ? view.notebook : 'main')
      const notebookRef = React.useRef(null)
      notebookRef.current = notebook
      stateRef.current = { editing, drafts, notebook, cells: view?.cells ?? [], t }

      /**
       * Adopt a view returned by the host and remember its revision.
       *
       * A full view is a snapshot taken when the request was handled, and it travels over a
       * different connection than the stream. It can therefore land *after* a newer streamed
       * event and, without this guard, replace the panel with an older notebook. Ignoring a view
       * older than the highest revision already seen keeps the stream authoritative; the next
       * poll fetches whatever was actually missed.
       *
       * A *different* notebook is the exception: its revision counts from its own start and has
       * nothing to compare against. The switch drops the tracker and replaces the cells outright,
       * because no cell of the new page can be the same object as one of the old page.
       */
      const adopt = React.useCallback((next) => {
        const switching = typeof next?.notebook === 'string' && next.notebook !== notebookRef.current
        if (switching) {
          panelRevisions.delete(sessionId)
          setEditing(null)
        }
        const known = panelRevisions.get(sessionId)
        if (!switching && typeof next?.revision === 'number' && typeof known === 'number' && next.revision < known) return
        if (typeof next?.revision === 'number') panelRevisions.set(sessionId, next.revision)
        setView((current) => (switching ? next : mergeView(current, next)))
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

      /**
       * Unsaved edits survive a reload — and a switch to another notebook.
       *
       * A draft is deliberately *not* a command — the host never sees typing — so nothing else can
       * restore it, and an F5 in the middle of a paragraph used to lose the paragraph. Drafts are
       * kept per notebook, so leaving a half-written cell to look at another page and coming back
       * finds it where it was. The editor is only reopened for the notebook it belonged to.
       */
      React.useEffect(() => {
        if (notebook === null) return
        const saved = readDrafts(sessionId)
        if (saved === null) return
        if (Object.keys(saved.drafts).length > 0) setDrafts(saved.drafts)
        if (saved.notebook === notebook && saved.editing !== null) setEditing(saved.editing)
      }, [sessionId, notebook])

      // Written only once the notebook is on screen: before that the state is still empty, and
      // storing "no drafts" then would erase what the restore above just read.
      React.useEffect(() => {
        if (notebook === null) return
        // Per notebook, so emptiness has to be counted across all of them: a page whose drafts
        // were all saved leaves an empty object behind, which is not a reason to keep the record.
        const hasText = Object.values(drafts).some((page) => page !== null && typeof page === 'object' && Object.keys(page).length > 0)
        writeDrafts(sessionId, editing === null && !hasText ? null : { notebook, editing, drafts })
      }, [sessionId, notebook, editing, drafts])

      /**
       * Drop drafts that have become meaningless.
       *
       * Two ways: the cell was deleted (its id is gone, and a recycled id does not exist), or the
       * host now holds exactly this text — which is what a save looks like from here. Only the
       * notebook on screen is examined: drafts of the other pages have no cells here to compare
       * against, and dropping them on a switch is the one thing this must not do.
       */
      React.useEffect(() => {
        if (notebook === null) return
        setDrafts((current) => {
          const mine = current[notebook]
          if (mine === null || typeof mine !== 'object') return current
          let changed = false
          const next = {}
          for (const [id, value] of Object.entries(mine)) {
            const cell = (view?.cells ?? []).find((candidate) => candidate.id === id)
            if (cell === undefined || cell.source === value) {
              changed = true
              continue
            }
            next[id] = value
          }
          if (!changed) return current
          const copy = { ...current }
          if (Object.keys(next).length === 0) delete copy[notebook]
          else copy[notebook] = next
          return copy
        })
      }, [view?.revision, notebook])

      // If the agent ran something in the shared kernel, this picks it up. `since` keeps the steady
      // state down to a two-field answer, and a failed poll never replaces a working panel with an
      // error banner — the next successful poll, or a click, will repair it.
      const poll = React.useCallback(async () => {
        try {
          const next = await callHost(sessionId, undefined, panelRevisions.get(sessionId))
          if (next?.unchanged !== true) {
            adopt(next)
            return
          }
          // The short answer carries the two things that change without a revision: the note
          // count (the agent took them) and the run-all flag (a sequence ended between cells).
          setView((current) => {
            if (current === null) return current
            const notes = typeof next.pendingNotes === 'number' && current.pendingNotes !== next.pendingNotes
            const sequence = typeof next.runningAll === 'boolean' && current.runningAll !== next.runningAll
            if (!notes && !sequence) return current
            return {
              ...current,
              ...(notes ? { pendingNotes: next.pendingNotes, notes: next.notes ?? [] } : {}),
              ...(sequence ? { runningAll: next.runningAll } : {}),
            }
          })
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
          // A switch — by another window, or by the panel in this one — is a different document,
          // not an edit to the list on screen. Patched events cannot express that, so this reads
          // the view again. An older host never sends this event, so nothing depends on it.
          if (event?.type === 'notebook') {
            load()
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
          const next = await callHost(sessionId, command)
          adopt(next)
          // A command's own answer is the only place a one-off message fits: a kernel verb's
          // result, or the list of things an import could not keep.
          setNotice(typeof next?.message === 'string' && next.message.length > 0 ? next.message : null)
        } catch (cause) {
          setError(cause.message)
        } finally {
          if (!silent) setBusy(null)
        }
      }, [sessionId, adopt])
      sendRef.current = send

      const onEdit = React.useCallback((id, source) => {
        setEditing(id)
        const page = stateRef.current.notebook
        setDrafts((current) => ({ ...current, [page]: { ...draftsFor(current, page), [id]: source } }))
      }, [])

      const onDraft = React.useCallback((value) => {
        const { editing: id, notebook: page } = stateRef.current
        setDrafts((current) => ({ ...current, [page]: { ...draftsFor(current, page), [id]: value } }))
      }, [])

      /** A draft is no longer a draft once the host has it. */
      const forgetDraft = React.useCallback((id) => {
        setDrafts((current) => {
          const page = stateRef.current.notebook
          const mine = current[page]
          if (mine === null || typeof mine !== 'object' || !(id in mine)) return current
          const next = { ...mine }
          delete next[id]
          const copy = { ...current }
          if (Object.keys(next).length === 0) delete copy[page]
          else copy[page] = next
          return copy
        })
      }, [])

      /**
       * Save the editor's text.
       *
       * `keepEditing` is what `Ctrl/Cmd+S` asks for: saving is not leaving, and closing the cell
       * under the user's caret because they saved mid-paragraph is the sort of thing that makes a
       * keyboard shortcut worse than no shortcut.
       */
      const onCommit = React.useCallback((id, source, options) => {
        const keep = options?.keepEditing === true
        if (!keep) setEditing(null)
        const cell = stateRef.current.cells.find((candidate) => candidate.id === id)
        if (cell !== undefined && cell.source === source) {
          forgetDraft(id)
          return
        }
        sendRef.current({ action: 'updateCell', id, source }, 'updateCell')
        // While the editor stays open the draft must stay too: dropping it here would fall back to
        // the cell's old source for the round trip, and the text would visibly snap backwards.
        // The view effect drops it once the host holds the same text.
        if (!keep) forgetDraft(id)
      }, [forgetDraft])

      const onCancel = React.useCallback(() => setEditing(null), [])

      // `Shift+Enter` carries the source with the run: one request instead of two, and the cell
      // starts executing immediately rather than after a full round trip spent saving it. The host
      // answers as soon as the kernel has the code; everything after that arrives on the stream.
      // A markdown cell skips the "running" state: rendering prose is not an execution.
      //
      // `keepEditing` is `Ctrl/Cmd+Enter`: run the cell in place and leave the editor open, which
      // is how a cell is iterated on — change a number, run, read the output, change it again.
      const onRun = React.useCallback(async (id, source, options) => {
        const keep = options?.keepEditing === true
        if (!keep) setEditing(null)
        const cell = stateRef.current.cells.find((candidate) => candidate.id === id)
        const markdown = cell?.kind === 'markdown'
        if (!markdown) {
          setRunningId(id)
          setView((current) => markRunning(current, id))
        }
        // See onCommit: a draft dropped while the editor is open flashes the previous source.
        if (!keep) forgetDraft(id)
        try {
          await sendRef.current({ action: 'runCell', id, source }, 'runCell', { silent: true })
        } finally {
          if (!markdown) setRunningId(null)
        }
      }, [forgetDraft])

      /**
       * Insert a cell directly below another one.
       *
       * `afterId` is what makes this "below this cell" rather than "at the end": a notebook is
       * read top to bottom, and the place a thought belongs is usually right under the cell that
       * prompted it.
       */
      const onInsert = React.useCallback((id) => {
        sendRef.current({ action: 'addCell', afterId: id }, 'addCell')
      }, [])

      /**
       * Import a `.ipynb` the user picked.
       *
       * Parsed here before it is sent: a file that is not JSON would otherwise come back as a
       * server-side error, and the useful message ("that is not a notebook") is available for free
       * in the browser.
       */
      const onFile = async (event) => {
        const input = event?.target
        const file = input?.files?.[0]
        // Clearing it makes choosing the same file twice fire again, which is what a retry is.
        if (input !== null && input !== undefined) input.value = ''
        if (file === undefined || file === null) return
        let document
        try {
          document = JSON.parse(await file.text())
        } catch {
          setNotice(stateRef.current.t('importBad'))
          return
        }
        await sendRef.current({ action: 'importNotebook', document }, 'importNotebook')
      }

      const onDelete = React.useCallback((id) => { sendRef.current({ action: 'deleteCell', id }, 'deleteCell') }, [])
      const onMove = React.useCallback((id, delta) => { sendRef.current({ action: 'moveCell', id, delta }, 'moveCell') }, [])
      const onClear = React.useCallback((id) => { sendRef.current({ action: 'clearOutput', id }, 'clearOutput') }, [])
      const onKind = React.useCallback((id, kind) => { sendRef.current({ action: 'updateCell', id, kind }, 'updateCell') }, [])

      /**
       * The model's rewrite of a cell is shown as a diff before it becomes the cell.
       *
       * The panel cannot tell the user's intent, but it can make the change visible: a chip says
       * the cell was rewritten, one click shows the line diff, and the two endings are "keep it"
       * (drop the marker) or "put mine back" (one command, because undo is not a second edit).
       */
      const onToggleDiff = React.useCallback((id) => {
        setDiffId((current) => (current === id ? null : id))
      }, [])
      const onAcceptDiff = React.useCallback((id) => {
        setDiffId((current) => (current === id ? null : current))
        sendRef.current({ action: 'dismissDiff', id }, 'dismissDiff')
      }, [])
      const onRevertDiff = React.useCallback((id) => {
        setDiffId((current) => (current === id ? null : current))
        sendRef.current({ action: 'revertCell', id }, 'revertCell')
      }, [])

      if (view === null && error === null) return h('div', { className: 'dshj-note', role: 'status' }, t('loading'))
      if (view === null) {
        return h('div', { className: 'dshj-root', role: 'region', 'aria-label': t('title') },
          h('div', { className: 'dshj-err', role: 'alert' }, error),
          h('div', { className: 'dshj-note' }, h('button', { type: 'button', className: 'dshj-btn', onClick: load }, t('retry'))))
      }

      const cells = view.cells ?? []
      const kernel = view.kernel
      const language = languageFor(kernel)
      const busyCell = busy !== null || runningId !== null
      const kernelText = kernel === undefined || kernel === null
        ? t('noKernel')
        : `${t('kernel')} ${kernel.name} · ${kernel.state} · ${String(kernel.id).slice(0, 8)}`

      return h('div', { className: 'dshj-root', role: 'region', 'aria-label': t('title') },
        h('div', { className: 'dshj-bar' },
          // Which page this is. A session can hold several notebooks, and the picker is the only
          // place they are named: the agent always works on the one shown here.
          h('select', {
            className: 'dshj-picker',
            value: notebook ?? 'main',
            title: t('notebookPicker'),
            'aria-label': t('notebookPicker'),
            onChange: (event) => send({ action: 'switchNotebook', notebook: event.target.value }, 'switchNotebook'),
          }, (view.notebooks ?? [notebook ?? 'main']).map((name) => h('option', { key: name, value: name }, name))),
          h('button', {
            type: 'button',
            className: 'dshj-btn dshj-new',
            title: t('newNotebookHint'),
            'aria-label': t('newNotebookHint'),
            disabled: busy !== null,
            onClick: () => send({ action: 'newNotebook' }, 'newNotebook'),
          }, t('newNotebook')),
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
          // Run all replaces itself with a stop while a sequence is going: two buttons that both
          // mean "run everything" would leave the user guessing which one is armed.
          view.runningAll === true
            ? h('button', {
              type: 'button',
              className: 'dshj-btn',
              title: t('stopRunAllHint'),
              onClick: () => send({ action: 'interrupt' }, 'interrupt'),
            }, t('stopRunAll'))
            : h('button', {
              type: 'button',
              className: 'dshj-btn',
              title: t('runAllHint'),
              disabled: busy !== null || cells.every((cell) => cell.kind !== 'code'),
              onClick: () => send({ action: 'runAll' }, 'runAll'),
            }, t('runAll')),
          // A link, not a button: the browser's own save dialog and the server's file name.
          h('a', {
            className: 'dshj-btn',
            href: `${DOWNLOAD_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`,
            download: '',
            title: t('exportHint'),
          }, t('exportIpynb')),
          h('button', {
            type: 'button',
            className: 'dshj-btn',
            title: t('importHint'),
            disabled: busy !== null,
            onClick: () => fileInput.current?.click(),
          }, t('importIpynb')),
          h('input', {
            type: 'file',
            accept: '.ipynb,application/x-ipynb+json,application/json',
            ref: fileInput,
            style: { display: 'none' },
            onChange: onFile,
          }),
          h('button', { type: 'button', className: 'dshj-btn', disabled: kernel === undefined || kernel === null, onClick: () => send({ action: 'interrupt' }, 'interrupt') }, t('interrupt')),
          h('button', { type: 'button', className: 'dshj-btn', disabled: busy !== null, onClick: () => send({ action: 'restartKernel' }, 'restartKernel') }, t('restart')),
          h('button', { type: 'button', className: 'dshj-btn', disabled: busy !== null, onClick: () => send({ action: 'clearAllOutputs' }, 'clearAllOutputs') }, t('clearOutputs'))),
        notesOpen && (view.pendingNotes ?? 0) > 0
          ? h('div', { className: 'dshj-notes', role: 'region', 'aria-label': t('notesTitle') },
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
        error !== null ? h('div', { className: 'dshj-err', role: 'alert' }, error) : null,
        notice !== null
          ? h('div', { className: 'dshj-notice', role: 'status' },
            h('span', null, notice),
            h('button', { type: 'button', className: 'dshj-btn', onClick: () => setNotice(null) }, t('dismiss')))
          : null,
        h('div', { className: 'dshj-cells', role: 'list' },
          cells.length === 0 ? h('div', { className: 'dshj-note' }, t('empty')) : null,
          cells.map((cell, index) => h(Cell, {
            key: cell.id,
            cell,
            index,
            count: cells.length,
            t,
            language,
            busy: runningId === cell.id,
            editing,
            draft: draftsFor(drafts, notebook)[cell.id] ?? cell.source,
            onEdit,
            onDraft,
            onCommit,
            onCancel,
            onRun,
            onInsert,
            onDelete,
            onMove,
            onClear,
            onKind,
            diffOpen: diffId === cell.id,
            onToggleDiff,
            onAcceptDiff,
            onRevertDiff,
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
