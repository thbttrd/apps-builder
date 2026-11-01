/**
 * The slug becomes a DNS label in <slug>.preview.<domain>, so it must survive as one.
 *
 * A module of its own, with no imports, so the projects screen can use the same function the
 * server creates with: its one field searches and creates, and a name counts as taken when
 * this makes the slug of a project in its listing — the server's 409, as of that listing.
 */
export function slugify(name: string): string {
  // Truncate before trimming, never after: slicing can land on a separator, and
  // "<39 chars> b" then yields a 40-char slug ending in "-" whose own slugify is 39
  // chars. safeSlug() refuses anything that is not its own slugify, so a non-idempotent
  // slugify made those names uncreatable — measured: createProject threw
  // `invalid slug "aaa…-"` before anything reached disk.
  //
  // Accents come off before the rest goes, so "Café crème" is cafe-creme and not caf-cr-me:
  // NFD splits é into e and a combining mark, and the marks are dropped. What comes out is
  // still a-z, 0-9 and "-", where NFD changes nothing, so it stays its own slugify.
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
}
