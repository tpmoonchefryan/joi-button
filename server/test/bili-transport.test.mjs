// The Bilibili Live Open Platform transport, driven against local fakes.
//
// TESTING WITHOUT CREDENTIALS IS THE POINT, not a convenience. Nothing in this
// file talks to bilibili: a real http server plays the gateway and a real
// RFC 6455 server plays the danmaku socket, so every byte this suite asserts on
// is a byte the production code actually produced or consumed. That matters
// more here than anywhere else in the project, because the failure mode the
// transport exists to prevent — being deaf while looking like we are listening
// — is invisible from the outside, and a mocked transport would reproduce the
// look without the hearing.
//
// WHY THE WEBSOCKET SERVER IS HAND-ROLLED AND `ws` IS NOT A DEPENDENCY.
// The sourcing rules say to check the three rings before adding anything, and
// the first ring answers: node ships a WebSocket CLIENT (used by the code under
// test) but no server, and what a server needs here is one upgrade handshake
// (sha1 of the key plus the RFC's fixed GUID) and one frame codec restricted to
// what the client under test actually sends — unfragmented binary, close, ping.
// That is the ~90 lines below. `ws` is an excellent library, and adding it would
// put a production-dependency-shaped supply-chain surface into this repository
// to serve test code alone, which is the trade the rules exist to refuse. The
// cost of the choice is stated rather than hidden: this server would not survive
// a fragmented frame or a payload above 64 KiB from the client, and if either
// ever becomes something the client does, this file has to grow.
//
// The clock is injected with a HAND-MOVED `now` and REAL timers. That split is
// deliberate: the sockets are real, so timers must actually fire, but `now` is
// the only input to the backoff gate and to danmaku-source's continuity
// arithmetic — leaving it on the wall clock would make "the reconnect happened
// after the code was issued" a race against a one-second timestamp resolution.

import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { brotliCompressSync, deflateSync } from 'node:zlib'

import { toCanonicalTimestamp } from '../db/migrate.mjs'
import {
  DANMAKU_CMD,
  HEADER_BYTES,
  INTERACTION_END_CMD,
  OPERATION,
  OPEN_LIVE_PATHS,
  OpenPlatformError,
  PROTO_VERSION,
  SIGNATURE_METHOD,
  SIGNATURE_VERSION,
  canonicalStringFromHeaders,
  createBiliTransport,
  decodeFrame,
  dialHost,
  encodePacket,
  signOpenPlatformRequest,
} from '../lib/bili-transport.mjs'
import { VISITOR_VERDICTS, createDanmakuSource } from '../lib/danmaku-source.mjs'

// ---------------------------------------------------------------------------
// a websocket server, in as little RFC 6455 as the client under test exercises

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function encodeServerFrame(payload, opcode = 0x2) {
  // Server-to-client frames are never masked (RFC 6455 §5.1).
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/** Pull whole frames off an accumulating buffer; returns [frames, remainder]. */
function drainClientFrames(buffer) {
  const frames = []
  let buf = buffer
  for (;;) {
    if (buf.length < 2) break
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < 4) break
      len = buf.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (buf.length < 10) break
      len = Number(buf.readBigUInt64BE(2))
      offset = 10
    }
    let mask = null
    if (masked) {
      if (buf.length < offset + 4) break
      mask = buf.subarray(offset, offset + 4)
      offset += 4
    }
    if (buf.length < offset + len) break
    const payload = Buffer.from(buf.subarray(offset, offset + len))
    if (mask !== null) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    frames.push({ opcode, payload })
    buf = buf.subarray(offset + len)
  }
  return [frames, buf]
}

/**
 * @param {(conn: object) => void} onConnection called with a connection handle
 *        carrying: send(buffer), sendPacket(opts), drop(), received (array of
 *        decoded client packets), and authBody (the auth packet's body text).
 */
function startWsServer(onConnection) {
  const server = createServer()
  const sockets = new Set()

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    sockets.add(socket)

    const conn = {
      socket,
      received: [], // every packet the client sent, decoded
      authBody: null,
      closed: false,
      rude: false, // set by a case to withhold the close-frame reply
      send: (buffer) => {
        if (!socket.destroyed) socket.write(encodeServerFrame(buffer))
      },
      sendPacket: (opts) => conn.send(encodePacket(opts)),
      /** Kill the socket the way a network does: no close frame, just gone. */
      drop: () => {
        conn.closed = true
        socket.destroy()
      },
    }

    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      const [frames, rest] = drainClientFrames(pending)
      pending = rest
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          conn.closed = true
          // `rude` models the peer the idle watchdog exists for: connected,
          // reachable, and not answering. RFC 6455 §7.1.2 has the closing side
          // wait for this reply, so withholding it is what leaves the client's
          // socket open — see closeSocket()'s known limit.
          if (!conn.rude && !socket.destroyed) socket.end(encodeServerFrame(Buffer.alloc(0), 0x8))
          continue
        }
        if (frame.opcode === 0x9) {
          conn.send(encodeServerFrame(frame.payload, 0xa))
          continue
        }
        if (frame.opcode !== 0x2) continue
        const header = {
          packetLength: frame.payload.readUInt32BE(0),
          headerLength: frame.payload.readUInt16BE(4),
          protocolVersion: frame.payload.readUInt16BE(6),
          operation: frame.payload.readUInt32BE(8),
          sequence: frame.payload.readUInt32BE(12),
        }
        const body = frame.payload.subarray(HEADER_BYTES, header.packetLength)
        conn.received.push({ ...header, body })
        if (header.operation === OPERATION.AUTH) conn.authBody = body.toString('utf8')
      }
    })
    socket.on('error', () => {
      conn.closed = true
    })
    socket.on('close', () => {
      conn.closed = true
      sockets.delete(socket)
    })

    onConnection(conn)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `ws://127.0.0.1:${port}/sub`,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// a gateway server

/**
 * @param {(call: {path: string, body: object, headers: object}) => object} handler
 *        returns { status?, json?, text? }
 */
