import { timingSafeEqual } from 'node:crypto'

/**
 * apps-builder's own stamp, put on every request the proxy forwards: by the SSO proxy after SSO (resources 23,
 * 24) and by Traefik's `ab-origin-auth` middleware on the preview routers. Not x-origin-auth: on the
 * cluster that one is the Gateway's, and every route removes it before the app.
 */
export const ORIGIN_HEADER = 'x-ab-origin'
/** The cluster's stamp: never apps-builder's to check, never the app's to see. */
export const GATEWAY_HEADER = 'x-origin-auth'

/** Constant-time, and false whenever either side is empty: an unset secret matches nothing. */
export function matches(got: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !got) return false
  const a = Buffer.from(got)
  const b = Buffer.from(secret)
  // length must match first: timingSafeEqual throws on mismatched sizes
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The status that refuses a request which did not come through the proxy, or 0 to let it in.
 * Every port apps-builder opens is reachable from any container on the dev server or the proxy and from the
 * VPN, none of which ufw sees, so reaching a port proves nothing; this header does.
 * 503 when the secret is unset: a missing .env line takes the service down, never opens it.
 */
export const refused = (secret: string | undefined, got: string | null | undefined): 0 | 403 | 503 =>
  !secret ? 503 : matches(got, secret) ? 0 : 403
