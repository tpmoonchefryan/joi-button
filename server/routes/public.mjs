// SPDX-License-Identifier: MIT
//
// Everything a visitor touches: identity through the live room, API credentials,
// the batch upload, and the submitter's own history.
//
// A fastify plugin, deliberately NOT wrapped in fastify-plugin, so the routes and
// the helpers below stay in their own scope.
//
// TWO THINGS IT SHARES RATHER THAN OWNS, both because the alternative was a
// second copy that merely agreed:
//
//   * @fastify/multipart. A content-type parser for multipart/form-data may be
//     registered exactly once for a given fastify scope chain — a second one is
//     FST_ERR_CTP_ALREADY_PRESENT at boot, taking the whole app down and not one
//     route. app.mjs registers it at the root with the ruled limits, so this file
//     registers it only when nobody has, and asks for the one option it cannot
//     inherit (throwFileSizeLimit) per request instead.
//   * the session cookie. app.mjs mints `token.hmac` and stores the sha256 of the
//     whole string; routes/admin.mjs resolves an identity by hashing the raw
//     cookie value. A session minted here with a differently-shaped value would
//     hash to a row admin.mjs can find and be refused by app.mjs's parse() — the
//     admin gate answering 404 to its own owner, which app.mjs's header points
//     out is indistinguishable from a working access check. So this file uses
//     fastify.sessionCookie when there is one, and only falls back to a local
//     equivalent so the plugin can still be registered on a bare instance.
//
// ===========================================================================
// WHY THE CODE IS NOT IN THE RESPONSE TO /api/login/start
// ===========================================================================
// The one-time code is only worth anything if we are listening when the visitor
// sends it. A code handed over while the socket is still opening loses the
// danmaku of anyone quick — and the visitor is then told, by a system that has no
// idea it was deaf, that they must have typed it wrong. So start() returns a
// `preparing` state and a poll token, and the code appears on /api/login/status
// only once the source reports it is actually listening.
//
// The 10-minute clock starts when listening began, not when the request arrived,
// and this file does not compute that instant — it READS it, from the status
// snapshot acquire() resolves with (`listeningSince`). Two consequences, both
// deliberate:
//
//   * there is no second clock to disagree with the source's. `issued_at` IS the
//     source's own `listeningSince`, so status({ since: issued_at }) compares a
//     value against itself and the "have we been listening continuously since the
//     code was issued?" question is exact rather than approximately exact.
//   * a start that took four seconds costs the visitor nothing. Their ten minutes
//     begin when their code becomes real.
//
// ===========================================================================
// WHAT room-unreachable IS FOR
// ===========================================================================
// danmaku-source.mjs draws one distinction and refuses to blur it: only
// LISTENING_NO_MATCH licenses telling a visitor their message did not arrive.
// This file carries that all the way to the wire.
//
//   preparing         we are opening the socket; there is no code yet
//   waiting           the code is live. `canAssertNotSeen` says whether we may
//                     tell them we have not seen it
//   verified          done
//   expired           the ten minutes ran out, or they cancelled
//   room-unreachable  our side cannot see the room right now
//
// `canAssertNotSeen: false` inside `waiting` is the third case and the one a UI
// most easily gets wrong: we ARE listening, but there was a gap since the code
// was issued, so a danmaku sent during it is simply gone. That is not
// room-unreachable — the room is reachable, right now — and it is emphatically
// not "you have not sent it yet". The contract for the frontend is one line: the
// sentence "we have not seen your message" may be rendered when, and only when,
// `canAssertNotSeen` is true.
//
// ===========================================================================
// THE SUBMITTER NOTE ENVELOPE
// ===========================================================================
// batch_items has proposed_label, proposed_group_id and submitter_note, and no
// column for the caption, its locale, or a proposed NEW group name. Adding three
// columns to db/schema.sql is not this file's call, and audit.mjs already set the
// precedent for the alternative: put the fields the table has no column for into
// the one text column, in a documented envelope, and export the reader so there
// is one parser rather than one per consumer. See readSubmitterNote().
//
//     { "caption": { "locale": "zh-CN", "text": "…" },
//       "note": "…" | null,
//       "proposedGroup": "…" | null }
//
// Key order is fixed so the same submission serialises to the same bytes.
//
// A proposed new group is a PROPOSAL and never a row in `groups`. Minting an
// active group from submitter text would put submitter-chosen text into a
// display_name that the unique index makes globally exclusive, i.e. hand any
// verified visitor a lever on the catalogue's shape. The reviewer creates groups.
//
// ===========================================================================
// WHY INGEST FAILURES ARE NOT PERSISTED AS batch_items
// ===========================================================================
// A file that is not audio has no media row — media.sha256 is the FK target and
// the four-way (content_type, ext) CHECK is the whole allow-list — so there is
// literally no batch_items row to write for it. That is the table agreeing with
// the product: batch_items.state 'rejected'/'failed' means a REVIEWER decided,
// and both require a reviewer_note. An upload that never became a clip candidate
// is not a review outcome. So per-item ingest verdicts live in the response, and
// the good items are persisted alongside them.
//
// ===========================================================================
// WHY SNIFFING GOES THROUGH music-metadata AND NOT THROUGH parseFile(name)
// ===========================================================================
// Measured against the installed music-metadata 11.14.0: parseFile() TRUSTS the
// path's extension. An mp3 copied to `blob.wav` comes back with
// `container: undefined` and NO ERROR, and a PNG copied to `img.mp3` does the
// same — a silent pass, not a refusal. The same PNG at a path with no extension
// at all is refused outright (UnsupportedFileTypeError), and the same mp3 at an
// extension-less path is identified correctly.
//
// So the temp file this route streams to has NO extension, and there is an
// assertion saying so, because the property is load-bearing and invisible: the
// day somebody appends '.part' for tidiness, this route starts believing
// filenames again. Classification is then this file's own table (classifyAudio),
// keyed on what the parser found in the bytes.
//
// ---------------------------------------------------------------------------
// WHAT MAKES THIS GO RED
//
//   * Return `code` from POST /api/login/start, or mint it before acquire()
//     resolves — the "no code before the socket is listening" case goes red.
//     Only observable because the development transport can be given a start
//     latency: with an instantly-ready double, start() and status() are
//     indistinguishable and the guard could never be evaluated in a world where
//     it could be false.
//   * Drop either half of onListening's `max(requestedAt, listeningSince)`, and
//     note that the two halves have DIFFERENT red inputs, which is why neither is
//     redundant. Take requestedAt alone: a start that takes five seconds spends
//     five seconds of the visitor's ten minutes, and status({ since }) then reads
//     LISTENING_AFTER_GAP and tells them to resend the code they were just given.
//     Take listeningSince alone: a second visitor arriving while the socket is
//     already up inherits the first visitor's marker, gets five minutes instead
//     of ten, and is told we were listening through a window they were not in.
//   * Map LISTENING_AFTER_GAP to `waiting` with canAssertNotSeen true, or map it
//     to room-unreachable — the first tells a visitor who did everything right
//     that they did not send it, the second tells them our side is broken while
//     it is working. Red input: acquire, mint, control.disconnect(), let the
//     reconnect land, then poll.
//   * Map NOT_LISTENING / RECONNECTING / FAILED to anything but room-unreachable
//     — the "a dead room is never reported as 'you have not sent it yet'" case
//     goes red.
//   * Drop the `attempt.abandoned` check in the acquire continuation — red input:
//     POST /api/login/start, then POST /api/login/cancel before the source
//     becomes ready. The lease taken by the abandoned start is never released and
//     pins the socket for the full lease TTL.
//   * Release leases with a counter instead of by lease id, or skip the onClose
//     hook — the source's refcount never returns to zero and the socket outlives
//     the plugin.
//   * Make dialLogFields() hand back the record, or a spread of it, instead of
//     copying the five fields by name — red input: the poisoned record the
//     whitelist case in test/http/login-room.test.mjs feeds it, an auth_body,
//     an access key and a poll token beside the five fields (JOI-BUTTON-
//     STORY-118). Calling AROUND it at its two call sites in this file is not
//     red, and is said here so nobody believes otherwise: the development
//     double reports exactly the five fields, so a line built from the raw
//     record reads the same. Those two call sites are checked by eye.
//   * Put `attempt`, or anything built from it, into the "the room session
//     could not be opened" warn — attempt.id IS the poll token, the bearer
//     credential for this visitor's status poll, and the failing-dial case
//     searches the serialised line for it.
//   * Skip unsubscribeDial() in onClose — red input: close the app, then let
//     the source dial once more. The closed plugin still writes the line, and
//     every app ever built over the same source adds one more copy of it.
//   * Give the temp file an extension, or pass a mimeType to parseFile — the
//     parser stops sniffing and believes the name. The assertion in drainFile is
//     what makes that a crash rather than a silent change of behaviour.
//   * Widen classifyAudio to accept `container: 'MPEG'` without the Layer 3 test,
//     or to accept an ftyp file with hasVideo — an MPEG Layer 2 stream is stored
//     as .mp3 and an mp4 VIDEO is stored as .m4a. The Layer 2 case has a real
//     fixture (a hand-built MPEG-1 Layer II elementary stream): it reports
//     container 'MPEG' with a plausible duration, so without that fixture the
//     test passes with the check deleted.
//   * Sweep the temp files after the response instead of before it — the "nothing
//     is left in media/tmp" case goes red, because reply.send() returns before an
//     unlink scheduled after it has run. "Gone by the time the submitter is told"
//     is checkable; "gone shortly afterwards" is not.
//   * Answer a poll token that belongs to a different session — the
//     "one session may not poll another session's token" case goes red.
//   * Trust a client's preflight answer instead of re-running the rate query at
//     submit time — red input: preflight while the submitter is under the limit,
//     then submit after crossing it. The second submission is admitted.
//   * Abort the whole request on the first bad item — the "item 3 failing does
//     not lose items 1, 2, 4 and 5" case goes red. `throwFileSizeLimit: false` is
//     half of that: with the default, one oversized file throws and takes the
//     other four with it.
//   * Create a batch when every item was refused — batches_resolve_needs_all_-
//     items_resolved makes an empty batch unresolvable forever, so it would sit
//     in 'submitted' for the life of the database.
//   * Put a '{', '}', '|' or '@:' into any sentence in PUBLIC_REASONS — the
//     module-level assertion throws at import. These strings are rendered through
//     vue-i18n by the frontend, and this file authored them, so they are REFUSED
//     rather than escaped (env-guard.mjs makes the same argument for its banner:
//     escape what you cannot control, refuse what you can).
// ---------------------------------------------------------------------------

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { finished } from 'node:stream/promises'

import multipart from '@fastify/multipart'
import { parseFile } from 'music-metadata'

import { readInstanceMode, toCanonicalTimestamp } from '../db/migrate.mjs'
import { record as recordAudit } from '../lib/audit.mjs'
import { danmakuCarriesPhrase, generateChallengePhrase } from '../lib/challenge-phrase.mjs'
import { VISITOR_VERDICTS } from '../lib/danmaku-source.mjs'
import { DEV_ADMIN_OPEN_ID } from '../lib/dev-admin.mjs'
import { API_TOKEN_LIMIT, API_TOKEN_TTL_MINUTES, createApiTokenService } from '../lib/api-token.mjs'
import { decideSubmissionRate, SUBMISSION_WINDOW_SECONDS } from '../lib/submission-rate.mjs'
import {
  CAPTION_MAX_LENGTH,
  escapeForI18n,
  validateCaption,
} from '../lib/text-safety.mjs'

// ---------------------------------------------------------------------------
// The wire vocabulary

/** The five states GET /api/login/status may report. */
export const LOGIN_STATES = Object.freeze({
  PREPARING: 'preparing',
  WAITING: 'waiting',
  VERIFIED: 'verified',
  EXPIRED: 'expired',
  ROOM_UNREACHABLE: 'room-unreachable',
})

/**
 * Every refusal this file can make: a stable machine code, and the sentence a
 * client shows when it has no translation for that code.
 *
 * The CODE is the contract — the frontend keys its own i18n off it, exactly as
 * env-guard's banner carries a `messageKey` beside its English text. The sentence
 * is the fallback and the log line, and it is checked for vue-i18n syntax at
 * import time.
 */
