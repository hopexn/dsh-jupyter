/**
 * HTTP routes backing the right-side notebook panel.
 *
 * Routes registered through `ctx.connection.fetch` sit inside the harness's own Host/Origin fence
 * and browser-session authentication, so the panel talks to them with a plain same-origin `fetch`
 * and no token handling of its own.
 *
 * The whole panel is one exact route with two methods — `GET` for the current view, `POST` for a
 * command — because exact Fetch paths are registered once per path and a single command endpoint
 * keeps the client's error handling in one place.
 *
 * **Registration is deferred, and that matters.** The `connection` entry itself waits on
 * `inject: [webRuntime]`, so on a cold boot the service is frequently *not yet provided* when a
 * plugin mounting later runs `apply`. Reading `ctx.get('connection')` once and giving up silently
 * has exactly one symptom: the panel loads, and every call it makes returns 404 because the route
 * was never registered. `ctx.inject` is therefore not optional here — it registers the route when
 * the service arrives and tears it down when the service leaves.
 *
 * @module dsh-jupyterlab/routes
 */

/** The one exact path the panel uses. */
export const NOTEBOOK_ROUTE = '/api/jupyterlab/notebook'

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
 * Register the panel's route once the Connection service is available.
 *
 * The route is optional: without a Connection service (a headless profile) the tools keep working
 * and only the panel is unavailable. The outcome is reported through `onState` rather than thrown,
 * so a headless profile stays quiet while a broken panel stays diagnosable.
 *
 * @param ctx - Plugin context.
 * @param options - Wiring.
 * @param options.notebooks - The notebook model.
 * @param options.connectionInfo - `() => { configured, url }` for the panel's status row.
 * @param options.onState - `(state: 'pending'|'registered'|'unavailable') => void` observer.
 */
export function registerNotebookRoutes(ctx, { notebooks, connectionInfo, onState }) {
  const report = (state) => { onState?.(state) }
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => {
      const connection = connectionCtx.connection
      if (connection === undefined || connection === null || typeof connection.fetch?.register !== 'function') {
        report('unavailable')
        return () => report('pending')
      }
      const dispose = connection.fetch.register({
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
              // cells, outputs and base64 images — would be pure waste.
              const since = url.searchParams.get('since')
              if (since !== null) {
                const revision = Number(since)
                if (Number.isFinite(revision) && notebooks.revision(sessionId) === revision) {
                  return json({ sessionId, revision, unchanged: true, ...info })
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
            const view = await notebooks.command(sessionId, body, { ...info, signal: request.signal })
            return json(view)
          } catch (error) {
            // A command that cannot be applied is a client-visible failure, not a server fault.
            return json({ ...info, error: error instanceof Error ? error.message : String(error) }, 200)
          }
        },
      })
      report('registered')
      return () => {
        report('pending')
        dispose()
      }
    }, 'jupyterlab: notebook route')
  })
}
