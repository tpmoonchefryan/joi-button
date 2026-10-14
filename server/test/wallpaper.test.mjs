// SPDX-License-Identifier: MIT
//
// The wallpaper pipeline, against real images.
//
// EVERY FIXTURE IS BUILT WITH SHARP AND NOTHING IS STUBBED. A stubbed decoder
// would let this file assert that storeWallpaper calls the methods its author
// believes strip EXIF, which is a test of the author's belief. STORY-035 asked
// for the EXIF to be gone, so the case below reads the STORED FILE back through
// sharp and looks for it — the only form of that claim that can fail if the
// belief is wrong.
//
// The three fixtures that are not sharp's own output are the ones sharp cannot
// make: an SVG (a text document), a decode bomb (a header that lies about its
// size) and a file that is not an image at all.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import sharp from 'sharp'

import {
  ACCEPTED_FORMATS,
  LIMIT_INPUT_PIXELS,
  MAX_HEIGHT,
  MAX_INPUT_BYTES,
  MAX_WIDTH,
  TEMP_NAME_PREFIX,
  WALLPAPER_REJECTIONS,
  looksLikeSvg,
  storeWallpaper,
} from '../lib/wallpaper.mjs'

/** A directory that exists and is empty, so "nothing was written" is checkable. */
function wallpaperDir(t) {
  // The cleanup removes the directory mkdtempSync made, not only the one inside
  // it: removing just wallpaper/ left an empty joi-wallpaper-* in TMPDIR for every
  // case that calls this (STORY-123). Registered before mkdirSync so a failure
  // there is cleaned up too.
  const root = mkdtempSync(join(tmpdir(), 'joi-wallpaper-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'wallpaper')
  mkdirSync(dir)
  return dir
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function png({ width = 40, height = 24, background = '#dd2e44' } = {}) {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer()
}

/**
 * A JPEG that really carries EXIF — verified in the case that uses it, because a
 * fixture that quietly lost its metadata on the way in would make the assertion
 * about the stored file pass for the wrong reason.
 */
function jpegWithExif() {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: '#6f2f74' } })
    .withExif({ IFD0: { Copyright: 'joi-button fixture', Software: 'the test that proves this is removed' } })
    .jpeg()
    .toBuffer()
}

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
    '<script>fetch("/api/admin/audit").then(r =&gt; r.text())</script>' +
    '<rect width="64" height="64" fill="#fedcae"/></svg>',
  'utf8',
)

/** The same thing behind an XML declaration, a DOCTYPE and a comment. */
const SVG_WITH_PREAMBLE = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
    '<!-- a comment long enough to push the root element past a naive prefix check -->\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script></svg>',
  'utf8',
)

const NOT_AN_IMAGE = Buffer.from(
  'This is prose. It is not a picture, however confidently the filename claims otherwise.',
  'utf8',
)

/**
 * A PNG whose header declares a size it does not contain: gigapixels in a few
 * hundred bytes. The whole file is a real PNG apart from the two numbers and the
 * CRC over them, so nothing rejects it for being malformed; it is rejected for
 * what it CLAIMS, which is the whole of the attack.
 */
async function decodeBomb({ width, height }) {
  const buffer = Buffer.from(await png({ width: 8, height: 8 }))
  buffer.writeUInt32BE(width, 16) // IHDR width
  buffer.writeUInt32BE(height, 20) // IHDR height
  // The CRC covers the chunk TYPE and its data: bytes 12..29 for a 13-byte IHDR.
  buffer.writeUInt32BE(crc32(buffer.subarray(12, 29)), 29)
  return buffer
}

/**
 * sharp's own ceiling, 0x3FFF squared — about 268 megapixels.
 *
 * Written down here because one case below exists ONLY to tell our limit apart
 * from this one. Without it, "a decode bomb is refused" would pass with
 * limitInputPixels deleted from lib/wallpaper.mjs entirely, and the deliberate
 * number would be decoration.
 */
const SHARP_DEFAULT_LIMIT_INPUT_PIXELS = 0x3fff * 0x3fff

/** CRC-32 (the PNG/zlib polynomial), written out rather than taken from
 *  node:zlib — zlib.crc32 landed in Node 22.2 and package.json says >= 22.0. */
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Runs `fn`, returns the error it threw, and fails if it threw nothing. */
async function refused(fn, why) {
  try {
    await fn()
  } catch (error) {
    return error
  }
  assert.fail(`${why}\n    it was ACCEPTED; nothing refused it.`)
}

