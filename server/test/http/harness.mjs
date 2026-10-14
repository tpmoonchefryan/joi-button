// SPDX-License-Identifier: MIT
//
// The whole server, assembled the way server.mjs assembles it, driven through
// app.inject(). No socket is bound and no credential exists — which is the point:
// this is the proof that the composition works BEFORE anyone has a Bilibili
// access key.
//
// ===========================================================================
// WHAT IS REAL HERE AND WHAT IS A DOUBLE
// ===========================================================================
// REAL: db/schema.sql on a file-backed SQLite database in WAL, the config that
// assertSafeConfig() cleared, createApp() with @fastify/multipart at the root,
// routes/public.mjs, routes/admin.mjs, lib/catalog.mjs writing onto a real
// directory, lib/audit.mjs, the session cookie app.mjs mints.
//
// DOUBLE: exactly two, and both are the ones the foundation ships for this.
//
//   the danmaku source   mode 'development'. It is DRIVEN, not merely present:
//                        its start latency, its failure mode and its mid-wait
//                        disconnect are set from the tests. "The code is not
//                        shown before the socket is listening" cannot fail
//                        against a source that is listening before you finish
//                        asking — that guard would sit green forever, never
//                        having been evaluated in a world where it could be
//                        false.
// The storage guard is the real filesystem admission path. Tests can replace
// its statfs seam when they need to drive the low-space leg.
//
// ===========================================================================
// WHY THE COOKIE NAME IS NOT PASSED TO routes/admin.mjs
// ===========================================================================
// app.mjs exports SESSION_COOKIE_NAME and routes/admin.mjs carries its own
// DEFAULT_COOKIE_NAME, and app.mjs's header says outright that the two are held
// in step "by this sentence alone" until an integration test logs in and then
// reaches an admin route. This harness deliberately does NOT pass `cookieName`,
// so every admin case in this directory depends on the two constants agreeing;
// change one without the other and the owner is answered 404 by their own
// server, which is exactly the failure that is indistinguishable from a working
// access check. admin-gate.test.mjs states it directly as well.
//
// ===========================================================================
// NOTE ON DISCOVERY
// ===========================================================================
// `npm test` runs `node --test` with no positional, which discovers every file
// under test/ (the runner's `**/test/**/*.{cjs,mjs,js}` pattern), so this
// directory is picked up without being listed anywhere. test/index.js — the
// entry point for the `node --test test/` form — carries a hand-written import
// list that does not name this directory (nor test/routes-public.test.mjs);
// test/http/index.js does the same job for this directory.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../../app.mjs'
import { createDanmakuSource } from '../../lib/danmaku-source.mjs'
import { DEV_ADMIN_OPEN_ID } from '../../lib/dev-admin.mjs'
import { createLoudnessNormalizer } from '../../lib/loudness.mjs'
import { createStorageGuard } from '../../lib/storage-guard.mjs'
import adminRoutes from '../../routes/admin.mjs'
import publicRoutes, { LOGIN_STATES } from '../../routes/public.mjs'
import { createTestClock } from '../helpers/clock.mjs'
import { clearedConfig } from '../helpers/config.mjs'
import { openDatabase } from '../helpers/temp-db.mjs'

export const T0 = '2026-08-01T00:00:00Z'
export const ROOM_ID = 3622717

/** The open_id ADMIN_OPEN_IDS carries in this harness. Nothing else is an admin. */
export const OWNER = Object.freeze({ openId: 'open-owner', displayName: 'Joi' })
export const VISITOR = Object.freeze({ openId: 'open-visitor', displayName: 'Viewer' })

export const LOCALES = Object.freeze(['en-US', 'zh-CN', 'ja-JP'])

/** Three captions, one per locale, so a clip can actually be published. */
export function captions(prefix) {
  return { 'en-US': `${prefix} en`, 'zh-CN': `${prefix} 中`, 'ja-JP': `${prefix} 日` }
}

// ---------------------------------------------------------------------------
// Audio fixtures
//
// Real bytes, built here rather than imported from test/routes-public.test.mjs:
// importing a *.test.mjs file registers a second copy of every test in it. The
// duplication is the cheaper of the two.

