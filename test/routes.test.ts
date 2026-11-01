/**
 * routes.ts's `app`, in-process: what a request meets once gate() has let it through. A preview's
 * page is same-site with the UI (`*.example.net`), so the browser sends the SSO cookie with its
 * requests to the UI's API, and the proxy stamps the origin header on them as on any other.
 */
import { expect, test } from 'bun:test'
import { app } from '../server/routes'

// A write with no side effect here: there is no turn to stop on a project that does not exist.
const stop = (site?: string) =>
  app.request('/api/projects/no-such-project/chat/stop', { method: 'POST', headers: site ? { 'sec-fetch-site': site } : {} })

test("a write from another origin is refused: a preview's page, same-site, or any other site", async () => {
  expect((await stop('same-site')).status).toBe(403)
  expect((await stop('cross-site')).status).toBe(403)
})

test("the UI's own writes pass, and so do scripts and curl, which send no Sec-Fetch-Site", async () => {
  expect((await stop('same-origin')).status).toBe(200)
  expect((await stop()).status).toBe(200)
})

test('reads from another origin are not refused: the browser keeps their answer from the page', async () => {
  expect((await app.request('/api/health', { headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(200)
})
