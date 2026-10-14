// SPDX-License-Identifier: MIT
//
// The HTTP surface: a configured fastify instance that is NOT listening.
//
// createApp() takes everything it needs as arguments and constructs none of it.
// That is what lets a test drive the whole surface against a temporary database
// and a programmable danmaku double, and it is also the ownership rule: this
// file never closes the database and never stops the room session, because it
// did not open them. server.mjs owns those.
//
// WHY THE GUARD REPORT IS AN ARGUMENT, AND WHAT ITS ABSENCE MEANS.
// `report` is what assertSafeConfig() returned. Two things here need it, and
// neither can be derived a second time without inventing a second answer to a
// question env-guard has already answered:
//
//   1. the bypass banner. env-guard's own header states the contract an HTTP
//      layer owes it: when report.banner is not null, set the header on EVERY
//      response and serve the banner in the health document. Until this file
//      existed, nothing did — the comment there says so in as many words.
//   2. the Secure attribute on the session cookie.
//
// When `report` is absent the deployment is treated as PRODUCTION: banner off,
// Secure on. That is not a guess dressed as a default — it is env-guard's own
// rule that a permissive environment must be asserted rather than inferred from
// silence. A test that hands over the five documented arguments and no report
// therefore gets the strict answer.
//
// HOW THE LOCAL-DEV COOKIE EXCEPTION CANNOT LEAK INTO PRODUCTION.
// A cookie without Secure is sent over plain HTTP, so it is readable by anything
// on the path. Local development over http://localhost needs exactly that, and
// the request for it (DEV_PLAIN_HTTP, config.session.allowPlainHttp) is a plain
// boolean an operator can set anywhere. What makes it safe is that it is not
// consulted alone: the effective value is
//
//     secure = report.production ? true : !config.session.allowPlainHttp
//
// and `report.production` is the OR of NODE_ENV === 'production', the database's
// own instance.mode === 'production', and "the mode could not be read at all".
// So reaching the insecure branch requires NODE_ENV to be something other than
// production AND the database file itself to be stamped 'development' — a mark
// migrate() writes and a trigger in schema.sql ratchets one way, so a database
// that has ever been production can never be talked back down. Setting the flag
// on a production deployment does not weaken the cookie; it does nothing at all.
//
// THE COOKIE NAME IS THE SAME IN BOTH, AND THAT IS A DECISION.
// The obvious upgrade is the `__Host-` prefix, which browsers enforce: Secure,
// Path=/, no Domain, so no sibling subdomain and nothing on plain HTTP can write
// it. It was not taken, because the prefix requires Secure and would therefore
// make the cookie's NAME depend on the deployment — and the name is not private
// to this file. routes/admin.mjs resolves an identity from a cookie it looks up
// BY NAME, with 'joi_session' as its default. A name that is right on a laptop
// and wrong in production would make the admin gate answer 404 to its owner,
// which that file's own comment points out is indistinguishable from a working
// access check. One stable name, plus Secure, plus Path=/ and no Domain (which
// already makes the cookie host-only), is the trade this deployment is worth.
//
// WHAT THE SIGNATURE BUYS, AND WHAT IT DOES NOT.
// The credential is 32 bytes from randomBytes; nobody can produce a value whose
// sha256 matches a stored session row without having been given it, signed or
// not. The HMAC buys exactly one thing: a cookie that this process did not mint
// is refused without a database query. That is worth having — it is the
// difference between a junk-cookie flood costing an HMAC each and costing a
// lookup each — but it is not what makes a session unforgeable. The entropy is.
//
// So the whole cookie value, signature included, is what sessions.token_sha256
// holds the sha256 of. That keeps one string in play instead of two, and it
// means anything that hashes the raw cookie value — routes/admin.mjs's default
// identity resolver does exactly that — finds the same row this file would.
//
// ---------------------------------------------------------------------------
// WHAT MAKES THIS GO RED
//
//   * Default `report` to a permissive value (`report = { production: false }`)
//     — the "no report means Secure" case goes red.
//   * Drop the `production ||` from the cookie decision, or read
//     allowPlainHttp on its own — the "DEV_PLAIN_HTTP is inert in production"
//     case goes red.
//   * Change SESSION_COOKIE_NAME without changing routes/admin.mjs's
//     DEFAULT_COOKIE_NAME — nothing here goes red, and that is the point of
//     saying it: the case that would catch it is an integration test that logs
//     in and then reaches an admin route, and until one exists these two
//     constants are held in step by this sentence alone.
//   * Compare the cookie signature with === instead of timingSafeEqual — no test
//     can prove that red, and saying so is the point: this one is not covered by
//     a case, it is covered by review. Do not add a timing test; a timing test on
//     a shared CI runner is a flake generator, not a gate.
//   * Let the database probe read instead of write (a SELECT instead of the
//     UPDATE below) — the "readiness goes red on a read-only volume" case goes
//     red, because a read-only SQLite file answers a SELECT perfectly.
//   * Fold roomSession into the readiness decision — the "the room session is
//     absent by design and readiness stays green" case goes red. That case is
//     the whole reason the three checks are separate: the session is started ON
//     DEMAND, so for most of any given day the honest answer is "nobody has
//     asked for one", and a readiness probe that read that as a fault would
//     restart a pod for behaving exactly as ruled.
//   * Set multipart's `parts` limit below files + fields — an over-numerous
//     batch then trips FST_PARTS_LIMIT instead of FST_FILES_LIMIT and the
//     submitter is told about a rule they have never heard of instead of the
//     ruled 10-clip cap.
//   * Return the fastify default body for a multipart refusal — the "the
//     refusal names which rule was broken, and its number" case goes red.
//   * Drop the `req` serializer resolveLogger adds, or let requestLogValue pass
//     the url through whole — the "the poll token is on no line at all" and
//     "every request line keeps method and path and loses the query string"
//     cases go red.
//   * Stop subscribing to the danmaku source's 'error' event — the "a danmaku
//     the source cannot read is logged" case goes red; log what it emits as it
//     is instead of through sourceErrorLogFields — the "named fields only"
//     case goes red.
//   * Drop the unsubscribe from the onClose hook — the "a closed app writes no
//     more source errors" case goes red; subscribe before the routes are
//     checked — the "refuses its routes leaves no subscription" case goes red.
// ---------------------------------------------------------------------------

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import Fastify from 'fastify'
import multipart from '@fastify/multipart'

