# apps-builder's image: the server, and on the cluster its browser container too — the
# same image running chrome-headless-shell, with no token, Secret or projects of the server's. Build from the
# repo root: deploy/build-images.sh. Read-only at runtime: /tmp is an emptyDir, the projects a PVC.

FROM docker.io/oven/bun:1.4.2@sha256:296a79bbc988bb0a91ef11099af70a78a8cba98b73fd53f7b2a7715b7c86ced2 AS bun

FROM docker.io/library/node:24-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /srv/apps-builder
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM docker.io/library/node:24-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# git: a checkpoint is a commit. node runs a project's own tsc (pilot.ts).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV HOME=/home/ab
WORKDIR /srv/apps-builder
COPY --from=build /srv/apps-builder/node_modules node_modules
COPY --from=build /srv/apps-builder/dist dist
COPY package.json CHANGELOG.md ./
COPY server server
COPY shared shared
COPY template template
# chromium's headless shell where pilot.ts and shots.ts look for it ($HOME/.cache/ms-playwright), the version
# playwright-core pins, with its libraries; on PATH for the browser container's command.
RUN node node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell \
  && ln -s "$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | tail -1)" /usr/local/bin/chrome-headless-shell \
  && chmod -R a+rX "$HOME" \
  && rm -rf /var/lib/apt/lists/*
USER 1000
CMD ["bun", "server/api.ts"]
