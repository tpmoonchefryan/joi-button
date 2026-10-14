// SPDX-License-Identifier: MIT
//
// The only file in this process that reads the environment.
//
// Everything downstream — app.mjs, server.mjs, the routes later stories add —
// receives a plain object. `process.env` appears exactly once below, and
// `deploy/runtime.env` is parsed exactly once below, so "where does this value
// come from?" has one answer and a test can supply a different environment
// without touching the machine it runs on.
//
// TWO CONSUMERS, ONE FILE. deploy/runtime.env.example says it: on the cluster
// that file becomes a Kubernetes Secret mounted with envFrom, and locally the
// API reads it directly. So both paths are honoured here, and the REAL
// environment wins over the file — in the pod there is no file, and on a laptop
// an explicit `SESSION_SECRET=… node server.mjs` should not be silently ignored
// in favour of a stale line in a file the operator forgot about.
//
// WHAT THIS FILE VALIDATES, AND WHAT IT DELIBERATELY DOES NOT.
// This file owns SYNTAX and PROVENANCE: "MAX_FILE_BYTES is not an integer",
// "ADMIN_OPEN_IDS contains an entry with a space in it". It is the only layer
// that knows the NAME an operator typed, so it is the only layer that can put
// that name in the message.
//
// lib/env-guard.mjs owns POLICY: ruled ceilings, required keys, and the refusal
// to run a development bypass in production. Those checks are NOT duplicated
// here — a ceiling enforced in two places is a ceiling that can be raised in one
// of them. What this file does instead is export ENV_SOURCES, so the entry point
// can translate the guard's config paths back into the variable names the
// operator actually set.
//
// WHY PATHS ARE NOT RESOLVED TO ABSOLUTE FORM HERE.
// It is one path.resolve() away and it would be a mistake. env-guard refuses a
// relative storage path in production, because a relative path resolves against
// the container's WORKDIR rather than the mounted PVC; resolving here would hand
// that check an absolute path every time and the refusal could never fire again.
// A gate whose predicate cannot be false is not a gate. So DATA_DIR reaches the
// guard exactly as it was written.
//
// ---------------------------------------------------------------------------
// ENVIRONMENT VARIABLES THIS FILE READS
//
// Published by deploy/runtime.env.example, spelled exactly as it publishes them:
//
//   BILI_APP_ID  BILI_ROOM_ID  BILI_ACCESS_KEY_ID  BILI_ACCESS_KEY_SECRET
//   BILI_ROOM_OWNER_AUTH_CODE
//   ADMIN_OPEN_IDS  SESSION_SECRET  DATA_DIR  DB_FILE  MEDIA_DIR  CATALOG_FILE
//   MAX_CLIPS_PER_BATCH  MAX_FILE_BYTES  DEV_BYPASS_DANMAKU  DANMAKU_MODE
//
// NOT published there — the template should grow them, and until it does this
// comment is the only place they are written down:
//
//   NODE_ENV            'production' | 'development' | 'test'. Never defaulted;
//                       see env-guard on why an unset NODE_ENV is a refusal.
//   PORT, HOST          the listener. Nothing can start without them.
//   LOG_LEVEL           pino level.
//   TRUST_PROXY         hop count or trusted-address list; see readTrustProxy.
//   CODE_TTL_MINUTES    REQUIRED by env-guard's roster (danmaku.codeTtlMinutes).
//   SESSION_TTL_HOURS   how long a bound session cookie stays valid.
//   DEV_PLAIN_HTTP      drops Secure from the session cookie. Inert outside a
//                       process the guard resolved as non-production; see
//                       app.mjs, which is where it is ANDed with that answer.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Imported, not re-implemented. `DEV_BYPASS_DANMAKU=true` must mean the same
// thing here as it does in the guard: env-guard's isUnsafe is deliberately wider
// than {0,1} ("anything present that is not exactly 0 counts as on"), and if
// this file decided with `=== '1'` instead, that spelling would set the config
// to production while the guard reported an active bypass — a process that
// refuses to start in production and builds the WRONG source in development.
// One predicate, read from the roster that owns it.
import { BYPASS_FLAGS } from './lib/env-guard.mjs'
// Imported rather than copied, for the same reason. The room dial's per-attempt
// bound below is DERIVED from the request timeout the transport uses; a copy of
// today's 5_000 written here would stop being that the day the default moved.
import { TRANSPORT_DEFAULTS } from './lib/bili-transport.mjs'

const MiB = 1024 * 1024

/** deploy/runtime.env, resolved from this file rather than from the cwd. */
export const DEFAULT_ENV_FILE = new URL('../deploy/runtime.env', import.meta.url)