import { readSchemaStamp, toCanonicalTimestamp } from './db/migrate.mjs'
import { DEV_ADMIN_DISPLAY_NAME, DEV_ADMIN_OPEN_ID } from './lib/dev-admin.mjs'

/**
 * Non-file form fields allowed in one request, and the size of one.
 *
 * A batch carries at most 10 clips and a handful of fields each (label, group,
 * note). 64 is roomy; 8 KiB per field is far above the
 * 80 code points text-safety.mjs allows in a caption and the 500 characters
 * batch_items.submitter_note allows, and far below anything that could be used
 * to push memory around.
 */
const MAX_FIELDS = 64
const MAX_FIELD_BYTES = 8 * 1024

/**
 * Non-multipart bodies (JSON). Deliberately small: every JSON body this API
 * accepts is a handful of ids and short strings. Uploads do not come through
 * here — @fastify/multipart is given its own fileSize limit below, so this
 * number never caps a clip.
 */
const JSON_BODY_LIMIT = 64 * 1024

/**
 * One name, in every deployment. routes/admin.mjs carries the same string as its
 * DEFAULT_COOKIE_NAME and looks the cookie up by it; see the header for why the
 * `__Host-` prefix, which would have made this name depend on the environment,
 * was refused.
 */
export const SESSION_COOKIE_NAME = 'joi_session'

/**
 * Typed refusals, mapped onto answers a submitter can act on.
 *
 * Each entry says WHICH rule was broken and what its number is, because "413
 * Payload Too Large" on a ten-file form does not tell anyone whether one file
 * was too big or there were too many of them. `limit` is read from the live
 * config, so the number in the message is the number the framework enforced.
 *
 * Messages are plain prose on purpose: no braces, no pipe, no '@:' — the
 * frontend renders through vue-i18n, where those are interpolation, a plural
 * separator and a linked message. The stable `code` is what a translation is
 * keyed on; the message is for a human reading a log or a curl.
 */
