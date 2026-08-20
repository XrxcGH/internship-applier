/**
 * The one rule about which hosts this tool will not touch — docs/04 § Tier C.
 *
 * This lived inside `sources/webSearch.ts`, where it read as a detail of one adapter, and it
 * was imported by exactly one caller: that adapter's own `siftCandidates`. Everything else
 * that opens a URL — the freshness refresh, the paste-a-URL route, the form-filling browser —
 * had no idea the rule existed.
 *
 * That gap turned the paste-the-text path into the opposite of its own promise. That path
 * exists so a student can bring a posting from Handshake, LinkedIn or Indeed WITHOUT this
 * tool ever contacting those sites, and it stores their address as the posting's identity on
 * the explicit undertaking that storing an address is not visiting one. But a stored address
 * is exactly what two other subsystems fetch: `refreshPostings` walks open postings and
 * `politeFetch`es each `canonical_url`, and the fill engine navigates a PERSISTENT, SIGNED-IN
 * Chromium profile to `apply_url`. So pasting a Handshake link — the careful path, the one
 * offered to avoid automated access — armed an unattended request to Handshake later, from
 * the browser profile carrying the student's own session.
 *
 * Hence a module of its own, named for the policy rather than for a source, so the next
 * subsystem that opens a URL finds it. A host on this list is refused everywhere, and the
 * refusal is always reported rather than silently swallowed.
 */

/**
 * Boards whose terms prohibit automated access, matched at the registrable brand.
 *
 * A model instruction is a request and this list is a rule: the web-search prompt already
 * asks the model not to return these, and this is the belt to those braces.
 */
export const AGGREGATOR_BRANDS = [
  'linkedin',
  // LinkedIn's own short-link domain, which is a different registrable name and so was not
  // covered by 'linkedin'. `https://lnkd.in/eXaMpLe` reduces to the brand 'lnkd'. These are
  // everywhere in search results and in employers' own social posts, so the model returns
  // them, and every one of them was two requests to LinkedIn infrastructure from the
  // student's address. The redirect to www.linkedin.com was caught by the per-hop check, so
  // no page content was read — but the rule this file states is that these hosts are never
  // fetched or opened, and fetching the short link is fetching one of them.
  'lnkd',
  'indeed',
  'glassdoor',
  'ziprecruiter',
  'joinhandshake',
  'handshake',
  'monster',
  'simplyhired',
  'lensa',
  'jobrapido',
  'talent',
  'bebee',
];

/**
 * Public suffixes that take two labels, so the registrable name is the third from the right.
 *
 * Deliberately short: it covers the country domains these particular boards actually run, and
 * a name that is not here is simply matched one label in, which is right for every ordinary
 * TLD. A full public-suffix list is a dependency and a download, and being wrong about
 * `glassdoor.co.uk` was the entire bug this replaced.
 */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'co.jp',
  'co.in',
  'co.nz',
  'co.za',
  'com.au',
  'com.br',
  'com.mx',
  'com.sg',
  'com.hk',
]);

/**
 * The brand a hostname is registered under: the label immediately left of its public suffix.
 *
 * Matched here rather than by host suffix, which only ever covered `.com` — so
 * `glassdoor.co.uk`, `monster.de` and `linkedin.cn` were not recognised as aggregators at
 * all: not dropped, but fetched, and a robots refusal then landed in "could not be read"
 * rather than in the policy-refusal count that exists to be visible.
 *
 * NOT `hostname.split('.').includes(brand)`: `talent` is on the list, and `talent.acme.com`
 * is an ordinary careers subdomain. That test would drop an employer's own page AND report
 * it to the student as somebody else's terms refusing us.
 */
function registrableBrand(hostname: string): string | null {
  // The trailing dot of a fully-qualified name, and only that: an unescaped `.` here matched
  // any last character and quietly ate the final letter of every hostname, so "co.uk" arrived
  // as "co.u" and no two-label suffix was ever recognised.
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  const index = TWO_LABEL_SUFFIXES.has(lastTwo) ? labels.length - 3 : labels.length - 2;
  return index >= 0 ? (labels[index] ?? null) : null;
}

/**
 * Whether this tool refuses to open the URL at all.
 *
 * A string that will not parse as a URL answers false, because "not a URL" is a different
 * complaint with a different message, and every caller here is already validating shape.
 * `URL.hostname` is what is matched, so credentials (`https://x@linkedin.com/`), ports and
 * case are all handled by the parser rather than by this list.
 */
export function isAggregatorUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const brand = registrableBrand(new URL(url).hostname);
  return brand !== null && AGGREGATOR_BRANDS.includes(brand);
}

/**
 * What to tell the student when a refusal reaches them, in their words rather than ours.
 *
 * One sentence, one place, because this is said on three screens now and three copies would
 * drift. It names the way forward, since a refusal with no alternative reads as a dead end
 * when in fact the tool has a whole path built for exactly this posting.
 */
export const AGGREGATOR_REFUSAL =
  'This tool does not open LinkedIn, Indeed, Glassdoor or Handshake — their terms refuse ' +
  'automated visits, and Handshake needs your school login besides. Open the posting there ' +
  'yourself, then paste its text into "Handshake, LinkedIn or Indeed" on the Discover screen.';
