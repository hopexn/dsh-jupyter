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
    }

    /** Panel styles: theme tokens only, so light and dark both come out right. */
    const CSS = `
.dshj-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); font-size:13px; }
.dshj-bar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:8px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); position:sticky; top:0; background:var(--dsw-specific-sidebar-fill); z-index:2; }
.dshj-kernel { color:var(--dsw-alias-label-secondary); font-size:12px; margin-right:auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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

    /** One output entry. */
    function Output(props) {
      const output = props.output
      // A stored image carries a URL (the host serves it with an immutable cache header); the
      // fallback is an inline data URL, which only appears when no store is configured.
      if (output.type === 'image') return h('img', { className: 'dshj-img', src: output.url ?? output.dataUrl, alt: 'cell output', loading: 'lazy' })
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
      const { cell, index, count, t, busy, editing, draft, onEdit, onDraft, onCommit, onCancel, onRun, onDelete, onMove, onClear } = props
      const isEditing = editing === cell.id
      const textarea = React.useRef(null)

      React.useEffect(() => {
        if (isEditing && textarea.current !== null) {
          textarea.current.focus()
          // Put the caret at the end rather than selecting everything.
          const value = textarea.current.value
          textarea.current.setSelectionRange(value.length, value.length)
        }
      }, [isEditing])

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
        h('span', { className: 'dshj-count' }, cell.executionCount === null || cell.executionCount === undefined ? (busy ? '…' : '') : `[${cell.executionCount}]`),
        cell.status === 'running' || busy ? h('span', { className: 'dshj-running' }, t('running')) : null,
        h('span', { className: 'dshj-head-spacer' }),
        isEditing
          ? h('button', { type: 'button', className: 'dshj-btn dshj-btn-primary', onClick: () => onCommit(cell.id, draft) }, t('done'))
          : h('button', { type: 'button', className: 'dshj-btn dshj-btn-primary', title: t('runHint'), onClick: () => onRun(cell.id, cell.source) }, t('run')),
        h('button', { type: 'button', className: 'dshj-btn', title: t('up'), disabled: index === 0, onClick: () => onMove(cell.id, -1) }, '↑'),
        h('button', { type: 'button', className: 'dshj-btn', title: t('down'), disabled: index === count - 1, onClick: () => onMove(cell.id, 1) }, '↓'),
        h('button', { type: 'button', className: 'dshj-btn', title: t('clearOutputs'), onClick: () => onClear(cell.id) }, '⌫'),
        h('button', { type: 'button', className: 'dshj-btn', title: t('remove'), onClick: () => onDelete(cell.id) }, '✕'))

      const body = isEditing
        ? h('textarea', {
          ref: textarea,
          className: 'dshj-editor',
          value: draft,
          spellCheck: false,
          placeholder: t('placeholder'),
          onChange: (event) => onDraft(event.target.value),
          onKeyDown,
        })
        : h('pre', {
          className: 'dshj-source',
          'data-empty': cell.source.trim().length === 0,
          title: t('editHint'),
          onDoubleClick: () => onEdit(cell.id, cell.source),
        }, cell.source.trim().length === 0 ? t('placeholder') : cell.source)

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

      /** Adopt a view returned by the host and remember its revision. */
      const adopt = React.useCallback((next) => {
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
          if (next?.unchanged !== true) adopt(next)
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
      const onRun = React.useCallback(async (id, source) => {
        setEditing(null)
        setRunningId(id)
        setView((current) => markRunning(current, id))
        try {
          await sendRef.current({ action: 'runCell', id, source }, 'runCell', { silent: true })
        } finally {
          setRunningId(null)
        }
      }, [])

      const onDelete = React.useCallback((id) => { sendRef.current({ action: 'deleteCell', id }, 'deleteCell') }, [])
      const onMove = React.useCallback((id, delta) => { sendRef.current({ action: 'moveCell', id, delta }, 'moveCell') }, [])
      const onClear = React.useCallback((id) => { sendRef.current({ action: 'clearOutput', id }, 'clearOutput') }, [])

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
          h('button', { type: 'button', className: 'dshj-btn', disabled: busy !== null, onClick: () => send({ action: 'addCell' }, 'addCell') }, t('addCell')),
          h('button', { type: 'button', className: 'dshj-btn', disabled: kernel === undefined || kernel === null, onClick: () => send({ action: 'interrupt' }, 'interrupt') }, t('interrupt')),
          h('button', { type: 'button', className: 'dshj-btn', disabled: busy !== null, onClick: () => send({ action: 'restartKernel' }, 'restartKernel') }, t('restart')),
          h('button', { type: 'button', className: 'dshj-btn', disabled: busy !== null, onClick: () => send({ action: 'clearAllOutputs' }, 'clearAllOutputs') }, t('clearOutputs'))),
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