const REFUSALS = Object.freeze({
  // @fastify/multipart
  FST_REQ_FILE_TOO_LARGE: (config) => ({
    status: 413,
    code: 'file_too_large',
    rule: 'maxFileBytes',
    limit: config.limits.maxFileBytes,
    message: `A file in this submission is larger than the per-file limit of ${config.limits.maxFileBytes} bytes.`,
  }),
  FST_FILES_LIMIT: (config) => ({
    status: 413,
    code: 'too_many_files',
    rule: 'maxClipsPerBatch',
    limit: config.limits.maxClipsPerBatch,
    message: `A submission may carry at most ${config.limits.maxClipsPerBatch} clips.`,
  }),
  FST_FIELDS_LIMIT: () => ({
    status: 413,
    code: 'too_many_fields',
    rule: 'maxFields',
    limit: MAX_FIELDS,
    message: `A submission may carry at most ${MAX_FIELDS} form fields.`,
  }),
  FST_PARTS_LIMIT: (config) => ({
    status: 413,
    code: 'too_many_parts',
    rule: 'maxParts',
    limit: config.limits.maxClipsPerBatch + MAX_FIELDS,
    message: 'This submission carried more form parts than the files and fields limits allow together.',
  }),
  FST_INVALID_MULTIPART_CONTENT_TYPE: () => ({
    // The plugin raises this as 406. 415 is the honest code: 406 is about the
    // Accept header, and nothing here is negotiating a response format.
    status: 415,
    code: 'not_multipart',
    rule: 'contentType',
    limit: null,
    message: 'This endpoint takes a multipart form-data body.',
  }),
  FST_INVALID_JSON_FIELD_ERROR: () => ({
    status: 400,
    code: 'malformed_json_field',
    rule: 'contentType',
    limit: null,
    message: 'A form field declared itself as JSON and did not parse as JSON.',
  }),
  FST_PROTO_VIOLATION: () => ({
    status: 400,
    code: 'reserved_field_name',
    rule: 'fieldName',
    limit: null,
    message: 'A form field used a reserved name.',
  }),
  FST_MP_PREMATURE_CLOSE: () => ({
    status: 400,
    code: 'upload_interrupted',
    rule: 'transfer',
    limit: null,
    message: 'The connection closed before the whole submission arrived. Nothing was kept.',
  }),
  // fastify core
  FST_ERR_CTP_BODY_TOO_LARGE: () => ({
    status: 413,
    code: 'body_too_large',
    rule: 'jsonBodyLimit',
    limit: JSON_BODY_LIMIT,
    message: `A non-upload request body may be at most ${JSON_BODY_LIMIT} bytes.`,
  }),
  FST_ERR_CTP_INVALID_MEDIA_TYPE: () => ({
    status: 415,
    code: 'unsupported_media_type',
    rule: 'contentType',
    limit: null,
    message: 'This endpoint does not accept that content type.',
  }),
  FST_ERR_CTP_EMPTY_JSON_BODY: () => ({
    status: 400,
    code: 'empty_body',
    rule: 'body',
    limit: null,
    message: 'The request declared a JSON body and sent nothing.',
  }),
})

/**
 * createApp({ config, db, danmaku, storageGuard, logger, report, routes })
 *
 * Returns a fastify instance with everything registered and no socket bound.
 * Plugin registration is queued, as fastify does: await app.ready() (or the
 * first app.inject()) before reaching for a decorator a plugin adds.
 *
 * @param {object}   config    from config.mjs, after assertSafeConfig froze it
 * @param {object}   db        an open better-sqlite3 handle, already migrated
 * @param {object}   danmaku   createDanmakuSource(config.danmaku)
 * @param {object}   storageGuard shared-volume admission guard
 * @param {object}   [logger]  a pino instance, a pino options object, or false
 * @param {object}   [report]  what assertSafeConfig returned; absent reads as production
 * @param {Array<Function|{plugin: Function, options?: object}>} [routes]
 *        The seam later stories register their routes through — and what lets a
 *        test drive a route that consumes a multipart body, so the limits below
 *        can be proven to refuse something. Plugins that need arguments come as
 *        { plugin, options }, which is the shape routes/admin.mjs asks for:
 *
 *          routes: [{ plugin: adminRoutes, options: {
 *            db,
 *            adminOpenIds: config.admin.openIds,
 *            paths: { catalogFile: config.storage.catalogFile,
 *                     mediaDir: config.storage.mediaDir },
 *            cookieName: SESSION_COOKIE_NAME,
 *          } }]
 * @param {boolean} [devAdminBypass]  inject a local admin session in development only
 */
