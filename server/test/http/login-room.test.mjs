// SPDX-License-Identifier: MIT
//
// The room session, over HTTP: when a code may exist at all, what a visitor is
// told when our side cannot hear the room, and who keeps the socket open.
//
// The development transport is DRIVEN here — slow, hung, failing, dropping
// mid-wait. Every one of those knobs exists because some guard in the real
// implementation is unfalsifiable without it: "the code is not shown before the
// socket is listening" cannot fail against a source that is listening before you
// finish asking, and "never tell a visitor who did everything right that they
// did not send it" cannot fail against a source that never drops.

import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import { createApp, requestLogValue, sourceErrorLogFields } from '../../app.mjs'
import { OpenPlatformError } from '../../lib/bili-transport.mjs'
import { LOGIN_STATES, dialLogFields } from '../../routes/public.mjs'
import { VISITOR, boot, captureLog, cookieOf, get } from './harness.mjs'

// ---------------------------------------------------------------------------
// A code cannot exist while we are deaf

test('no code exists — on the wire or in the database — until the room session is really listening', async (t) => {
  const { app, db, clock, danmaku } = await boot(t)
  danmaku.control.setStartLatencyMs(3000)

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  const token = started.json().pollToken
  assert.equal(started.json().code, undefined)

  // Sampled across the whole opening window rather than at one convenient
  // instant. The claim is an INVARIANT — "a code is visible only while we are
  // listening" — so it is asserted at every observation, not at one.
  const observations = []
  for (let i = 0; i < 16; i += 1) {
    const body = (await get(app, `/api/login/status?token=${token}`, { cookie })).json()
    observations.push({
      listening: danmaku.status().listening,
      hasCode: typeof body.code === 'string',
      codeRows: db.prepare("SELECT count(*) AS n FROM verify_codes").get().n,
      state: body.state,
    })
    await clock.advance(250)
  }

  for (const [i, seen] of observations.entries()) {
    assert.equal(
      seen.hasCode && !seen.listening,
      false,
      `observation ${i}: a code was on the wire while the socket was not listening`,
    )
    assert.equal(
      seen.codeRows > 0 && !seen.listening && seen.state === LOGIN_STATES.PREPARING,
      false,
      `observation ${i}: a verify_codes row existed before the socket was listening`,
    )
  }
  // The two halves of the vacuity guard: without them this passes against a
  // source that never becomes ready AND against one that is ready instantly.
  assert.ok(
    observations.some((seen) => !seen.listening && !seen.hasCode && seen.state === LOGIN_STATES.PREPARING),
    'the window in which the guard could have been false was never entered',
  )
  assert.ok(observations.some((seen) => seen.hasCode && seen.listening), 'no code was ever issued at all')
})

test('a start that never becomes ready issues no code and ends as room-unreachable, not as waiting', async (t) => {
  const { app, db, clock, danmaku } = await boot(t)
  // The transport never settles; the lifecycle's own startTimeoutMs (10s) is
  // what ends it. Without the injected clock this case would cost ten real
  // seconds and get skipped.
  danmaku.control.setStartBehaviour('hang')

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  const token = started.json().pollToken

  for (const step of [1000, 4000, 4000]) {
    await clock.advance(step)
    const body = (await get(app, `/api/login/status?token=${token}`, { cookie })).json()
    assert.equal(body.state, LOGIN_STATES.PREPARING)
    assert.equal(body.code, undefined)
  }

  await clock.advance(2000) // past startTimeoutMs
  const dead = (await get(app, `/api/login/status?token=${token}`, { cookie })).json()
  assert.equal(dead.state, LOGIN_STATES.ROOM_UNREACHABLE)
  assert.equal(dead.code, undefined)
  assert.equal(dead.canAssertNotSeen, undefined, 'a deaf socket claimed it would have seen the danmaku')
  // Never our own error text: it is ours and can carry internals a visitor has
  // no business reading.
  assert.equal(dead.lastError, undefined)
  assert.equal(db.prepare('SELECT count(*) AS n FROM verify_codes').get().n, 0)
})

// ---------------------------------------------------------------------------
// room-unreachable is its own state

