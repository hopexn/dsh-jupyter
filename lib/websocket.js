/**
 * A minimal RFC 6455 WebSocket client, used for the kernel channel.
 *
 * ## Why not the built-in `WebSocket`
 *
 * Node's `WebSocket` resolves the hostname through `dns.lookup` on every handshake and gives no
 * way to inject a resolver (`headers.host` is overwritten before the request leaves, verified).
 * Against a mDNS name that is one five-second `getaddrinfo` per kernel channel — and a channel is
 * opened exactly when the user first runs something, which is the worst possible moment.
 *
 * Going through `node:http`'s upgrade path fixes that because the request accepts a `lookup`, and
 * it keeps `Host` and TLS SNI correct — which matters here, since Jupyter answers `403` to a
 * request whose `Host` does not match its own address.
 *
 * Only what the kernel protocol needs is implemented: text frames, fragmentation, ping/pong and
 * close. No extensions, no sub-protocol negotiation, no client-side masking shortcuts.
 *
 * @module dsh-jupyterlab/websocket
 */

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

import { createLookup } from './dns-cache.js'

/** The magic value RFC 6455 mixes into the handshake key. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Frame opcodes this client understands. */
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

/** Default cap on one message, so a hostile peer cannot exhaust memory. */
const DEFAULT_MAX_PAYLOAD = 64 * 1024 * 1024

/** Shared resolver for kernel channels: same cache as the REST transport. */
const sharedLookup = createLookup()

/**
 * A connected (or connecting) WebSocket channel.
 *
 * Mirrors the small slice of the browser API the kernel client uses: `readyState`, `send`,
 * `close`, `addEventListener`/`removeEventListener`, and the `onopen`/`onmessage`/`onclose`/
 * `onerror` properties.
 */
