// SPDX-License-Identifier: MIT
//
// The room's danmaku source: one shape, two implementations, and the on-demand
// lifecycle they share.
//
// Identity on this site comes from the owner's own live room. The site issues a
// one-time code, the visitor sends it as a danmaku, and this module is the thing
// that is listening when they do. There is no OAuth to fall back on, so the
// question "were we actually listening?" is not a diagnostic detail — it is the
// difference between "you have not sent it yet" and "we would not have seen it
// if you had".
//
// WHY THE DEVELOPMENT DOUBLE IS PROGRAMMABLE AND NOT MERELY FAKE.
// A double that is ready instantly and never drops makes two of the real
// implementation's guards vacuously true. "The code must not be shown before the
// socket is listening" cannot fail against a source that is listening before you
// finish asking; "never tell a visitor who did everything right that they are
// probably muted" cannot fail against a source that never disconnects. Both
// guards would sit there green forever, having never been evaluated in a world
// where they could be false. So the double can be told to be slow, to fail, to
// hang, and to drop mid-wait — those are the worlds those guards exist for.
//
// WHY THE PRODUCTION TRANSPORT THROWS AT CONSTRUCTION.
// STORY-010 owns the Open Platform protocol. Until it lands, constructing the
// production source fails at boot rather than at the first visitor. An API that
// starts happily and only discovers under load that it cannot verify anyone is
// strictly worse than one that refuses to start: the first fails in front of a
// person who did nothing wrong.
//
// WHAT THIS MODULE DOES AND DOES NOT TOUCH. It does not know what a code looks
// like and does not match anything — matching belongs to the caller, so `text`
// is handed over verbatim and a substituted character in it would simply fail
// to match the code we issued.
//
// `displayName` is the exception, and it is not an inconsistency. A Bilibili
// nickname is text we OBSERVE, not text anyone authored for us, and it ends up
// in a credit line that reaches vue-i18n — where "@:info.title" is a read of a
// message the submitter does not own. So it goes through escapeForI18n() here,
// on the way in, for the reason text-safety.mjs already argues at length for
// captions: mangling is the correct outcome for observed text. Doing it here
// rather than at each render site means there is one place to get it right
// instead of one place per consumer to forget.
//
// It also never writes to stdout: open_id is a stable pseudonymous handle for a
// real person and a log line is the cheapest way to leak one somewhere nobody
// is guarding.
//
// ---------------------------------------------------------------------------
// WHAT MAKES THIS GO RED
//
//   * Delete the clock.clearInterval in stopHeartbeat() — status().heartbeat.ticks
//     keeps rising after stop(), and the "a clean stop stops the heartbeat too,
//     not only the socket" case goes red. Note WHICH number that case reads:
//     ticks, counted before the call and counted even when the call throws. An
//     earlier version of this counted successful beats, and the leaked timer was
//     invisible to it — the leaked callback threw every time, so the success
//     count stayed put and the guard stayed green through the exact bug it was
//     written for. Counting the wrong thing is indistinguishable from not
//     checking.
//   * Make release() decrement a count instead of looking the lease up in the
//     Map (that is what the Map is for) — releasing the same lease twice tears
//     the session down while a second visitor is still waiting, and the
//     double-release case goes red.
//   * Drop the `await start()` in acquire(), or resolve start() before the
//     transport reports ready — the "the code is not shown before the socket is
//     listening" case goes red. This is only observable because the development
//     transport can be given a start latency.
//   * Make the listeningSince assignment conditional (`listeningSince ??= now`)
//     so a reconnect keeps the pre-drop marker — the recovered source then
//     reports LISTENING_NO_MATCH and the "never blame the visitor for our
//     disconnect" case goes red. One write site, so one line to break: an
//     earlier version also nulled it on disconnect, and with two lines enforcing
//     one invariant, neither alone was load-bearing and neither could be
//     red-proven.
//   * Remove the in-flight start deduplication (`if (startPromise) return
//     startPromise`) — two concurrent acquires open two sockets and the
//     control.startCount() === 1 case goes red.
//   * Let createProductionTransport() return an object instead of throwing — the
//     "production is not implemented and says so at boot" case goes red.
//   * Attach `control` to a production source — the "the programmable surface
//     does not exist outside development" case goes red.
//   * Let control.emitDanmaku() work while not listening — the double could then
//     prove a delivery the real transport cannot make, and the fidelity case
//     goes red. That case has to emit AFTER a stop, not merely before the first
//     start: before the first start there is no callback to call, so a test that
//     only checks that path passes with the listening check deleted.
//   * Put Date#toISOString() back in place of toCanonicalTimestamp() — every
//     timestamp here grows a '.sss' that no timestamp column in schema.sql
//     accepts, and the continuity guard INVERTS: with listeningSince
//     '2026-08-01T00:00:00.500Z', status({ since: '2026-08-01T00:00:00Z' })
//     answers LISTENING_NO_MATCH, because '.' (0x2E) sorts before 'Z' (0x5A).
//     A source that began listening half a second AFTER the code was issued
//     would report that it was listening before it — the precise false
//     reassurance this module exists to refuse.
//   * Delete the `gen === generation` guard in stop()'s finally — red input:
//     drive the source to 'failed', control.setStopLatencyMs(10), call stop(),
//     control.setStopLatencyMs(1), call stop() again, advance the clock past
//     both. The first stop's finally now lands LAST and re-marks a cleanly
//     stopped source 'failed', so status().visitor.verdict reads FAILED — our
//     side blamed for a shutdown that worked. (Without the stop latency knob
//     the two writes always land in the harmless order, and this guard could
//     never be observed doing anything, which is why the knob exists.)
//   * Delete the `generation += 1` in start() — the mirror of the guard above,
//     and the one that fails in the visitor's favour rather than ours. Red
//     input: stopLatencyMs 10, acquire, release (the close begins and takes
//     10ms), acquire again INSIDE that window, then advance past both the new
//     start and the close. Without the bump the in-flight stop still holds the
//     current generation, so its finally lands last and writes 'stopped' over a
//     start that had already succeeded: status().listening reads false, and
//     control.isListening() reads true, with a waiter holding a lease. Note the
//     advance has to clear the CLOSE, not just the new start — stopping short
//     of it passes with the defect in place, because the overwrite has not
//     landed yet.
//   * Delete the startAbort() call in stop() — red input: startBehaviour
//     'hang', `const p = acquire()`, then `await stop({ force: true })`. p stays
//     pending until the clock is advanced by the full startTimeoutMs, waiting on
//     a session that was torn down before the wait began.
//   * Delete the `gen !== generation` check AFTER the wait in start()'s dial
//     loop — red input: startRetryableFailures 1 with retryAfterMs 20000,
//     acquire, let the first dial be refused, stop({ force: true }) during the
//     wait, then advance 25000ms. The abort settled only the OUTER promise; the
//     loop wakes up and dials again, so control.startCount() reads 2 and the
//     double is listening for a session nobody holds. The twin check BEFORE the
//     wait cannot be red-proven against the double, and says so rather than
//     pretending: the double's stop() clears a pending start, so a dial in
//     flight never comes back refused after a stop. Against the real transport
//     it can (a connect timeout that fires after the stop is retryable), and
//     that check is what keeps the loop from sleeping out a wait for a start
//     nobody is waiting on any more.
//   * Drop `onDial` from the transport.start() call in the dial loop, or stop
//     the double reporting the dials it makes — the 'dial' event never fires
//     and both forwarding cases go red. That event is the only trace of a dial
//     that failed and was retried into success; nothing else would notice it
//     going quiet.
//   * Truncate displayName with slice() instead of by code points, or raise
//     maxNameLength above 120 — two red inputs, one per half: a nickname of
//     `'a' + '\u{1D4A5}'.repeat(100)` (slice(0, 128) cuts the 64th surrogate
//     pair in half and emits a LONE SURROGATE), and a nickname of
//     '名'.repeat(121) (121 code points survives a 128-unit slice and then
//     fails submitters.display_name's `length(display_name) <= 120` as a raw
//     CHECK error, at the end of a verification that had otherwise succeeded).
//   * Drop the escapeForI18n() call on displayName — red input: the nickname
//     '@:info.title'. Stored verbatim it renders as the site's own title
//     wherever the credit line is shown, i.e. text the submitter does not own
//     appearing under their name.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
// Imported rather than reimplemented, and imported from db/ rather than moved
// into lib/: toCanonicalTimestamp() is the only producer of the second-precision
// form every timestamp CHECK in schema.sql accepts, it lives beside the schema
// whose constraints define it, and migrate.mjs does nothing at import time
// (schema.sql is read inside migrate(), not beside it) so importing it here
// costs nothing and touches no disk. Moving it to lib/ would buy a shorter
// import path at the price of separating the rule from the file it describes.
import { toCanonicalTimestamp } from '../db/migrate.mjs'
import { createBiliTransport } from './bili-transport.mjs'
import { isConfigValidated } from './env-guard.mjs'
import { escapeForI18n } from './text-safety.mjs'