function startGateway(handler) {
  const calls = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    // Awaited, so a case can hold one answer open while the world moves on
    // underneath it — which is the only way to observe a reply that lands after
    // the session it belongs to is gone.
    req.on('end', async () => {
      const raw = Buffer.concat(chunks)
      const call = { path: req.url, headers: req.headers, raw, body: safeJson(raw) }
      calls.push(call)
      let answer
      try {
        answer = (await handler(call)) ?? { status: 200, json: { code: 0, message: '0', data: {} } }
      } catch (err) {
        answer = { status: 500, json: { code: -1, message: String(err) } }
      }
      const payload = answer.text ?? JSON.stringify(answer.json ?? {})
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
      res.end(payload)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        calls,
        callsTo: (path) => calls.filter((call) => call.path === path),
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function safeJson(raw) {
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// shared fixtures

const CREDENTIALS = Object.freeze({
  appId: 1787439765162,
  accessKeyId: 'akid-test-0001',
  accessKeySecret: 'secret-test-0001',
  roomOwnerAuthCode: 'OWNER-AUTH-CODE',
  roomId: 424242,
})

/** now is hand-moved; timers are real, because the sockets are real. */
function testClock(startIso = '2026-08-01T00:00:00Z') {
  let nowMs = Date.parse(startIso)
  return {
    now: () => new Date(nowMs),
    advance: (ms) => {
      nowMs += ms
    },
    setTimeout: (fn, ms) => {
      const t = globalThis.setTimeout(fn, ms)
      t.unref?.()
      return t
    },
    clearTimeout: (t) => globalThis.clearTimeout(t),
    setInterval: (fn, ms) => {
      const t = globalThis.setInterval(fn, ms)
      t.unref?.()
      return t
    },
    clearInterval: (t) => globalThis.clearInterval(t),
  }
}

/** `wssUrl` may be one link or the platform's whole list of them, in order. */
function startAnswer(wssUrl, { gameId = 'game-0001', roomId = CREDENTIALS.roomId } = {}) {
  const wssLinks = Array.isArray(wssUrl) ? wssUrl : [wssUrl]
  return {
    status: 200,
    json: {
      code: 0,
      message: '0',
      request_id: 'req-0001',
      data: {
        game_info: { game_id: gameId },
        websocket_info: { auth_body: JSON.stringify({ key: 'auth-token', roomid: roomId }), wss_link: wssLinks },
        anchor_info: { room_id: roomId, uid: 9, uname: 'owner', uface: '', open_id: 'owner-open-id' },
      },
    },
  }
}

function danmakuPacket({ openId, uname, msg }) {
  return encodePacket({
    operation: OPERATION.SEND_MSG_REPLY,
    protocolVersion: PROTO_VERSION.NORMAL,
    body: JSON.stringify({
      cmd: DANMAKU_CMD,
      data: { open_id: openId, uname, msg, uface: '', timestamp: 1_785_000_000, room_id: CREDENTIALS.roomId },
    }),
  })
}

async function until(predicate, what, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * A gateway and a socket that both behave, wired to a transport.
 *
 * Returns everything a case needs to misbehave selectively afterwards.
 */
async function wiredTransport({ gatewayHandler, onConnection, transport = {}, credentials = {} } = {}) {
  const clock = testClock()
  const connections = []
  const ws = await startWsServer((conn) => {
    connections.push(conn)
    if (onConnection) onConnection(conn, connections.length)
    else defaultAuth(conn)
  })
  const gateway = await startGateway(async (call) => {
    if (gatewayHandler) {
      const answer = await gatewayHandler(call, ws.url)
      if (answer) return answer
    }
    if (call.path === OPEN_LIVE_PATHS.start) return startAnswer(ws.url)
    return { status: 200, json: { code: 0, message: '0', data: {} } }
  })

  const config = {
    ...CREDENTIALS,
    ...credentials,
    clock,
    gatewayBaseUrl: gateway.baseUrl,
    transport: { wsIdleTimeoutMs: 60_000, wsHeartbeatIntervalMs: 60_000, ...transport },
  }

  return {
    clock,
    gateway,
    ws,
    connections,
    config,
    transport: createBiliTransport(config),
    close: async () => {
      await ws.close()
      await gateway.close()
    },
  }
}

/**
 * A danmaku host that accepts the TCP connection and then never answers the
 * websocket upgrade: the "still connecting" half of a slow cross-border
 * handshake (JOI-BUTTON-STORY-118). The sockets are tracked so close() can
 * destroy them; nothing else ever would.
 *
 * @param {{ onUpgrade?: () => void }} [hooks] called as each upgrade arrives
 */
function startStalledServer({ onUpgrade } = {}) {
  const server = createServer()
  const sockets = new Set()
  let upgrades = 0
  server.on('upgrade', (req, socket) => {
    upgrades += 1
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    if (onUpgrade) onUpgrade()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `ws://127.0.0.1:${port}/sub`,
        port,
        upgrades: () => upgrades,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

/**
 * The connect timeout for every case that makes a dial stall. Small, because
 * each stalled dial costs this much real time; not smaller, because the
 * HEALTHY dial in the same case has to finish inside it on a busy machine.
 */
const STALL_MS = 300

/**
 * `now` on the wall clock, for the cases that run the real lifecycle across a
 * redial. Its retry waits are real timers, while the transport's backoff gate
 * and the lifecycle's start budget both read `now` — with the hand-moved clock
 * the gate would never open and the budget would never run out. None of these
 * cases asserts anything second-precision about continuity.
 */
function wallClock() {
  const timers = testClock()
  return {
    now: () => new Date(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  }
}

/** Accept the auth packet as the platform would. */
function defaultAuth(conn) {
  const timer = setInterval(() => {
    if (conn.authBody === null) return
    clearInterval(timer)
    conn.sendPacket({
      operation: OPERATION.AUTH_REPLY,
      protocolVersion: PROTO_VERSION.NORMAL,
      body: JSON.stringify({ code: 0 }),
    })
  }, 2)
  timer.unref?.()
}

// ---------------------------------------------------------------------------
// the signature

test('the signature is HMAC-SHA256 over the documented canonical string (golden vector)', () => {
  // Working, reproducible with node:crypto and nothing else:
  //
  //   body          {"code":"OWNER-AUTH-CODE","app_id":1787439765162}   (49 bytes UTF-8)
  //   md5(body)     a0eda7d45905af8a3c47c956cc317c82
  //
  // The six x-bili-* headers, sorted by name ascending, each rendered
  // `name:value`, joined with '\n' and no trailing newline:
  //
  //   x-bili-accesskeyid:akid-golden-0001
  //   x-bili-content-md5:a0eda7d45905af8a3c47c956cc317c82
  //   x-bili-signature-method:HMAC-SHA256
  //   x-bili-signature-nonce:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0
  //   x-bili-signature-version:1.0
  //   x-bili-timestamp:1785000000
  //
  //   HMAC-SHA256(key='secret-golden-0001', msg=that string), lower-case hex
  //     = 219c5d3668350dc85343e0e12941a968be2459f096f81e2f64fd49a4cf902681
  //
  // The construction is [OFFICIAL] SignUtility.cs:32-79 and [BLIVEDM]
  // open_live.py:126-143, which agree line for line. See lib/bili-transport.mjs.
  const bodyBytes = Buffer.from(JSON.stringify({ code: 'OWNER-AUTH-CODE', app_id: 1787439765162 }), 'utf8')
  const signed = signOpenPlatformRequest({
    accessKeyId: 'akid-golden-0001',
    accessKeySecret: 'secret-golden-0001',
    bodyBytes,
    nonce: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    timestamp: '1785000000',
  })

  assert.equal(bodyBytes.length, 49)
  assert.equal(signed.contentMd5, 'a0eda7d45905af8a3c47c956cc317c82')
  assert.equal(
    signed.canonicalString,
    [
      'x-bili-accesskeyid:akid-golden-0001',
      'x-bili-content-md5:a0eda7d45905af8a3c47c956cc317c82',
      'x-bili-signature-method:HMAC-SHA256',
      'x-bili-signature-nonce:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
      'x-bili-signature-version:1.0',
      'x-bili-timestamp:1785000000',
    ].join('\n'),
  )
  assert.equal(signed.signature, '219c5d3668350dc85343e0e12941a968be2459f096f81e2f64fd49a4cf902681')
  // No scheme prefix: the hex IS the header value.
  assert.equal(signed.headers.Authorization, signed.signature)
  assert.equal(signed.headers['x-bili-signature-method'], SIGNATURE_METHOD)
  assert.equal(signed.headers['x-bili-signature-version'], SIGNATURE_VERSION)
  assert.equal(signed.canonicalString.endsWith('\n'), false, 'the canonical string must not end with a newline')
})

test('the sort is load-bearing: the same headers joined in insertion order sign differently', () => {
  // Without this case the `.sort()` could be deleted and the golden vector above
  // would still pass IF the object literal happened to be written in sorted
  // order. It is not — lib/bili-transport.mjs builds it in the official demo's
  // insertion order precisely so the two differ, and this is the proof that they
  // do. Deleting the sort turns the golden signature into this one.
  const pairs = {
    'x-bili-content-md5': 'a0eda7d45905af8a3c47c956cc317c82',
    'x-bili-timestamp': '1785000000',
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    'x-bili-accesskeyid': 'akid-golden-0001',
    'x-bili-signature-version': '1.0',
  }
  const unsorted = Object.keys(pairs)
    .map((name) => `${name}:${pairs[name]}`)
    .join('\n')
  const signature = createHmac('sha256', 'secret-golden-0001').update(unsorted, 'utf8').digest('hex')

  assert.equal(signature, '48af86db1f328567757a9cd88a7cc92a877e0bbfee6c7a35155b6b11942ad013')
  assert.notEqual(signature, '219c5d3668350dc85343e0e12941a968be2459f096f81e2f64fd49a4cf902681')
})

test('the signature on the wire verifies against the bytes that were actually sent', async () => {
  // Re-implementing the construction in the test would only prove that two
  // copies of one mistake agree. This is the check a verifier on the other side
  // makes: take the x-bili-* headers off the wire, sort, join, HMAC, compare —
  // and crucially recompute content-md5 over the RECEIVED body, so signing a
  // re-serialised body would fail here even though every header looked right.
  const verified = []
  const rig = await wiredTransport({
    gatewayHandler: (call) => {
      const expectedMd5 = createHash('md5').update(call.raw).digest('hex')
      const recomputed = createHmac('sha256', CREDENTIALS.accessKeySecret)
        .update(canonicalStringFromHeaders(call.headers), 'utf8')
        .digest('hex')
      verified.push({
        path: call.path,
        md5Matches: call.headers['x-bili-content-md5'] === expectedMd5,
        signatureMatches: call.headers.authorization === recomputed,
        headerNames: Object.keys(call.headers)
          .filter((name) => name.startsWith('x-bili-'))
          .sort(),
      })
      return null
    },
  })

  try {
    await rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} })
    await rig.transport.stop()

    assert.ok(verified.length >= 2, 'expected at least a start and an end call')
    for (const call of verified) {
      assert.equal(call.md5Matches, true, `content-md5 did not cover the body sent to ${call.path}`)
      assert.equal(call.signatureMatches, true, `Authorization did not verify for ${call.path}`)
      assert.deepEqual(call.headerNames, [
        'x-bili-accesskeyid',
        'x-bili-content-md5',
        'x-bili-signature-method',
        'x-bili-signature-nonce',
        'x-bili-signature-version',
        'x-bili-timestamp',
      ])
    }
  } finally {
    await rig.close()
  }
})

// ---------------------------------------------------------------------------
// start / heartbeat / end

test('start, heartbeat and end are all called, with the bodies the platform documents', async () => {
  const rig = await wiredTransport()
  try {
    await rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} })

    rig.transport.heartbeat()
    await until(() => rig.gateway.callsTo(OPEN_LIVE_PATHS.heartbeat).length === 1, 'the app heartbeat')

    await rig.transport.stop()

    const starts = rig.gateway.callsTo(OPEN_LIVE_PATHS.start)
    const beats = rig.gateway.callsTo(OPEN_LIVE_PATHS.heartbeat)
    const ends = rig.gateway.callsTo(OPEN_LIVE_PATHS.end)

    assert.equal(starts.length, 1)
    assert.deepEqual(starts[0].body, { code: CREDENTIALS.roomOwnerAuthCode, app_id: CREDENTIALS.appId })
    assert.equal(beats.length, 1)
    assert.deepEqual(beats[0].body, { game_id: 'game-0001' })
    // The half that is easiest to forget: an un-ended session is a resource the
    // platform believes is still running, and it can block re-opening the room.
    assert.equal(ends.length, 1, 'the app session was never ended')
    assert.deepEqual(ends[0].body, { app_id: CREDENTIALS.appId, game_id: 'game-0001' })
  } finally {
    await rig.close()
  }
})

test('the websocket heartbeat is a second, separate beat: auth is answered with one immediately', async () => {
  // Separate cadences, separate transports, separate failure modes: the HTTP
  // beat keeps the PLATFORM's session alive (60s and it closes it), the WS beat
  // keeps the SOCKET alive. Confusing them means one of the two silently stops.
  const rig = await wiredTransport({ transport: { wsHeartbeatIntervalMs: 25 } })
  try {
    await rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} })
    const conn = rig.connections[0]

    await until(() => conn.received.some((p) => p.operation === OPERATION.HEARTBEAT), 'the first ws heartbeat')
    const first = conn.received.filter((p) => p.operation === OPERATION.HEARTBEAT).length
    assert.ok(first >= 1, 'no websocket heartbeat followed a successful auth')
    // Outgoing packets carry protocol version 1 and sequence 1 in both sources.
    const beat = conn.received.find((p) => p.operation === OPERATION.HEARTBEAT)
    assert.equal(beat.protocolVersion, PROTO_VERSION.HEARTBEAT)
    assert.equal(beat.sequence, 1)
    assert.equal(beat.headerLength, HEADER_BYTES)

    await until(
      () => conn.received.filter((p) => p.operation === OPERATION.HEARTBEAT).length > first,
      'the ws heartbeat to repeat on its interval',
    )
    // No HTTP heartbeat was called for any of that.
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.heartbeat).length, 0)
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('heartbeat() never returns a thenable, and reports an async failure on the next beat', async () => {
  // danmaku-source.mjs calls heartbeat() un-awaited inside a try/catch. A
  // returned rejected promise would become an unhandled rejection and take the
  // process down — a failing room heartbeat has to degrade, not detonate.
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => {
      if (call.path === OPEN_LIVE_PATHS.start) return startAnswer(wssUrl)
      if (call.path === OPEN_LIVE_PATHS.heartbeat) return { status: 200, json: { code: 4000, message: 'nope' } }
      return null
    },
  })
  try {
    await rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} })

    const returned = rig.transport.heartbeat()
    assert.equal(returned, undefined, 'heartbeat() returned a value the lifecycle would ignore')
    assert.equal(typeof returned?.then, 'undefined')

    await until(() => rig.transport.state().deferredErrors > 0, 'the failed beat to be recorded')
    // It surfaces synchronously on the NEXT beat, which is the only channel the
    // lifecycle gives us — it routes a throw here to its 'error' listeners.
    assert.throws(() => rig.transport.heartbeat(), /app heartbeat answered code 4000/)
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('heartbeat() with no open session throws rather than pretending there is something to keep alive', async () => {
  const rig = await wiredTransport()
  try {
    assert.throws(() => rig.transport.heartbeat(), /no open app session/)
  } finally {
    await rig.close()
  }
})

// ---------------------------------------------------------------------------
// framing