// Defaults. Each one is either what deploy/runtime.env.example already shows, or
// the strictest value that still runs.
const DEFAULTS = Object.freeze({
  port: 8080,
  // 0.0.0.0 because the primary deployment is a container: a service cannot
  // reach a process bound to loopback. The exposure that buys is bounded by the
  // pod's network, and on a laptop by the machine's own firewall.
  host: '0.0.0.0',
  dataDir: './.data',
  maxClipsPerBatch: 10,
  maxFileBytes: 5 * MiB,
  codeTtlMinutes: 10,
  sessionTtlHours: 30 * 24,
  logLevel: 'info',
})

// The database file, the media directory and the catalogue document, relative to
// DATA_DIR. These names match the commented defaults in
// deploy/runtime.env.example; changing one here without changing it there would
// give the operator a template that documents a path the code does not use.
const DERIVED_FROM_DATA_DIR = Object.freeze({
  dbFile: 'joi.db',
  mediaDir: 'media',
  catalogFile: 'catalog.json',
  // A SIBLING of media/, never a child of it. The web pod publishes mediaDir at
  // /media/ with `immutable` caching; staging inside it would make every
  // in-flight upload publicly fetchable and then permanently cached. A sibling
  // is still on the same volume, which is what rename() requires.
  stagingDir: 'incoming',
  // The theme stylesheet the web pod serves at /theme.css (no-cache + ETag,
  // like catalog.json), and the owner-uploaded wallpapers it serves at
  // /wallpaper/ (immutable — the filenames are content hashes). Both siblings
  // of media/ for the same reason staging is: each nginx location aliases
  // exactly one directory, and nothing under media/ that is not published
  // audio.
  themeCssFile: 'theme.css',
  wallpaperDir: 'wallpaper',
})

/**
 * Config path -> the environment variable names that can feed it, in priority
 * order.
 *
 * This is not documentation that sits beside the code: every read below goes
 * through it, and a path that is missing from it throws. It is exported so the
 * entry point can turn env-guard's refusal ("storage.mediaDir: missing") into
 * one an operator can act on ("set MEDIA_DIR, or DATA_DIR").
 */
export const ENV_SOURCES = Object.freeze({
  'server.port': Object.freeze(['PORT']),
  'server.host': Object.freeze(['HOST']),
  'server.logLevel': Object.freeze(['LOG_LEVEL']),
  'server.trustProxy': Object.freeze(['TRUST_PROXY']),

  'database.file': Object.freeze(['DB_FILE', 'DATA_DIR']),

  'storage.dataDir': Object.freeze(['DATA_DIR']),
  'storage.mediaDir': Object.freeze(['MEDIA_DIR', 'DATA_DIR']),
  'storage.catalogFile': Object.freeze(['CATALOG_FILE', 'DATA_DIR']),
  'storage.stagingDir': Object.freeze(['STAGING_DIR', 'DATA_DIR']),
  'storage.themeCssFile': Object.freeze(['THEME_CSS_FILE', 'DATA_DIR']),
  'storage.wallpaperDir': Object.freeze(['WALLPAPER_DIR', 'DATA_DIR']),

  'limits.maxClipsPerBatch': Object.freeze(['MAX_CLIPS_PER_BATCH']),
  'limits.maxFileBytes': Object.freeze(['MAX_FILE_BYTES']),

  'danmaku.mode': Object.freeze(['DANMAKU_MODE', 'DEV_BYPASS_DANMAKU']),
  'danmaku.roomId': Object.freeze(['BILI_ROOM_ID']),
  'danmaku.appId': Object.freeze(['BILI_APP_ID']),
  'danmaku.accessKeyId': Object.freeze(['BILI_ACCESS_KEY_ID']),
  'danmaku.accessKeySecret': Object.freeze(['BILI_ACCESS_KEY_SECRET']),
  'danmaku.roomOwnerAuthCode': Object.freeze(['BILI_ROOM_OWNER_AUTH_CODE']),
  'danmaku.codeTtlMinutes': Object.freeze(['CODE_TTL_MINUTES']),

  'session.secret': Object.freeze(['SESSION_SECRET']),
  'session.ttlHours': Object.freeze(['SESSION_TTL_HOURS']),
  'session.allowPlainHttp': Object.freeze(['DEV_PLAIN_HTTP']),

  'admin.openIds': Object.freeze(['ADMIN_OPEN_IDS']),

  nodeEnv: Object.freeze(['NODE_ENV']),
})

