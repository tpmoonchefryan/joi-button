// SPDX-License-Identifier: MIT
//
// deploy/deploy-k3s.sh, driven end to end against stubs (STORY-119).
//
// The repository moved owners, CI started pushing images to the new owner's
// namespace, and the deploy path kept pulling from the old one. Nothing caught
// it because nothing ran this script anywhere but production. These tests run
// it here, with every outside party replaced:
//
//   kubectl   KUBECTL is an absolute path to a stub that records each call and
//             every stream piped into `apply -f -`, and answers the reads the
//             script makes (nodes, generation, rollout status, the two in-pod
//             wgets, the deployed image) the way a cluster would.
//   ssh       a fake `ssh` first on PATH. It never opens a connection and
//             refuses every host but the fixture alias, which is under the
//             RFC 2606 `.invalid` TLD and so cannot resolve anywhere.
//   pulls     PULL_CMD is an absolute path to a stub that records the image
//             reference and fails for the one named in STUB_PULL_FAIL. The fake
//             `sudo` answers the default PULL_CMD the same way, and nothing else.
//   the rest  k3s, crictl, ctr, docker and kubectl on PATH are tripwires: they
//             record that they were reached and fail.
//
// ENV_FILE and RUNTIME_ENV_FILE always point at fixtures in a temporary
// directory. That is not tidiness: a real, git-ignored deploy/deploy.env can sit
// next to the script, the script sources it by default, and an exported empty
// REMOTE does not override it. HOME is a temporary directory too. Nothing here
// reads or writes a file in the repository, and nothing touches the network.
//
//   node --test test/

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'deploy', 'deploy-k3s.sh')
const MANIFEST_DIR = join(REPO_ROOT, 'deploy', 'k8s')

// Where CI pushes (.github/workflows/image.yml derives it from the repository
// owner), and therefore where an un-overridden deploy must pull from.
const WEB_REPO = 'ghcr.io/tpmoonchefryan/joi-button/web'
const API_REPO = 'ghcr.io/tpmoonchefryan/joi-button/api'
const TEST_TAG = 'v0.0.0-test'
const FAKE_NODE = 'fake-node.invalid'
const US = '\x1f'

// ---------------------------------------------------------------------------
// stubs
// ---------------------------------------------------------------------------

// Every stub appends one line per call to events.log: its name, then its
// arguments, separated by the ASCII unit separator. One printf per line, so the
// two kubectl processes of a pipeline cannot interleave inside a line.
const LOG_FN = String.raw`log_event() {
  local line="$1" a
  shift
  for a in "$@"; do line="$line"$'\037'"$a"; done
  printf '%s\n' "$line" >> "$STUB_STATE_DIR/events.log"
}`

const TRIPWIRE = String.raw`#!/usr/bin/env bash
${LOG_FN}
name="$(basename "$0")"
log_event tripwire "$name" "$@"
echo "tripwire: the real '$name' must never be reached from test/deploy-k3s.test.mjs" >&2
exit 97
`

// sudo answers exactly two calls: the default PULL_CMD (`sudo -n k3s crictl pull
// <ref>`), as a pull that succeeds unless the ref is STUB_PULL_FAIL, and the
// local-build path's `sudo k3s ctr images ls -q`, listing STUB_LOCAL_IMAGES.
// Anything else is a tripwire. The real sudo is never reached.
const FAKE_SUDO = String.raw`#!/usr/bin/env bash
${LOG_FN}
log_event sudo "$@"
if [ "$#" = 5 ] && [ "$1" = -n ] && [ "$2" = k3s ] && [ "$3" = crictl ] && [ "$4" = pull ]; then
  if [ "$5" = "$STUB_PULL_FAIL" ]; then echo "fake crictl: pulling image $5: not found" >&2; exit 1; fi
  echo "Image is up to date for $5"
  exit 0
fi
if [ "$*" = "k3s ctr images ls -q" ]; then
  for ref in $STUB_LOCAL_IMAGES; do echo "$ref"; done
  exit 0
fi
echo "tripwire: 'sudo $*' is not a call this test expects; the real sudo is never reached" >&2
exit 97
`

