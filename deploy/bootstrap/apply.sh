# shellcheck shell=bash
# SPDX-License-Identifier: MIT
#
# Step 5 of the deploy bootstrap: build and run the site, on whichever target was
# chosen, with the TLS that was chosen.
#
#   k3s     -> TLS prerequisites (own-cert Secret, or cert-manager + a ClusterIssuer)
#              then deploy/deploy-k3s.sh does build + Secret + apply, then the
#              Ingress gets its tls block, then the catalogue is seeded.
#   docker  -> build the two images locally, write deploy/docker/.env, bring the
#              stack up with the TLS override, then seed.
#
# Idempotent: re-running re-applies and repairs rather than duplicating.

TLS_SECRET_NAME=joi-button-tls
K8S_NS=joi-button

# Pipe stdin into a command on the node: ssh when REMOTE is set, a local shell
# otherwise. The same helper drives a remote node and this machine, so the k3s
# manifests below apply identically in both. (run_on from target.sh does the
# no-stdin case; this is its stdin-carrying sibling.)
k3s_pipe() { if [[ -n "${REMOTE:-}" ]]; then ssh "$REMOTE" "$1"; else bash -c "$1"; fi; }

apply_target() {
  # Open fd 3 for the whole apply step. Unlike the earlier steps, apply prompts
  # only occasionally (the cert-manager install confirm on the Let's Encrypt path),
  # but it DOES prompt — and every other step opens its own fd 3, so this one must
  # too, or confirm_yes reads a closed descriptor and set -u then trips on the
  # unset answer.
  open_tty
  trap close_tty RETURN
  case "${DEPLOY_TARGET:?run the target step first}" in
    k3s)    apply_k3s ;;
    docker) apply_docker ;;
    *)      die "unknown DEPLOY_TARGET '$DEPLOY_TARGET'" ;;
  esac
  close_tty
  trap - RETURN
}

# ---------------------------------------------------------------------------
# k3s
# ---------------------------------------------------------------------------

apply_k3s() {
  [[ -n "${APP_HOST:-}" ]] || die 'APP_HOST is unset — run the domain step'
  : "${KUBECTL:=sudo k3s kubectl}"

  # Where the images come from. A single-host run (no REMOTE) has no Docker on the
  # k3s node to build with, so the images MUST come from the registry — the kubelet
  # pulls them. With a REMOTE, either source works; the caller's IMAGE_SOURCE wins
  # (default local-build, streamed in over ssh).
  local image_source="${IMAGE_SOURCE:-local}"
  if [[ -z "${REMOTE:-}" ]]; then
    image_source=registry
    note 'Single-host deploy on this node (no REMOTE): images are pulled from the'
    note 'registry (IMAGE_SOURCE=registry) — nothing is built here.'
  fi

  section 'k3s — TLS prerequisites'
  case "${TLS_MODE:?run the TLS step first}" in
    own-cert)    k3s_tls_secret_from_files ;;
    letsencrypt) k3s_cert_manager; k3s_cluster_issuer ;;
  esac

  section 'k3s — runtime Secret and workloads'
  note "Delegating to deploy/deploy-k3s.sh (Secret + apply; images: $image_source)."
  APP_HOST="$APP_HOST" REMOTE="${REMOTE:-}" IMAGE_SOURCE="$image_source" \
    bash "$REPO_ROOT/deploy/deploy-k3s.sh" all \
    || die 'deploy-k3s.sh failed'

  section 'k3s — attach TLS to the Ingress'
  k3s_patch_ingress_tls
  k3s_http_redirect

  section 'k3s — seed the catalogue if empty'
  k3s_seed_if_needed
}

# Redirect plain http to https, the job the docker path's traefik entrypoint does
# for free. A Middleware CRD plus the router annotation that references it — the
# k3s traefik way. Idempotent: applying the same Middleware and annotation again
# changes nothing. Without it a visitor on http gets the app with a Secure cookie
# that never comes back, i.e. a login that cannot complete.
k3s_http_redirect() {
  printf 'apiVersion: traefik.io/v1alpha1\nkind: Middleware\nmetadata:\n  name: redirect-https\n  namespace: %s\nspec:\n  redirectScheme:\n    scheme: https\n    permanent: true\n' \
    "$K8S_NS" | k3s_pipe "$KUBECTL apply -f -" >&2 \
    || { note 'could not create the redirect middleware (older traefik CRD?); http will not redirect'; return 0; }
  run_on "$KUBECTL -n $K8S_NS annotate ingress joi-button-public traefik.ingress.kubernetes.io/router.middlewares=${K8S_NS}-redirect-https@kubernetescrd --overwrite" >&2 \
    || note 'could not annotate the ingress for the redirect'
  note 'http now redirects to https.'
}