// Values whose text must never appear in an error message, a log line or a
// health document. Keyed by env var name, because that is what this file
// handles; env-guard keeps the same list keyed by config path.
//
// It is used in both directions, which is what keeps it from drifting into
// decoration: describeEnvValue() is the ONLY thing that renders a value into a
// message and it consults this set, and read.secret() refuses to read a variable
// that is not in it. So a secret added to the reader without being added here
// fails at boot rather than leaking into stderr.
//
// Stated exactly, because the difference matters and the codebase has been
// bitten by claims like this one before: NO message this file produces today can
// reach the withholding branch. Every reader that prints a value (integer, mode,
// trustProxy) reads a variable that is not a secret, and every secret is read by
// read.secret(), which prints nothing at all. The branch is therefore a standing
// rule about the next reader somebody writes, not something that fires now —
// which is why describeEnvValue is exported and asserted on directly rather than
// inferred from a refusal message that would pass with it deleted.
//
// BILI_ACCESS_KEY_ID is here although deploy/runtime.env.example does not mark
// it with a ★: env-guard's roster lists danmaku.accessKeyId as `secret: true`,
// and the two layers must not disagree about which values may be printed.
const SECRET_ENV = Object.freeze(
  new Set([
    'BILI_ACCESS_KEY_ID',
    'BILI_ACCESS_KEY_SECRET',
    'BILI_ROOM_OWNER_AUTH_CODE',
    'SESSION_SECRET',
  ]),
)

/**
 * A session-signing key shorter than this is refused outright rather than
 * defaulted or warned about. 32 characters is what the generator in
 * deploy/runtime.env.example produces on its shortest day
 * (randomBytes(32).toString('base64url') is 43), so the only strings this
 * rejects are ones nobody generated.
 */
export const MIN_SESSION_SECRET_LENGTH = 32

/** submitters.open_id is `CHECK (open_id <> '' AND length(open_id) <= 128)`. */
const MAX_OPEN_ID_LENGTH = 128

export class ConfigEnvError extends Error {
  constructor(problems) {
    super(formatEnvProblems(problems))
    this.name = 'ConfigEnvError'
    this.problems = Object.freeze([...problems])
  }
}

/**
 * Requirements that describe the keys THIS file produces and env-guard's own
 * roster does not carry. Passed to assertSafeConfig as extraRequirements, which
 * can only add refusals — the bypass check is evaluated afterwards and reads
 * BYPASS_FLAGS, which is not a parameter.
 *
 * The one entry that overlaps the base roster is database.file, and it
 * strengthens rather than replaces: the roster asks for a non-empty string, this
 * asks for an absolute path in production. env-guard already makes that argument
 * for storage.mediaDir and storage.catalogFile — "a relative path resolves
 * against the container's WORKDIR" — and it is not less true of the database
 * that is the sole authority for everything the other two hold.
 */
export const CONFIG_EXTRA_REQUIREMENTS = Object.freeze([
  Object.freeze({
    path: 'database.file',
    kind: 'path',
    why: 'The SQLite file lives on the same PVC as the media; a relative path in production is the container WORKDIR, not the volume.',
  }),
  Object.freeze({
    path: 'server.port',
    kind: 'integer',
    min: 1,
    max: 65535,
    why: 'The TCP port to listen on.',
  }),
  Object.freeze({
    path: 'server.host',
    kind: 'string',
    why: 'The interface to bind. A container must not bind loopback only.',
  }),
  Object.freeze({
    path: 'session.secret',
    kind: 'string',
    secret: true,
    why: 'Signs the session cookie. Without it the cookie is forgeable, so this is a boot requirement and not a runtime one.',
  }),
  Object.freeze({
    path: 'session.ttlHours',
    kind: 'integer',
    min: 1,
    max: 24 * 365,
    why: 'How long a bound session stays valid.',
  }),
  Object.freeze({
    path: 'session.allowPlainHttp',
    kind: 'boolean',
    why: 'Requests a cookie without Secure. Inert unless the guard resolves this process as non-production; see app.mjs.',
  }),
  Object.freeze({
    path: 'danmaku.roomOwnerAuthCode',
    kind: 'string',
    secret: true,
    when: (config) => config?.danmaku?.mode === 'production',
    why: 'Streamer identity code from play-live.bilibili.com; it authorises this app for the one room.',
  }),
])

/**
 * Read the environment (and deploy/runtime.env, when it is there) and build the
 * config object the foundation expects.
 *
 * @param {object}  [options]
 * @param {object}  [options.env]      environment bag; defaults to process.env
 * @param {URL|string|null} [options.envFile]  runtime.env path, or null to skip it
 * @returns {{ config: object, env: object, envFile: {path: string|null, present: boolean} }}
 *
 * The merged environment bag comes back BESIDE the config rather than inside it,
 * for two reasons. It has to be handed to assertSafeConfig as options.env — the
 * guard watches DEV_BYPASS_* by name, and if it read the ambient process.env
 * while the config had been built from a file, a bypass set in that file would
 * be invisible to the half of the roster that watches the operator-facing
 * spelling. And keeping it out of the config means a JSON dump of the config is
 * not a dump of every secret in the environment.
 */