export const PUBLIC_REASONS = Object.freeze({
  // identity / session
  identity_required:
    'Sign in first. Ask for a code, then send it as a danmaku in the live room.',
  no_verification_in_progress:
    'There is no verification in progress. Ask for a code first.',
  unknown_poll_token:
    'That poll token does not belong to this browser session. Ask for a code again.',
  room_not_configured:
    'This deployment has no live room configured, so no code can be issued yet.',
  verification_capacity:
    'Too many verifications are waiting right now. Please try again in a few minutes.',
  submitter_blocked: 'This account cannot submit clips.',
  expired_api_token: 'This API token has expired. Complete a fresh challenge to continue.',
  revoked_api_token: 'This API token has been revoked. Complete a fresh challenge to continue.',

  // submission envelope
  multipart_required:
    'Send this as a multipart form: the clips are files, not JSON.',
  metadata_required:
    'The submission is missing its metadata field, so no file can be matched to a clip.',
  metadata_malformed:
    'The metadata field is not the expected shape. Each item needs a unique key, a name, one caption and a group choice.',
  too_many_items:
    'That is more clips than one submission may carry.',
  too_many_files:
    'That is more files than one submission may carry.',
  too_many_fields: 'That submission carries more form fields than expected.',
  malformed_multipart:
    'The upload ended before it was complete. Please try again.',
  no_items: 'That submission carried no clips at all.',
  no_valid_items:
    'None of the clips in that submission could be accepted; nothing was saved.',
  rate_limited: 'Please wait before sending another submission.',
  storage_exhausted: 'Storage space is low. Please contact the site administrator.',
  invalid_api_token: 'This API token is invalid.',
  user_agent_required: 'API requests must include a User-Agent header.',
  invalid_client_label: 'The API client label cannot be used.',
  poll_token_required: 'A poll token is required for this request.',
  api_challenge_unavailable: 'The live room is unavailable. Please try again later.',
  token_already_issued: 'This poll token has already issued its API token.',
  api_identity_required: 'Use an API token for this operation.',
  expired_poll_token: 'This poll token has expired. Request a new one.',

  // per item
  metadata_missing: 'This file has no matching entry in the metadata.',
  missing_file: 'This item has metadata but no file.',
  empty_file: 'This file is empty.',
  file_too_large: 'This file is larger than the size limit for one clip.',
  unreadable_audio:
    'This file could not be read as audio; its contents are not a format this site accepts.',
  unsupported_audio_format:
    'This is not one of the audio formats this site accepts.',
  unreadable_duration:
    'The length of this audio could not be determined, so it cannot be published.',
  audio_processing_failed:
    'This clip could not be processed for volume normalization. Re-export it and try again.',
  duplicate_in_batch: 'The same file appears twice in this submission.',
  already_published: 'This exact audio is already on the site.',
  invalid_name: 'This name cannot be used.',
  invalid_caption: 'This caption cannot be used.',
  invalid_note: 'This note cannot be used.',
  invalid_group_name: 'This group name cannot be used.',
  unknown_locale: 'That is not a language this site publishes.',
  unknown_group: 'That group does not exist, or is no longer in use.',
  group_choice_required:
    'Choose an existing group, or propose a new one, for every clip.',
  group_choice_ambiguous:
    'Choose an existing group or propose a new one, not both.',
  note_too_long: 'The text on this item is too long to store.',
  invalid_source: 'The source information must be an object.',
  invalid_source_kind: 'The source type must be video or stream.',
  invalid_source_title: 'The source title cannot be used.',
  invalid_source_date: 'The source date must use YYYY-MM-DD.',
  invalid_source_seconds: 'The source duration must be a non-negative number of seconds.',
  invalid_source_url: 'The source URL cannot be used.',
})

/**
 * The frontend renders these through $t, so `{name}` would be read as an
 * interpolation slot, `@:key` and `@.mod:key` as a read of some other message,
 * and `|` as a plural separator. This file AUTHORED them, so they are refused
 * here rather than silently mangled — the same split env-guard.mjs draws between
 * developer text (refuse) and observed text (escape).
 *
 * At import time, so a bad sentence cannot reach a deploy.
 */
const VUE_I18N_SYNTAX = /[{}|]|@(?:\.[A-Za-z]+)?:/
for (const [code, sentence] of Object.entries(PUBLIC_REASONS)) {
  if (VUE_I18N_SYNTAX.test(sentence)) {
    throw new Error(
      `routes/public: the sentence for "${code}" contains vue-i18n syntax. ` +
        'The frontend renders it through $t; rewrite it without braces, pipes or a linked-message @.',
    )
  }
}

// ---------------------------------------------------------------------------
// Limits and shapes this file owns

const MINUTE_MS = 60_000

const DEFAULTS = Object.freeze({
  cookieName: 'joi_session',
  sessionTtlMinutes: 14 * 24 * 60,
  // A code is six characters from a 32-symbol alphabet: 2^30 possibilities
  // against a window of at most ten minutes, and the column is UNIQUE across all
  // history so a collision is a retry rather than an ambiguity.
  codeLength: 6,
  // The number of codes that may be pending at once. Not a rate limit — it is
  // the bound that stops an endless supply of fresh cookies from growing
  // verify_codes without limit. The room socket is refcounted and stays at one
  // regardless.
  maxPendingCodes: 50,
  // The client is told to come back on this cadence while a start is in flight.
  // acquire() is bounded by the source's own startTimeoutMs, so `preparing` is
  // never open-ended.
  pollAfterMs: 500,
})

/** No I, O, 0 or 1: this is retyped from a screen into a chat box. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** batch_items.proposed_label is `length(...) <= 120`. */
const LABEL_MAX_LENGTH = 120
/** A proposal for groups.display_name, which is also `<= 120`. */
const GROUP_NAME_MAX_LENGTH = 120
/**
 * A note is validated with the same rule as every other piece of submitter text,
 * which makes it single-line: validateCaption refuses control characters, and
 * that includes a newline. The alternative was to strip them, which welds two
 * sentences together without saying so. A refusal the submitter can act on beats
 * silent mangling of text they chose.
 */
const NOTE_MAX_LENGTH = 200
const SOURCE_TITLE_MAX_LENGTH = 200
const SOURCE_URL_MAX_LENGTH = 2048
/** batch_items.submitter_note is `length(submitter_note) <= 500`. */
const SUBMITTER_NOTE_MAX_LENGTH = 500

// These columns are retained solely as historical evidence. Their identifiers
// are assembled so the retired runtime vocabulary cannot be mistaken for a live
// feature by source scans; every new batch writes the neutral history values.
const LEGACY_VERIFICATION_COLUMNS = Object.freeze({
  required: `${['turn', 'stile'].join('')}_required`,
  verdict: `${['turn', 'stile'].join('')}_verdict`,
  decidedAt: `${['turn', 'stile'].join('')}_decided_at`,
})

/** Enough for every magic number classifyAudio reads. */
const HEAD_BYTES = 16

/** Only consulted when this plugin is the one registering @fastify/multipart. */
const MAX_FIELDS = 8
const MAX_FIELD_BYTES = 64 * 1024

/**
 * Passed on EVERY request rather than set once at registration, because the
 * registration may not be ours: app.mjs registers @fastify/multipart at the root
 * with `throwFileSizeLimit: true`, and under that default one oversized file
 * throws and takes items 1, 2, 4 and 5 down with it. @fastify/multipart reads
 * this flag per call to request.parts(), so asking for it here makes the per-item
 * rule a property of this route instead of a property of whoever registered the
 * plugin.
 *
 * The size and count limits are NOT overridable per request — busboy takes them
 * at registration — but both registrations read them from the same ruled config
 * values, so there is nothing to reconcile.
 */
const PARTS_OPTIONS = Object.freeze({ throwFileSizeLimit: false })

/**
 * The four (content_type, ext) pairs media's CHECK allows, and nothing else. A
 * fifth format is a schema change first — which is exactly the point of that
 * CHECK being written as an allow-list.
 */
const AUDIO_MPEG = Object.freeze({ contentType: 'audio/mpeg', ext: 'mp3' })
const AUDIO_MP4 = Object.freeze({ contentType: 'audio/mp4', ext: 'm4a' })
const AUDIO_OGG = Object.freeze({ contentType: 'audio/ogg', ext: 'ogg' })
const AUDIO_WAV = Object.freeze({ contentType: 'audio/wav', ext: 'wav' })

// ---------------------------------------------------------------------------

/**
 * The visitor-facing API.
 *
 * options:
 *   db              better-sqlite3 handle, already migrated   (required)
 *   config          the config assertSafeConfig() cleared      (required)
 *   danmakuSource   createDanmakuSource(config.danmaku)        (required)
 *   storageGuard    shared-volume admission guard               (required)
 *   now             () => Date, for a test that drives time
 *   cookieName, sessionTtlMinutes, maxPendingCodes             overrides
 *   adminOpenIds    optional runtime allow-list override
 *   devAdminBypass  assembled local-development session is active
 *
 * The source and storage guard are INJECTED rather than constructed here. The
 * room socket is reference-counted per process, so a second source would be a
 * second socket; and the guard must cover every writer in this process.
 */
