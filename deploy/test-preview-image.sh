#!/usr/bin/env bash
# The preview image serves a real project from an empty /app:
# node_modules from the image, vite's cache in /tmp, nothing written under /ab.
#   deploy/test-preview-image.sh <image>             podman: read-only root, tmpfs /app and /tmp, uid 1000
#   deploy/test-preview-image.sh <image> --cluster   a gVisor pod in scratch namespace abtest-image (deleted on exit)
# The checks run inside the container (node's fetch on 127.0.0.1), so both ways run the same ones: the
# project is pushed through the control port (:5174) as apps-builder pushes it, then vite is probed (:5173).
# Exit 0 = all PASS.
set -u
IMAGE=${1:?usage: test-preview-image.sh <image> [--cluster]}
MODE=${2:-podman}
SRC=${AB_TEST_PROJECT:-$(cd "$(dirname "$0")/.." && pwd)/template}
NAME=abtest-image
NS=abtest-image

if [ "$MODE" = --cluster ]; then
  cleanup() { kubectl delete ns $NS --ignore-not-found --timeout=120s >/dev/null 2>&1; }
  trap cleanup EXIT
  kubectl create ns $NS >/dev/null
  kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: {name: $NAME, namespace: $NS}
spec:
  runtimeClassName: gvisor
  securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: preview
      image: $IMAGE
      imagePullPolicy: Always
      env: [{name: AB_CONTROL_TOKEN, value: image-test-token}]
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}, readOnlyRootFilesystem: true}
      volumeMounts: [{name: app, mountPath: /app}, {name: tmp, mountPath: /tmp}]
  volumes: [{name: app, emptyDir: {}}, {name: tmp, emptyDir: {}}]
EOF
  kubectl -n $NS wait pod/$NAME --for=condition=Ready --timeout=180s >/dev/null || { echo "FAIL the pod never ran"; exit 1; }
  ex() { kubectl -n $NS exec -i $NAME -c preview -- "$@"; }
  tail_log() { kubectl -n $NS logs $NAME -c preview --tail=5; }
else
  cleanup() { podman rm -f $NAME >/dev/null 2>&1; }
  trap cleanup EXIT
  cleanup
  podman run -d --name $NAME --read-only --tmpfs /app:rw,mode=1777 --tmpfs /tmp:rw,mode=1777 --user 1000 \
    -e AB_CONTROL_TOKEN=image-test-token "$IMAGE" >/dev/null \
    || { echo "FAIL the container never ran"; exit 1; }
  ex() { podman exec -i $NAME "$@"; }
  tail_log() { podman logs --tail 5 $NAME; }
fi

# The source only (no node_modules, .git or .apps-builder) into /tmp/seed; the checks push it from there.
sleep 1
ex mkdir -p /tmp/seed 2>/dev/null || { echo "FAIL the container stopped before the push:"; tail_log 2>&1 | sed 's/^/  /'; exit 1; }
tar c -C "$SRC" --exclude=./node_modules --exclude=./.git --exclude=./.apps-builder . | ex tar x --no-same-owner -C /tmp/seed 2>/dev/null
ex node - <<'EOF'
const fs = require('node:fs')
const base = 'http://127.0.0.1:5173'
let failed = 0
const out = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed++ }
const get = (path) => fetch(base + path).catch((e) => ({ status: 0, headers: new Headers(), text: async () => String(e) }))
const started = Date.now()
const push = (files) => fetch('http://127.0.0.1:5174/_ab/push', {
  method: 'POST', headers: { authorization: `Bearer ${process.env.AB_CONTROL_TOKEN}` }, body: JSON.stringify({ files }),
}).then((r) => r.status, (e) => String(e))
const tree = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? tree(`${d}/${e.name}`, `${rel}${e.name}/`) : [[`${rel}${e.name}`, fs.readFileSync(`${d}/${e.name}`).toString('base64')]])
;(async () => {
  const seeded = await push(Object.fromEntries(tree('/tmp/seed')))
  out(seeded === 204, `the project pushed through the control port -> ${seeded}`)
  out((await fetch('http://127.0.0.1:5174/_ab/push', { method: 'POST', body: '{}' })).status === 401, 'a push without the token -> 401')
  for (let i = 0; i < 300 && (await get('/')).status !== 200; i++) await new Promise((r) => setTimeout(r, 100))
  const root = await get('/')
  out(root.status === 200 && (root.headers.get('content-type') ?? '').includes('text/html'), `/ -> ${root.status} HTML`)
  const main = await get('/src/main.tsx')
  const js = await main.text()
  out(main.status === 200 && (main.headers.get('content-type') ?? '').includes('javascript'), `/src/main.tsx -> ${main.status} JavaScript`)
  const urls = [...js.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g)].map((m) => m[1])
  const answers = await Promise.all(urls.map(async (u) => [u, (await get(u)).status]))
  const bad = answers.filter(([, s]) => s !== 200)
  out(urls.some((u) => u.includes('react')) && bad.length === 0, `every import of main.tsx -> 200 (${urls.length}; refused: ${JSON.stringify(bad)})`)
  const probe = `probe-${Date.now()}`
  const home = fs.readFileSync('/tmp/seed/src/Home.tsx', 'utf8') + `\nexport const abProbe = "${probe}"\n`
  out((await push({ 'src/Home.tsx': Buffer.from(home).toString('base64') })) === 204, 'an edit pushed -> 204')
  let held = false
  for (let i = 0; i < 50 && !held; i++) {
    held = (await (await get(`/src/Home.tsx?t=${i}`)).text()).includes(probe)
    if (!held) await new Promise((r) => setTimeout(r, 100))
  }
  out(held, 'the pushed edit is in the next /src/Home.tsx')
  const touched = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`
    if (e.isDirectory() && !e.isSymbolicLink()) walk(p)
    else if (fs.lstatSync(p).mtimeMs > started) touched.push(p)
  } }
  try { walk('/ab') } catch (e) { touched.push(String(e)) }
  out(touched.length === 0, `nothing written under /ab (${touched.slice(0, 3).join(' ')})`)
  process.exit(failed ? 1 : 0)
})()
EOF