export function loadConfig({ env: processEnv = process.env, envFile = DEFAULT_ENV_FILE } = {}) {
  const problems = []
  const file = readEnvFile(envFile, problems)
  const env = mergeEnvironment(file.values, processEnv)

  const read = makeReader(env, problems)

  // --- modes -------------------------------------------------------------
  // Two spellings for one switch, exactly as the template describes them:
  // DANMAKU_MODE=development and DEV_BYPASS_DANMAKU=1 both select the double.
  // Either one alone is enough; the guard refuses either one alone in
  // production.
  const danmakuMode = read.mode('danmaku.mode')
  // --- storage -----------------------------------------------------------
  const dataDir = read.string('storage.dataDir') ?? DEFAULTS.dataDir
  const databaseFile = read.string('database.file') ?? join(dataDir, DERIVED_FROM_DATA_DIR.dbFile)
  const mediaDir = read.string('storage.mediaDir') ?? join(dataDir, DERIVED_FROM_DATA_DIR.mediaDir)
  const catalogFile =
    read.string('storage.catalogFile') ?? join(dataDir, DERIVED_FROM_DATA_DIR.catalogFile)
  const stagingDir = read.string('storage.stagingDir') ?? join(dataDir, DERIVED_FROM_DATA_DIR.stagingDir)
  const themeCssFile = read.string('storage.themeCssFile') ?? join(dataDir, DERIVED_FROM_DATA_DIR.themeCssFile)
  const wallpaperDir = read.string('storage.wallpaperDir') ?? join(dataDir, DERIVED_FROM_DATA_DIR.wallpaperDir)

  const nodeEnv = read.string('nodeEnv')
  const sessionSecret = read.secret('session.secret')
  // Read once: a second read of a malformed value would report the same problem
  // twice, and the refusal message is supposed to be a list of distinct things
  // to fix.
  const codeTtlMinutes = read.integer('danmaku.codeTtlMinutes') ?? DEFAULTS.codeTtlMinutes

  const dialPolicy = danmakuDialPolicy()

  if (sessionSecret !== undefined && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    // Length only. The value never appears in the message — this one goes to
    // stderr, and stderr goes to the cluster log.
    problems.push({
      name: envNamesFor('session.secret')[0],
      problem: `is shorter than ${MIN_SESSION_SECRET_LENGTH} characters`,
      hint: 'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    })
  }

  const config = {
    // Not defaulted, ever. assertSafeConfig refuses an unset nodeEnv with a
    // better message than anything this file could invent, and its whole
    // argument is that the permissive branch must never be the default of
    // anything.
    nodeEnv,

    server: {
      port: read.integer('server.port') ?? DEFAULTS.port,
      host: read.string('server.host') ?? DEFAULTS.host,
      logLevel: read.string('server.logLevel') ?? DEFAULTS.logLevel,
      trustProxy: read.trustProxy('server.trustProxy'),
    },

    database: {
      file: databaseFile,
      // What migrate() stamps into instance.mode, which is then one of the two
      // signals env-guard reads for production-ness — and a one-way ratchet, so
      // a database stamped production can never be talked back down.
      //
      // Derived from NODE_ENV rather than given a switch of its own, and
      // deliberately only from the EXACT string 'development': NODE_ENV=test, an
      // unset NODE_ENV and a typo all stamp production, which costs a developer
      // a bypass and costs a deployment nothing. That is the same asymmetry
      // migrate() cites for its own default.
      instanceMode: nodeEnv === 'development' ? 'development' : 'production',
    },

    storage: { dataDir, mediaDir, catalogFile, stagingDir, themeCssFile, wallpaperDir },

    limits: {
      // The ruled ceilings live in env-guard's roster (1..10 and 1..5 MiB); this
      // reads the number and checks that it IS a number. Lower is accepted.
      maxClipsPerBatch: read.integer('limits.maxClipsPerBatch') ?? DEFAULTS.maxClipsPerBatch,
      maxFileBytes: read.integer('limits.maxFileBytes') ?? DEFAULTS.maxFileBytes,
    },

    danmaku: {
      mode: danmakuMode,
      roomId: read.integer('danmaku.roomId'),
      appId: read.integer('danmaku.appId'),
      accessKeyId: read.secret('danmaku.accessKeyId'),
      accessKeySecret: read.secret('danmaku.accessKeySecret'),
      roomOwnerAuthCode: read.secret('danmaku.roomOwnerAuthCode'),
      codeTtlMinutes,
      // Overrides of lib/bili-transport.mjs's TRANSPORT_DEFAULTS for this
      // deployment. Handed down unchanged — server.mjs -> createDanmakuSource ->
      // createProductionTransport -> createBiliTransport, which merges it over
      // its defaults. Today it is the connect timeout alone; see
      // danmakuDialPolicy() for the measurement and the ruling behind it.
      transport: dialPolicy.transport,
      lifecycle: {
        // The room session is held open by leases, and the ruling is that it
        // stops on success or a 10-minute expiry. Deriving the lease TTL from
        // the code TTL is what keeps those the same fact: a lease that outlived
        // its code would hold the socket open for a code nobody can still use.
        leaseTtlMs: codeTtlMinutes * 60_000,
        // How long the socket stays open after the LAST waiter lets go.
        //
        // Deployment policy, derived from a measured platform behaviour rather
        // than from taste (JOI-BUTTON-INC-006): /v2/app/start answers 7001
        // 请求冷却期 for a while after a session for the same app+room ends —
        // observed to clear inside 15s. Without a linger, the sequence this
        // site's whole login is made of, "A verifies, session stops, B asks for
        // a code", puts B inside that window and tells B the room is
        // unreachable.
        //
        // The lifecycle's own default is 0, because a linger is a policy and not
        // a property of a refcount. This is where the policy lives, beside the
        // other value derived from a ruling.
        lingerMs: readLingerMs(env),
        // The bound on ONE transport.start(), derived from the connect timeout
        // above, and the budget across all of them, unchanged. Policy for the
        // same reason the linger is; see danmakuDialPolicy().
        startTimeoutMs: dialPolicy.startTimeoutMs,
        startBudgetMs: dialPolicy.startBudgetMs,
      },
    },

    session: {
      secret: sessionSecret,
      ttlHours: read.integer('session.ttlHours') ?? DEFAULTS.sessionTtlHours,
      allowPlainHttp: read.bypassFlag('session.allowPlainHttp'),
    },

    admin: {
      // Server-side allow-list, checked on every admin route (ruling). Empty is
      // a legitimate state: an open_id is obtained by logging in once through
      // the danmaku flow, so a fresh deployment has none yet. Empty means
      // nobody is an admin, which is the safe reading of "not configured".
      openIds: readOpenIds(env, problems),
    },
  }

  if (problems.length > 0) throw new ConfigEnvError(problems)

  return Object.freeze({
    config,
    env,
    envFile: Object.freeze({ path: file.path, present: file.present }),
  })
}

/**
 * The environment variable names behind a config path, for a message that has
 * to tell an operator what to edit.
 */
export function envNamesFor(path) {
  const names = ENV_SOURCES[path]
  if (names === undefined) {
    // A path with no declared source is a value that appeared from somewhere
    // this file does not describe, which is the state ENV_SOURCES exists to make
    // impossible.
    throw new Error(`config: no environment source is declared for "${path}"`)
  }
  return names
}

// ---------------------------------------------------------------------------
// deploy/runtime.env

/**
 * Parse a KEY=VALUE file.
 *
 * Deliberately small, and deliberately strict where dotenv is lenient: a line
 * this parser cannot read is a problem it reports, never a line it skips. The
 * file is edited by hand — deploy/runtime.env.example even warns that refreshing
 * the auth code invalidates the old one with "no other symptom" — so a
 * silently-dropped assignment is the last thing it needs.
 *
 * Handles what the committed template actually contains: comment lines, blank
 * lines, empty assignments and trailing comments after a
 * value (`BILI_ACCESS_KEY_SECRET=            # ★`). A '#' only starts a comment
 * when it follows whitespace or begins the value, so a '#' inside a password is
 * kept. Quoted values keep everything between the quotes.
 *
 * @returns {{values: object, problems: Array}}
 */
export function parseEnvFile(text) {
  const values = Object.create(null)
  const seen = new Map()
  const problems = []
  const lines = String(text).split(/\r?\n/)

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
    const eq = withoutExport.indexOf('=')
    if (eq < 1) {
      problems.push({ name: `line ${lineNo}`, problem: 'is not a KEY=VALUE assignment' })
      continue
    }

    const name = withoutExport.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      problems.push({ name: `line ${lineNo}`, problem: `has "${name}" on the left of the =, which is not a variable name` })
      continue
    }
    if (seen.has(name)) {
      // Last-wins would mean the earlier line is ignored with no sign of it.
      problems.push({
        name,
        problem: `is assigned twice, on lines ${seen.get(name)} and ${lineNo}`,
      })
      continue
    }
    seen.set(name, lineNo)

    values[name] = readEnvFileValue(withoutExport.slice(eq + 1))
  }

  return { values, problems }
}

