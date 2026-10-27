/**
 * A process-local DNS cache, shaped as a `lookup` function for `node:http` / `node:https`.
 *
 * ## Why this exists
 *
 * A Jupyter server reached by a mDNS name — `http://jupyterbox.local:9002/lab` is the archetype —
 * costs **about five seconds per `getaddrinfo` call** on macOS. `mDNSResponder` first multicasts
 * for the name (twice, with its own timeouts) and only then falls back to `/etc/hosts`, so the
 * *lookup* is slow even though the *connection* and the *response* are both a millisecond away.
 *
 * Measured on the machine this was written for:
 *
 * ```
 * tcp connect to jupyterbox.local:9002   5020 ms   (per attempt, every attempt)
 * dns lookup                            5006 ms
 * fetch the same server by 10.0.0.10     12 ms
 * ```
 *
 * Node's `fetch` and `WebSocket` call `dns.lookup` themselves and offer no way in, so the fix has
 * to live in the transport: own the lookup, cache the answer, and reuse the socket. Every request
 * after the first then costs one round trip instead of one round trip plus five seconds.
 *
 * The cache is deliberately small and boring: one address per host, a five-minute TTL, and
 * in-flight de-duplication so ten concurrent requests ask the resolver once.
 *
 * @module dsh-jupyterlab/dns-cache
 */

import dns from 'node:dns'
import net from 'node:net'

/** How long a resolved address is reused before asking the resolver again. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000

/** `host` → `{ address, family, expiresAt }`. */
const cache = new Map()

/** `host` → pending promise, so concurrent callers share one resolver round trip. */
const inFlight = new Map()

/**
 * Whether a host is already an IP literal, and so needs no resolution at all.
 *
 * @param host - Hostname or address.
 * @returns The address family, or 0 when the host must be resolved.
 */
export function ipFamily(host) {
  return net.isIP(String(host ?? ''))
}

/** Drop every cached address. Used by tests, and after a connection-level failure. */
export function clearDnsCache() {
  cache.clear()
  inFlight.clear()
}

/**
 * Resolve one host to a single address, preferring IPv4 and honoring a requested family.
 *
 * @param host - Hostname to resolve. IP literals are returned unchanged.
 * @param options - Resolution controls.
 * @param options.family - Preferred address family: 4, 6, or 0 for either.
 * @param options.ttlMs - Cache lifetime for a successful resolution.
 * @returns The chosen address and its family.
 * @throws {Error} When the resolver finds nothing.
 */
export async function resolveHost(host, { family = 0, ttlMs = DEFAULT_TTL_MS } = {}) {
  const literalFamily = ipFamily(host)
  if (literalFamily !== 0) return { address: String(host), family: literalFamily }

  const key = `${host}\u0000${family}`
  const cached = cache.get(key)
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return { address: cached.address, family: cached.family }
  }

  let pending = inFlight.get(key)
  if (pending === undefined) {
    pending = (async () => {
      // `all` + `verbatim: true` keeps Node from reordering or silently dropping families, so the
      // preference below is this module's decision rather than the resolver's.
      const addresses = await dns.promises.lookup(host, { all: true, verbatim: true })
      if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new Error(`no address found for ${host}`)
      }
      const wanted = family === 0 ? undefined : addresses.find((entry) => entry.family === family)
      const ipv4 = addresses.find((entry) => entry.family === 4)
      return wanted ?? ipv4 ?? addresses[0]
    })().finally(() => { inFlight.delete(key) })
    inFlight.set(key, pending)
  }

  const chosen = await pending
  cache.set(key, { address: chosen.address, family: chosen.family, expiresAt: Date.now() + ttlMs })
  return { address: chosen.address, family: chosen.family }
}

/**
 * Build a Node-compatible `lookup` function backed by the cache.
 *
 * `node:http` and `node:https` call `lookup(hostname, options, callback)`; `options.all` asks for
 * every address, and `options.family` restricts the family. Both shapes are supported because the
 * two call sites use different ones.
 *
 * @param options - Cache controls.
 * @param options.ttlMs - Cache lifetime for a successful resolution.
 * @returns A `lookup` function suitable for `http.request({ lookup })`.
 */
export function createLookup({ ttlMs = DEFAULT_TTL_MS } = {}) {
  return function lookup(hostname, options, callback) {
    const wantAll = typeof options === 'object' && options !== null && options.all === true
    const family = typeof options === 'object' && options !== null ? Number(options.family) || 0 : 0
    resolveHost(hostname, { family, ttlMs })
      .then((resolved) => {
        if (wantAll) callback(null, [{ address: resolved.address, family: resolved.family }])
        else callback(null, resolved.address, resolved.family)
      })
      .catch((error) => callback(error))
  }
}

/** A snapshot of the cache, for diagnostics and tests. */
export function dnsCacheEntries() {
  return [...cache].map(([key, value]) => ({
    host: key.split('\u0000')[0],
    family: value.family,
    address: value.address,
    fresh: value.expiresAt > Date.now(),
  }))
}