test('a multi-packet zlib frame yields every danmaku inside it', async () => {
  // The case the task calls out and the one a naive implementation passes every
  // test but this one: JSON.parse on the payload works right up until the first
  // compressed batch, and then loses everything in it at once, silently, with
  // the socket still up.
  const seen = []
  const rig = await wiredTransport()
  try {
    await rig.transport.start({ onDanmaku: (raw) => seen.push(raw), onDisconnect: () => {} })
    const conn = rig.connections[0]

    const inner = Buffer.concat([
      danmakuPacket({ openId: 'open-a', uname: 'Ann', msg: 'JOI-AAAA' }),
      danmakuPacket({ openId: 'open-b', uname: 'Bo', msg: 'JOI-BBBB' }),
      danmakuPacket({ openId: 'open-c', uname: 'Cy', msg: 'JOI-CCCC' }),
    ])
    // Proof that the naive path really would fail here, asserted rather than
    // asserted-about: the compressed payload is not JSON.
    const compressed = deflateSync(inner)
    assert.throws(() => JSON.parse(compressed.toString('utf8')))

    conn.send(
      encodePacket({
        operation: OPERATION.SEND_MSG_REPLY,
        protocolVersion: PROTO_VERSION.DEFLATE,
        body: compressed,
      }),
    )

    await until(() => seen.length === 3, 'all three danmaku from the compressed batch')
    assert.deepEqual(
      seen.map((raw) => raw.open_id),
      ['open-a', 'open-b', 'open-c'],
    )
    assert.deepEqual(
      seen.map((raw) => raw.msg),
      ['JOI-AAAA', 'JOI-BBBB', 'JOI-CCCC'],
    )
    // The wire names are handed over untouched: normalizeDanmaku() in
    // danmaku-source.mjs is the single normaliser and it reads these.
    assert.equal(seen[1].uname, 'Bo')
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('an uncompressed multi-packet frame is walked too, and a HEARTBEAT_REPLY is not walked past', () => {
  const batch = Buffer.concat([
    danmakuPacket({ openId: 'open-a', uname: 'Ann', msg: 'one' }),
    danmakuPacket({ openId: 'open-b', uname: 'Bo', msg: 'two' }),
  ])
  const packets = decodeFrame(batch)
  assert.equal(packets.length, 2)
  assert.equal(JSON.parse(packets[1].body.toString('utf8')).data.msg, 'two')

  // A heartbeat reply's pack_len excludes the echoed heartbeat body, so a walk
  // that trusted it would land mid-body and read a garbage header.
  //
  // The red input has to be chosen, not assumed. An earlier version of this case
  // used a 12-byte echo, and a walk that advanced by pack_len simply ran off the
  // end of a 28-byte buffer and stopped — one packet either way, green through
  // the exact defect it was written for. The echo here is what the server
  // actually sends back ("后面是客户端发的心跳包内容"): the client's whole
  // 16-byte heartbeat packet, after the four popularity bytes. Advancing by the
  // declared 16 now lands on the popularity value and reads it as a packet
  // length of 10000, which the walk refuses.
  const reply = Buffer.concat([
    Buffer.alloc(HEADER_BYTES),
    Buffer.from([0, 0, 0x27, 0x10]), // popularity = 10000
    encodePacket({ operation: OPERATION.HEARTBEAT }), // our own beat, echoed
  ])
  reply.writeUInt32BE(HEADER_BYTES, 0)
  reply.writeUInt16BE(HEADER_BYTES, 4)
  reply.writeUInt16BE(PROTO_VERSION.NORMAL, 6)
  reply.writeUInt32BE(OPERATION.HEARTBEAT_REPLY, 8)
  reply.writeUInt32BE(1, 12)

  const decoded = decodeFrame(reply)
  assert.equal(decoded.length, 1, 'the walk continued past a heartbeat reply into its echoed body')
  assert.equal(decoded[0].operation, OPERATION.HEARTBEAT_REPLY)
  assert.equal(decoded[0].body.readUInt32BE(0), 10_000, 'the popularity value was not the first four body bytes')
})

test('a brotli batch is decoded too, and the two decompression ceilings hold', async () => {
  // Brotli is decoded for the same reason zlib is: the two reference
  // implementations disagree about whether the Open Platform sends compressed
  // frames at all, and decoding a format the server never sends costs nothing
  // while failing to decode one it does send loses a whole batch invisibly.
  const inner = Buffer.concat([
    danmakuPacket({ openId: 'open-a', uname: 'Ann', msg: 'br-one' }),
    danmakuPacket({ openId: 'open-b', uname: 'Bo', msg: 'br-two' }),
  ])
  const packets = decodeFrame(
    encodePacket({
      operation: OPERATION.SEND_MSG_REPLY,
      protocolVersion: PROTO_VERSION.BROTLI,
      body: brotliCompressSync(inner),
    }),
  )
  assert.equal(packets.length, 2)
  assert.equal(JSON.parse(packets[0].body.toString('utf8')).data.msg, 'br-one')

  // A ceiling nobody can breach is not a ceiling. Both of these are inputs a
  // hostile upstream controls: a body that expands far beyond what it cost to
  // send, and a packet that decompresses into a packet that decompresses into…
  // A well-formed packet whose body is 200 KiB of one character: valid all the
  // way down, so the ONLY thing that can reject it is the size ceiling. A bomb
  // made of garbage bytes would be refused by the header walk instead, and the
  // ceiling would sit there never having been the thing that said no.
  const padded = encodePacket({
    operation: OPERATION.SEND_MSG_REPLY,
    protocolVersion: PROTO_VERSION.NORMAL,
    body: JSON.stringify({ cmd: 'LIVE_OPEN_PLATFORM_PADDING', data: { pad: 'A'.repeat(200_000) } }),
  })
  const bomb = encodePacket({
    operation: OPERATION.SEND_MSG_REPLY,
    protocolVersion: PROTO_VERSION.DEFLATE,
    body: deflateSync(padded),
  })
  assert.ok(bomb.length < 1_000, 'the bomb should be cheap to send and expensive to expand')
  assert.throws(() => decodeFrame(bomb, { maxDecompressedBytes: 4_096 }), /expanded past 4096 bytes/)
  assert.equal(decodeFrame(bomb).length, 1, 'the default ceiling refused a body it should have accepted')

  let nested = danmakuPacket({ openId: 'open-a', uname: 'Ann', msg: 'deep' })
  for (let depth = 0; depth < 6; depth += 1) {
    nested = encodePacket({
      operation: OPERATION.SEND_MSG_REPLY,
      protocolVersion: PROTO_VERSION.DEFLATE,
      body: deflateSync(nested),
    })
  }
  assert.throws(() => decodeFrame(nested), /nesting deeper than 4 levels/)
})

test('encodePacket writes the 16-byte header the platform specifies', () => {
  const packet = encodePacket({ operation: OPERATION.AUTH, body: '{"key":"x"}' })
  assert.equal(packet.readUInt32BE(0), HEADER_BYTES + 11, 'total length must include the header')
  assert.equal(packet.readUInt16BE(4), HEADER_BYTES)
  assert.equal(packet.readUInt16BE(6), PROTO_VERSION.HEARTBEAT, 'outgoing packets use protocol version 1')
  assert.equal(packet.readUInt32BE(8), OPERATION.AUTH)
  assert.equal(packet.readUInt32BE(12), 1)
  assert.equal(packet.subarray(HEADER_BYTES).toString('utf8'), '{"key":"x"}')
})

test('a malformed frame is refused rather than walked, and costs one frame not the session', async () => {
  // Lengths that point outside the buffer, or below the header, are the two
  // shapes that turn a walk into an infinite loop or an out-of-bounds read.
  const lying = Buffer.alloc(HEADER_BYTES + 4)
  lying.writeUInt32BE(9999, 0)
  lying.writeUInt16BE(HEADER_BYTES, 4)
  assert.throws(() => decodeFrame(lying), /claims 9999 bytes but only 20 remain/)

  const tooShort = Buffer.alloc(HEADER_BYTES)
  tooShort.writeUInt32BE(4, 0)
  tooShort.writeUInt16BE(HEADER_BYTES, 4)
  assert.throws(() => decodeFrame(tooShort), /below its own header length/)

  assert.throws(() => decodeFrame(Buffer.alloc(8)), /shorter than the 16-byte header/)

  // And end to end: garbage on the socket does not end a visitor's wait.
  const seen = []
  const rig = await wiredTransport()
  try {
    await rig.transport.start({ onDanmaku: (raw) => seen.push(raw), onDisconnect: () => {} })
    const conn = rig.connections[0]
    conn.send(Buffer.from('not a packet at all, not even long enough'))
    await until(() => rig.transport.state().undecodableFrames === 1, 'the bad frame to be counted')

    conn.send(danmakuPacket({ openId: 'open-a', uname: 'Ann', msg: 'still here' }))
    await until(() => seen.length === 1, 'a good danmaku after a bad frame')
    assert.equal(rig.transport.state().authenticated, true, 'one bad frame tore the session down')
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('a mirrored danmaku is not identity: it was typed in another room', async () => {
  const seen = []
  const rig = await wiredTransport()
  try {
    await rig.transport.start({ onDanmaku: (raw) => seen.push(raw), onDisconnect: () => {} })
    const conn = rig.connections[0]

    conn.send(
      encodePacket({
        operation: OPERATION.SEND_MSG_REPLY,
        protocolVersion: PROTO_VERSION.NORMAL,
        body: JSON.stringify({
          cmd: 'LIVE_OPEN_PLATFORM_DM_MIRROR',
          data: { open_id: 'open-elsewhere', uname: 'Elsewhere', msg: 'JOI-AAAA', is_mirror: true },
        }),
      }),
    )
    conn.send(danmakuPacket({ openId: 'open-here', uname: 'Here', msg: 'JOI-BBBB' }))

    await until(() => seen.length === 1, 'the non-mirrored danmaku')
    // Give the mirror every chance to arrive late before concluding it did not.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(seen.length, 1, 'a mirrored danmaku was accepted as presence in the owner\'s room')
    assert.equal(seen[0].open_id, 'open-here')
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

// ---------------------------------------------------------------------------
// being deaf, and saying so

test('a gateway 4xx surfaces as "we are deaf", never as silence', async () => {
  const rig = await wiredTransport({
    gatewayHandler: (call) => {
      if (call.path === OPEN_LIVE_PATHS.start) {
        return { status: 403, json: { code: 4003, message: 'app not authorised for this room', request_id: 'req-x' } }
      }
      return null
    },
  })
  try {
    await assert.rejects(
      () => rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} }),
      (err) => {
        assert.match(err.message, /we cannot hear the room/)
        assert.equal(err.status, 403)
        assert.equal(err.platformCode, 4003)
        assert.equal(err.requestId, 'req-x')
        // The refusal must not carry the request body: it contains the room
        // owner's auth code, and an error message ends up in a log.
        assert.equal(err.message.includes(CREDENTIALS.roomOwnerAuthCode), false)
        assert.equal(err.message.includes(CREDENTIALS.accessKeySecret), false)
        return true
      },
    )
    assert.equal(rig.transport.state().hasSession, false)
  } finally {
    await rig.close()
  }
})

test('through the real lifecycle, a refusing gateway makes the visitor verdict FAILED and never LISTENING', async () => {
  // The end-to-end shape of the same fact. This is the one that matters to a
  // person: the UI branches on visitor.verdict, and only LISTENING_NO_MATCH
  // licenses telling someone their message did not arrive.
  const rig = await wiredTransport({
    gatewayHandler: (call) => {
      if (call.path === OPEN_LIVE_PATHS.start) return { status: 500, json: { code: -500, message: 'upstream' } }
      return null
    },
  })
  const source = createDanmakuSource({ ...rig.config, mode: 'production', lifecycle: { startTimeoutMs: 2_000 } })
  try {
    await assert.rejects(() => source.acquire(), /we cannot hear the room/)

    const status = source.status({ since: toCanonicalTimestamp(rig.clock.now()) })
    assert.equal(status.visitor.verdict, VISITOR_VERDICTS.FAILED)
    assert.equal(status.listening, false)
    assert.equal(status.visitor.canAssertNotSeen, false, 'a source that never listened claimed it would have seen it')
    assert.match(status.lastError.message, /we cannot hear the room/)
    assert.equal(status.waiters, 0, 'a failed start left a lease behind')
  } finally {
    await source.stop({ force: true }).catch(() => {})
    await rig.close()
  }
})

test('an auth rejection is not a listening socket: start fails and the session is ended', async () => {
  // Resolving on socket-open instead of on AUTH_REPLY code 0 is the bug here.
  // A connected but unauthenticated socket hears nothing at all, and showing a
  // visitor their code at that moment is showing it into a void.
  const rig = await wiredTransport({
    onConnection: (conn) => {
      const timer = setInterval(() => {
        if (conn.authBody === null) return
        clearInterval(timer)
        conn.sendPacket({
          operation: OPERATION.AUTH_REPLY,
          protocolVersion: PROTO_VERSION.NORMAL,
          body: JSON.stringify({ code: -101 }),
        })
      }, 2)
      timer.unref?.()
    },
  })
  try {
    await assert.rejects(
      () => rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} }),
      /rejected our auth packet \(code -101\)/,
    )
    // The gateway session was opened before the socket was dialled. Leaving it
    // open is a resource the platform believes is still running.
    const ends = rig.gateway.callsTo(OPEN_LIVE_PATHS.end)
    assert.equal(ends.length, 1, 'a start that failed after /v2/app/start left the session running')
    assert.deepEqual(ends[0].body, { app_id: CREDENTIALS.appId, game_id: 'game-0001' })
  } finally {
    await rig.close()
  }
})

test('a room id that does not match the auth code is refused, because listening to the wrong room looks like listening', async () => {
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => {
      if (call.path === OPEN_LIVE_PATHS.start) return startAnswer(wssUrl, { roomId: 999_999 })
      return null
    },
  })
  try {
    await assert.rejects(
      () => rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} }),
      /opened room 999999, but BILI_ROOM_ID is 424242/,
    )
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.end).length, 1)
  } finally {
    await rig.close()
  }
})