// PULL_CMD for most runs: an absolute path, so the pre-pull never needs sudo.
const FAKE_PULL = String.raw`#!/usr/bin/env bash
${LOG_FN}
log_event pull "$@"
if [ "$#" != 1 ]; then echo "fake pull: expected one image reference, got $#" >&2; exit 2; fi
if [ "$1" = "$STUB_PULL_FAIL" ]; then echo "fake pull: $1: not found" >&2; exit 1; fi
echo "Image is up to date for $1"
`

// The fake ssh. FAKE_SSH_MODE=record (the default) only records, and keeps what
// arrived on stdin; FAKE_SSH_MODE=run then hands the remote command to a local
// bash, the way the remote login shell would, with stdin closed for -n.
// (The stubs avoid brace expansions: these are String.raw templates.)
const FAKE_SSH = String.raw`#!/usr/bin/env bash
${LOG_FN}
log_event ssh "$@"
no_stdin=0
if [ "$1" = "-n" ]; then no_stdin=1; shift; fi
case "$1" in
  -*) echo "fake ssh: unexpected option $1" >&2; exit 255 ;;
esac
host="$1"
if [ -z "$FAKE_SSH_HOST" ] || [ "$host" != "$FAKE_SSH_HOST" ]; then
  log_event ssh-refused "$host"
  echo "fake ssh: refusing '$host'; this test only ever names $FAKE_SSH_HOST" >&2
  exit 255
fi
shift
mode="$FAKE_SSH_MODE"
[ -n "$mode" ] || mode=record
if [ "$mode" = record ]; then
  if [ "$no_stdin" = 0 ]; then cat >> "$STUB_STATE_DIR/ssh-stdin.txt"; fi
  echo "fake ssh ran on $host: $*"
  exit 0
fi
if [ "$no_stdin" = 1 ]; then
  exec bash -c "$*" < /dev/null
fi
exec bash -c "$*"
`

// The kubectl stub, in CommonJS so the extension-less file loads the same way
// on every Node version.
const FAKE_KUBECTL = String.raw`#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const state = process.env.STUB_STATE_DIR
const argv = process.argv.slice(2)
fs.appendFileSync(path.join(state, 'events.log'), ['kubectl', ...argv].join('\x1f') + '\n')

let args = argv
if (args[0] === '-n') args = args.slice(2)
const is = (...want) => want.length === args.length && want.every((w, i) => w === args[i])
const appliedFiles = () =>
  fs.readdirSync(state).filter((f) => /^apply-\d+\.yaml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
// The last applied Deployment of that name, as the cluster would hold it.
const deployment = (name) => {
  let found = null
  for (const f of appliedFiles()) {
    for (const doc of fs.readFileSync(path.join(state, f), 'utf8').split(/^---[ \t]*$/m)) {
      const named = new RegExp('^  name:[ \\t]*' + name + '[ \\t]*$', 'm')
      if (/^kind:[ \t]*Deployment[ \t]*$/m.test(doc) && named.test(doc)) found = doc
    }
  }
  return found
}
const done = (out) => { process.stdout.write(out); process.exit(0) }

if (is('get', 'nodes', '-o', 'name')) done('node/fake-node\n')
if (is('apply', '-f', '-')) {
  const n = appliedFiles().length + 1
  fs.writeFileSync(path.join(state, 'apply-' + n + '.yaml'), fs.readFileSync(0, 'utf8'))
  done('applied by the stub (' + n + ')\n')
}
if (args[0] === 'get' && args[1] === 'deploy' && args.length === 5 && args[3] === '-o') {
  const doc = deployment(args[2])
  if (!doc) {
    process.stderr.write('Error from server (NotFound): deployments.apps "' + args[2] + '" not found\n')
    process.exit(1)
  }
  if (args[4] === 'jsonpath={.metadata.generation}') done('1')
  if (args[4] === 'jsonpath={.spec.template.spec.containers[0].image}') {
    const m = /^[ \t]*image:[ \t]*(\S+)[ \t]*$/m.exec(doc)
    done(m ? m[1] : '')
  }
}
if (args[0] === 'create' && args[1] === 'secret' && args.includes('--from-env-file=/dev/stdin') && args.includes('--dry-run=client')) {
  const input = fs.readFileSync(0, 'utf8')
  fs.appendFileSync(path.join(state, 'secret-input.env'), input)
  const data = input.split('\n').filter(Boolean)
    .map((l) => '  ' + l.slice(0, l.indexOf('=')) + ': ' + Buffer.from(l.slice(l.indexOf('=') + 1)).toString('base64'))
  done('apiVersion: v1\nkind: Secret\nmetadata:\n  name: ' + args[3] + '\ndata:\n' + data.join('\n') + '\n')
}
if (args[0] === 'create' && args[1] === 'namespace' && args.includes('--dry-run=client')) {
  done('apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ' + args[2] + '\n')
}
if (args[0] === 'rollout' && args[1] === 'status') done('deployment "' + args[2] + '" successfully rolled out\n')
if (args[0] === 'rollout' && args[1] === 'restart') done(args[2] + ' restarted\n')
if (is('exec', 'deploy/joi-button-web', '--', 'wget', '-qO-', 'http://127.0.0.1:8080/')) {
  done('<!doctype html><html><body><div id="app"></div></body></html>\n')
}
if (is('exec', 'deploy/joi-button-api', '--', 'wget', '-qO-', 'http://127.0.0.1:8080/api/readyz')) {
  done('{"status":"ok","checks":{"database":{"status":"ok"}}}\n')
}
process.stderr.write('kubectl stub: unexpected call: ' + argv.join(' ') + '\n')
process.exit(98)
`