test('every way our side can be deaf is reported as room-unreachable, never as "you have not sent it yet"', async (t) => {
  const { app, clock, danmaku } = await boot(t)

  // (a) the room could not be reached at all: no code was ever issued.
  danmaku.control.setStartBehaviour('fail')
  const failed = await app.inject({ method: 'POST', url: '/api/login/start' })
  const failedCookie = cookieOf(failed)
  await clock.advance(1)
  const unreachable = (
    await get(app, `/api/login/status?token=${failed.json().pollToken}`, { cookie: failedCookie })
  ).json()
  assert.equal(unreachable.state, LOGIN_STATES.ROOM_UNREACHABLE)
  assert.equal(unreachable.canAssertNotSeen, undefined)
  assert.equal(unreachable.detail, 'unreachable')

  // (b) a code IS live and the socket drops underneath it.
  danmaku.control.setStartBehaviour('ready')
  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  await clock.advance(1)
  const read = async () => (await get(app, '/api/login/status', { cookie })).json()

  const live = await read()
  assert.equal(live.state, LOGIN_STATES.WAITING)
  assert.equal(live.canAssertNotSeen, true)
  const code = live.code

  danmaku.control.disconnect({ reason: 'simulated' })
  const down = await read()
  assert.equal(down.state, LOGIN_STATES.ROOM_UNREACHABLE, 'a deaf socket was reported as waiting')
  assert.equal(down.detail, 'reconnecting')
  assert.equal(down.canAssertNotSeen, undefined)
  // The code is NOT withdrawn: it is still valid, and taking it off the screen
  // makes the UI flicker for a reason that has nothing to do with the visitor.
  assert.equal(down.code, code)

  // (c) the reconnect itself fails: still deaf, still its own state.
  danmaku.control.setStartBehaviour('fail')
  await clock.advance(2000)
  const stillDown = await read()
  assert.equal(stillDown.state, LOGIN_STATES.ROOM_UNREACHABLE)
  assert.equal(stillDown.detail, 'source_failed')
  assert.equal(stillDown.canAssertNotSeen, undefined)

  // (d) recovered — and this is the case a UI most easily gets wrong. We ARE
  // listening now, and there was a window since the code was issued in which we
  // were not, so a danmaku sent during it is simply gone. That is not
  // room-unreachable and it is emphatically not "you have not sent it yet".
  danmaku.control.setStartBehaviour('ready')
  await clock.advance(2000)
  const recovered = await read()
  assert.equal(recovered.state, LOGIN_STATES.WAITING)
  assert.equal(recovered.canAssertNotSeen, false, 'a gap in our listening was reported as continuous')
  assert.equal(recovered.resend, true)
  assert.equal(recovered.code, code)

  // And the code still works, which is what makes `resend` an invitation rather
  // than a dead end.
  danmaku.control.emitDanmaku({ openId: VISITOR.openId, displayName: 'Viewer', text: code })
  assert.equal((await read()).state, LOGIN_STATES.VERIFIED)
})

// ---------------------------------------------------------------------------
// who keeps the socket open

