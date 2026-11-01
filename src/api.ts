/**
 * The client's view of the server's types — re-exported, never re-declared.
 *
 * These were four hand-written mirrors and they had already drifted (the server sends
 * `startedAt`; the copy here never had it). tsconfig puts `src` and `server` in one
 * program and `verbatimModuleSyntax` erases a type-only export whole, so nothing from
 * server/ reaches the bundle — this is a compile-time link and a build-time nothing.
 */
export type { Activity, Doing } from '../server/activity'
export type { ArtefactsView, DesignBrief } from '../server/agent'
export type { AskedPlan, Plan, Spec } from '../server/plan'
export type { ChatEvent, Usage } from '../server/stream'
export type { ChatGet, FileBody, House, Tree, Written } from '../server/routes'
export type { DesignView, DocView, ExampleId } from '../server/design'
export type { Edit } from '../shared/diff'
export type { RestoreMode, Snapshot, Timeline } from '../server/git'
export type { Project } from '../server/previews'
export type { Gate, Settings, SettingsChange } from '../shared/settings'
export type { VersionInfo, Entry, Section, Block } from '../server/version'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init)
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${r.status}`)
  return body as T
}

/** api(), sending `body` as JSON. */
export const json = <T>(path: string, method: 'POST' | 'PUT' | 'PATCH', body: unknown): Promise<T> =>
  api<T>(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
