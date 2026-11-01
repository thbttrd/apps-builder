# A preview's image: node, the template's node_modules, and apps-builder's preview
# scripts. A preview's /app starts empty and apps-builder pushes the project's source into it; node_modules
# is this image's (preview-vite.mjs links it), so every project must carry the template's lockfile (the
# ab.lock label is its sha256). Build from the repo root: deploy/build-images.sh, or
#   podman build -f deploy/preview.Dockerfile --build-arg AB_LOCK=$(sha256sum template/bun.lock | cut -d' ' -f1) .
# Read-only at runtime: vite's cache goes to /tmp (an emptyDir), nothing is written under /ab.

# glibc (Debian), like node's image: the native bindings bun picks (rolldown, lightningcss, tailwind's oxide)
# are the -gnu ones.
FROM docker.io/oven/bun:1.4.2@sha256:296a79bbc988bb0a91ef11099af70a78a8cba98b73fd53f7b2a7715b7c86ced2 AS deps
WORKDIR /ab
COPY template/package.json template/bun.lock ./
RUN bun install --frozen-lockfile

FROM docker.io/library/node:24-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae
ARG AB_LOCK
LABEL ab.lock=$AB_LOCK
COPY --from=deps /ab/node_modules /ab/node_modules
COPY server/preview-vite.mjs server/preview-control.mjs server/fetch-relay.mjs server/crash-overlay.mjs /ab/
USER 1000
WORKDIR /app
ENTRYPOINT ["node", "/ab/preview-vite.mjs"]