export class KernelSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  /** Current state, as the browser API reports it. */
  readyState = KernelSocket.CONNECTING
  /** @type {((event: object) => void)|null} */
  onopen = null
  /** @type {((event: object) => void)|null} */
  onmessage = null
  /** @type {((event: object) => void)|null} */
  onclose = null
  /** @type {((event: object) => void)|null} */
  onerror = null

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map()
  /** Unparsed bytes carried over between TCP reads. */
  #buffer = Buffer.alloc(0)
  /** Frames of a fragmented message, in arrival order. */
  #fragments = []
  /** Opcode of the message being reassembled. */
  #fragmentOpcode = 0
  #socket
  #request
  #timer
  #closeEmitted = false

  /**
   * @param url - Absolute `ws(s)://` URL.
   * @param options - Connection controls.
   * @param options.headers - Extra request headers (cookie, authorization).
   * @param options.lookup - Resolver for the handshake; defaults to the shared cache.
   * @param options.connectTimeoutMs - Handshake budget.
   * @param options.maxPayloadBytes - Largest single message accepted.
   */
  constructor(url, { headers = {}, lookup = sharedLookup, connectTimeoutMs = 15_000, maxPayloadBytes = DEFAULT_MAX_PAYLOAD } = {}) {
    /** Absolute URL this channel talks to. */
    this.url = url
    this.maxPayloadBytes = maxPayloadBytes
    this.#connect(headers, lookup, connectTimeoutMs)
  }

  /** Whether the channel is open. */
  get isOpen() {
    return this.readyState === KernelSocket.OPEN
  }

  /**
   * @param type - Event name: `open`, `message`, `close` or `error`.
   * @param listener - Handler.
   */
  addEventListener(type, listener) {
    if (typeof listener !== 'function') return
    let set = this.#listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(type, set)
    }
    set.add(listener)
  }

  /**
   * @param type - Event name.
   * @param listener - Handler previously added.
   */
  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener)
  }

  /**
   * Send one text message.
   *
   * @param text - Payload.
   * @throws {Error} When the channel is not open.
   */
  send(text) {
    if (this.readyState !== KernelSocket.OPEN) {
      throw new Error('jupyter: the kernel channel is not open.')
    }
    this.#writeFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8'))
  }

  /** Send a close frame and tear the socket down. */
  close() {
    if (this.readyState === KernelSocket.CLOSED) return
    this.readyState = KernelSocket.CLOSING
    try {
      this.#writeFrame(OPCODE.CLOSE, Buffer.alloc(0))
    } catch {
      // The socket may already be gone; tearing down below is what matters.
    }
    this.#teardown()
    this.#emitClose()
  }

  /** Open the upgrade request. */
  #connect(headers, lookup, connectTimeoutMs) {
    const target = new URL(this.url)
    const transport = target.protocol === 'wss:' ? https : http
    const key = randomBytes(16).toString('base64')
    let request
    try {
      request = transport.request({
        hostname: target.hostname,
        port: target.port === '' ? undefined : target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        // No pooling: this socket stops being HTTP after the upgrade.
        agent: false,
        lookup,
        headers: {
          ...headers,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': key,
          'sec-websocket-version': '13',
        },
      })
    } catch (error) {
      queueMicrotask(() => this.#fail(error))
      return
    }
    this.#request = request
    this.#timer = setTimeout(() => {
      this.#fail(new Error(`jupyter: timed out opening the channel to ${this.url}`))
    }, connectTimeoutMs)
    if (typeof this.#timer.unref === 'function') this.#timer.unref()

    request.on('upgrade', (response, socket, head) => {
      clearTimeout(this.#timer)
      const expected = createHash('sha1').update(key + GUID).digest('base64')
      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy()
        this.#fail(new Error('jupyter: the channel handshake was answered with the wrong Sec-WebSocket-Accept.'))
        return
      }
      this.#attach(socket, head)
    })
    request.on('response', (response) => {
      // A non-101 answer means the upgrade was refused — usually a dead kernel (404) or a
      // rejected credential (403). Both need to surface as a handshake failure.
      clearTimeout(this.#timer)
      const status = response.statusCode ?? 0
      response.resume()
      this.#fail(new Error(`jupyter: the channel upgrade was refused with HTTP ${status}. The kernel may have been shut down.`))
    })
    request.on('error', (error) => {
      clearTimeout(this.#timer)
      this.#fail(error)
    })
    request.end()
  }

  /** Take ownership of the upgraded socket. */
  #attach(socket, head) {
    this.#socket = socket
    this.readyState = KernelSocket.OPEN
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('error', (error) => {
      this.#emit('error', { type: 'error', message: error?.message })
      this.#teardown()
      this.#emitClose()
    })
    socket.on('close', () => {
      this.#teardown()
      this.#emitClose()
    })
    if (head !== undefined && head !== null && head.length > 0) this.#onData(head)
    this.#emit('open', { type: 'open' })
  }

  /** Buffer incoming bytes and parse as many complete frames as possible. */
  #onData(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    while (this.readyState === KernelSocket.OPEN && this.#parseFrame()) {
      // Keep draining; a single read can carry many frames.
    }
  }

  /**
   * Parse one frame from the buffer.
   *
   * @returns True when a frame was consumed, false when more bytes are needed.
   */
  #parseFrame() {
    const buffer = this.#buffer
    if (buffer.length < 2) return false
    const fin = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return false
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return false
      const wide = buffer.readBigUInt64BE(2)
      if (wide > BigInt(this.maxPayloadBytes)) {
        this.#fail(new Error(`jupyter: the kernel sent a ${wide.toString()} byte frame, above the limit.`))
        return false
      }
      length = Number(wide)
      offset = 10
    }
    if (length > this.maxPayloadBytes) {
      this.#fail(new Error('jupyter: the kernel sent an oversized frame.'))
      return false
    }
    let mask
    if (masked) {
      if (buffer.length < offset + 4) return false
      mask = buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (buffer.length < offset + length) return false

    let payload = buffer.subarray(offset, offset + length)
    if (masked) {
      const unmasked = Buffer.allocUnsafe(length)
      for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ mask[index & 3]
      payload = unmasked
    }
    this.#buffer = buffer.subarray(offset + length)
    this.#handleFrame(fin, opcode, payload)
    return true
  }

  /** Act on one complete frame. */
  #handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OPCODE.CONTINUATION:
        this.#fragments.push(payload)
        if (fin) this.#flushFragments()
        break
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (fin) this.#deliver(payload)
        else {
          this.#fragmentOpcode = opcode
          this.#fragments = [payload]
        }
        break
      case OPCODE.PING:
        this.#writeFrame(OPCODE.PONG, payload)
        break
      case OPCODE.PONG:
        break
      case OPCODE.CLOSE:
        this.close()
        break
      default:
        this.#fail(new Error(`jupyter: the kernel channel sent an unknown frame opcode 0x${opcode.toString(16)}.`))
        break
    }
  }

  /** Join a fragmented message and deliver it. */
  #flushFragments() {
    if (this.#fragments.length === 0) return
    const payload = Buffer.concat(this.#fragments)
    this.#fragments = []
    if (this.#fragmentOpcode === OPCODE.TEXT || this.#fragmentOpcode === OPCODE.BINARY) this.#deliver(payload)
    this.#fragmentOpcode = 0
  }

  /** Hand one message to the consumer. */
  #deliver(payload) {
    this.#emit('message', { type: 'message', data: payload.toString('utf8') })
  }

  /** Write one masked frame. */
  #writeFrame(opcode, payload) {
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.allocUnsafe(2)
      header[1] = 0x80 | length
    } else if (length < 65_536) {
      header = Buffer.allocUnsafe(4)
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.allocUnsafe(10)
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    header[0] = 0x80 | opcode
    const mask = randomBytes(4)
    const masked = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index & 3]
    this.#socket?.write(Buffer.concat([header, mask, masked]))
  }

  /** Release the socket and the request. */
  #teardown() {
    this.readyState = KernelSocket.CLOSED
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    try { this.#socket?.destroy() } catch { /* already gone */ }
    this.#socket = undefined
    try { this.#request?.destroy() } catch { /* already gone */ }
    this.#request = undefined
    this.#buffer = Buffer.alloc(0)
    this.#fragments = []
  }

  /** Fail the connection before it opened. */
  #fail(error) {
    this.#teardown()
    this.#emit('error', { type: 'error', message: error?.message ?? String(error) })
    this.#emitClose()
  }

  /** Emit `close` exactly once. */
  #emitClose() {
    if (this.#closeEmitted) return
    this.#closeEmitted = true
    this.#emit('close', { type: 'close', code: 1006, wasClean: false })
  }

  /** Call property handlers and `addEventListener` listeners for one event. */
  #emit(type, event) {
    const property = this[`on${type}`]
    if (typeof property === 'function') {
      try { property.call(this, event) } catch { /* a listener must not break the channel */ }
    }
    const set = this.#listeners.get(type)
    if (set === undefined) return
    for (const listener of [...set]) {
      try { listener.call(this, event) } catch { /* same */ }
    }
  }
}
