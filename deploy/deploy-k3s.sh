#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# joi-button operator entrypoint for a single-node k3s cluster reached over ssh.
#
#   Usage:  deploy/deploy-k3s.sh [import|apply|all]
#
#     import   build BOTH images (web and api) for linux/amd64, stream each into the
#              cluster's containerd WITHOUT a registry, then ask the cluster whether
#              they arrived
#     apply    build the runtime Secret from deploy/runtime.env, render deploy/k8s
#              (replacing the literal 'replace-me' image tags on stdout only) and apply
#              it through the remote's kubectl, then wait for both rollouts
#     all      import, then apply  (this is also the default when no argument is given)
#
#   SITE-SPECIFIC VALUES LIVE OUTSIDE THIS REPOSITORY.
#   This is a public repository, so it carries no hostnames, no addresses and no
#   cluster identity of its own. Copy deploy/deploy.env.example to
#   deploy/deploy.env (git-ignored) and fill it in, or export the same names in
#   your shell. Nothing here has a fallback that would quietly point at somebody
#   else's cluster: the two values that identify a deployment are REQUIRED.
#   For every name listed below, a NON-EMPTY value exported by the caller wins over
#   the same name in deploy.env; the file only fills the names the caller left unset
#   or exported empty. That is what lets CI pass IMAGE_REPO/API_IMAGE_REPO to a node
#   whose deploy.env says something else.
#
#   Required (no default — the script refuses to guess):
#     REMOTE                 ssh host alias of the k3s node          (import, apply)
#     APP_HOST               hostname the Ingress serves             (apply)
#
#   Also required for `apply`, and NOT an environment variable:
#     deploy/runtime.env     the API's credentials and settings. Copy
#                            deploy/runtime.env.example and fill it in; it is
#                            git-ignored. `apply` turns it into the Secret
#                            `joi-button-runtime` that the API pod reads with
#                            envFrom, and refuses to proceed without it — a pod
#                            whose envFrom names a missing Secret never starts,
#                            and reports that as a rollout timeout naming nothing.
#                            The values travel over ssh into kubectl's stdin; they
#                            are never written to the node's disk and never printed.
#                            Override the path with RUNTIME_ENV_FILE=...
#
#   Optional:
#     LB_ADDRESS             ingress load-balancer address, used only to print a
#                            DNS-independent curl at the end
#     IMAGE_REPO             default ghcr.io/tpmoonchefryan/joi-button/web
#     API_IMAGE_REPO         default ghcr.io/tpmoonchefryan/joi-button/api
#     IMAGE_SOURCE           default local  local | registry   (see the note at its default)
#     RUNTIME_ENV_FILE       default deploy/runtime.env
#     TAG                    default dev-<short git sha of HEAD>
#     NAMESPACE              default joi-button
#     KUBECTL                default "sudo k3s kubectl"           (see the note below)
#     MANIFEST_DIR           default deploy/k8s
#     ROLLOUT_TIMEOUT        default 120s
#     RESTART_IF_UNCHANGED   default 1                            (see the note below)
#     SMOKE                  default 1     run deploy/smoke-image.sh before shipping
#     ALLOW_REGISTRY_PULL    default 0     permit applying a tag absent from the node
#     ENV_FILE               default deploy/deploy.env
#
#   TAGS: this script builds and deploys `dev-<short7-sha>` (plus `-dirty` when the
#   working tree is not clean). CI publishes bare `<short7-sha>` to GHCR. The two
#   namespaces are separate on purpose — see the comment at the TAG default — so
#   deploying a CI image means naming it:
#     ALLOW_REGISTRY_PULL=1 TAG=<short7-sha> deploy/deploy-k3s.sh apply
#
#   ASSUMPTION, stated so it can be checked rather than believed: a stock k3s node has
#   no standalone kubectl binary -- kubectl is reached as a k3s subcommand, and reading
#   /etc/rancher/k3s/k3s.yaml needs root. Hence the KUBECTL default is "sudo k3s kubectl".
#   If your node has a real kubectl with a readable kubeconfig, override it:
#     KUBECTL=kubectl deploy/deploy-k3s.sh apply
#   Import also needs passwordless sudo on the remote, because the image tar arrives on
#   stdin and a sudo password prompt has nowhere to read from. That is preflighted.
#
#   The repository must stay clean: the manifests keep their 'replace-me' placeholders —
#   the image tag, and the Ingress host `replace-me.invalid` — and are never edited in
#   place. Substitution happens on a pipe. `.invalid` is the RFC 2606 reserved TLD, so a
#   placeholder that somehow escapes substitution can never resolve to a real host.
#
#   RESTART_IF_UNCHANGED: with imagePullPolicy IfNotPresent, re-importing new bytes under
#   an already-deployed tag leaves the Deployment spec byte-identical, so the apply is a
#   no-op, no pods restart, and "rollout status" would happily report success while the
#   old bytes keep serving. When the Deployment's generation does not move, this script
#   therefore issues an explicit "rollout restart". Set RESTART_IF_UNCHANGED=0 to opt out.

set -euo pipefail