function writeExecutable(file, body) {
  writeFileSync(file, body)
  chmodSync(file, 0o755)
}

// A fresh temporary world for one run of the script; removed when the test ends.
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'joi-deploy-k3s-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // KUBECTL travels unquoted inside remote command strings, exactly as an
  // operator's "sudo k3s kubectl" does; a path with blanks would split.
  assert.doesNotMatch(root, /\s/, 'the temporary directory path must not contain whitespace')
  const box = {
    root,
    bin: join(root, 'bin'),
    state: join(root, 'state'),
    home: join(root, 'home'),
    kubectl: join(root, 'kubectl-stub'),
    pull: join(root, 'pull-stub'),
    envFile: join(root, 'deploy.env'),
    runtimeEnv: join(root, 'runtime.env'),
  }
  for (const dir of [box.bin, box.state, box.home]) mkdirSync(dir)
  writeExecutable(join(box.bin, 'ssh'), FAKE_SSH)
  writeExecutable(join(box.bin, 'sudo'), FAKE_SUDO)
  for (const name of ['kubectl', 'k3s', 'crictl', 'ctr', 'docker']) writeExecutable(join(box.bin, name), TRIPWIRE)
  writeExecutable(box.kubectl, FAKE_KUBECTL)
  writeExecutable(box.pull, FAKE_PULL)
  writeFileSync(box.runtimeEnv, 'JOI_TEST_KEY=fixture-value\n')
  writeFileSync(box.envFile, '')
  return box
}

function parseEvents(stateDir) {
  const file = join(stateDir, 'events.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [who, ...argv] = line.split(US)
      return { who, argv }
    })
}