function readEnvFileValue(raw) {
  // Left-trimmed only, so that the comment rule below can still see whether the
  // '#' is at the start of the value. `KEY=      # note` is an EMPTY assignment
  // with a comment after it — which is what most of the ★ lines in
  // deploy/runtime.env.example are — and reading it as the value "# note" would
  // turn an unset secret into a set one, i.e. a boot that succeeds with a
  // credential nobody supplied.
  const value = raw.replace(/^[ \t]+/, '')
  if (value === '') return ''

  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const end = value.lastIndexOf(quote)
    if (end > 0) return value.slice(1, end)
    return value.slice(1) // unterminated quote: take the rest, the reader trims
  }

  // A '#' starts a comment when it begins the value or follows whitespace.
  // `a#b` is a value containing a '#'.
  const comment = value.search(/(^|\s)#/)
  return (comment === -1 ? value : value.slice(0, comment)).trim()
}

function readEnvFile(envFile, problems) {
  if (envFile === null || envFile === undefined) {
    return { values: Object.create(null), path: null, present: false }
  }
  // fileURLToPath, not URL#pathname: a pathname is percent-encoded, so a
  // checkout under a directory with a space in its name would be reported at a
  // path nobody can copy into a shell.
  const path = envFile instanceof URL ? fileURLToPath(envFile) : String(envFile)
  let text
  try {
    text = readFileSync(envFile, 'utf8')
  } catch (error) {
    // Absent is the normal case in the pod, where envFrom supplies the same
    // names. Anything else (a directory, a permission error) is reported: a file
    // that exists and cannot be read is not the same as no file.
    if (error?.code === 'ENOENT') return { values: Object.create(null), path, present: false }
    problems.push({ name: path, problem: `could not be read (${error?.code ?? 'unknown error'})` })
    return { values: Object.create(null), path, present: false }
  }

  const parsed = parseEnvFile(text)
  for (const problem of parsed.problems) {
    problems.push({ ...problem, name: `${path}: ${problem.name}` })
  }
  return { values: parsed.values, path, present: true }
}