DEFAULT_IMAGE_REPO="ghcr.io/tpmoonchefryan/joi-button/web"
DEFAULT_API_IMAGE_REPO="ghcr.io/tpmoonchefryan/joi-button/api"
DEFAULT_NAMESPACE="joi-button"
PLACEHOLDER_IMAGE="${DEFAULT_IMAGE_REPO}:replace-me"
PLACEHOLDER_API_IMAGE="${DEFAULT_API_IMAGE_REPO}:replace-me"
PLACEHOLDER_HOST="replace-me.invalid"

DEPLOYMENT_NAME="joi-button-web"
API_DEPLOYMENT_NAME="joi-button-api"

# The Secret the API pod reads with envFrom. It is BUILT FROM deploy/runtime.env
# on every apply rather than committed as a manifest: a committed template with
# blank values would be applied alongside everything else and would overwrite the
# real credentials with blanks, which is a deploy that silently unsets the
# signing key and every Bilibili credential. Same reasoning as the deploy.env
# split — the repository is public and states no secrets of its own.
SECRET_NAME="joi-button-runtime"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Site-specific values come from a git-ignored file, so this repository states no
# cluster's identity. Already-exported variables win: the file only fills gaps.
#
# "Already-exported" covers every name the header documents, not only the three
# that identify a deployment. Sourcing the file would otherwise overwrite them —
# and the one caller that must not lose that race is CI, which exports the image
# repositories it just pushed to; a deploy.env written before a repository move
# would quietly point the rollout at images that do not exist. So: remember each
# documented name the caller exported NON-EMPTY, read the file, put them back. An
# exported empty value does not count as set (REMOTE always behaved that way), so
# the file's value stands. ENV_FILE itself is on the list so the file cannot
# rename itself in the messages printed at the end.
CALLER_WINS=(
  REMOTE APP_HOST LB_ADDRESS
  IMAGE_REPO API_IMAGE_REPO IMAGE_SOURCE TAG NAMESPACE KUBECTL
  RUNTIME_ENV_FILE MANIFEST_DIR ROLLOUT_TIMEOUT RESTART_IF_UNCHANGED
  SMOKE ALLOW_REGISTRY_PULL ENV_FILE
)
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/deploy.env}"
if [[ -f "${ENV_FILE}" ]]; then
  _caller_values=()
  for _name in "${CALLER_WINS[@]}"; do
    # ${!_name} is the value of the variable NAMED by _name (bash indirection).
    if [[ -n "${!_name:-}" ]]; then
      _caller_values[${#_caller_values[@]}]="${_name}=${!_name}"
    fi
  done
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
  if [[ ${#_caller_values[@]} -gt 0 ]]; then
    for _pair in "${_caller_values[@]}"; do
      printf -v "${_pair%%=*}" '%s' "${_pair#*=}"
    done
  fi
fi

IMAGE_REPO="${IMAGE_REPO:-${DEFAULT_IMAGE_REPO}}"
API_IMAGE_REPO="${API_IMAGE_REPO:-${DEFAULT_API_IMAGE_REPO}}"
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-${SCRIPT_DIR}/runtime.env}"
REMOTE="${REMOTE:-}"
APP_HOST="${APP_HOST:-}"
LB_ADDRESS="${LB_ADDRESS:-}"
NAMESPACE="${NAMESPACE:-${DEFAULT_NAMESPACE}}"
KUBECTL="${KUBECTL:-sudo k3s kubectl}"
MANIFEST_DIR="${MANIFEST_DIR:-deploy/k8s}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-120s}"
RESTART_IF_UNCHANGED="${RESTART_IF_UNCHANGED:-1}"

# Where the images come from:
#   local      build them here and stream into the node's containerd over ssh
#              (the original two-machine model; needs REMOTE + Docker here).
#   registry   they were built and pushed to a registry (GHCR) by CI; the node's
#              kubelet pulls them. No Docker, no build, no import — and this is
#              what makes a SINGLE-HOST deploy (bootstrap run ON the node, REMOTE
#              empty) possible, because nothing here needs a builder anymore.
IMAGE_SOURCE="${IMAGE_SOURCE:-local}"

MODE="${1:-all}"

log() { printf '[deploy-k3s] %s\n' "$*"; }
warn() { printf '[deploy-k3s] WARNING: %s\n' "$*" >&2; }
fail() {
  printf '[deploy-k3s] ERROR: %s\n' "$*" >&2
  exit 1
}

# Run a command "on the node": over ssh when REMOTE is set, in a local shell when
# it is not. Every kubectl/ctr call in the apply path goes through these two, so
# the SAME code drives a remote node and this machine. `-n` on the ssh form keeps
# it from swallowing our stdin; the piping form deliberately lets stdin through.
node_exec() { if [[ -n "${REMOTE}" ]]; then node_exec "$1"; else bash -c "$1"; fi; }
node_pipe() { if [[ -n "${REMOTE}" ]]; then ssh    "${REMOTE}" "$1"; else bash -c "$1"; fi; }

usage() {
  # Print this file's header comment block, minus the leading '#'. Anchored on the
  # comment run itself rather than fixed line numbers, so editing the header cannot
  # silently truncate the help text.
  awk 'NR > 2 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "${cmd}" >/dev/null 2>&1 || fail "required command not found locally: ${cmd}"
  done
}

case "${MODE}" in
  import | apply | all) ;;
  -h | --help | help)
    usage
    exit 0
    ;;
  *)
    printf 'Unsupported mode: %s\n\n' "${MODE}" >&2
    usage >&2
    exit 1
    ;;
esac

# Everything below runs from the repository root, so the docker build context and
# MANIFEST_DIR mean the same thing no matter where the operator invoked this from.
cd "${REPO_ROOT}"

require_cmd git
# ssh is only a dependency when there is a remote to reach. A single-host deploy
# (REMOTE empty) drives the local node directly and needs no ssh at all.
[[ -z "${REMOTE}" ]] || require_cmd ssh

# Refuse to guess who you are deploying to or as what. A default here would be a
# hostname from somebody else's network baked into a public repository.
missing_config() {
  fail "$1 is not set. Copy deploy/deploy.env.example to deploy/deploy.env and fill it in, or export $1 for this invocation. This repository deliberately ships no cluster addresses of its own."
}
# REMOTE is REQUIRED for the local-build path (it names the node to stream the
# image into over ssh) but OPTIONAL for the registry path (the node is this
# machine, and the kubelet pulls the image itself). An empty REMOTE therefore
# only makes sense with IMAGE_SOURCE=registry; anything else is a misconfiguration
# that would otherwise fail deep inside a build with a confusing message.
if [[ -z "${REMOTE}" && "${IMAGE_SOURCE}" != "registry" ]]; then
  fail "REMOTE is empty, which means a single-host deploy ON this node — but that only works with IMAGE_SOURCE=registry (there is no builder here to make the images). Set IMAGE_SOURCE=registry to pull them from the registry, or set REMOTE to build here and stream them to a node."
fi
if [[ "${MODE}" != "import" ]]; then
  [[ -n "${APP_HOST}" ]] || missing_config APP_HOST
  case "${APP_HOST}" in
    *.invalid) fail "APP_HOST is '${APP_HOST}', which is the placeholder, not a hostname. Set a real one." ;;
  esac
