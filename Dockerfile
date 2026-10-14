# joi-button — Vue 2.7 static SPA, built once and served by unprivileged nginx.
#
# Build (what the first verification path does):
#   docker buildx build --platform linux/amd64 \
#     -t ghcr.io/tpmoonchefryan/joi-button/web:replace-me .
#
# --platform=$BUILDPLATFORM on the builder stage keeps the JS toolchain native
# to the build host (no QEMU for npm/webpack, which is where all the time goes)
# while the runtime stage is produced for the target arch.  dist/ is
# architecture-independent static text, so this is the standard split.
# The runtime stage contains no RUN instruction at all, so a cross-build never
# has to emulate a single target-arch process.

# ---------------------------------------------------------------------------
# stage 1 — build the static bundle
# ---------------------------------------------------------------------------
# Alpine, not bookworm-slim.  Checked against package-lock.json
# (lockfileVersion 3) rather than assumed:
#   * no node-sass anywhere; `sass` resolves to 1.77.8, which is dart-sass
#     compiled to JS — no libsass, no node-gyp, no python needed.
#     sass-loader 10.5.2 lists node-sass only as an OPTIONAL peer.
#   * the only packages with install scripts are core-js, ejs,
#     @apollo/protobufjs, yorkie (git-hook installer, skips when .git is
#     absent — and .dockerignore removes .git) and fsevents.  Every fsevents
#     entry is {"optional":true,"os":["darwin"]}, so npm skips it on linux and
#     its node-gyp build never runs.  musl is therefore not a risk here.
#   * every dependency resolves to registry.npmjs.org (0 git/tarball URLs), so
#     the image needs no git.
# node:22-alpine, not node:20. Node 20 left maintenance on 2026-04-30, and the
# workflow that pinned 20 (.github/workflows/deploy.yml, the GitHub Pages
# publish) has been deleted — so the reason this said 20 no longer exists.
#
# The risk of the bump is bounded and stated: this stage only runs the JS
# toolchain and emits static text, and its output is checked by the PUBLIC_PATH
# gate below plus deploy/smoke-image.sh against the running container. Nothing
# from this stage reaches the runtime image except dist/.
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

# Manifest + lockfile first: this layer is reused on every source-only change.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# vue.config.js reads process.env.PUBLIC_PATH; since GitHub Pages was retired
# its own default is '/' too, so this ARG now RESTATES the default rather than
# overriding a different one.  It is kept because a subpath deployment would need
# it and because the gate below has to have a value to compare against.
ARG PUBLIC_PATH=/
ENV PUBLIC_PATH=${PUBLIC_PATH}

# THE CONTRAST GATE, run rather than merely defined.
#
# `npm run contrast` has existed since the palette repair and was invoked by
# nothing — not this file, not CI, not the smoke test. A gate nobody runs is a
# comment, and this one is the only check on the DEFAULT palette: it reads
# src/App.vue's :root block and asserts every foreground/background
# pairings the site actually renders. (An OWNER's palette is checked separately,
# at run time, by server/lib/theme.mjs — against the same roster, which is why
# server/lib/contrast.mjs is a module and not a copy.)
#
# Before `npm run build`, deliberately: a palette that cannot be shipped should
# fail in seconds rather than after a two-minute webpack run.
RUN npm run contrast

# NOTE: NODE_ENV is intentionally NOT set.  vue-cli-service sets it to
# production itself, whereas exporting it before `npm ci` risks dropping the
# devDependencies that provide vue-cli-service.
#
# THE GATE, and why it is no longer a grep for '/joi-button/'.
# It used to be `grep -q '/joi-button/js/'`, which worked while that string was
# vue.config.js's production default: a build that ignored PUBLIC_PATH emitted
# it, and the grep caught it.  With the default now '/', that grep can never
# match no matter what vue.config.js does — it would be a gate whose predicate
# cannot be false, i.e. decoration that reads like protection.
#
# So the gate asks the question directly instead: does the prefix on the emitted
# <script src> equal the PUBLIC_PATH we asked for?  It goes red if vue.config.js
# stops honouring PUBLIC_PATH, if a subpath build is served at the root, or if a
# root build is served under a subpath — including prefixes nobody has thought of
# yet.  Exercised in all three directions before being committed: a real
# PUBLIC_PATH=/ build reads '/' (green), a real PUBLIC_PATH=/sub/ build reads
# '/sub/' (green — so it is not red-always), and the root build checked against
# '/sub/', which is exactly "vue.config.js ignored PUBLIC_PATH", exits 1.
RUN npm run build \
 && test -s dist/index.html \
 && test -d dist/voices \
 && emitted="$(sed -n 's|.*<script[^>]* src="\([^"]*\)/js/app\.[^"]*".*|\1/|p' dist/index.html | head -n1)" \
 && if [ -z "${emitted}" ]; then \
        echo "FATAL: no <script src=\".../js/app.<hash>.js\"> in dist/index.html; the build layout changed and this gate no longer measures anything." >&2; \
        exit 1; \
    fi \
 && if [ "${emitted}" != "${PUBLIC_PATH}" ]; then \
        echo "FATAL: asked for PUBLIC_PATH=${PUBLIC_PATH} but dist/index.html references assets under ${emitted}." >&2; \
        echo "       vue.config.js is not honouring PUBLIC_PATH; every asset URL would 404 where this image is served." >&2; \
        exit 1; \
    fi

# ---------------------------------------------------------------------------
# stage 2 — runtime
# ---------------------------------------------------------------------------
# nginx stable 1.28, alpine, unprivileged variant.  That image already runs as
# uid/gid 101, EXPOSEs 8080 and keeps its pid outside /var/run; deploy/nginx.conf
# re-states all of it explicitly so nothing depends on those defaults.
FROM nginxinc/nginx-unprivileged:1.28-alpine

LABEL org.opencontainers.image.title="joi-button web" \
      org.opencontainers.image.source="https://github.com/tpmoonchefryan/joi-button" \
      org.opencontainers.image.description="Static Vue 2 SPA served by unprivileged nginx on 8080"

# Full main config (see the header of deploy/nginx.conf for why it is
# nginx.conf and not conf.d/default.conf).
COPY deploy/nginx.conf /etc/nginx/nginx.conf

# Static payload.  Files land root-owned and mode 644/755 (verified: every file
# under public/ and src/ is 644, every directory 755), which uid 101 can read on
# a read-only filesystem.  This also overwrites the base image's placeholder
# index.html.
COPY --from=builder /app/dist/ /usr/share/nginx/html/

EXPOSE 8080
USER 101

# Same as the base image; restated so `docker inspect` shows it here.
# No HEALTHCHECK: the k8s probes hit GET /healthz.
CMD ["nginx", "-g", "daemon off;"]