// ---------------------------------------------------------------------------

test('a real PNG round-trips, and the file on disk is the one the name promises', async (t) => {
  const dir = join(wallpaperDir(t), 'not-created-yet')

  const stored = await storeWallpaper(await png({ width: 64, height: 48 }), { wallpaperDir: dir })

  assert.equal(stored.format, 'png')
  assert.equal(stored.width, 64)
  assert.equal(stored.height, 48)
  assert.match(stored.path, /^[0-9a-f]{64}\.png$/)
  // No separator anywhere in it: themes.wallpaper_path CHECKs the same shape, so
  // a traversal has no legal spelling in the column OR in the answer.
  assert.equal(stored.path.includes('/'), false)

  const onDisk = readFileSync(join(dir, stored.path))
  assert.equal(onDisk.length, stored.bytes)
  // THE NAME IS THE HASH OF WHAT IS THERE. Not of what was uploaded — see the
  // EXIF case, which is where the two are guaranteed to differ.
  assert.equal(`${sha256(onDisk)}.png`, stored.path)

  // The directory did not exist a moment ago: a first upload onto a fresh volume
  // must not need somebody to mkdir it first.
  assert.deepEqual(readdirSync(dir), [stored.path])
})

test('storing the same picture twice converges on one file', async (t) => {
  const dir = wallpaperDir(t)
  const source = await png({ width: 20, height: 20 })

  const first = await storeWallpaper(source, { wallpaperDir: dir })
  const second = await storeWallpaper(Buffer.from(source), { wallpaperDir: dir })

  assert.equal(first.path, second.path)
  assert.deepEqual(readdirSync(dir), [first.path])
})

test('a JPEG carrying EXIF loses it, and the stored name is the hash of the stripped bytes', async (t) => {
  const dir = wallpaperDir(t)
  const source = await jpegWithExif()

  // The fixture is really carrying what this case is about to look for. Without
  // this, "the stored file has no EXIF" would pass against a file that never had
  // any, which is the shape of a gate that cannot go red.
  const before = await sharp(source).metadata()
  assert.ok(before.exif !== undefined && before.exif.length > 0, 'the fixture has no EXIF to lose')

  const stored = await storeWallpaper(source, { wallpaperDir: dir })
  assert.equal(stored.format, 'jpeg')
  assert.equal(stored.path.endsWith('.jpg'), true, 'themes.wallpaper_path allows jpg, not jpeg')

  const after = await sharp(join(dir, stored.path)).metadata()
  assert.equal(after.exif, undefined, 'the stored wallpaper still carries EXIF')
  assert.equal(after.icc, undefined, 'the stored wallpaper still carries an ICC profile')
  assert.equal(after.xmp, undefined, 'the stored wallpaper still carries XMP')

  // The two hashes differ BECAUSE the metadata is gone, which is what makes this
  // the case that catches a name computed from the input.
  assert.notEqual(stored.path, `${sha256(source)}.jpg`)
  assert.equal(stored.path, `${sha256(readFileSync(join(dir, stored.path)))}.jpg`)
})

test('an SVG is refused by name, even called .png, and even behind a DOCTYPE', async (t) => {
  const dir = wallpaperDir(t)

  // The filename never reaches this function — that is the point of taking a
  // buffer — so "called .png" is proved at the HTTP boundary, in
  // test/http/theme.test.mjs. What is proved here is that the BYTES are enough.
  for (const [what, payload] of [['plain', SVG], ['with a preamble', SVG_WITH_PREAMBLE]]) {
    const error = await refused(
      () => storeWallpaper(payload, { wallpaperDir: dir }),
      `an SVG ${what} was stored`,
    )
    assert.equal(error.code, WALLPAPER_REJECTIONS.svg_refused, error.message)
    // BY NAME: the owner is told the format is the problem, not that their file
    // is broken, because converting it is the answer and retrying is not.
    assert.match(error.message, /SVG/)
  }

  assert.equal(looksLikeSvg(SVG_WITH_PREAMBLE), true)
  // A real PNG is not mistaken for markup: the sniffer requires the first
  // non-space byte to be '<', so compressed data that happens to spell '<svg'
  // cannot cost somebody their upload.
  assert.equal(looksLikeSvg(await png()), false)

  // THE THIRD LAYER, asserted because lib/wallpaper.mjs's header now makes a
  // claim about it. With both SVG branches deleted, the allow-list is what still
  // refuses the payload — measured on darwin/arm64 and on linux/musl/x64, where
  // sharp reports `format: 'svg'` and this lookup misses. So the two branches buy
  // the SENTENCE, not the refusal, and the header says so. If 'svg' were ever
  // added here, deleting a branch really would store the payload and this line is
  // what notices.
  assert.equal(ACCEPTED_FORMATS.svg, undefined, "an SVG would be STORED if the allow-list accepted 'svg'")

  assert.deepEqual(readdirSync(dir), [])
})

