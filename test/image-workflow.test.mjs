// SPDX-License-Identifier: MIT
//
// A tag deploy pulls exactly what the same run pushed (STORY-119).
//
// build-and-push computes the two image repositories once, from the repository
// owner, and pushes <repository>:<tag>. deploy-to-prod used to hand only TAG to
// deploy/deploy-k3s.sh, which then filled in a repository path written into the
// script. When the repository moved to another account, CI pushed to the new
// path while a tag deploy would have pulled that version from the old one,
// where it does not exist — and the API Deployment, being Recreate, stops the
// running pod before the pull fails.
//
// Nothing here reaches GitHub, a registry or a host. The workflow is read with
// a YAML parser (Psych, Ruby's standard YAML library); its `run:` blocks are
// executed by bash in a temporary directory with HOME pointed there; `ssh` and
// `git` are test doubles placed first on PATH, and the fake ssh only records
// its arguments. The remote command it received is then replayed under a second
// temporary HOME against a stand-in deploy/deploy-k3s.sh that records the
// environment it was started with, so the assertions are about what
// deploy-k3s.sh RECEIVES, not about a substring that merely looks right.
//
//   node --test test/image-workflow.test.mjs

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOW = fileURLToPath(new URL('../.github/workflows/image.yml', import.meta.url))

// The shape deploy-to-prod must accept, verbatim from the Subtask's acceptance
// criteria. The shell's own check is compared against these case by case.
const REPO_SHAPE = {
  web: /^ghcr\.io\/[a-z0-9]([a-z0-9-]*[a-z0-9])?\/joi-button\/web$/,
  api: /^ghcr\.io\/[a-z0-9]([a-z0-9-]*[a-z0-9])?\/joi-button\/api$/,
}

// The tag shape deploy-to-prod must accept, verbatim from STORY-119 SUB-013's
// acceptance criteria; the shell's own check is compared against it case by case.
// Without the m flag, `$` here matches only at the very end, so a trailing
// newline does not pass.
const TAG_SHAPE = /^v[0-9]+\.[0-9]+\.[0-9]+$/

// Fake secrets. The fake ssh never reads them, and a `.invalid` name never
// resolves, so even a real ssh reached by mistake would connect nowhere.
const FAKE_SECRETS = {
  PROD_SSH_KEY: 'not-a-key',
  PROD_SSH_HOST: 'deploy-target.invalid',
  PROD_SSH_USER: 'deployer',
  PROD_KNOWN_HOSTS: 'deploy-target.invalid ssh-ed25519 AAAAnot-a-host-key',
}
const FAKE_SSH_ENV = {
  SSH_KEY: FAKE_SECRETS.PROD_SSH_KEY,
  SSH_HOST: FAKE_SECRETS.PROD_SSH_HOST,
  SSH_USER: FAKE_SECRETS.PROD_SSH_USER,
  KNOWN_HOSTS: FAKE_SECRETS.PROD_KNOWN_HOSTS,
}
const WEB = 'ghcr.io/tpmoonchefryan/joi-button/web'
const API = 'ghcr.io/tpmoonchefryan/joi-button/api'
const SHORT_SHA = 'abc1234'

const FAKE_SSH = `#!/bin/sh
# Test double: record argv, NUL-separated, one file per call. Connects nowhere.
printf '%s\\0' "$@" > "$(mktemp "\${FAKE_SSH_CALLS:?}/call.XXXXXX")"
`

const FAKE_GIT = `#!/bin/sh
# Test double: no repository is read or written.
if [ "$1" = rev-parse ]; then echo ${SHORT_SHA}; fi
exit 0
`

// Stand-in for deploy/deploy-k3s.sh on the node: record what it was started with.
const DEPLOY_K3S_STAND_IN = `env > "$HOME/deploy-k3s.env"
printf '%s\\n' "$@" > "$HOME/deploy-k3s.argv"
`

// --- reading the workflow ---------------------------------------------------

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
  'ruby is not on PATH, so image.yml cannot be read with a YAML parser'

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