function mergeEnvironment(fileValues, processEnv) {
  const env = Object.create(null)
  for (const [name, value] of Object.entries(fileValues)) env[name] = value

  for (const [name, value] of Object.entries(processEnv ?? {})) {
    if (value === undefined) continue
    // An empty export does not mask a real value in the file. This is the same
    // rule env-guard applies to DEV_BYPASS_*: an empty assignment is an absent
    // flag, not a flag set to the empty string.
    if (String(value).trim() === '' && env[name] !== undefined) continue
    env[name] = value
  }
  return env
}

// ---------------------------------------------------------------------------
// readers

function makeReader(env, problems) {
  // Trimmed, and empty reads as absent. Both because a value mounted from a
  // Kubernetes Secret routinely arrives with a trailing newline, and because
  // An empty assignment in the template means "not set yet" — reporting that as
  // a present-but-empty string would produce "wrong-type" where the operator
  // needs to read "missing".
  const raw = (name) => {
    const value = env[name]
    if (value === undefined || value === null) return undefined
    const text = String(value).trim()
    return text === '' ? undefined : text
  }

  // The FIRST name only. The rest of a path's entry in ENV_SOURCES names
  // variables that reach it another way — DATA_DIR, which the three storage
  // paths are derived from below, and DEV_BYPASS_*, which read.mode() consults
  // by position. They are in the table so a refusal can name every variable that
  // feeds a path, not so that a value can be read out of the wrong one: reading
  // DATA_DIR here would have made storage.mediaDir the data directory itself.
  const direct = (path) => {
    const name = envNamesFor(path)[0]
    return { name, value: raw(name) }
  }

  return {
    string(path) {
      return direct(path).value
    },

    secret(path) {
      const { name, value } = direct(path)
      if (!SECRET_ENV.has(name)) {
        throw new Error(
          `config: ${name} is read as a secret but SECRET_ENV does not list it, so describeEnvValue() would print it.`,
        )
      }
      return value
    },

    integer(path) {
      const { name, value } = direct(path)
      if (value === undefined) return undefined
      // Strict: Number('10abc') is NaN but Number('') is 0 and Number('0x10')
      // is 16, and none of those are what an operator typing a limit meant.
      if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        problems.push({ name, problem: `is ${describeEnvValue(name, value)}, which is not an integer` })
        return undefined
      }
      return Number(value)
    },

    /**
     * 'production' | 'development', from either spelling.
     *
     * The DEV_BYPASS_* predicate is env-guard's own, so the two layers cannot
     * disagree about what "on" means.
     */
    mode(path) {
      const [modeName, bypassName] = envNamesFor(path)
      const declared = raw(modeName)
      if (declared !== undefined) {
        if (declared !== 'production' && declared !== 'development') {
          problems.push({
            name: modeName,
            problem: `is ${describeEnvValue(modeName, declared)}, which is neither "production" nor "development"`,
          })
          return undefined
        }
        if (declared === 'development') return 'development'
      }
      return bypassIsOn(bypassName, raw(bypassName)) ? 'development' : 'production'
    },

    /**
     * A DEV_BYPASS_*-shaped flag: absent or "0" is off, anything else is on.
     *
     * Unlike mode(), this does NOT demand that env-guard's roster watch the
     * variable, and that is deliberate rather than an omission. The only flag
     * read this way is DEV_PLAIN_HTTP, whose safety does not come from a refusal
     * — it comes from app.mjs ANDing it with the guard's own production answer,
     * which makes it inert in production rather than refused there. A flag that
     * changes what the process DOES must go through mode(); this one changes an
     * attribute on a cookie in a process the guard has already cleared.
     */
    bypassFlag(path) {
      const [name] = envNamesFor(path)
      const value = raw(name)
      if (value === undefined) return false
      return value !== '0'
    },

    trustProxy(path) {
      return readTrustProxy(direct(path), problems)
    },
  }
}