test('an image format we do not serve is refused, and the answer names it', async (t) => {
  const dir = wallpaperDir(t)
  const gif = await sharp(await png({ width: 10, height: 10 })).gif().toBuffer()
  assert.equal((await sharp(gif).metadata()).format, 'gif', 'the fixture is not really a GIF')

  const error = await refused(() => storeWallpaper(gif, { wallpaperDir: dir }), 'a GIF was stored')
  assert.equal(error.code, WALLPAPER_REJECTIONS.unsupported_format)
  assert.match(error.message, /gif/i)
  // The roster is closed and these three are it — the same three
  // themes.wallpaper_path's CHECK allows.
  assert.deepEqual(Object.keys(ACCEPTED_FORMATS), ['png', 'jpeg', 'webp'])
  assert.deepEqual(readdirSync(dir), [])
})

test('a file that is not an image at all is refused', async (t) => {
  const dir = wallpaperDir(t)
  const error = await refused(
    () => storeWallpaper(NOT_AN_IMAGE, { wallpaperDir: dir }),
    'a text file was stored',
  )
  assert.equal(error.code, WALLPAPER_REJECTIONS.not_an_image)
  assert.deepEqual(readdirSync(dir), [])
})

test('an oversized upload is refused before anything decodes it', async (t) => {
  const dir = wallpaperDir(t)
  // A real, valid PNG that is simply too big: 1400x1400 stored uncompressed is
  // ~5.9 MB, and its dimensions are well inside the cap — so this can only be
  // refused for its SIZE, which is what the assertion claims.
  const big = await sharp(Buffer.alloc(1400 * 1400 * 3, 0xab), {
    raw: { width: 1400, height: 1400, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer()
  assert.ok(big.length > MAX_INPUT_BYTES, `the fixture is only ${big.length} bytes`)

  const error = await refused(() => storeWallpaper(big, { wallpaperDir: dir }), 'an oversized PNG was stored')
  assert.equal(error.code, WALLPAPER_REJECTIONS.too_large)
  assert.equal(error.details.limit, MAX_INPUT_BYTES)
  assert.deepEqual(readdirSync(dir), [])
})

test('an image larger than the dimension cap is refused, and the answer names both sizes', async (t) => {
  const dir = wallpaperDir(t)
  // 15 megapixels: inside LIMIT_INPUT_PIXELS, so the header parses and the
  // refusal can quote the real numbers instead of a libvips string.
  const wide = await png({ width: 5000, height: 3000, background: '#91d7f1' })
  assert.ok(5000 * 3000 < LIMIT_INPUT_PIXELS)

  const error = await refused(() => storeWallpaper(wide, { wallpaperDir: dir }), 'a 5000x3000 image was stored')
  assert.equal(error.code, WALLPAPER_REJECTIONS.dimensions_too_large)
  assert.match(error.message, /5000x3000/)
  assert.match(error.message, new RegExp(`${MAX_WIDTH}x${MAX_HEIGHT}`))
  assert.deepEqual(readdirSync(dir), [])
})

test('a decode bomb is refused from its header, before anything allocates for it', async (t) => {
  const dir = wallpaperDir(t)
  const bomb = await decodeBomb({ width: 100000, height: 100000 })
  // Small enough to sail past every byte-count check ever written. That is the
  // whole attack: the cost is in what the header PROMISES, not in what arrived.
  assert.ok(bomb.length < 4096, `the bomb is ${bomb.length} bytes, which is not a bomb`)
  assert.ok(100000 * 100000 > LIMIT_INPUT_PIXELS)

  const error = await refused(() => storeWallpaper(bomb, { wallpaperDir: dir }), 'a decode bomb was stored')
  assert.equal(error.code, WALLPAPER_REJECTIONS.dimensions_too_large)
  assert.deepEqual(readdirSync(dir), [])
})

test('the pixel ceiling is the one this module chose, not the one sharp ships with', async (t) => {
  const dir = wallpaperDir(t)
  // 200 megapixels: INSIDE sharp's default and outside ours. The case above
  // cannot see the difference — ten gigapixels is refused by either number — so
  // this is the one that fails if LIMIT_INPUT_PIXELS is raised or deleted, and
  // without it that constant would be a comment rather than a limit.
  const bomb = await decodeBomb({ width: 20000, height: 10000 })
  assert.ok(20000 * 10000 > LIMIT_INPUT_PIXELS)
  assert.ok(20000 * 10000 < SHARP_DEFAULT_LIMIT_INPUT_PIXELS)

  const error = await refused(() => storeWallpaper(bomb, { wallpaperDir: dir }), 'a 200-megapixel header was accepted')
  assert.equal(error.code, WALLPAPER_REJECTIONS.dimensions_too_large)
  // BEFORE IT IS DECODED — the distinguishing fact. Under sharp's default the
  // header would parse, and the refusal would come from the dimension check
  // afterwards with a different sentence, having already agreed to look at it.
  assert.match(error.message, /refused before it is decoded/)
  assert.equal(error.details.limitInputPixels, LIMIT_INPUT_PIXELS)
  assert.deepEqual(readdirSync(dir), [])
})

test('an empty upload is refused', async (t) => {
  const dir = wallpaperDir(t)
  const error = await refused(
    () => storeWallpaper(Buffer.alloc(0), { wallpaperDir: dir }),
    'an empty buffer was stored',
  )
  assert.equal(error.code, WALLPAPER_REJECTIONS.empty)
  assert.deepEqual(readdirSync(dir), [])
})

test('after every refusal the directory is exactly as empty as it started', async (t) => {
  const dir = wallpaperDir(t)
  const bomb = await decodeBomb({ width: 100000, height: 100000 })
  const gif = await sharp(await png()).gif().toBuffer()

  for (const payload of [SVG, SVG_WITH_PREAMBLE, NOT_AN_IMAGE, bomb, gif, Buffer.alloc(0)]) {
    await refused(() => storeWallpaper(payload, { wallpaperDir: dir }), 'a refused payload was stored')
  }

  // Not "no wallpaper was published" — NOTHING, including a temp file. The write
  // path names its temp file with a leading dot and readdirSync lists those too,
  // so a half-written leftover shows up here rather than hiding from the check
  // that is supposed to find it.
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(existsSync(dir), true)
})

test('the temp name keeps the leading dot that deploy/nginx.conf refuses', async (t) => {
  const dir = wallpaperDir(t)

  // WHY A CONSTANT IS ASSERTED HERE RATHER THAN A LIVE TEMP FILE: the whole
  // open/write/fsync/rename sequence is synchronous, so no observer in this
  // process can ever see the temp file exist — and the case above proves that
  // after a refusal it does not. What is left to protect is the joint between
  // this module and deploy/nginx.conf, whose nested `location ~ /\.` inside the
  // `^~ /wallpaper/` block is the only thing standing between a crash-leftover
  // and a partial image served `public, immutable` for a year.
  //
  // That rule keys on the LEADING DOT, and nothing mechanical connects the two
  // files. Renaming the temp file to `wallpaper-tmp-<uuid>` would silently move
  // this module out from under nginx's protection with every existing test still
  // green. This is the line that goes red instead.
  assert.equal(TEMP_NAME_PREFIX.startsWith('.'), true, 'nginx refuses dot segments; a temp file must be one')
  // And it is really the name in use: a successful store leaves the published
  // file and nothing else, so the constant is not decoration somewhere off to the
  // side of the code that writes.
  const stored = await storeWallpaper(await png({ width: 16, height: 16 }), { wallpaperDir: dir })
  assert.deepEqual(readdirSync(dir), [stored.path])
  assert.equal(stored.path.startsWith(TEMP_NAME_PREFIX), false, 'a temp name was published')
})