export function createApp({
  config,
  db,
  danmaku,
  storageGuard,
  logger,
  report = null,
  routes = [],
  devAdminBypass = false,
} = {}) {
  requireArgument(config, 'config')
  requireArgument(db, 'db')
  requireArgument(danmaku, 'danmaku')
  requireArgument(storageGuard, 'storageGuard')
  // Named, because the alternative is a TypeError from deep inside a plugin
  // registration that says only "cannot read properties of undefined". The
  // config the entry point builds always has all four; a hand-built one in a
  // test may not.
  requireSections(config, ['server', 'limits', 'session', 'storage'])

  const banner = report?.banner ?? null
  // Absent report reads as production. See the header: this is the same rule
  // env-guard applies to an unstated deployment mode, for the same reason.
  const production = report === null ? true : report.production === true

  if (devAdminBypass && (production || report?.nodeEnv !== 'development')) {
    throw new Error('createApp: devAdminBypass is only valid for a development report')
  }

  const app = Fastify({
    ...resolveLogger(logger, config),
    bodyLimit: JSON_BODY_LIMIT,
    // Never `true`. See config.mjs: with trustProxy true, request.ip becomes the
    // leftmost X-Forwarded-For entry, which the client writes — and that address
    // is what an external identity verifier would receive as the address that
    // completed the verification.
    trustProxy: config.server.trustProxy ?? false,
  })

  const sessionCookie = createSessionCookie({
    secret: config.session.secret,
    secure: production || !config.session.allowPlainHttp,
    ttlHours: config.session.ttlHours,
  })

  // A local acceptance server should open the desk directly. It still uses the
  // normal signed session row and cookie, so /api/me, public routes and the
  // admin gate exercise the same path as a real session. The switch is passed
  // only by server.mjs after env-guard has established NODE_ENV=development.
  const devSession = devAdminBypass
    ? createDevelopmentAdminSession(db, sessionCookie, config.session.ttlHours)
    : null

  app.decorate('config', config)
  app.decorate('db', db)
  app.decorate('danmaku', danmaku)
  app.decorate('storageGuard', storageGuard)
  app.decorate('sessionCookie', sessionCookie)
  app.decorate('guardReport', report)

  if (devSession !== null) {
    app.addHook('onRequest', async (request, reply) => {
      // Always prefer the local session in this explicitly local-only mode. It
      // also repairs a stale cookie left by an earlier dev server instance.
      if (sessionCookie.read(request) === devSession.token) return
      request.headers.cookie = replaceCookie(request.headers.cookie, sessionCookie.name, devSession.token)
      sessionCookie.set(reply, devSession.token)
    })
  }

  // Uploads never touch disk here: no route calls saveRequestFiles(), so the
  // only bytes that exist are the ones a route reads out of the stream — and
  // busboy stops feeding that stream the moment fileSize is exceeded, which is
  // what makes "refused before it is stored" true rather than aspirational.
  app.register(multipart, {
    limits: {
      fileSize: config.limits.maxFileBytes,
      files: config.limits.maxClipsPerBatch,
      fields: MAX_FIELDS,
      fieldSize: MAX_FIELD_BYTES,
      // At least files + fields, or an over-numerous batch trips the parts limit
      // first and the submitter is told about a rule they have never heard of
      // instead of the ruled 10-clip cap.
      parts: config.limits.maxClipsPerBatch + MAX_FIELDS,
    },
    throwFileSizeLimit: true,
  })

  app.addHook('onSend', async (request, reply, payload) => {
    // Nothing this API answers is cacheable: it is all per-session or
    // per-moment. The published catalogue is a static file served by the web
    // pod, and that is the thing with cache headers.
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    if (banner !== null) {
      // env-guard's contract: EVERY response, so that no reply from a bypassed
      // build can be mistaken for one from a real one.
      reply.header(banner.httpHeader.name, banner.httpHeader.value)
    }
    return payload
  })

  registerHealthRoutes(app, { config, db, danmaku, storageGuard, banner, startedAt: new Date() })

  for (const route of routes) {
    if (typeof route === 'function') {
      app.register(route)
      continue
    }
    if (route !== null && typeof route === 'object' && typeof route.plugin === 'function') {
      // No prefix is added here, ever. routes/admin.mjs refuses one at
      // registration because its routes carry their full paths; a caller that
      // wants one has to say so in its own options.
      app.register(route.plugin, route.options ?? {})
      continue
    }
    throw new TypeError(
      'createApp: every entry in `routes` must be a fastify plugin function, or { plugin, options }',
    )
  }

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: 'No route matches this method and path.' },
      requestId: request.id,
    })
  })

  app.setErrorHandler((error, request, reply) => {
    const refusal = describeRefusal(error, config)
    if (refusal !== null) {
      request.log.info({ err: error, rule: refusal.rule }, 'request refused by a limit')
      reply.code(refusal.status).send({
        error: {
          code: refusal.code,
          rule: refusal.rule,
          limit: refusal.limit,
          message: refusal.message,
        },
        requestId: request.id,
      })
      return
    }

    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500
    if (status >= 500) {
      // The message is logged and never sent: a 500 message is an internal
      // detail, and this one has a database path in it often enough to matter.
      request.log.error({ err: error }, 'unhandled error')
      reply.code(500).send({
        error: { code: 'internal_error', message: 'The request could not be completed.' },
        requestId: request.id,
      })
      return
    }

    request.log.info({ err: error }, 'request rejected')
    reply.code(status).send({
      error: {
        code: typeof error.code === 'string' ? error.code : 'bad_request',
        message: error.message,
        ...(error.validation ? { details: error.validation } : {}),
      },
      requestId: request.id,
    })
  })

  // The room source's 'error' event, written down (JOI-BUTTON-STORY-120). It is
  // where the source sends every failure it has nobody to return to — a frame
  // it could not read, a heartbeat that threw, a session it could not end, a
  // listener that threw — and until this subscription nothing listened, so none
  // of them reached the log; at most a counter moved. 'danmaku' is in the
  // message for the reason routes/public.mjs gives for its dial lines: the
  // operator's check is `kubectl logs … | grep danmaku`.
  //
  // Through sourceErrorLogFields() and nothing else, because the payload can be
  // anything a listener threw. Here and not in server.mjs, because server.mjs
  // hands this function the very source it runs and only this side has a test
  // seam. Last, after everything above that can throw: a createApp that throws
  // returns no app to close, and a subscription made before the throw would
  // outlive it. The subscription leaves on close; the source does not stop — it
  // is not this file's to stop (see the header).
  const unsubscribeSourceErrors = danmaku.on('error', (error) => {
    app.log.error({ err: sourceErrorLogFields(error) }, 'danmaku source error')
  })
  app.addHook('onClose', async () => {
    unsubscribeSourceErrors()
  })

  return app
}

