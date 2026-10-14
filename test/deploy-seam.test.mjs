// SPDX-License-Identifier: MIT
//
// The seam between the release workflow and the deploy script (STORY-119).
//
// test/image-workflow.test.mjs proves what deploy-to-prod SENDS: the command it
// hands to ssh, replayed against a stand-in that only records its environment.
// test/deploy-k3s.test.mjs proves what deploy/deploy-k3s.sh DOES with an
// environment the test gives it. A release goes through both, and neither file
// joins them. This one does:
//
//   runner   .github/workflows/image.yml is read with Ruby's YAML parser
//            (Psych). The meta step and the deploy-to-prod step run in bash, with
//            a fake git, fake secrets, a fake GITHUB_OUTPUT and a temporary
//            HOME. The runner's fake ssh skips ssh(1)'s options the way ssh does,
//            accepts no destination but deployer@deploy-target.invalid, and hands
//            the command it received to a bash started by `env -i` in a
//            temporary node HOME — the remote shell starts from the node user's
//            own environment, not the runner's. The deploy step's exit status is
//            therefore the remote run's.
//   node     HOME/joi-button holds copies of this repository's
//            deploy/deploy-k3s.sh and deploy/k8s/*.yaml and nothing else of it
//            (no server/, no node_modules, and never a deploy.env or runtime.env
//            from this checkout). Its deploy.env holds only the six keys the
//            production node's file holds, with fixture values. KUBECTL and
//            PULL_CMD are left at the script's defaults: a fake sudo first on the
//            node's PATH answers `sudo k3s kubectl ...` by handing it to a
//            kubectl stub, and `sudo -n k3s crictl pull <ref>` as a pull that
//            fails only for the reference a test names. ssh, kubectl, k3s,
//            crictl, ctr, docker, curl and wget on the node's PATH are tripwires,
//            and node is not on it, so the runtime Secret takes the script's
//            no-Node.js branch, as on a bare k3s node.
//
// Nothing here reaches GitHub, a registry, a cluster or a host. The only files
// of this repository it reads are the workflow, the deploy script and the
// manifests; every temporary directory is removed in a finally block.
//
//   node --test test/deploy-seam.test.mjs

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'image.yml')
const SCRIPT = join(REPO_ROOT, 'deploy', 'deploy-k3s.sh')
const MANIFEST_DIR = join(REPO_ROOT, 'deploy', 'k8s')

// The kubectl stub is a Node script started by its shebang, because node is
// deliberately absent from the node's PATH.
const NODE = process.execPath
const US = '\x1f'
const TAG = 'v9.9.9'
const SHORT_SHA = 'abc1234'
const OWNERS = ['TpMoonChefRyan', 'Another-Account']

// Fake secrets. A `.invalid` name never resolves, so even a real ssh reached by
// mistake would connect nowhere; the fake ssh refuses every other destination.
const FAKE_SECRETS = {
  PROD_SSH_KEY: 'not-a-key',
  PROD_SSH_HOST: 'deploy-target.invalid',
  PROD_SSH_USER: 'deployer',
  PROD_KNOWN_HOSTS: 'deploy-target.invalid ssh-ed25519 AAAAnot-a-host-key',
}
const FAKE_DEST = `${FAKE_SECRETS.PROD_SSH_USER}@${FAKE_SECRETS.PROD_SSH_HOST}`

// The production node's deploy.env holds these six keys and no others; the
// values are fixtures. APP_HOST is under `.test` rather than `.invalid` because
// deploy-k3s.sh refuses `.invalid` there: it is the manifests' placeholder TLD.
const NODE_DEPLOY_ENV = [
  'APP_HOST=joi.example.test',
  'TARGET_ADDR=192.0.2.10',
  'TLS_MODE=letsencrypt',
  'ACME_EMAIL=ops@example.test',
  'CERT_FILE=',
  'KEY_FILE=',
  '',
].join('\n')