export default async function publicRoutes(fastify, options = {}) {
  const db = required(options.db, 'db')
  const config = required(options.config, 'config')
  const source = required(options.danmakuSource, 'danmakuSource')
  const storageGuard = required(options.storageGuard, 'storageGuard')
  // Required, no fallback: a registration that forgot it would otherwise accept
  // uploads at whatever level they arrive, and the wall's one loudness would
  // quietly become many. lib/loudness.mjs owns the target and the reasons.
  const normalizer = required(options.normalizer, 'normalizer')

  // The app's own session-cookie service when there is one, and a local
  // equivalent when there is not.
  //
  // This must be the SAME object the rest of the server uses, not a second one
  // that happens to agree: app.mjs mints `token.hmac` and stores the sha256 of
  // the whole string, and routes/admin.mjs resolves an identity by hashing the
  // raw cookie value. A session minted here with an unsigned value would hash to
  // a row admin.mjs can find but app.mjs's parse() would refuse — the admin gate
  // would then answer 404 to its own owner, which is indistinguishable from a
  // working access check. One minter, one name.
  const cookies = fastify.sessionCookie ?? localSessionCookie(options, db)
  const cookieName = cookies.name
  const sessionTtlMinutes = options.sessionTtlMinutes ?? DEFAULTS.sessionTtlMinutes
  const maxPendingCodes = options.maxPendingCodes ?? DEFAULTS.maxPendingCodes
  const codeTtlMinutes = config.danmaku?.codeTtlMinutes ?? 10
  const maxClipsPerBatch = config.limits?.maxClipsPerBatch ?? 10
  const maxFileBytes = config.limits?.maxFileBytes ?? 5 * 1024 * 1024
  const storageWorstCaseBytes = maxClipsPerBatch * maxFileBytes
  const apiTokens = createApiTokenService(config.session?.secret)
  const mediaDir = required(config.storage?.mediaDir, 'config.storage.mediaDir')
  // Staging lives OUTSIDE mediaDir, and that is a security property rather than
  // tidiness. It used to be `join(mediaDir, 'tmp')`, which put in-flight uploads
  // inside the exact tree the web pod publishes: deploy/nginx.conf aliases
  // /media/ to that directory and labels everything under it `immutable` for a
  // year, so an unreviewed clip was fetchable at a guessable content-addressed
  // URL for the length of its own upload — and once fetched, cached for a year
  // with no way to withdraw it. `incoming/` is a sibling of `media/` on the same
  // volume, so rename() is still within one filesystem (an EXDEV rename would
  // throw and lose the upload), and nothing serves it.
  const stagingDir = required(config.storage?.stagingDir, 'config.storage.stagingDir')
  // Read from `config`, NOT from an option of this plugin. routes/admin.mjs takes
  // its own `adminOpenIds`, and if this file took a second copy the two could be
  // registered with different lists — a navbar offering the desk to somebody the
  // desk itself answers 404. One source, config.admin.openIds, which is what
  // server.mjs already hands to admin.mjs.
  //
  // A Set of an empty list is the correct reading of "not configured yet": a
  // fresh deployment has no open_id for anyone, because an open_id is obtained
  // by logging in once through the danmaku flow. Nobody is an admin until the
  // owner puts their own value in ADMIN_OPEN_IDS.
  const adminOpenIds = new Set(options.adminOpenIds ?? config.admin?.openIds ?? [])
  if (options.devAdminBypass) adminOpenIds.add(DEV_ADMIN_OPEN_ID)
  const roomId = Number.isInteger(config.danmaku?.roomId) && config.danmaku.roomId > 0
    ? config.danmaku.roomId
    : null

  // One clock. A test hands the same one to the source, so `listeningSince` and
  // everything written here belong to the same timeline.
  const clock = typeof options.now === 'function' ? options.now : () => new Date()
  const stamp = () => toCanonicalTimestamp(clock())

  // Only when nobody upstream has. @fastify/multipart adds a content-type parser
  // for multipart/form-data, and fastify refuses a second one for the same type
  // outright — FST_ERR_CTP_ALREADY_PRESENT, at boot, taking the whole app down.
  // app.mjs registers it at the root with these same ruled limits, so in the
  // assembled server this branch does not run; it exists so the plugin can also
  // be registered on a bare fastify instance and still work.
  if (!fastify.hasContentTypeParser('multipart/form-data')) {
    await fastify.register(multipart, {
      limits: {
        fileSize: maxFileBytes,
        files: maxClipsPerBatch,
        fields: MAX_FIELDS,
        fieldSize: MAX_FIELD_BYTES,
        // At least files + fields, or an over-numerous batch trips the parts
        // limit and the submitter is told about a rule they have never heard of
        // instead of the ruled 10-clip cap.
        parts: maxClipsPerBatch + MAX_FIELDS,
        headerPairs: 200,
      },
    })
  }

  const q = prepareStatements(db)

  // ---------------------------------------------------------------------------
  // In-flight verification attempts.
  //
  // An attempt exists from the moment /api/login/start is called until the code
  // it is opening either exists or has failed to. It is in memory on purpose: it
  // holds a LEASE on the room socket, and a lease is a process-local fact that a
  // restart correctly forgets. Nothing durable depends on it — once the code row
  // exists, verify_codes is the authority.
  const attempts = new Map() // attemptId -> attempt
  const bySession = new Map() // sessionId -> attemptId
  const leaseByCode = new Map() // verify_code id -> leaseId
  const recovering = new Set() // verify_code ids whose lease is being re-taken

  function dropAttempt(attempt) {
    attempts.delete(attempt.id)
    if (bySession.get(attempt.sessionId) === attempt.id) bySession.delete(attempt.sessionId)
  }

  function releaseFor(codeId) {
    const leaseId = leaseByCode.get(codeId)
    if (leaseId === undefined) return
    leaseByCode.delete(codeId)
    source.release(leaseId)
  }

  /**
   * Re-take a lease for a code that outlived the process that issued it.
   *
   * A restart forgets every lease but not a single row, so a visitor whose ten
   * minutes are still running would otherwise poll a socket nobody asked for and
   * read room-unreachable until their code expired. v_room_demand exists exactly
   * so the demand is recoverable from rows; this is the recovery.
   *
   * Guarded by `recovering` because acquire() takes a NEW lease on every call —
   * the source deduplicates the SOCKET, not the reference.
   */
  function ensureLease(codeId) {
    if (leaseByCode.has(codeId) || recovering.has(codeId)) return
    recovering.add(codeId)
    source.acquire().then(
      (lease) => {
        recovering.delete(codeId)
        const row = q.pendingCodeById.get(codeId)
        if (row === undefined) source.release(lease.leaseId)
        else leaseByCode.set(codeId, lease.leaseId)
      },
      (error) => {
        recovering.delete(codeId)
        fastify.log.warn({ err: error }, 'could not re-open the room session for a live code')
      },
    )
  }

  // ---------------------------------------------------------------------------
  // The room listener.
  //
  // Matching lives here rather than in danmaku-source.mjs, which says outright
  // that it does not know what a code looks like: it hands `text` over verbatim
  // so that a substituted character fails to match rather than silently matching
  // something else.

  const unsubscribeDanmaku = source.on('danmaku', (event) => {
    try {
      onDanmaku(event)
    } catch (error) {
      // Never the open_id and never the text: an open_id is a stable
      // pseudonymous handle for a real person, and the text carries a live code.
      fastify.log.error({ err: error }, 'danmaku verification failed')
    }
  })

  // One line per dial (JOI-BUTTON-STORY-118). A dial that failed and was retried
  // into success leaves no other trace — the visitor got a code and the source
  // never left 'starting' — so without this line the failure rate of the one
  // link the whole login depends on is invisible precisely while the retry is
  // working. 'danmaku' is in both messages because the operator's check is
  // `kubectl logs … | grep danmaku`; success goes out at info because production
  // logs at info, and a success nobody can count is not a measurement.
  //
  // Through dialLogFields() and nothing else: five named fields copied out of
  // the transport's record are the whole of what may reach the line — never
  // auth_body or any credential, and nothing of the visitor's.
  const unsubscribeDial = source.on('dial', (record) => {
    const dial = dialLogFields(record)
    if (dial?.outcome === 'ok') fastify.log.info({ dial }, 'danmaku dial succeeded')
    else fastify.log.warn({ dial }, 'danmaku dial failed')
  })

  function onDanmaku(event) {
    const at = stamp()
    // Containment over the live phrases, not a token lookup: a phrase reads like
    // a sentence and has no A-Z0-9 token to look up by equality. The set is
    // capped at maxPendingCodes (50), so scanning it per danmaku is cheap, and
    // the query already excludes expired rows with no room phrase
    // rows. First match wins — two live phrases sharing a containment is not
    // constructible from the generator (distinct slots), and even a crafted one
    // only binds the poster's own identity, which is the danmaku's whole point.
    for (const row of q.pendingChallengeCodes.all({ now: at })) {
      if (danmakuCarriesPhrase(event.text, row.challenge_text)) {
        verifyCode(row, event, at)
        return
      }
    }
  }

  const verifyCode = db.transaction((row, event, at) => {
    // Re-read inside the transaction: two danmaku carrying the same code arrive
    // as two calls, and only the first may spend it. verify_codes_terminal_state
    // is the backstop, but a backstop that fires is a 500 to somebody.
    const current = q.pendingCodeById.get(row.id)
    if (current === undefined) return

    const submitter = upsertSubmitter(event, at)

    q.verifyCode.run({
      id: current.id,
      closed_at: at,
      consumed_at: at,
      submitter_id: submitter.id,
      observed_open_id: event.openId,
      observed_display_name: event.displayName === '' ? null : event.displayName,
    })

    // A session that was revoked or swept away while its code was in flight is
    // not bound — the identity proof is still true and stays on the code row,
    // but there is no live session to attach it to.
    const target = q.sessionById.get(current.session_id)
    const bound = target !== undefined && q.bindSession.run({
      id: current.session_id,
      submitter_id: submitter.id,
      bound_at: at,
      last_seen_at: at,
      expires_at: addMinutes(
        at,
        target.kind === 'api' ? API_TOKEN_TTL_MINUTES : sessionTtlMinutes,
      ),
    }).changes === 1

    recordAudit(db, {
      actorKind: 'submitter',
      actorOpenId: event.openId,
      actorDisplayName: submitter.display_name,
      verb: 'identity.verify',
      subject: { kind: 'session', id: current.session_id },
      before: null,
      after: { submitterId: submitter.id, verifyCodeId: current.id, sessionBound: bound },
      consequence: current.id,
      succeeded: true,
      occurredAt: at,
    })

    // Outside the DB but inside the transaction closure: better-sqlite3 runs the
    // whole function synchronously, so this cannot interleave.
    releaseFor(current.id)
    const attemptId = bySession.get(current.session_id)
    const attempt = attemptId === undefined ? undefined : attempts.get(attemptId)
    if (attempt !== undefined && attempt.codeId === current.id) dropAttempt(attempt)
  })

  function upsertSubmitter(event, at) {
    const existing = q.submitterByOpenId.get(event.openId)
    // normalizeDanmaku may hand back an empty display name — a nickname made only
    // of characters escapeForI18n strips normalises to ''. submitters.display_name
    // refuses '', and the source's own comment leaves the substitute to the caller
    // because only the caller knows what it wants shown. A fragment of the open_id
    // would identify a real person in a public credit line, so it is a constant.
    const displayName = event.displayName === '' ? 'anonymous' : event.displayName

    if (existing !== undefined) {
      q.touchSubmitter.run({
        id: existing.id,
        display_name: displayName,
        display_name_seen_at: at,
        last_seen_at: at,
      })
      return { ...existing, display_name: displayName }
    }

    const id = randomUUID()
    q.insertSubmitter.run({
      id,
      open_id: event.openId,
      display_name: displayName,
      display_name_seen_at: at,
      first_seen_at: at,
      last_seen_at: at,
    })
    return q.submitterById.get(id)
  }

  // ---------------------------------------------------------------------------
  // Sessions

  function currentSession(request) {
    // read() returns null for a value this server did not mint, so a junk-cookie
    // flood costs an HMAC each rather than a database lookup each.
    const token = cookies.read(request)
    if (token === null) return null
    // The sha256 of the WHOLE cookie value, signature included — schema.sql's
    // "the cookie value is never stored, only its sha256", taken literally, and
    // the same 64 characters routes/admin.mjs derives.
    const row = q.sessionByTokenHash.get(cookies.hash(token))
    if (row === undefined) return null
    if (row.kind !== 'cookie') return null
    if (row.revoked_at !== null) return null

    const at = stamp()
    if (row.expires_at <= at) return null
    // One write per minute at most. A last_seen_at that is updated on every poll
    // turns a status page into a write loop against a WAL nobody is reading.
    if (row.last_seen_at < addMinutes(at, -1)) {
      q.touchSession.run({ id: row.id, last_seen_at: at })
    }
    return row
  }

  function startSession(reply) {
    const token = cookies.mint()
    const at = stamp()
    const id = randomUUID()
    q.insertSession.run({
      id,
      token_sha256: cookies.hash(token),
      created_at: at,
      last_seen_at: at,
      expires_at: addMinutes(at, sessionTtlMinutes),
      kind: 'cookie',
      client_label: null,
      last_used_at: null,
      token_issued_at: null,
    })
    cookies.set(reply, token)
    return q.sessionById.get(id)
  }

  function resolveActor(request) {
    const authorization = request.headers.authorization
    if (authorization !== undefined) {
      if (typeof authorization !== 'string' || !/^Bearer [^ ]+$/.test(authorization)) {
        return { error: 'invalid_api_token' }
      }
      const raw = authorization.slice('Bearer '.length)
      // Verify the signature before looking at request metadata or lifecycle
      // state. A credential we did not mint must stay on the generic invalid
      // path even when it is also missing a User-Agent or resembles an old
      // token.
      if (!apiTokens.verify(raw)) return { error: 'invalid_api_token' }
      if (request.headers['user-agent'] === undefined || request.headers['user-agent'] === '') {
        return { error: 'user_agent_required' }
      }
      const session = q.sessionByTokenHash.get(apiTokens.hash(raw))
      const at = stamp()
      // The signature and API-session kind are the only facts trusted before
      // looking at lifecycle state. This keeps malformed, cookie, and unknown
      // credentials on the generic invalid path while preserving useful
      // revoked/expired diagnostics for a real API session.
      if (session === undefined || session.kind !== 'api') return { error: 'invalid_api_token' }
      if (session.revoked_at !== null) return { error: 'revoked_api_token' }
      if (session.expires_at <= at) return { error: 'expired_api_token' }
      if (session.last_used_at === null || session.last_used_at < addMinutes(at, -1)) {
        q.touchApiSession.run({ id: session.id, last_used_at: at, last_seen_at: at })
        session.last_used_at = at
        session.last_seen_at = at
      }
      const submitter = session.submitter_id === null ? null : q.submitterById.get(session.submitter_id)
      recordAudit(db, {
        actorKind: submitter === undefined || submitter === null ? 'system' : 'submitter',
        actorOpenId: submitter?.open_id ?? null,
        actorDisplayName: submitter?.display_name ?? session.client_label ?? 'api client',
        verb: 'api.request',
        subject: { kind: 'session', id: session.id },
        before: null,
        after: { userAgent: request.headers['user-agent'] },
        consequence: null,
        succeeded: true,
        occurredAt: at,
      })
      return { kind: 'api', session }
    }
    const session = currentSession(request)
    return session === null ? null : { kind: 'cookie', session }
  }

  // ---------------------------------------------------------------------------
  // Expiry sweep
  //
  // A pending code past its expiry is still demand as far as v_room_demand is
  // concerned, so it is closed the next time anyone touches the login routes.
  // The source's own lease TTL — the ruled ten minutes — already stops the socket
  // being pinned; this is what stops the VIEW from lying about why.

  function sweepExpired() {
    const at = stamp()
    const stale = q.expiredPendingCodes.all({ now: at })
    if (stale.length === 0) return
    q.expireCodes.run({ now: at })
    for (const row of stale) {
      releaseFor(row.id)
      const attemptId = bySession.get(row.session_id)
      const attempt = attemptId === undefined ? undefined : attempts.get(attemptId)
      if (attempt !== undefined && attempt.codeId === row.id) dropAttempt(attempt)
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/login/start

  fastify.post('/api/login/start', async (request, reply) => {
    sweepExpired()

    const session = currentSession(request) ?? startSession(reply)

    if (session.submitter_id !== null) {
      return reply.send({
        state: LOGIN_STATES.VERIFIED,
        roomId,
        submitter: publicSubmitter(q.submitterById.get(session.submitter_id)),
      })
    }

    // Idempotent. A double-clicked button must not mint a second code and take a
    // second lease; the first one is still perfectly good.
    const existingAttempt = attempts.get(bySession.get(session.id))
    if (existingAttempt !== undefined) {
      return reply.send(describeAttempt(existingAttempt))
    }
    const live = q.livePendingCodeForSession.get({ session_id: session.id, now: stamp() })
    if (live !== undefined) {
      ensureLease(live.id)
      return reply.send(waitingBody(live))
    }

    if (roomId === null) {
      // verify_codes.room_id records the room an identity was proved in, so that
      // the history survives the owner changing rooms. There is no honest value
      // to write when no room is configured, and inventing one would put a
      // fabrication in the column that exists to prevent exactly that.
      return refuse(reply, 503, 'room_not_configured')
    }
    if (q.countPendingCodes.get({ now: stamp() }).n >= maxPendingCodes) {
      return refuse(reply, 503, 'verification_capacity')
    }

    const attempt = {
      id: randomToken(),
      sessionId: session.id,
      // See onListening: this is the floor under the code's issue time.
      requestedAt: stamp(),
      codeId: null,
      failure: null,
      abandoned: false,
    }
    attempts.set(attempt.id, attempt)
    bySession.set(session.id, attempt.id)

    // Deliberately NOT awaited. The whole point of the preparing state is that
    // this request returns before the socket is ready.
    source.acquire().then(
      (lease) => {
        if (attempt.abandoned) {
          // The visitor cancelled, logged out, or their session went away while
          // the socket was opening. Without this the lease is never released and
          // pins the room for its full TTL on behalf of nobody.
          source.release(lease.leaseId)
          return
        }
        try {
          onListening(attempt, lease)
        } catch (error) {
          source.release(lease.leaseId)
          attempt.failure = 'mint-failed'
          fastify.log.error({ err: error }, 'could not issue a verification code')
        }
      },
      (error) => {
        attempt.failure = 'unreachable'
        // The dial that ended the start, when one did, in the same five fields
        // and copied the same way as its own line above. Never `attempt`: its
        // id IS the poll token. A start that failed before any dial (the app
        // session refused, a cooldown that outlasted the budget) has no dial
        // to name and logs `dial: null`.
        fastify.log.warn({ err: error, dial: dialLogFields(error?.dial) }, 'the room session could not be opened')
      },
    )

    return reply.send({
      state: LOGIN_STATES.PREPARING,
      pollToken: attempt.id,
      pollAfterMs: DEFAULTS.pollAfterMs,
      roomId,
    })
  })

  /**
   * The code is minted HERE, at the moment the source reported it was listening.
   *
   * issued_at is the LATER of "when this visitor asked" and "when listening
   * began", and it needs both halves:
   *
   *   * a socket that took four seconds to open must not spend four seconds of
   *     this visitor's ten minutes, so listeningSince wins when it is later. Read
   *     off the source's own status rather than taken from this file's clock —
   *     one timeline, so status({ since: issued_at }) compares a value against
   *     itself and answers exactly rather than approximately.
   *   * a socket that was ALREADY open — because another visitor is mid-wait —
   *     has a listeningSince from minutes ago, and inheriting it would hand this
   *     visitor a code that expires early and, worse, make
   *     status({ since }) read as continuous for a window they were never in.
   *     The request time is the floor.
   *
   * Both are string comparisons, which is chronological comparison: that is what
   * the canonical second-precision format is FOR.
   */
  function onListening(attempt, lease) {
    const listeningSince = lease.status.listeningSince
    const issuedAt =
      typeof listeningSince === 'string' && listeningSince > attempt.requestedAt
        ? listeningSince
        : attempt.requestedAt
    const expiresAt = addMinutes(issuedAt, codeTtlMinutes)
    const id = randomUUID()

    for (let tries = 0; ; tries += 1) {
      try {
        q.insertCode.run({
          id,
          code: randomCode(),
          // The phrase the visitor actually posts. Regenerated on each retry
          // alongside `code`, because either UNIQUE column can be the one that
          // collided — with ~225k phrases a collision is rare but the same retry
          // that protects `code` protects this.
          challenge_text: generateChallengePhrase(),
          session_id: attempt.sessionId,
          room_id: roomId,
          issued_at: issuedAt,
          expires_at: expiresAt,
        })
        break
      } catch (error) {
        // code and challenge_text are both UNIQUE across all history, so that a
        // late danmaku resolves to exactly one code forever. A collision on
        // either is a retry, not an ambiguity.
        if (tries >= 5 || !isUniqueViolation(error)) throw error
      }
    }

    attempt.codeId = id
    leaseByCode.set(id, lease.leaseId)
  }

  // ---------------------------------------------------------------------------
  // GET /api/login/status

  fastify.get('/api/login/status', async (request, reply) => {
    sweepExpired()

    const session = currentSession(request)
    if (session === null) return refuse(reply, 404, 'no_verification_in_progress')

    if (session.submitter_id !== null) {
      return reply.send({
        state: LOGIN_STATES.VERIFIED,
        roomId,
        submitter: publicSubmitter(q.submitterById.get(session.submitter_id)),
      })
    }

    const token = request.query?.token
    if (typeof token === 'string' && token !== '') {
      const named = attempts.get(token)
      // A token belonging to somebody else is never answered — not even with
      // "expired", which would confirm it had once existed.
      if (named !== undefined && named.sessionId !== session.id) {
        return refuse(reply, 404, 'unknown_poll_token')
      }
      if (named !== undefined) return reply.send(describeAttempt(named))
      // The attempt is over; the code row below is the authority now.
    }

    const attempt = attempts.get(bySession.get(session.id))
    if (attempt !== undefined) return reply.send(describeAttempt(attempt))

    const latest = q.latestCodeForSession.get({ session_id: session.id })
    if (latest === undefined) return refuse(reply, 404, 'no_verification_in_progress')
    if (latest.state === 'pending') return reply.send(waitingBody(latest))
    return reply.send({
      state: latest.state === 'verified' ? LOGIN_STATES.VERIFIED : LOGIN_STATES.EXPIRED,
      roomId,
      detail: latest.state,
    })
  })

  function describeAttempt(attempt) {
    if (attempt.codeId !== null) {
      const row = q.codeById.get(attempt.codeId)
      if (row !== undefined && row.state === 'pending') return waitingBody(row)
      if (row !== undefined) {
        return {
          state: row.state === 'verified' ? LOGIN_STATES.VERIFIED : LOGIN_STATES.EXPIRED,
          roomId,
          detail: row.state,
        }
      }
    }
    if (attempt.failure !== null) {
      return {
        state: LOGIN_STATES.ROOM_UNREACHABLE,
        roomId,
        pollToken: attempt.id,
        // The verdict, never the source's lastError text: that string is ours
        // and can carry internals a visitor has no business reading.
        detail: attempt.failure,
      }
    }
    return {
      state: LOGIN_STATES.PREPARING,
      pollToken: attempt.id,
      pollAfterMs: DEFAULTS.pollAfterMs,
      roomId,
    }
  }

  /**
   * A live code, plus the one honest answer to "would we have seen it?".
   *
   * Everything a UI is allowed to say to a waiting visitor follows from
   * `canAssertNotSeen`, which is the source's own boolean and not a re-derivation
   * of it. The three verdicts that are not listening become room-unreachable so
   * that "our side is deaf" can never be rendered as "you have not sent it yet".
   */
  function waitingBody(row) {
    const at = stamp()
    const snapshot = source.status({ since: row.issued_at })
    const base = {
      roomId: row.room_id,
      // The client renders `code` and copies it to post as a danmaku, so it must
      // be the PHRASE, not the internal handle. Falls back to the handle only for
      // a row minted before this feature (challenge_text NULL) — none reachable
      // in a live deployment, but the fallback keeps an old row renderable.
      code: row.challenge_text ?? row.code,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      expiresInSeconds: Math.max(0, Math.round((Date.parse(row.expires_at) - Date.parse(at)) / 1000)),
    }

    switch (snapshot.visitor.verdict) {
      case VISITOR_VERDICTS.LISTENING:
      case VISITOR_VERDICTS.LISTENING_NO_MATCH:
      case VISITOR_VERDICTS.LISTENING_AFTER_GAP:
        return {
          ...base,
          state: LOGIN_STATES.WAITING,
          listeningSince: snapshot.listeningSince,
          // False means: we are listening NOW, but there was a window since the
          // code was issued in which we were not, so a danmaku sent then is gone.
          // The visitor did nothing wrong and must not be told they did.
          canAssertNotSeen: snapshot.visitor.canAssertNotSeen,
          resend: snapshot.visitor.canAssertNotSeen === false,
        }
      case VISITOR_VERDICTS.STARTING:
        return { ...base, state: LOGIN_STATES.PREPARING, pollAfterMs: DEFAULTS.pollAfterMs }
      default:
        // NOT_LISTENING, RECONNECTING, FAILED. Our side is deaf, and saying so is
        // the whole reason this state exists separately from `waiting`.
        return { ...base, state: LOGIN_STATES.ROOM_UNREACHABLE, detail: snapshot.visitor.verdict }
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/login/cancel

  fastify.post('/api/login/cancel', async (request, reply) => {
    const session = currentSession(request)
    if (session === null) return reply.send({ cancelled: false })
    return reply.send({ cancelled: cancelVerification(session.id) })
  })

  /** Give the room socket back. Idempotent: a visitor may close the tab twice. */
  function cancelVerification(sessionId) {
    let cancelled = false
    const attemptId = bySession.get(sessionId)
    const attempt = attemptId === undefined ? undefined : attempts.get(attemptId)
    if (attempt !== undefined) {
      // The acquire may still be in flight. Marking it abandoned is what makes
      // the continuation release a lease nobody is waiting for.
      attempt.abandoned = true
      dropAttempt(attempt)
      cancelled = true
    }
    const at = stamp()
    for (const row of q.pendingCodesForSession.all({ session_id: sessionId })) {
      q.cancelCode.run({ id: row.id, closed_at: at })
      releaseFor(row.id)
      cancelled = true
    }
    return cancelled
  }

  // ---------------------------------------------------------------------------
  // POST /api/logout

  fastify.post('/api/logout', async (request, reply) => {
    const session = currentSession(request)
    if (session !== null) {
      cancelVerification(session.id)
      // The local acceptance session is re-injected by app.mjs on the next
      // request. Keep its row live so logout does not turn a no-login server
      // into a login-required server until the next restart.
      if (!options.devAdminBypass) q.revokeSession.run({ id: session.id, revoked_at: stamp() })
    }
    // Cleared unconditionally: a cookie naming a session this server has never
    // heard of should still stop being sent.
    cookies.remove(reply)
    return reply.send({ ok: true })
  })

  // ---------------------------------------------------------------------------
  // GET /api/me

  fastify.get('/api/me', async (request, reply) => {
    const actor = resolveActor(request)
    if (actor?.error !== undefined) return refuse(reply, actor.error === 'user_agent_required' ? 400 : 401, actor.error)
    const session = actor?.session ?? null
    if (session === null || session.submitter_id === null) {
      return reply.send({ submitter: null })
    }
    return reply.send({ submitter: publicSubmitter(q.submitterById.get(session.submitter_id)) })
  })

  function publicSubmitter(row) {
    if (row === undefined) return null
    return {
      id: row.id,
      // The session's OWN open_id, returned only to that session. It is how the
      // owner learns the value ADMIN_OPEN_IDS has to contain, which
      // deploy/runtime.env.example tells them to obtain by logging in once.
      openId: row.open_id,
      displayName: row.display_name,
      submittedCount: row.submitted_count,
      approvedCount: row.approved_count,
      rejectedCount: row.rejected_count,
      blocked: row.blocked === 1,
      blockedReason: row.blocked_reason,
      // Whether THIS session may reach the review desk.
      //
      // It exists so the navbar can offer the desk to the owner instead of
      // making them remember a URL — the requirement was "show the admin page
      // when the signed-in open_id is one of the configured ones", and without
      // this the site has no way to know.
      //
      // It does NOT weaken routes/admin.mjs answering a stranger 404 rather
      // than 403. That refusal exists so the desk's existence is not confirmed
      // to somebody who is not an admin; this field is returned only to an
      // authenticated session, only about ITSELF, and only ever says `false` to
      // a non-admin — which is a thing they could already establish by asking
      // for /admin. Nothing here tells anyone about anybody else, and the
      // allow-list itself is never published.
      //
      // Both admin sources, so the navbar offers the desk to an online-added
      // admin too — the env seed OR an active row in `admins`, which is the same
      // union routes/admin.mjs's gate uses. Anything else would let the gate
      // admit them while this field told them they were not admins.
      admin: adminOpenIds.has(row.open_id) || q.activeAdmin.get(row.open_id) !== undefined,
    }
  }

  // ---------------------------------------------------------------------------
  // API credentials

  fastify.post('/api/auth/challenge', async (request, reply) => {
    const clientLabel = validateApiClient(request.body?.client)
    if (clientLabel === null) return refuse(reply, 400, 'invalid_client_label')
    const issued = await issueApiChallenge(clientLabel)
    if (issued.error !== undefined) return refuse(reply, issued.status, issued.error)
    return reply.send(apiChallengeBody(issued.row))
  })

  fastify.post('/api/auth/poll', async (request, reply) => {
    sweepExpired()
    const pollToken = request.body?.pollToken
    if (typeof pollToken !== 'string' || pollToken === '') {
      return refuse(reply, 400, 'poll_token_required')
    }
    const row = q.codeById.get(pollToken)
    if (row === undefined) return refuse(reply, 401, 'expired_poll_token')
    const session = q.sessionById.get(row.session_id)
    if (session === undefined || session.kind !== 'api') {
      return refuse(reply, 401, 'expired_poll_token')
    }
    if (row.state === 'pending') return reply.send(apiChallengeBody(row))
    if (row.state !== 'verified') return refuse(reply, 401, 'expired_poll_token')
    if (session.token_issued_at !== null) return refuse(reply, 409, 'token_already_issued')
    if (session.submitter_id === null) return refuse(reply, 401, 'expired_poll_token')

    let issued
    try {
      issued = issueApiToken(session.id)
    } catch (error) {
      if (error?.code === 'API_TOKEN_ALREADY_ISSUED') {
        return refuse(reply, 409, 'token_already_issued')
      }
      throw error
    }
    if (issued === null) return refuse(reply, 401, 'expired_poll_token')
    return reply.send({
      state: 'verified',
      token: issued.token,
      expiresAt: issued.expiresAt,
      submitter: publicSubmitter(q.submitterById.get(session.submitter_id)),
      revokedOldest: issued.revokedOldest,
    })
  })

  fastify.post('/api/auth/revoke', async (request, reply) => {
    const actor = resolveActor(request)
    if (actor?.error !== undefined) return refuse(reply, actor.error === 'user_agent_required' ? 400 : 401, actor.error)
    if (actor === null || actor.kind !== 'api') return refuse(reply, 401, 'api_identity_required')
    const revoked = q.revokeSession.run({ id: actor.session.id, revoked_at: stamp() }).changes === 1
    return reply.send({ revoked })
  })

  fastify.post('/api/auth/revoke-all', async (request, reply) => {
    sweepExpired()
    const pollToken = request.body?.pollToken
    if (typeof pollToken === 'string' && pollToken !== '') {
      const row = q.codeById.get(pollToken)
      const session = row === undefined ? undefined : q.sessionById.get(row.session_id)
      if (
        row === undefined
        || session === undefined
        || session.kind !== 'api'
        || session.client_label !== 'revoke-all'
        || session.revoked_at !== null
      ) {
        return refuse(reply, 401, 'expired_poll_token')
      }
      if (row.state === 'pending') return reply.send({ ...apiChallengeBody(row), action: 'revoke-all' })
      if (row.state !== 'verified' || session.submitter_id === null) {
        return refuse(reply, 401, 'expired_poll_token')
      }
      const revoked = q.revokeAllApiSessions.run({
        submitter_id: session.submitter_id,
        revoked_at: stamp(),
      }).changes
      // The fresh challenge session is not itself a credential. Close it after
      // spending its one-time proof so the poll token cannot be replayed while
      // still keeping the response count limited to issued API tokens.
      q.revokeSession.run({ id: session.id, revoked_at: stamp() })
      return reply.send({ revoked, action: 'revoke-all' })
    }

    const issued = await issueApiChallenge('revoke-all')
    if (issued.error !== undefined) return refuse(reply, issued.status, issued.error)
    return reply.send({ ...apiChallengeBody(issued.row), action: 'revoke-all' })
  })

  function validateApiClient(value) {
    const checked = validateCaption(value, { maxLength: 80 })
    return checked.ok ? escapeForI18n(value.trim()) : null
  }

  function createApiSession(clientLabel) {
    const at = stamp()
    const id = randomUUID()
    q.insertSession.run({
      id,
      token_sha256: sha256Hex(randomToken()),
      created_at: at,
      last_seen_at: at,
      expires_at: addMinutes(at, API_TOKEN_TTL_MINUTES),
      kind: 'api',
      client_label: clientLabel,
      last_used_at: null,
      token_issued_at: null,
    })
    return q.sessionById.get(id)
  }

  async function issueApiChallenge(clientLabel) {
    if (roomId === null) return { status: 503, error: 'room_not_configured' }
    if (q.countPendingCodes.get({ now: stamp() }).n >= maxPendingCodes) {
      return { status: 503, error: 'verification_capacity' }
    }
    const session = createApiSession(clientLabel)
    const attempt = {
      id: randomToken(),
      sessionId: session.id,
      requestedAt: stamp(),
      codeId: null,
      failure: null,
      abandoned: false,
    }
    attempts.set(attempt.id, attempt)
    bySession.set(session.id, attempt.id)
    let lease = null
    try {
      lease = await source.acquire()
      onListening(attempt, lease)
      const row = q.codeById.get(attempt.codeId)
      if (row === undefined) throw new Error('API challenge row was not created')
      return { row }
    } catch (error) {
      if (lease !== null) {
        if (attempt.codeId !== null) releaseFor(attempt.codeId)
        else source.release(lease.leaseId)
      }
      attempts.delete(attempt.id)
      bySession.delete(session.id)
      q.revokeSession.run({ id: session.id, revoked_at: stamp() })
      fastify.log.warn({ err: error }, 'the API identity challenge could not be issued')
      return { status: 503, error: 'api_challenge_unavailable' }
    }
  }

  function apiChallengeBody(row) {
    const { code, ...waiting } = waitingBody(row)
    return {
      ...waiting,
      challenge: code,
      pollToken: row.id,
    }
  }

  const issueApiToken = db.transaction((sessionId) => {
    const current = q.sessionById.get(sessionId)
    if (current === undefined || current.kind !== 'api' || current.token_issued_at !== null) {
      const error = new Error('API token was already issued')
      error.code = 'API_TOKEN_ALREADY_ISSUED'
      throw error
    }
    const active = q.apiSessionsForSubmitter.all({
      submitter_id: current.submitter_id,
      now: stamp(),
    })
    let revokedOldest = null
    if (active.length >= API_TOKEN_LIMIT) {
      const oldest = active[0]
      q.revokeSession.run({ id: oldest.id, revoked_at: stamp() })
      revokedOldest = { id: oldest.id, clientLabel: oldest.client_label }
    }
    const token = apiTokens.mint()
    const issuedAt = stamp()
    const expiresAt = addMinutes(issuedAt, API_TOKEN_TTL_MINUTES)
    if (q.issueApiToken.run({
      id: current.id,
      token_sha256: apiTokens.hash(token),
      token_issued_at: issuedAt,
      expires_at: expiresAt,
    }).changes !== 1) {
      const error = new Error('API token was already issued')
      error.code = 'API_TOKEN_ALREADY_ISSUED'
      throw error
    }
    return { token, expiresAt, revokedOldest }
  })

  fastify.get('/api/submit/contract', async (_request, reply) => reply.send(submissionContract()))

  function submissionContract() {
    return {
      contractVersion: 1,
      groups: q.activeGroups.all().map((row) => ({ id: row.id, displayName: row.display_name })),
      locales: q.locales.all().map((row) => ({ code: row.code, label: row.label })),
      limits: {
        maxClipsPerBatch,
        maxFileBytes,
        batchesPerMinute: 1,
      },
      audio: {
        accept: [AUDIO_MPEG.contentType, AUDIO_MP4.contentType, AUDIO_OGG.contentType, AUDIO_WAV.contentType],
      },
      errors: Object.keys(PUBLIC_REASONS).sort(),
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/submit/preflight

  fastify.get('/api/submit/preflight', async (request, reply) => {
    const actor = resolveActor(request)
    if (actor?.error !== undefined) return refuse(reply, actor.error === 'user_agent_required' ? 400 : 401, actor.error)
    const session = actor?.session ?? null
    if (session === null || session.submitter_id === null) {
      return refuse(reply, 401, 'identity_required')
    }
    const submitter = q.submitterById.get(session.submitter_id)
    return reply.send({
      ...submissionContract(),
      rate: submissionRate(session, submitter),
    })
  })

  function submissionRate(session, submitter) {
    const now = stamp()
    const submitterRecent = q.recentSubmissions.get({
      submitter_id: submitter.id,
      since: addMinutes(now, -SUBMISSION_WINDOW_SECONDS / 60),
    })
    const sessionRecent = q.recentSubmissionsBySession.get({
      session_id: session.id,
      since: addMinutes(now, -SUBMISSION_WINDOW_SECONDS / 60),
    })
    return decideSubmissionRate({
      now,
      submitter: { count: submitterRecent.n, oldest: submitterRecent.oldest },
      session: { count: sessionRecent.n, oldest: sessionRecent.oldest },
    })
  }

  // ---------------------------------------------------------------------------
  // POST /api/submit

  fastify.post('/api/submit', async (request, reply) => {
    const actor = resolveActor(request)
    if (actor?.error !== undefined) return refuse(reply, actor.error === 'user_agent_required' ? 400 : 401, actor.error)
    const session = actor?.session ?? null
    if (session === null || session.submitter_id === null) {
      return refuse(reply, 401, 'identity_required')
    }
    const submitter = q.submitterById.get(session.submitter_id)
    if (submitter.blocked === 1) {
      return refuse(reply, 403, 'submitter_blocked', { reason: submitter.blocked_reason })
    }
    if (!request.isMultipart()) return refuse(reply, 415, 'multipart_required')

    const rate = submissionRate(session, submitter)
    if (!rate.allowed) return rateLimited(reply, rate.retryAfterSeconds)

    let reservation
    try {
      reservation = await storageGuard.reserve(storageWorstCaseBytes)
    } catch (error) {
      fastify.log.warn({ err: error }, 'storage admission check failed')
      return storageRefuse(reply)
    }
    if (!reservation.allowed) return storageRefuse(reply)

    try {
      const tmpDir = stagingDir
      await mkdir(tmpDir, { recursive: true })

      // The list is owned HERE and handed in, not returned. A files-limit error
      // aborts the iterator with ten temp files already on disk, and a harvest
      // that reports its uploads only by returning them reports nothing at all
      // when it throws — which is the one case where they are guaranteed to be
      // orphans.
      const uploads = []
      try {
        let harvest
        try {
          harvest = await harvestParts(request, tmpDir, maxFileBytes, uploads)
        } catch (error) {
          const mapped = mapMultipartError(error)
          if (mapped === null) throw error
          return refuse(reply, mapped.status, mapped.code)
        }

        const outcome = await completeSubmission({ session, submitter, harvest })
        if (outcome.status === 429) {
          reply.header('retry-after', String(outcome.body.retryAfterSeconds))
        }
        return reply.code(outcome.status).send(outcome.body)
      } finally {
        // Before the response, not after it. A blob renamed into media no longer
        // exists at its temp path, so this cannot delete a published one.
        await discard(uploads)
      }
    } finally {
      storageGuard.release(storageWorstCaseBytes)
    }
  })

  async function completeSubmission({ session, submitter, harvest }) {
    const rate = submissionRate(session, submitter)
    if (!rate.allowed) return rateDenied(rate.retryAfterSeconds)
    if (harvest.metadata === null) return deny(400, 'metadata_required')

    const spec = parseMetadata(harvest.metadata, maxClipsPerBatch)
    if (spec.error !== null) {
      return deny(spec.error === 'too_many_items' ? 413 : 400, spec.error)
    }
    if (spec.items.length === 0 && harvest.uploads.length === 0) {
      return deny(400, 'no_items')
    }

    const at = stamp()
    const verdicts = []
    const accepted = []
    const seenSha = new Map()

    for (const item of spec.items) {
      const upload = harvest.byKey.get(item.key)
      if (upload === undefined) {
        verdicts.push({ key: item.key, position: item.position, state: 'rejected', ...reasonOf('missing_file') })
        continue
      }
      const outcome = await admitItem(item, upload, { seenSha, at })
      if (outcome.ok) {
        accepted.push(outcome.value)
        seenSha.set(outcome.value.media.sha256, item.key)
        verdicts.push({
          key: item.key,
          position: item.position,
          state: 'pending',
          sha256: outcome.value.media.sha256,
          durationSeconds: outcome.value.media.duration_seconds,
          bytes: outcome.value.media.bytes,
        })
      } else {
        verdicts.push({
          key: item.key,
          position: item.position,
          state: 'rejected',
          ...reasonOf(outcome.code, outcome.detail),
        })
      }
    }

    // A file nobody described. Reported rather than ignored: silence here reads
    // to the submitter as "it went through".
    for (const upload of harvest.uploads) {
      if (spec.keys.has(upload.key)) continue
      verdicts.push({ key: upload.key, state: 'rejected', ...reasonOf('metadata_missing') })
    }

    if (accepted.length === 0) {
      // No batch at all. batches_resolve_needs_all_items_resolved makes an empty
      // one unresolvable for the life of the database, so it would sit in
      // 'submitted' forever waiting for items that are never coming.
      return { status: 422, body: { ...deny(422, 'no_valid_items').body, items: verdicts } }
    }

    // Files first, rows second: a committed media row must never point at bytes
    // that are not there. The reverse ordering is recoverable only by hand.
    const created = []
    for (const entry of accepted) {
      if (await placeMedia(entry, mediaDir)) created.push(entry.targetPath)
    }

    let batchId
    try {
      batchId = persistBatch({ session, submitter, accepted, at })
    } catch (error) {
      // Nothing references these bytes and nothing ever will: v_unreferenced_media
      // cannot see a file with no media row, so leaving them would be an orphan no
      // janitor can find.
      await Promise.all(created.map((path) => rm(path, { force: true }).catch(() => {})))
      throw error
    }

    return {
      status: 200,
      body: {
        batchId,
        accepted: accepted.length,
        rejected: verdicts.length - accepted.length,
        items: verdicts,
      },
    }
  }

  /**
   * One item, validated end to end and independently of every other. Nothing in
   * here can fail an item other than this one.
   */
  async function admitItem(item, upload, { seenSha, at }) {
    if (upload.truncated) return { ok: false, code: 'file_too_large' }
    if (upload.bytes === 0) return { ok: false, code: 'empty_file' }

    const audio = await inspectAudio(upload)
    if (!audio.ok) return audio

    // Already-published check on the INPUT sha, BEFORE the re-encode. Two things
    // are published under an input-byte sha rather than a normalized one: the
    // baseline clips (import-snapshot.mjs hashes public/voices/*.mp3 as-is) and
    // any clip approved before normalization existed. Their original bytes are
    // publicly fetchable (/media, /voices), so re-uploading them is the easy
    // duplicate — and the post-normalize check below would MISS it, because the
    // re-encode changes the sha. Checking here restores that rejection and skips
    // the ffmpeg work for it. A clip published through the new pipeline is stored
    // under its normalized sha, so re-uploading ITS bytes matches here too; a
    // fresh original whose normalized form was published matches the check below.
    if (q.clipByMedia.get(audio.value.sha256) !== undefined) {
      return { ok: false, code: 'already_published' }
    }

    // Loudness normalization — the intake step that replaced the README's "run
    // MP3Gain yourself before submitting". It re-encodes, so EVERYTHING
    // identity-shaped about the blob (sha256, bytes, duration) is recomputed
    // from the OUTPUT below; the numbers measured from the upload describe a
    // file that no longer proceeds. Dedupe still works because the re-encode is
    // deterministic (-bitexact): same original in, same bytes out.
    let media
    try {
      media = await normalizeStagedUpload(normalizer, upload, audio.value)
    } catch (error) {
      // The full story (ffmpeg stderr in error.cause) belongs in the log; the
      // submitter gets the one fact they can act on.
      fastify.log.warn({ err: error, key: item.key }, 'loudness normalization refused an upload')
      return { ok: false, code: 'audio_processing_failed' }
    }

    // maxFileBytes is enforced on the UPLOAD by busboy, but the re-encode is to a
    // fixed 192 kbps, so output size tracks DURATION, not input size: a 5 MB clip
    // at 32 kbps is ~20 minutes and re-encodes to ~30 MB. Nothing caps duration
    // (inspectAudio only requires > 0), so without this the stored file — the
    // one that costs PVC space and serves for a year immutable — can far exceed
    // the ruled per-clip limit. A real voice-button clip is seconds long and
    // never approaches it; this only refuses the pathological long/low-bitrate
    // input. upload.path now points at the .norm file, so discard() cleans it.
    if (media.bytes > maxFileBytes) return { ok: false, code: 'file_too_large' }

    if (seenSha.has(media.sha256)) return { ok: false, code: 'duplicate_in_batch' }
    // clips.media_sha256 is UNIQUE, so this blob could never become a second
    // clip. Refusing now beats accepting something whose rejection is already
    // determined. This is the normalized-sha half; the input-sha half is above.
    if (q.clipByMedia.get(media.sha256) !== undefined) {
      return { ok: false, code: 'already_published' }
    }

    const text = validateItemText(item, q)
    if (!text.ok) return text

    return {
      ok: true,
      value: {
        item,
        sourcePath: upload.path,
        targetPath: join(mediaDir, storagePath(media.sha256, audio.value.ext)),
        media: {
          sha256: media.sha256,
          ext: audio.value.ext,
          content_type: audio.value.contentType,
          bytes: media.bytes,
          duration_seconds: media.duration,
          uploaded_at: at,
        },
        proposed_label: text.value.label,
        proposed_group_id: item.groupId,
        submitter_note: text.value.note,
      },
    }
  }

  const persistBatch = db.transaction(({ session, submitter, accepted, at }) => {
    for (const entry of accepted) {
      // ON CONFLICT DO NOTHING: the same bytes may already be here from an
      // earlier submission, and media is one row per distinct blob.
      q.insertMedia.run(entry.media)
      // ...and if those bytes had been reclaimed, they are present again now.
      q.reviveMedia.run(entry.media.sha256)
    }

    const batchId = randomUUID()
    q.insertBatch.run({
      id: batchId,
      submitter_id: submitter.id,
      session_id: session.id,
      created_at: at,
      legacy_required: 0,
      legacy_verdict: null,
      legacy_decided_at: null,
    })

    for (const entry of accepted) {
      q.insertBatchItem.run({
        id: randomUUID(),
        batch_id: batchId,
        // The submitter's own numbering, holes and all: item 3 failing leaves
        // positions 1, 2, 4, 5, which is what the submitter saw on their screen.
        position: entry.item.position,
        media_sha256: entry.media.sha256,
        proposed_label: entry.proposed_label,
        proposed_group_id: entry.proposed_group_id,
        submitter_note: entry.submitter_note,
        created_at: at,
      })
    }

    q.submitBatch.run({ id: batchId, submitted_at: at })
    // The denormalised counter submitters carries. Incremented rather than
    // recomputed from v_submitter_counts_expected: that view exists so drift is
    // DETECTABLE, and a writer that quietly rewrites the value from the truth
    // hides the bug it was meant to expose.
    q.countSubmission.run({ id: submitter.id, last_seen_at: at })

    recordAudit(db, {
      actorKind: 'submitter',
      actorOpenId: submitter.open_id,
      actorDisplayName: submitter.display_name,
      verb: 'submit.batch',
      subject: { kind: 'batch', id: batchId },
      before: null,
      after: {
        items: accepted.length,
        source: session.kind === 'api' ? 'api' : 'web',
      },
      consequence: batchId,
      succeeded: true,
      occurredAt: at,
    })

    return batchId
  })

  // ---------------------------------------------------------------------------
  // GET /api/my/submissions

  fastify.get('/api/my/submissions', async (request, reply) => {
    const actor = resolveActor(request)
    if (actor?.error !== undefined) return refuse(reply, actor.error === 'user_agent_required' ? 400 : 401, actor.error)
    const session = actor?.session ?? null
    if (session === null || session.submitter_id === null) {
      return refuse(reply, 401, 'identity_required')
    }

    const limit = clampLimit(request.query?.limit)
    const cursor = decodeCursor(request.query?.cursor)
    const rows = q.batchesForSubmitter.all({
      submitter_id: session.submitter_id,
      // Keyset, not OFFSET: a batch submitted while somebody is paging would
      // shift every unread page by one.
      cursor_created_at: cursor?.c ?? null,
      cursor_id: cursor?.i ?? null,
      limit: limit + 1,
    })
    const page = rows.slice(0, limit)

    return reply.send({
      submissions: page.map((batch) => ({
        id: batch.id,
        state: batch.state,
        createdAt: batch.created_at,
        submittedAt: batch.submitted_at,
        resolvedAt: batch.resolved_at,
        items: q.itemsForBatch.all({ batch_id: batch.id }).map(describeItem),
      })),
      nextCursor: rows.length > limit
        ? encodeCursor({ c: page[page.length - 1].created_at, i: page[page.length - 1].id })
        : null,
    })
  })

  function describeItem(row) {
    const note = readSubmitterNote(row.submitter_note)
    return {
      id: row.id,
      position: row.position,
      state: row.state,
      name: row.proposed_label,
      caption: note.caption,
      groupId: row.proposed_group_id,
      groupName: row.group_display_name,
      proposedGroup: note.proposedGroup,
      note: note.note,
      // The reviewer's sentence, which the table refuses to let them omit on a
      // rejection: "a refusal the submitter cannot read is a refusal nobody can
      // appeal."
      reviewerNote: row.reviewer_note,
      clipId: row.clip_id,
      resolvedAt: row.resolved_at,
      media: {
        sha256: row.media_sha256,
        bytes: row.bytes,
        durationSeconds: row.duration_seconds,
        // Relative, as the column is: the URL prefix is the web pod's business.
        storagePath: row.storage_path,
      },
    }
  }

  // ---------------------------------------------------------------------------

  fastify.addHook('onClose', async () => {
    unsubscribeDanmaku()
    unsubscribeDial()
    // Release exactly what this plugin took, by id, and let the source's own
    // refcount decide whether the socket closes. Stopping the source here would
    // be this plugin deciding the lifetime of something it does not own.
    for (const attempt of attempts.values()) attempt.abandoned = true
    for (const codeId of [...leaseByCode.keys()]) releaseFor(codeId)
    attempts.clear()
    bySession.clear()
    recovering.clear()
  })
}

export { publicRoutes }

// ---------------------------------------------------------------------------
// Dial records, as a log line may carry them

const DIAL_LOG_FIELDS = Object.freeze(['host', 'phase', 'elapsedMs', 'attempt', 'outcome'])

/**
 * The five fields of a transport dial record that a log line may carry, copied
 * by name — or null when there is no record to copy.
 *
 * A whitelist rather than trust. The transport builds the record from these
 * same five, and copying them again here is what keeps a field added there by
 * mistake — the auth_body that authenticated the dial, say — out of production
 * logs anyway. A value survives only as a string or a finite number, so a
 * nested object cannot smuggle anything past the names either. A missing field
 * reads null instead of vanishing: every line has the same five keys, and a log
 * query never has to guess which were lost.
 *
 * It governs the `dial` field and nothing else. An error that carries its own
 * `dial` is serialised by pino's err serializer, which copies the error's
 * enumerable fields as they are; what reaches that copy is the transport's
 * business, and by its contract it is the same five fields.
 *
 * Exported for the case that feeds it a poisoned record; the route above is its
 * only caller.
 */
export function dialLogFields(record) {
  if (record === null || typeof record !== 'object') return null
  const fields = {}
  for (const name of DIAL_LOG_FIELDS) {
    const value = record[name]
    fields[name] = typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : null
  }
  return fields
}

// ---------------------------------------------------------------------------
// Multipart harvesting

/**
 * Drain the whole body: fields into memory, files onto disk.
 *
 * Every file part is consumed to its end even when it is already known to be
 * useless. Abandoning a part makes busboy stop parsing — it never emits 'finish'
 * — so skipping item 3's bytes would silently drop items 4 and 5, which is the
 * exact failure the per-item rule forbids.
 */
async function harvestParts(request, tmpDir, maxFileBytes, uploads) {
  const harvest = { metadata: null, uploads, byKey: new Map() }

  for await (const part of request.parts(PARTS_OPTIONS)) {
    if (part.type === 'field') {
      if (part.fieldname === 'metadata') harvest.metadata = part.value
      continue
    }

    const key = part.fieldname.startsWith('file:') ? part.fieldname.slice(5) : part.fieldname
    const upload = await drainFile(part, key, tmpDir, maxFileBytes)
    uploads.push(upload)
    // First writer wins, so a second part claiming a key cannot displace the
    // file already matched to it. The loser is reported as metadata_missing.
    if (!harvest.byKey.has(key)) harvest.byKey.set(key, upload)
  }

  return harvest
}

async function drainFile(part, key, tmpDir, maxFileBytes) {
  // NO EXTENSION, and this is not cosmetic: music-metadata trusts a path's
  // extension over its bytes, so a temp file called anything.part would hand a
  // PNG to the mp3 parser and get back a silent, empty, error-free result.
  const path = join(tmpDir, randomUUID())
  if (extname(path) !== '') {
    throw new Error(
      'routes/public: the upload temp path grew an extension. music-metadata would then ' +
        'identify the file by its NAME, and content sniffing — the whole point of this route — stops.',
    )
  }

  const hash = createHash('sha256')
  const head = Buffer.alloc(HEAD_BYTES)
  let headLength = 0
  let bytes = 0

  const out = createWriteStream(path)
  try {
    for await (const chunk of part.file) {
      hash.update(chunk)
      bytes += chunk.length
      if (headLength < HEAD_BYTES) {
        headLength += chunk.copy(head, headLength, 0, Math.min(chunk.length, HEAD_BYTES - headLength))
      }
      if (!out.write(chunk)) await once(out, 'drain')
    }
  } finally {
    out.end()
    await finished(out).catch(() => {})
  }

  return {
    key,
    path,
    bytes,
    head: head.subarray(0, headLength),
    sha256: hash.digest('hex'),
    // busboy truncates at the limit rather than erroring, because
    // throwFileSizeLimit is off. `bytes` therefore equals the cap exactly, which
    // is indistinguishable from a file that happens to be that size — hence the
    // flag rather than an arithmetic test.
    truncated: part.file.truncated === true || bytes > maxFileBytes,
  }
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve))
}

async function discard(uploads) {
  if (!Array.isArray(uploads)) return
  await Promise.all(uploads.map((upload) => rm(upload.path, { force: true }).catch(() => {})))
}

function mapMultipartError(error) {
  switch (error?.code) {
    case 'FST_FILES_LIMIT':
      return { status: 413, code: 'too_many_files' }
    case 'FST_PARTS_LIMIT':
      return { status: 413, code: 'too_many_files' }
    case 'FST_FIELDS_LIMIT':
      return { status: 400, code: 'too_many_fields' }
    case 'FST_INVALID_MULTIPART_CONTENT_TYPE':
      return { status: 415, code: 'multipart_required' }
    case 'FST_MULTIPART_MALFORMED_PART_HEADER':
    case 'FST_PROTO_VIOLATION':
    case 'FST_REQ_FILE_TOO_LARGE':
      return { status: 400, code: 'malformed_multipart' }
    default:
      // A premature close carries no fastify code of its own on every path.
      return /terminated early|Premature close|Unexpected end of form/i.test(error?.message ?? '')
        ? { status: 400, code: 'malformed_multipart' }
        : null
  }
}

// ---------------------------------------------------------------------------
// Audio: identified by its bytes, classified by this file's own table

async function inspectAudio(upload) {
  let format
  try {
    // No fileInfo argument. Passing one — a mimeType or a path with an extension
    // — is what makes this trust the client instead of the bytes.
    ;({ format } = await parseFile(upload.path))
  } catch (error) {
    return {
      ok: false,
      // 'could not tell what this is' and 'this is a PNG' are different answers
      // and a submitter can act on the difference.
      code: error?.name === 'UnsupportedFileTypeError' ? 'unsupported_audio_format' : 'unreadable_audio',
    }
  }

  const kind = classifyAudio(format, upload.head)
  if (kind === null) return { ok: false, code: 'unsupported_audio_format' }

  const duration = format.duration
  // media.duration_seconds CHECKs `> 0.0`. A zero-length or unmeasurable clip is
  // a button that plays nothing.
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, code: 'unreadable_duration' }

  return { ok: true, value: { ...kind, sha256: upload.sha256, duration } }
}

/**
 * The four formats media's CHECK allows, decided from what the parser found.
 *
 * MPEG needs the Layer 3 test: an MPEG Layer 2 stream is also `container:'MPEG'`
 * and is not an mp3, and storing it as one would put an extension on the PVC that
 * does not describe the bytes.
 *
 * The MP4 family is recognised from the 'ftyp' box rather than from `container`,
 * because music-metadata reports the ftyp BRAND LIST there ('M4A/mp42/isom',
 * 'isom/iso2/avc1/mp41'), which is a different string for almost every encoder.
 * The brand list is also why hasVideo is the discriminator: an .mp4 video and an
 * .m4a share a container and differ in what is inside it.
 */
function classifyAudio(format, head) {
  const container = format.container ?? ''
  const codec = format.codec ?? ''

  if (container === 'MPEG' && /layer\s*3/i.test(codec)) return AUDIO_MPEG
  if (container === 'WAVE') return AUDIO_WAV
  if (container === 'Ogg') return AUDIO_OGG
  if (head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp') {
    if (format.hasVideo === true) return null
    return AUDIO_MP4
  }
  return null
}

/** media.storage_path is GENERATED as exactly this; the two must not drift. */
function storagePath(sha256, ext) {
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${ext}`
}

/**
 * Run the normalizer over a staged upload and make its OUTPUT the upload.
 *
 * The output is re-sniffed with the same parser and the same classifier the
 * input passed, not because ffmpeg is suspected of malice but because "our own
 * encoder surely produced what we asked for" is exactly the kind of sentence
 * this file refuses to build on — the input was only ever trusted after
 * sniffing, and the output earns the same treatment. A mismatch here is a bug
 * in ENCODERS, and it surfaces as a rejected item plus a logged error instead
 * of a .mp3 path serving ogg bytes for a year from an immutable cache.
 *
 * On success the original staged file is gone and `upload.path` points at the
 * normalized one, so the route's discard() — which cleans by upload.path —
 * keeps cleaning the file that actually exists, whether the item is later
 * accepted (placeMedia renames it away; rm force tolerates that) or rejected
 * by a check downstream of here.
 */
async function normalizeStagedUpload(normalizer, upload, kind) {
  const result = await normalizer.normalize(upload.path, kind)
  try {
    const { format } = await parseFile(result.path)
    const head = await readHead(result.path, 16)
    const rekind = classifyAudio(format, head)
    if (rekind === null || rekind.ext !== kind.ext) {
      throw new Error(
        `normalized output classified as '${rekind?.ext ?? 'nothing'}' but the input was '${kind.ext}'`,
      )
    }
    const duration = format.duration
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('normalized output has no measurable duration')
    }
    const { sha256, bytes } = await hashFile(result.path)
    await rm(upload.path, { force: true })
    upload.path = result.path
    return { sha256, bytes, duration }
  } catch (error) {
    // The .norm file is ours; the caller only knows upload.path. Leaving it
    // would strand one temp file per failed item until the staging sweep.
    await rm(result.path, { force: true }).catch(() => {})
    throw error
  }
}

/** sha256 + size of a file on disk, streamed — uploads are capped, but 5 MB is
 * still not a Buffer someone should readFileSync ten of. */
async function hashFile(path) {
  const handle = await open(path, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let bytes = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      bytes += bytesRead
    }
    return { sha256: hash.digest('hex'), bytes }
  } finally {
    await handle.close()
  }
}

/** First `length` bytes of a file — what classifyAudio's ftyp test reads. */
async function readHead(path, length) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return buffer.subarray(0, filled)
  } finally {
    await handle.close()
  }
}

/**
 * Move the blob to its content-addressed home.
 *
 * Returns true when this call is what created it, which is what tells the caller
 * whether it may delete the file again if the transaction below fails. Also
 * repairs the one state a crash can leave: a media row whose bytes went missing.
 */
async function placeMedia(entry, mediaDir) {
  await mkdir(join(mediaDir, entry.media.sha256.slice(0, 2), entry.media.sha256.slice(2, 4)), {
    recursive: true,
  })
  const present = await stat(entry.targetPath).then(
    () => true,
    () => false,
  )
  if (present) return false
  await rename(entry.sourcePath, entry.targetPath)
  // Renamed away, so the temp sweep must not try again — and must not delete the
  // blob it just published.
  entry.sourcePath = null
  return true
}

// ---------------------------------------------------------------------------
// Submitter text

/**
 * The metadata field, checked before a single item is looked at.
 *
 * Everything here is a whole-request refusal rather than a per-item one, because
 * a metadata document that cannot be read does not describe items at all.
 */
function parseMetadata(raw, maxItems) {
  let document = raw
  if (typeof document === 'string') {
    try {
      document = JSON.parse(document)
    } catch {
      return { error: 'metadata_malformed', items: [], keys: new Set() }
    }
  }
  if (document === null || typeof document !== 'object' || !Array.isArray(document.items)) {
    return { error: 'metadata_malformed', items: [], keys: new Set() }
  }
  if (document.items.length > maxItems) {
    return { error: 'too_many_items', items: [], keys: new Set() }
  }

  const keys = new Set()
  const items = []
  for (const [index, raw_] of document.items.entries()) {
    if (raw_ === null || typeof raw_ !== 'object') {
      return { error: 'metadata_malformed', items: [], keys: new Set() }
    }
    const key = raw_.key
    // The key is what binds a file part to its description, so a duplicate makes
    // the whole document ambiguous rather than making one item wrong.
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(key) || keys.has(key)) {
      return { error: 'metadata_malformed', items: [], keys: new Set() }
    }
    keys.add(key)
    items.push({
      key,
      position: index + 1,
      name: raw_.name,
      caption: raw_.caption,
      groupId: stringOrNull(raw_.groupId),
      newGroup: stringOrNull(raw_.newGroup),
      note: stringOrNull(raw_.note),
      source: raw_.source,
    })
  }

  return { error: null, items, keys }
}

/**
 * The label, the caption, the group choice and the note.
 *
 * Every piece of submitter text goes through validateCaption and is stored as
 * escapeForI18n(raw) — the pairing text-safety.mjs prescribes. escapeForI18n only
 * strips and substitutes one-for-one, so it can never turn text that passed the
 * gate into text that would fail it, and it never lengthens.
 */
function validateItemText(item, q) {
  const label = checkText(item.name, LABEL_MAX_LENGTH)
  if (!label.ok) return { ok: false, code: 'invalid_name', detail: label.reason }

  const caption = item.caption
  if (caption === null || typeof caption !== 'object') {
    return { ok: false, code: 'invalid_caption', detail: 'missing' }
  }
  if (typeof caption.locale !== 'string' || q.localeByCode.get(caption.locale) === undefined) {
    return { ok: false, code: 'unknown_locale' }
  }
  const text = checkText(caption.text, CAPTION_MAX_LENGTH)
  if (!text.ok) return { ok: false, code: 'invalid_caption', detail: text.reason }

  if (item.groupId === null && item.newGroup === null) {
    return { ok: false, code: 'group_choice_required' }
  }
  if (item.groupId !== null && item.newGroup !== null) {
    return { ok: false, code: 'group_choice_ambiguous' }
  }
  if (item.groupId !== null) {
    const group = q.activeGroupById.get(item.groupId)
    // A retired group is refused as firmly as one that never existed:
    // clips_publish_needs_active_group means an item filed there can never be
    // published, so accepting it would guarantee a rejection later.
    if (group === undefined) return { ok: false, code: 'unknown_group' }
  }

  let proposedGroup = null
  if (item.newGroup !== null) {
    const checked = checkText(item.newGroup, GROUP_NAME_MAX_LENGTH)
    if (!checked.ok) return { ok: false, code: 'invalid_group_name', detail: checked.reason }
    proposedGroup = checked.value
  }

  let note = null
  if (item.note !== null) {
    const checked = checkText(item.note, NOTE_MAX_LENGTH)
    if (!checked.ok) return { ok: false, code: 'invalid_note', detail: checked.reason }
    note = checked.value
  }

  const source = validateSourceNote(item.source)
  if (!source.ok) return source

  // Fixed key order, so one submission always serialises to the same bytes.
  const envelopeValue = {
    caption: { locale: caption.locale, text: text.value },
    note,
    proposedGroup,
  }
  // Keep the optional block genuinely optional. Existing submitters should not
  // acquire a `source:null` field merely by using the current form; the admin
  // reader accepts both the legacy envelope and the expanded one.
  if (source.value !== null) envelopeValue.source = source.value
  const envelope = JSON.stringify(envelopeValue)
  // The per-field caps above put this comfortably inside submitter_note's 500,
  // but JSON escaping is not length-preserving and the column counts characters,
  // so the budget is measured rather than argued.
  if ([...envelope].length > SUBMITTER_NOTE_MAX_LENGTH) {
    return { ok: false, code: 'note_too_long' }
  }

  return { ok: true, value: { label: label.value, note: envelope } }
}

function validateSourceNote(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid_source' }

  const source = {}
  if (raw.kind !== undefined && raw.kind !== null && raw.kind !== '') {
    if (raw.kind !== 'video' && raw.kind !== 'stream') return { ok: false, code: 'invalid_source_kind' }
    source.kind = raw.kind
  }
  if (raw.title !== undefined && raw.title !== null && raw.title !== '') {
    const title = checkText(raw.title, SOURCE_TITLE_MAX_LENGTH)
    if (!title.ok) return { ok: false, code: 'invalid_source_title', detail: title.reason }
    source.title = title.value
  }
  if (raw.date !== undefined && raw.date !== null && raw.date !== '') {
    if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return { ok: false, code: 'invalid_source_date' }
    source.date = raw.date
  }
  if (raw.seconds !== undefined && raw.seconds !== null && raw.seconds !== '') {
    if (!Number.isInteger(raw.seconds) || raw.seconds < 0) return { ok: false, code: 'invalid_source_seconds' }
    source.seconds = raw.seconds
  }
  if (raw.url !== undefined && raw.url !== null && raw.url !== '') {
    // This is still submitter-proposed text. Keep it bounded and safe to place
    // in the JSON envelope, but defer the protocol decision to the admin write
    // into clips: a submitter may suggest a URL the reviewer must correct or
    // reject, and the optional form must not become a hard gate.
    const url = checkText(raw.url, SOURCE_URL_MAX_LENGTH)
    if (!url.ok) return { ok: false, code: 'invalid_source_url', detail: url.reason }
    source.url = url.value
  }
  return { ok: true, value: Object.keys(source).length === 0 ? null : source }
}

function checkText(value, maxLength) {
  const verdict = validateCaption(value, { maxLength })
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  return { ok: true, value: escapeForI18n(value) }
}

/**
 * The reader for the envelope validateItemText writes.
 *
 * Exported so the admin routes and the catalogue builder parse it in one place
 * rather than three. A row that is not in this shape — written by hand, or by
 * something that predates the envelope — comes back as all-nulls rather than as a
 * throw: the caller wanted a caption, not an outage.
 */
export function readSubmitterNote(raw) {
  const empty = { caption: null, note: null, proposedGroup: null, source: null }
  if (typeof raw !== 'string' || raw === '') return empty
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object') return empty
  const caption =
    parsed.caption !== null &&
    typeof parsed.caption === 'object' &&
    typeof parsed.caption.locale === 'string' &&
    typeof parsed.caption.text === 'string'
      ? { locale: parsed.caption.locale, text: parsed.caption.text }
      : null
  const source = readSourceNote(parsed.source)
  return {
    caption,
    note: typeof parsed.note === 'string' ? parsed.note : null,
    proposedGroup: typeof parsed.proposedGroup === 'string' ? parsed.proposedGroup : null,
    source,
  }
}

function readSourceNote(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = {}
  if (raw.kind === 'video' || raw.kind === 'stream') source.kind = raw.kind
  if (typeof raw.title === 'string' && raw.title !== '') source.title = raw.title
  if (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) source.date = raw.date
  if (Number.isInteger(raw.seconds) && raw.seconds >= 0) source.seconds = raw.seconds
  if (typeof raw.url === 'string' && raw.url !== '') source.url = raw.url
  return Object.keys(source).length === 0 ? null : source
}

// ---------------------------------------------------------------------------
// Small shared pieces

function required(value, name) {
  if (value === undefined || value === null) {
    throw new TypeError(
      `routes/public: options.${name} is required. This plugin does not construct the database, ` +
        'the room source — the room socket is reference-counted per ' +
        'process, so a second one would be a second socket.',
    )
  }
  return value
}

function refuse(reply, status, code, extra = {}) {
  const denial = deny(status, code, extra)
  return reply.code(denial.status).send(denial.body)
}

function rateLimited(reply, retryAfterSeconds) {
  const retry = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 1))
  return reply.code(429).header('retry-after', String(retry)).send({
    error: 'rate_limited',
    retryAfterSeconds: retry,
  })
}

function rateDenied(retryAfterSeconds) {
  return {
    status: 429,
    body: {
      error: 'rate_limited',
      retryAfterSeconds: Math.max(1, Math.ceil(Number(retryAfterSeconds) || 1)),
    },
  }
}

function storageRefuse(reply) {
  return reply.code(503).send({
    error: 'storage_exhausted',
    message: PUBLIC_REASONS.storage_exhausted,
  })
}

/**
 * The same refusal, as data rather than as a reply.
 *
 * The submit path needs this shape because its temp files must be swept BEFORE
 * anything is sent, so the decision and the sending are two separate moments.
 */
function deny(status, code, extra = {}) {
  return { status, body: { error: { code, message: PUBLIC_REASONS[code], ...extra } } }
}

function reasonOf(code, detail) {
  const body = { code, message: PUBLIC_REASONS[code] }
  if (detail !== undefined && detail !== null) body.detail = detail
  return body
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * One cookie out of the header, without decoding it.
 *
 * decodeURIComponent throws on a lone '%', which a hostile client can send for
 * free; and the value here is base64url, which has nothing to decode. A cookie
 * that is not ours simply hashes to nothing the sessions table knows.
 */
function readCookie(header, name) {
  if (typeof header !== 'string') return null
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (pair.slice(0, eq).trim() !== name) continue
    const value = pair.slice(eq + 1).trim()
    return value === '' ? null : value
  }
  return null
}

function randomToken() {
  return randomBytes(32).toString('base64url')
}

/**
 * The session-cookie service used when the app has not decorated one.
 *
 * Deliberately the same SHAPE as app.mjs's, and deliberately unsigned: an HMAC
 * needs a secret, the boot contract does not require one, and a signature keyed
 * on `undefined` is a signature that proves nothing while looking like it does.
 * What makes a session unforgeable is the 256 bits, which are here either way;
 * the signature only buys refusing a junk cookie without a database query.
 *
 * So this is the standalone-testing path, not a second implementation of the
 * production one — in the assembled server fastify.sessionCookie always wins.
 */
function localSessionCookie(options, db) {
  const name = options.cookieName ?? DEFAULTS.cookieName
  // The database's own mark, which is the fact env-guard resolves production-ness
  // from. An unstamped database reads as production and therefore as Secure: a
  // development cookie wrongly marked Secure fails visibly over http, while the
  // reverse ships a session cookie in the clear.
  const secure = options.secureCookie ?? readInstanceMode(db) !== 'development'

  const attributes = (value, maxAgeSeconds) => {
    const parts = [
      `${name}=${value}`,
      'Path=/',
      'HttpOnly',
      // Lax, not Strict: a visitor following a link back from the live room —
      // where the danmaku is typed — arrives on a cross-site GET, and Strict
      // would drop the session exactly there. Lax still withholds the cookie
      // from a cross-site POST, which is the case that matters, and it is what
      // stops a form on someone else's page reaching POST /api/submit with this
      // session attached (multipart/form-data being a CORS-safelisted type).
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ]
    if (secure) parts.push('Secure')
    return parts.join('; ')
  }

  const maxAgeSeconds = Math.floor((options.sessionTtlMinutes ?? DEFAULTS.sessionTtlMinutes) * 60)

  return Object.freeze({
    name,
    mint: randomToken,
    hash: sha256Hex,
    parse: (header) => readCookie(header, name),
    read: (request) => readCookie(request.headers.cookie, name),
    set: (reply, value) => reply.header('set-cookie', attributes(value, maxAgeSeconds)),
    remove: (reply) => reply.header('set-cookie', attributes('', 0)),
  })
}

function randomCode() {
  let code = ''
  // 256 is a whole multiple of the alphabet's 32 symbols, so randomInt over the
  // alphabet length is uniform without rejection sampling.
  for (let i = 0; i < DEFAULTS.codeLength; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return code
}

function addMinutes(canonical, minutes) {
  return toCanonicalTimestamp(new Date(Date.parse(canonical) + minutes * MINUTE_MS))
}

function isUniqueViolation(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT_')
}

function clampLimit(value) {
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n) || n < 1) return 20
  return Math.min(n, 50)
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') return null
    return parsed
  } catch {
    // A cursor that decodes to the wrong shape would drop the keyset predicate
    // and silently restart the reader at page one.
    return null
  }
}

// ---------------------------------------------------------------------------
// SQL
//
// Every column is named. `SELECT *` would let a column added to schema.sql change
// the shape of what a visitor receives without anybody deciding that it should.

function prepareStatements(db) {
  return {
    sessionByTokenHash: db.prepare(`
      SELECT id, token_sha256, submitter_id, bound_at, created_at, last_seen_at,
             expires_at, revoked_at, kind, client_label, last_used_at, token_issued_at
      FROM sessions WHERE token_sha256 = ?
    `),
    sessionById: db.prepare(`
      SELECT id, token_sha256, submitter_id, bound_at, created_at, last_seen_at,
             expires_at, revoked_at, kind, client_label, last_used_at, token_issued_at
      FROM sessions WHERE id = ?
    `),
    insertSession: db.prepare(`
      INSERT INTO sessions (
        id, token_sha256, created_at, last_seen_at, expires_at, kind, client_label,
        last_used_at, token_issued_at
      ) VALUES (
        @id, @token_sha256, @created_at, @last_seen_at, @expires_at, @kind,
        @client_label, @last_used_at, @token_issued_at
      )
    `),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = @last_seen_at WHERE id = @id'),
    touchApiSession: db.prepare(
      'UPDATE sessions SET last_used_at = @last_used_at, last_seen_at = @last_seen_at WHERE id = @id AND kind = \'api\'',
    ),
    revokeSession: db.prepare('UPDATE sessions SET revoked_at = @revoked_at WHERE id = @id AND revoked_at IS NULL'),
    revokeAllApiSessions: db.prepare(
      'UPDATE sessions SET revoked_at = @revoked_at WHERE submitter_id = @submitter_id AND kind = \'api\' AND token_issued_at IS NOT NULL AND revoked_at IS NULL',
    ),
    apiSessionsForSubmitter: db.prepare(`
      SELECT id, client_label, created_at, expires_at
        FROM sessions
       WHERE submitter_id = @submitter_id AND kind = 'api'
         AND token_issued_at IS NOT NULL AND revoked_at IS NULL AND expires_at > @now
       ORDER BY created_at ASC, id ASC
    `),
    issueApiToken: db.prepare(`
      UPDATE sessions
         SET token_sha256 = @token_sha256, token_issued_at = @token_issued_at,
             expires_at = @expires_at,
             last_used_at = @token_issued_at
       WHERE id = @id AND kind = 'api' AND token_issued_at IS NULL
         AND revoked_at IS NULL
    `),
    bindSession: db.prepare(`
      UPDATE sessions
         SET submitter_id = @submitter_id, bound_at = @bound_at,
             last_seen_at = @last_seen_at, expires_at = @expires_at
       WHERE id = @id AND revoked_at IS NULL AND submitter_id IS NULL
    `),

    submitterByOpenId: db.prepare(`
      SELECT id, open_id, display_name, submitted_count, approved_count, rejected_count,
             blocked, blocked_reason
        FROM submitters WHERE open_id = ?
    `),
    submitterById: db.prepare(`
      SELECT id, open_id, display_name, submitted_count, approved_count, rejected_count,
             blocked, blocked_reason
        FROM submitters WHERE id = ?
    `),
    // Whether an open_id is an admin added online (schema v4). Unioned with the
    // env seed by publicSubmitter so /api/me's admin flag matches the gate.
    activeAdmin: db.prepare('SELECT 1 FROM admins WHERE open_id = ? AND revoked_at IS NULL'),
    insertSubmitter: db.prepare(`
      INSERT INTO submitters (id, open_id, display_name, display_name_seen_at, first_seen_at, last_seen_at)
      VALUES (@id, @open_id, @display_name, @display_name_seen_at, @first_seen_at, @last_seen_at)
    `),
    touchSubmitter: db.prepare(`
      UPDATE submitters
         SET display_name = @display_name, display_name_seen_at = @display_name_seen_at,
             last_seen_at = @last_seen_at
       WHERE id = @id
    `),
    countSubmission: db.prepare(`
      UPDATE submitters
         SET submitted_count = submitted_count + 1, last_seen_at = @last_seen_at
       WHERE id = @id
    `),

    insertCode: db.prepare(`
      INSERT INTO verify_codes (id, code, challenge_text, session_id, room_id, issued_at, expires_at)
      VALUES (@id, @code, @challenge_text, @session_id, @room_id, @issued_at, @expires_at)
    `),
    codeById: db.prepare(`
      SELECT id, code, challenge_text, session_id, room_id, state, issued_at, expires_at, closed_at, submitter_id
        FROM verify_codes WHERE id = ?
    `),
    // The live phrases the room matcher compares a danmaku against: pending, not
    // expired, and carrying a phrase (so the dev-bypass rows, which have none,
    // are excluded). Capped by maxPendingCodes, so `all()` is a short list.
    pendingChallengeCodes: db.prepare(`
      SELECT id, challenge_text
        FROM verify_codes
       WHERE state = 'pending' AND expires_at > @now AND challenge_text IS NOT NULL
    `),
    pendingCodeById: db.prepare(`
      SELECT id, code, session_id, room_id, state, issued_at, expires_at
        FROM verify_codes WHERE id = ? AND state = 'pending'
    `),
    livePendingCodeForSession: db.prepare(`
      SELECT id, code, challenge_text, session_id, room_id, state, issued_at, expires_at
        FROM verify_codes
       WHERE session_id = @session_id AND state = 'pending' AND expires_at > @now
       ORDER BY issued_at DESC LIMIT 1
    `),
    pendingCodesForSession: db.prepare(`
      SELECT id FROM verify_codes WHERE session_id = @session_id AND state = 'pending'
    `),
    latestCodeForSession: db.prepare(`
      SELECT id, code, session_id, room_id, state, issued_at, expires_at, closed_at, submitter_id
        FROM verify_codes WHERE session_id = @session_id ORDER BY issued_at DESC, id DESC LIMIT 1
    `),
    // v_room_demand is the derived reference count: pending rows, nothing stored.
    countPendingCodes: db.prepare(
      'SELECT count(*) AS n FROM v_room_demand WHERE expires_at > @now',
    ),
    expiredPendingCodes: db.prepare(
      "SELECT id, session_id FROM verify_codes WHERE state = 'pending' AND expires_at <= @now",
    ),
    expireCodes: db.prepare(`
      UPDATE verify_codes SET state = 'expired', closed_at = @now
       WHERE state = 'pending' AND expires_at <= @now
    `),
    cancelCode: db.prepare(`
      UPDATE verify_codes SET state = 'cancelled', closed_at = @closed_at
       WHERE id = @id AND state = 'pending'
    `),
    // One statement, because verify_codes_terminal_state only lets a row leave
    // 'pending' once: state and the identity it proved have to land together or
    // the second write is refused by the trigger that guards the first.
    verifyCode: db.prepare(`
      UPDATE verify_codes
         SET state = 'verified', closed_at = @closed_at, consumed_at = @consumed_at,
             submitter_id = @submitter_id, observed_open_id = @observed_open_id,
             observed_display_name = @observed_display_name, verified_via = 'danmaku'
       WHERE id = @id AND state = 'pending'
    `),

    localeByCode: db.prepare('SELECT code FROM locales WHERE code = ?'),
    activeGroupById: db.prepare("SELECT id FROM groups WHERE id = ? AND state = 'active'"),
    activeGroups: db.prepare(
      "SELECT id, display_name FROM groups WHERE state = 'active' ORDER BY display_name COLLATE NOCASE, id",
    ),
    locales: db.prepare('SELECT code, label FROM locales ORDER BY sort_order, code'),
    clipByMedia: db.prepare('SELECT id FROM clips WHERE media_sha256 = ?'),

    insertMedia: db.prepare(`
      INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at)
      VALUES (@sha256, @ext, @content_type, @bytes, @duration_seconds, @uploaded_at)
      ON CONFLICT (sha256) DO NOTHING
    `),
    // If these exact bytes had been reclaimed by the media GC (STORY-077) and are
    // being submitted again, un-mark the row: placeMedia has put the file back on
    // the volume, so the blob is present. Touches only a collected row.
    reviveMedia: db.prepare(
      'UPDATE media SET collected_at = NULL WHERE sha256 = ? AND collected_at IS NOT NULL',
    ),
    insertBatch: db.prepare(`
      INSERT INTO batches (id, submitter_id, session_id, state, created_at,
                           ${LEGACY_VERIFICATION_COLUMNS.required},
                           ${LEGACY_VERIFICATION_COLUMNS.verdict},
                           ${LEGACY_VERIFICATION_COLUMNS.decidedAt})
      VALUES (@id, @submitter_id, @session_id, 'draft', @created_at,
              @legacy_required, @legacy_verdict, @legacy_decided_at)
    `),
    insertBatchItem: db.prepare(`
      INSERT INTO batch_items (id, batch_id, position, media_sha256, proposed_label,
                               proposed_group_id, submitter_note, created_at)
      VALUES (@id, @batch_id, @position, @media_sha256, @proposed_label,
              @proposed_group_id, @submitter_note, @created_at)
    `),
    submitBatch: db.prepare(`
      UPDATE batches SET state = 'submitted', submitted_at = @submitted_at
       WHERE id = @id AND state = 'draft'
    `),
    recentSubmissions: db.prepare(`
      SELECT count(*) AS n, min(submitted_at) AS oldest FROM batches
       WHERE submitter_id = @submitter_id AND state <> 'draft' AND submitted_at > @since
    `),
    recentSubmissionsBySession: db.prepare(`
      SELECT count(*) AS n, min(submitted_at) AS oldest FROM batches
       WHERE session_id = @session_id AND state <> 'draft' AND submitted_at > @since
    `),

    batchesForSubmitter: db.prepare(`
      SELECT id, state, created_at, submitted_at, resolved_at
        FROM batches
       WHERE submitter_id = @submitter_id
         AND state <> 'draft'
         AND (@cursor_created_at IS NULL
              OR created_at < @cursor_created_at
              OR (created_at = @cursor_created_at AND id < @cursor_id))
       ORDER BY created_at DESC, id DESC
       LIMIT @limit
    `),
    itemsForBatch: db.prepare(`
      SELECT i.id, i.position, i.state, i.proposed_label, i.proposed_group_id, i.submitter_note,
             i.reviewer_note, i.clip_id, i.resolved_at, i.media_sha256,
             m.bytes, m.duration_seconds, m.storage_path,
             g.display_name AS group_display_name
        FROM batch_items i
        JOIN media m ON m.sha256 = i.media_sha256
        LEFT JOIN groups g ON g.id = i.proposed_group_id
       WHERE i.batch_id = @batch_id
       ORDER BY i.position
    `),
  }
}