# Build a TLS Secret manifest LOCALLY from the operator's cert/key and apply it
# over ssh, so the private key never lands on the node's disk in the clear —
# only inside the Secret, which is where kubernetes keeps it anyway.
k3s_tls_secret_from_files() {
  [[ -r "${CERT_FILE:-}" && -r "${KEY_FILE:-}" ]] || die 'CERT_FILE/KEY_FILE unreadable — run the TLS step'
  note "Creating Secret $TLS_SECRET_NAME from your certificate."
  tls_secret_yaml "$TLS_SECRET_NAME" "$CERT_FILE" "$KEY_FILE" \
    | k3s_pipe "$KUBECTL -n $K8S_NS apply -f -" >&2 \
    || die 'failed to create the TLS secret'
}

tls_secret_yaml() {
  local name="$1" cert="$2" key="$3"
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\ntype: kubernetes.io/tls\ndata:\n  tls.crt: %s\n  tls.key: %s\n' \
    "$name" "$K8S_NS" "$(base64 < "$cert" | tr -d '\n')" "$(base64 < "$key" | tr -d '\n')"
}

# Install cert-manager if it is not already there. Its CRDs + controllers issue
# and RENEW the Let's Encrypt certificate; without it there is nobody to.
k3s_cert_manager() {
  if run_on "$KUBECTL get ns cert-manager >/dev/null 2>&1"; then
    note 'cert-manager already installed.'
    return 0
  fi
  note 'Installing cert-manager (needs the node to have internet).'
  confirm_yes 'Install cert-manager now?' || die 'aborted — install cert-manager, then re-run'
  local ver='v1.16.2'
  run_on "$KUBECTL apply -f https://github.com/cert-manager/cert-manager/releases/download/$ver/cert-manager.yaml" >&2 \
    || die 'cert-manager install failed (node internet?)'
  note 'Waiting for cert-manager to be ready...'
  run_on "$KUBECTL -n cert-manager wait --for=condition=Available deploy --all --timeout=180s" >&2 \
    || die 'cert-manager did not become ready'
}

# A ClusterIssuer that proves control of APP_HOST over HTTP-01 through traefik.
k3s_cluster_issuer() {
  [[ "${ACME_EMAIL:-}" == *@*.* ]] || die 'ACME_EMAIL unset — run the TLS step'
  note 'Creating the Let'\''s Encrypt ClusterIssuer.'
  printf 'apiVersion: cert-manager.io/v1\nkind: ClusterIssuer\nmetadata:\n  name: letsencrypt\nspec:\n  acme:\n    email: %s\n    server: https://acme-v02.api.letsencrypt.org/directory\n    privateKeySecretRef:\n      name: letsencrypt-account\n    solvers:\n      - http01:\n          ingress:\n            class: traefik\n' \
    "$ACME_EMAIL" | k3s_pipe "$KUBECTL apply -f -" >&2 \
    || die 'failed to create the ClusterIssuer'
}

# Add the tls block (and, in LE mode, the cert-manager annotation that makes it
# fill the secret). A merge patch, so re-running is a no-op once it is there.
k3s_patch_ingress_tls() {
  local patch
  patch=$(printf '{"spec":{"tls":[{"hosts":["%s"],"secretName":"%s"}]}}' "$APP_HOST" "$TLS_SECRET_NAME")
  run_on "$KUBECTL -n $K8S_NS patch ingress joi-button-public --type=merge -p '$patch'" >&2 \
    || die 'failed to patch the ingress with tls'
  if [[ "$TLS_MODE" == letsencrypt ]]; then
    run_on "$KUBECTL -n $K8S_NS annotate ingress joi-button-public cert-manager.io/cluster-issuer=letsencrypt --overwrite" >&2 \
      || die 'failed to annotate the ingress for cert-manager'
    note 'cert-manager will now request the certificate; it can take a minute.'
  fi
  note "Ingress serves TLS for $APP_HOST from Secret $TLS_SECRET_NAME."
}