// A node whose deploy.env still names the repositories from before the move,
// with a local image source and an older tag on top.
const STALE_DEPLOY_ENV = NODE_DEPLOY_ENV + [
  'IMAGE_REPO=ghcr.io/ryanlan-new/joi-button/web',
  'API_IMAGE_REPO=ghcr.io/ryanlan-new/joi-button/api',
  'IMAGE_SOURCE=local',
  'TAG=v2.7.4',
  '',
].join('\n')

// Real tools that must never run on the node. node is not among them: it must
// be ABSENT, not trapped, so that `command -v node` fails as on a bare node.
const NODE_TRIPWIRES = ['ssh', 'kubectl', 'k3s', 'crictl', 'ctr', 'docker', 'curl', 'wget']

// --- reading the workflow -----------------------------------------------------

function readWorkflow () {
  const r = spawnSync('ruby', [
    '-ryaml', '-rjson', '-e',
    'print JSON.generate(YAML.safe_load(File.read(ARGV[0], encoding: "UTF-8")))',
    WORKFLOW,
  ], { encoding: 'utf8' })
  if (r.error && r.error.code === 'ENOENT') return { workflow: null, parseError: null }
  if (r.status !== 0) return { workflow: null, parseError: `${r.stderr}` || `ruby exited ${r.status}` }
  return { workflow: JSON.parse(r.stdout), parseError: null }
}

const { workflow, parseError } = readWorkflow()
const skip = workflow === null && parseError === null &&
  'ruby is not on PATH, so image.yml cannot be read with a YAML parser, and every test in this file starts from it'

function parsed () {
  if (parseError !== null) assert.fail(`the YAML parser rejected image.yml:\n${parseError}`)
  return workflow
}

function stepWhere (job, predicate, what) {
  const hits = parsed().jobs[job].steps.filter(predicate)
  assert.equal(hits.length, 1, `expected exactly one ${what} step in ${job}`)
  return hits[0]
}
const runs = (needle) => (step) => typeof step.run === 'string' && step.run.includes(needle)
const metaStep = () => stepWhere('build-and-push', (step) => step.id === 'meta', 'meta')
const summaryStep = () => stepWhere('build-and-push', runs('GITHUB_STEP_SUMMARY'), 'job-summary')
const deployStep = () => stepWhere('deploy-to-prod', runs('deploy-k3s.sh'), 'deploy')

// --- what Actions does around a `run:` block -------------------------------------

// `${{ <context>.<property path> }}` lookups only. Anything else (a function
// call, an operator, a context this file does not model) throws, so a workflow
// edit the simulation cannot follow fails loudly instead of resolving to ''.
// A missing property renders as '', as it does in Actions.
function expand (text, contexts) {
  return String(text).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    if (!/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(expression)) {
      throw new Error(`unmodelled expression: ${expression}`)
    }
    const [root, ...path] = expression.split('.')
    if (!(root in contexts)) throw new Error(`unmodelled context: ${root}`)
    let value = contexts[root]
    for (const property of path) {
      const key = value !== null && typeof value === 'object'
        ? Object.keys(value).find((k) => k.toLowerCase() === property.toLowerCase())
        : undefined
      value = key === undefined ? undefined : value[key]
    }
    return value === undefined || value === null ? '' : String(value)
  })
}

// $GITHUB_OUTPUT: `name=value` lines and `name<<DELIMITER` ... `DELIMITER` blocks.
function parseGithubOutput (text) {
  const outputs = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '') continue
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i])
    if (heredoc) {
      const [, name, delimiter] = heredoc
      const body = []
      for (i++; i < lines.length && lines[i] !== delimiter; i++) body.push(lines[i])
      assert.ok(i < lines.length, `unterminated ${name}<<${delimiter} in GITHUB_OUTPUT`)
      outputs[name] = body.join('\n')
      continue
    }
    const eq = lines[i].indexOf('=')
    assert.ok(eq > 0, `unreadable GITHUB_OUTPUT line: ${lines[i]}`)
    outputs[lines[i].slice(0, eq)] = lines[i].slice(eq + 1)
  }
  return outputs
}

// --- doubles ------------------------------------------------------------------------