test('two visitors share one socket: the first finishing does not tear it down, and the one who walked away lets it stop', async (t) => {
  const { app, db, clock, danmaku } = await boot(t)

  const first = await app.inject({ method: 'POST', url: '/api/login/start' })
  const second = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookieOne = cookieOf(first)
  const cookieTwo = cookieOf(second)
  assert.notEqual(cookieOne, cookieTwo, 'the second visitor was handed the first one\'s session')

  await clock.advance(1)
  const liveOne = (await get(app, '/api/login/status', { cookie: cookieOne })).json()
  const liveTwo = (await get(app, '/api/login/status', { cookie: cookieTwo })).json()
  assert.equal(liveOne.state, LOGIN_STATES.WAITING)
  assert.equal(liveTwo.state, LOGIN_STATES.WAITING)
  assert.notEqual(liveOne.code, liveTwo.code)

  // Two waiters, ONE socket. The source deduplicates the connection, not the
  // reference — and it is the reference count that decides the lifetime.
  assert.equal(danmaku.status().waiters, 2)
  assert.equal(danmaku.control.startCount(), 1, 'two visitors opened two sockets')
  assert.equal(danmaku.control.stopCount(), 0)

  // A third visitor arriving five minutes into an already-open socket gets their
  // OWN ten minutes: inheriting `listeningSince` would hand them five, and would
  // make the continuity answer read as true for a window they were never in.
  await clock.advance(5 * 60 * 1000)
  const third = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookieThree = cookieOf(third)
  await clock.advance(1)
  const liveThree = (await get(app, '/api/login/status', { cookie: cookieThree })).json()
  assert.equal(
    Date.parse(liveThree.issuedAt) - Date.parse(liveOne.issuedAt),
    5 * 60 * 1000,
    'a later visitor inherited an earlier visitor\'s clock',
  )
  assert.equal(liveThree.canAssertNotSeen, true)
  assert.equal(danmaku.status().waiters, 3)
  assert.equal(danmaku.control.startCount(), 1)

  // The first one finishes. Its lease goes back; the other two hold the socket.
  danmaku.control.emitDanmaku({ openId: 'open-one', displayName: 'One', text: liveOne.code })
  await clock.advance(1)
  assert.equal(
    (await get(app, '/api/login/status', { cookie: cookieOne })).json().state,
    LOGIN_STATES.VERIFIED,
  )
  assert.equal(danmaku.status().waiters, 2, 'a completed verification took more than its own lease')
  assert.equal(danmaku.status().listening, true, 'the socket closed while two visitors were still waiting')
  assert.equal(danmaku.control.stopCount(), 0)
  assert.equal(danmaku.control.isListening(), true)

  // The second one is still waiting, and nothing about the first one's success
  // shows up as a gap in their window.
  const stillWaiting = (await get(app, '/api/login/status', { cookie: cookieTwo })).json()
  assert.equal(stillWaiting.state, LOGIN_STATES.WAITING)
  assert.equal(stillWaiting.canAssertNotSeen, true)

  // Both remaining visitors walk away — no cancel, no logout, just a closed tab.
  // The ruled ten minutes are what bound this: a lease cannot outlive the code
  // it was taken for.
  await clock.advance(11 * 60 * 1000)
  assert.equal(danmaku.status().waiters, 0, 'a lease nobody released pinned the room session')
  assert.equal(danmaku.status().listening, false)
  assert.equal(danmaku.control.isListening(), false)
  assert.equal(danmaku.control.stopCount(), 1)

  const expired = (await get(app, '/api/login/status', { cookie: cookieTwo })).json()
  assert.equal(expired.state, LOGIN_STATES.EXPIRED)
  // v_room_demand is the derived reference count; a row left 'pending' would
  // make the view claim demand that no longer exists.
  assert.equal(db.prepare('SELECT count(*) AS n FROM v_room_demand').get().n, 0)
})

test('cancelling gives the socket back even while the start is still in flight', async (t) => {
  const { app, clock, danmaku } = await boot(t)
  danmaku.control.setStartLatencyMs(3000)

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cancelled = await app.inject({
    method: 'POST',
    url: '/api/login/cancel',
    headers: { cookie: cookieOf(started) },
  })
  assert.equal(cancelled.json().cancelled, true)

  await clock.advance(5000)
  // Without the abandoned check in the acquire continuation this lease is never
  // released and pins the room for its full TTL on behalf of nobody.
  assert.equal(danmaku.status().waiters, 0)
})

// ---------------------------------------------------------------------------
// every dial, one log line (JOI-BUTTON-STORY-118)
//
// Read through the real logger: captureLog() hands createApp pino options, so
// fastify builds the pino instance production gets, with production's
// serializers, and only the destination differs. What these cases read is what
// a production log line would carry.
//
// "Does not carry the poll token" is asserted of the dial lines and the final
// warn here, and of every line captured in the request-line cases at the end
// of this section: since JOI-BUTTON-STORY-120 the request line keeps method and
// path and drops the query string, so GET /api/login/status?token=… no longer
// puts the token in the log. A new case may assert it over everything.

const DIAL_KEYS = Object.freeze(['attempt', 'elapsedMs', 'host', 'outcome', 'phase'])
// pino's numeric levels, which is what lands in the line.
const INFO = 30
const WARN = 40
const ERROR = 50
// Everything pino puts on a line by itself, plus the two fields the final warn
// is allowed to add. Anything else at the top level is something the route
// chose to log, and nothing else was chosen.
const FINAL_WARN_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'err', 'dial'])

const linesSaying = (log, msg) => log.lines.filter((line) => line.msg === msg)