# Seed the baseline catalogue exactly once — only when the database has no clips,
# so a re-run never double-seeds. Reuses the one-off seed pod pattern.
k3s_seed_if_needed() {
  local n
  n=$(run_on "$KUBECTL -n $K8S_NS exec deploy/joi-button-api -- node -e \"try{const d=require('better-sqlite3')('/srv/shared/joi.db',{readonly:true});process.stdout.write(String(d.prepare('SELECT count(*) n FROM clips').get().n))}catch(e){process.stdout.write('0')}\" 2>/dev/null" 2>/dev/null || echo 0)
  if [[ "${n:-0}" -gt 0 ]]; then
    note "Catalogue already has $n clips — not re-seeding."
    return 0
  fi
  note 'Seeding the baseline catalogue (3 groups, 12 clips) via a one-off pod.'
  note 'Run deploy/bootstrap.sh does this only when the database is empty.'
  # The heavy lifting lives in a companion the k3s deploy already ships; if it is
  # absent this is a soft note rather than a failure, because the site is up and
  # the owner can seed later.
  if [[ -x "$REPO_ROOT/deploy/seed-k3s.sh" ]]; then
    APP_HOST="$APP_HOST" REMOTE="${REMOTE:-}" bash "$REPO_ROOT/deploy/seed-k3s.sh" || note 'seed step reported a problem — see above; the site is up regardless'
  else
    note 'deploy/seed-k3s.sh not present; seed later with import-snapshot.'
  fi
}

# ---------------------------------------------------------------------------
# docker
# ---------------------------------------------------------------------------

apply_docker() {
  command -v docker >/dev/null 2>&1 || die 'docker not found on this machine'
  docker compose version >/dev/null 2>&1 || die 'docker compose v2 not found'
  [[ -n "${APP_HOST:-}" ]] || die 'APP_HOST unset — run the domain step'
  local dir="$REPO_ROOT/deploy/docker"
  local tag; tag="dev-$(git -C "$REPO_ROOT" rev-parse --short=7 HEAD 2>/dev/null || echo local)"

  section 'docker — build the images'
  docker build --tag "ghcr.io/tpmoonchefryan/joi-button/web:$tag" -f "$REPO_ROOT/Dockerfile" "$REPO_ROOT" >&2 \
    || die 'web image build failed'
  docker build --tag "ghcr.io/tpmoonchefryan/joi-button/api:$tag" -f "$REPO_ROOT/Dockerfile.api" "$REPO_ROOT" >&2 \
    || die 'api image build failed'

  section 'docker — write compose env and the runtime secret'
  # runtime.env is the same file the collect step wrote; compose reads it as the
  # api's env_file, so it must sit beside the compose file.
  cp "${RUNTIME_ENV_FILE:-$REPO_ROOT/deploy/runtime.env}" "$dir/runtime.env"
  chmod 600 "$dir/runtime.env"
  docker_write_env "$dir/.env" "$tag"

  section 'docker — bring the stack up'
  local override
  case "$TLS_MODE" in
    letsencrypt) override="$dir/compose.le.yml" ;;
    own-cert)    override="$dir/compose.cert.yml" ;;
    *)           die "unknown TLS_MODE '$TLS_MODE'" ;;
  esac
  ( cd "$dir" && docker compose -f docker-compose.yml -f "$override" up -d ) \
    || die 'docker compose up failed'

  section 'docker — seed the catalogue if empty'
  docker_seed_if_needed "$dir"
  note "Up. It serves https on this host for $APP_HOST."
}

docker_write_env() {
  local file="$1" tag="$2"
  ( umask 077; : >"$file" )
  {
    printf 'APP_HOST=%s\n' "$APP_HOST"
    printf 'IMAGE_TAG=%s\n' "$tag"
    printf 'ACME_EMAIL=%s\n' "${ACME_EMAIL:-}"
    printf 'CERT_FILE=%s\n' "${CERT_FILE:-}"
    printf 'KEY_FILE=%s\n' "${KEY_FILE:-}"
  } >>"$file"
  chmod 600 "$file"
}

docker_seed_if_needed() {
  local dir="$1" n
  n=$( cd "$dir" && docker compose exec -T api node -e "try{const d=require('better-sqlite3')('/srv/shared/joi.db',{readonly:true});process.stdout.write(String(d.prepare('SELECT count(*) n FROM clips').get().n))}catch(e){process.stdout.write('0')}" 2>/dev/null || echo 0 )
  if [[ "${n:-0}" -gt 0 ]]; then
    note "Catalogue already has $n clips — not re-seeding."
    return 0
  fi
  note 'Seeding the baseline catalogue.'
  # import-snapshot derives its inputs from its own location, so src/ and public/
  # are mounted read-only for the one-off run.
  ( cd "$dir" && docker compose run --rm \
      -v "$REPO_ROOT/src:/src:ro" -v "$REPO_ROOT/public:/public:ro" \
      api node scripts/import-snapshot.mjs ) \
    || note 'seed step reported a problem; the site is up, seed later if needed'
}
