// SPDX-License-Identifier: MIT
//
// JOI-BUTTON-INC-006: the platform's restart cooldown, and the two things that
// answer it.
//
// WHAT WAS MEASURED (2026-08-01, real credentials, room 3622717). After a stop
// that had FULLY SETTLED — state 'stopped', zero waiters, /v2/app/end returned —
// an immediate /v2/app/start answered `code 7001 (请求冷却期)`, and the same call
// at +15s succeeded. Cold starts took 5.6–7.1s. Heartbeats ticked every 20s with
// no errors.
//
// WHY IT MATTERS. This site's only login is: ask for a code, send it as a
// danmaku, get recognised. The room session opens for that and closes on
// success. So the ordinary sequence
//
//     visitor A verifies  ->  session stops  ->  visitor B asks for a code
//
// puts B's start inside the cooldown, and B is told the room is unreachable —
// a false report, about the one path the whole site depends on.
//
// THE TWO ANSWERS, and why one alone is not enough:
//
//   linger  keeps the socket open for a while after the LAST waiter lets go, so
//           B arrives while it is still open and waits for nothing. This removes
//           the cooldown from the common path and MOVES the window rather than
//           closing it: somebody arriving just after the linger expires still
//           lands in it.
//   retry   waits the cooldown out inside acquire(), so the visitor in that
//           window sees a longer "准备中" instead of an error.
//
// Both are exercised here against the development transport, which now carries a
// knob that produces exactly the rejection shape lib/bili-transport puts on a
// 7001. Without that knob the retry is unfalsifiable: a test that never sees a
// retryable rejection cannot tell a loop that waits and succeeds from one that
// gives up.

import assert from 'node:assert/strict'
import test from 'node:test'

import { COOLDOWN_CODES, OpenPlatformError } from '../lib/bili-transport.mjs'
import { DANMAKU_DEFAULTS, createDanmakuSource } from '../lib/danmaku-source.mjs'
import { createTestClock } from './helpers/clock.mjs'
import { clearedConfig } from './helpers/config.mjs'

const T0 = '2026-08-01T00:00:00Z'

function source(t, { development = {}, lifecycle = {} } = {}) {
  const clock = createTestClock(T0)
  const { config } = clearedConfig({
    danmaku: { mode: 'development', codeTtlMinutes: 10, roomId: 3622717, clock, development, lifecycle },
  })
  const made = createDanmakuSource(config.danmaku)
  t.after(() => made.stop({ force: true }).catch(() => {}))
  return { source: made, clock }
}

test('7001 is classified as a cooldown, and that classification is not a lone literal', () => {
  // The set exists so the number appears once. A second `=== 7001` somewhere is
  // how a code table drifts.
  assert.deepEqual([...COOLDOWN_CODES], [7001])
  const err = new OpenPlatformError('x', { platformCode: 7001 })
  assert.equal(COOLDOWN_CODES.includes(err.platformCode), true)
  assert.equal(COOLDOWN_CODES.includes(4001), false)
})

test('the library default is NOT to linger, because a linger is policy', () => {
  // server/config.mjs sets 45s for the deployment. This module is a refcount and
  // its default has to be the one that makes the refcount observable.
  assert.equal(DANMAKU_DEFAULTS.lingerMs, 0)
  assert.equal(DANMAKU_DEFAULTS.startBudgetMs, 45_000)
})

test('acquire waits out a cooldown instead of reporting an unreachable room', async (t) => {
  const { source: src, clock } = source(t, {
    development: { startRetryableFailures: 1, retryAfterMs: 20_000 },
  })

  const pending = src.acquire()
  // The first dial rejects with the cooldown shape; the loop is now waiting.
  // NOTE the ordering, which the manual clock forces everywhere in this file:
  // the double's start resolves from a timer, so acquire() must be in flight
  // BEFORE time moves, and a promise that will reject needs its handler attached
  // synchronously or the runner reports it as unhandled.
  await clock.advance(1)
  assert.equal(src.status().listening, false)
  // 'starting', NOT 'failed': the visitor is shown 准备中 for the whole wait,
  // because telling them the room is unreachable during a wait we know will end
  // is the false report this change exists to remove.
  assert.equal(src.status().state, 'starting')

  await clock.advance(20_500)
  const { leaseId, status } = await pending
  assert.equal(status.listening, true)
  assert.equal(src.status().state, 'listening')
  assert.equal(typeof leaseId, 'string')
  // And the double really did refuse once — otherwise this passes on a source
  // that never had to wait for anything.
  assert.equal(src.control.retryableFailuresRemaining(), 0)
})

test('the retry is BOUNDED: a cooldown longer than the budget fails with the real reason', async (t) => {
  const { source: src, clock } = source(t, {
    // A wait that cannot fit in the 45s budget. Failing now, with the cooldown's
    // own message, beats sleeping through the budget and then reporting a
    // timeout that names the wrong cause.
    development: { startRetryableFailures: 1, retryAfterMs: 90_000 },
  })

  // assert.rejects attaches the handler now, not after the advance.
  const settled = assert.rejects(src.acquire(), /cooldown/i)
  await clock.advance(1)
  await settled
  assert.equal(src.status().listening, false)
})