test('a socket that goes silent is reported as deafness, not left looking like listening', async () => {
  // The nastiest failure the transport has: the OS has no complaint, no data
  // arrives, and without the watchdog we would keep telling visitors we can
  // hear them.
  const disconnects = []
  const rig = await wiredTransport({ transport: { wsIdleTimeoutMs: 60, wsHeartbeatIntervalMs: 60_000 } })
  try {
    await rig.transport.start({ onDanmaku: () => {}, onDisconnect: (info) => disconnects.push(info) })
    await until(() => disconnects.length === 1, 'the idle watchdog to fire')
    assert.equal(disconnects[0].reason, 'ws-idle')
    assert.match(disconnects[0].error.message, /no websocket message for 60ms/)
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('the platform closing the app session (7003) deafens at once rather than after three misses', async () => {
  const disconnects = []
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => {
      if (call.path === OPEN_LIVE_PATHS.start) return startAnswer(wssUrl)
      if (call.path === OPEN_LIVE_PATHS.heartbeat) return { status: 200, json: { code: 7003, message: 'closed' } }
      return null
    },
  })
  try {
    await rig.transport.start({ onDanmaku: () => {}, onDisconnect: (info) => disconnects.push(info) })
    rig.transport.heartbeat()
    await until(() => disconnects.length === 1, 'the 7003 to be treated as deafness')
    assert.equal(disconnects[0].reason, 'app-session-closed')
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('a heartbeat answer that lands after its session is gone does not tear down the session that replaced it', async () => {
  // The app heartbeat is an HTTP call in flight for as long as the platform
  // takes to answer, and nothing cancels it. Twenty seconds later the answer
  // arrives into a world where that session has been stopped and a new one is
  // listening — and "the session is closed" is TRUE about the session it names
  // and FALSE about the socket that exists now. Acting on it would drop a live
  // room because of a dead one's mail.
  //
  // This is the case that makes the generation check in goDeaf() falsifiable.
  // Without it the guard sits green forever: every other caller of goDeaf is
  // reached through a timer that teardown already cleared, so an in-flight HTTP
  // reply is the only thing that can still arrive holding a stale generation.
  let releaseBeat
  const beatHeld = new Promise((resolve) => {
    releaseBeat = resolve
  })
  const disconnects = []
  const rig = await wiredTransport({
    gatewayHandler: async (call, wssUrl) => {
      if (call.path === OPEN_LIVE_PATHS.start) return startAnswer(wssUrl)
      if (call.path === OPEN_LIVE_PATHS.heartbeat) {
        await beatHeld
        return { status: 200, json: { code: 7003, message: 'closed' } }
      }
      return null
    },
  })
  const handlers = { onDanmaku: () => {}, onDisconnect: (info) => disconnects.push(info) }
  try {
    await rig.transport.start(handlers)
    rig.transport.heartbeat() // dispatched, and now parked on beatHeld

    await rig.transport.stop()
    await rig.transport.start(handlers)
    await until(() => rig.connections.length === 2, 'the replacement socket')
    assert.equal(rig.transport.state().authenticated, true)

    releaseBeat()
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.deepEqual(disconnects, [], 'a stale heartbeat reply disconnected the session that replaced it')
    assert.equal(rig.transport.state().authenticated, true, 'the live socket was torn down by a dead session reply')
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('the server ending the interaction is deafness, even though the socket stays open', async () => {
  const disconnects = []
  const rig = await wiredTransport()
  try {
    await rig.transport.start({ onDanmaku: () => {}, onDisconnect: (info) => disconnects.push(info) })
    rig.connections[0].send(
      encodePacket({
        operation: OPERATION.SEND_MSG_REPLY,
        protocolVersion: PROTO_VERSION.NORMAL,
        body: JSON.stringify({ cmd: INTERACTION_END_CMD, data: { game_id: 'game-0001' } }),
      }),
    )
    await until(() => disconnects.length === 1, 'the interaction-end to be reported')
    assert.equal(disconnects[0].reason, 'interaction-end')
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('a peer that will not answer the close frame is counted, not silently leaked', async () => {
  // A measured limit of the runtime, held in place by a test in both
  // directions. Node's WebSocket has no terminate(): close() waits for the
  // peer's close frame, and a connected-but-silent peer never sends one, so the
  // socket stays. That peer is exactly the one the idle watchdog exists for —
  // the repeating case — so a file descriptor per episode is the shape of it.
  // We cannot force the close; we can refuse to let it be invisible.
  const polite = await wiredTransport({ transport: { closeGraceMs: 40 } })
  try {
    await polite.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} })
    await polite.transport.stop()
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(
      polite.transport.state().socketsStuckClosing,
      0,
      'a well-behaved peer was reported as leaking, which would make the counter noise',
    )
  } finally {
    await polite.close()
  }

  const rude = await wiredTransport({
    onConnection: (conn) => {
      conn.rude = true
      defaultAuth(conn)
    },
    transport: { closeGraceMs: 40 },
  })
  try {
    await rude.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} })
    await rude.transport.stop()
    await until(() => rude.transport.state().socketsStuckClosing === 1, 'the stuck socket to be counted')
  } finally {
    await rude.close()
  }
})

// ---------------------------------------------------------------------------
// reconnection and backoff

test('consecutive start failures back off by doubling, and a dial during the backoff does not happen', async () => {
  // The delay is asserted on the transport's own schedule rather than on a
  // wall-clock gap, so this is exact rather than approximate. `now` is
  // hand-moved; only the gate reads it.
  const rig = await wiredTransport({
    gatewayHandler: (call) => {
      if (call.path === OPEN_LIVE_PATHS.start) return { status: 503, json: { code: -503, message: 'down' } }
      return null
    },
    transport: { backoff: { initialDelayMs: 1_000, factor: 2, maxDelayMs: 4_000 } },
  })
  const handlers = { onDanmaku: () => {}, onDisconnect: () => {} }
  try {
    const delays = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(() => rig.transport.start(handlers))
      delays.push(rig.transport.state().nextDialInMs)
      rig.clock.advance(rig.transport.state().nextDialInMs)
    }
    // Doubling, capped. A constant policy would read [1000, 1000, 1000, ...]
    // and a missing cap would read [..., 8000, 16000].
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 4_000, 4_000])
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.start).length, 5, 'a dial was skipped or doubled')

    // And the gate really gates: calling again before the delay elapses must not
    // touch the network at all.
    await assert.rejects(() => rig.transport.start(handlers))
    const dialled = rig.gateway.callsTo(OPEN_LIVE_PATHS.start).length
    await assert.rejects(() => rig.transport.start(handlers), /still backing off .* We are deaf, not idle/s)
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.start).length, dialled, 'the transport dialled while backing off')
  } finally {
    await rig.close()
  }
})