/** A RIFF/WAVE file of exactly the requested length, built byte by byte. */
export function wav({ sampleRate = 8000, seconds = 1, channels = 1, bits = 8 } = {}) {
  const blockAlign = channels * (bits / 8)
  const dataLength = Math.round(sampleRate * seconds) * blockAlign
  const buffer = Buffer.alloc(44 + dataLength)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataLength, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bits, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataLength, 40)
  buffer.fill(128, 44)
  return buffer
}

/** `wav()` of a size chosen in bytes rather than in seconds. */
export function wavOfBytes(bytes) {
  const data = Math.max(2, bytes - 44)
  return wav({ sampleRate: 8000, seconds: data / 8000 })
}

// There is deliberately no mp3 or MPEG Layer II fixture here. Classification —
// "container 'MPEG' is not enough, it has to be Layer 3" — is a property of
// routes/public.mjs's own table and is proved where it is written, in
// test/routes-public.test.mjs, against a hand-built Layer II stream. Carrying a
// second copy of those fixtures here would mean two places to keep correct and
// one of them with no case that reads it.

/** A PNG. Not audio, however it is named. */
export const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.alloc(512, 7),
])

// ---------------------------------------------------------------------------
// Multipart

export function multipart(parts) {
  const boundary = `----joihttp${Math.random().toString(36).slice(2)}`
  const chunks = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    chunks.push(
      Buffer.from(
        part.filename === undefined
          ? `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`
          : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            'Content-Type: application/octet-stream\r\n\r\n',
      ),
    )
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value)))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * A multipart POST.
 *
 * The cookie and the content-type are assembled in ONE place on purpose:
 * spreading a multipart result over a `headers` object silently replaces the
 * boundary, which costs a test its session and reports it as identity_required.
 */
export function postForm(app, url, { cookie, headers: extraHeaders = {}, parts }) {
  const body = multipart(parts)
  const headers = { ...extraHeaders, 'content-type': body.contentType }
  if (cookie !== undefined) headers.cookie = cookie
  return app.inject({ method: 'POST', url, headers, payload: body.payload })
}

export function postJson(app, url, { cookie, headers: extraHeaders = {}, body = {} } = {}) {
  const headers = { ...extraHeaders, 'content-type': 'application/json' }
  if (cookie !== undefined) headers.cookie = cookie
  return app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) })
}

export function get(app, url, { cookie, headers: extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders }
  if (cookie !== undefined) headers.cookie = cookie
  return app.inject({ method: 'GET', url, headers })
}

export function cookieOf(response) {
  const raw = response.headers['set-cookie']
  const one = Array.isArray(raw) ? raw[0] : raw
  return one === undefined ? null : one.split(';')[0]
}

/** The submission metadata field, as the client sends it. */
export const metadata = (items) => ({ name: 'metadata', value: JSON.stringify({ items }) })

export const anItem = (overrides = {}) => ({
  key: 'a',
  name: 'Clip A',
  caption: { locale: 'zh-CN', text: '测试' },
  groupId: 'voices-core',
  ...overrides,
})

// ---------------------------------------------------------------------------
// The server

/**
 * captureLog({ level }) -> { logger, lines }
 *
 * For boot()'s `logger`: what the server would have logged, as the objects a
 * production log line is made of.
 *
 * pino OPTIONS rather than a hand-rolled logger object, on purpose. server.mjs
 * passes options too (`logger: { level }`), so fastify builds the same pino
 * instance with the same serializers — `err` comes out as type, message, stack
 * and the error's own enumerable fields, exactly as it would in production —
 * and only the destination differs. A test asserting that a line does not
 * carry a credential is then asserting it about what production writes, not
 * about what a stand-in happened to keep. 'info' by default because that is
 * the level the deployment runs at.
 */
export function captureLog({ level = 'info' } = {}) {
  const lines = []
  const stream = {
    write(chunk) {
      lines.push(JSON.parse(chunk))
    },
  }
  return { logger: { level, stream }, lines }
}

