// SPDX-License-Identifier: MIT
//
// JOI-BUTTON-STORY-118, JOI-BUTTON-MIN-013 D1: the room-dial timings this
// deployment actually runs with.
//
// The library defaults — a 5s connect timeout in lib/bili-transport.mjs, a 10s
// bound per dial in lib/danmaku-source.mjs — are what the transport and
// lifecycle suites are written against, and they stay. The change is deployment
// policy and lives in server/config.mjs, beside the linger JOI-BUTTON-INC-006
// put there for the same reason. So what this file asserts is the EFFECTIVE
// value: what loadConfig() returns for a production environment, merged over
// the library tables the way createBiliTransport and createDanmakuSource merge
// it. Reading config.danmaku.transport alone would pass with the merge broken;
// reading the library tables alone would pass with config.mjs untouched. The
// last test goes one step further and lets a real transport, built from the
// production danmaku section, show when it gives up on a handshake that never
// completes.
//
// envFile is null in every load. The default is deploy/runtime.env, the
// operator's real, git-ignored credentials file: a test must not read it, and
// must not answer differently because one happens to exist on this machine.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { CONFIG_EXTRA_REQUIREMENTS, ENV_SOURCES, loadConfig } from '../config.mjs'
import { createBiliTransport, OPEN_LIVE_PATHS, TRANSPORT_DEFAULTS } from '../lib/bili-transport.mjs'
import { createDanmakuSource, DANMAKU_DEFAULTS } from '../lib/danmaku-source.mjs'
import { assertSafeConfig } from '../lib/env-guard.mjs'

/** MIN-013 D1: the connect timeout production runs with. */
const RULED_CONNECT_TIMEOUT_MS = 30_000
/** MIN-013 D1: the start budget, unchanged by the ruling. */
const RULED_START_BUDGET_MS = 45_000
/** STORY-118: a connect timeout is retried one backoff step plus this much later. */
const REDIAL_MARGIN_MS = 250

/**
 * The environment the API pod runs with: the literal env of
 * deploy/k8s/api-deployment.yaml plus the names deploy/runtime.env.example
 * publishes for the Secret. Every credential here is a placeholder.
 */
function productionEnv(extra = {}) {
  return {
    NODE_ENV: 'production',
    PORT: '8080',
    HOST: '0.0.0.0',
    DATA_DIR: '/srv/shared',
    TRUST_PROXY: '1',
    CODE_TTL_MINUTES: '10',
    LOG_LEVEL: 'info',
    BILI_APP_ID: '1787439765162',
    BILI_ROOM_ID: '21484828',
    BILI_ACCESS_KEY_ID: 'access-key-id',
    BILI_ACCESS_KEY_SECRET: 'access-key-secret',
    BILI_ROOM_OWNER_AUTH_CODE: 'room-owner-auth-code',
    SESSION_SECRET: 's'.repeat(43),
    ADMIN_OPEN_IDS: '',
    DANMAKU_LINGER_SECONDS: '45',
    ...extra,
  }
}

/**
 * Load, then merge exactly as the runtime does — server.mjs hands config.danmaku
 * to createDanmakuSource unchanged, and:
 *
 *   lib/bili-transport.mjs   { ...TRANSPORT_DEFAULTS, ...config.transport },
 *                            with backoff merged one level down
 *   lib/danmaku-source.mjs   { ...DANMAKU_DEFAULTS, ...config.lifecycle }
 */
function effectiveDial(env = productionEnv()) {
  const { config } = loadConfig({ env, envFile: null })
  const section = config.danmaku
  return {
    section,
    transport: {
      ...TRANSPORT_DEFAULTS,
      ...(section.transport ?? {}),
      backoff: { ...TRANSPORT_DEFAULTS.backoff, ...(section.transport?.backoff ?? {}) },
    },
    lifecycle: { ...DANMAKU_DEFAULTS, ...(section.lifecycle ?? {}) },
  }
}

test('production dials with a 30s connect timeout, a per-dial bound above the transport’s own, and the 45s budget', () => {
  const { transport, lifecycle } = effectiveDial()

  assert.equal(transport.connectTimeoutMs, RULED_CONNECT_TIMEOUT_MS)

  // The ruled floor: end the previous session, open a new one, connect.
  assert.ok(
    lifecycle.startTimeoutMs >= 2 * transport.requestTimeoutMs + transport.connectTimeoutMs,
    `startTimeoutMs ${lifecycle.startTimeoutMs} is below 2 x requestTimeoutMs + connectTimeoutMs`,
  )
  // And the path the ruling chose 45s for: a held session's heartbeat fails, so
  // heartbeat, end, start, connect. Below this the lifecycle's generic timeout
  // could reach the log ahead of the transport's own account of which stage
  // failed.
  assert.ok(
    lifecycle.startTimeoutMs >= 3 * transport.requestTimeoutMs + transport.connectTimeoutMs,
    `startTimeoutMs ${lifecycle.startTimeoutMs} does not cover heartbeat + end + start + connect`,
  )

  assert.equal(lifecycle.startBudgetMs, RULED_START_BUDGET_MS)
})

