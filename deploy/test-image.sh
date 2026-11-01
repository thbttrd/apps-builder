#!/usr/bin/env bash
# apps-builder's image (deploy/Dockerfile): what the cluster's two containers need of it,
# run the way the cluster runs them — read-only, its own user, a tmpfs /tmp.
#   deploy/test-image.sh <image>        Exit 0 = all PASS.
set -u
REF=${1:?usage: test-image.sh <image>}
NAME=abtest-app-image
fails=0
check() { local n=$1; shift; if "$@" >/dev/null 2>&1; then echo "PASS $n"; else echo "FAIL $n"; fails=$((fails+1)); fi; }
run() { podman run --rm --read-only --tmpfs /tmp "$REF" "$@"; }
cleanup() { podman rm -f $NAME $NAME-browser >/dev/null 2>&1; }
trap cleanup EXIT
cleanup

check "the image runs as uid 1000" test "$(run id -u 2>/dev/null)" = 1000
check "node is 24" sh -c "podman run --rm --read-only --tmpfs /tmp '$REF' node --version | grep -q '^v24\.'"
check "git runs" run git --version
check "bun runs" run bun --version

# The server: no secret, so every request is 503 (origin.ts) — it started, and it fails closed.
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
podman run -d --name $NAME --read-only --tmpfs /tmp -p 127.0.0.1:$port:8787 "$REF" >/dev/null 2>&1
up() { for _ in $(seq 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health")" = 503 ] && return 0; sleep 0.5; done; return 1; }
check "bun server/api.ts with no secret answers 503 on :8787" up
[ "$fails" -eq 0 ] || podman logs --tail 5 $NAME 2>&1 | sed 's/^/  /'

# The browser container: the same image, chrome-headless-shell with its debug port on the pod's loopback.
podman run -d --name $NAME-browser --read-only --tmpfs /tmp "$REF" \
  chrome-headless-shell --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars --user-data-dir=/tmp/chrome >/dev/null 2>&1
devtools() { for _ in $(seq 60); do podman exec $NAME-browser node -e \
  "fetch('http://127.0.0.1:9222/json/version').then((r) => r.json()).then((j) => process.exit(j.Browser ? 0 : 1), () => process.exit(1))" && return 0; sleep 0.5; done; return 1; }
check "the browser command's /json/version answers" devtools

exit $fails