function bypassIsOn(name, value) {
  if (value === undefined) return false
  const flag = BYPASS_FLAGS.find((candidate) => candidate.source === 'env' && candidate.path === name)
  if (flag === undefined) {
    // The roster is what refuses this flag in production. A flag this file
    // honours and the roster does not watch is a bypass with no guard on it, so
    // it is refused here rather than quietly obeyed.
    throw new Error(
      `config: ${name} is read as a development bypass but env-guard's BYPASS_FLAGS does not watch it; ` +
        'a bypass the guard cannot refuse must not be honoured here.',
    )
  }
  return flag.isUnsafe(value)
}

/**
 * TRUST_PROXY: a hop COUNT, or a list of trusted addresses. Never `true`.
 *
 * This is not pedantry about spelling. fastify's `trustProxy: true` makes
 * request.ip the LEFTMOST X-Forwarded-For entry, which any client can write —
 * and that address is what an external identity verifier would send as
 * `remoteip`, where it is compared against the address that actually completed
 * the verification. A spoofed header turns into a hard rejection for a
 * legitimate visitor. Omit it rather than pass a guess.
 *
 * A number takes the nth address from the RIGHT (1 = the address the ingress
 * observed, which is the usual answer behind traefik) and a list takes the
 * rightmost address that is not in it; both are answers the client cannot move.
 */
function readTrustProxy({ name, value }, problems) {
  if (value === undefined || value === '0' || value === 'false') return false
  if (/^(true|yes|all|any)$/i.test(value)) {
    problems.push({
      name,
      problem: `is ${describeEnvValue(name, value)}, which would trust every hop`,
      hint: 'Use the number of proxies in front of this process (behind one ingress: 1), or a comma-separated list of trusted addresses.',
    })
    return false
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value)
    return Number.isSafeInteger(hops) && hops > 0 ? hops : false
  }
  const list = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  if (list.length === 0) {
    problems.push({
      name,
      problem: `is ${describeEnvValue(name, value)}, which is neither a hop count nor a list of addresses`,
    })
    return false
  }
  return list
}

/**
 * DANMAKU_LINGER_SECONDS, defaulting to 45.
 *
 * Read here rather than through the reader roster because it is a tuning knob
 * with a safe default rather than a value the process needs supplied: an
 * unreadable or absent one falls back, and a deliberate 0 is honoured (it turns
 * the linger off, which is what a test deployment against a different room might
 * want). Refusing to boot over a mistyped tuning knob would be the wrong trade —
 * the value cannot make the site unsafe, only slower or chattier.
 */
function readLingerMs(env) {
  const raw = env.DANMAKU_LINGER_SECONDS
  if (raw === undefined || String(raw).trim() === '') return 45_000
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) return 45_000
  const seconds = Number(text)
  // Capped at the code's own lifetime: a linger longer than the code TTL would
  // keep the socket open past the point where any code it was opened for could
  // still be used, which is the standing connection the ruling forbids.
  return Math.min(seconds, 10 * 60) * 1000
}

