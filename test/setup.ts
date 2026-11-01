/**
 * Preloaded by `bun test` (bunfig.toml), before any test file imports anything: project.ts
 * reads AB_PROJECTS_DIR and model.ts the key at module scope, and bun test shares one module
 * registry across files, so this is the only place they can be set in time. Never the real
 * ones: bun auto-loads .env, and a suite run against the real projects directory once ran
 * `git read-tree -u --reset` on a real project (the design log, check-restore's protection).
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll } from 'bun:test'

const scratch = join(import.meta.dir, '..', '.check-tests')
rmSync(scratch, { recursive: true, force: true })
process.env.AB_PROJECTS_DIR = scratch
// Not a key: the settings tests build the request a key would sign, and read it off a stub.
process.env.OPENROUTER_API_KEY = 'sk-check-not-a-key'

afterAll(() => rmSync(scratch, { recursive: true, force: true }))
