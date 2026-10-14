<!-- SPDX-License-Identifier: MIT -->

# joi-button on k3s — operator notes

Four manifests that publish the built site as a read-only nginx pod on a
single-node k3s cluster reached over ssh.

**This repository is public and states no cluster's identity.** The node, the
hostname the Ingress serves and the load-balancer address are yours, not the
repository's: put them in `deploy/deploy.env` (git-ignored; copy
`deploy/deploy.env.example`). Below, `$REMOTE`, `$APP_HOST` and `$LB_ADDRESS`
refer to those values.

| File                  | Object                                                          |
| --------------------- | --------------------------------------------------------------- |
| `namespace.yaml`      | Namespace `joi-button`                                          |
| `web-service.yaml`    | Service `joi-button-web` — ClusterIP, port 80 → 8080            |
| `web-deployment.yaml` | Deployment `joi-button-web` — 1 replica, nginx, read-only root   |
| `ingress.yaml`        | Ingress `joi-button-public` — traefik, host `replace-me.invalid` |

Two placeholders are substituted on the way in and never edited on disk: the
image tag `replace-me`, and the Ingress host `replace-me.invalid` (RFC 2606's
reserved TLD, so an unsubstituted placeholder fails loudly rather than resolving
somewhere unintended).

These manifests are the whole deployment surface. They do **not** contain the
nginx config, the cache headers or the `/healthz` endpoint — those live in the
container build elsewhere in this repository. What this baseline assumes of the
image: listens on **8080**, runs as **uid/gid 101**, tolerates a **read-only root
filesystem** given writable `/tmp` and `/var/cache/nginx`, serves from
`/usr/share/nginx/html`, and answers `GET /healthz` with a small plain-text body
that is *not* `index.html`.

## Image delivery

Image names: `ghcr.io/tpmoonchefryan/joi-button/web` and
`ghcr.io/tpmoonchefryan/joi-button/api`, tag placeholder `replace-me` (the web
image in `web-deployment.yaml`, the API image in `api-deployment.yaml` and
`backup-cronjob.yaml`). `imagePullPolicy` is `IfNotPresent`.

`IMAGE_REPO` and `API_IMAGE_REPO` override the two repositories. **A value you
export wins over the same key in `deploy/deploy.env`**; the file only fills
gaps. That holds for every name the script's header documents, which are the
names in its `CALLER_WINS` list: `REMOTE`, `APP_HOST`, `LB_ADDRESS`,
`IMAGE_REPO`, `API_IMAGE_REPO`, `IMAGE_SOURCE`, `TAG`, `NAMESPACE`, `KUBECTL`,
`RUNTIME_ENV_FILE`, `MANIFEST_DIR`, `ROLLOUT_TIMEOUT`, `RESTART_IF_UNCHANGED`,
`SMOKE`, `ALLOW_REGISTRY_PULL`, `PREPULL`, `PULL_CMD` and `ENV_FILE`.
An exported empty value counts as not set, so it cannot blank out the file's
value. To deploy an image published under another repository (rolling back to a
release that predates a repository move, say), export both repositories for that
one run.

**`deploy/deploy-k3s.sh` is the supported path and the single tag authority.** It
builds, smoke-tests, streams the image into the node's containerd, applies the
manifests with the tag substituted on a pipe, and then asserts that the pod
serves the app. The manual recipes below this section are the fallback for when
you need to see each step.

```bash
deploy/deploy-k3s.sh          # import + apply
deploy/deploy-k3s.sh import   # build, smoke, stream to the node, verify arrival
deploy/deploy-k3s.sh apply    # render, apply, wait, assert
```

There are **two tag namespaces, deliberately kept apart**:

| Who builds it              | Tag                                | Where it lives                |
| -------------------------- | ---------------------------------- | ----------------------------- |
| `deploy/deploy-k3s.sh`     | `dev-<short7-sha>` (`-dirty` if the working tree is not clean) | that node's containerd only |
| `.github/workflows/image.yml` | `<short7-sha>`, plus `latest` from `main` | GHCR                    |

They must not collide. A locally built image carries the bytes of your working
tree; if it were tagged with the bare sha, `IfNotPresent` would let it shadow the
CI image for that commit on the node indefinitely, with nothing to reveal the
substitution. To deploy a CI-published image, take the registry path and name the
tag explicitly:

```bash
IMAGE_SOURCE=registry TAG=<short7-sha> deploy/deploy-k3s.sh apply
```