const MINUTE = 60_000

export const DANMAKU_DEFAULTS = Object.freeze({
  // The Open Platform app session has to be kept alive by an application-level
  // heartbeat; the exact cadence is STORY-010's to pin down. What matters here
  // is that the timer belongs to the lifecycle, so stop() can end it.
  heartbeatIntervalMs: 20_000,
  startTimeoutMs: 10_000,
  reconnectDelayMs: 1_000,
  // The ruled ceiling: a code, and the room session it holds open, expire after
  // 10 minutes. A lease that nobody releases must not pin the socket forever —
  // the commonest way a reference-counted resource never stops is a waiter that
  // went away without saying so.
  leaseTtlMs: 10 * MINUTE,
  /**
   * How long the room session stays open after the LAST waiter lets go.
   *
   * 45s, and it used to be 0. The reason is measured (JOI-BUTTON-INC-006): the
   * Open Platform refuses /v2/app/start for a while after a session for the same
   * app+room has ended — code 7001 请求冷却期, observed to clear somewhere inside
   * 15s. With no linger, the sequence that the whole login is made of —
   *
   *     visitor A verifies -> session stops -> visitor B asks for a code
   *
   * puts B's start inside that cooldown, and B is told the room is unreachable.
   *
   * A linger removes the cooldown from the COMMON path entirely: B arrives while
   * the socket is still open and gets a code with no wait at all. It does not
   * remove it from the tail — a visitor arriving just after the linger expires
   * still lands in the window — which is why the retry below exists as well.
   * Linger is the optimisation; the retry is the correctness.
   *
   * It is not a return to a standing connection. The ruling was that the room is
   * listened to on demand and released on success or at the 10-minute expiry;
   * 45s after the last waiter is on demand by any reading, and the socket is
   * demonstrably closed when nobody has asked for a code in the last minute.
   *
   * ZERO IS THE LIBRARY DEFAULT, and the 45s lives in server/config.mjs. This
   * module is the lifecycle; how long a DEPLOYMENT lingers is policy derived
   * from a platform's measured behaviour, and config.mjs is where that already
   * lives (it derives leaseTtlMs from the ruled code TTL in the same object).
   * Defaulting it here would also mean every lifecycle test that asserts prompt
   * teardown had to wait out a linger to prove a refcount — which is a different
   * property, tested with linger off.
   */
  lingerMs: 0,
  /**
   * How long acquire() may go on STARTING dials on its way to 'listening'.
   *
   * A gate on the next dial, not a deadline on the current one. The loop reads
   * it only after a dial has failed with something that waiting fixes, to
   * decide whether one more wait-and-dial still fits; it never interrupts a
   * dial in flight. Each dial is bounded on its own by startTimeoutMs (10s is
   * the library default; the deployment's value in server/config.mjs has to
   * sit above the transport's own staged timeouts, so that the error naming
   * the stage that stalled arrives before this lifecycle's generic one).
   *
   * Two failures clear by waiting (see retryableWaitMs below), and 45s has to
   * admit one wait plus one more dial for each, or the retry could never
   * complete and would only add latency to a failure:
   *
   *   * the platform's restart cooldown (7001): refused after one
   *     /v2/app/start round trip, asks for ~20s, measured to clear inside 15s;
   *     a dial after it (cold starts were measured at up to 7s) still fits.
   *   * a connect timeout (JOI-BUTTON-MIN-013 D1, 30s in the deployment): the
   *     next dial goes to the next wss_link about 1.25s later, on the same
   *     game session, and starts at ~31s — inside the budget.
   *
   * So the longest a visitor watches the spinner is NOT this number. When both
   * dials stall for the full 30s, the second began inside the budget and is
   * allowed to finish, and the room is reported unreachable after about 62s.
   * That is the stated price of a 30s connect timeout on a cross-border
   * handshake; cutting the second dial short would trade it for a failure that
   * names the budget instead of the stage that stalled.
   */
  startBudgetMs: 45_000,
  maxRecordedGaps: 50,
  maxOpenIdLength: 128,
  // 120, not 128, and matched to submitters.display_name's
  // `CHECK (length(display_name) <= 120)`. A limit looser than the column's is
  // not a limit, it is a deferral: the nickname passes here and the INSERT
  // fails with a raw CHECK error at the end of a verification that had already
  // succeeded. SQLite's length() counts code points, which is why the
  // truncation below counts them too.
  maxNameLength: 120,
  maxTextLength: 512,
})