/**
 * boot(t, options) -> { app, db, clock, danmaku, storageGuard, paths, config, report }
 *
 * Every step is in the order server.mjs puts it in, and the order is the whole
 * point of that file: the guard needs the migrated database (it reads
 * instance.mode out of it), and the development sources need the guard (they
 * refuse to construct from a config it has not cleared).
 *
 * `logger` goes to createApp as given; false (the default) logs nothing. Pass
 * captureLog().logger to read what was logged.
 */
export async function boot(t, {
  roomId = ROOM_ID,
  maxFileBytes,
  maxClipsPerBatch,
  adminOpenIds = [OWNER.openId],
  devAdminBypass = false,
  storageGuard: suppliedStorageGuard,
  logger = false,
} = {}) {
  // 1. the database, stamped 'development' — the mark the guard reads and the
  //    mark schema.sql's bypass triggers consult. It is a one-way ratchet, so a
  //    database that has ever been production could not be talked back down into
  //    this fixture.
  const db = openDatabase(t, { mode: 'development', now: T0 })

  const dataDir = mkdtempSync(join(tmpdir(), 'joi-http-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const paths = Object.freeze({
    dataDir,
    mediaDir: join(dataDir, 'media'),
    catalogFile: join(dataDir, 'catalog.json'),
    // Laid out exactly as config.mjs derives it from DATA_DIR: a SIBLING of
    // media/, because the web pod publishes media/ and staging inside it would
    // put in-flight uploads on the public site. Tests assert the emptiness of
    // this directory, so the layout has to be the real one.
    stagingDir: join(dataDir, 'incoming'),
    themeCssFile: join(dataDir, 'theme.css'),
    wallpaperDir: join(dataDir, 'wallpaper'),
  })

  const clock = createTestClock(T0)

  const limits = {}
  if (maxClipsPerBatch !== undefined) limits.maxClipsPerBatch = maxClipsPerBatch
  if (maxFileBytes !== undefined) limits.maxFileBytes = maxFileBytes

  // 2. the guard. `db` rather than an instanceMode string: the process and the
  //    database file then derive production-ness from one fact instead of two
  //    that can disagree.
  const { config, report } = clearedConfig(
    {
      storage: {
        dataDir: paths.dataDir,
        mediaDir: paths.mediaDir,
        catalogFile: paths.catalogFile,
        stagingDir: paths.stagingDir,
        themeCssFile: paths.themeCssFile,
        wallpaperDir: paths.wallpaperDir,
      },
      limits,
      danmaku: {
        mode: 'development',
        codeTtlMinutes: 10,
        clock,
        ...(roomId === null ? {} : { roomId }),
      },
    },
    { db, instanceMode: undefined },
  )

  // createApp asks for two sections env-guard's roster does not cover. Spread
  // rather than mutate: assertSafeConfig deep-froze what it cleared, and the
  // section objects below are the same references the sources were cleared for.
  const effectiveAdminOpenIds = devAdminBypass
    ? [...new Set([...adminOpenIds, DEV_ADMIN_OPEN_ID])]
    : [...adminOpenIds]
  const whole = Object.freeze({
    ...config,
    storage: { ...config.storage, dataDir: paths.dataDir },
    nodeEnv: 'development',
    server: { trustProxy: false, logLevel: 'silent' },
    session: { secret: 'test-session-secret-'.padEnd(48, 'x'), ttlHours: 336, allowPlainHttp: true },
    admin: { openIds: effectiveAdminOpenIds },
  })

  // 3. the sources and storage guard.
  const danmaku = createDanmakuSource(config.danmaku)
  const storageGuard = suppliedStorageGuard ?? createStorageGuard({ dataDir: paths.dataDir, now: clock.now })
  // The real normalizer, same as production: the http harness exercises the
  // submission route end to end, so a stand-in here would prove less than the
  // process it stands for. ffmpeg is present in the API image and on a dev
  // machine that can run this suite at all.
  const normalizer = createLoudnessNormalizer()

  const app = createApp({
    config: whole,
    db,
    danmaku,
    storageGuard,
    logger,
    report,
    devAdminBypass,
    routes: [
      {
        plugin: publicRoutes,
        options: {
          db,
          config: whole,
          adminOpenIds: effectiveAdminOpenIds,
          devAdminBypass,
          danmakuSource: danmaku,
          storageGuard,
          normalizer,
          now: clock.now,
        },
      },
      {
        // No cookieName, deliberately — see the header.
        plugin: adminRoutes,
        options: {
          db,
          adminOpenIds: effectiveAdminOpenIds,
          // All four keys, the way server.mjs passes them. It used to be two,
          // and routes/admin.mjs would then DERIVE the theme paths from
          // dirname(catalogFile) — which in this harness's layout lands on the
          // same directory, so no test through boot() could tell the wired world
          // from the derived one. Passing all four means a future regression in
          // adminStoragePaths is at least representable here, rather than
          // needing the one test that builds a divergent tree by hand.
          paths: {
            catalogFile: paths.catalogFile,
            mediaDir: paths.mediaDir,
            themeCssFile: paths.themeCssFile,
            wallpaperDir: paths.wallpaperDir,
          },
          storageGuard,
          storageWorstCaseBytes: whole.limits.maxFileBytes,
          // The same source the public plugin got, so admin-invite tests through
          // boot() exercise the real room orchestration rather than a stub.
          danmakuSource: danmaku,
          roomId: whole.danmaku.roomId,
          codeTtlMinutes: whole.danmaku.codeTtlMinutes,
          now: clock.now,
        },
      },
    ],
  })
  await app.ready()
  t.after(() => app.close())

  return { app, db, clock, danmaku, storageGuard, paths, config: whole, report }
}

