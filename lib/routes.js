/**
 * HTTP routes backing the right-side notebook panel.
 *
 * Routes registered through `ctx.connection.fetch` sit inside the harness's own Host/Origin fence
 * and browser-session authentication, so the panel talks to them with a plain same-origin `fetch`
 * and no token handling of its own.
 *
 * Three routes, because the panel does three different things:
 *
 * - `/api/jupyterlab/notebook` — one exact path with two methods: `GET` for the current view,
 *   `POST` for a command. One command endpoint keeps the client's error handling in one place.
 * - `/api/jupyterlab/notebook/stream` — Server-Sent Events, the output of a running cell as it is
 *   produced. `POST runCell` answers in milliseconds now, so this is what makes a long cell
 *   watchable instead of a blank box with a spinner.
 * - `/api/jupyterlab/asset` — the pictures a cell produced, content-addressed and immutable.
 *   Serving them from here is what keeps a notebook document down to kilobytes.
 *
 * Routes are matched by **exact pathname** (`connection.fetch` is an exact registry), which is why
 * the asset name travels in a query parameter rather than in a path segment.
 *
 * **Registration is deferred, and that matters.** The `connection` entry itself waits on
 * `inject: [webRuntime]`, so on a cold boot the service is frequently *not yet provided* when a
 * plugin mounting later runs `apply`. Reading `ctx.get('connection')` once and giving up silently
 * has exactly one symptom: the panel loads, and every call it makes returns 404 because the route
 * was never registered. `ctx.inject` is therefore not optional here — it registers the routes when
 * the service arrives and tears them down when the service leaves.
 *
 * @module dsh-jupyterlab/routes
 */

/** The one exact path the panel uses for reads and commands. */
export const NOTEBOOK_ROUTE = '/api/jupyterlab/notebook'

/** Server-Sent Events carrying a running cell's output. */
export const STREAM_ROUTE = '/api/jupyterlab/notebook/stream'

/** Content-addressed images referenced by cell outputs. */
export const ASSET_ROUTE = '/api/jupyterlab/asset'

/**
 * How long output deltas are coalesced before they are written to the stream.
 *
 * A print loop can produce hundreds of iopub messages per second, and one SSE frame per message
 * would cost more than the rendering it feeds. 60 ms is below the threshold where a human sees the
 * delay and above the point where the framing dominates.
 */
const STREAM_FLUSH_MS = 60

/** Comment frames keep proxies and the browser from treating an idle stream as dead. */
const STREAM_HEARTBEAT_MS = 25_000

/**
 * Read a session id from a request, rejecting anything unusable.
 *
 * @param value - Candidate session id.
 * @returns The trimmed id.
 * @throws {Error} When it is missing or not a string.
 */
function requireSessionId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('a sessionId is required')
  }
  return value.trim()
}

/** JSON response that browsers and proxies must not cache. */
function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Build the SSE response for one session.
 *
 * The stream owns its subscription: when the browser goes away (a reload, a closed tab, a dropped
 * network) the request's abort signal releases the listener and the heartbeat, so a panel that is
 * opened and closed a hundred times leaves nothing behind.
 *
 * @param sessionId - Session whose notebook to watch.
 * @param notebooks - The notebook model.
 * @param request - The incoming request, for its abort signal.
 * @returns A streaming `text/event-stream` response.
 */