// The closed set of answers status() will give about a waiting visitor. There is
// deliberately no member meaning "you are probably muted": the only verdict that
// licenses "we would have seen it" is LISTENING_NO_MATCH, and it requires
// uninterrupted listening since the code was issued.
export const VISITOR_VERDICTS = Object.freeze({
  NOT_LISTENING: 'not_listening',
  STARTING: 'starting',
  RECONNECTING: 'reconnecting',
  FAILED: 'source_failed',
  LISTENING: 'listening',
  LISTENING_NO_MATCH: 'listening_no_match',
  LISTENING_AFTER_GAP: 'listening_after_gap',
})

export const SOURCE_STATES = Object.freeze([
  'idle',
  'starting',
  'listening',
  'reconnecting',
  'stopping',
  'stopped',
  'failed',
])

/**
 * Normalise one raw danmaku into the shape every consumer sees.
 *
 * Exported because STORY-010 must emit the same shape the development double
 * emits; two normalisers is two contracts. Accepts both the Open Platform wire
 * names (open_id / uname / msg) and the normalised ones, so the real transport
 * can hand its payload straight in.
 *
 * Throws on anything malformed. The lifecycle catches that, counts it, and
 * routes it to 'error' listeners: a hostile or broken upstream must not be able
 * to push an unbounded string into the caller's matcher, and must not be able to
 * stop the session by sending one bad frame.
 *
 * `displayName` comes back escaped and truncated, and may come back EMPTY — a
 * nickname made only of characters escapeForI18n strips normalises to ''. That
 * is not new (an absent uname already produced ''), and it stays the caller's
 * decision, because submitters.display_name refuses '' and only the caller
 * knows what it wants shown instead.
 */
export function normalizeDanmaku(raw, { receivedAt, limits = DANMAKU_DEFAULTS } = {}) {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('danmaku: expected an object')
  }
  const openId = raw.openId ?? raw.open_id
  const displayName = raw.displayName ?? raw.uname ?? ''
  const text = raw.text ?? raw.msg

  if (typeof openId !== 'string' || openId.trim() === '') {
    throw new TypeError('danmaku: open_id is missing or empty')
  }
  if (openId.length > limits.maxOpenIdLength) {
    throw new TypeError(`danmaku: open_id exceeds ${limits.maxOpenIdLength} characters`)
  }
  if (typeof text !== 'string') {
    throw new TypeError('danmaku: text is missing or not a string')
  }
  if (text.length > limits.maxTextLength) {
    throw new TypeError(`danmaku: text exceeds ${limits.maxTextLength} characters`)
  }
  if (typeof displayName !== 'string') {
    throw new TypeError('danmaku: display name is not a string')
  }

  return Object.freeze({
    id: randomUUID(),
    // A receivedAt supplied by the caller goes through the same producer rather
    // than being trusted: STORY-010's transport will hand one in, and a second
    // precision arriving from there would defeat every ordering comparison made
    // on these strings just as surely as producing one here would.
    receivedAt: toCanonicalTimestamp(receivedAt ?? new Date()),
    openId,
    // Escape first, truncate second. escapeForI18n only strips and substitutes
    // 1:1, so escaping can only shorten — doing it after the cut would spend
    // budget on characters that are about to be removed. Slicing an array of
    // code points cannot cut a surrogate pair in half the way slice() on UTF-16
    // units does, so the result satisfies the column's length CHECK and cannot
    // carry a lone surrogate.
    displayName: truncateCodePoints(escapeForI18n(displayName), limits.maxNameLength),
    // Verbatim: the caller matches the one-time code against this text, and a
    // substituted character would not match the code we issued.
    text,
  })
}

/**
 * createDanmakuSource(config) -> {
 *   start, stop, acquire, release, on, off, status, mode, [control]
 * }
 *
 * config:
 *   mode          'production' | 'development'   (required)
 *   lifecycle     partial override of DANMAKU_DEFAULTS
 *   clock         injectable timers, for tests
 *   development   knobs for the programmable double (development mode only)
 *
 * events, through on(event, listener), which returns its own unsubscribe:
 *   'danmaku'     one normalised danmaku (see normalizeDanmaku)
 *   'status'      status(), on every change of state
 *   'error'       a failure with nobody left to return it to
 *   'dial'        one record per dial the transport made, as the transport
 *                 made it: { host, phase, elapsedMs, attempt, outcome }, where
 *                 host is host:port, phase is 'connecting' (the handshake had
 *                 not completed) or 'awaiting-auth-reply' (it had, and the
 *                 room had not answered the auth packet), and outcome is 'ok'
 *                 for the dial that got the room listening. Never auth_body,
 *                 never a credential — the transport builds the record from
 *                 those five and nothing else, and a listener that writes it
 *                 to a log should still copy those five by name.
 *
 *                 Forwarded for every dial, including one made for a start
 *                 that a stop has since cancelled: the record describes the
 *                 network, and the network did not stop being slow because
 *                 nobody was waiting any more. A refusal that came before any
 *                 socket was dialled — the platform's cooldown answer to
 *                 /v2/app/start, say — is not a dial and produces none.
 *
 * In development mode the config must be one assertSafeConfig() has cleared. It
 * is not enough to remember to call the guard: the bypass is unconstructable
 * without it.
 */