test('a successful start clears the backoff, so one bad minute does not throttle the next hour', async () => {
  let failStart = true
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => {
      if (call.path !== OPEN_LIVE_PATHS.start) return null
      if (failStart) return { status: 503, json: { code: -503, message: 'down' } }
      return startAnswer(wssUrl)
    },
  })
  try {
    await assert.rejects(() => rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} }))
    assert.equal(rig.transport.state().nextDialInMs, 1_000)

    rig.clock.advance(1_000)
    failStart = false
    await rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} })
    assert.equal(rig.transport.state().nextDialInMs, 0)
    assert.equal(rig.transport.state().consecutiveStartFailures, 0)
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('a dropped socket reconnects through the lifecycle, and the visitor is never blamed for our gap', async () => {
  // The whole point of the module, end to end. A visitor asked for a code while
  // we were listening; the socket then dropped and came back. The honest answer
  // afterwards is LISTENING_AFTER_GAP — "we were away, we cannot say you did not
  // send it" — and the dishonest one, the one this project exists to refuse, is
  // LISTENING_NO_MATCH.
  const seen = []
  const rig = await wiredTransport({ transport: { backoff: { initialDelayMs: 0, factor: 1, maxDelayMs: 0 } } })
  const source = createDanmakuSource({
    ...rig.config,
    mode: 'production',
    lifecycle: { reconnectDelayMs: 10, startTimeoutMs: 2_000, heartbeatIntervalMs: 60_000 },
  })
  source.on('danmaku', (event) => seen.push(event))

  try {
    const codeIssuedAt = toCanonicalTimestamp(rig.clock.now())
    const lease = await source.acquire()
    assert.equal(lease.status.listening, true)
    assert.equal(
      source.status({ since: codeIssuedAt }).visitor.verdict,
      VISITOR_VERDICTS.LISTENING_NO_MATCH,
      'an uninterrupted listen should license "you have not sent it yet"',
    )

    // Move `now` before the drop so the reconnect's listeningSince is provably
    // later than the code's issue time. Both are second-precision, so a
    // reconnect inside the same second reads as continuous by design.
    rig.clock.advance(5_000)
    rig.connections[0].drop()

    await until(() => rig.connections.length === 2, 'the lifecycle to redial')
    await until(() => source.status().state === 'listening', 'the source to come back')

    // Both halves of the session were released before the new one opened: the
    // lifecycle reconnects WITHOUT calling stop(), so start() is the only place
    // the old game session can be ended.
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.start).length, 2)
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.end).length, 1, 'the pre-drop session was left running')

    const after = source.status({ since: codeIssuedAt })
    assert.equal(after.visitor.verdict, VISITOR_VERDICTS.LISTENING_AFTER_GAP)
    assert.equal(after.visitor.canAssertNotSeen, false, 'the visitor was blamed for our disconnect')
    assert.equal(after.gaps.length >= 1, true)

    // And it is a working socket, not merely a state word.
    rig.connections[1].send(danmakuPacket({ openId: 'open-after', uname: 'After', msg: 'JOI-ZZZZ' }))
    await until(() => seen.length === 1, 'a danmaku over the reconnected socket')
    assert.equal(seen[0].openId, 'open-after')
    assert.equal(seen[0].text, 'JOI-ZZZZ')

    source.release(lease.leaseId)
    await until(() => source.status().state === 'stopped', 'the source to stop when the lease went')
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.end).length, 2, 'the second session was left running')
  } finally {
    await source.stop({ force: true }).catch(() => {})
    await rig.close()
  }
})

// ---------------------------------------------------------------------------
// construction

test('production refuses at boot without credentials, not at the first visitor', () => {
  assert.throws(() => createDanmakuSource({ mode: 'production' }), /cannot be built without every Open Platform/)
  assert.throws(
    () => createBiliTransport({ ...CREDENTIALS, accessKeySecret: '' }),
    /accessKeySecret \(BILI_ACCESS_KEY_SECRET\)/,
  )
  assert.throws(() => createBiliTransport({ ...CREDENTIALS, roomId: 0 }), /roomId \(BILI_ROOM_ID\)/)
  // Every missing key is named in one message rather than one per boot.
  assert.throws(
    () => createBiliTransport({}),
    /appId .*accessKeyId .*accessKeySecret .*roomOwnerAuthCode .*roomId/s,
  )
})

test('a production source has no programmable surface bolted onto it', async () => {
  const rig = await wiredTransport()
  try {
    const source = createDanmakuSource({ ...rig.config, mode: 'production' })
    assert.equal(source.mode, 'production')
    assert.equal(source.control, undefined, 'the development knobs exist on a production source')
    assert.ok(Object.isFrozen(source))
  } finally {
    await rig.close()
  }
})

test('a /v2/app/start that succeeds with an unusable payload still ends the session it opened', async () => {
  // The platform opens the session the moment /v2/app/start answers code 0. If
  // we then refuse the payload — a game_id but no wss_link to dial — the
  // session is ours whether we can use it or not, and an un-ended one can block
  // re-connecting to the same room. The visitor is then told the room is
  // unreachable because of our own bookkeeping.
  const rig = await wiredTransport({
    gatewayHandler: (call) => {
      if (call.path !== OPEN_LIVE_PATHS.start) return null
      return {
        status: 200,
        json: {
          code: 0,
          message: '0',
          data: {
            game_info: { game_id: 'game-LEAKED' },
            websocket_info: { auth_body: 'ok', wss_link: [] },
          },
        },
      }
    },
  })
  try {
    await assert.rejects(
      () => rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} }),
      /wss_link/,
    )
    assert.equal(
      rig.gateway.callsTo(OPEN_LIVE_PATHS.end).length,
      1,
      'the session the platform opened was never ended — the game_id was dropped before the failure path could see it',
    )
  } finally {
    await rig.close()
  }
})

// ---------------------------------------------------------------------------
// a slow handshake is waited out, on the same session (JOI-BUTTON-STORY-118)
//
// 2026-10-14, production: one cross-border handshake outlasted the connect
// timeout, the timeout was not retryable, and a visitor was told we could not
// hear the room. JOI-BUTTON-MIN-013 D1 is what these cases hold: the connect
// timer — and nothing else — is retryable, the game session is KEPT, and the
// redial goes to the next wss_link on that same session after one project
// heartbeat, with no /v2/app/end and no second /v2/app/start in between.

test('a connect timeout is retryable, keeps the game session, and arms the backoff for the redial', async () => {
  const stalled = await startStalledServer()
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => (call.path === OPEN_LIVE_PATHS.start ? startAnswer([stalled.url, wssUrl]) : null),
    transport: { connectTimeoutMs: STALL_MS },
  })
  try {
    await assert.rejects(
      () => rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} }),
      (err) => {
        assert.match(err.message, /did not authenticate within 300ms/)
        assert.equal(err.connectTimeout, true)
        assert.equal(err.retryable, true, 'a connect timeout was not offered for a retry')
        // backoffDelayMs(1) + 250 with the default backoff. The redial has to
        // land AFTER the gate opens, because the gate's refusal is final.
        assert.equal(err.retryAfterMs, 1_250)
        return true
      },
    )
    assert.equal(stalled.upgrades(), 1, 'the first wss_link was not the one dialled')
    const state = rig.transport.state()
    assert.equal(state.consecutiveStartFailures, 1)
    assert.equal(state.nextDialInMs, 1_000)
    assert.equal(state.hasSession, true, 'the game session was not kept for the redial')
    assert.equal(
      rig.gateway.callsTo(OPEN_LIVE_PATHS.end).length,
      0,
      'a connect timeout ended the session the redial needs; re-opening one walks into the 7001 cooldown',
    )
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
    await stalled.close()
  }
})

test('through the lifecycle, a connect timeout redials the next wss_link on the same session, and the visitor only ever sees starting', async () => {
  // Story AC1. The first address is connected but never answers the auth
  // packet; the second one does. The visitor is shown 准备中 throughout.
  const silent = []
  const silentHost = await startWsServer((conn) => silent.push(conn)) // handshakes, never answers auth
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) =>
      call.path === OPEN_LIVE_PATHS.start ? startAnswer([silentHost.url, wssUrl]) : null,
    transport: { connectTimeoutMs: STALL_MS },
  })
  const source = createDanmakuSource({
    ...rig.config,
    clock: wallClock(),
    mode: 'production',
    lifecycle: { startTimeoutMs: 2_000, heartbeatIntervalMs: 60_000 },
  })
  const states = []
  source.on('status', (status) => states.push(status.state))
  try {
    const lease = await source.acquire()
    assert.equal(lease.status.listening, true)

    assert.deepEqual(
      rig.gateway.calls.map((call) => call.path),
      [OPEN_LIVE_PATHS.start, OPEN_LIVE_PATHS.heartbeat],
      'between the two dials there must be one project heartbeat and nothing else — no end, no second start',
    )
    assert.deepEqual(rig.gateway.callsTo(OPEN_LIVE_PATHS.heartbeat)[0].body, { game_id: 'game-0001' })
    assert.equal(silent.length, 1, 'the first dial did not go to the first wss_link')
    assert.equal(rig.connections.length, 1, 'the redial did not go to the next wss_link')
    assert.notEqual(silent[0].authBody, null, 'the first dial never sent its auth packet')
    assert.equal(rig.connections[0].authBody, silent[0].authBody, 'the redial did not send the same auth_body verbatim')
    assert.deepEqual(
      states,
      ['starting', 'listening'],
      'the visitor saw something other than 准备中 during the redial',
    )

    // The session that was redialled is the one the visitor holds, and it is
    // ended when they let go — not leaked because it was carried across a dial.
    source.release(lease.leaseId)
    await until(() => source.status().state === 'stopped', 'the source to stop when the lease went')
    const ends = rig.gateway.callsTo(OPEN_LIVE_PATHS.end)
    assert.equal(ends.length, 1)
    assert.deepEqual(ends[0].body, { app_id: CREDENTIALS.appId, game_id: 'game-0001' })
  } finally {
    await source.stop({ force: true }).catch(() => {})
    await rig.close()
    await silentHost.close()
  }
})

for (const [refusal, answer] of [
  ['answers 7003', () => ({ status: 200, json: { code: 7003, message: 'closed' } })],
  ['fails with HTTP 502', () => ({ status: 502, json: { code: -502, message: 'bad gateway' } })],
]) {
  test(`a held session whose heartbeat ${refusal} is ended, and a new session is opened in its place`, async () => {
    const stalled = await startStalledServer()
    let starts = 0
    const rig = await wiredTransport({
      gatewayHandler: (call, wssUrl) => {
        if (call.path === OPEN_LIVE_PATHS.start) {
          starts += 1
          return startAnswer([stalled.url, wssUrl], { gameId: `game-000${starts}` })
        }
        if (call.path === OPEN_LIVE_PATHS.heartbeat) return answer()
        return null
      },
      transport: { connectTimeoutMs: STALL_MS },
    })
    const handlers = { onDanmaku: () => {}, onDisconnect: () => {} }
    try {
      await assert.rejects(() => rig.transport.start(handlers), (err) => err.retryable === true)
      rig.clock.advance(1_250) // what the lifecycle waits before it redials
      await rig.transport.start(handlers)

      assert.deepEqual(
        rig.gateway.calls.map((call) => call.path),
        [OPEN_LIVE_PATHS.start, OPEN_LIVE_PATHS.heartbeat, OPEN_LIVE_PATHS.end, OPEN_LIVE_PATHS.start],
        'a held session was dialled without being confirmed, or replaced without being ended',
      )
      assert.deepEqual(rig.gateway.callsTo(OPEN_LIVE_PATHS.heartbeat)[0].body, { game_id: 'game-0001' })
      assert.deepEqual(rig.gateway.callsTo(OPEN_LIVE_PATHS.end)[0].body, {
        app_id: CREDENTIALS.appId,
        game_id: 'game-0001',
      })
      const state = rig.transport.state()
      assert.equal(state.authenticated, true)
      assert.equal(state.hasSession, true)
      assert.equal(state.consecutiveStartFailures, 0)
      // The new session's dial still rotated past the address that stalled.
      assert.equal(stalled.upgrades(), 1)
      assert.equal(rig.connections.length, 1)
    } finally {
      await rig.transport.stop().catch(() => {})
      await rig.close()
      await stalled.close()
    }
  })
}