// --- what Actions does around a `run:` block ----------------------------------

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

// $GITHUB_OUTPUT: `name=value` lines and `name<<DELIMITER` … `DELIMITER` blocks.
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

// --- sandbox --------------------------------------------------------------------

function sandbox () {
  const dir = mkdtempSync(join(tmpdir(), 'image-workflow-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 })
  writeFileSync(join(bin, 'git'), FAKE_GIT, { mode: 0o755 })
  const PATH = `${bin}:/usr/bin:/bin`
  const box = { dir, PATH, dispose: () => rmSync(dir, { recursive: true, force: true }) }
  // Go no further unless the doubles are what the scripts will find.
  const found = spawnSync('sh', ['-c', 'command -v ssh; command -v git'], { env: { PATH }, encoding: 'utf8' })
  if (found.stdout !== `${join(bin, 'ssh')}\n${join(bin, 'git')}\n`) {
    box.dispose()
    assert.fail(`the fake ssh and git are not first on PATH:\n${found.stdout}${found.stderr}`)
  }
  return box
}

// A fresh runner: its own HOME (the deploy step writes ~/.ssh) and its own
// record of ssh calls.
function runner (box) {
  const dir = mkdtempSync(join(box.dir, 'runner-'))
  const home = join(dir, 'home')
  const calls = join(dir, 'ssh-calls')
  mkdirSync(home)
  mkdirSync(calls)
  return { dir, home, calls, env: { PATH: box.PATH, HOME: home, FAKE_SSH_CALLS: calls } }
}

// `bash -e {0}` is how Actions runs a `run:` block that names no shell.
function runBash (dir, name, body, env) {
  const file = join(dir, `${name}.sh`)
  writeFileSync(file, body)
  return spawnSync('bash', ['-e', file], { cwd: dir, env, encoding: 'utf8' })
}

function runStep (step, contexts, run, runnerEnv = {}) {
  const env = { ...run.env, ...runnerEnv }
  for (const [name, value] of Object.entries(step.env ?? {})) env[name] = expand(value, contexts)
  return runBash(run.dir, step.id ?? 'step', expand(step.run, contexts), env)
}

function sshCalls (run) {
  return readdirSync(run.calls)
    .map((file) => readFileSync(join(run.calls, file), 'utf8').split('\0').slice(0, -1))
}

// ssh(1): these options take a separate argument. The first other word is the
// destination; every word after it is joined with spaces into the command the
// remote shell runs.
const SSH_OPTIONS_WITH_ARGUMENT = new Set([...'BbcDEeFIiJLlmOopQRSWw'].map((c) => `-${c}`))
function splitSsh (argv) {
  let i = 0
  while (i < argv.length && argv[i].startsWith('-')) i += SSH_OPTIONS_WITH_ARGUMENT.has(argv[i]) ? 2 : 1
  return { destination: argv[i], command: argv.slice(i + 1).join(' ') }
}

// The node side: the remote command runs in the node user's shell, which starts
// from the node's own environment. Nothing in the runner step's env reaches
// deploy-k3s.sh unless the command itself carries it.
function replayOnNode (box, command) {
  const home = mkdtempSync(join(box.dir, 'node-'))
  mkdirSync(join(home, 'joi-button', 'deploy'), { recursive: true })
  writeFileSync(join(home, 'joi-button', 'deploy', 'deploy-k3s.sh'), DEPLOY_K3S_STAND_IN)
  const r = spawnSync('bash', ['-c', command], { env: { HOME: home, PATH: box.PATH }, encoding: 'utf8' })
  assert.equal(r.status, 0, `the remote command failed on the stand-in node:\n${r.stdout}${r.stderr}`)
  const env = {}
  for (const line of readFileSync(join(home, 'deploy-k3s.env'), 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  const argv = readFileSync(join(home, 'deploy-k3s.argv'), 'utf8').split('\n').filter(Boolean)
  return { env, argv }
}

// --- the two jobs -------------------------------------------------------------

function buildAndPush (box, { owner, ref }) {
  const run = runner(box)
  const githubOutput = join(run.dir, 'github-output')
  writeFileSync(githubOutput, '')
  const github = { repository_owner: owner, ref, ref_name: ref.replace(/^refs\/(heads|tags)\//, '') }
  const r = runStep(metaStep(), { github, inputs: {} }, run, { GITHUB_OUTPUT: githubOutput })
  assert.equal(r.status, 0, `the meta step failed:\n${r.stdout}${r.stderr}`)
  const meta = parseGithubOutput(readFileSync(githubOutput, 'utf8'))
  const outputs = {}
  for (const [name, value] of Object.entries(parsed().jobs['build-and-push'].outputs ?? {})) {
    outputs[name] = expand(value, { steps: { meta: { outputs: meta } } })
  }
  return { meta, outputs }
}

// deploy-to-prod as Actions would start it after build-and-push.
function deployToProd (box, { tag, needs }) {
  const run = runner(box)
  const contexts = {
    github: { ref: `refs/tags/${tag}`, ref_name: tag },
    secrets: FAKE_SECRETS,
    needs: { 'build-and-push': { outputs: needs } },
  }
  const r = runStep(deployStep(), contexts, run)
  return { r, run, calls: sshCalls(run) }
}

// deploy-to-prod's run script alone, with its environment given directly.
function deployScript (box, env) {
  const run = runner(box)
  const r = runBash(run.dir, 'deploy', expand(deployStep().run, {}), { ...run.env, ...env })
  return { r, run, calls: sshCalls(run) }
}

const words = (text) => text.split(/\s+/)
const assigns = (text, name, value) =>
  words(text).includes(`${name}=${value}`) || words(text).includes(`${name}='${value}'`)
const errorNaming = (name) => new RegExp(`::error::.*[^A-Z_]${name}\\b`)

// --- tests --------------------------------------------------------------------

test('image.yml reads as YAML; build-and-push exports image and api_image; triggers, permissions, concurrency, needs and if are as before', { skip }, () => {
  const wf = parsed()
  const outputs = wf.jobs['build-and-push'].outputs ?? {}
  assert.equal(outputs.image, '${{ steps.meta.outputs.image }}')
  assert.equal(outputs.api_image, '${{ steps.meta.outputs.api_image }}')

  const deploy = wf.jobs['deploy-to-prod']
  assert.equal(deploy.needs, 'build-and-push')
  assert.equal(deploy.if, "startsWith(github.ref, 'refs/tags/v')")
  assert.equal(deploy.permissions, undefined)
  assert.equal(deploy.concurrency, undefined)

  // YAML 1.1 (Psych) reads the bare key `on` as the boolean true.
  const on = wf.on ?? wf.true
  assert.deepEqual(Object.keys(on), ['workflow_dispatch', 'push'])
  assert.deepEqual(on.push, { branches: ['main'], tags: ['v*.*.*'] })
  assert.deepEqual(Object.keys(on.workflow_dispatch.inputs), ['tag'])
  assert.deepEqual(wf.permissions, { contents: 'read', packages: 'write' })
  assert.deepEqual(wf.concurrency, { group: 'image-${{ github.ref }}', 'cancel-in-progress': false })
})

test('the workflow names no image owner literally; the path comes from the repository owner', () => {
  const offending = readFileSync(WORKFLOW, 'utf8').split('\n')
    .map((line, index) => `${index + 1}: ${line.trim()}`)
    .filter((line) => /ghcr\.io\/[A-Za-z0-9-]+\/|ryanlan-new/.test(line))
  assert.deepEqual(offending, [])
})

test('deploy-to-prod takes both repositories from build-and-push and computes none of its own', { skip }, () => {
  const step = deployStep()
  assert.equal(step.env?.IMAGE_REPO, '${{ needs.build-and-push.outputs.image }}')
  assert.equal(step.env?.API_IMAGE_REPO, '${{ needs.build-and-push.outputs.api_image }}')
  const job = JSON.stringify(parsed().jobs['deploy-to-prod'])
  assert.equal(job.match(/repository_owner|github\.repository\b/)?.[0], undefined)
  assert.equal(step.run.match(/^\s*(export\s+)?(API_)?IMAGE_REPO=.*$/m)?.[0], undefined)
})

for (const owner of ['TpMoonChefRyan', 'Another-Account']) {
  test(`a v9.9.9 tag pushed under ${owner}: deploy-k3s.sh receives the repositories build-and-push pushed it to`, { skip }, () => {
    const box = sandbox()
    try {
      const pushed = buildAndPush(box, { owner, ref: 'refs/tags/v9.9.9' })
      assert.equal(pushed.meta.image, `ghcr.io/${owner.toLowerCase()}/joi-button/web`)
      assert.equal(pushed.meta.api_image, `ghcr.io/${owner.toLowerCase()}/joi-button/api`)
      assert.equal(pushed.outputs.image, pushed.meta.image)
      assert.equal(pushed.outputs.api_image, pushed.meta.api_image)

      const { r, calls } = deployToProd(box, { tag: 'v9.9.9', needs: pushed.outputs })
      assert.equal(r.status, 0, `deploy-to-prod failed:\n${r.stdout}${r.stderr}`)
      assert.equal(calls.length, 1, 'deploy-to-prod calls ssh exactly once')
      const { destination, command } = splitSsh(calls[0])
      assert.equal(destination, 'deployer@deploy-target.invalid')

      const received = replayOnNode(box, command)
      assert.deepEqual(received.argv, ['apply'])
      assert.equal(received.env.IMAGE_SOURCE, 'registry')
      assert.equal(received.env.TAG, 'v9.9.9')
      assert.equal(received.env.IMAGE_REPO, pushed.meta.image)
      assert.equal(received.env.API_IMAGE_REPO, pushed.meta.api_image)
      // deploy-k3s.sh pins <repository>:<TAG>; both must be tags this run pushed.
      assert.ok(pushed.meta.tags.split('\n').includes(`${received.env.IMAGE_REPO}:${received.env.TAG}`))
      assert.ok(pushed.meta.api_tags.split('\n').includes(`${received.env.API_IMAGE_REPO}:${received.env.TAG}`))
    } finally {
      box.dispose()
    }
  })
}

test('deploy-to-prod run script with a fake ssh: both repositories arrive single-quoted; a shell metacharacter never reaches ssh', { skip }, () => {
  const box = sandbox()
  try {
    const env = { ...FAKE_SSH_ENV, DEPLOY_TAG: 'v9.9.9', IMAGE_REPO: WEB, API_IMAGE_REPO: API }
    const good = deployScript(box, env)
    assert.equal(good.r.status, 0, `${good.r.stdout}${good.r.stderr}`)
    assert.equal(good.calls.length, 1)
    const { command } = splitSsh(good.calls[0])
    assert.ok(words(command).includes(`IMAGE_REPO='${WEB}'`), command)
    assert.ok(words(command).includes(`API_IMAGE_REPO='${API}'`), command)
    assert.ok(existsSync(join(good.run.home, '.ssh', 'id_deploy')), 'the key file lands in the temporary HOME')

    const bad = deployScript(box, { ...env, IMAGE_REPO: 'ghcr.io/x/joi-button/web;id' })
    assert.notEqual(bad.r.status, 0)
    assert.equal(bad.calls.length, 0, 'ssh was called with an unvalidated IMAGE_REPO')
    assert.match(bad.r.stdout, errorNaming('IMAGE_REPO'))
  } finally {
    box.dispose()
  }
})

test('deploy-to-prod refuses, before ssh and naming the variable, any repository that is not ghcr.io/<owner>/joi-button/{web,api}', { skip }, () => {
  const candidates = (leaf, other) => [
    `ghcr.io/tpmoonchefryan/joi-button/${leaf}`,
    `ghcr.io/a/joi-button/${leaf}`,
    `ghcr.io/0/joi-button/${leaf}`,
    `ghcr.io/a--b/joi-button/${leaf}`,
    `ghcr.io/x1-2y/joi-button/${leaf}`,
    '',
    `ghcr.io/x/joi-button/${leaf};id`,
    `ghcr.io/x/joi-button/${leaf}'; id; '`,
    `ghcr.io/$(id)/joi-button/${leaf}`,
    `ghcr.io/\`id\`/joi-button/${leaf}`,
    `ghcr.io/X/joi-button/${leaf}`,
    `ghcr.io/-x/joi-button/${leaf}`,
    `ghcr.io/x-/joi-button/${leaf}`,
    `ghcr.io//joi-button/${leaf}`,
    `ghcr.io/x/y/joi-button/${leaf}`,
    `ghcr.io/x/joi-button/${leaf}/joi-button/${leaf}`,
    `ghcr.io/x/joi-button/${leaf}:v9.9.9`,
    `ghcr.io/x/joi-button/${other}`,
    `docker.io/x/joi-button/${leaf}`,
    `ghcrXio/x/joi-button/${leaf}`,
    ` ghcr.io/x/joi-button/${leaf}`,
    `ghcr.io/x/joi-button/${leaf}\n`,
    `ghcr.io/x\n/joi-button/${leaf}`,
    `ghcr.io/x y/joi-button/${leaf}`,
    `ghcr.io/ä/joi-button/${leaf}`,
  ]
  const box = sandbox()
  try {
    for (const [name, leaf, other] of [['IMAGE_REPO', 'web', 'api'], ['API_IMAGE_REPO', 'api', 'web']]) {
      const values = candidates(leaf, other)
      assert.ok(values.filter((v) => REPO_SHAPE[leaf].test(v)).length >= 5, 'the table keeps its accepted cases')
      assert.ok(values.filter((v) => !REPO_SHAPE[leaf].test(v)).length >= 15, 'the table keeps its refused cases')
      for (const value of values) {
        const label = `${name}=${JSON.stringify(value)}`
        const { r, calls } = deployScript(box, {
          ...FAKE_SSH_ENV, DEPLOY_TAG: 'v9.9.9', IMAGE_REPO: WEB, API_IMAGE_REPO: API, [name]: value,
        })
        if (REPO_SHAPE[leaf].test(value)) {
          assert.equal(r.status, 0, `${label} should deploy:\n${r.stdout}${r.stderr}`)
          assert.equal(calls.length, 1, label)
          assert.ok(words(splitSsh(calls[0]).command).includes(`${name}='${value}'`), label)
        } else {
          assert.notEqual(r.status, 0, `${label} should be refused`)
          assert.equal(calls.length, 0, `${label} reached ssh`)
          assert.match(r.stdout, errorNaming(name), label)
        }
      }
    }
  } finally {
    box.dispose()
  }
})

test('deploy-to-prod refuses, before the key file is written or ssh runs and naming DEPLOY_TAG, any tag that is not exactly v<digits>.<digits>.<digits>', { skip }, () => {
  const values = [
    'v9.9.9',
    'v10.20.30',
    'v0.0.0',
    'v2.7.6',
    'v123.4567.89',
    '',
    "v1.2.3';id;'",
    'v1.2.3-rc.1',
    'v1.2.3+build.5',
    'v1.2',
    'v1..2.3',
    'v1.2.3.4',
    'v.1.2.3',
    'v1.2.3.',
    'v',
    '1.2.3',
    'V1.2.3',
    'vv1.2.3',
    'v1.2.x',
    ' v1.2.3',
    'v1.2.3 ',
    'v1.2 .3',
    'v1.2.3\t',
    'v1.2.3\n',
    'v1.2.3\nid',
    'v1.2.3;id',
    'v1.2.3$(id)',
    'v1.2.3`id`',
    'v1.2.٣', // ARABIC-INDIC DIGIT THREE: a digit, but not one of 0123456789
    'v1.2.³', // SUPERSCRIPT THREE
  ]
  assert.ok(values.filter((v) => TAG_SHAPE.test(v)).length >= 3, 'the table keeps its accepted cases')
  assert.ok(values.filter((v) => !TAG_SHAPE.test(v)).length >= 8, 'the table keeps its refused cases')
  const box = sandbox()
  try {
    for (const value of values) {
      const label = `DEPLOY_TAG=${JSON.stringify(value)}`
      const { r, run, calls } = deployScript(box, {
        ...FAKE_SSH_ENV, DEPLOY_TAG: value, IMAGE_REPO: WEB, API_IMAGE_REPO: API,
      })
      const keyWritten = existsSync(join(run.home, '.ssh', 'id_deploy'))
      if (TAG_SHAPE.test(value)) {
        // As before the check was tightened: one ssh call, which checks out the
        // tag and starts deploy-k3s.sh pinned to it.
        assert.equal(r.status, 0, `${label} should deploy:\n${r.stdout}${r.stderr}`)
        assert.ok(keyWritten, `${label}: no key file`)
        assert.equal(calls.length, 1, label)
        const { command } = splitSsh(calls[0])
        assert.ok(command.includes(`checkout --quiet --force 'refs/tags/${value}';`), `${label}: ${command}`)
        const received = replayOnNode(box, command)
        assert.deepEqual(received.argv, ['apply'], label)
        assert.equal(received.env.TAG, value, label)
        assert.equal(received.env.IMAGE_SOURCE, 'registry', label)
      } else {
        assert.notEqual(r.status, 0, `${label} should be refused`)
        assert.match(r.stdout, errorNaming('DEPLOY_TAG'), label)
        assert.equal(keyWritten, false, `${label}: the key file was written before the refusal`)
        assert.equal(calls.length, 0, `${label} reached ssh`)
      }
    }
  } finally {
    box.dispose()
  }
})

test("the job summary's manual deploy command names the repositories this run pushed to", { skip }, () => {
  const box = sandbox()
  try {
    const pushed = buildAndPush(box, { owner: 'TpMoonChefRyan', ref: 'refs/heads/main' })
    const run = runner(box)
    const summaryFile = join(run.dir, 'step-summary.md')
    writeFileSync(summaryFile, '')
    const steps = {
      meta: { outputs: pushed.meta },
      build: { outputs: { digest: `sha256:${'a'.repeat(64)}` } },
      build_api: { outputs: { digest: `sha256:${'b'.repeat(64)}` } },
    }
    const r = runStep(summaryStep(), { steps }, run, { GITHUB_STEP_SUMMARY: summaryFile })
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    const block = /```bash\n(.*)\n```/.exec(readFileSync(summaryFile, 'utf8'))
    assert.ok(block, 'the summary carries a bash block')
    const command = block[1]
    assert.ok(assigns(command, 'IMAGE_REPO', WEB), command)
    assert.ok(assigns(command, 'API_IMAGE_REPO', API), command)
    assert.ok(assigns(command, 'TAG', SHORT_SHA), command)
    assert.ok(command.endsWith('deploy/deploy-k3s.sh apply'), command)
    // STORY-119 SUB-011: the registry path, which pulls both images on the node
    // before it applies anything. ALLOW_REGISTRY_PULL=1 is the local-build
    // path's switch, and that path never pre-pulls.
    assert.ok(assigns(command, 'IMAGE_SOURCE', 'registry'), command)
    assert.doesNotMatch(command, /ALLOW_REGISTRY_PULL/, command)
    // The paste-into-the-manifests alternative: the API image also goes into the
    // backup CronJob, and the line that says so carries the API image.
    const summary = readFileSync(summaryFile, 'utf8')
    const yaml = /```yaml\n([^]*?)\n```/.exec(summary)
    assert.ok(yaml, 'the summary carries a yaml block')
    const lines = yaml[1].split('\n').map((line) => line.trim())
    const cronJob = lines.findIndex((line) => line.includes('backup-cronjob.yaml'))
    assert.ok(cronJob >= 0, `the yaml block does not mention backup-cronjob.yaml:\n${yaml[1]}`)
    assert.equal(lines[cronJob + 1], `image: ${API}:${SHORT_SHA}`, yaml[1])
  } finally {
    box.dispose()
  }
})
