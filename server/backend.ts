/**
 * Where a preview's pod runs: rootless podman beside apps-builder (dev on the dev server, and
 * the check suite), or the cluster (kube.ts, when AB_PREVIEW_NAMESPACE is set). One pod spec (pod.ts) for
 * both; what differs is who runs it, the address it answers on and where its databases keep their data.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeKube } from './kube'
import type { Pod, Service, Volume } from './pod'
import { makePodman } from './podman'
import { PROJECTS_DIR } from './project'

/** Base URLs of a running preview's two ports, e.g. `http://127.0.0.1:41234`. */
export type Address = { vite: string; control: string }

export type Backend = {
  /** Resolves once the pod is created and has an address, not once it answers: the caller waits for that. */
  run(spec: Pod): Promise<Address>
  /** Stops and removes one pod; quiet when it is already gone. Resolves once it is. */
  remove(name: string): Promise<void>
  /** Every pod of this instance, the ones a killed predecessor left included: pods outlive apps-builder. */
  removeAll(): Promise<void>
  /** Resolves when the pod's preview container ends, or the pod goes. */
  exited(name: string): Promise<void>
  /** A container's last lines, for an error or check_app's report. */
  logs(name: string, container: string): Promise<string>
  /** The databases' volume, made ready; undefined when the app has neither Redis nor Postgres. */
  dataVolume(slug: string, dataId: string, services: readonly Service[]): Promise<Volume | undefined>
  removeData(slug: string, dataId: string): Promise<void>
  renameData(from: string, to: string): Promise<void>
}

/** Which apps-builder a pod is: dev, staging and the check suite share one podman. */
export const INSTANCE = Bun.hash(PROJECTS_DIR).toString(36).slice(0, 6)

/** The pod's own service-account mount (the cluster's apps-builder container). */
const SA = '/var/run/secrets/kubernetes.io/serviceaccount'
const NAMESPACE = Bun.env.AB_PREVIEW_NAMESPACE

export const backend: Backend = NAMESPACE
  ? makeKube(
      'https://kubernetes.default.svc',
      // Read at every call: a projected token is rotated under the process.
      () => readFileSync(join(SA, 'token'), 'utf8').trim(),
      readFileSync(join(SA, 'ca.crt'), 'utf8'),
      NAMESPACE,
      INSTANCE,
    )
  : makePodman(INSTANCE, join(PROJECTS_DIR, '.data'))