fi

if [[ -z "${TAG:-}" ]]; then
  # --short=7, not bare --short: the bare form honours core.abbrev and can return
  # 8+ characters, which would silently disagree with the 7 that
  # .github/workflows/image.yml publishes.
  GIT_SHA="$(git rev-parse --short=7 HEAD 2>/dev/null || true)"
  # TWO TAG NAMESPACES, ON PURPOSE. CI publishes `<sha>`; the local-build path uses
  # `dev-<sha>`. They must not collide: a locally built image carries the bytes of
  # your working tree, and with `imagePullPolicy: IfNotPresent` a local build tagged
  # `<sha>` would shadow the CI image of that commit on the node forever.
  if [[ "${IMAGE_SOURCE}" == "registry" ]]; then
    # The registry path PULLS the image CI published — the BARE short sha — so match
    # it exactly. But the code may have been synced here WITHOUT its .git (a tar or
    # `git archive`), in which case there is no sha to read: fall back to :latest,
    # which CI also publishes from main. :latest is not reproducible, so it is a
    # fallback with a warning, not a default to reach for.
    if [[ -n "${GIT_SHA}" ]]; then
      TAG="${GIT_SHA}"
      if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
        warn "working tree is dirty; the registry holds HEAD's image (${TAG}), which does NOT include your uncommitted changes. Commit and let CI publish, or pass an explicit TAG=."
      fi
    else
      TAG="latest"
      warn "no git checkout here (code was synced without .git), so pinning the registry image to :latest — published on main. For a reproducible, sha-pinned deploy, run from a git checkout or pass TAG=<sha>."
    fi
  else
    [[ -n "${GIT_SHA}" ]] ||
      fail "cannot read the short git sha of HEAD in ${REPO_ROOT}; the local-build path needs it. Pass an explicit TAG=..., or use IMAGE_SOURCE=registry to pull a published image instead of building."
    TAG="dev-${GIT_SHA}"
    if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
      TAG="${TAG}-dirty"
      warn "working tree is dirty; tagging ${TAG} so the tag cannot claim to be commit ${GIT_SHA}."
    fi
  fi
fi

IMAGE_REF="${IMAGE_REPO}:${TAG}"
# ONE tag across both images. They are built from one working tree and they share
# a volume layout and an API contract, so a deploy that pinned them separately
# would make "which pair is running" a question with two answers.
API_IMAGE_REF="${API_IMAGE_REPO}:${TAG}"

log "repo root:  ${REPO_ROOT}"
log "mode:       ${MODE}"
log "web image:  ${IMAGE_REF}"
log "api image:  ${API_IMAGE_REF}"
log "remote:     ${REMOTE:-<none — single-host, this node>}"
log "image src:  ${IMAGE_SOURCE}"
log "namespace:  ${NAMESPACE}"
log "kubectl:    ${KUBECTL}"

# ---------------------------------------------------------------------------
# import: build for the cluster's architecture, stream it in, then ask the cluster
# ---------------------------------------------------------------------------

