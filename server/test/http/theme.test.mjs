// SPDX-License-Identifier: MIT
//
// The theme, driven over HTTP: the four routes an owner's form talks to.
//
// The unit tests next door prove what a theme MAY be (test/theme.test.mjs) and
// what happens to an uploaded picture (test/wallpaper.test.mjs). What is proved
// here is the part neither of them can see:
//
//   * the four routes are behind the same allow-list as the rest of the desk, and
//     a stranger gets the answer a MISSING route gets, not a 403 that confirms
//     the route is there;
//   * a refusal leaves the volume byte-for-byte as it was — the assertion is on
//     the FILE, because "nothing was stored" is a claim about the disk and not
//     about a status code;
//   * a save and a delete both land on the log.
//
// The "good" palette is the one GET hands the form. Retyping sixteen colours
// here would mean these cases could keep passing against a palette the site does
// not ship.
//
// Three cases at the bottom are not about a request at all. They are about the
// three ways this suite was structurally unable to see a production failure:
// it runs from a tree where src/ is a sibling (so a route reading src/App.vue
// looked fine while the image has no src/), and its harness hands the plugin the
// same two storage keys server.mjs did (so two REQUIRED environment variables
// could be ignored with every test green). A gate that cannot go red for the
// world it is protecting is not a gate.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import Fastify from 'fastify'
import sharp from 'sharp'

import { openDatabase } from '../helpers/temp-db.mjs'
import { EMPTY_THEME_CSS, THEME_TOKENS } from '../../lib/theme.mjs'
import adminRoutes, { DEFAULT_PALETTE, adminStoragePaths } from '../../routes/admin.mjs'
import { OWNER, VISITOR, auditHigh, auditSince, boot, get, login, postForm, postJson } from './harness.mjs'

/** server/, the directory Dockerfile.api copies and the only one the image has. */
const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(SERVER_ROOT, '..')

const THEME_URL = '/api/admin/theme'
const WALLPAPER_URL = '/api/admin/theme/wallpaper'

function del(app, url, { cookie } = {}) {
  const headers = {}
  if (cookie !== undefined) headers.cookie = cookie
  return app.inject({ method: 'DELETE', url, headers })
}

/** The owner, signed in, plus the palette their form would open pre-filled with. */
async function desk(t) {
  const ctx = await boot(t)
  const cookie = await login(ctx, OWNER)
  const opened = await get(ctx.app, THEME_URL, { cookie })
  assert.equal(opened.statusCode, 200, opened.payload)
  const { defaults } = opened.json()
  // If the defaults ever stopped being a whole palette, every "refused for reason
  // X" case below could be passing because a token was missing.
  assert.equal(Object.keys(defaults).length, THEME_TOKENS.length, JSON.stringify(defaults))
  return { ...ctx, cookie, defaults }
}

const readCss = (paths) => (existsSync(paths.themeCssFile) ? readFileSync(paths.themeCssFile) : null)

function png({ width = 48, height = 32, background = '#fedcae' } = {}) {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer()
}

const SVG_CALLED_PNG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script></svg>',
  'utf8',
)

// ---------------------------------------------------------------------------
// the gate

test('a stranger gets 404 from all four theme routes, and it is the missing-route answer', async (t) => {
  const ctx = await boot(t)
  const visitor = await login(ctx, VISITOR)
  const picture = await png()

  const attempts = [
    () => get(ctx.app, THEME_URL, { cookie: visitor }),
    () => postJson(ctx.app, THEME_URL, { cookie: visitor, body: { name: 'x', tokens: {} } }),
    () => del(ctx.app, THEME_URL, { cookie: visitor }),
    () => postForm(ctx.app, WALLPAPER_URL, { cookie: visitor, parts: [{ name: 'file', filename: 'w.png', value: picture }] }),
    // No session at all takes the same path.
    () => get(ctx.app, THEME_URL),
    () => del(ctx.app, THEME_URL),
  ]

  const missing = await ctx.app.inject({ method: 'GET', url: '/api/admin/no-such-route', headers: { cookie: visitor } })
  assert.equal(missing.statusCode, 404)

  for (const attempt of attempts) {
    const response = await attempt()
    assert.equal(response.statusCode, 404, response.payload)
    // The same BODY a genuinely missing path gets, because it is produced by the
    // same handler — routes/admin.mjs calls reply.callNotFound() rather than
    // writing a 404 of its own.
    assert.deepEqual(response.json().error, missing.json().error)
  }

  // Not one row and not one file: a stranger's attempt is not an admin action, so
  // it is deliberately not audited either (an append-only table anybody on the
  // internet can add to is a disk-fill primitive).
  assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM themes').get().n, 0)
  assert.equal(existsSync(ctx.paths.themeCssFile), false)
})

