/**
 * Content-addressed store for the pictures a cell produces.
 *
 * Notebook outputs used to carry their images inline as base64 data URLs, which meant every
 * `view()` — every panel click, every poll that found a change — shipped megabytes of base64
 * through a JSON document that also had to be parsed by the browser. Worse, the notebook mirror
 * wrote all of it to disk on every edit.
 *
 * Here an image is written once, under the hash of its own bytes, and the cell keeps only
 * `api/jupyterlab/asset?name=<hash>.png`. The route serves it with `immutable`, so the browser
 * caches it forever: a rerun that redraws the same figure re-uses the same URL and costs nothing,
 * and a notebook with ten plots costs ten small files instead of a multi-megabyte document.
 *
 * Content addressing is also what makes `immutable` honest: the name cannot describe different
 * bytes later.
 *
 * @module dsh-jupyterlab/assets
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Extensions the store accepts, and the MIME type each one denotes. */
const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

/** Extension for each accepted MIME type. */
const EXTENSION_BY_MIME = Object.fromEntries(
  Object.entries(MIME_BY_EXTENSION).map(([extension, mime]) => [mime, extension]),
)

/** Names this store will serve: 20 hex characters of digest plus a known extension. */
const NAME_PATTERN = /^[0-9a-f]{20}\.(?:png|jpg|gif|webp|svg|pdf)$/

/** Hex digits kept from the SHA-256 digest. 80 bits: collision-free at any realistic scale. */
const DIGEST_LENGTH = 20

/** How much decoded image data is kept in memory for instant re-serving. */
const DEFAULT_MAX_CACHED_BYTES = 32 * 1024 * 1024

/** How much decoded image data the mirror directory may hold before the oldest is pruned. */
const DEFAULT_MAX_DISK_BYTES = 256 * 1024 * 1024

/**
 * How often the directory is measured.
 *
 * Pruning on every write would stat the whole directory on the click path, which is the cost this
 * store exists to avoid. Once per process was too rare: a long-lived app kept writing plots and
 * never looked at the total again, so the cap was only ever enforced on the next restart.
 */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000

/**
 * The public path an asset name is served from.
 *
 * Document-relative for the same reason the panel's own route is: the app may be served under a
 * path prefix, and a leading slash would escape it.
 *
 * @param name - The content-addressed file name.
 * @returns A URL usable directly as an `img` source.
 */
export function assetUrl(name) {
  return `api/jupyterlab/asset?name=${encodeURIComponent(name)}`
}

/**
 * Store images by content hash and serve them back.
 */
export class AssetStore {
  /** Decoded payloads, oldest first; re-reading moves an entry to the end. */
  #memory = new Map()
  /** Bytes currently held in {@link AssetStore#memory}. */
  #cachedBytes = 0
  #maxCachedBytes
  #maxDiskBytes
  #pruneIntervalMs
  /** When the directory was last measured; zero means it has never been. */
  #lastPruneAt = 0
  /** @type {string} */
  #directory