do_import() {
  # Registry path: nothing to build or stream. CI already published both images
  # and the node's kubelet pulls them. Skipping here is what lets a single-host
  # run (no Docker on the node) reach `apply`.
  if [[ "${IMAGE_SOURCE}" == "registry" ]]; then
    log "IMAGE_SOURCE=registry: skipping build/import; the kubelet pulls ${IMAGE_REF} and ${API_IMAGE_REF} from the registry."
    return 0
  fi

  require_cmd docker
  docker buildx version >/dev/null 2>&1 || fail "docker buildx is required (docker buildx version failed)."

  [[ -f Dockerfile ]] || fail "Dockerfile not found in ${REPO_ROOT}; nothing to build."
  [[ -f Dockerfile.api ]] || fail "Dockerfile.api not found in ${REPO_ROOT}; the API image cannot be built."

  log "Preflighting ssh and passwordless sudo on ${REMOTE} ..."
  node_exec 'true' || fail "cannot ssh to ${REMOTE}."
  node_exec 'sudo -n true' ||
    fail "passwordless sudo is not available on ${REMOTE}; 'sudo k3s ctr images import -' cannot prompt because stdin carries the image tar."

  log "Building ${IMAGE_REF} for linux/amd64 ..."
  # --load is required so that the built image lands in the local docker image store
  # where 'docker save' can find it; with the plain docker driver it is the default,
  # with a docker-container builder it is not.
  # --provenance=false: with provenance on, buildx produces an OCI index carrying
  # an extra unknown/unknown attestation manifest, and the delivery path here is
  # `docker save | k3s ctr images import`, which handles a plain single-platform
  # manifest far more predictably.
  docker buildx build \
    --platform linux/amd64 \
    -t "${IMAGE_REF}" \
    --build-arg PUBLIC_PATH=/ \
    --provenance=false \
    --load \
    .

  # Start it before shipping it. The runtime contract (read-only root filesystem,
  # the two writable mounts, the cache split, honest 404s) is only observable in a
  # running container, and shipping first would make the cluster the place where
  # it is first evaluated. SMOKE=0 opts out; there is no good reason to.
  if [[ "${SMOKE:-1}" == "1" ]]; then
    [[ -x deploy/smoke-image.sh ]] ||
      fail "deploy/smoke-image.sh is missing or not executable; set SMOKE=0 to skip it deliberately."
    log "Smoke-testing ${IMAGE_REF} the way the Deployment runs it ..."
    SMOKE_PLATFORM=linux/amd64 deploy/smoke-image.sh "${IMAGE_REF}" ||
      fail "the image failed its runtime contract; not shipping it to the cluster."
  fi

  assert_amd64_then_import "${IMAGE_REF}"

  # ---- the API image -----------------------------------------------------
  # Built AFTER the web image and its smoke test, so a broken frontend fails the
  # run before a second multi-minute build starts.
  #
  # No --platform=$BUILDPLATFORM inside Dockerfile.api: `npm ci` there compiles
  # better-sqlite3, a native addon, so its builder stage must run as the TARGET
  # architecture. On an arm64 laptop that means QEMU and several minutes; on the
  # amd64 node it is native. See the header of Dockerfile.api.
  #
  # There is no smoke test for this image, and that is a gap stated rather than
  # papered over: starting it needs a database volume and a full credential set,
  # which is what the cluster provides and a `docker run` here does not. The API
  # is covered instead by 320 tests over the assembled fastify app, and by the
  # /api/readyz assertion do_apply makes against the running pod — readyz opens a
  # savepoint on the real database and rolls it back, so it cannot be green over
  # a volume that is missing or read-only.
  log "Building ${API_IMAGE_REF} for linux/amd64 (native addon: this stage is NOT cross-compiled) ..."
  docker buildx build \
    --platform linux/amd64 \
    -f Dockerfile.api \
    -t "${API_IMAGE_REF}" \
    --provenance=false \
    --load \
    .

  assert_amd64_then_import "${API_IMAGE_REF}"
}

# Ask the local authority what was actually built, ship it, then ask the cluster
# whether it arrived. Both questions go to the party that owns the answer: a
# silently arm64 image would otherwise only surface on the node as an exec format
# error inside a CrashLoopBackOff, and `docker save | ssh` exiting 0 proves the
# pipe ran, not that containerd kept anything.
assert_amd64_then_import() {
  local ref="$1"
  local built_arch matched

  built_arch="$(docker image inspect --format '{{.Architecture}}' "${ref}")"
  [[ "${built_arch}" == "amd64" ]] ||
    fail "built image architecture is '${built_arch}', but the cluster node is amd64."
  log "Built ${ref} (architecture ${built_arch})."

  log "Streaming ${ref} into ${REMOTE}'s containerd (no registry involved) ..."
  # Remote side is single-quoted so nothing here is re-expanded by the remote shell.
  docker save "${ref}" | node_pipe 'sudo k3s ctr images import -'

  log "Verifying with the cluster that ${ref} is present ..."
  if ! matched="$(node_exec "sudo k3s ctr images ls -q | grep -F -- '${ref}'")"; then
    fail "the cluster does not list ${ref} after import. Do not proceed to apply: with imagePullPolicy IfNotPresent the pods would fail to start."
  fi
  log "Cluster confirms: ${matched}"
}