export function createDanmakuSource(config = {}) {
  const mode = config?.mode
  if (mode !== 'production' && mode !== 'development') {
    throw new TypeError(
      `createDanmakuSource: config.mode must be "production" or "development", got ${JSON.stringify(mode)}`,
    )
  }
  if (mode === 'development' && !isConfigValidated(config)) {
    throw new Error(
      'createDanmakuSource: the development danmaku source can only be built from a config that ' +
        'assertSafeConfig() has cleared. Call assertSafeConfig(config, { nodeEnv }) at the entry ' +
        'point first — it is what refuses this mode in production, and skipping it does not grant ' +
        'the bypass, it removes it.',
    )
  }

  const opts = Object.freeze({ ...DANMAKU_DEFAULTS, ...(config.lifecycle ?? {}) })
  const clock = config.clock ?? realClock()
  const emitter = createEmitter()

  const transport =
    mode === 'production'
      ? createProductionTransport(config)
      : createDevelopmentTransport(config.development ?? {}, clock)

  const leases = new Map()
  const gaps = []

  let state = 'idle'
  let generation = 0
  let startPromise = null
  // Set while a start is in flight; calling it fails that start now instead of
  // at its own timeout. stop() is the only caller.
  let startAbort = null
  let startedAt = null
  let listeningSince = null
  let stoppedAt = null
  let lastEventAt = null
  let lastError = null
  let heartbeatTimer = null
  let heartbeatTicks = 0
  let heartbeatErrors = 0
  let lastHeartbeatAt = null
  let reconnectTimer = null
  let lingerTimer = null
  let received = 0
  let malformed = 0

  function setState(next) {
    if (state === next) return
    state = next
    emitter.emit('status', status())
  }

  function openGap(reason) {
    const open = gaps.find((g) => g.to === null)
    if (open) return
    gaps.push({ from: toCanonicalTimestamp(clock.now()), to: null, reason })
    while (gaps.length > opts.maxRecordedGaps) gaps.shift()
  }

  function closeGap() {
    const open = gaps.find((g) => g.to === null)
    if (open) open.to = toCanonicalTimestamp(clock.now())
  }

  function startHeartbeat() {
    if (heartbeatTimer !== null) return
    heartbeatTimer = clock.setInterval(() => {
      // Ticks are counted BEFORE the call, and counted even when the call
      // throws. This is the only observable that distinguishes "the timer was
      // cleared" from "the timer is still armed and its work is failing" —
      // `running` below is our own bookkeeping and a leaked interval does not
      // update it. Counting successes here instead would have made a leak
      // invisible for exactly as long as the leaked work kept failing, which is
      // forever.
      heartbeatTicks += 1
      lastHeartbeatAt = toCanonicalTimestamp(clock.now())
      try {
        transport.heartbeat()
      } catch (err) {
        heartbeatErrors += 1
        lastError = { message: errorText(err), at: toCanonicalTimestamp(clock.now()) }
        emitter.emit('error', err)
      }
    }, opts.heartbeatIntervalMs)
  }

  function stopHeartbeat() {
    if (heartbeatTimer === null) return
    clock.clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  function cancelReconnect() {
    if (reconnectTimer === null) return
    clock.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  function cancelLinger() {
    if (lingerTimer === null) return
    clock.clearTimeout(lingerTimer)
    lingerTimer = null
  }

  // Handed to every transport.start() as onDial, and forwarded as it came: the
  // record is the transport's, built from five named fields, and a listener that
  // logs it copies those five by name as well. emit() never throws — a
  // listener's exception goes to 'error' listeners instead — so a broken log
  // sink cannot reach back into the dial that reported to it.
  function reportDial(record) {
    emitter.emit('dial', record)
  }

  function ingest(raw) {
    let event
    try {
      event = normalizeDanmaku(raw, { receivedAt: toCanonicalTimestamp(clock.now()), limits: opts })
    } catch (err) {
      malformed += 1
      emitter.emit('error', err)
      return
    }
    received += 1
    lastEventAt = event.receivedAt
    emitter.emit('danmaku', event)
  }

  function handleDisconnect(info = {}) {
    stopHeartbeat()
    openGap(info.reason ?? 'transport-disconnected')
    if (info.error) lastError = { message: errorText(info.error), at: toCanonicalTimestamp(clock.now()) }

    if (leases.size === 0) {
      stoppedAt = toCanonicalTimestamp(clock.now())
      setState('stopped')
      return
    }
    setState('reconnecting')
    scheduleReconnect()
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) return
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null
      if (leases.size === 0) return
      start().catch(() => {
        // The lease TTL is what bounds this loop: a waiter cannot hold a lease
        // longer than the code is valid for, so a permanently broken room stops
        // retrying within the ruled 10 minutes rather than forever.
        if (leases.size > 0) scheduleReconnect()
      })
    }, opts.reconnectDelayMs)
  }

  function start() {
    if (state === 'listening') return Promise.resolve(status())
    // One socket per source. Two visitors asking at the same moment is the
    // normal case, not the rare one.
    if (startPromise) return startPromise

    cancelLinger()
    // start() bumps too, not just stop(). Without this, a stop already in flight
    // still holds the current generation, so when its `finally` lands it writes
    // 'stopped' over a start that succeeded during the close window — and a
    // visitor who arrived just then is told the room is unreachable while the
    // transport is demonstrably listening. That is the false report this module
    // exists to prevent, inverted. Bumping here makes the in-flight stop's
    // captured generation stale, so its finally correctly declines to write.
    generation += 1
    const gen = generation
    setState('starting')
    startedAt = toCanonicalTimestamp(clock.now())
    openGap('never-started')

    // The abort half of the race. stop() calls `abort` so a start it orphans
    // fails at once; without it the waiter in acquire() sits out the whole
    // startTimeoutMs on a session that was torn down before it began waiting.
    // Promise.race subscribes to both sides, so an abort that arrives after the
    // transport won is absorbed rather than becoming an unhandled rejection.
    let abort
    const aborted = new Promise((_, reject) => {
      abort = () => reject(new Error('danmaku source: the start was cancelled by a stop'))
    })
    startAbort = abort

    // Dial, and WAIT OUT the conditions that clear by themselves.
    //
    // This loop is inside start() rather than around it on purpose: the state
    // stays 'starting' for its whole duration, so a visitor sees 准备中 rather
    // than being told the room is unreachable during a wait we already know will
    // end. Going to 'failed' and retrying from outside would have flickered a
    // false verdict at exactly the moment the answer was "nearly".
    //
    // The per-dial timeout is unchanged; what is new is the budget across dials.
    const dial = async () => {
      const deadline = clock.now().getTime() + opts.startBudgetMs
      for (;;) {
        try {
          return await withTimeout(
            clock,
            transport.start({ onDanmaku: ingest, onDisconnect: handleDisconnect, onDial: reportDial }),
            opts.startTimeoutMs,
            `the transport did not become ready within ${opts.startTimeoutMs}ms`,
          )
        } catch (err) {
          const waitMs = retryableWaitMs(err)
          if (waitMs === null) throw err
          // Superseded: a stop (which has already settled the waiter through
          // `aborted`) or a later start owns the source now. Nobody is waiting
          // on this loop any more, so it does not wait either.
          if (gen !== generation) throw err
          // Not enough budget left to wait AND dial again: fail now with the
          // real reason rather than sleeping through the remainder and then
          // reporting a timeout, which would name the wrong cause.
          if (clock.now().getTime() + waitMs >= deadline) throw err
          await delay(clock, waitMs)
          // Asked again on waking, and this is the check that holds the line: a
          // stop that landed DURING the wait settled the waiter, but not this
          // loop. Without it the next turn dials for a session nobody holds —
          // stop() has already run its transport.stop() and will not come back,
          // so whatever that dial opens is never closed.
          if (gen !== generation) throw err
        }
      }
    }

    // aborted races the WHOLE loop, not one dial: a stop arriving while we are
    // waiting out a cooldown or a connect timeout settles the waiter at once
    // rather than after the wait. It does NOT stop the loop — a race settles
    // its own promise and leaves the losers running — which is why the loop
    // above checks the generation for itself on both sides of every wait.
    const attempt = Promise.race([dial(), aborted])

    // Cleared BY IDENTITY, not unconditionally. When a stop aborts this start
    // and a new acquire opens another one before these handlers run, a blind
    // `startPromise = null` would drop the new start's handle and its abort
    // hook — leaving the next stop nothing to cancel and the dedup broken.
    const forget = () => {
      if (startPromise === pending) startPromise = null
      if (startAbort === abort) startAbort = null
    }

    const pending = attempt.then(
      () => {
        forget()
        if (gen !== generation) {
          // A stop landed while this was in flight and the transport became
          // ready anyway: it is now listening for a session nobody holds, and
          // stop() has already run its own transport.stop() and will not come
          // back. Close it here or it outlives the source that opened it.
          void closeOrphanedTransport()
          return status()
        }
        // THE ONLY PLACE listeningSince IS EVER WRITTEN, and it is written on
        // every ready rather than only the first. That is what makes "we have
        // been listening continuously since T" answerable: after a drop, this
        // is later than the code's issue time and the verdict downgrades to
        // LISTENING_AFTER_GAP by arithmetic instead of by someone remembering
        // to invalidate it.
        //
        // Nulling it on the way out as well would be redundant, and redundancy
        // here is not free: two lines enforcing one invariant means neither one
        // alone is load-bearing, so neither can be red-proven. status() hides a
        // stale value instead, by reporting it only while actually listening.
        listeningSince = toCanonicalTimestamp(clock.now())
        closeGap()
        setState('listening')
        startHeartbeat()
        return status()
      },
      async (err) => {
        forget()
        // Includes the abort case: the stop that cancelled this start moved the
        // generation, so it owns the state and this handler must not write
        // 'failed' over what that stop is about to record.
        if (gen !== generation) throw err
        lastError = { message: errorText(err), at: toCanonicalTimestamp(clock.now()) }
        stopHeartbeat()
        try {
          await transport.stop()
        } catch {
          // A transport that cannot be stopped after failing to start has
          // nothing left to tell us; the start error is the one that matters.
        }
        setState('failed')
        throw err
      },
    )
    startPromise = pending
    return startPromise
  }

  // Never throws: this runs after the owner of the session has gone, so there
  // is nobody left to return a failure to. It goes to 'error' listeners, which
  // is where a socket we could not close belongs.
  async function closeOrphanedTransport() {
    try {
      await transport.stop()
    } catch (err) {
      emitter.emit('error', err)
    }
  }

  async function stop({ force = false } = {}) {
    if (leases.size > 0 && !force) {
      throw new Error(
        `danmaku source: refusing to stop while ${leases.size} waiter(s) hold a lease. ` +
          'Release them, or pass { force: true } if this is process shutdown. Stopping under a ' +
          'live wait is exactly the failure the reference count exists to prevent.',
      )
    }
    // A failed start releases its own lease, which lands here — and a plain
    // 'stopped' at the end would read as an orderly shutdown of a session that
    // never opened. The distinction is the visitor's: 'stopped' invites "try
    // again", 'failed' plus lastError lets the UI say our side could not reach
    // the room, which is the true and non-blaming answer.
    const cameFromFailure = state === 'failed'
    // Our claim on the source, captured AFTER the bump so it names this stop and
    // not the state before it. A stop that starts later moves `generation` past
    // `gen`, and the finally below then belongs to that stop rather than to us.
    generation += 1
    const gen = generation
    setState('stopping')
    cancelLinger()
    cancelReconnect()
    // The heartbeat goes before the socket. A stop that only drops the socket
    // leaves this timer beating against a session that no longer exists.
    stopHeartbeat()
    for (const lease of leases.values()) {
      if (lease.timer !== null) clock.clearTimeout(lease.timer)
    }
    leases.clear()
    // Cancel before dropping the handle. Without this the start we just
    // orphaned runs to its own timeout with acquire() still waiting on it —
    // a waiter blocked for startTimeoutMs on a session that no longer exists.
    if (startAbort !== null) startAbort()
    startAbort = null
    startPromise = null
    try {
      await transport.stop()
    } finally {
      // The guard start() applies, applied here for the same reason: when
      // transport.stop() settles after a later owner has taken the source over,
      // writing 'stopped'/'failed' now would park it in a terminal state while
      // the transport is listening and a waiter holds a lease. The later owner's
      // own stop records the ending; this one has nothing left to say.
      if (gen === generation) {
        stoppedAt = toCanonicalTimestamp(clock.now())
        closeGap()
        setState(cameFromFailure ? 'failed' : 'stopped')
      }
    }
  }

  function scheduleStop() {
    if (opts.lingerMs > 0) {
      cancelLinger()
      lingerTimer = clock.setTimeout(() => {
        lingerTimer = null
        if (leases.size === 0) stop().catch((err) => emitter.emit('error', err))
      }, opts.lingerMs)
      return
    }
    stop().catch((err) => emitter.emit('error', err))
  }

  /**
   * Take a reference on the room session. Resolves only once the transport is
   * listening — the caller may show the one-time code after this resolves and
   * not before.
   */
  async function acquire({ ttlMs } = {}) {
    const lease = { id: randomUUID(), acquiredAt: toCanonicalTimestamp(clock.now()), timer: null }
    // Registered before the await: a release racing with this start must not see
    // an empty lease table and tear down the session we are opening.
    leases.set(lease.id, lease)
    try {
      await start()
    } catch (err) {
      // A failed start must not leave a lease behind, or the count never returns
      // to zero and the source never stops.
      dropLease(lease.id)
      throw err
    }
    const ttl = ttlMs ?? opts.leaseTtlMs
    lease.timer = clock.setTimeout(() => release(lease.id), ttl)
    return { leaseId: lease.id, status: status() }
  }

  /**
   * Give up a reference. Returns false for an unknown or already-released lease
   * rather than decrementing: a refcount that trusts its callers to release
   * exactly once is a refcount that will be released twice.
   */
  function release(leaseId) {
    return dropLease(leaseId)
  }

  function dropLease(leaseId) {
    const lease = leases.get(leaseId)
    if (!lease) return false
    leases.delete(leaseId)
    if (lease.timer !== null) clock.clearTimeout(lease.timer)
    if (leases.size === 0) scheduleStop()
    return true
  }

  /**
   * status({ since }) — `since` is the moment the visitor's code was issued.
   *
   * The field the UI branches on is `visitor.verdict`, and the one it must never
   * paper over is the difference between "we are not listening" and "you have
   * not sent it yet". Only LISTENING_NO_MATCH licenses telling someone their
   * message did not arrive.
   */
  function status({ since } = {}) {
    const listening = state === 'listening'
    // Both sides are second-precision, so a listen and a code issue that fall
    // inside the SAME second compare equal and read as continuous. That
    // sub-second window is the one case where this can still reassure wrongly,
    // and it is the stated price of the ruled timestamp format — stated here
    // rather than left to be discovered. The millisecond form did not shrink
    // that window, it inverted the comparison outright: '…:00.500Z' <= '…:00Z'
    // is true, so ANY start within the following second read as continuous.
    const continuous = listening && listeningSince !== null && (!since || listeningSince <= since)
    return Object.freeze({
      mode,
      state,
      listening,
      waiters: leases.size,
      startedAt,
      // Reported only while listening: the marker itself is never cleared (see
      // the single write site), so exposing it unconditionally would claim a
      // "listening since" for a source that is not listening.
      listeningSince: listening ? listeningSince : null,
      stoppedAt,
      lastEventAt,
      lastError: lastError ? Object.freeze({ ...lastError }) : null,
      heartbeat: Object.freeze({
        intervalMs: opts.heartbeatIntervalMs,
        // Bookkeeping, not evidence: this says whether we think we hold a timer
        // handle. `ticks` is the evidence.
        running: heartbeatTimer !== null,
        ticks: heartbeatTicks,
        errors: heartbeatErrors,
        lastTickAt: lastHeartbeatAt,
      }),
      events: Object.freeze({ received, malformed }),
      gaps: Object.freeze(gaps.map((g) => Object.freeze({ ...g }))),
      visitor: Object.freeze({
        verdict: visitorVerdict(state, continuous, since),
        // "Can we honestly say we would have seen it?" Everything the UI is
        // allowed to tell a waiting visitor follows from this one boolean.
        canAssertNotSeen: continuous,
        since: since ?? null,
      }),
    })
  }

  function visitorVerdict(current, continuous, since) {
    switch (current) {
      case 'listening':
        if (!since) return VISITOR_VERDICTS.LISTENING
        return continuous ? VISITOR_VERDICTS.LISTENING_NO_MATCH : VISITOR_VERDICTS.LISTENING_AFTER_GAP
      case 'starting':
        return VISITOR_VERDICTS.STARTING
      case 'reconnecting':
        return VISITOR_VERDICTS.RECONNECTING
      case 'failed':
        return VISITOR_VERDICTS.FAILED
      default:
        return VISITOR_VERDICTS.NOT_LISTENING
    }
  }

  const source = {
    mode,
    start,
    stop,
    acquire,
    release,
    on: emitter.on,
    off: emitter.off,
    status,
  }

  // The programmable surface exists in development only. Frozen so that nothing
  // downstream can bolt one onto a production source later.
  if (mode === 'development') {
    source.control = Object.freeze({
      ...transport.control,
      heartbeatTicks: () => heartbeatTicks,
      leaseCount: () => leases.size,
    })
  }

  return Object.freeze(source)
}