test('a dial that gets the room listening writes exactly one info line, "danmaku dial succeeded", carrying the five dial fields', async (t) => {
  const log = captureLog()
  const { app, clock } = await boot(t, { logger: log.logger })

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  assert.equal(started.statusCode, 200, started.payload)
  const { pollToken } = started.json()
  await clock.advance(1)

  const succeeded = linesSaying(log, 'danmaku dial succeeded')
  assert.equal(succeeded.length, 1, 'the dial that got the room listening was not logged exactly once')
  const [line] = succeeded
  assert.equal(line.level, INFO, 'a successful dial was logged below the level production runs at')
  assert.deepEqual(Object.keys(line.dial).sort(), DIAL_KEYS)
  assert.equal(line.dial.outcome, 'ok')
  assert.equal(linesSaying(log, 'danmaku dial failed').length, 0)
  assert.ok(!JSON.stringify(line).includes(pollToken), 'the dial line carries the visitor\'s poll token')
})

test('a dial that fails writes a warn line, and "the room session could not be opened" carries err and the same five fields', async (t) => {
  const log = captureLog()
  const { app, clock, danmaku } = await boot(t, { logger: log.logger })
  danmaku.control.setStartBehaviour('fail')

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  const { pollToken } = started.json()
  assert.equal(typeof pollToken, 'string')
  await clock.advance(1)

  // What the visitor is told has not moved; only the log has grown.
  const told = (await get(app, `/api/login/status?token=${pollToken}`, { cookie })).json()
  assert.equal(told.state, LOGIN_STATES.ROOM_UNREACHABLE)

  const failed = linesSaying(log, 'danmaku dial failed')
  assert.equal(failed.length, 1, 'the dial that failed was not logged exactly once')
  assert.equal(failed[0].level, WARN)
  assert.deepEqual(Object.keys(failed[0].dial).sort(), DIAL_KEYS)
  assert.notEqual(failed[0].dial.outcome, 'ok')

  // The message text is the one this warn has always had: it is what an
  // operator already searches for.
  const final = linesSaying(log, 'the room session could not be opened')
  assert.equal(final.length, 1, 'the final warn is missing, or its text has changed')
  assert.equal(final[0].level, WARN)
  assert.match(final[0].err.message, /simulated start failure/, 'the final warn lost the error that ended the start')
  assert.deepEqual(final[0].dial, failed[0].dial, 'the final warn does not name the dial that ended the start')

  for (const line of [...failed, final[0]]) {
    const text = JSON.stringify(line)
    assert.ok(!text.includes(pollToken), `"${line.msg}" carries the visitor's poll token`)
    assert.ok(!/auth_?body/i.test(text), `"${line.msg}" carries an auth body`)
  }
  const extra = Object.keys(final[0]).filter((key) => !FINAL_WARN_KEYS.has(key))
  assert.deepEqual(extra, [], 'the final warn logs fields beyond err and dial')
})

test('a dial record reaches a log line as five named fields and nothing else, whatever the transport put beside them', () => {
  // The transport is supposed to build its record from these five. This is the
  // case for the day it does not: everything below that is not one of the five
  // is something a log must never carry.
  const poisoned = {
    host: 'broadcastlv.chat.bilibili.com:443',
    phase: 'awaiting-auth-reply',
    elapsedMs: 30_000,
    attempt: 2,
    outcome: 'timeout',
    auth_body: '{"roomid":3622717,"key":"secret-auth-key"}',
    accessKeySecret: 'secret-access-key',
    pollToken: 'secret-poll-token',
    url: 'wss://broadcastlv.chat.bilibili.com:443/sub?token=secret-url-token',
  }
  const fields = dialLogFields(poisoned)
  assert.deepEqual(fields, {
    host: 'broadcastlv.chat.bilibili.com:443',
    phase: 'awaiting-auth-reply',
    elapsedMs: 30_000,
    attempt: 2,
    outcome: 'timeout',
  })
  assert.doesNotMatch(JSON.stringify(fields), /secret/)

  // Copied by name is not enough on its own: an object under an allowed name
  // would carry its contents straight past the whitelist.
  const nested = dialLogFields({ ...poisoned, host: { name: 'broadcastlv', auth_body: 'secret-nested' } })
  assert.equal(nested.host, null)
  assert.doesNotMatch(JSON.stringify(nested), /secret/)

  // Every line has all five keys; a missing one reads null, not absent.
  assert.deepEqual(dialLogFields({ outcome: 'ok' }), {
    host: null,
    phase: null,
    elapsedMs: null,
    attempt: null,
    outcome: 'ok',
  })
  assert.equal(dialLogFields(undefined), null)
  assert.equal(dialLogFields(null), null)
  assert.equal(dialLogFields('broadcastlv.chat.bilibili.com:443'), null)
})