A release does this by itself. Pushing a `vX.Y.Z` tag also publishes both images
under that tag, and the workflow's `deploy-to-prod` job then runs this script on
the node with `IMAGE_SOURCE=registry`, `TAG=vX.Y.Z`, and `IMAGE_REPO` and
`API_IMAGE_REPO` set to the repositories that same run pushed to. A renamed or
moved repository therefore no longer leaves the deploy pulling an image that
does not exist, and the node's `deploy/deploy.env` cannot point it at another
repository.

**The registry path pulls both images on the node before it applies
anything.** Before the first `kubectl apply` (namespace, runtime Secret,
workloads) it runs `PULL_CMD` on the node for the API image, then for the web
image. If either pull fails, the script refuses and exits without changing any
object, and whatever is running keeps serving. Without this, a tag the node
cannot pull would take the API down: its Deployment is `Recreate`, so the old
pod stops before the new one is found stuck in `ImagePullBackOff`. With both
images already on the node, the `Recreate` gap is only the new pod's start-up.

| Variable   | Default                   | Purpose                                                               |
| ---------- | ------------------------- | --------------------------------------------------------------------- |
| `PREPULL`  | `1`                       | `0` skips the pre-pull, with a WARNING, and with it the refusal above |
| `PULL_CMD` | `sudo -n k3s crictl pull` | the command that pulls one image on the node; the image reference is appended |

The default `PULL_CMD` needs passwordless sudo on the node, as the default
`KUBECTL` does. On a node driven through a kubeconfig (`KUBECTL=kubectl` in its
`deploy/deploy.env`) that default may fail, and the first deploy then refuses
before applying anything: set `PULL_CMD` in that node's `deploy/deploy.env`, or
pass `PREPULL=0` for one run.

`ALLOW_REGISTRY_PULL=1` belongs to the local-build path. Without it, that path
refuses to apply a tag that is not already on the node — with `IfNotPresent`,
that would replace a serving Deployment with one stuck in `ImagePullBackOff`.
With it, the script proceeds without any pre-pull and leaves the pull to the
kubelet. It is not a way to deploy a CI-published image: that takes the
registry path above, which checks the pull before applying.

**GHCR packages are private by default, even for a public repository.** The
`org.opencontainers.image.source` label in both Dockerfiles makes each package
auto-link to this repo, which enables "inherit access from source repository" —
but that, and making a package public, are manual settings on the package. The
registry path, and with it the release deploy above, assumes the node can pull
both packages anonymously: no `imagePullSecret` is shipped. If either package
cannot be pulled that way, the pre-pull fails and the script refuses before
applying anything; the local import above does not depend on package
visibility. **Record here how the node gets its images** (public packages, an
`imagePullSecret`, or the local import), so the next operator does not
rediscover it from a 401.

Use a fresh tag per build. Re-importing new content under a tag containerd
already has, with `IfNotPresent`, leaves the old layers serving unless you also
force a restart — a self-inflicted "my fix didn't deploy". `deploy-k3s.sh`
handles this by issuing an explicit `rollout restart` when the Deployment's
generation does not move.

The manual equivalent of the import step:

```bash
TAG="dev-$(git rev-parse --short=7 HEAD)"
docker buildx build --platform linux/amd64 --provenance=false \
  -t "ghcr.io/tpmoonchefryan/joi-button/web:${TAG}" --build-arg PUBLIC_PATH=/ --load .
deploy/smoke-image.sh "ghcr.io/tpmoonchefryan/joi-button/web:${TAG}"
docker save "ghcr.io/tpmoonchefryan/joi-button/web:${TAG}" \
  | ssh "$REMOTE" 'sudo k3s ctr images import -'
```

The result is a **node-local** image: it exists in that node's containerd and in
no registry. Fine on one node; a landmine the day a second node joins.

## Apply by hand

Prefer `deploy/deploy-k3s.sh apply`, which does all of this plus the assertions.
Note that a stock k3s node has no standalone `kubectl`: it is reached as
`sudo k3s kubectl`, so run these over ssh or substitute accordingly.

Substitute the tag on the way in; nothing here is templated by Helm or Kustomize.

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/web-service.yaml
sed "s|/web:replace-me|/web:${TAG}|" deploy/k8s/web-deployment.yaml \
  | kubectl apply -f -
kubectl apply -f deploy/k8s/ingress.yaml

kubectl -n joi-button rollout status deploy/joi-button-web --timeout=90s
```

Order matters in two places: the namespace must exist before anything in it, and
the Service before the Ingress so traefik never resolves a route to a backend
that is not there yet. Service-before-Deployment is habit, not a requirement.

Confirm what you actually applied, rather than what the file says:

```bash
kubectl -n joi-button get deploy joi-button-web \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

## The theme