// ---------------------------------------------------------------------------
// transports

// STORY-010 landed, and the reason this used to throw did not go away with it —
// it moved. createBiliTransport() refuses at construction when any Open Platform
// credential is missing or invalid, so `mode: 'production'` still fails at boot
// rather than at the first visitor. What changed is only which sentence you get:
// "not implemented" became "these credentials are missing".
//
// The wire protocol itself is deliberately not here. This file is the lifecycle
// — reference counting, the start race, the verdict a waiting visitor is
// allowed to be told — and none of that should have to be read past a packet
// decoder to be understood. See lib/bili-transport.mjs, whose header records
// which document or reference implementation every protocol detail came from.
function createProductionTransport(config) {
  return createBiliTransport(config)
}

/**
 * The programmable double.
 *
 * Every knob here exists because some guard in the real implementation is
 * unfalsifiable without it. They are settable after construction so a single
 * test can walk a source through ready -> drop -> recovered.
 */
function createDevelopmentTransport(devConfig, clock) {
  const state = {
    behaviour: devConfig.startBehaviour ?? 'ready', // 'ready' | 'fail' | 'hang'
    latencyMs: devConfig.startLatencyMs ?? 0,
    stopLatencyMs: devConfig.stopLatencyMs ?? 0,
    failureMessage: devConfig.startFailureMessage ?? 'simulated start failure',
    // The platform's restart cooldown, modelled. The first N starts reject with
    // an error carrying { retryable, retryAfterMs } — the shape lib/bili-transport
    // puts on a 7001 请求冷却期 — and the N+1th succeeds.
    //
    // This knob exists for the same reason every other knob in this double
    // exists: without it the dial loop's retry is unfalsifiable. A test that
    // never sees a retryable rejection cannot tell a loop that waits and
    // succeeds from one that gives up, and the real cooldown is a live
    // platform's behaviour that no test may depend on reproducing.
    retryableFailuresRemaining: devConfig.startRetryableFailures ?? 0,
    retryAfterMs: devConfig.retryAfterMs ?? 20_000,
    startCount: 0,
    stopCount: 0,
    heartbeatCount: 0,
    listening: false,
    pendingTimer: null,
    onDanmaku: null,
    onDisconnect: null,
  }

  function clearPending() {
    if (state.pendingTimer === null) return
    clock.clearTimeout(state.pendingTimer)
    state.pendingTimer = null
  }

  return {
    kind: 'development',

    // Reports its dials the way the real transport does — one record through
    // onDial as each dial ends, the same record on the error a failed dial
    // rejects with — because the per-dial log line is otherwise unfalsifiable
    // through this double: a route that never logs a dial passes every test
    // that cannot make one happen. The record is synthetic and says so:
    // host 'development', elapsedMs the configured latency, attempt the start
    // count. Only starts that reach the point where the real transport would
    // have dialled report one; see the two exceptions below.
    start({ onDanmaku, onDisconnect, onDial }) {
      state.startCount += 1
      state.onDanmaku = onDanmaku
      state.onDisconnect = onDisconnect
      const behaviour = state.behaviour
      // Captured now rather than read when the timer fires: the record
      // describes THIS dial, and a knob turned while it is in flight belongs to
      // the next one.
      const attempt = state.startCount
      const latencyMs = state.latencyMs
      const dialEnded = (outcome, phase) => {
        const record = Object.freeze({ host: 'development', phase, elapsedMs: latencyMs, attempt, outcome })
        if (typeof onDial === 'function') onDial(record)
        return record
      }
      return new Promise((resolve, reject) => {
        clearPending()
        state.pendingTimer = clock.setTimeout(() => {
          state.pendingTimer = null
          if (state.retryableFailuresRemaining > 0) {
            // No dial record. On the platform this refusal is the answer to
            // /v2/app/start, which comes before any socket is dialled.
            state.retryableFailuresRemaining -= 1
            const cooling = new Error('simulated cooldown (请求冷却期)')
            cooling.retryable = true
            cooling.retryAfterMs = state.retryAfterMs
            reject(cooling)
            return
          }
          if (behaviour === 'fail') {
            const failure = new Error(state.failureMessage)
            failure.dial = dialEnded('error', 'connecting')
            reject(failure)
            return
          }
          // Never settles, so never ends a dial and never reports one: the
          // lifecycle times it out, and that timeout is the lifecycle's, not a
          // dial's.
          if (behaviour === 'hang') return
          state.listening = true
          dialEnded('ok', 'awaiting-auth-reply')
          resolve()
        }, latencyMs)
      })
    },

    stop() {
      state.stopCount += 1
      clearPending()
      state.listening = false
      if (state.stopLatencyMs <= 0) return Promise.resolve()
      // A stop that settles LATER than the code which called it is what makes
      // the generation guard in the lifecycle's stop() observable at all: with
      // an instantly resolved stop no second owner can get between the call and
      // its finally, so that guard would sit there green forever, never having
      // been evaluated in a world where it could be false. Same argument as the
      // start knobs above; a real socket close is not instant either.
      return new Promise((resolve) => {
        clock.setTimeout(resolve, state.stopLatencyMs)
      })
    },

    heartbeat() {
      if (!state.listening) throw new Error('development transport: heartbeat while not listening')
      state.heartbeatCount += 1
    },

    control: Object.freeze({
      setStartBehaviour(behaviour) {
        if (!['ready', 'fail', 'hang'].includes(behaviour)) {
          throw new TypeError(`unknown start behaviour "${behaviour}"`)
        }
        state.behaviour = behaviour
      },
      setStartLatencyMs(ms) {
        if (!Number.isInteger(ms) || ms < 0) throw new TypeError('start latency must be a non-negative integer')
        state.latencyMs = ms
      },
      setStopLatencyMs(ms) {
        if (!Number.isInteger(ms) || ms < 0) throw new TypeError('stop latency must be a non-negative integer')
        state.stopLatencyMs = ms
      },
      setStartFailureMessage(message) {
        state.failureMessage = String(message)
      },

      /**
       * Deliver a danmaku as if the room had sent it.
       *
       * Refuses while not listening. A double that can deliver an event the real
       * transport could not would let a test prove a delivery that cannot
       * happen — and the guard it was proving would be worth nothing.
       */
      /** Arm N consecutive retryable (cooldown-shaped) start rejections. */
      coolDownFor(count, retryAfterMs) {
        state.retryableFailuresRemaining = count
        if (typeof retryAfterMs === 'number') state.retryAfterMs = retryAfterMs
      },
      retryableFailuresRemaining: () => state.retryableFailuresRemaining,

      emitDanmaku({ openId, displayName = '', text }) {
        if (!state.listening || typeof state.onDanmaku !== 'function') {
          throw new Error(
            'development transport: refusing to emit a danmaku while not listening — the real ' +
              'transport cannot deliver one either, and a false positive here would validate a ' +
              'guard that does not hold.',
          )
        }
        state.onDanmaku({ openId, displayName, text })
      },

      /** A mid-wait drop: the case that turns LISTENING_NO_MATCH into LISTENING_AFTER_GAP. */
      disconnect({ reason = 'simulated-disconnect', error = null } = {}) {
        if (!state.listening) throw new Error('development transport: not listening, nothing to disconnect')
        state.listening = false
        clearPending()
        if (typeof state.onDisconnect === 'function') state.onDisconnect({ reason, error })
      },

      startCount: () => state.startCount,
      stopCount: () => state.stopCount,
      transportHeartbeatCount: () => state.heartbeatCount,
      isListening: () => state.listening,
    }),
  }
}