function appliedStreams(stateDir) {
  return readdirSync(stateDir)
    .filter((f) => /^apply-\d+\.yaml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => readFileSync(join(stateDir, f), 'utf8'))
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Run deploy/deploy-k3s.sh in a sandbox. `env` entries set to undefined are
// removed, which is how a test says "the caller did not export this". Both
// `deployEnv` and `env` may be functions of the sandbox, for paths inside it.
function runDeploy(t, { mode = 'apply', deployEnv = '', env = {} } = {}) {
  const box = sandbox(t)
  writeFileSync(box.envFile, typeof deployEnv === 'function' ? deployEnv(box) : deployEnv)
  const merged = {
    PATH: `${box.bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    HOME: box.home,
    TMPDIR: box.root,
    LC_ALL: 'C',
    STUB_STATE_DIR: box.state,
    FAKE_SSH_HOST: FAKE_NODE,
    ENV_FILE: box.envFile,
    RUNTIME_ENV_FILE: box.runtimeEnv,
    KUBECTL: box.kubectl,
    PULL_CMD: box.pull,
    IMAGE_SOURCE: 'registry',
    TAG: TEST_TAG,
    ...(typeof env === 'function' ? env(box) : env),
  }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  const result = spawnSync('bash', [SCRIPT, mode], {
    cwd: box.root,
    env: merged,
    encoding: 'utf8',
    timeout: 120_000,
  })
  const events = parseEvents(box.state)
  return {
    box,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    events,
    kubectl: events.filter((e) => e.who === 'kubectl').map((e) => e.argv),
    applied: appliedStreams(box.state),
    describe() {
      return `exit ${result.status} signal ${result.signal}\n--- stdout (tail)\n${(result.stdout ?? '').slice(-1500)}\n--- stderr (tail)\n${(result.stderr ?? '').slice(-1500)}`
    },
  }
}

// The image lines of each rendered manifest in a stream, keyed by file name.
function imagesByManifest(stream) {
  const images = {}
  let current = null
  for (const line of stream.split('\n')) {
    const rendered = /^# rendered from (.+)$/.exec(line)
    if (rendered) {
      current = basename(rendered[1])
      images[current] = []
      continue
    }
    const image = /^\s*image:\s*(\S+)\s*$/.exec(line)
    if (image && current) images[current].push(image[1])
  }
  return images
}

function workloadStream(run) {
  const stream = run.applied.find((s) => /^# rendered from .*web-deployment\.yaml$/m.test(s))
  assert.ok(stream, `no applied stream carried the workload manifests\n${run.describe()}`)
  return stream
}

function assertPinned(run, webRef, apiRef) {
  const stream = workloadStream(run)
  const images = imagesByManifest(stream)
  assert.deepEqual(images['web-deployment.yaml'], [webRef], 'web Deployment image')
  assert.deepEqual(images['api-deployment.yaml'], [apiRef], 'api Deployment image')
  assert.deepEqual(images['backup-cronjob.yaml'], [apiRef], 'backup CronJob image')
  assert.doesNotMatch(stream, /replace-me/, 'the applied workload stream still carries a placeholder')
  return stream
}

function assertNoOutsideParty(run) {
  const reached = run.events.filter((e) => e.who === 'tripwire' || e.who === 'ssh-refused')
  assert.deepEqual(reached, [], 'a tripwire was reached, or the fake ssh was asked for a real host')
}

const SINGLE_HOST_ENV = 'REMOTE=\nAPP_HOST=app.example.test\n'

// ---------------------------------------------------------------------------
// SUB-007: the new namespace, and the caller's exports win over deploy.env
// ---------------------------------------------------------------------------

test('STORY-119 SUB-007: default repositories and all three manifest placeholders name the namespace CI pushes to', () => {
  const script = readFileSync(SCRIPT, 'utf8')
  assert.equal(/^DEFAULT_IMAGE_REPO="([^"]*)"$/m.exec(script)?.[1], WEB_REPO)
  assert.equal(/^DEFAULT_API_IMAGE_REPO="([^"]*)"$/m.exec(script)?.[1], API_REPO)

  // The script derives its placeholders from the defaults, so these lines must
  // equal "<default>:replace-me" byte for byte or `apply` refuses before it starts.
  const imageLines = (file) =>
    readFileSync(join(MANIFEST_DIR, file), 'utf8')
      .split('\n')
      .filter((l) => /^\s*image:/.test(l))
      .map((l) => l.trim())
  assert.deepEqual(imageLines('web-deployment.yaml'), [`image: ${WEB_REPO}:replace-me`])
  assert.deepEqual(imageLines('api-deployment.yaml'), [`image: ${API_REPO}:replace-me`])
  assert.deepEqual(imageLines('backup-cronjob.yaml'), [`image: ${API_REPO}:replace-me`])

  const deploySide = [
    SCRIPT,
    join(REPO_ROOT, 'deploy', 'deploy.env.example'),
    ...readdirSync(MANIFEST_DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => join(MANIFEST_DIR, f)),
  ]
  for (const file of deploySide) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /ryanlan-new\/joi-button/, `${basename(file)} still names the old image namespace`)
    assert.doesNotMatch(text, /ghcr\.io\/ryanlan-new/, `${basename(file)} still names the old registry owner`)
  }
})

test('STORY-119 SUB-007: apply pins web, api and the backup CronJob to the new namespace, or to the repositories the caller exports', (t) => {
  const plain = runDeploy(t, { deployEnv: SINGLE_HOST_ENV, env: { IMAGE_REPO: undefined, API_IMAGE_REPO: undefined } })
  assert.equal(plain.status, 0, plain.describe())
  assert.match(plain.stdout, new RegExp(`web image: +${escapeRe(`${WEB_REPO}:${TEST_TAG}`)}$`, 'm'))
  assert.match(plain.stdout, new RegExp(`api image: +${escapeRe(`${API_REPO}:${TEST_TAG}`)}$`, 'm'))
  const stream = assertPinned(plain, `${WEB_REPO}:${TEST_TAG}`, `${API_REPO}:${TEST_TAG}`)
  assert.match(stream, /^\s*- host: app\.example\.test$/m, 'the Ingress host comes from deploy.env')
  // The script's own last word: it read the image back from the "cluster".
  assert.match(plain.stdout, new RegExp(`joi-button-web pins ${escapeRe(`${WEB_REPO}:${TEST_TAG}`)}\\.`))
  assert.match(plain.stdout, new RegExp(`joi-button-api pins ${escapeRe(`${API_REPO}:${TEST_TAG}`)}\\.`))
  assert.deepEqual(plain.events.filter((e) => e.who === 'ssh'), [], 'REMOTE is empty, so nothing may go over ssh')
  assertNoOutsideParty(plain)

  // What CI does: export the repositories it pushed to.
  const exported = runDeploy(t, {
    deployEnv: SINGLE_HOST_ENV,
    env: { IMAGE_REPO: 'registry.example.test/team/joi/web', API_IMAGE_REPO: 'registry.example.test/team/joi/api' },
  })
  assert.equal(exported.status, 0, exported.describe())
  assertPinned(exported, `registry.example.test/team/joi/web:${TEST_TAG}`, `registry.example.test/team/joi/api:${TEST_TAG}`)
  assertNoOutsideParty(exported)
})

test('STORY-119 SUB-007: a non-empty export wins over deploy.env for every documented name; empty exports and file-only names leave the file in charge', (t) => {
  // Every value on the file side would break the run, or be visible, if it won.
  const fileSide = (box) =>
    [
      'REMOTE=',
      'APP_HOST=app.example.test',
      'LB_ADDRESS=lb.example.test',
      'IMAGE_REPO=file.example.test/joi/web',
      'API_IMAGE_REPO=file.example.test/joi/api',
      'TAG=v0.0.0-file',
      'IMAGE_SOURCE=local',
      'NAMESPACE=file-namespace',
      `KUBECTL=${join(box.root, 'no-such-kubectl')}`,
      `RUNTIME_ENV_FILE=${join(box.root, 'no-such-runtime.env')}`,
      `MANIFEST_DIR=${join(box.root, 'no-such-manifests')}`,
      'ROLLOUT_TIMEOUT=111s',
      `PULL_CMD=${join(box.root, 'no-such-pull')}`, // the caller's PULL_CMD is the stub
      '',
    ].join('\n')
  const callerSide = (box) => ({
    IMAGE_REPO: 'caller.example.test/joi/web',
    API_IMAGE_REPO: 'caller.example.test/joi/api',
    TAG: 'v0.0.0-caller',
    IMAGE_SOURCE: 'registry',
    NAMESPACE: 'caller-namespace',
    KUBECTL: box.kubectl,
    RUNTIME_ENV_FILE: box.runtimeEnv,
    MANIFEST_DIR,
    ROLLOUT_TIMEOUT: '7s',
    LB_ADDRESS: '', // exported empty: does not count as set
  })
  const run = (overrides) =>
    runDeploy(t, { deployEnv: fileSide, env: (box) => ({ ...callerSide(box), ...overrides }) })

  const all = run({})
  assert.equal(all.status, 0, all.describe())
  assert.match(all.stdout, /web image: +caller\.example\.test\/joi\/web:v0\.0\.0-caller$/m)
  assert.match(all.stdout, /api image: +caller\.example\.test\/joi\/api:v0\.0\.0-caller$/m)
  assert.match(all.stdout, /image src: +registry$/m)
  assert.match(all.stdout, /namespace: +caller-namespace$/m)
  assert.match(all.stdout, new RegExp(`kubectl: +${escapeRe(all.box.kubectl)}$`, 'm'))
  const stream = assertPinned(all, 'caller.example.test/joi/web:v0.0.0-caller', 'caller.example.test/joi/api:v0.0.0-caller')
  // MANIFEST_DIR: the caller's absolute path is what got rendered.
  assert.match(stream, new RegExp(`^# rendered from ${escapeRe(MANIFEST_DIR)}/web-deployment\\.yaml$`, 'm'))
  // RUNTIME_ENV_FILE: the Secret was built from the caller's fixture.
  assert.equal(readFileSync(join(all.box.state, 'secret-input.env'), 'utf8'), 'JOI_TEST_KEY=fixture-value\n')
  // NAMESPACE: every namespaced kubectl call used the caller's.
  const namespaced = all.kubectl.filter((argv) => argv[0] === '-n')
  assert.ok(namespaced.length > 0, all.describe())
  for (const argv of namespaced) assert.equal(argv[1], 'caller-namespace', argv.join(' '))
  // ROLLOUT_TIMEOUT: both rollout waits used the caller's.
  const waits = all.kubectl.filter((argv) => argv.includes('status'))
  assert.equal(waits.length, 2, all.describe())
  for (const argv of waits) assert.equal(argv.at(-1), '--timeout=7s')
  // Names only deploy.env set still apply, and an exported EMPTY LB_ADDRESS did
  // not erase the file's value.
  assert.match(stream, /^\s*- host: app\.example\.test$/m)
  assert.match(all.stdout, /--resolve app\.example\.test:80:lb\.example\.test /)
  assertNoOutsideParty(all)

  // Exported EMPTY image repositories do not count as set: deploy.env's stand.
  const empty = run({ IMAGE_REPO: '', API_IMAGE_REPO: '' })
  assert.equal(empty.status, 0, empty.describe())
  assertPinned(empty, 'file.example.test/joi/web:v0.0.0-caller', 'file.example.test/joi/api:v0.0.0-caller')
  assertNoOutsideParty(empty)
})

// ---------------------------------------------------------------------------
// SUB-008: the registry path pulls both images on the node before applying
// ---------------------------------------------------------------------------

const API_REF = `${API_REPO}:${TEST_TAG}`
const WEB_REF = `${WEB_REPO}:${TEST_TAG}`
const callsOf = (run, who) => run.events.filter((e) => e.who === who).map((e) => e.argv)

// The two kubectl calls that may precede a refusal: the node preflight and the
// generation reads. Neither changes anything in the cluster.
function isRead(argv) {
  const a = argv[0] === '-n' ? argv.slice(2) : argv
  const nodes = a.join(' ') === 'get nodes -o name'
  const generation = a.length === 5 && a[0] === 'get' && a[1] === 'deploy' && a[4] === 'jsonpath={.metadata.generation}'
  return nodes || generation
}

test('STORY-119 SUB-008: registry apply pulls the API image, then the web image, on the node before the first apply', (t) => {
  const run = runDeploy(t, { deployEnv: SINGLE_HOST_ENV })
  assert.equal(run.status, 0, run.describe())
  assert.deepEqual(callsOf(run, 'pull'), [[API_REF], [WEB_REF]])
  const lastPull = run.events.findLastIndex((e) => e.who === 'pull')
  const firstApply = run.events.findIndex((e) => e.who === 'kubectl' && e.argv.includes('apply'))
  assert.ok(firstApply > lastPull, `the first apply (event ${firstApply}) came before the last pull (event ${lastPull})`)
  // Two good pulls, and the rest of the flow is what it was.
  assert.equal(run.applied.length, 3, 'namespace, runtime Secret, workloads')
  assertPinned(run, WEB_REF, API_REF)
  assertNoOutsideParty(run)
})

test('STORY-119 SUB-008: a pull that fails stops apply before any object changes, and names the reference', (t) => {
  for (const [failing, pulled] of [
    [API_REF, [[API_REF]]],
    [WEB_REF, [[API_REF], [WEB_REF]]],
  ]) {
    const run = runDeploy(t, { deployEnv: SINGLE_HOST_ENV, env: { STUB_PULL_FAIL: failing } })
    assert.notEqual(run.status, 0, run.describe())
    assert.equal(run.signal, null, run.describe())
    assert.deepEqual(callsOf(run, 'pull'), pulled)
    assert.match(run.stderr, new RegExp(`could not pull ${escapeRe(failing)} `))
    assert.match(run.stderr, /must be public/)
    assert.match(run.stderr, /pull credentials/)
    // Nothing was applied: no namespace, no Secret, no workloads, no rollout.
    assert.deepEqual(run.applied, [])
    assert.ok(!existsSync(join(run.box.state, 'secret-input.env')), 'the runtime Secret was built')
    assert.deepEqual(
      run.kubectl.filter((argv) => !isRead(argv)),
      [],
      'kubectl was asked for something other than a read before the refusal',
    )
    assertNoOutsideParty(run)
  }
})

test('STORY-119 SUB-008: PREPULL=0 from the caller skips the pre-pull with a warning, even over PREPULL=1 in deploy.env', (t) => {
  const run = runDeploy(t, { deployEnv: `${SINGLE_HOST_ENV}PREPULL=1\n`, env: { PREPULL: '0' } })
  assert.equal(run.status, 0, run.describe())
  assert.deepEqual(callsOf(run, 'pull'), [])
  assert.match(run.stderr, /WARNING: PREPULL=0: not pulling /)
  assertPinned(run, WEB_REF, API_REF)
  assertNoOutsideParty(run)
})

test('STORY-119 SUB-008: the default pull command is `sudo -n k3s crictl pull`; a PULL_CMD in deploy.env replaces it', (t) => {
  const byDefault = runDeploy(t, { deployEnv: SINGLE_HOST_ENV, env: { PULL_CMD: undefined } })
  assert.equal(byDefault.status, 0, byDefault.describe())
  assert.deepEqual(callsOf(byDefault, 'sudo'), [
    ['-n', 'k3s', 'crictl', 'pull', API_REF],
    ['-n', 'k3s', 'crictl', 'pull', WEB_REF],
  ])
  assertNoOutsideParty(byDefault)

  const fromFile = runDeploy(t, {
    deployEnv: (box) => `${SINGLE_HOST_ENV}PULL_CMD=${box.pull}\n`,
    env: { PULL_CMD: undefined },
  })
  assert.equal(fromFile.status, 0, fromFile.describe())
  assert.deepEqual(callsOf(fromFile, 'pull'), [[API_REF], [WEB_REF]])
  assert.deepEqual(callsOf(fromFile, 'sudo'), [])
  assertNoOutsideParty(fromFile)
})

test('STORY-119 SUB-008: PREPULL and PULL_CMD are in the Optional list the script prints as its help', (t) => {
  const run = runDeploy(t, { mode: '--help' })
  assert.equal(run.status, 0, run.describe())
  assert.match(run.stdout, /^\s+PREPULL\s+default 1\b/m)
  assert.match(run.stdout, /^\s+PULL_CMD\s+default "sudo -n k3s crictl pull"/m)
  assert.deepEqual(run.events, [], 'help reached a stub')
})

// ---------------------------------------------------------------------------
// SUB-009: with REMOTE set, node_exec reaches the node over `ssh -n`
// ---------------------------------------------------------------------------

// The two one-line definitions, exactly as the script has them.
function nodeFunctions() {
  const lines = readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter((l) => /^node_(exec|pipe)\(\) \{.*\}$/.test(l))
  assert.equal(lines.length, 2, 'node_exec and node_pipe are no longer one-line definitions; update this harness')
  return lines.join('\n')
}

test('STORY-119 SUB-009: node_exec makes exactly one `ssh -n <REMOTE> <command>` call; node_pipe keeps stdin and no -n; empty REMOTE stays local', (t) => {
  const box = sandbox(t)
  const harness = (remote) =>
    spawnSync(
      'bash',
      ['-c', 'set -euo pipefail; eval "$NODE_FUNCTIONS"; node_exec "printf exec-ran"; printf "pipe-payload\\n" | node_pipe "cat"'],
      {
        cwd: box.root,
        env: {
          PATH: `${box.bin}:${process.env.PATH}`,
          HOME: box.home,
          STUB_STATE_DIR: box.state,
          FAKE_SSH_HOST: FAKE_NODE,
          FAKE_SSH_MODE: 'record',
          REMOTE: remote,
          NODE_FUNCTIONS: nodeFunctions(),
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    )

  const remote = harness(FAKE_NODE)
  const remoteDescribe = `exit ${remote.status} signal ${remote.signal}\n${remote.stdout}\n${remote.stderr}`
  assert.equal(remote.status, 0, remoteDescribe)
  assert.deepEqual(
    parseEvents(box.state),
    [
      { who: 'ssh', argv: ['-n', FAKE_NODE, 'printf exec-ran'] },
      { who: 'ssh', argv: [FAKE_NODE, 'cat'] },
    ],
    remoteDescribe,
  )
  assert.equal(readFileSync(join(box.state, 'ssh-stdin.txt'), 'utf8'), 'pipe-payload\n')

  const local = harness('')
  assert.equal(local.status, 0, local.stderr)
  assert.equal(local.stdout, 'exec-ranpipe-payload\n')
  assert.equal(parseEvents(box.state).length, 2, 'an empty REMOTE went over ssh')
})

test('STORY-119 SUB-009: with REMOTE set in deploy.env, apply goes through ssh and completes the registry flow', (t) => {
  const run = runDeploy(t, {
    deployEnv: `REMOTE=${FAKE_NODE}\nAPP_HOST=app.example.test\n`,
    env: { FAKE_SSH_MODE: 'run' },
  })
  assert.equal(run.signal, null, run.describe())
  assert.equal(run.status, 0, run.describe())
  assertPinned(run, WEB_REF, API_REF)
  assert.deepEqual(callsOf(run, 'pull'), [[API_REF], [WEB_REF]])
  assertNoOutsideParty(run)

  const ssh = callsOf(run, 'ssh')
  assert.deepEqual(ssh[0], ['-n', FAKE_NODE, `${run.box.kubectl} get nodes -o name`])
  for (const argv of ssh) {
    const piped = argv.at(-1).endsWith('apply -f -')
    // node_pipe carries a stream on stdin and must not pass -n; everything else
    // is node_exec, which must.
    assert.deepEqual(argv.slice(0, -1), piped ? [FAKE_NODE] : ['-n', FAKE_NODE], argv.join(' '))
  }
  assert.equal(ssh.filter((argv) => argv[0] !== '-n').length, 3, 'namespace, runtime Secret and workloads are piped')
})

test('STORY-119 SUB-008: IMAGE_SOURCE=local keeps the node image-store check and does not pre-pull', (t) => {
  const local = (images) =>
    runDeploy(t, {
      deployEnv: `REMOTE=${FAKE_NODE}\nAPP_HOST=app.example.test\n`,
      env: { IMAGE_SOURCE: 'local', FAKE_SSH_MODE: 'run', STUB_LOCAL_IMAGES: images.join(' ') },
    })
  const lsCalls = (run) => callsOf(run, 'sudo').filter((argv) => argv.join(' ') === 'k3s ctr images ls -q')
  const pulls = (run) => [...callsOf(run, 'pull'), ...callsOf(run, 'sudo').filter((argv) => argv.includes('pull'))]

  const present = local([WEB_REF, API_REF])
  assert.equal(present.status, 0, present.describe())
  assert.equal(lsCalls(present).length, 2, 'one image-store check per image')
  assert.deepEqual(pulls(present), [], 'the local-build path pre-pulled')
  assertPinned(present, WEB_REF, API_REF)
  assertNoOutsideParty(present)

  const missing = local([WEB_REF])
  assert.notEqual(missing.status, 0, missing.describe())
  assert.match(missing.stderr, new RegExp(`${escapeRe(API_REF)} is not in ${escapeRe(FAKE_NODE)}'s image store`))
  assert.deepEqual(pulls(missing), [])
  assert.deepEqual(missing.applied, [])
  assertNoOutsideParty(missing)
})