The owner's theme is two files on the same shared volume as `catalog.json` and
`media/`, both written by the **API** and served read-only by the **web** pod.
Nothing is baked into the image and nothing is rebuilt when a theme changes.

| Path on the volume            | URL                  | Cache-Control             |
| ----------------------------- | -------------------- | ------------------------- |
| `theme.css`                   | `/theme.css`         | `no-cache` + ETag         |
| `wallpaper/<sha256>.<ext>`    | `/wallpaper/<name>`  | `max-age=31536000, immutable` |

`theme.css` is a `:root` block of the same custom properties `src/App.vue`
declares. `public/index.html` links it unconditionally, from `<body>` so that it
is read after the bundled stylesheet — same selector, same specificity, later
declaration wins. `POST /api/admin/theme` rewrites the file and `DELETE` replaces
it with a comment, so **the site returns to its bundled palette without a
redeploy**.

The two rows get **opposite** cache treatment, and that is the whole point:

- `theme.css` **changes at a stable name**, so `immutable` would pin every
  visitor to the first theme they ever loaded for a year, with no way for the
  owner to correct it. `no-cache` plus the ETag nginx already emits makes a save
  visible on the next navigation for the price of one conditional request
  against a few hundred bytes. It is an exact-match location for the same reason
  `/catalog.json` is: an exact match is decided before any regex, so the generic
  `*.css` rule — one hour — cannot reach it and no save can sit invisible for
  up to sixty minutes while the admin page says it worked.
- The wallpaper's filename **is** its sha256 (a `CHECK` in `server/db/schema.sql`
  permits no other spelling), so new bytes cannot reuse the URL and `immutable`
  is a promise the name keeps by itself.

**A first deploy has no `theme.css` and that is not an error.** `/theme.css`
answers 404, the browser drops the stylesheet, and the page renders in the
palette compiled into its bundle — the same fallback shape as `catalog.json`.
Both directions are asserted by `deploy/smoke-image.sh`, which seeds its own
fixtures and checks the immutable/bounded split each way.

## Backups

`backup-cronjob.yaml` runs `server/scripts/backup.mjs` out of the API image at
03:17 nightly, into the separate `joi-button-backups` claim. Read that script's
header for what is included and what is not; the short version is joi.db via
`VACUUM INTO`, the referenced media once per blob, and nothing derived or in
flight.

**The on-cluster copy is not off-site.** k3s's local-path provisioner puts every
claim on the same disk, so it survives a bad migration and not a dead node. The
second copy is a PULL, from your machine, because the credentials only point one
way — and a node that could write to the backup destination is a node whose
compromise takes the backups too.

```bash
deploy/pull-backup.sh
```

It rsyncs the volume here and then verifies the LOCAL copy: re-derives the
database digest from the manifest, opens it and runs `integrity_check`, and
checks every blob the manifest names is present. "The transfer exited 0" is a
different claim, and not the one that matters.

Check the schedule is actually running, rather than assuming it:

```bash
kubectl -n joi-button get cronjob joi-button-backup
kubectl -n joi-button get jobs -l app.kubernetes.io/name=joi-button-backup
kubectl -n joi-button logs -l app.kubernetes.io/name=joi-button-backup --tail=40
```

**Restoring.** Never in place — that destroys the only copy of the current state
with the command meant to recover from destroying it. Restore beside it and swap:

```bash
node server/scripts/backup.mjs --restore 20260801T031700Z --into /srv/shared.restored
```

The command refuses to write into a directory that already holds a `joi.db`, and
it checks the snapshot's digest before copying rather than after. `catalog.json`
is not restored because it is derived — point the API at the restored directory
and publish once.

**Retention is a policy.** `BACKUP_PRUNE_DAYS` (30) bounds how far back a
restore can reach, and anything deleted from the live data inside that window
comes back with the restore. Re-run whatever deletion policy exists afterwards.
There is no automatic deletion in this system today — `v_unreferenced_media`
names collectable blobs and nothing acts on it — so the rule is written before
the policy it has to respect.

## Verify

Resolving the name yourself tests routing without depending on DNS — use it
first, so a resolver problem cannot look like a deployment problem. `$APP_HOST`
and `$LB_ADDRESS` come from `deploy/deploy.env`.

```bash
R="--resolve ${APP_HOST}:80:${LB_ADDRESS}"

curl -sS $R -o /dev/null -w '%{http_code}\n' "http://${APP_HOST}/healthz"
curl -sSI $R "http://${APP_HOST}/"                        # expect Cache-Control: no-cache
curl -sS  $R "http://${APP_HOST}/nope/deep" | head -c 80  # expect the app shell
```

Then the real thing, which additionally proves the client resolves the name:

```bash
curl -sSI "http://${APP_HOST}/"
```