// ---------------------------------------------------------------------------
// small shared pieces

// node:events is not used here on purpose: EventEmitter throws when an 'error'
// event has no listener, so a transport hiccup during a window when nobody
// happens to be subscribed would take the process down. A source whose job is to
// survive disconnects must not have that property.
function createEmitter() {
  const listeners = new Map()

  function on(event, cb) {
    if (typeof cb !== 'function') throw new TypeError('listener must be a function')
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(cb)
    return () => off(event, cb)
  }

  function off(event, cb) {
    return listeners.get(event)?.delete(cb) ?? false
  }

  function emit(event, payload) {
    const set = listeners.get(event)
    if (!set || set.size === 0) return
    for (const cb of [...set]) {
      try {
        cb(payload)
      } catch (err) {
        if (event === 'error') continue // an error handler that throws is not worth a loop
        emit('error', err)
      }
    }
  }

  return { on, off, emit }
}

// unref, with its consequence stated: no timer this module creates will hold the
// event loop open. A ten-minute lease timer or a heartbeat that outlived its
// session must never be the reason a container refuses to exit — that is the
// shape of every background-cleanup bug this project has already had once.
//
// The price is real and belongs here rather than in a surprise: a program whose
// ONLY pending work is a danmaku source will exit mid-wait. The API is not such
// a program (the HTTP listener holds the loop), but a test harness or a one-off
// script is, and must hold the loop itself.
function realClock() {
  return {
    now: () => new Date(),
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

// Uses the injected clock, not the global one: a test that drives time must be
// able to drive the start timeout too, or "the start that never becomes ready"
// costs it a real ten seconds and gets skipped.
/**
 * How long to wait before dialling again, or null when this error is not one
 * that waiting fixes.
 *
 * The transport sets both fields on exactly two kinds of error, the two that
 * mean "not yet" rather than "broken":
 *
 *   * the platform's own restart cooldown (code 7001), which is known to clear;
 *   * a connect timeout — the socket did not open, or opened and was not
 *     answered, inside connectTimeoutMs (JOI-BUTTON-MIN-013 D1). A slow
 *     cross-border handshake is the next wss_link's problem, not a verdict on
 *     the room, and the transport keeps the game session so the next dial
 *     reuses it rather than walking into the cooldown that ending it causes.
 *
 * NOT the transport's backoff gate. An earlier version of this note listed it
 * as retryable, and lib/bili-transport.mjs says the opposite on purpose: that
 * gate is reached after consecutive genuine failures, and waiting it out would
 * spend a visitor's whole budget to fail anyway. Anything else — a bad
 * credential, the wrong room, an auth packet the room refused, a socket that
 * errored or closed before it authenticated — is not improved by waiting
 * either, and retrying it would turn a clear error into a slow one.
 */
function retryableWaitMs(error) {
  if (error === null || typeof error !== 'object') return null
  if (error.retryable !== true) return null
  const wait = error.retryAfterMs
  return typeof wait === 'number' && Number.isFinite(wait) && wait >= 0 ? wait : null
}

function delay(clock, ms) {
  return new Promise((resolve) => clock.setTimeout(resolve, ms))
}

function withTimeout(clock, promise, ms, message) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = clock.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`danmaku source: ${message}`))
    }, ms)
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clock.clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clock.clearTimeout(timer)
        reject(err)
      },
    )
  })
}

// Code points, because that is the unit the column counts: SQLite's length() on
// TEXT returns characters, not UTF-16 units, so a code-point budget here is the
// same budget submitters.display_name enforces. String#slice() counts UTF-16
// units and can cut between the halves of a surrogate pair; the lone surrogate
// that leaves survives JSON.stringify and becomes U+FFFD when the row is
// encoded as UTF-8, corrupting the name rather than shortening it.
function truncateCodePoints(text, max) {
  const points = [...text]
  if (points.length <= max) return text
  return points.slice(0, max).join('')
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err)
}