  /**
   * @param options - Storage controls.
   * @param options.directory - Directory for the on-disk copy; defaults under `$DSH_HOME`.
   * @param options.maxCachedBytes - Memory budget for decoded images.
   * @param options.maxDiskBytes - Directory budget; the oldest files are pruned above it.
   * @param options.pruneIntervalMs - Minimum time between directory scans; 0 scans every write.
   */
  constructor({ directory, maxCachedBytes = DEFAULT_MAX_CACHED_BYTES, maxDiskBytes = DEFAULT_MAX_DISK_BYTES, pruneIntervalMs = PRUNE_INTERVAL_MS } = {}) {
    this.#directory = directory ?? path.join(
      process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
      'jupyterlab',
      'assets',
    )
    this.#maxCachedBytes = maxCachedBytes
    this.#maxDiskBytes = maxDiskBytes
    this.#pruneIntervalMs = Math.max(0, pruneIntervalMs)
  }

  /**
   * Store one base64 payload and return the name it can be fetched under.
   *
   * @param mime - MIME type of the payload; anything unknown is refused.
   * @param base64 - Base64 payload, already stripped of whitespace.
   * @returns `{ name, url, mime, bytes }`, or undefined when the type is not storable.
   */
  put(mime, base64) {
    const extension = EXTENSION_BY_MIME[mime]
    if (extension === undefined || typeof base64 !== 'string') return undefined
    let data
    try {
      data = Buffer.from(base64, 'base64')
    } catch {
      return undefined
    }
    if (data.length === 0) return undefined
    const name = `${createHash('sha256').update(data).digest('hex').slice(0, DIGEST_LENGTH)}.${extension}`
    const alreadyStored = this.#memory.has(name)
    this.#remember(name, data)
    if (!alreadyStored) this.#write(name, data)
    return { name, url: assetUrl(name), mime, bytes: data.length }
  }

  /**
   * Look one asset up, from memory first and then from the mirror directory.
   *
   * @param name - Content-addressed file name from a cell output.
   * @returns `{ mime, data }`, or undefined when the name is unknown or malformed.
   */
  get(name) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return undefined
    const cached = this.#memory.get(name)
    if (cached !== undefined) {
      // Re-insert so the least recently used entry is the first one evicted.
      this.#memory.delete(name)
      this.#memory.set(name, cached)
      return { mime: mimeOf(name), data: cached }
    }
    try {
      const data = readFileSync(path.join(this.#directory, name))
      this.#remember(name, data)
      return { mime: mimeOf(name), data }
    } catch {
      return undefined
    }
  }

  /** Whether an asset is available without touching the disk. */
  has(name) {
    return this.#memory.has(name)
  }

  /** Number of distinct payloads held; used by tests. */
  get size() {
    return this.#memory.size
  }

  /** Directory holding the on-disk copies, for diagnostics. */
  get directory() {
    return this.#directory
  }

  /** Keep one decoded payload in memory, evicting the oldest entries over budget. */
  #remember(name, data) {
    const previous = this.#memory.get(name)
    if (previous !== undefined) {
      this.#memory.delete(name)
      this.#cachedBytes -= previous.length
    }
    this.#memory.set(name, data)
    this.#cachedBytes += data.length
    while (this.#cachedBytes > this.#maxCachedBytes && this.#memory.size > 1) {
      const oldest = this.#memory.keys().next()
      if (oldest.done === true) break
      const evicted = this.#memory.get(oldest.value)
      this.#memory.delete(oldest.value)
      this.#cachedBytes -= evicted.length
    }
  }

  /** Write the on-disk copy once; a concurrent writer of the same content is harmless. */
  #write(name, data) {
    try {
      // Create the directory first: pruning used to mark itself done before the very first write,
      // when the directory did not exist yet, so a fresh install never pruned at all.
      mkdirSync(this.#directory, { recursive: true })
      this.#prune()
      // `wx` keeps an existing file untouched: the content is the same by construction, and two
      // runs finishing at once must not both try to replace it.
      writeFileSync(path.join(this.#directory, name), data, { flag: 'wx' })
    } catch {
      // A read-only home directory must never break execution; memory still serves this process.
    }
  }

  /**
   * Bound the directory, at most once per interval.
   *
   * The notebook mirror keeps the outputs that reference these files, so they cannot simply be
   * dropped on restart. The cap is generous and only the oldest drawings go first; anything pruned
   * still renders from the in-memory copy until the app restarts.
   */
  #prune() {
    const now = Date.now()
    if (now - this.#lastPruneAt < this.#pruneIntervalMs) return
    // Mark before scanning: a scan that throws must not turn into one attempt per write.
    this.#lastPruneAt = now
    let entries
    try {
      entries = readdirSync(this.#directory)
        .filter((name) => NAME_PATTERN.test(name))
        .map((name) => {
          const file = path.join(this.#directory, name)
          const info = statSync(file)
          return { file, size: info.size, at: info.mtimeMs }
        })
    } catch {
      return
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    if (total <= this.#maxDiskBytes) return
    entries.sort((left, right) => left.at - right.at)
    for (const entry of entries) {
      if (total <= this.#maxDiskBytes) break
      try {
        unlinkSync(entry.file)
        total -= entry.size
      } catch {
        // Another process may have removed it first.
      }
    }
  }
}

/** MIME type implied by an asset file name. */
function mimeOf(name) {
  return MIME_BY_EXTENSION[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream'
}