// ---------------------------------------------------------------------------
// health
//
// Three separate facts, and they are separate because they fail separately:
//
//   process alive     the only thing a liveness probe may read. It is answered
//                     by answering at all, and it deliberately does NOT touch
//                     the database — a liveness probe that goes red on a
//                     database fault restarts a process that a restart cannot
//                     repair, turning a full disk into a crash loop.
//   database writable readiness. Not "openable", not "readable": a read-only
//                     mount and a full volume both answer SELECT perfectly, so
//                     the probe writes.
//   room session      reported, never counted. It is started ON DEMAND when a
//                     visitor asks for a code and stopped on success or at the
//                     ruled 10-minute expiry, so "absent" is its normal state
//                     and folding it into readiness would take the pod out of
//                     service for behaving as designed.

function registerHealthRoutes(app, { config, db, danmaku, storageGuard, banner, startedAt }) {
  app.get('/api/healthz', async () => ({
    status: 'ok',
    check: 'process',
    uptimeSeconds: Math.floor(process.uptime()),
    startedAt: toCanonicalTimestamp(startedAt),
    checkedAt: toCanonicalTimestamp(new Date()),
  }))

  app.get('/api/readyz', async (request, reply) => {
    const database = probeDatabase(db, request.log)
    const ready = database.status === 'ok'
    reply.code(ready ? 200 : 503)
    return {
      status: ready ? 'ok' : 'error',
      // The checks readiness is made of, named in the payload so that "the room
      // session is not one of them" is a fact a reader can see rather than a
      // claim in a comment.
      readiness: ['process', 'database'],
      checks: { process: { status: 'ok' }, database },
      checkedAt: toCanonicalTimestamp(new Date()),
    }
  })

  app.get('/api/health', async (request, reply) => {
    const database = probeDatabase(db, request.log)
    const storage = await storageGuard.snapshot()
    const ready = database.status === 'ok'
    reply.code(ready ? 200 : 503)
    return {
      status: ready ? 'ok' : 'error',
      readiness: ['process', 'database'],
      checks: {
        process: {
          status: 'ok',
          uptimeSeconds: Math.floor(process.uptime()),
          startedAt: toCanonicalTimestamp(startedAt),
        },
        database,
        roomSession: describeRoomSession(danmaku),
      },
      storage,
      limits: {
        maxClipsPerBatch: config.limits.maxClipsPerBatch,
        maxFileBytes: config.limits.maxFileBytes,
      },
      // Null on a healthy production instance. When it is not null this build is
      // running with an identity bypass, and saying so in the
      // health document is half of the contract env-guard's buildBanner sets out
      // — the X-Joi-Bypass header on every response is the other half.
      banner,
      checkedAt: toCanonicalTimestamp(new Date()),
    }
  })
}