test('a held session is ended by stop(), exactly once, and is not reused afterwards', async () => {
  const stalled = await startStalledServer()
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => (call.path === OPEN_LIVE_PATHS.start ? startAnswer([stalled.url, wssUrl]) : null),
    transport: { connectTimeoutMs: STALL_MS },
  })
  const handlers = { onDanmaku: () => {}, onDisconnect: () => {} }
  try {
    await assert.rejects(() => rig.transport.start(handlers), (err) => err.retryable === true)
    assert.equal(rig.transport.state().hasSession, true)

    await rig.transport.stop()
    assert.equal(rig.transport.state().hasSession, false, 'stop() left the held session in place')
    await rig.transport.stop()
    const ends = rig.gateway.callsTo(OPEN_LIVE_PATHS.end)
    assert.equal(ends.length, 1, 'the held session was not ended exactly once')
    assert.deepEqual(ends[0].body, { app_id: CREDENTIALS.appId, game_id: 'game-0001' })

    // Nothing is carried over: the next start opens a session of its own and
    // never heartbeats the one stop() ended.
    rig.clock.advance(1_250)
    await rig.transport.start(handlers)
    assert.deepEqual(
      rig.gateway.calls.map((call) => call.path),
      [OPEN_LIVE_PATHS.start, OPEN_LIVE_PATHS.end, OPEN_LIVE_PATHS.start],
    )
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
    await stalled.close()
  }
})

test('a held session is ended when its redial fails for any reason other than another timeout', async () => {
  // One redial that is REFUSED rather than slow: the session it was kept for
  // has nothing left to wait for, so the failure path ends it as it always did.
  const stalled = await startStalledServer()
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => (call.path === OPEN_LIVE_PATHS.start ? startAnswer([stalled.url, wssUrl]) : null),
    onConnection: rejectingAuth, // the second address, where the redial goes
    transport: { connectTimeoutMs: STALL_MS },
  })
  const handlers = { onDanmaku: () => {}, onDisconnect: () => {} }
  try {
    await assert.rejects(() => rig.transport.start(handlers), (err) => err.retryable === true)
    rig.clock.advance(1_250)
    await assert.rejects(
      () => rig.transport.start(handlers),
      (err) => {
        assert.match(err.message, /rejected our auth packet \(code -101\)/)
        assert.notEqual(err.retryable, true)
        return true
      },
    )
    assert.deepEqual(
      rig.gateway.calls.map((call) => call.path),
      [OPEN_LIVE_PATHS.start, OPEN_LIVE_PATHS.heartbeat, OPEN_LIVE_PATHS.end],
    )
    assert.equal(rig.transport.state().hasSession, false)
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
    await stalled.close()
  }
})

test('through the lifecycle, when both addresses stall the budget runs out: no third dial, and the held session is ended once', async () => {
  const silent = []
  const silentHost = await startWsServer((conn) => silent.push(conn))
  const stalled = await startStalledServer()
  const rig = await wiredTransport({
    gatewayHandler: (call) =>
      call.path === OPEN_LIVE_PATHS.start ? startAnswer([silentHost.url, stalled.url]) : null,
    transport: { connectTimeoutMs: STALL_MS },
  })
  // On the wall clock: the first timeout lands near 300ms and asks for 1250ms,
  // which fits in 3000; the second lands near 1850ms and asks for 2250ms, which
  // does not. Both margins are over a second.
  const source = createDanmakuSource({
    ...rig.config,
    clock: wallClock(),
    mode: 'production',
    lifecycle: { startTimeoutMs: 2_000, startBudgetMs: 3_000, heartbeatIntervalMs: 60_000 },
  })
  try {
    await assert.rejects(
      () => source.acquire(),
      (err) => {
        // The transport's own, phase-specific error — not the lifecycle's
        // generic timeout, and not a backoff refusal.
        assert.match(err.message, /bili transport: the danmaku socket did not authenticate within 300ms/)
        return true
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 100)) // room for a third dial or a second end to show
    assert.equal(silent.length, 1)
    assert.equal(stalled.upgrades(), 1, 'the budget was spent and a third dial still happened')
    assert.deepEqual(
      rig.gateway.calls.map((call) => call.path),
      [OPEN_LIVE_PATHS.start, OPEN_LIVE_PATHS.heartbeat, OPEN_LIVE_PATHS.end],
      'the held session was leaked, or ended twice',
    )
    assert.deepEqual(rig.gateway.callsTo(OPEN_LIVE_PATHS.end)[0].body, {
      app_id: CREDENTIALS.appId,
      game_id: 'game-0001',
    })
    assert.equal(source.status().state, 'failed')
  } finally {
    await source.stop({ force: true }).catch(() => {})
    await rig.close()
    await silentHost.close()
    await stalled.close()
  }
})

function rejectingAuth(conn) {
  const timer = setInterval(() => {
    if (conn.authBody === null) return
    clearInterval(timer)
    conn.sendPacket({
      operation: OPERATION.AUTH_REPLY,
      protocolVersion: PROTO_VERSION.NORMAL,
      body: JSON.stringify({ code: -101 }),
    })
  }, 2)
  timer.unref?.()
}

function closingBeforeAuth(conn) {
  const timer = setInterval(() => {
    if (conn.authBody === null) return
    clearInterval(timer)
    // A clean close frame, then the end of the stream.
    if (!conn.socket.destroyed) conn.socket.end(encodeServerFrame(Buffer.alloc(0), 0x8))
  }, 2)
  timer.unref?.()
}

function droppingBeforeAuth(conn) {
  const timer = setInterval(() => {
    if (conn.authBody === null) return
    clearInterval(timer)
    conn.drop()
  }, 2)
  timer.unref?.()
}

for (const [what, setup, expected] of [
  ['an auth rejection', { onConnection: rejectingAuth }, /rejected our auth packet \(code -101\)/],
  ['a socket closed before auth', { onConnection: closingBeforeAuth }, /(closed|errored) before authenticating/],
  ['a socket dropped before auth', { onConnection: droppingBeforeAuth }, /(closed|errored) before authenticating/],
  [
    'a room that does not match BILI_ROOM_ID',
    {
      gatewayHandler: (call, wssUrl) =>
        call.path === OPEN_LIVE_PATHS.start ? startAnswer(wssUrl, { roomId: 999_999 }) : null,
    },
    /opened room 999999, but BILI_ROOM_ID is 424242/,
  ],
]) {
  test(`through the lifecycle, ${what} is dialled once, never retried, and its session is ended`, async () => {
    // Waiting does not fix these, so they fail exactly as they did before
    // MIN-013 D1. On the wall clock, so a retry that should not happen would
    // actually get through the backoff gate and show up as a second start.
    const rig = await wiredTransport({ ...setup, transport: { connectTimeoutMs: 2_000 } })
    const source = createDanmakuSource({
      ...rig.config,
      clock: wallClock(),
      mode: 'production',
      lifecycle: { startTimeoutMs: 3_000, heartbeatIntervalMs: 60_000 },
    })
    try {
      await assert.rejects(() => source.acquire(), expected)
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.start).length, 1, 'a hard failure was retried')
      assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.end).length, 1, 'the session was left running')
      assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.heartbeat).length, 0)
      assert.ok(rig.connections.length <= 1, 'a hard failure was redialled')
      assert.equal(source.status().state, 'failed')
    } finally {
      await source.stop({ force: true }).catch(() => {})
      await rig.close()
    }
  })
}

test('a stop() that lands mid-dial: the timeout that follows is not retryable, nothing is kept, and the session is ended once', async () => {
  let arrived
  const upgraded = new Promise((resolve) => {
    arrived = resolve
  })
  const stalled = await startStalledServer({ onUpgrade: () => arrived() })
  let starts = 0
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => {
      if (call.path !== OPEN_LIVE_PATHS.start) return null
      starts += 1
      return startAnswer(starts === 1 ? stalled.url : wssUrl, { gameId: `game-000${starts}` })
    },
    transport: { connectTimeoutMs: STALL_MS },
  })
  const handlers = { onDanmaku: () => {}, onDisconnect: () => {} }
  try {
    const outcome = rig.transport.start(handlers).then(
      () => null,
      (err) => err,
    )
    await upgraded
    await rig.transport.stop()
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.end).length, 1, 'stop() did not end the session')

    const err = await outcome
    assert.ok(err instanceof Error, 'a dial that was stopped resolved as if it had authenticated')
    assert.match(err.message, /did not authenticate within 300ms/)
    assert.notEqual(err.retryable, true, 'a dial nobody is waiting for asked to be retried')
    assert.equal(err.retryAfterMs, undefined)
    const state = rig.transport.state()
    assert.equal(state.hasSession, false, 'a stopped dial kept its session')
    // A dial cancelled by stop() says nothing about the room: not counted, and
    // no backoff for the next visitor to run into.
    assert.equal(state.consecutiveStartFailures, 0)
    assert.equal(state.nextDialInMs, 0)
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.end).length, 1, 'the session was ended twice')

    await rig.transport.start(handlers)
    assert.deepEqual(
      rig.gateway.calls.map((call) => call.path),
      [OPEN_LIVE_PATHS.start, OPEN_LIVE_PATHS.end, OPEN_LIVE_PATHS.start],
      'the next start heartbeated a session that stop() had already ended',
    )
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
    await stalled.close()
  }
})