test('a closed app writes no more dial lines: the dial subscription leaves with the plugin', async (t) => {
  const log = captureLog()
  const { app, clock, danmaku } = await boot(t, { logger: log.logger })
  const logged = () => linesSaying(log, 'danmaku dial succeeded').length

  // Live first, so that the silence below means something: a dial the source
  // makes while the app is up does reach the log.
  const before = danmaku.acquire()
  await clock.advance(1)
  danmaku.release((await before).leaseId)
  await clock.advance(1)
  assert.equal(logged(), 1, 'the subscription was never live, so its removal would prove nothing')

  await app.close()

  const after = danmaku.acquire()
  await clock.advance(1)
  danmaku.release((await after).leaseId)
  await clock.advance(1)
  assert.equal(danmaku.control.startCount(), 2, 'the source never dialled again, so the silence proves nothing')
  assert.equal(logged(), 1, 'a closed app went on logging the source\'s dials')
})

// The request line itself (JOI-BUTTON-STORY-120). fastify writes one "incoming
// request" line per request, and its default puts req.url in whole — for a
// visitor's poll that is the poll token, once per poll. createApp hands fastify
// requestLogValue as the `req` serializer instead: method and path, the query
// string cut off, every other key as fastify writes it.

test('a visitor\'s poll is logged as GET /api/login/status, and the poll token is on no line at all', async (t) => {
  const log = captureLog()
  const { app, clock } = await boot(t, { logger: log.logger })

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  assert.equal(started.statusCode, 200, started.payload)
  const cookie = cookieOf(started)
  const { pollToken } = started.json()
  assert.equal(typeof pollToken, 'string')
  await clock.advance(1)

  const polled = await get(app, `/api/login/status?token=${pollToken}`, { cookie })
  assert.equal(polled.statusCode, 200, polled.payload)

  const incoming = linesSaying(log, 'incoming request').filter((line) => line.req.method === 'GET')
  assert.equal(incoming.length, 1, 'the poll did not write exactly one request line')
  const [line] = incoming
  assert.equal(line.level, INFO, 'the request line left the level production runs at')
  assert.equal(line.req.url, '/api/login/status')

  // Its pair is untouched: the same request, the same level, the same text.
  const completed = linesSaying(log, 'request completed').filter((done) => done.reqId === line.reqId)
  assert.equal(completed.length, 1, 'the poll\'s "request completed" line is missing, or its text has changed')
  assert.equal(completed[0].level, INFO)
  assert.equal(completed[0].res.statusCode, 200)

  for (const [i, each] of log.lines.entries()) {
    assert.ok(!JSON.stringify(each).includes(pollToken), `line ${i} ("${each.msg}") carries the visitor's poll token`)
  }
})

test('every request line keeps method and path and loses the query string, whichever route it reached, or none', async (t) => {
  const log = captureLog()
  const { app } = await boot(t, { logger: log.logger })
  const secret = 'secret-query-token'

  await get(app, `/api/my/submissions?limit=5&token=${secret}`)
  const nowhere = await get(app, `/api/no-such-route?x=1&token=${secret}`)
  assert.equal(nowhere.statusCode, 404, nowhere.payload)

  const incoming = linesSaying(log, 'incoming request')
  assert.deepEqual(
    incoming.map((line) => [line.level, line.req.method, line.req.url]),
    [
      [INFO, 'GET', '/api/my/submissions'],
      [INFO, 'GET', '/api/no-such-route'],
    ],
  )
  for (const [i, each] of log.lines.entries()) {
    assert.ok(!JSON.stringify(each).includes(secret), `line ${i} ("${each.msg}") carries a query-string token`)
  }

  // Everything but the url is what fastify itself writes: the same request
  // through a bare fastify, default serializer and all. That line does carry
  // the token, which is the other half of the proof — without it, a fastify
  // that had stopped logging query strings would let this case pass on its own.
  const plain = captureLog()
  const bare = Fastify({ logger: plain.logger })
  t.after(() => bare.close())
  await bare.inject({ method: 'GET', url: `/api/my/submissions?limit=5&token=${secret}` })
  const [fastifyDefault] = linesSaying(plain, 'incoming request')
  assert.ok(JSON.stringify(fastifyDefault.req).includes(secret), 'fastify\'s own request line no longer carries the query string')
  assert.deepEqual(incoming[0].req, { ...fastifyDefault.req, url: '/api/my/submissions' })
})