/**
 * Writability, proved by writing.
 *
 * The write is a no-op UPDATE of the single `instance` row inside a savepoint
 * that is always rolled back, so the probe changes nothing and leaves no row
 * behind. It is an UPDATE and not a SELECT because the failures worth catching —
 * a read-only remount, a full volume, a database another process has locked —
 * are all invisible to a read.
 *
 * `changes === 0` is red too: the row is seeded by schema.sql and stamped by
 * migrate(), so its absence means this file is not the database this process
 * thinks it is.
 *
 * instance.mode is deliberately NOT reported. schema.sql keeps it out of
 * schema_version precisely because schema_version is published and the
 * deployment mode must not be; a health document is published in the same sense.
 */
function probeDatabase(db, log) {
  const result = { status: 'error', writable: false, schemaVersion: null, minCompatibleVersion: null, code: null }

  if (!db.open) {
    result.code = 'DATABASE_CLOSED'
    return result
  }

  const savepoint = 'health_writable_probe'
  try {
    const stamp = readSchemaStamp(db)
    result.schemaVersion = stamp?.version ?? null
    result.minCompatibleVersion = stamp?.minCompatibleVersion ?? null

    db.exec(`SAVEPOINT ${savepoint}`)
    try {
      const info = db.prepare('UPDATE instance SET created_at = created_at WHERE id = 1').run()
      result.writable = info.changes === 1
      result.status = info.changes === 1 ? 'ok' : 'error'
      if (info.changes !== 1) result.code = 'INSTANCE_ROW_MISSING'
    } finally {
      // Swallowed on purpose: whatever went wrong, the error worth reporting is
      // the one from the statement, and a failed rollback must not replace it.
      try {
        db.exec(`ROLLBACK TO ${savepoint}`)
        db.exec(`RELEASE ${savepoint}`)
      } catch {
        /* nothing left to unwind */
      }
    }
  } catch (error) {
    // The CODE, not the message: a health document is reachable from outside and
    // a SQLite message can carry the path of the database file. The full error
    // goes to the log, which is where a path belongs.
    result.status = 'error'
    result.writable = false
    result.code = typeof error?.code === 'string' ? error.code : 'DATABASE_ERROR'
    log?.error({ err: error }, 'database health probe failed')
  }

  return result
}

/**
 * The room session, described honestly.
 *
 * `expected` is the whole point: with no waiter holding a lease there is nothing
 * to be listening for, and "not listening" is then the correct state rather than
 * a fault. Only when somebody is waiting does a source that is not listening
 * mean anything at all.
 *
 * lastError is reported as a TIME and not as text. The message is ours today,
 * but the production transport (STORY-010) will put an upstream's words in it,
 * and an upstream's words can carry a host or a token. The text is in the log.
 */
function describeRoomSession(danmaku) {
  let status
  try {
    status = danmaku.status()
  } catch {
    return { status: 'unknown', onDemand: true, expected: false, waiters: 0, listening: false, lastErrorAt: null }
  }

  const expected = status.waiters > 0
  return {
    // The source's own state word, not a re-derived verdict: danmaku-source.mjs
    // owns that vocabulary and a second one here could disagree with it.
    status: status.state,
    onDemand: true,
    expected,
    // "Are we serving everyone who is waiting?" — false only when somebody is
    // actually waiting and we are not listening. This is reported, not counted:
    // see readiness above.
    serving: !expected || status.listening,
    waiters: status.waiters,
    listening: status.listening,
    listeningSince: status.listeningSince,
    lastErrorAt: status.lastError?.at ?? null,
  }
}

// ---------------------------------------------------------------------------
// session cookie

/**
 * createSessionCookie({ secret, secure, ttlHours })
 *
 * One value travels: 32 random bytes and an HMAC of them, joined by a dot. That
 * whole string is the cookie, and sha256 OF THAT WHOLE STRING is what
 * sessions.token_sha256 holds — schema.sql's "the cookie value is never stored,
 * only its sha256", taken literally, so that a leaked backup hands over no live
 * session and so that two modules hashing "the cookie" get the same 64
 * characters. See the header for what the signature is and is not for.
 *
 * The crypto is separated from the request/reply wrappers on purpose: mint,
 * hash, verify and parse are all callable without an HTTP request, so they can
 * be tested where they are written rather than through an endpoint.
 */