function openEventStream(sessionId, notebooks, request) {
  const encoder = new TextEncoder()
  /** @type {ReadableStreamDefaultController<Uint8Array>|undefined} */
  let controller
  let closed = false
  let flushTimer
  let heartbeatTimer
  /**
   * Frames waiting for the next flush. JSON is serialized here rather than buffered as events so
   * a burst costs one `enqueue` and one chunk on the wire.
   */
  const queue = []
  let unsubscribe = () => {}
  const onAbort = () => cleanup()

  /** Stop producing: release the subscription and end the body exactly once. */
  function cleanup() {
    if (closed) return
    closed = true
    clearTimeout(flushTimer)
    clearInterval(heartbeatTimer)
    unsubscribe()
    request?.signal?.removeEventListener?.('abort', onAbort)
    try {
      controller?.close()
    } catch {
      // Already closed by the runtime.
    }
  }

  /** Write everything queued as one chunk. */
  function flush() {
    flushTimer = undefined
    if (closed || queue.length === 0) return
    const chunk = queue.join('')
    queue.length = 0
    try {
      controller.enqueue(encoder.encode(chunk))
    } catch {
      cleanup()
    }
  }

  /** Queue one frame, immediately when it is a boundary the user is waiting for. */
  function schedule(immediate) {
    if (closed) return
    if (immediate) {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      flush()
      return
    }
    if (flushTimer === undefined) flushTimer = setTimeout(flush, STREAM_FLUSH_MS)
  }

  const body = new ReadableStream({
    start(streamController) {
      controller = streamController
      // An immediate frame gets the connection out of "connecting" without waiting for output.
      streamController.enqueue(encoder.encode(': connected\n\n'))
      unsubscribe = notebooks.subscribe(sessionId, (event) => {
        queue.push(`data: ${JSON.stringify(event)}\n\n`)
        // A cell event is a start or an end: rare, and exactly the moment the panel's status row
        // must not lag behind.
        schedule(event.type === 'cell')
      })
      heartbeatTimer = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          cleanup()
        }
      }, STREAM_HEARTBEAT_MS)
      // A pending heartbeat must never hold the host process open.
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
      request?.signal?.addEventListener?.('abort', onAbort, { once: true })
      if (request?.signal?.aborted === true) cleanup()
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // nginx-style proxies buffer by default, which would defeat the whole point.
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * Register the panel's routes once the Connection service is available.
 *
 * The routes are optional: without a Connection service (a headless profile) the tools keep working
 * and only the panel is unavailable. The outcome is reported through `onState` rather than thrown,
 * so a headless profile stays quiet while a broken panel stays diagnosable.
 *
 * @param ctx - Plugin context.
 * @param options - Wiring.
 * @param options.notebooks - The notebook model.
 * @param options.assets - The image store backing cell pictures, when one is configured.
 * @param options.connectionInfo - `() => { configured, url }` for the panel's status row.
 * @param options.onState - `(state: 'pending'|'registered'|'unavailable') => void` observer.
 */
export function registerNotebookRoutes(ctx, { notebooks, assets, connectionInfo, onState }) {
  const report = (state) => { onState?.(state) }
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => {
      const connection = connectionCtx.connection
      if (connection === undefined || connection === null || typeof connection.fetch?.register !== 'function') {
        report('unavailable')
        return () => report('pending')
      }

      const register = (definition) => connection.fetch.register(definition)

      const notebookRoute = register({
        path: NOTEBOOK_ROUTE,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        async fetch(request) {
          const url = new URL(request.url)
          const info = connectionInfo?.() ?? {}
          try {
            if (request.method === 'GET') {
              const sessionId = requireSessionId(url.searchParams.get('sessionId'))
              // A poll: the panel already has this revision, so answering with the whole notebook —
              // cells, outputs and images — would be pure waste.
              const since = url.searchParams.get('since')
              if (since !== null) {
                const revision = Number(since)
                if (Number.isFinite(revision) && notebooks.revision(sessionId) === revision) {
                  // `pendingNotes` rides along because the badge has to fall back to zero once the
                  // agent has taken the notes, and that happens without a revision bump.
                  return json({
                    sessionId,
                    revision,
                    unchanged: true,
                    pendingNotes: notebooks.pendingNotes(sessionId),
                    ...info,
                  })
                }
              }
              return json(await notebooks.view(sessionId, info))
            }
            let body
            try {
              body = await request.json()
            } catch {
              return json({ error: 'request body is not JSON' }, 400)
            }
            const sessionId = requireSessionId(body?.sessionId)
            // No `signal` on purpose: a command must not be cancelled by the browser navigating
            // away, and `runCell` no longer waits for the execution it starts.
            const view = await notebooks.command(sessionId, body, { ...info })
            return json(view)
          } catch (error) {
            // A command that cannot be applied is a client-visible failure, not a server fault.
            return json({ ...info, error: error instanceof Error ? error.message : String(error) }, 200)
          }
        },
      })

      const streamRoute = register({
        path: STREAM_ROUTE,
        methods: ['GET'],
        fetch(request) {
          try {
            const sessionId = requireSessionId(new URL(request.url).searchParams.get('sessionId'))
            return openEventStream(sessionId, notebooks, request)
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 200)
          }
        },
      })

      const assetRoute = register({
        path: ASSET_ROUTE,
        methods: ['GET'],
        fetch(request) {
          const name = new URL(request.url).searchParams.get('name')
          const asset = name === null ? undefined : assets?.get(name)
          if (asset === undefined) {
            return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } })
          }
          return new Response(asset.data, {
            status: 200,
            headers: {
              'content-type': asset.mime,
              'content-length': String(asset.data.length),
              // The name is the hash of the bytes, so this response can never go stale.
              'cache-control': 'public, max-age=31536000, immutable',
            },
          })
        },
      })

      report('registered')
      return () => {
        report('pending')
        assetRoute()
        streamRoute()
        notebookRoute()
      }
    }, 'jupyterlab: notebook route')
  })
}