test('a dial that was stopped does not reach into the session a later start opened', async () => {
  // The connect timer outlives stop() by up to connectTimeoutMs — 30s in
  // production — and a new visitor can open and authenticate a session inside
  // that window. When the old timer fires it must not close the new socket
  // (that would deafen it silently: its handlers go with it) nor end the new
  // session from its failure path.
  let arrived
  const upgraded = new Promise((resolve) => {
    arrived = resolve
  })
  const stalled = await startStalledServer({ onUpgrade: () => arrived() })
  let starts = 0
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => {
      if (call.path !== OPEN_LIVE_PATHS.start) return null
      starts += 1
      return startAnswer(starts === 1 ? stalled.url : wssUrl, { gameId: `game-000${starts}` })
    },
    transport: { connectTimeoutMs: STALL_MS },
  })
  const heard = []
  const disconnects = []
  try {
    const stale = rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {} }).then(
      () => null,
      (err) => err,
    )
    await upgraded
    await rig.transport.stop()
    await rig.transport.start({ onDanmaku: (d) => heard.push(d), onDisconnect: (info) => disconnects.push(info) })
    assert.equal(rig.transport.state().authenticated, true)

    const err = await stale // the old connect timer has now fired
    assert.match(err.message, /did not authenticate within 300ms/)
    assert.notEqual(err.retryable, true, 'a dial nobody is waiting for asked to be retried')
    await new Promise((resolve) => setTimeout(resolve, 50))

    const state = rig.transport.state()
    assert.equal(state.authenticated, true, "the stale dial's timer closed the live socket")
    assert.equal(state.hasSession, true)
    // Nor does it count against the live session or gate the next dial: had it
    // been taken for a timeout of the LIVE session, that session would now be
    // marked as held for a redial, and a reconnect would be refused for 1s.
    assert.equal(state.consecutiveStartFailures, 0)
    assert.equal(state.nextDialInMs, 0)
    assert.deepEqual(
      rig.gateway.callsTo(OPEN_LIVE_PATHS.end).map((call) => call.body.game_id),
      ['game-0001'],
      "the stale dial's failure path ended the live session",
    )
    assert.deepEqual(disconnects, [])
    rig.connections[0].send(danmakuPacket({ openId: 'open-live', uname: 'Live', msg: 'JOI-LIVE' }))
    await until(() => heard.length === 1, 'a danmaku on the live socket')
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
    await stalled.close()
  }
})

// ---------------------------------------------------------------------------
// a stop() that lands while /v2/app/start is answering (JOI-BUTTON-STORY-121)
//
// The stop runs while the platform is still opening the session, so there is
// no `session` yet and it ends nothing; the session the answer opens a moment
// later belongs to a start nobody is waiting for any more. In production that
// is a deploy: SIGTERM stops the source while a visitor's start is in flight.
// Dialling that session would leave a socket listening for nobody until the
// platform reaps it for want of a project heartbeat, or until the next
// visitor's start ends it and walks into the 7001 cooldown. The lifecycle
// cannot close it either: the stop has already settled its race, so its
// clean-up for a start that turns ready late never runs.

test('a stop() that lands while /v2/app/start is answering ends the session that answer opened, never dials it, and holds nothing against the next start', async () => {
  let answer
  const answerHeld = new Promise((resolve) => {
    answer = resolve
  })
  let starts = 0
  const rig = await wiredTransport({
    gatewayHandler: async (call, wssUrl) => {
      if (call.path !== OPEN_LIVE_PATHS.start) return null
      starts += 1
      if (starts === 1) await answerHeld
      return startAnswer(wssUrl, { gameId: `game-000${starts}` })
    },
  })
  const dials = []
  const handlers = { onDanmaku: () => {}, onDisconnect: () => {}, onDial: (record) => dials.push(record) }
  try {
    const outcome = rig.transport.start(handlers).then(
      () => null,
      (err) => err,
    )
    await until(() => rig.gateway.callsTo(OPEN_LIVE_PATHS.start).length === 1, 'the /v2/app/start request')
    await rig.transport.stop()
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.end).length, 0, 'stop() ended a session the platform had not opened yet')
    answer()

    const err = await outcome
    assert.ok(err instanceof OpenPlatformError, 'a start that a stop overtook went on to dial as if someone still held it')
    assert.match(err.message, /stopped before \/v2\/app\/start had answered/)
    assert.match(err.message, /not dialling/)
    assert.notEqual(err.retryable, true, 'a start nobody is waiting for asked to be retried')
    assert.deepEqual(
      rig.gateway.calls.map((call) => call.path),
      [OPEN_LIVE_PATHS.start, OPEN_LIVE_PATHS.end],
      'the session that answer opened was left running on the platform',
    )
    assert.deepEqual(rig.gateway.callsTo(OPEN_LIVE_PATHS.end)[0].body, {
      app_id: CREDENTIALS.appId,
      game_id: 'game-0001',
    })
    assert.equal(rig.connections.length, 0, 'a session nobody holds was dialled')
    assert.deepEqual(dials, [], 'a start that never dialled reported a dial')
    const state = rig.transport.state()
    assert.equal(state.hasSession, false, 'the cancelled start kept its session')
    // Cancelled by a stop, so it says nothing about the room: not counted, and
    // no backoff for the next visitor to run into.
    assert.equal(state.consecutiveStartFailures, 0)
    assert.equal(state.nextDialInMs, 0)

    // The clock is NOT moved: had the cancellation armed the backoff, the gate
    // would refuse this start outright.
    await rig.transport.start(handlers)
    assert.equal(rig.transport.state().authenticated, true)
    assert.deepEqual(
      rig.gateway.calls.map((call) => call.path),
      [OPEN_LIVE_PATHS.start, OPEN_LIVE_PATHS.end, OPEN_LIVE_PATHS.start],
    )
    assert.equal(dials.length, 1)
    assert.equal(dials[0].outcome, 'ok')
    assert.equal(dials[0].attempt, 1, 'the cancelled start was counted as a failed dial')
  } finally {
    answer()
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test("a stop() that lands while /v2/app/start is answering for a held session's replacement ends that replacement too, and never dials it", async () => {
  const stalled = await startStalledServer()
  let answer
  const answerHeld = new Promise((resolve) => {
    answer = resolve
  })
  let starts = 0
  const rig = await wiredTransport({
    gatewayHandler: async (call, wssUrl) => {
      if (call.path === OPEN_LIVE_PATHS.start) {
        starts += 1
        if (starts === 2) await answerHeld
        return startAnswer([stalled.url, wssUrl], { gameId: `game-000${starts}` })
      }
      if (call.path === OPEN_LIVE_PATHS.heartbeat) return { status: 200, json: { code: 7003, message: 'closed' } }
      return null
    },
    transport: { connectTimeoutMs: STALL_MS },
  })
  const handlers = { onDanmaku: () => {}, onDisconnect: () => {} }
  try {
    await assert.rejects(() => rig.transport.start(handlers), (err) => err.retryable === true)
    rig.clock.advance(1_250) // what the lifecycle waits before it redials
    const outcome = rig.transport.start(handlers).then(
      () => null,
      (err) => err,
    )
    // The held session has been heartbeated (7003) and ended by the time this
    // arrives: the second /v2/app/start is only sent once that end answered.
    await until(() => rig.gateway.callsTo(OPEN_LIVE_PATHS.start).length === 2, 'the second /v2/app/start request')
    await rig.transport.stop()
    answer()

    const err = await outcome
    assert.ok(err instanceof OpenPlatformError, 'the replacement session was dialled after the stop')
    assert.match(err.message, /stopped before \/v2\/app\/start had answered/)
    assert.match(err.message, /not dialling/)
    assert.notEqual(err.retryable, true, 'a start nobody is waiting for asked to be retried')
    assert.deepEqual(
      rig.gateway.calls.map((call) => call.path),
      [
        OPEN_LIVE_PATHS.start,
        OPEN_LIVE_PATHS.heartbeat,
        OPEN_LIVE_PATHS.end,
        OPEN_LIVE_PATHS.start,
        OPEN_LIVE_PATHS.end,
      ],
      'the replacement session was left running on the platform',
    )
    assert.deepEqual(
      rig.gateway.callsTo(OPEN_LIVE_PATHS.end).map((call) => call.body),
      [
        { app_id: CREDENTIALS.appId, game_id: 'game-0001' },
        { app_id: CREDENTIALS.appId, game_id: 'game-0002' },
      ],
    )
    assert.equal(stalled.upgrades(), 1)
    assert.equal(rig.connections.length, 0, 'the replacement session was dialled')
    assert.equal(rig.transport.state().hasSession, false, 'the cancelled start kept its session')
  } finally {
    answer()
    await rig.transport.stop().catch(() => {})
    await rig.close()
    await stalled.close()
  }
})

// ---------------------------------------------------------------------------
// one record per dial (JOI-BUTTON-STORY-118)
//
// Before this, a failed dial left one warn with no host and no phase, and a
// dial that succeeded on a retry left nothing at all, so the failure rate MIN-013
// D2 has to judge was invisible. Every dial now ends in one record of five keys
// — host, phase, elapsedMs, attempt, outcome — handed to the caller's onDial
// and, on failure, carried by the error as err.dial. These cases hold its shape
// and, as much as its shape, what it must never carry.

const DIAL_KEYS = ['attempt', 'elapsedMs', 'host', 'outcome', 'phase']

function portOf(url) {
  return new URL(url).port
}

test('a dial that never completes the websocket handshake is reported once: connecting, timeout, and err.dial is that record', async () => {
  let rig = null
  // The injected clock moves while the dial is in flight, so elapsedMs is
  // provably measured across the dial on that clock.
  const stalled = await startStalledServer({ onUpgrade: () => rig.clock.advance(1_234) })
  rig = await wiredTransport({
    gatewayHandler: (call) => (call.path === OPEN_LIVE_PATHS.start ? startAnswer([stalled.url]) : null),
    transport: { connectTimeoutMs: STALL_MS },
  })
  const records = []
  try {
    await assert.rejects(
      () => rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {}, onDial: (r) => records.push(r) }),
      (err) => {
        assert.equal(records.length, 1, 'a dial was reported more or less than once')
        assert.deepEqual(records[0], {
          host: `127.0.0.1:${stalled.port}`,
          phase: 'connecting',
          elapsedMs: 1_234,
          attempt: 1,
          outcome: 'timeout',
        })
        assert.equal(err.dial, records[0], 'the error does not carry the record the caller was given')
        assert.match(err.message, /did not authenticate within 300ms \(phase: connecting\)/)
        return true
      },
    )
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
    await stalled.close()
  }
})