// ---------------------------------------------------------------------------
// GET

test('with no theme saved, GET answers null plus the roster and the shipped palette', async (t) => {
  const { app, cookie } = await desk(t)

  const answer = (await get(app, THEME_URL, { cookie })).json()

  assert.equal(answer.theme, null)
  // The roster travels with the answer so the form's labels come from one place.
  assert.deepEqual(answer.roster, THEME_TOKENS.map((token) => ({ ...token })))
  // The palette compiled into the bundle, so the form opens pre-filled with what
  // is on screen rather than with sixteen empty inputs. It is a constant in
  // routes/admin.mjs and NOT a read of src/App.vue — see the two cases at the
  // bottom of this file for the drift gate and for why the read had to go.
  assert.equal(answer.defaults['--cream'], '#fedcae')
  assert.equal(answer.defaults['--candy-red'], '#dd2e44')
  // Not declared in :root — .main-content reads it with a `transparent` fallback
  // — so the route supplies the token's rendered value, which is TRANSPARENT.
  // It used to supply '#ffffff', which meant the form advertised "what is on
  // screen" and then changed what is on screen the moment it was saved
  // untouched: an opaque white slab over body_bg.svg.
  assert.equal(answer.defaults['--content-bg'], '#00000000')
})

test('an untouched save is a no-op on screen: the defaults go back in unchanged', async (t) => {
  // The case the '#ffffff' default broke. An owner opens the form, types a name
  // because the form requires one, presses save, and the site must look exactly
  // as it did — otherwise the pre-fill was advertising a state it does not carry.
  const { app, cookie, defaults, paths } = await desk(t)

  const saved = await postJson(app, THEME_URL, {
    cookie,
    body: { name: 'untouched', tokens: defaults, wallpaperPath: null },
  })

  assert.equal(saved.statusCode, 200, saved.payload)
  const css = readFileSync(paths.themeCssFile, 'utf8')
  // Fully transparent, so `.main-content` paints nothing and the page's own
  // artwork still shows through — same pixels as before the save.
  assert.match(css, /--content-bg: #00000000;/)
})

// ---------------------------------------------------------------------------
// POST

test('a good theme is stored, activated, written to theme.css and audited', async (t) => {
  const { app, db, cookie, defaults, paths } = await desk(t)
  const before = auditHigh(db)

  const saved = await postJson(app, THEME_URL, {
    cookie,
    body: { name: 'Evening', tokens: { ...defaults, '--cream': '#fff3e0' }, wallpaperPath: null },
  })

  assert.equal(saved.statusCode, 200, saved.payload)
  const { theme } = saved.json()
  assert.equal(theme.name, 'Evening')
  assert.equal(theme.isActive, true)
  assert.equal(theme.wallpaperPath, null)
  assert.equal(theme.wallpaperUrl, null)
  assert.equal(theme.tokens['--cream'], '#fff3e0')

  const row = db.prepare('SELECT id, name, is_active, activated_at FROM themes').get()
  assert.equal(row.id, theme.id)
  assert.equal(row.is_active, 1)
  assert.ok(row.activated_at !== null)

  // The stylesheet, on the volume the web pod mounts — which is the only thing a
  // visitor's browser ever reads. A theme that is a row and not a file is a theme
  // nobody can see.
  const css = readFileSync(paths.themeCssFile, 'utf8')
  assert.match(css, /:root \{/)
  assert.match(css, /--cream: #fff3e0;/)
  assert.match(css, /--content-bg: #00000000;/)
  // No wallpaper was named, so there is no body rule at all.
  assert.equal(/background-image/.test(css), false)

  const entries = auditSince(db, before)
  const entry = entries.find((row2) => row2.action === 'admin.theme.save')
  assert.ok(entry, JSON.stringify(entries.map((e) => e.action)))
  assert.equal(entry.subject_kind, 'theme')
  assert.equal(entry.subject_id, theme.id)
  assert.equal(entry.actor_id, OWNER.openId)
  const detail = JSON.parse(entry.detail)
  assert.equal(detail.succeeded, true)
  assert.equal(detail.consequence, `theme:${theme.id}`)
})

test('a palette that fails contrast is refused, the failing pairing is named, and nothing on disk moves', async (t) => {
  const { app, db, cookie, defaults, paths } = await desk(t)

  // A theme has to be live first, or "the file is unchanged" would be a claim
  // about a file that does not exist — true, and true for the wrong reason.
  const first = await postJson(app, THEME_URL, { cookie, body: { name: 'Evening', tokens: defaults } })
  assert.equal(first.statusCode, 200, first.payload)
  const cssBefore = readCss(paths)
  const rowsBefore = db.prepare('SELECT count(*) AS n FROM themes').get().n

  // White ink on the white button face: 1:1, which is the resting label of every
  // voice button on the site.
  const refused = await postJson(app, THEME_URL, {
    cookie,
    body: { name: 'Unreadable', tokens: { ...defaults, '--plum-700': '#ffffff' } },
  })

  assert.equal(refused.statusCode, 400, refused.payload)
  const error = refused.json().error
  assert.equal(error.code, 'theme_invalid')
  const contrast = error.problems.filter((problem) => problem.code === 'contrast')
  assert.ok(contrast.length > 0, JSON.stringify(error.problems))
  // NAMED, not counted: the owner is told which pairing, at what ratio, against
  // what, and what it needed.
  const resting = contrast.find((problem) => problem.detail.startsWith('voice button, resting'))
  assert.ok(resting, JSON.stringify(contrast))
  // AGAINST --surface, not against the literal 'white'. That is the whole of the
  // fix: the pair used to name the literal, so it measured a colour the owner
  // cannot change while the one they CAN change — the button face — was in no
  // pair at all. The case below is the same hole from the other side.
  assert.match(resting.detail, /1\.00:1 against --surface, needs 4\.5:1/)
  assert.equal(resting.token, '--plum-700')

  // The claim this case exists for.
  assert.deepEqual(readCss(paths), cssBefore)
  assert.equal(db.prepare('SELECT count(*) AS n FROM themes').get().n, rowsBefore)
  assert.equal(db.prepare('SELECT name FROM themes WHERE is_active = 1').get().name, 'Evening')
})

test('a palette that hides the button LABELS by moving the button FACE is refused too', async (t) => {
  // The reachable exploit, driven end to end. Every previous case moved an INK
  // and was caught; this one moves a SURFACE. `--surface: #6f2f74` is the
  // resting label's own colour, so every voice button on the site renders its
  // text at 1.00:1 — and before the roster audit this stored 200, wrote
  // theme.css and left every gate green, because no pair mentioned --surface and
  // 'voice button, resting' measured --plum-700 against the literal 'white'.
  const { app, db, cookie, defaults, paths } = await desk(t)

  const refused = await postJson(app, THEME_URL, {
    cookie,
    body: { name: 'invisible', tokens: { ...defaults, '--surface': defaults['--plum-700'] } },
  })

  assert.equal(refused.statusCode, 400, refused.payload)
  const problems = refused.json().error.problems.filter((p) => p.code === 'contrast')
  // Named by pairing, and it is more than one: --surface is the voice button
  // face AND the fill of every card on the site, so the owner is told about all
  // of them at once rather than discovering them one save at a time.
  const named = problems.map((p) => p.detail.split(':')[0])
  assert.deepEqual(
    named.sort(),
    ['card body text', 'card small print', 'voice button, resting'],
    JSON.stringify(refused.json().error.problems),
  )

  assert.equal(db.prepare('SELECT count(*) AS n FROM themes').get().n, 0)
  assert.equal(existsSync(paths.themeCssFile), false)
})

test('a wallpaperPath that is not on the volume is a 400, not a stored row', async (t) => {
  const { app, db, cookie, defaults, paths } = await desk(t)
  const invented = `${'ab'.repeat(32)}.png`

  const refused = await postJson(app, THEME_URL, {
    cookie,
    body: { name: 'Invented', tokens: defaults, wallpaperPath: invented },
  })

  assert.equal(refused.statusCode, 400, refused.payload)
  const error = refused.json().error
  assert.equal(error.code, 'theme_invalid')
  const problem = error.problems.find((p) => p.code === 'wallpaper_missing')
  assert.ok(problem, JSON.stringify(error.problems))
  assert.equal(problem.detail, invented)

  assert.equal(db.prepare('SELECT count(*) AS n FROM themes').get().n, 0)
  assert.equal(existsSync(paths.themeCssFile), false)
  // And the refusal is on the log, with succeeded: false — an owner's refused
  // action is recorded; only the GATE's refusals are not.
  const refusal = db.prepare("SELECT detail FROM audit_log WHERE action = 'admin.refused' ORDER BY seq DESC").get()
  assert.ok(refusal, 'the refusal was not audited')
  assert.equal(JSON.parse(refusal.detail).succeeded, false)
})

test('a second save replaces the first as active and leaves exactly one active row', async (t) => {
  const { app, db, cookie, defaults, paths } = await desk(t)

  const first = await postJson(app, THEME_URL, { cookie, body: { name: 'One', tokens: defaults } })
  assert.equal(first.statusCode, 200, first.payload)
  const second = await postJson(app, THEME_URL, {
    cookie,
    body: { name: 'Two', tokens: { ...defaults, '--cream': '#fff0dd' } },
  })
  assert.equal(second.statusCode, 200, second.payload)

  const active = db.prepare('SELECT id, name FROM themes WHERE is_active = 1').all()
  assert.equal(active.length, 1)
  assert.equal(active[0].name, 'Two')
  // BOTH rows are still there: themes is history, so rolling back to 'One' is one
  // UPDATE and not a retyping exercise.
  assert.equal(db.prepare('SELECT count(*) AS n FROM themes').get().n, 2)
  const one = db.prepare("SELECT is_active, activated_at FROM themes WHERE name = 'One'").get()
  assert.equal(one.is_active, 0)
  assert.ok(one.activated_at !== null, 'the deactivated row lost the record of when it was live')

  assert.match(readFileSync(paths.themeCssFile, 'utf8'), /--cream: #fff0dd;/)
})

test('when the stylesheet cannot be written the row is still active, which is the recoverable half', async (t) => {
  const { app, db, cookie, defaults, paths } = await desk(t)

  // A DIRECTORY where theme.css belongs. The temp file is written happily — it
  // has a different name — and the rename onto the target is what fails, which
  // is exactly the shape of a volume that went read-only or filled up midway.
  mkdirSync(paths.themeCssFile, { recursive: true })

  const failed = await postJson(app, THEME_URL, { cookie, body: { name: 'Evening', tokens: defaults } })

  // A 500, because nothing the owner typed was wrong. What matters is which side
  // is ahead: THE ROW IS COMMITTED AND ACTIVE, and the site is still showing the
  // previous palette. The other order — stylesheet first — would have put a
  // palette on the site that no row records, and nothing later corrects that.
  assert.equal(failed.statusCode, 500, failed.payload)
  assert.equal(failed.json().error.code, 'stylesheet_unwritten')
  assert.match(failed.json().error.message, /Press save again/)
  assert.equal(db.prepare('SELECT name FROM themes WHERE is_active = 1').get().name, 'Evening')
  // And nothing half-written was left behind under the name nginx would serve.
  assert.deepEqual(readdirSync(paths.themeCssFile), [])

  // "Press save again" is a real instruction and not a consolation: with the
  // obstruction gone, the identical request produces the stylesheet the row
  // already implied.
  rmSync(paths.themeCssFile, { recursive: true })
  const retried = await postJson(app, THEME_URL, { cookie, body: { name: 'Evening', tokens: defaults } })
  assert.equal(retried.statusCode, 200, retried.payload)
  assert.match(readFileSync(paths.themeCssFile, 'utf8'), /--cream: #fedcae;/)
})

// ---------------------------------------------------------------------------
// DELETE

test('DELETE returns the site to its shipped palette and keeps the row as history', async (t) => {
  const { app, db, cookie, defaults, paths } = await desk(t)
  const saved = await postJson(app, THEME_URL, { cookie, body: { name: 'Evening', tokens: defaults } })
  assert.equal(saved.statusCode, 200, saved.payload)
  const themeId = saved.json().theme.id
  const before = auditHigh(db)

  const removed = await del(app, THEME_URL, { cookie })

  assert.equal(removed.statusCode, 200, removed.payload)
  assert.deepEqual(removed.json(), { theme: null })
  assert.equal((await get(app, THEME_URL, { cookie })).json().theme, null)

  // The EMPTY form, not a deleted file: the page links theme.css unconditionally,
  // and a 404 would put a red line in every visitor's console for a state that is
  // not an error.
  assert.equal(readFileSync(paths.themeCssFile, 'utf8'), EMPTY_THEME_CSS)

  const row = db.prepare('SELECT is_active, activated_at FROM themes WHERE id = ?').get(themeId)
  assert.equal(row.is_active, 0)
  assert.ok(row.activated_at !== null)

  const entry = auditSince(db, before).find((e) => e.action === 'admin.theme.deactivate')
  assert.ok(entry, 'the deactivation was not audited')
  assert.equal(entry.subject_id, themeId)
})

// ---------------------------------------------------------------------------
// the wallpaper

test('an uploaded wallpaper is re-encoded, content-addressed, audited, and usable by a theme', async (t) => {
  const { app, db, cookie, defaults, paths } = await desk(t)
  const before = auditHigh(db)

  const uploaded = await postForm(app, WALLPAPER_URL, {
    cookie,
    parts: [{ name: 'file', filename: 'holiday.png', value: await png({ width: 48, height: 32 }) }],
  })

  assert.equal(uploaded.statusCode, 200, uploaded.payload)
  const stored = uploaded.json()
  assert.match(stored.path, /^[0-9a-f]{64}\.png$/)
  assert.equal(stored.url, `/wallpaper/${stored.path}`)
  assert.equal(stored.width, 48)
  assert.equal(stored.height, 32)
  assert.equal(stored.format, 'png')
  assert.deepEqual(readdirSync(paths.wallpaperDir), [stored.path])
  assert.equal(readFileSync(join(paths.wallpaperDir, stored.path)).length, stored.bytes)

  const entry = auditSince(db, before).find((e) => e.action === 'admin.theme.wallpaper')
  assert.ok(entry, 'the upload was not audited')
  assert.equal(entry.subject_id, stored.path)

  // And a theme may now name it — which is the only way the picture reaches a
  // visitor, because the stylesheet is what carries the url().
  //
  // WITH AN OPAQUE --content-bg, and that is not test housekeeping: the shipped
  // default for that token is transparent, and STORY-035 refuses a transparent
  // backing whenever there is a picture behind it, so a wallpaper save that
  // reuses `defaults` untouched is a 400 by design. Spelling the opaque value
  // here is what makes this case about the wallpaper rather than about the rule
  // next door — and the rule itself is proved, both directions, one case down.
  const saved = await postJson(app, THEME_URL, {
    cookie,
    body: {
      name: 'Holiday',
      tokens: { ...defaults, '--content-bg': '#ffffff' },
      wallpaperPath: stored.path,
    },
  })
  assert.equal(saved.statusCode, 200, saved.payload)
  assert.equal(saved.json().theme.wallpaperUrl, stored.url)

  const css = readFileSync(paths.themeCssFile, 'utf8')
  assert.match(css, new RegExp(`background-image: url\\("/wallpaper/${stored.path}"\\);`))
  assert.match(css, /background-attachment: fixed;/)
})

test('the shipped defaults plus a wallpaper are refused until the backing is made opaque (STORY-035)', async (t) => {
  // Both directions over HTTP, because the shipped default for --content-bg is
  // now the transparent one. That makes "open the form, upload a picture, press
  // save" the FIRST thing an owner does and a 400 — so the refusal has to name
  // the token and the fix has to work, or the change to the default has traded
  // one bad first experience for another.
  const { app, cookie, defaults, paths } = await desk(t)
  const uploaded = await postForm(app, WALLPAPER_URL, {
    cookie,
    parts: [{ name: 'file', filename: 'holiday.png', value: await png() }],
  })
  assert.equal(uploaded.statusCode, 200, uploaded.payload)
  const wallpaperPath = uploaded.json().path

  const refused = await postJson(app, THEME_URL, {
    cookie,
    body: { name: 'Holiday', tokens: defaults, wallpaperPath },
  })
  assert.equal(refused.statusCode, 400, refused.payload)
  assert.deepEqual(
    refused.json().error.problems,
    [{ code: 'content_backing_translucent', token: '--content-bg' }],
    'the ONLY problem should be this one; anything else means the defaults are broken for another reason',
  )
  assert.equal(existsSync(paths.themeCssFile), false)

  const accepted = await postJson(app, THEME_URL, {
    cookie,
    body: { name: 'Holiday', tokens: { ...defaults, '--content-bg': '#ffffff' }, wallpaperPath },
  })
  assert.equal(accepted.statusCode, 200, accepted.payload)
  const css = readFileSync(paths.themeCssFile, 'utf8')
  assert.match(css, /--content-bg: #ffffff;/)
  assert.match(css, new RegExp(`background-image: url\\("/wallpaper/${wallpaperPath}"\\);`))
})

test('an SVG uploaded as wallpaper.png is refused by name, and nothing lands on the volume', async (t) => {
  const { app, cookie, paths } = await desk(t)

  const refused = await postForm(app, WALLPAPER_URL, {
    cookie,
    // The filename and the declared content type both claim PNG. Neither is
    // consulted: the format comes from the bytes.
    parts: [{ name: 'file', filename: 'wallpaper.png', value: SVG_CALLED_PNG }],
  })

  assert.equal(refused.statusCode, 400, refused.payload)
  const error = refused.json().error
  assert.equal(error.code, 'svg_refused')
  assert.match(error.message, /SVG/)

  assert.equal(existsSync(paths.wallpaperDir) ? readdirSync(paths.wallpaperDir).length : 0, 0)
})

test('a request with no file part named "file" is refused rather than answered with a null path', async (t) => {
  const { app, cookie, paths } = await desk(t)
  const picture = await png()

  for (const [why, parts] of [
    ['no file part at all', [{ name: 'notes', value: 'no file here' }]],
    // A real image under the wrong field name. This is the case that keeps the
    // name in the contract meaning something: without the check, the route would
    // accept whatever file happened to arrive first, and the agreed field name
    // would be documentation rather than a rule.
    ['a file under another name', [{ name: 'wallpaper', filename: 'w.png', value: picture }]],
    ['a file with no name at all', [{ name: '', filename: 'w.png', value: picture }]],
  ]) {
    const refused = await postForm(app, WALLPAPER_URL, { cookie, parts })
    assert.equal(refused.statusCode, 400, `${why}: ${refused.payload}`)
    assert.equal(refused.json().error.code, 'file_missing', why)
  }

  assert.equal(existsSync(paths.wallpaperDir) ? readdirSync(paths.wallpaperDir).length : 0, 0)
})

// ---------------------------------------------------------------------------
// the world this suite could not otherwise see
//
// Everything above runs in the repo, from a harness whose temp directory
// happens to be laid out exactly as config.mjs would lay out DATA_DIR. Two
// production failures live precisely in the gap between that world and the pod's.

test('the checked-in defaults ARE src/App.vue’s :root block', async (t) => {
  // routes/admin.mjs used to parse this block at request time, which was drift-
  // proof and did not work in the image (see the next case). The values are a
  // constant now, so THIS is the thing that keeps them honest — and it runs
  // here, in the repo, where src/ exists. Edit a colour in App.vue and it names
  // the token.
  //
  // The ONE case that skips it is the API image, which carries server/ and
  // nothing above it — there is no App.vue there to compare against, which is
  // the whole reason the values are a constant, and the case below runs the
  // route in exactly that layout. The discriminator is the FRONTEND package.json
  // rather than App.vue itself, deliberately: "the repo is here but App.vue
  // moved" must be a failure, not a silent skip. A gate that decides for itself
  // that it is not applicable is the failure mode this file is full of.
  if (!existsSync(join(REPO_ROOT, 'package.json'))) {
    t.skip('server/ without a repo above it, i.e. the API image layout; this gate runs in CI')
    return
  }
  const css = readFileSync(join(REPO_ROOT, 'src/App.vue'), 'utf8')
  const block = css.match(/:root\s*\{([\s\S]*?)\}/)
  assert.ok(block, 'src/App.vue has no :root block')

  const declared = {}
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    declared[name] = value
  }
  // --content-bg is deliberately NOT in :root — `.main-content` reads it with a
  // `transparent` fallback — so the constant supplies it and nothing in App.vue
  // can confirm the value. What IS confirmed is that it stays transparent: an
  // opaque default is the thing that painted over body_bg.svg.
  assert.equal(DEFAULT_PALETTE['--content-bg'], '#00000000')
  assert.equal(declared['--content-bg'], undefined, 'if :root now declares it, this pair of files disagrees')

  const { '--content-bg': _contentBg, ...fromConstant } = DEFAULT_PALETTE
  assert.deepEqual(fromConstant, declared)
  // And the whole roster is covered, so the form never opens with an empty field.
  assert.equal(Object.keys(DEFAULT_PALETTE).length, THEME_TOKENS.length)
})

test('the defaults survive the API image layout, which carries server/ and no src/', async (t) => {
  // Dockerfile.api is `COPY server/ ./` and nothing else. Reproduced here rather
  // than asserted about: the module is loaded from a copy of server/ that has NO
  // sibling src/, which is the only layout the running pod has ever had. When
  // the defaults were a runtime read of ../../src/App.vue this answered {}, the
  // form opened with sixteen empty inputs and the first save was a 400 — while
  // every test in this file passed, because they all ran from the repo.
  const root = mkdtempSync(join(tmpdir(), 'joi-image-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const app = join(root, 'app')
  cpSync(SERVER_ROOT, app, { recursive: true, filter: (src) => !src.startsWith(join(SERVER_ROOT, 'node_modules')) })
  // The image installs its own; a symlink is the cheap equivalent and keeps the
  // resolution walk (app/routes -> app/node_modules) identical to the real one.
  symlinkSync(join(SERVER_ROOT, 'node_modules'), join(app, 'node_modules'))

  // THE PRECONDITION, asserted rather than assumed. If this ever became true the
  // case below would pass for the wrong reason.
  assert.equal(existsSync(join(root, 'src')), false, 'the fixture is not image-shaped')
  assert.equal(existsSync(join(app, 'routes/admin.mjs')), true)

  // The probe REGISTERS THE PLUGIN AND CALLS THE ROUTE. Importing the exported
  // constant instead would have been cheaper and would have proved nothing: the
  // first draft of this case did exactly that, and a mutation that left the
  // constant in place while the route went back to reading src/App.vue passed it.
  // What the pod is answering is the only fact worth checking.
  //
  // It lives INSIDE the copy so module resolution walks app/node_modules, the
  // same way it does in the image. That keeps `../../src/App.vue` resolving
  // outside the copy — which is the whole point.
  //
  // The probe's database and storage paths go in a directory THIS test makes and
  // removes, so nothing is left in TMPDIR whether the probe answers, throws or is
  // killed (STORY-123). When the probe made its own, nothing ever removed it. It
  // is outside the copy, where the probe's own directory always was.
  const probeData = mkdtempSync(join(tmpdir(), 'joi-image-probe-'))
  t.after(() => rmSync(probeData, { recursive: true, force: true }))
  const probe = join(app, 'image-defaults-probe.mjs')
  writeFileSync(
    probe,
    [
      "import { join } from 'node:path'",
      "import Database from 'better-sqlite3'",
      "import Fastify from 'fastify'",
      "import { migrate } from './db/migrate.mjs'",
      "import adminRoutes from './routes/admin.mjs'",
      'const dir = process.argv[2]',
      "const db = new Database(join(dir, 'joi.db'))",
      "migrate(db, { mode: 'development' })",
      'const server = Fastify({ logger: false })',
      'await server.register(adminRoutes, {',
      "  db, adminOpenIds: ['owner'],",
      '  paths: {',
      "    catalogFile: join(dir, 'catalog.json'), mediaDir: join(dir, 'media'),",
      "    themeCssFile: join(dir, 'theme.css'), wallpaperDir: join(dir, 'wallpaper'),",
      '  },',
      "  resolveIdentity: () => ({ openId: 'owner' }),",
      '})',
      "const answered = await server.inject({ method: 'GET', url: '/api/admin/theme' })",
      'process.stdout.write(JSON.stringify(answered.json().defaults))',
      'process.exit(0)',
    ].join('\n'),
  )
  const answer = JSON.parse(execFileSync(process.execPath, [probe, probeData], { encoding: 'utf8' }))

  assert.deepEqual(answer, { ...DEFAULT_PALETTE }, 'the image answers a different palette from the repo')
  assert.equal(Object.keys(answer).length, THEME_TOKENS.length)
})

test('THEME_CSS_FILE and WALLPAPER_DIR are honoured, not re-derived from the catalogue', async (t) => {
  // config.mjs reads both and lib/env-guard.mjs REQUIRES both to be absolute in
  // production, and server.mjs used to hand this plugin `{catalogFile, mediaDir}`
  // only — so resolveThemePaths derived the theme paths from dirname(catalogFile)
  // and both variables did nothing. An operator who moved either got a save that
  // answered 200 and wrote where nginx is not looking.
  //
  // Not driven through boot(): the harness registers the plugin with the same two
  // keys and lays its directories out so that the derivation coincides, which is
  // exactly why no existing case can tell the two worlds apart. This one puts the
  // theme paths on a DIFFERENT volume and drives a real save through the real
  // route, with resolveIdentity standing in for the session cookie.
  const db = openDatabase(t, { mode: 'development' })
  const dataDir = mkdtempSync(join(tmpdir(), 'joi-data-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'joi-elsewhere-'))
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })

  // The shape config.mjs produces when THEME_CSS_FILE / WALLPAPER_DIR are set
  // off DATA_DIR, mapped by the same function server.mjs calls.
  const storage = {
    catalogFile: join(dataDir, 'catalog.json'),
    mediaDir: join(dataDir, 'media'),
    themeCssFile: join(elsewhere, 'theme.css'),
    wallpaperDir: join(elsewhere, 'wallpaper'),
  }
  assert.deepEqual(
    adminStoragePaths(storage),
    storage,
    'server.mjs builds the plugin’s paths from this; dropping a key here is the original bug',
  )

  const fastify = Fastify({ logger: false })
  t.after(() => fastify.close())
  await fastify.register(adminRoutes, {
    db,
    adminOpenIds: ['owner-open-id'],
    paths: adminStoragePaths(storage),
    resolveIdentity: () => ({ openId: 'owner-open-id', submitterId: null, displayName: 'owner' }),
  })

  const saved = await fastify.inject({
    method: 'POST',
    url: THEME_URL,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Elsewhere', tokens: DEFAULT_PALETTE, wallpaperPath: null }),
  })
  assert.equal(saved.statusCode, 200, saved.payload)

  // Where the bytes landed, which is the only question that matters.
  assert.match(readFileSync(storage.themeCssFile, 'utf8'), /--cream: #fedcae;/)
  assert.equal(
    existsSync(join(dataDir, 'theme.css')),
    false,
    'the stylesheet was written beside catalog.json, i.e. THEME_CSS_FILE was ignored',
  )
})