# ---------------------------------------------------------------------------
# apply: render on stdout only, apply through the remote's kubectl, wait for rollout
# ---------------------------------------------------------------------------

MANIFESTS_NS=()
MANIFESTS_REST=()

collect_manifests() {
  [[ -d "${MANIFEST_DIR}" ]] || fail "manifest directory not found: ${MANIFEST_DIR} (relative to ${REPO_ROOT})"

  local file
  while IFS= read -r file; do
    [[ -n "${file}" ]] || continue
    case "$(basename "${file}")" in
      kustomization.yaml | kustomization.yml)
        fail "found ${file}: this script applies plain manifests with sed substitution on stdout, not kustomize overlays."
        ;;
    esac
    if grep -Eq '^kind:[[:space:]]*Namespace([[:space:]]|$)' "${file}"; then
      MANIFESTS_NS[${#MANIFESTS_NS[@]}]="${file}"
    else
      MANIFESTS_REST[${#MANIFESTS_REST[@]}]="${file}"
    fi
  done <<EOF
$(find "${MANIFEST_DIR}" -type f \( -name '*.yaml' -o -name '*.yml' \) | LC_ALL=C sort)
EOF

  if [[ ${#MANIFESTS_NS[@]} -eq 0 && ${#MANIFESTS_REST[@]} -eq 0 ]]; then
    fail "no .yaml/.yml manifests under ${MANIFEST_DIR} (relative to ${REPO_ROOT})"
  fi
}

SED_ARGS=()

set_sed_args_for() {
  local file="$1"
  # The API substitution goes FIRST. Both placeholders end in ':replace-me' and
  # the repository paths differ only in their last segment (.../web vs .../api),
  # so order would not matter for a literal `s|…|…|` — but if the web pattern
  # were ever loosened to something that also matches the API line, the tighter
  # rule having already fired is what keeps the API pod from being pinned to the
  # nginx image. Cheap, and the failure it prevents is silent.
  SED_ARGS=(
    -e "s|${PLACEHOLDER_API_IMAGE}|${API_IMAGE_REF}|g"
    -e "s|${PLACEHOLDER_IMAGE}|${IMAGE_REF}|g"
    -e "s|${PLACEHOLDER_HOST}|${APP_HOST}|g"
  )
  # Renaming the namespace is only attempted when the operator actually asked for a
  # different one; the default path touches the image tag and nothing else.
  if [[ "${NAMESPACE}" != "${DEFAULT_NAMESPACE}" ]]; then
    SED_ARGS[${#SED_ARGS[@]}]="-e"
    SED_ARGS[${#SED_ARGS[@]}]="s|^\([[:space:]]*\)namespace:[[:space:]]*${DEFAULT_NAMESPACE}[[:space:]]*\$|\1namespace: ${NAMESPACE}|"
    if grep -Eq '^kind:[[:space:]]*Namespace([[:space:]]|$)' "${file}"; then
      SED_ARGS[${#SED_ARGS[@]}]="-e"
      SED_ARGS[${#SED_ARGS[@]}]="s|^\([[:space:]]*\)name:[[:space:]]*${DEFAULT_NAMESPACE}[[:space:]]*\$|\1name: ${NAMESPACE}|"
    fi
  fi
}

# Renders to stdout. The files on disk are never modified.
render_stream() {
  local file
  for file in "$@"; do
    printf '# rendered from %s\n' "${file}"
    set_sed_args_for "${file}"
    sed "${SED_ARGS[@]}" "${file}"
    printf -- '---\n'
  done
}

assert_no_placeholder() {
  local label="$1" stream="$2"
  case "${stream}" in
    *replace-me*)
      fail "rendered ${label} still contains 'replace-me'; refusing to apply an unpinned image reference or an unresolved Ingress host."
      ;;
  esac
}

remote_generation() {
  local deployment="$1"
  node_exec "${KUBECTL} -n '${NAMESPACE}' get deploy ${deployment} -o jsonpath='{.metadata.generation}' 2>/dev/null || true"
}

# Build the runtime Secret from deploy/runtime.env and apply it.
#
# ORDER MATTERS: this runs after the namespace exists and BEFORE the workloads.
# api-deployment.yaml reads it with envFrom, and a pod whose envFrom names an
# absent Secret does not start — it sits in CreateContainerConfigError, which
# rollout status reports as a plain timeout with no mention of the secret.
#
# The values never touch the remote disk. They travel over the ssh pipe into
# kubectl's stdin and from there to the API server; nothing is written to a file
# on the node, and nothing is echoed here. `--dry-run=client -o yaml | apply` is
# what makes this idempotent — `create secret` alone fails the second time.
apply_runtime_secret() {
  [[ -f "${RUNTIME_ENV_FILE}" ]] ||
    fail "${RUNTIME_ENV_FILE} does not exist, so the API pod would have no credentials, no session key and no admin list — it would not start. Copy deploy/runtime.env.example to deploy/runtime.env and fill it in (it is git-ignored), or set RUNTIME_ENV_FILE=... to point elsewhere."

  log "Building Secret ${SECRET_NAME} from ${RUNTIME_ENV_FILE} (values are never printed) ..."
  local rendered
  # Command substitution, so a failure in the normaliser stops the deploy rather
  # than piping an empty stream into kubectl and creating an EMPTY Secret — which
  # would look like a successful apply and take the API down at the next restart.
  if command -v node >/dev/null 2>&1; then
    # PREFERRED: the API's own parser normalises the file, so "what a line means"
    # has exactly one definition (see runtime-env-to-secret.mjs) — it strips the
    # inline ' #' comments a hand-edited file may carry.
    rendered="$(node "${SCRIPT_DIR}/runtime-env-to-secret.mjs" "${RUNTIME_ENV_FILE}")" ||
      fail "deploy/runtime-env-to-secret.mjs refused ${RUNTIME_ENV_FILE} (see the message above); nothing was applied."
  else
    # A single-host deploy runs ON a bare k3s node with no Node.js. The bootstrap
    # writes runtime.env as clean KEY=value lines (no inline comments), which
    # kubectl --from-env-file reads correctly on its own. Guard the ONE case that
    # would silently corrupt a secret: a value line carrying an inline ' #' comment,
    # which the API treats as a comment but kubectl would fold INTO the value.
    local bad
    bad="$(grep -nE '^[^#[:space:]][^=]*=.*[[:space:]]#' "${RUNTIME_ENV_FILE}" || true)"
    [[ -z "${bad}" ]] ||
      fail "node is not installed here, and ${RUNTIME_ENV_FILE} has value line(s) with an inline ' #' comment that kubectl would fold INTO the secret:
${bad}
Install Node.js on this node, or remove the ' # ...' from those lines, then re-run."
    rendered="$(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "${RUNTIME_ENV_FILE}")"
  fi
  [[ -n "${rendered}" ]] ||
    fail "no key=value lines to build the Secret from in ${RUNTIME_ENV_FILE}."

  # shellcheck disable=SC2029
  printf '%s\n' "${rendered}" | node_pipe \
    "${KUBECTL} -n '${NAMESPACE}' create secret generic '${SECRET_NAME}' --from-env-file=/dev/stdin --dry-run=client -o yaml | ${KUBECTL} apply -f -"
}

do_apply() {
  collect_manifests

  # If no manifest carries the placeholder, the substitution below would be a no-op and
  # the apply would ship whatever literal is in the files. Refuse instead.
  grep -R -F -q -- "${PLACEHOLDER_IMAGE}" "${MANIFEST_DIR}" ||
    fail "no manifest under ${MANIFEST_DIR} (relative to ${REPO_ROOT}) contains the placeholder '${PLACEHOLDER_IMAGE}'; nothing would be pinned to ${TAG}."
  grep -R -F -q -- "${PLACEHOLDER_API_IMAGE}" "${MANIFEST_DIR}" ||
    fail "no manifest under ${MANIFEST_DIR} contains the API placeholder '${PLACEHOLDER_API_IMAGE}'; the API Deployment would keep whatever image literal is in the file rather than ${API_IMAGE_REF}."
  grep -R -F -q -- "${PLACEHOLDER_HOST}" "${MANIFEST_DIR}" ||
    fail "no manifest under ${MANIFEST_DIR} contains the Ingress host placeholder '${PLACEHOLDER_HOST}'; the applied Ingress would carry whatever hostname is literally in the file, not ${APP_HOST}."

  local where="${REMOTE:-this node}"
  log "Preflighting ${KUBECTL} on ${where} ..."
  node_exec "${KUBECTL} get nodes -o name" >/dev/null ||
    fail "'${KUBECTL}' failed on ${where}. Check ${REMOTE:+ssh, }sudo, and that k3s is running; override the command with KUBECTL=..."

  # imagePullPolicy is IfNotPresent, so a tag that never reached this node is a
  # rollout that will sit in ImagePullBackOff unless the registry happens to be
  # reachable AND the package is readable (public, or via an imagePullSecret).
  #
  # In the REGISTRY path this is expected: the image is NOT in the node's local
  # store — the kubelet pulls it on first use — so checking the local store would
  # always "fail" and is skipped. In the LOCAL-BUILD path the image was just
  # streamed in, so its absence is a real STOP: the apply below replaces a working
  # Deployment spec, and proceeding on a tag that resolves nowhere trades a serving
  # site for ImagePullBackOff.
  if [[ "${IMAGE_SOURCE}" == "registry" ]]; then
    log "IMAGE_SOURCE=registry: the kubelet pulls ${IMAGE_REF} and ${API_IMAGE_REF} from the registry; not checking the node's local image store."
  else
    local ref
    for ref in "${IMAGE_REF}" "${API_IMAGE_REF}"; do
      if ! node_exec "sudo k3s ctr images ls -q | grep -F -- '${ref}'" >/dev/null 2>&1; then
        if [[ "${ALLOW_REGISTRY_PULL:-0}" == "1" ]]; then
          warn "${ref} is not on ${where}; proceeding because ALLOW_REGISTRY_PULL=1. The kubelet must be able to pull it (public package or an imagePullSecret)."
        else
          fail "${ref} is not in ${where}'s image store, and the running Deployment would be replaced by one that cannot start. Either run 'deploy/deploy-k3s.sh import' to build and stream this tag in, or re-run with IMAGE_SOURCE=registry (or ALLOW_REGISTRY_PULL=1) if the kubelet is meant to pull it from the registry."
        fi
      fi
    done
  fi

  local ns_stream="" rest_stream=""
  if [[ ${#MANIFESTS_NS[@]} -gt 0 ]]; then
    ns_stream="$(render_stream "${MANIFESTS_NS[@]}")"
    assert_no_placeholder "namespace manifests" "${ns_stream}"
  fi
  if [[ ${#MANIFESTS_REST[@]} -gt 0 ]]; then
    rest_stream="$(render_stream "${MANIFESTS_REST[@]}")"
    assert_no_placeholder "manifests" "${rest_stream}"
  fi

  # Read each Deployment's generation before anything is applied. Comparing it
  # afterwards is what tells us whether the apply actually changed that spec.
  local web_gen_before api_gen_before
  web_gen_before="$(remote_generation "${DEPLOYMENT_NAME}")"
  api_gen_before="$(remote_generation "${API_DEPLOYMENT_NAME}")"

  if [[ -n "${ns_stream}" ]]; then
    log "Applying namespace manifest(s) ..."
    # KUBECTL and NAMESPACE are deliberately expanded here, on the client: they are local
    # configuration. Their values are single-quoted where they land in the remote command,
    # so the remote shell re-expands nothing.
    # shellcheck disable=SC2029
    printf '%s\n' "${ns_stream}" | node_pipe "${KUBECTL} apply -f -"
  else
    log "No Namespace manifest found; ensuring namespace ${NAMESPACE} exists ..."
    node_exec "${KUBECTL} create namespace '${NAMESPACE}' --dry-run=client -o yaml | ${KUBECTL} apply -f -"
  fi

  # Between the namespace and the workloads. See apply_runtime_secret.
  apply_runtime_secret

  if [[ -n "${rest_stream}" ]]; then
    log "Applying workload manifests to namespace ${NAMESPACE} ..."
    # shellcheck disable=SC2029
    printf '%s\n' "${rest_stream}" | node_pipe "${KUBECTL} apply -f -"
  else
    # Legitimate when every object lives in one multi-document file that also carries the
    # Namespace: that file was already applied above. Piping an empty stream to kubectl
    # would fail with "no objects passed to apply", so skip it rather than fake a failure.
    log "No separate workload manifests; all objects came from the Namespace-carrying manifest(s)."
  fi

  restart_if_spec_unchanged "${DEPLOYMENT_NAME}" "${web_gen_before}"
  restart_if_spec_unchanged "${API_DEPLOYMENT_NAME}" "${api_gen_before}"

  # The API first. It is the one with a Recreate strategy and a database
  # migration on its startup path, so it is both the slower and the likelier of
  # the two to fail — and a failure here should be reported before the web
  # rollout spends the rest of the timeout succeeding at serving a site whose API
  # is down.
  log "Waiting for the API rollout (timeout ${ROLLOUT_TIMEOUT}) ..."
  node_exec "${KUBECTL} -n '${NAMESPACE}' rollout status deploy/${API_DEPLOYMENT_NAME} --timeout=${ROLLOUT_TIMEOUT}"

  log "Waiting for the web rollout (timeout ${ROLLOUT_TIMEOUT}) ..."
  node_exec "${KUBECTL} -n '${NAMESPACE}' rollout status deploy/${DEPLOYMENT_NAME} --timeout=${ROLLOUT_TIMEOUT}"

  # A green rollout means the probes passed. /healthz is a filesystem-independent
  # `return 200`, so on its own it would also be green over an empty document
  # root. Assert the served bytes and the deployed image reference before calling
  # this a success.
  log "Asserting the deployed pod actually serves the app ..."
  local served
  served="$(node_exec "${KUBECTL} -n '${NAMESPACE}' exec deploy/${DEPLOYMENT_NAME} -- wget -qO- http://127.0.0.1:8080/" 2>/dev/null || true)"
  case "${served}" in
    *'<div id="app">'*) log "Served document contains the app root element." ;;
    *) fail "the pod is ready but GET / does not contain the app root element; the document root is empty or wrong." ;;
  esac

  # The API's readiness probe already passed, and asking again from here proves
  # something the probe cannot: that the answer is the one THIS script's pair of
  # images produces. /api/readyz opens a savepoint on the real database and rolls
  # it back, so it cannot be green over a missing or read-only volume — which is
  # the failure a shared PVC actually has.
  log "Asserting the API answers its own readiness document ..."
  local ready_body
  # busybox wget, from the alpine base — same tool the web assertion above uses.
  # It exits non-zero and prints nothing on the 503 that readyz answers with when
  # the database probe fails, so a failed probe reaches the case below as an
  # empty string and is refused there.
  ready_body="$(node_exec "${KUBECTL} -n '${NAMESPACE}' exec deploy/${API_DEPLOYMENT_NAME} -- wget -qO- http://127.0.0.1:8080/api/readyz" 2>/dev/null || true)"
  # The DATABASE check specifically, not the envelope's own "status". readyz
  # returns `status: ok` only when the database probe did, so matching the
  # envelope would work — but it would also match if the readiness contract were
  # ever loosened to report ok while a check underneath it failed. This asserts
  # the check that costs something: probeDatabase opens a savepoint on the real
  # file and rolls it back, so it goes red on a volume that is absent, read-only
  # or holding a database this build cannot open.
  case "${ready_body}" in
    *'"database":{"status":"ok"'*) log "API readiness document reports the database check green." ;;
    '') fail "GET /api/readyz from inside the API pod returned nothing; readyz answers 503 (and wget prints nothing) when the database probe fails." ;;
    *) fail "the API pod is ready by its probe but /api/readyz does not report a green database check: ${ready_body}" ;;
  esac

  assert_deployed_image "${DEPLOYMENT_NAME}" "${IMAGE_REF}"
  assert_deployed_image "${API_DEPLOYMENT_NAME}" "${API_IMAGE_REF}"
}

# With imagePullPolicy IfNotPresent, re-importing new bytes under an
# already-deployed tag leaves the Deployment spec byte-identical: the apply is a
# no-op, no pod restarts, and `rollout status` reports success while the OLD
# bytes keep serving. Comparing the generation across the apply is what detects
# that, and an explicit restart is what fixes it.
restart_if_spec_unchanged() {
  local deployment="$1" gen_before="$2" gen_after
  gen_after="$(remote_generation "${deployment}")"
  if [[ -z "${gen_after}" ]]; then
    fail "deployment ${deployment} does not exist in namespace ${NAMESPACE} after the apply; the manifests under ${MANIFEST_DIR} do not define it."
  fi
  [[ -n "${gen_before}" && "${gen_before}" == "${gen_after}" ]] || return 0

  if [[ "${RESTART_IF_UNCHANGED}" == "1" ]]; then
    log "${deployment} spec unchanged (generation ${gen_after}); restarting the rollout so re-imported bytes for ${TAG} are actually picked up."
    node_exec "${KUBECTL} -n '${NAMESPACE}' rollout restart deploy/${deployment}"
  else
    warn "${deployment} spec unchanged (generation ${gen_after}) and RESTART_IF_UNCHANGED=0: running pods keep their current image bytes even if you just re-imported tag ${TAG}."
  fi
}

assert_deployed_image() {
  local deployment="$1" expected="$2" deployed
  deployed="$(node_exec "${KUBECTL} -n '${NAMESPACE}' get deploy ${deployment} -o jsonpath='{.spec.template.spec.containers[0].image}'" 2>/dev/null || true)"
  [[ "${deployed}" == "${expected}" ]] ||
    fail "${deployment} now runs '${deployed}', not the '${expected}' this run pinned."
  log "${deployment} pins ${deployed}."
}

# ---------------------------------------------------------------------------

case "${MODE}" in
  import)
    do_import
    ;;
  apply)
    do_apply
    ;;
  all)
    do_import
    do_apply
    ;;
esac

echo
log "Done: ${MODE}"
if [[ "${MODE}" != "import" ]]; then
  cat <<EOF

Check the site (LAN):
  http://${APP_HOST}/

Check the health endpoint:
  curl -sS -i http://${APP_HOST}/healthz
EOF
  if [[ -n "${LB_ADDRESS}" ]]; then
    cat <<EOF

If ${APP_HOST} does not resolve on this machine, address the ingress load balancer directly:
  curl -sS -i --resolve ${APP_HOST}:80:${LB_ADDRESS} http://${APP_HOST}/healthz
EOF
  elif [[ -n "${REMOTE}" ]]; then
    cat <<EOF

If ${APP_HOST} does not resolve on this machine, set LB_ADDRESS in ${ENV_FILE} to the
ingress load balancer address and re-run, or browse without DNS by forwarding the
service port:
  ssh -L 8080:127.0.0.1:18080 ${REMOTE} "${KUBECTL} -n ${NAMESPACE} port-forward --address 127.0.0.1 svc/${DEPLOYMENT_NAME} 18080:80"
  # then open http://localhost:8080/
EOF
  else
    cat <<EOF

If ${APP_HOST} does not resolve here, set LB_ADDRESS in ${ENV_FILE} to this node's
address and re-run, or browse without DNS by forwarding the service port locally:
  ${KUBECTL} -n ${NAMESPACE} port-forward --address 127.0.0.1 svc/${DEPLOYMENT_NAME} 18080:80
  # then open http://localhost:18080/
EOF
  fi
  if [[ -n "${REMOTE}" ]]; then
    cat <<EOF

See pod status:
  ssh ${REMOTE} "${KUBECTL} -n ${NAMESPACE} get pods -l app.kubernetes.io/name=${DEPLOYMENT_NAME} -o wide"

See pod logs:
  ssh ${REMOTE} "${KUBECTL} -n ${NAMESPACE} logs -l app.kubernetes.io/name=${DEPLOYMENT_NAME} --tail=50"
EOF
  else
    cat <<EOF

See pod status:
  ${KUBECTL} -n ${NAMESPACE} get pods -l app.kubernetes.io/name=${DEPLOYMENT_NAME} -o wide

See pod logs:
  ${KUBECTL} -n ${NAMESPACE} logs -l app.kubernetes.io/name=${DEPLOYMENT_NAME} --tail=50
EOF
  fi
fi