test('requestLogValue is fastify\'s request value with the url cut at its first "?", and nothing else changed', () => {
  assert.deepEqual(
    requestLogValue({
      method: 'GET',
      url: '/api/login/status?token=secret-poll-token&next=?again',
      headers: { 'accept-version': '2.x' },
      host: 'api.joi.invalid',
      ip: '127.0.0.1',
      socket: { remotePort: 51234 },
    }),
    {
      method: 'GET',
      url: '/api/login/status',
      version: '2.x',
      host: 'api.joi.invalid',
      remoteAddress: '127.0.0.1',
      remotePort: 51234,
    },
  )

  // No Accept-Version and no socket: undefined, so absent from the written
  // line — as they are from fastify's own.
  const written = JSON.parse(JSON.stringify(requestLogValue({
    method: 'GET',
    url: '/api/healthz',
    headers: {},
    host: 'api.joi.invalid',
    ip: '127.0.0.1',
  })))
  assert.deepEqual(written, { method: 'GET', url: '/api/healthz', host: 'api.joi.invalid', remoteAddress: '127.0.0.1' })

  // A url that is not a string is passed on as it came, as fastify's would be.
  assert.equal(requestLogValue({ method: 'GET', headers: {} }).url, undefined)
})

// The source's own errors (JOI-BUTTON-STORY-120). What the source cannot hand
// back to a caller — a frame it could not read, a listener that threw — goes to
// its 'error' event, and createApp writes each one as a "danmaku source error"
// line, through sourceErrorLogFields so that only named fields reach it.

// Everything pino puts on a line by itself, plus err; and within err, pino's
// own `type` plus the six names sourceErrorLogFields copies.
const SOURCE_ERROR_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'err'])
const SOURCE_ERROR_ERR_KEYS = new Set(['type', 'name', 'message', 'stack', 'endpoint', 'status', 'platformCode'])

const sourceErrorLines = (log) => linesSaying(log, 'danmaku source error')

test('a danmaku the source cannot read is logged: exactly one error line, "danmaku source error", saying what was wrong', async (t) => {
  const log = captureLog()
  const { clock, danmaku } = await boot(t, { logger: log.logger })
  const lease = danmaku.acquire()
  await clock.advance(1)
  const { leaseId } = await lease

  // No open_id: normalizeDanmaku refuses it, and the source sends the refusal
  // to 'error' — there is no caller to return it to.
  danmaku.control.emitDanmaku({ openId: '', text: 'x' })
  danmaku.release(leaseId)
  assert.equal(danmaku.status().events.malformed, 1, 'the source never refused the danmaku, so the line below proves nothing')

  const lines = sourceErrorLines(log)
  assert.equal(lines.length, 1, 'the source\'s error was not logged exactly once')
  assert.equal(lines[0].level, ERROR)
  assert.match(lines[0].err.message, /open_id is missing/)
})

test('a source error reaches the log as named fields only, whatever the thrown value carried beside them', async (t) => {
  const log = captureLog()
  const { clock, danmaku } = await boot(t, { logger: log.logger })
  const lease = danmaku.acquire()
  await clock.advance(1)
  const { leaseId } = await lease

  // A listener that throws an error dressed in everything a log must never
  // carry. The source hands a listener's exception to 'error' rather than let
  // it escape, so this is a payload the subscription really can be given.
  const poisoned = Object.assign(new Error('a danmaku listener failed'), {
    authBody: 'secret-auth-body',
    auth_body: 'secret-auth_body',
    accessKeySecret: 'secret-access-key',
    pollToken: 'secret-poll-token',
    code: 'secret-identity-code',
    cause: { auth_body: 'secret-nested' },
    dial: { auth_body: 'secret-dial' },
  })
  const unsubscribe = danmaku.on('danmaku', () => {
    throw poisoned
  })
  danmaku.control.emitDanmaku({ openId: VISITOR.openId, displayName: VISITOR.displayName, text: 'hello' })
  unsubscribe()
  danmaku.release(leaseId)

  const lines = sourceErrorLines(log)
  assert.equal(lines.length, 1, 'the listener\'s exception was not logged exactly once')
  const [line] = lines
  assert.equal(line.level, ERROR)
  assert.equal(line.err.message, 'a danmaku listener failed')
  assert.doesNotMatch(JSON.stringify(line), /secret/)
  const errExtra = Object.keys(line.err).filter((key) => !SOURCE_ERROR_ERR_KEYS.has(key))
  assert.deepEqual(errExtra, [], 'err carries fields beyond the named ones')
  const extra = Object.keys(line).filter((key) => !SOURCE_ERROR_KEYS.has(key))
  assert.deepEqual(extra, [], 'the line carries fields beyond err')
  // pino's own `type` names the plain object it was handed; `name` is what
  // carries the class.
  assert.equal(line.err.name, 'Error')
})