export function createSessionCookie({ secret, secure, ttlHours }) {
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('createSessionCookie: a session secret is required; an unsigned session cookie is a forgeable one')
  }
  const name = SESSION_COOKIE_NAME
  const maxAgeSeconds = Math.floor(ttlHours * 3600)

  const signatureFor = (token) => createHmac('sha256', secret).update(token, 'utf8').digest('base64url')

  /**
   * A fresh cookie value: token and signature, both base64url, so the result
   * needs no encoding to be a legal cookie value.
   */
  function mint() {
    const token = randomBytes(32).toString('base64url')
    return `${token}.${signatureFor(token)}`
  }

  /** What sessions.token_sha256 holds for a value: 64 lowercase hex characters. */
  function hash(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex')
  }

  /**
   * Was this value minted here?
   *
   * timingSafeEqual, and the length check before it is not a shortcut past the
   * comparison — timingSafeEqual THROWS on buffers of different lengths, so a
   * mismatch has to be answered before it is called.
   */
  function verify(value) {
    if (typeof value !== 'string') return false
    const cut = value.lastIndexOf('.')
    if (cut <= 0) return false
    const presented = Buffer.from(value.slice(cut + 1), 'base64url')
    const expected = Buffer.from(signatureFor(value.slice(0, cut)), 'base64url')
    if (presented.length !== expected.length) return false
    return timingSafeEqual(presented, expected)
  }

  /**
   * The cookie value if it carries our signature, else null.
   *
   * First occurrence wins, matching routes/admin.mjs: a second cookie of the
   * same name injected from a wider domain or a different path must not
   * overwrite the one this origin set.
   */
  function parse(cookieHeader) {
    if (typeof cookieHeader !== 'string' || cookieHeader === '') return null
    for (const pair of cookieHeader.split(';')) {
      const eq = pair.indexOf('=')
      if (eq < 1) continue
      if (pair.slice(0, eq).trim() !== name) continue
      const value = pair.slice(eq + 1).trim()
      return verify(value) ? value : null
    }
    return null
  }

  function serialize(value) {
    // A cookie value is copied verbatim into a response header. Everything mint()
    // produces is base64url plus one dot, so anything else came from somewhere it
    // should not have.
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new TypeError('session cookie: refusing to set a value with characters that could split the header')
    }
    const attributes = [
      `${name}=${value}`,
      'Path=/',
      'HttpOnly',
      // Lax, not Strict: a visitor who follows a link back from the live room —
      // which is where the verification danmaku is typed — arrives on a
      // cross-site GET, and Strict would drop the session exactly there. Lax
      // still withholds the cookie from cross-site POSTs, which is the case that
      // matters.
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ]
    if (secure) attributes.push('Secure')
    return attributes.join('; ')
  }

  function clear() {
    const attributes = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
    if (secure) attributes.push('Secure')
    return attributes.join('; ')
  }

  return Object.freeze({
    name,
    secure,
    maxAgeSeconds,
    mint,
    hash,
    verify,
    parse,
    serialize,
    clear,
    /** Convenience wrappers for a route. */
    read: (request) => parse(request.headers.cookie),
    set: (reply, value) => reply.header('set-cookie', serialize(value)),
    remove: (reply) => reply.header('set-cookie', clear()),
  })
}

// ---------------------------------------------------------------------------