test('a first dial that hangs for the whole connect timeout still leaves the budget room to redial', () => {
  // The redial is the point of the ruling. If a hung first dial used the budget
  // up, the dial loop would refuse to wait and report the room unreachable —
  // the 2026-10-14 failure again, only 30s slower.
  const { transport, lifecycle } = effectiveDial()

  // The longest first dial that can still end in a connect timeout: end a
  // dropped session, open a new one, connect.
  const failedByMs = 2 * transport.requestTimeoutMs + transport.connectTimeoutMs
  const redialDueMs = failedByMs + transport.backoff.initialDelayMs + REDIAL_MARGIN_MS

  // danmaku-source's dial loop gives up when now + wait >= deadline.
  assert.ok(
    redialDueMs < lifecycle.startBudgetMs,
    `a redial due at ${redialDueMs}ms does not fit the ${lifecycle.startBudgetMs}ms start budget`,
  )
})

test('the connect timer ends a silent dial before the idle watchdog could', () => {
  // The watchdog is armed at onopen. Were it the shorter of the two, a socket
  // that opened and never answered the auth packet would be ended by the
  // watchdog, as a drop, while start() was still waiting.
  const { transport } = effectiveDial()

  assert.ok(
    transport.connectTimeoutMs < transport.wsIdleTimeoutMs,
    `connectTimeoutMs ${transport.connectTimeoutMs} is not below wsIdleTimeoutMs ${transport.wsIdleTimeoutMs}`,
  )
})

test('the library defaults are untouched: 30s is this deployment’s policy, not the transport’s', () => {
  assert.equal(TRANSPORT_DEFAULTS.connectTimeoutMs, 5_000)
  assert.equal(DANMAKU_DEFAULTS.startTimeoutMs, 10_000)
  assert.equal(DANMAKU_DEFAULTS.startBudgetMs, 45_000)
})

test('no environment variable reaches the dial timings', () => {
  // Nothing in the roster feeds them...
  const fed = Object.keys(ENV_SOURCES).filter((path) => /^danmaku\.(transport|lifecycle)\b/.test(path))
  assert.deepEqual(fed, [])

  // ...and a tripwire for the spellings a knob would most plausibly get. Not a
  // proof of the negative — the roster above and review are that — but none of
  // the likely names moves anything, and neither do the two tuning knobs that
  // do exist, which move their own values only.
  const stems = ['CONNECT_TIMEOUT', 'DIAL_TIMEOUT', 'START_TIMEOUT', 'START_BUDGET', 'REQUEST_TIMEOUT', 'WS_IDLE_TIMEOUT']
  const knobs = {}
  for (const prefix of ['', 'DANMAKU_', 'BILI_']) {
    for (const stem of stems) {
      for (const unit of ['', '_MS', '_SECONDS']) knobs[`${prefix}${stem}${unit}`] = '1'
    }
  }
  const noisy = productionEnv({ ...knobs, DANMAKU_LINGER_SECONDS: '0', CODE_TTL_MINUTES: '5' })

  const timings = ({ transport, lifecycle }) => ({
    connectTimeoutMs: transport.connectTimeoutMs,
    requestTimeoutMs: transport.requestTimeoutMs,
    wsIdleTimeoutMs: transport.wsIdleTimeoutMs,
    startTimeoutMs: lifecycle.startTimeoutMs,
    startBudgetMs: lifecycle.startBudgetMs,
  })
  assert.deepEqual(timings(effectiveDial(noisy)), timings(effectiveDial()))
})

test('the production boot path still clears and builds the danmaku section', () => {
  // server.mjs: loadConfig -> assertSafeConfig (which deep-freezes what it
  // clears) -> createDanmakuSource(config.danmaku). The transport section is new
  // in the config; nothing on that path may refuse it.
  const { config, env } = loadConfig({ env: productionEnv(), envFile: null })
  assertSafeConfig(config, {
    nodeEnv: config.nodeEnv,
    instanceMode: 'production',
    env,
    extraRequirements: CONFIG_EXTRA_REQUIREMENTS,
  })

  assert.equal(Object.isFrozen(config.danmaku.transport), true)
  const source = createDanmakuSource(config.danmaku)
  assert.equal(source.mode, 'production')
})