// Single-quote for a shell. The temporary paths never contain a quote (asserted
// in world()), but quoting keeps the stubs honest anyway.
const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`

// Every node-side double appends one line per call to events.log: its name,
// then its arguments, separated by the ASCII unit separator. The node's shell
// starts with an empty environment, so the log's path is written into each
// double instead of travelling in a variable. (The stubs avoid brace
// expansions: these are String.raw templates.)
const logFn = (w) => String.raw`STUB_EVENTS=${sq(join(w.state, 'events.log'))}
log_event() {
  local line="$1" a
  shift
  for a in "$@"; do line="$line"$'\037'"$a"; done
  printf '%s\n' "$line" >> "$STUB_EVENTS"
}`

const tripwire = (w) => String.raw`#!/usr/bin/env bash
${logFn(w)}
log_event tripwire "$(basename "$0")" "$@"
echo "tripwire: the real '$(basename "$0")' must never be reached from test/deploy-seam.test.mjs" >&2
exit 97
`

// sudo on the node answers the two defaults deploy-k3s.sh uses there and
// nothing else: KUBECTL "sudo k3s kubectl" goes to the kubectl stub, and
// PULL_CMD "sudo -n k3s crictl pull" is a pull that succeeds unless the
// reference is the one written to the pull-fail file. The real sudo is never
// reached.
const fakeSudo = (w) => String.raw`#!/usr/bin/env bash
${logFn(w)}
log_event sudo "$@"
if [ "$#" -ge 2 ] && [ "$1" = k3s ] && [ "$2" = kubectl ]; then
  shift 2
  exec ${sq(w.kubectl)} "$@"
fi
if [ "$#" = 5 ] && [ "$1" = -n ] && [ "$2" = k3s ] && [ "$3" = crictl ] && [ "$4" = pull ]; then
  log_event pull "$5"
  if [ -f ${sq(w.pullFail)} ] && [ "$5" = "$(cat ${sq(w.pullFail)})" ]; then
    echo "fake crictl: pulling image $5: not found" >&2
    exit 1
  fi
  echo "Image is up to date for $5"
  exit 0
fi
log_event tripwire sudo "$@"
echo "tripwire: 'sudo $*' is not a call this test expects; the real sudo is never reached" >&2
exit 97
`

// git on the node: deploy-to-prod fetches and checks out the tag. This copy has
// no repository to fetch into, and it already holds the files under test.
const fakeNodeGit = (w) => String.raw`#!/usr/bin/env bash
${logFn(w)}
log_event git "$@"
exit 0
`

// The kubectl stub: the same answers as test/deploy-k3s.test.mjs's stub of the
// same name, with its state directory written in and node named by its
// absolute path.
const fakeKubectl = (w) => String.raw`#!${NODE}
'use strict'
const fs = require('fs')
const path = require('path')
const state = ${JSON.stringify(w.state)}
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

// git on the runner: the meta step reads the short sha; nothing else is read.
const FAKE_RUNNER_GIT = `#!/bin/sh
if [ "$1" = rev-parse ]; then echo ${SHORT_SHA}; fi
exit 0
`

// ssh on the runner. It records its arguments, skips the options the way
// ssh(1) parses them, refuses every destination but the fixture one, and then
// runs the remote command as sshd would: in a shell started from the node
// user's own minimal environment, in the node's HOME, stdin closed.
const SSH_OPTIONS_WITH_ARGUMENT = 'BbcDEeFIiJLlmOopQRSWw'
const fakeRunnerSsh = (w) => String.raw`#!/usr/bin/env bash
printf '%s\0' "$@" > "$(mktemp ${sq(join(w.calls, 'call.XXXXXX'))})"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -[${SSH_OPTIONS_WITH_ARGUMENT}]) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
dest="$1"
shift
if [ "$dest" != ${sq(FAKE_DEST)} ]; then
  echo "fake ssh: refusing '$dest'; this test only ever names ${FAKE_DEST}" >&2
  exit 255
fi
cd ${sq(w.nodeHome)} || exit 255
exec /usr/bin/env -i ${nodeEnv(w).map(sq).join(' ')} bash -c "$*" < /dev/null
`