test('a closed app writes no more source errors: the subscription leaves with the app', async (t) => {
  const log = captureLog()
  const { app, clock, danmaku } = await boot(t, { logger: log.logger })
  const logged = () => sourceErrorLines(log).length
  const lease = danmaku.acquire()
  await clock.advance(1)
  const { leaseId } = await lease

  // Live first, so that the silence below means something: an error the
  // source raises while the app is up does reach the log.
  danmaku.control.emitDanmaku({ openId: '', text: 'x' })
  assert.equal(logged(), 1, 'the subscription was never live, so its removal would prove nothing')

  await app.close()

  // The source is not the app's, so it is still listening on this lease.
  danmaku.control.emitDanmaku({ openId: '', text: 'x' })
  danmaku.release(leaseId)
  assert.equal(danmaku.status().events.malformed, 2, 'the source never errored again, so the silence proves nothing')
  assert.equal(logged(), 1, 'a closed app went on logging the source\'s errors')
})

test('a createApp that refuses its routes leaves no subscription behind on the source', async (t) => {
  const { clock, config, danmaku, db, report, storageGuard } = await boot(t)
  const log = captureLog()
  // A throwing createApp returns no app, so nothing could ever close one: a
  // subscription it made before throwing would outlive it.
  assert.throws(
    () => createApp({ config, db, danmaku, storageGuard, logger: log.logger, report, routes: ['not a plugin'] }),
    /every entry in `routes`/,
  )

  const lease = danmaku.acquire()
  await clock.advance(1)
  const { leaseId } = await lease
  danmaku.control.emitDanmaku({ openId: '', text: 'x' })
  danmaku.release(leaseId)
  assert.equal(danmaku.status().events.malformed, 1, 'the source never errored, so the silence proves nothing')
  assert.equal(sourceErrorLines(log).length, 0, 'the refused app left its subscription on the source')
})

test('sourceErrorLogFields copies six named fields, each only as the type it should be, and of anything else only its type', () => {
  const failure = new OpenPlatformError('bili gateway: POST /v2/app/start answered with platform code 7001', {
    endpoint: '/v2/app/start',
    status: 200,
    platformCode: 7001,
    requestId: 'gateway-request-1',
  })
  assert.deepEqual(sourceErrorLogFields(Object.assign(failure, { auth_body: 'secret-auth-body' })), {
    name: 'OpenPlatformError',
    message: 'bili gateway: POST /v2/app/start answered with platform code 7001',
    stack: failure.stack,
    endpoint: '/v2/app/start',
    status: 200,
    platformCode: 7001,
  })

  // Copied by name is not enough on its own: a value of the wrong kind under an
  // allowed name would carry its contents straight past the list.
  const disguised = sourceErrorLogFields({
    message: 'disguised',
    name: { auth_body: 'secret-name' },
    stack: ['secret-stack'],
    endpoint: { auth_body: 'secret-endpoint' },
    status: '500 secret-status',
    platformCode: Number.NaN,
  })
  assert.deepEqual(disguised, { message: 'disguised' })

  // Anything without a string message — a thrown string, nothing at all, an
  // object that only looks like trouble — is recorded as its type and no more.
  assert.deepEqual(sourceErrorLogFields('secret-thrown-string'), { type: 'string' })
  assert.deepEqual(sourceErrorLogFields(undefined), { type: 'undefined' })
  assert.deepEqual(sourceErrorLogFields(null), { type: 'object' })
  assert.deepEqual(sourceErrorLogFields({ reason: 'secret-reason', message: 42 }), { type: 'object' })
})