test('a transport built from the production danmaku section gives up on a silent handshake at 30s, not 5s', async (t) => {
  const { section } = effectiveDial()
  const danmakuServer = await silentDanmakuServer(t)
  const gateway = await fakeGateway(t, { wssUrl: danmakuServer.url, roomId: section.roomId })
  const clock = manualClock()

  // `section` is the object createProductionTransport hands to
  // createBiliTransport unchanged. Only the two documented test seams are added.
  const transport = createBiliTransport({ ...section, gatewayBaseUrl: gateway.baseUrl, clock })

  let outcome = null
  const started = transport
    .start({ onDanmaku() {}, onDisconnect() {}, onDial() {} })
    .then(
      () => {
        outcome = 'opened'
      },
      (err) => {
        outcome = err
      },
    )

  // The connect timer is armed in the tick the socket is created, so once the
  // upgrade request has arrived the clock can be moved.
  await until(() => danmakuServer.upgrades() === 1, 'the upgrade request')

  clock.advance(TRANSPORT_DEFAULTS.connectTimeoutMs)
  await settle()
  assert.equal(outcome, null, 'the dial was abandoned at the library default')

  clock.advance(RULED_CONNECT_TIMEOUT_MS - TRANSPORT_DEFAULTS.connectTimeoutMs - 1)
  await settle()
  assert.equal(outcome, null, 'the dial was abandoned before the ruled 30s')

  clock.advance(1)
  await until(() => outcome !== null, 'the dial to end at 30s')
  await started
  assert.ok(outcome instanceof Error, 'a handshake that never completes cannot open the room')

  // Ends whatever session the transport still holds, whichever way the timeout
  // left it.
  await transport.stop()
})

// --- fakes ------------------------------------------------------------------

/**
 * Hand-moved time AND hand-moved timers. The handshake below never completes,
 * so nothing real has to fire inside the transport; the connect timer is the
 * thing under test, and moving it by hand is what lets 30s pass in a few ms.
 */
function manualClock(startIso = '2026-10-14T13:06:24Z') {
  let nowMs = Date.parse(startIso)
  let nextId = 1
  const timers = new Map()
  const schedule = (fn, ms, every) => {
    const id = nextId++
    timers.set(id, { at: nowMs + Math.max(0, ms), fn, every })
    return id
  }
  return {
    now: () => new Date(nowMs),
    setTimeout: (fn, ms) => schedule(fn, ms, null),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, ms)),
    clearInterval: (id) => timers.delete(id),
    advance(ms) {
      const target = nowMs + ms
      for (;;) {
        let dueId = null
        let due = null
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.at)) {
            dueId = id
            due = timer
          }
        }
        if (due === null) break
        nowMs = due.at
        if (due.every === null) timers.delete(dueId)
        else due.at += due.every
        due.fn()
      }
      nowMs = target
    },
  }
}

/** A danmaku server that accepts the TCP connection and never answers the upgrade. */
async function silentDanmakuServer(t) {
  const held = new Set()
  let upgrades = 0
  const server = createServer((req, res) => {
    res.writeHead(426).end()
  })
  server.on('upgrade', (req, socket) => {
    upgrades += 1
    held.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => held.delete(socket))
  })
  const port = await listen(server)
  t.after(() => {
    for (const socket of held) socket.destroy()
    return shut(server)
  })
  return { url: `ws://127.0.0.1:${port}/sub`, upgrades: () => upgrades }
}

/** /v2/app/start offers the silent server; every other call answers code 0. */
async function fakeGateway(t, { wssUrl, roomId }) {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const answer =
        req.url === OPEN_LIVE_PATHS.start
          ? {
              code: 0,
              message: '0',
              request_id: 'req-start',
              data: {
                game_info: { game_id: 'game-0001' },
                websocket_info: {
                  auth_body: JSON.stringify({ key: 'placeholder', roomid: roomId }),
                  wss_link: [wssUrl],
                },
                anchor_info: { room_id: roomId },
              },
            }
          : { code: 0, message: '0', request_id: 'req-other', data: {} }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
    })
  })
  const port = await listen(server)
  t.after(() => shut(server))
  return { baseUrl: `http://127.0.0.1:${port}` }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

function shut(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

async function until(predicate, what, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Long enough for anything the clock just set off to finish over loopback. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50))
}