function writeExecutable (file, body) {
  writeFileSync(file, body)
  chmodSync(file, 0o755)
}

// The node user's environment as sshd would start it.
const nodeEnv = (w) => [
  `HOME=${w.nodeHome}`,
  `PATH=${w.nodePath}`,
  'USER=deployer',
  'LOGNAME=deployer',
  'SHELL=/bin/bash',
  `TMPDIR=${w.nodeTmp}`,
]

// Where each name resolves on a PATH; '' for a name that does not.
function resolve (PATH, names) {
  const r = spawnSync('sh', ['-c', 'for n in "$@"; do command -v "$n" || echo; done', 'sh', ...names], {
    env: { PATH },
    encoding: 'utf8',
  })
  return r.stdout.split('\n').slice(0, names.length)
}

// --- one world: a runner and a node ---------------------------------------------------

// Temporary throughout. The caller disposes of it in a finally block.
function world ({ deployEnv = NODE_DEPLOY_ENV } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'joi-deploy-seam-'))
  const w = {
    root,
    runner: join(root, 'runner'),
    runnerHome: join(root, 'runner', 'home'),
    runnerBin: join(root, 'runner', 'bin'),
    runnerTmp: join(root, 'runner', 'tmp'),
    calls: join(root, 'runner', 'ssh-calls'),
    nodeHome: join(root, 'node', 'home'),
    nodeBin: join(root, 'node', 'bin'),
    nodeTmp: join(root, 'node', 'tmp'),
    state: join(root, 'node', 'state'),
    kubectl: join(root, 'node', 'kubectl-stub'),
    pullFail: join(root, 'node', 'pull-fail'),
    steps: 0,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
  w.repo = join(w.nodeHome, 'joi-button')
  w.runnerPath = `${w.runnerBin}:/usr/bin:/bin`
  w.nodePath = `${w.nodeBin}:/usr/bin:/bin`
  try {
    // The paths travel inside shell command lines and a shebang.
    assert.doesNotMatch(root, /[\s'"\\]/, 'the temporary directory path must not contain blanks or quotes')
    assert.doesNotMatch(NODE, /\s/, 'the node binary path must not contain blanks: it is the kubectl stub\'s shebang')
    for (const dir of [w.runnerHome, w.runnerBin, w.runnerTmp, w.calls, w.nodeBin, w.nodeTmp, w.state]) {
      mkdirSync(dir, { recursive: true })
    }

    // The node's checkout: the deploy script and the manifests, copied.
    mkdirSync(join(w.repo, 'deploy', 'k8s'), { recursive: true })
    copyFileSync(SCRIPT, join(w.repo, 'deploy', 'deploy-k3s.sh'))
    chmodSync(join(w.repo, 'deploy', 'deploy-k3s.sh'), 0o755)
    const manifests = readdirSync(MANIFEST_DIR).filter((f) => /\.ya?ml$/.test(f))
    assert.ok(manifests.includes('backup-cronjob.yaml'), manifests.join(' '))
    for (const f of manifests) copyFileSync(join(MANIFEST_DIR, f), join(w.repo, 'deploy', 'k8s', f))
    writeFileSync(join(w.repo, 'deploy', 'deploy.env'), deployEnv)
    writeFileSync(join(w.repo, 'deploy', 'runtime.env'), 'JOI_SEAM_KEY=fixture-value\n')

    writeExecutable(w.kubectl, fakeKubectl(w))
    writeExecutable(join(w.nodeBin, 'sudo'), fakeSudo(w))
    writeExecutable(join(w.nodeBin, 'git'), fakeNodeGit(w))
    for (const name of NODE_TRIPWIRES) writeExecutable(join(w.nodeBin, name), tripwire(w))
    writeExecutable(join(w.runnerBin, 'git'), FAKE_RUNNER_GIT)
    writeExecutable(join(w.runnerBin, 'ssh'), fakeRunnerSsh(w))

    // Go no further unless each side finds what was put there for it.
    assert.deepEqual(resolve(w.runnerPath, ['ssh', 'git']), [join(w.runnerBin, 'ssh'), join(w.runnerBin, 'git')])
    const nodeNames = ['sudo', 'git', ...NODE_TRIPWIRES, 'node']
    assert.deepEqual(
      resolve(w.nodePath, nodeNames),
      [...nodeNames.slice(0, -1).map((name) => join(w.nodeBin, name)), ''],
      'on the node, the doubles must come first and node must not be found',
    )
  } catch (error) {
    w.dispose()
    throw error
  }
  return w
}

// `bash -e {0}` is how Actions runs a `run:` block that names no shell.
function runStep (w, step, contexts, extraEnv = {}) {
  const env = { PATH: w.runnerPath, HOME: w.runnerHome, TMPDIR: w.runnerTmp, ...extraEnv }
  for (const [name, value] of Object.entries(step.env ?? {})) env[name] = expand(value, contexts)
  const file = join(w.runner, `step-${++w.steps}.sh`)
  writeFileSync(file, expand(step.run, contexts))
  return spawnSync('bash', ['-e', file], { cwd: w.runner, env, encoding: 'utf8', timeout: 120_000 })
}

function report (r) {
  return `exit ${r.status} signal ${r.signal}\n--- stdout (tail)\n${(r.stdout ?? '').slice(-2000)}\n--- stderr (tail)\n${(r.stderr ?? '').slice(-2000)}`
}

// build-and-push: the meta step, then the job outputs deploy-to-prod reads.
function buildAndPush (w, { owner, ref }) {
  const githubOutput = join(w.runner, 'github-output')
  writeFileSync(githubOutput, '')
  const github = { repository_owner: owner, ref, ref_name: ref.replace(/^refs\/(heads|tags)\//, '') }
  const r = runStep(w, metaStep(), { github, inputs: {} }, { GITHUB_OUTPUT: githubOutput })
  assert.equal(r.status, 0, `the meta step failed:\n${report(r)}`)
  const meta = parseGithubOutput(readFileSync(githubOutput, 'utf8'))
  assert.equal(meta.image, `ghcr.io/${owner.toLowerCase()}/joi-button/web`)
  assert.equal(meta.api_image, `ghcr.io/${owner.toLowerCase()}/joi-button/api`)
  const outputs = {}
  for (const [name, value] of Object.entries(parsed().jobs['build-and-push'].outputs ?? {})) {
    outputs[name] = expand(value, { steps: { meta: { outputs: meta } } })
  }
  return { meta, outputs }
}

// deploy-to-prod's one step, as Actions would start it after build-and-push.
function deployToProd (w, { tag, outputs }) {
  const contexts = {
    github: { ref: `refs/tags/${tag}`, ref_name: tag },
    secrets: FAKE_SECRETS,
    needs: { 'build-and-push': { outputs } },
  }
  return runStep(w, deployStep(), contexts)
}

// The job summary of a build-and-push run, and the one command in its bash block.
function summaryCommand (w, meta) {
  const summaryFile = join(w.runner, 'step-summary.md')
  writeFileSync(summaryFile, '')
  const steps = {
    meta: { outputs: meta },
    build: { outputs: { digest: `sha256:${'a'.repeat(64)}` } },
    build_api: { outputs: { digest: `sha256:${'b'.repeat(64)}` } },
  }
  const r = runStep(w, summaryStep(), { steps }, { GITHUB_STEP_SUMMARY: summaryFile })
  assert.equal(r.status, 0, `the job-summary step failed:\n${report(r)}`)
  const block = /```bash\n(.*)\n```/.exec(readFileSync(summaryFile, 'utf8'))
  assert.ok(block, 'the summary carries a bash block')
  return block[1]
}

// An operator on the node, in HOME/joi-button, running a command as printed.
function onNode (w, command) {
  return spawnSync('/usr/bin/env', ['-i', ...nodeEnv(w), 'bash', '-c', command], {
    cwd: w.repo,
    encoding: 'utf8',
    timeout: 120_000,
  })
}

// --- what happened on the node --------------------------------------------------------

function sshCalls (w) {
  return readdirSync(w.calls)
    .map((file) => readFileSync(join(w.calls, file), 'utf8').split('\0').slice(0, -1))
}

function splitSsh (argv) {
  const withArgument = new Set([...SSH_OPTIONS_WITH_ARGUMENT].map((c) => `-${c}`))
  let i = 0
  while (i < argv.length && argv[i].startsWith('-')) i += withArgument.has(argv[i]) ? 2 : 1
  return { destination: argv[i], command: argv.slice(i + 1).join(' ') }
}

function nodeSide (w) {
  const file = join(w.state, 'events.log')
  const events = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      const [who, ...argv] = line.split(US)
      return { who, argv }
    })
    : []
  const applied = readdirSync(w.state)
    .filter((f) => /^apply-\d+\.yaml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => readFileSync(join(w.state, f), 'utf8'))
  return {
    events,
    applied,
    pulls: events.filter((e) => e.who === 'pull').map((e) => e.argv[0]),
    kubectl: events.filter((e) => e.who === 'kubectl').map((e) => e.argv),
    tripped: events.filter((e) => e.who === 'tripwire'),
    secretBuilt: existsSync(join(w.state, 'secret-input.env')),
  }
}

// The image lines of each rendered manifest in a stream, keyed by file name.
function imagesByManifest (stream) {
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

// The two kubectl calls that may precede a refusal: the node preflight and the
// generation reads. Neither changes anything in the cluster.
function isRead (argv) {
  const a = argv[0] === '-n' ? argv.slice(2) : argv
  const nodes = a.join(' ') === 'get nodes -o name'
  const generation = a.length === 5 && a[0] === 'get' && a[1] === 'deploy' && a[4] === 'jsonpath={.metadata.generation}'
  return nodes || generation
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Both images pulled on the node, the API first, before the first apply; the
// web Deployment, the API Deployment and the backup CronJob pinned to them;
// no tripwire reached.
function assertShipped (w, output, { webRef, apiRef }) {
  const node = nodeSide(w)
  assert.deepEqual(node.tripped, [], `a tripwire was reached\n${output}`)
  assert.deepEqual(node.pulls, [apiRef, webRef], `the pre-pulls\n${output}`)
  const lastPull = node.events.findLastIndex((e) => e.who === 'pull')
  const firstApply = node.events.findIndex((e) => e.who === 'kubectl' && e.argv.includes('apply'))
  assert.ok(firstApply > lastPull, `the first apply (event ${firstApply}) did not come after the last pull (event ${lastPull})\n${output}`)
  const stream = node.applied.find((s) => /^# rendered from .*web-deployment\.yaml$/m.test(s))
  assert.ok(stream, `no applied stream carried the workload manifests\n${output}`)
  const images = imagesByManifest(stream)
  assert.deepEqual(images['web-deployment.yaml'], [webRef], 'web Deployment image')
  assert.deepEqual(images['api-deployment.yaml'], [apiRef], 'api Deployment image')
  assert.deepEqual(images['backup-cronjob.yaml'], [apiRef], 'backup CronJob image')
  assert.doesNotMatch(stream, /replace-me/, 'the applied workload stream still carries a placeholder')
  // Without node on the PATH, the runtime Secret came from the script's
  // no-Node.js branch, as on a bare k3s node.
  assert.ok(node.secretBuilt, `the runtime Secret was not built\n${output}`)
}

// A tag push, end to end: build-and-push, then deploy-to-prod into a node.
function shipsTheTag (owner, deployEnv) {
  const w = world({ deployEnv })
  try {
    const pushed = buildAndPush(w, { owner, ref: `refs/tags/${TAG}` })
    const webRef = `${pushed.meta.image}:${TAG}`
    const apiRef = `${pushed.meta.api_image}:${TAG}`
    assert.ok(pushed.meta.tags.split('\n').includes(webRef), `${webRef} is not among the pushed tags:\n${pushed.meta.tags}`)
    assert.ok(pushed.meta.api_tags.split('\n').includes(apiRef), `${apiRef} is not among the pushed tags:\n${pushed.meta.api_tags}`)

    const r = deployToProd(w, { tag: TAG, outputs: pushed.outputs })
    const output = report(r)
    assert.equal(r.status, 0, output)
    assert.match(r.stdout, new RegExp(`^Deployed ${escapeRe(TAG)}\\.$`, 'm'), output)
    const calls = sshCalls(w)
    assert.equal(calls.length, 1, 'deploy-to-prod calls ssh exactly once')
    assert.equal(splitSsh(calls[0]).destination, FAKE_DEST)
    assertShipped(w, output, { webRef, apiRef })
  } finally {
    w.dispose()
  }
}

// --- tests --------------------------------------------------------------------------

for (const owner of OWNERS) {
  test(`STORY-119 SUB-012: a ${TAG} tag pushed under ${owner} reaches the real deploy-k3s.sh on a six-key node, which pre-pulls and pins exactly what build-and-push pushed`, { skip }, () => {
    shipsTheTag(owner, NODE_DEPLOY_ENV)
  })
}

for (const owner of OWNERS) {
  test(`STORY-119 SUB-012: under ${owner}, a node deploy.env naming the old repositories, IMAGE_SOURCE=local and TAG=v2.7.4 loses to what CI passes`, { skip }, () => {
    shipsTheTag(owner, STALE_DEPLOY_ENV)
  })
}

test('STORY-119 SUB-012: when the node cannot pull the API image, or the web image, deploy-to-prod fails before anything is applied and names that image', { skip }, () => {
  for (const failing of ['api', 'web']) {
    const w = world()
    try {
      const pushed = buildAndPush(w, { owner: OWNERS[0], ref: `refs/tags/${TAG}` })
      const webRef = `${pushed.meta.image}:${TAG}`
      const apiRef = `${pushed.meta.api_image}:${TAG}`
      const failingRef = failing === 'api' ? apiRef : webRef
      writeFileSync(w.pullFail, failingRef)

      const r = deployToProd(w, { tag: TAG, outputs: pushed.outputs })
      const output = `${failing} pull fails\n${report(r)}`
      assert.notEqual(r.status, 0, output)
      assert.equal(r.signal, null, output)
      assert.doesNotMatch(r.stdout, /^Deployed /m, output)
      assert.match(`${r.stdout}${r.stderr}`, new RegExp(`could not pull ${escapeRe(failingRef)} `), output)

      const node = nodeSide(w)
      assert.deepEqual(node.pulls, failing === 'api' ? [apiRef] : [apiRef, webRef], output)
      assert.deepEqual(node.applied, [], `something was applied\n${output}`)
      assert.equal(node.secretBuilt, false, `the runtime Secret was built\n${output}`)
      assert.deepEqual(
        node.kubectl.filter((argv) => !isRead(argv)),
        [],
        `kubectl was asked for something other than a read before the refusal\n${output}`,
      )
      assert.deepEqual(node.tripped, [], `a tripwire was reached\n${output}`)
    } finally {
      w.dispose()
    }
  }
})

test("STORY-119 SUB-012: the job summary's manual deploy command for a main push, run as printed in HOME/joi-button on that node, pre-pulls both images and pins all three to <repository>:<short sha>", { skip }, () => {
  for (const owner of OWNERS) {
    const w = world()
    try {
      const pushed = buildAndPush(w, { owner, ref: 'refs/heads/main' })
      const webRef = `${pushed.meta.image}:${SHORT_SHA}`
      const apiRef = `${pushed.meta.api_image}:${SHORT_SHA}`
      assert.ok(pushed.meta.tags.split('\n').includes(webRef), pushed.meta.tags)
      assert.ok(pushed.meta.api_tags.split('\n').includes(apiRef), pushed.meta.api_tags)

      const command = summaryCommand(w, pushed.meta)
      const r = onNode(w, command)
      const output = `${owner}: ${command}\n${report(r)}`
      assert.equal(r.status, 0, output)
      assert.equal(r.signal, null, output)
      assertShipped(w, output, { webRef, apiRef })
    } finally {
      w.dispose()
    }
  }
})