/**
 * How long the room dial may take on THIS deployment (JOI-BUTTON-MIN-013 D1).
 *
 * connectTimeoutMs, 30s where lib/bili-transport.mjs defaults to 5s. That one
 * timer covers the WebSocket handshake, sending the auth packet and waiting for
 * AUTH_REPLY. This deployment runs in Singapore and dials danmaku servers in
 * mainland China; measured from inside the production API container with the
 * same Node and global WebSocket the transport uses (JOI-KB-004, 2026-10-14),
 * 19 of 24 handshakes to the usual endpoints opened within 5s (249-2722ms) and
 * 5 did not, and in an earlier run one of 8 had still not opened at 10s. Both
 * failed logins of 2026-10-14 ended on the 5s timer and were reported as "we
 * cannot hear the room" (whether still in the handshake or already awaiting
 * AUTH_REPLY was not recorded). 30s is the ruled value, not a fitted one: a
 * handshake that hangs past it is answered by redialling the next wss_link
 * inside the start budget (STORY-118), not by waiting longer.
 *
 * startTimeoutMs, the lifecycle's bound on ONE transport.start(). It sits above
 * every path through start(), so that the transport's own error — which stage
 * failed — is what reaches the log rather than the lifecycle's generic "did not
 * become ready". The longest path is a held session whose /v2/app/heartbeat
 * fails: heartbeat, /v2/app/end, /v2/app/start, then the connect. Three gateway
 * requests and one connect, 45s today. The ruled floor is two requests and a
 * connect (40s); the third request is what covers the heartbeat path.
 *
 * startBudgetMs, the whole attempt: unchanged at 45s by the same ruling, and
 * equal to the library default. Written here anyway so the three numbers that
 * decide whether a slow handshake gets a second chance sit together. A first
 * dial that hangs for the full 30s has failed by 35s (40s if it first had to
 * end a dropped session); the redial is due 1.25s later, still inside 45s, and
 * that is what makes the redial real. When both addresses hang, the visitor
 * hears "unreachable" after about 62s rather than 5.
 *
 * Kept true by test/danmaku-dial-config.test.mjs: the connect timeout stays
 * below the transport's wsIdleTimeoutMs (35s), because the idle watchdog is
 * armed at onopen and would otherwise end an awaiting-auth-reply dial before
 * the connect timer could; and the library defaults stay as they are, the same
 * split as lingerMs above.
 *
 * Not an environment variable, on purpose: STORY-118 adds no switch, and a knob
 * would let the deployed value drift from the ruling without a review noticing.
 * Fresh objects on every call, like everything else loadConfig builds, because
 * assertSafeConfig deep-freezes what it clears.
 */
function danmakuDialPolicy() {
  const transport = { connectTimeoutMs: 30_000 }
  // The merge createBiliTransport performs, so the bound follows the request
  // timeout the transport will actually use.
  const effective = { ...TRANSPORT_DEFAULTS, ...transport }
  return {
    transport,
    startTimeoutMs: 3 * effective.requestTimeoutMs + effective.connectTimeoutMs,
    startBudgetMs: 45_000,
  }
}

function readOpenIds(env, problems) {
  const [name] = envNamesFor('admin.openIds')
  const raw = env[name]
  if (raw === undefined || String(raw).trim() === '') return []

  const seen = new Set()
  const openIds = []
  for (const entry of String(raw).split(',')) {
    const openId = entry.trim()
    if (openId === '') continue
    if (openId.length > MAX_OPEN_ID_LENGTH) {
      // The value is not printed: an open_id is a stable pseudonymous handle for
      // a real person, and a refusal message is not a place to put one.
      problems.push({ name, problem: `contains an entry longer than ${MAX_OPEN_ID_LENGTH} characters` })
      continue
    }
    if (/\s/.test(openId)) {
      problems.push({ name, problem: 'contains an entry with whitespace inside it; the separator is a comma' })
      continue
    }
    if (seen.has(openId)) continue
    seen.add(openId)
    openIds.push(openId)
  }
  return openIds
}

// ---------------------------------------------------------------------------

function formatEnvProblems(problems) {
  const n = problems.length
  return [
    'joi-button API refused to start.',
    '',
    `${n} environment ${n === 1 ? 'problem' : 'problems'}, all of them listed here so you only have to start once more:`,
    '',
    ...problems.map((problem) => {
      const head = `  - ${problem.name} ${problem.problem}`
      return problem.hint ? `${head}\n      ${problem.hint}` : head
    }),
    '',
    `Values are read from the environment first and then from ${fileURLToPath(DEFAULT_ENV_FILE)};`,
    'deploy/runtime.env.example is the committed template.',
    '',
  ].join('\n')
}

/**
 * The one place a value is rendered into a message. Every problem line above
 * goes through it, which is what makes SECRET_ENV a rule rather than a list.
 *
 * Exported so the rule can be asserted on where it is stated. Asserting it
 * through a refusal message instead would pass with this whole function deleted,
 * because nothing that is currently refused carries a secret's value.
 */
export function describeEnvValue(name, value) {
  if (SECRET_ENV.has(name)) return '(value withheld: this variable is a secret)'
  return JSON.stringify(value)
}