test('a dial that handshakes but never hears AUTH_REPLY is reported as awaiting-auth-reply', async () => {
  const rig = await wiredTransport({ onConnection: () => {}, transport: { connectTimeoutMs: STALL_MS } })
  const records = []
  try {
    await assert.rejects(
      () => rig.transport.start({ onDanmaku: () => {}, onDisconnect: () => {}, onDial: (r) => records.push(r) }),
      (err) => {
        assert.equal(err.dial, records[0])
        assert.match(err.message, /\(phase: awaiting-auth-reply\)/)
        return true
      },
    )
    assert.equal(records.length, 1)
    assert.equal(
      records[0].phase,
      'awaiting-auth-reply',
      'a server that let us in and said nothing read as a slow network',
    )
    assert.equal(records[0].outcome, 'timeout')
    assert.equal(records[0].host, `127.0.0.1:${portOf(rig.ws.url)}`)
    assert.notEqual(rig.connections[0].authBody, null, 'the auth packet was never sent, so nothing was awaited')
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('a successful dial and an auth rejection are each reported once, from awaiting-auth-reply', async () => {
  const ok = await wiredTransport()
  const okRecords = []
  try {
    await ok.transport.start({ onDanmaku: () => {}, onDisconnect: () => {}, onDial: (r) => okRecords.push(r) })
    assert.equal(okRecords.length, 1)
    const { elapsedMs, ...rest } = okRecords[0]
    assert.deepEqual(rest, {
      host: `127.0.0.1:${portOf(ok.ws.url)}`,
      phase: 'awaiting-auth-reply',
      attempt: 1,
      outcome: 'ok',
    })
    assert.ok(Number.isInteger(elapsedMs) && elapsedMs >= 0, `elapsedMs ${elapsedMs} is not a non-negative integer`)

    // Traffic after the dial is not another dial.
    ok.connections[0].send(danmakuPacket({ openId: 'open-after', uname: 'After', msg: 'JOI-AFTR' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(okRecords.length, 1)
  } finally {
    await ok.transport.stop().catch(() => {})
    await ok.close()
  }

  const rejected = await wiredTransport({ onConnection: rejectingAuth })
  const rejectedRecords = []
  try {
    await assert.rejects(
      () =>
        rejected.transport.start({
          onDanmaku: () => {},
          onDisconnect: () => {},
          onDial: (r) => rejectedRecords.push(r),
        }),
      (err) => {
        assert.match(err.message, /rejected our auth packet \(code -101\)/)
        assert.equal(err.dial, rejectedRecords[0])
        return true
      },
    )
    assert.equal(rejectedRecords.length, 1)
    assert.equal(rejectedRecords[0].outcome, 'auth-rejected')
    assert.equal(rejectedRecords[0].phase, 'awaiting-auth-reply')
  } finally {
    await rejected.transport.stop().catch(() => {})
    await rejected.close()
  }
})

for (const [what, onConnection] of [
  ['closes', closingBeforeAuth],
  ['drops', droppingBeforeAuth],
]) {
  test(`a socket that ${what} before auth is reported once, with the outcome its error names`, async () => {
    const rig = await wiredTransport({ onConnection, transport: { connectTimeoutMs: 2_000 } })
    const records = []
    try {
      const err = await rig.transport
        .start({ onDanmaku: () => {}, onDisconnect: () => {}, onDial: (r) => records.push(r) })
        .then(
          () => null,
          (e) => e,
        )
      assert.ok(err instanceof Error)
      assert.equal(records.length, 1)
      assert.equal(err.dial, records[0])
      // Which of error and close undici delivers first is its business; the
      // record and the message must agree on it.
      const expected = {
        'socket-closed': /closed before authenticating/,
        'socket-error': /errored before authenticating/,
      }
      assert.ok(records[0].outcome in expected, `unexpected outcome ${records[0].outcome}`)
      assert.match(err.message, expected[records[0].outcome])
      assert.equal(records[0].phase, 'awaiting-auth-reply')
    } finally {
      await rig.transport.stop().catch(() => {})
      await rig.close()
    }
  })
}

test('a wss_link the runtime cannot parse is still one dial, reported as a socket error', async () => {
  const rig = await wiredTransport({
    gatewayHandler: (call) => (call.path === OPEN_LIVE_PATHS.start ? startAnswer(['not a websocket url']) : null),
  })
  const records = []
  try {
    const err = await rig.transport
      .start({ onDanmaku: () => {}, onDisconnect: () => {}, onDial: (r) => records.push(r) })
      .then(
        () => null,
        (e) => e,
      )
    assert.ok(err instanceof Error, 'a dial to an unparseable address succeeded')
    assert.equal(records.length, 1)
    assert.deepEqual(
      { ...records[0], elapsedMs: 0 },
      { host: 'unparseable', phase: 'connecting', elapsedMs: 0, attempt: 1, outcome: 'socket-error' },
    )
    assert.equal(err.dial, records[0])
    assert.equal(rig.gateway.callsTo(OPEN_LIVE_PATHS.end).length, 1, 'the session was left running')
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
  }
})

test('a redial on the held session is the second record: attempts 1 and 2, each on its own host', async () => {
  const stalled = await startStalledServer()
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => (call.path === OPEN_LIVE_PATHS.start ? startAnswer([stalled.url, wssUrl]) : null),
    transport: { connectTimeoutMs: STALL_MS },
  })
  const records = []
  const handlers = { onDanmaku: () => {}, onDisconnect: () => {}, onDial: (r) => records.push(r) }
  try {
    await assert.rejects(() => rig.transport.start(handlers), (err) => err.retryable === true)
    rig.clock.advance(1_250)
    await rig.transport.start(handlers)
    assert.deepEqual(
      records.map(({ elapsedMs, ...rest }) => rest),
      [
        { host: `127.0.0.1:${stalled.port}`, phase: 'connecting', attempt: 1, outcome: 'timeout' },
        { host: `127.0.0.1:${portOf(rig.ws.url)}`, phase: 'awaiting-auth-reply', attempt: 2, outcome: 'ok' },
      ],
    )
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
    await stalled.close()
  }
})

test('no dial record and no err.dial carries a credential, the auth body, or anything of the wss_link but host and port', async () => {
  // Every outcome a record can have in practice, from one transport: a
  // timeout, a refused redial on the held session, and a fresh session that
  // authenticates. The wss_links carry a query, as nothing promises they never
  // will, and the record must not.
  const stalled = await startStalledServer()
  let answered = 0
  let starts = 0
  const rig = await wiredTransport({
    gatewayHandler: (call, wssUrl) => {
      if (call.path !== OPEN_LIVE_PATHS.start) return null
      starts += 1
      const links = starts === 1 ? [stalled.url, wssUrl] : [wssUrl]
      return startAnswer(
        links.map((link) => `${link}?key=wss-query-secret`),
        { gameId: `game-000${starts}` },
      )
    },
    onConnection: (conn) => {
      answered += 1
      if (answered === 1) rejectingAuth(conn)
      else defaultAuth(conn)
    },
    transport: { connectTimeoutMs: STALL_MS },
  })
  const records = []
  const errors = []
  const handlers = { onDanmaku: () => {}, onDisconnect: () => {}, onDial: (r) => records.push(r) }
  const attempt = () =>
    rig.transport.start(handlers).catch((err) => {
      errors.push(err)
    })
  try {
    await attempt() // stalls: timeout, session held
    rig.clock.advance(1_250)
    await attempt() // redial on the held session: auth rejected, session ended
    rig.clock.advance(2_250)
    await attempt() // a fresh session: ok
    assert.deepEqual(
      records.map((r) => r.outcome),
      ['timeout', 'auth-rejected', 'ok'],
    )
    assert.equal(errors.length, 2)
    assert.deepEqual(
      errors.map((err) => err.dial),
      records.slice(0, 2),
    )

    const forbidden = [
      CREDENTIALS.accessKeyId,
      CREDENTIALS.accessKeySecret,
      CREDENTIALS.roomOwnerAuthCode,
      'auth-token', // inside auth_body
      '/sub', // the wss_link path
      'wss-query-secret', // the wss_link query
      'game-000', // the game session
    ]
    for (const record of [...records, ...errors.map((err) => err.dial)]) {
      assert.deepEqual(Object.keys(record).sort(), DIAL_KEYS, 'a dial record grew a key')
      assert.ok(Object.isFrozen(record), 'a dial record can be edited by whoever logs it')
      const text = JSON.stringify(record)
      for (const secret of forbidden) {
        assert.equal(text.includes(secret), false, `a dial record carries ${secret}: ${text}`)
      }
    }
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
    await stalled.close()
  }
})

test('dialHost writes out the port and never the path, the query, or userinfo', () => {
  assert.equal(
    dialHost('wss://zj-cn-live-comet.chat.bilibili.com:2245/sub?token=abc'),
    'zj-cn-live-comet.chat.bilibili.com:2245',
  )
  // new URL() drops a default port; the record writes it back, so 443 and 2245
  // dials of the same host are told apart the same way in every log line.
  assert.equal(dialHost('wss://broadcastlv.chat.bilibili.com:443/sub'), 'broadcastlv.chat.bilibili.com:443')
  assert.equal(dialHost('wss://broadcastlv.chat.bilibili.com/sub'), 'broadcastlv.chat.bilibili.com:443')
  assert.equal(dialHost('ws://127.0.0.1/sub'), '127.0.0.1:80')
  assert.equal(dialHost('ws://user:pass@127.0.0.1:9/sub'), '127.0.0.1:9')
  assert.equal(dialHost('not a websocket url'), 'unparseable')
})

test('a dial that a stop() overtakes still reports to the onDial it was started with, and a throwing onDial changes nothing', async () => {
  let arrived
  const upgraded = new Promise((resolve) => {
    arrived = resolve
  })
  const stalled = await startStalledServer({ onUpgrade: () => arrived() })
  const rig = await wiredTransport({
    gatewayHandler: (call) => (call.path === OPEN_LIVE_PATHS.start ? startAnswer([stalled.url]) : null),
    transport: { connectTimeoutMs: STALL_MS },
  })
  const records = []
  try {
    const outcome = rig.transport
      .start({
        onDanmaku: () => {},
        onDisconnect: () => {},
        onDial: (r) => {
          records.push(r)
          throw new Error('onDial-boom')
        },
      })
      .then(
        () => null,
        (err) => err,
      )
    await upgraded
    await rig.transport.stop() // nulls the handlers; the dial is still running
    assert.equal(records.length, 0)

    const err = await outcome
    assert.equal(records.length, 1, 'the record of a dial that a stop overtook went nowhere')
    assert.equal(records[0].outcome, 'cancelled', 'a dial stop() cancelled was counted as a network timeout')
    assert.equal(records[0].phase, 'connecting')
    assert.equal(err.dial, records[0])
    // Its own error, not the callback's.
    assert.match(err.message, /did not authenticate within 300ms/)
  } finally {
    await rig.transport.stop().catch(() => {})
    await rig.close()
    await stalled.close()
  }

  // A throwing onDial on a dial that succeeds: still listening, and the fault
  // is reported on the next heartbeat rather than swallowed.
  const ok = await wiredTransport()
  try {
    await ok.transport.start({
      onDanmaku: () => {},
      onDisconnect: () => {},
      onDial: () => {
        throw new Error('onDial-boom')
      },
    })
    assert.equal(ok.transport.state().authenticated, true, 'a throwing onDial undid a dial that worked')
    assert.equal(ok.transport.state().deferredErrors, 1)
    assert.throws(() => ok.transport.heartbeat(), /onDial callback failed \(onDial-boom\)/)
  } finally {
    await ok.transport.stop().catch(() => {})
    await ok.close()
  }

  // An async onDial that rejects: absorbed the same way, never an unhandled
  // rejection (which on Node takes the process down).
  const later = await wiredTransport()
  try {
    await later.transport.start({
      onDanmaku: () => {},
      onDisconnect: () => {},
      onDial: async () => {
        throw new Error('onDial-async-boom')
      },
    })
    await until(() => later.transport.state().deferredErrors === 1, 'the rejected onDial to be deferred')
    assert.equal(later.transport.state().authenticated, true)
  } finally {
    await later.transport.stop().catch(() => {})
    await later.close()
  }
})