With no DNS record and no hosts entry, forward the Service port instead and
browse it — this bypasses the Ingress, so no Host header is involved:

```bash
ssh -L 8080:127.0.0.1:18080 "$REMOTE" \
  "sudo k3s kubectl -n joi-button port-forward --address 127.0.0.1 svc/joi-button-web 18080:80"
# then open http://localhost:8080/
```

Cache contract, checked in both directions by `deploy/smoke-image.sh` and worth a
manual look because the whole voice-file workflow rests on it:

| URL family                              | Expected                              |
| --------------------------------------- | ------------------------------------- |
| `/`, `/index.html`, any deep link       | `no-cache, must-revalidate`           |
| `/js/app.<hash>.js`, `/css/…`, `/fonts/…`, `/img/…` | `max-age=31536000, immutable` |
| `/voices/*.mp3`                         | `max-age=31536000, immutable`          |
| `/media/*`, `/wallpaper/*`              | `max-age=31536000, immutable`          |
| `/catalog.json`, `/theme.css`           | `no-cache`                             |
| `/resources/**`, `/site.webmanifest`    | `max-age=3600, must-revalidate`        |

The last row is the one that is easy to get wrong in the dangerous direction:
those filenames are copied verbatim from `public/` and do **not** change when
their bytes do, so freezing them for a year would be unrecoverable for every
visitor who cached them. `immutable` is granted only where a new byte forces a
new name — webpack's content hashes, and `/voices/*` where the project convention
requires a new filename per recut (see the repository README).

Voice filenames contain spaces, apostrophes and question marks, so quote and
URL-encode them when curling one directly.

The deep-link check returning 200 is correct (vue-router runs in history mode, so
nginx falls back to `index.html`) — and it is also why `/healthz` exists as a
separate endpoint. Every other path is 200 by construction, so no other path can
tell you whether the site is really there.

## What this baseline does not do

Read this as the list of things nobody has done yet, not as accepted risk that
somebody signed off.

- **No TLS.** Plain HTTP on port 80, no cert, no redirect. There is no
  `tls:` block in the Ingress.
- **No public internet exposure, and no authentication.** The reachability limit
  is a private ingress address plus a name that only resolves on the LAN.
  Anything that can reach that address with the right `Host` header gets the
  site. Nothing here authenticates anyone.
- **No autoscaling, no PodDisruptionBudget, single replica.** Pod eviction, image
  change or node reboot means a short outage. On a single-node cluster there is no
  second failure domain to spread over anyway.
- **Node-local image, if imported.** No registry pull secret is shipped, so a
  private GHCR package will fail to pull.
- **No NetworkPolicy, no ResourceQuota, no LimitRange, no metrics or
  ServiceMonitor.** Observability is `kubectl logs` and nginx's access log.
- **Nothing verifies the DNS record.** `$APP_HOST` has to resolve by some means
  outside these files. Do not assume it does: an ingress can be perfectly healthy
  while the name resolves nowhere on the machine you are testing from, and the two
  failures look identical in a browser. Browsing by name needs a LAN DNS record or
  a hosts entry (`$LB_ADDRESS $APP_HOST`); adding a hosts entry needs root and is
  the operator's call. The `curl --resolve` and port-forward recipes above are the
  DNS-independent ways to confirm the deployment itself.
- **RUN THE SNAPSHOT IMPORT BEFORE THE FIRST PUBLISH.** The twelve clips this
  site has always served live in `src/voices.json`, compiled into the bundle, and
  the page paints them when `/catalog.json` cannot be fetched. The first publish
  creates that file — and the fetched document REPLACES the compiled one
  wholesale, so on an empty database the site would go from twelve clips to
  however many were just approved, silently. Once, on the node, against the same
  volume the API uses:

  ```bash
  DATA_DIR=/srv/shared node server/scripts/import-snapshot.mjs --dry-run
  ```

  Then again without `--dry-run`. It is idempotent, it never updates or deletes,
  and it imports the clips as `published`, so they survive every publish after
  it. Skipping it is recoverable — run it later and publish again — but between
  the two the site is missing its own content.

- **This replaced GitHub Pages; Pages is retired.** `.github/workflows/deploy.yml`
  is deleted and `vue.config.js` now serves from `/` in every mode. The reason is
  structural rather than preference: Pages serves static files and nothing else,
  so a site with an API has nowhere to put `/api/*`. There is one deployment now,
  and one publicPath. Old `ryanlan-new.github.io/joi-button/…` links are a
  different origin and nothing here can redirect them — if that matters, the
  Pages site has to be turned off in the repository's settings by hand, which is
  the owner's action and not something a manifest can do.