function createDevelopmentAdminSession(db, sessionCookie, ttlHours) {
  const now = new Date()
  const createdAt = toCanonicalTimestamp(now)
  const expiresAt = toCanonicalTimestamp(new Date(now.getTime() + ttlHours * 60 * 60 * 1000))
  const submitter = db.prepare('SELECT id FROM submitters WHERE open_id = ?').get(DEV_ADMIN_OPEN_ID)

  if (submitter === undefined) {
    db.prepare(`
      INSERT INTO submitters (id, open_id, display_name, display_name_seen_at, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      DEV_ADMIN_OPEN_ID,
      DEV_ADMIN_OPEN_ID,
      DEV_ADMIN_DISPLAY_NAME,
      createdAt,
      createdAt,
      createdAt,
    )
  }

  const token = sessionCookie.mint()
  db.prepare(`
    INSERT INTO sessions (id, token_sha256, submitter_id, bound_at, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    sessionCookie.hash(token),
    DEV_ADMIN_OPEN_ID,
    createdAt,
    createdAt,
    createdAt,
    expiresAt,
  )

  return Object.freeze({ token })
}

function replaceCookie(header, name, value) {
  const kept = typeof header === 'string'
    ? header.split(';').map((part) => part.trim()).filter((part) => part !== '' && part.split('=', 1)[0] !== name)
    : []
  return [`${name}=${value}`, ...kept].join('; ')
}

function describeRefusal(error, config) {
  const build = typeof error?.code === 'string' ? REFUSALS[error.code] : undefined
  return build === undefined ? null : build(config)
}

function requireArgument(value, name) {
  if (value === null || value === undefined) {
    throw new TypeError(`createApp: ${name} is required and must be supplied by the caller`)
  }
}

function requireSections(config, names) {
  const missing = names.filter((name) => config[name] === null || typeof config[name] !== 'object')
  if (missing.length > 0) {
    throw new TypeError(
      `createApp: config is missing the section(s) ${missing.join(', ')}. See config.mjs for the shape.`,
    )
  }
}

/**
 * fastify v5 keeps a logger INSTANCE and logger OPTIONS in different keys and
 * throws if an instance arrives in the options key, so the two are told apart
 * here rather than at every call site.
 *
 * Nothing at all means no logging, which is what a test wants; server.mjs always
 * passes something.
 *
 * Both OPTIONS paths leave here with requestLogValue as the `req` serializer,
 * over any `req` serializer the caller brought (JOI-BUTTON-STORY-120). fastify's
 * default writes req.url whole into the "incoming request" line, and a visitor
 * polls GET /api/login/status?token=<pollToken> — one line per poll, each
 * carrying a credential that answers for that visitor until it expires. The
 * caller's object is copied, never edited: captureLog() hands the same options
 * to more than one boot().
 *
 * An INSTANCE goes through untouched, and that is a gap stated rather than
 * closed: fastify serialises requests on an instance with the instance's own
 * `req` serializer, or with its default — the whole URL — when the instance has
 * none. Nothing passes an instance today. Whatever starts to must build it with
 * `serializers: { req: requestLogValue }`, or the poll token is back in the log.
 */
function resolveLogger(logger, config) {
  if (logger === undefined || logger === null || logger === false) return {}
  const methods = ['info', 'error', 'debug', 'fatal', 'warn', 'trace', 'child']
  if (typeof logger === 'object' && methods.every((method) => typeof logger[method] === 'function')) {
    return { loggerInstance: logger }
  }
  const options = logger === true ? { level: config.server.logLevel } : logger
  return { logger: { ...options, serializers: { ...options.serializers, req: requestLogValue } } }
}

/**
 * The `req` of every request log line: fastify's own default (asReqValue in
 * fastify/lib/logger-pino.js), key for key, except that the url stops before
 * its first '?' (JOI-BUTTON-STORY-120).
 *
 * Method and path are what a request line is read for. The query string is
 * where callers of this API put what must not be kept — the visitor's poll
 * token above all — so all of it goes, rather than a list of parameter names
 * that is only ever as complete as the last route somebody remembered.
 *
 * The other keys are fastify's, so the line an operator searches keeps its
 * shape: `version` is undefined, and so absent from the JSON, unless the
 * request carried Accept-Version. A url that is not a string is returned as it
 * is, which is what fastify's default would have written.
 *
 * Exported for the case that reads it directly, and for whatever builds a
 * logger instance to hand to createApp (see resolveLogger).
 */
export function requestLogValue(req) {
  return {
    method: req.method,
    url: typeof req.url === 'string' ? req.url.split('?', 1)[0] : req.url,
    version: req.headers && req.headers['accept-version'],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  }
}

/**
 * What of a danmaku source error may reach the "danmaku source error" line
 * (JOI-BUTTON-STORY-120).
 *
 * The payload is whatever failed, and that includes whatever a listener threw:
 * the source hands a listener's exception to 'error' rather than let it escape.
 * Given that value as it is, pino's err serializer copies every enumerable
 * field it carries, nested objects included, so an error that happened to hold
 * an auth body or a visitor's code would write it out. Nothing is spread here.
 * A value with a string message gives up name, message and stack as strings,
 * and three of the fields OpenPlatformError adds — endpoint as a string, status
 * and platformCode as finite numbers — and nothing else: not code, not cause,
 * not dial. Any other value is recorded as its type alone.
 *
 * The message is not filtered, because carrying it is the line's whole job.
 * What goes into it is the thrower's business; bili-transport.mjs's errors
 * carry a path, an HTTP status and the platform's own text, never a request
 * body. pino recomputes `type` from the constructor of what it is handed, a
 * plain object here, so it is `name` that carries the error's class.
 *
 * Exported for the case that feeds it a poisoned error; the subscription in
 * createApp is its only caller.
 */
export function sourceErrorLogFields(value) {
  if (typeof value?.message !== 'string') return { type: typeof value }
  const fields = {}
  for (const name of ['name', 'message', 'stack', 'endpoint']) {
    if (typeof value[name] === 'string') fields[name] = value[name]
  }
  for (const name of ['status', 'platformCode']) {
    if (Number.isFinite(value[name])) fields[name] = value[name]
  }
  return fields
}