/**
 * Obtain an identity the only way this site issues one: ask for a code, wait
 * until the room session is really listening, and send the code as a danmaku.
 *
 * The two assertions inside are not decoration. They are what makes every later
 * test's premise true rather than assumed: if a code were ever handed over
 * before the socket was listening, every fixture in this directory would be
 * built on a code nobody could have used.
 */
export async function login(ctx, { openId, displayName = openId } = {}) {
  const started = await ctx.app.inject({ method: 'POST', url: '/api/login/start' })
  assert.equal(started.statusCode, 200, started.payload)
  assert.equal(started.json().code, undefined, 'a code was issued before the socket was listening')
  const cookie = cookieOf(started)
  assert.ok(cookie, 'no session cookie was set by /api/login/start')

  await ctx.clock.advance(1)
  const live = (await get(ctx.app, '/api/login/status', { cookie })).json()
  assert.equal(live.state, LOGIN_STATES.WAITING, `no code was issued: ${JSON.stringify(live)}`)

  ctx.danmaku.control.emitDanmaku({ openId, displayName, text: live.code })
  // Let the release that the verification triggers finish before anything else
  // touches the source, so the next login opens a socket rather than racing a
  // close that is still unwinding.
  await ctx.clock.advance(1)

  const me = (await get(ctx.app, '/api/me', { cookie })).json()
  assert.equal(me.submitter?.openId, openId, 'the danmaku did not bind an identity to the session')
  return cookie
}

/**
 * A group that already exists, with a caption in every locale.
 *
 * Written with SQL rather than through a route because there is no
 * group-creation route: a group is minted by approving an item into a new one,
 * which is a thing the review tests do explicitly. This stands in for the
 * catalogue that predates the system.
 */
export function seedGroup(db, { id, displayName, sortOrder = 0, now = T0 }) {
  db.prepare('INSERT INTO groups (id, display_name, sort_order, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    displayName,
    sortOrder,
    now,
  )
  const insert = db.prepare(
    'INSERT INTO group_captions (group_id, locale, text, updated_at) VALUES (?, ?, ?, ?)',
  )
  for (const locale of LOCALES) insert.run(id, locale, `${displayName} ${locale}`, now)
  return id
}

/** Every audit action appended since `before`, oldest first. */
export function auditSince(db, before) {
  return db
    .prepare('SELECT seq, id, action, actor_id, subject_kind, subject_id, detail FROM audit_log WHERE seq > ? ORDER BY seq')
    .all(before)
}

export function auditHigh(db) {
  return db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM audit_log').get().seq
}
