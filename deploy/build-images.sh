#!/usr/bin/env bash
# Builds apps-builder's two images from this checkout, tests them, and with --push
# sends them to the image registry and prints what to pin in
# the cluster's GitOps repo:
#   apps-builder=registry.example.net/apps/apps-builder:<tag>@sha256:…
#   apps-builder-preview=registry.example.net/apps/apps-builder-preview:<tag>@sha256:…
# Usage: deploy/build-images.sh <tag> [--push]     (a tag other than `dev` needs a clean checkout)
set -euo pipefail
TAG=${1:?usage: build-images.sh <tag> [--push]}
PUSH=${2:-}
cd "$(dirname "$0")/.."
[ "$TAG" = dev ] || [ -z "$(git status --porcelain)" ] ||
  { echo "build-images: uncommitted changes: commit them, or build the tag dev" >&2; exit 1; }
REG=registry.example.net/apps
podman build -q -f deploy/Dockerfile -t "localhost/apps-builder:$TAG" . >/dev/null
podman build -q -f deploy/preview.Dockerfile --build-arg AB_LOCK="$(sha256sum template/bun.lock | cut -d' ' -f1)" \
  -t "localhost/apps-builder-preview:$TAG" . >/dev/null
# An untested image is never pushed.
deploy/test-image.sh "localhost/apps-builder:$TAG" >&2
deploy/test-preview-image.sh "localhost/apps-builder-preview:$TAG" >&2
[ "$PUSH" = --push ] || exit 0
D=$(mktemp); trap 'command rm -f "$D"' EXIT
for image in apps-builder apps-builder-preview; do
  podman tag "localhost/$image:$TAG" "$REG/$image:$TAG"
  podman push -q --digestfile "$D" "$REG/$image:$TAG" >&2
  echo "$image=$REG/$image:$TAG@$(cat "$D")"
done