test('a cooldown that never clears still ends, rather than retrying forever', async (t) => {
  const { source: src, clock } = source(t, {
    development: { startRetryableFailures: 99, retryAfterMs: 10_000 },
  })

  const settled = assert.rejects(src.acquire(), /cooldown/i)
  // Four waits of 10s fit inside the 45s budget; the fifth cannot, so the loop
  // gives up rather than spinning. Advance well past it either way.
  for (let i = 0; i < 8; i += 1) await clock.advance(10_000)
  await settled
  assert.equal(src.status().listening, false)
  // It stopped ASKING, which is the property. Some retries happened (this is not
  // a test that the first attempt failed), and it did not exhaust the 99.
  const left = src.control.retryableFailuresRemaining()
  assert.ok(left < 99, 'no retry happened at all')
  assert.ok(left > 90, `retried ${99 - left} times, which is not bounded`)
})

test('a stop during the wait ends the dial loop as well as the waiter: no second dial, no session nobody holds', async (t) => {
  // JOI-BUTTON-STORY-118 makes this window common: a connect timeout is now
  // retryable too, so a visitor who gives up during a 30s dial or the ~1.25s
  // wait after it lands a stop here. The cooldown shape reaches the same loop
  // and is the one the double can produce.
  const { source: src, clock } = source(t, {
    development: { startRetryableFailures: 1, retryAfterMs: 20_000 },
  })

  // Handler attached before time moves, as everywhere in this file.
  const cancelled = assert.rejects(src.acquire(), /the start was cancelled by a stop/)
  await clock.advance(1)
  // The first dial was refused with the cooldown shape and the loop is now
  // waiting it out — the window this case is about.
  assert.equal(src.status().state, 'starting')
  assert.equal(src.control.startCount(), 1)

  await src.stop({ force: true })
  await cancelled

  // Past the end of the wait AND past the latency of the dial that would follow
  // it. The stop settled the waiter at once, through the race; the loop behind
  // a settled race keeps running, and unguarded it wakes up in here and dials.
  await clock.advance(25_000)

  assert.equal(src.control.startCount(), 1, 'the loop dialled again after the stop, for a session nobody holds')
  assert.equal(
    src.control.isListening(),
    false,
    'a dial made after the stop left the room listening for nobody, and nothing will close it',
  )
  assert.equal(src.status().state, 'stopped')
  assert.equal(src.status().waiters, 0)
})

test('with a linger, the session survives the gap between two visitors', async (t) => {
  const { source: src, clock } = source(t, { lifecycle: { lingerMs: 45_000 } })

  const opening = src.acquire()
  await clock.advance(1)
  const first = await opening
  assert.equal(src.status().listening, true)
  const startsAfterFirst = src.control.startCount()

  // A verifies and lets go. The socket must NOT close yet — that is the whole
  // point of the linger, and it is what keeps B out of the cooldown.
  src.release(first.leaseId)
  await clock.advance(5_000)
  assert.equal(src.status().listening, true, 'the linger did not hold the session open')
  assert.equal(src.status().waiters, 0)

  // B arrives inside the linger and is served by the SAME session: no second
  // start, therefore no cooldown to hit and no wait at all.
  const rejoining = src.acquire()
  await clock.advance(1)
  const second = await rejoining
  assert.equal(src.status().listening, true)
  assert.equal(src.control.startCount(), startsAfterFirst, 'B caused a second start, so the linger bought nothing')
  src.release(second.leaseId)
})

test('the linger ENDS: nobody asking means the socket closes', async (t) => {
  // The other half of the ruling. A linger that never expires is the standing
  // connection the on-demand design exists to avoid, and a test that only proves
  // the session survives would be satisfied by exactly that.
  const { source: src, clock } = source(t, { lifecycle: { lingerMs: 45_000 } })

  const opening = src.acquire()
  await clock.advance(1)
  const held = await opening
  src.release(held.leaseId)
  await clock.advance(46_000)
  assert.equal(src.status().listening, false, 'the session outlived its linger')
  assert.equal(src.status().state, 'stopped')
})

test('a visitor arriving during the linger cancels the close, rather than racing it', async (t) => {
  const { source: src, clock } = source(t, { lifecycle: { lingerMs: 45_000 } })

  const opening = src.acquire()
  await clock.advance(1)
  const first = await opening
  src.release(first.leaseId)
  await clock.advance(44_000)

  const rejoining = src.acquire()
  await clock.advance(1)
  const second = await rejoining
  // Past when the linger WOULD have fired. If acquiring did not cancel it, the
  // pending close lands here and takes the session out from under a live waiter.
  await clock.advance(5_000)
  assert.equal(src.status().listening, true, 'the linger closed the session under a waiter')
  assert.equal(src.status().waiters, 1)
  src.release(second.leaseId)
})
