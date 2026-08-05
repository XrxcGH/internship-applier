/**
 * Polite HTTP client — see docs/04-job-discovery.md § Politeness and caching.
 *
 * One place for rate limiting, backoff, conditional requests, and robots.txt so every
 * source adapter is well-behaved by construction rather than by remembering to be.
 */
import { logger } from '../logger';

const USER_AGENT = 'internship-applier/0.1 (+local personal job-search tool)';
const DEFAULT_RPS = 1;
const MAX_ATTEMPTS = 5;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface Bucket {
  tokens: number;
  last: number;
  rps: number;
}

interface CacheEntry {
  body: string;
  etag?: string;
  lastModified?: string;
  at: number;
  status: number;
}

const buckets = new Map<string, Bucket>();
const cache = new Map<string, CacheEntry>();
const robots = new Map<string, Set<string>>();

/**
 * How many response bodies to keep at once.
 *
 * The TTL above decides whether a hit is SERVED, never whether an entry is dropped, so
 * every distinct URL a session touched used to stay resident for the life of the process.
 * A server left running across a few scheduled refreshes fetches thousands of posting
 * pages, and their HTML sat in memory with nothing bounding it.
 */
const MAX_CACHE_ENTRIES = 500;

/**
 * A cached body, if it is still worth having.
 *
 * Past the TTL an entry earns its keep only through its validators: an etag or a
 * last-modified turns the next request into a 304 instead of a download. Without either,
 * an expired body is a stale page taking up room and is dropped here.
 */
function readCache(url: string): CacheEntry | undefined {
  const entry = cache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.at < CACHE_TTL_MS) return entry;
  if (entry.etag ?? entry.lastModified) return entry;
  cache.delete(url);
  return undefined;
}

function rememberResponse(url: string, entry: CacheEntry): void {
  // Deleting before setting moves the key to the end, so map order is the order the bodies
  // were WRITTEN, not the order they were last read — reads leave the order alone on
  // purpose. What decides whether an entry is still worth anything here is its age: it is
  // dead six hours after it was fetched, and being read does not make it any fresher. So
  // the first key is the entry closest to expiring and is exactly the one to drop.
  // Promoting on read would invert that, keeping a body with minutes of life left and
  // evicting one downloaded seconds ago. The 304 path re-inserts as well, because a
  // not-modified answer really does restart the clock on that body.
  cache.delete(url);
  cache.set(url, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export interface FetchOptions {
  /** Requests per second for this host. Defaults to 1. */
  rps?: number;
  headers?: Record<string, string>;
  /** Skip robots.txt. Only for documented API endpoints, never for page fetches. */
  isDocumentedApi?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Strips credential-shaped query parameters out of a URL.
 *
 * Adzuna requires its app id and key in the query string, and there is no way around
 * that. What there is a way around is carrying them onward: the assembled URL was logged
 * verbatim on every retry and stored on the error, which pino's default serializer then
 * copies out of `err.url` when the discovery run logs the failure. Live API credentials
 * in a log file, in an app whose stated posture is that logs are redacted.
 */
export function scrubUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) {
      if (/key|secret|token|password|app_id|apikey/i.test(key))
        u.searchParams.set(key, '[redacted]');
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export class HttpError extends Error {
  readonly url: string;

  constructor(
    message: string,
    readonly status: number,
    url: string,
  ) {
    super(message);
    this.name = 'HttpError';
    this.url = scrubUrl(url);
  }
}

async function takeToken(host: string, rps: number): Promise<void> {
  const b = buckets.get(host) ?? { tokens: rps, last: Date.now(), rps };
  b.rps = rps;

  const now = Date.now();
  b.tokens = Math.min(rps, b.tokens + ((now - b.last) / 1000) * rps);
  b.last = now;

  if (b.tokens < 1) {
    const waitMs = ((1 - b.tokens) / rps) * 1000;
    buckets.set(host, b);
    await sleep(waitMs);
    return takeToken(host, rps);
  }

  b.tokens -= 1;
  buckets.set(host, b);
}

/**
 * Does a Disallow pattern match this path?
 *
 * The REP allows `*` as a wildcard and a trailing `$` as an end anchor, and a plain
 * `startsWith` treated both as literal characters — so "/*?page=" and "/*\/apply$" could
 * never match anything and were silently treated as permission to fetch. Every failure
 * mode of this function has to err toward NOT fetching.
 */
function robotsMatches(pattern: string, pathname: string): boolean {
  if (pattern === '/') return true;
  if (!pattern.includes('*') && !pattern.endsWith('$')) return pathname.startsWith(pattern);

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(pathname);
}

/**
 * Conservative parse: collects Disallow paths that apply to `*` or to us.
 *
 * "Conservative" was aspirational. Consecutive User-agent lines form ONE group under the
 * REP, but `applies` was reassigned by each line in turn, so
 *
 *     User-agent: *
 *     User-agent: AdsBot
 *     Disallow: /careers/
 *
 * left `applies` false and threw away a rule that binds us. Grouping is now accumulated
 * until the first non-User-agent line, which is what the standard actually says.
 *
 * Missing `Allow:` support stays missing on purpose: ignoring an Allow can only make this
 * refuse a fetch it could have made, and that is the direction to be wrong in.
 */
async function disallowedPaths(origin: string): Promise<Set<string>> {
  const cached = robots.get(origin);
  if (cached) return cached;

  const paths = new Set<string>();
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      // `group` collects the agents named since the last rule line; `applies` is whether
      // any of them is us. A rule line ends the run of agent lines.
      let group: string[] = [];
      let applies = false;
      let inGroup = false;

      for (const raw of (await res.text()).split('\n')) {
        const line = raw.split('#')[0]!.trim();
        if (!line) continue;
        const [k, ...rest] = line.split(':');
        const key = k?.toLowerCase().trim();
        const value = rest.join(':').trim();

        if (key === 'user-agent') {
          if (inGroup) {
            group = [];
            inGroup = false;
          }
          group.push(value);
          applies = group.some(
            (a) => a === '*' || USER_AGENT.toLowerCase().startsWith(a.toLowerCase()),
          );
        } else if (key === 'disallow') {
          inGroup = true;
          if (applies && value) paths.add(value);
        } else if (key === 'allow' || key === 'crawl-delay') {
          inGroup = true;
        }
      }
    }
  } catch {
    // No robots.txt, or unreachable — treat as unrestricted, which is the convention.
  }

  robots.set(origin, paths);
  return paths;
}

export async function politeFetch(url: string, opts: FetchOptions = {}): Promise<string> {
  const u = new URL(url);
  const host = u.host;

  if (!opts.isDocumentedApi) {
    const blocked = await disallowedPaths(u.origin);
    for (const p of blocked) {
      if (robotsMatches(p, u.pathname)) {
        throw new HttpError(`robots.txt disallows ${u.pathname}`, 403, url);
      }
    }
  }

  const hit = readCache(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;

  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await takeToken(host, opts.rps ?? DEFAULT_RPS);

    try {
      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        accept: 'application/json, text/html;q=0.9, */*;q=0.5',
        ...opts.headers,
      };
      if (hit?.etag) headers['if-none-match'] = hit.etag;
      if (hit?.lastModified) headers['if-modified-since'] = hit.lastModified;

      const res = await fetch(url, {
        headers,
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });

      if (res.status === 304 && hit) {
        rememberResponse(url, { ...hit, at: Date.now() });
        return hit.body;
      }

      if (res.status === 429 || res.status >= 500) {
        // Kept so the throw at the end of the loop carries the real status. Without it, a
        // source that answered 429 five times in a row surfaced as HttpError(status 0),
        // and the per-source health line the user reads said only that something failed —
        // not that it was a rate limit rather than an outage or a dead network.
        lastErr = new HttpError(`${res.status} ${res.statusText}`, res.status, url);

        // Waiting after the final attempt delays the error by up to thirty seconds and
        // changes nothing, because there is no attempt left to make.
        if (attempt === MAX_ATTEMPTS - 1) break;

        /**
         * Two bugs lived in one line here.
         *
         * `Number(null)` is 0 and `Number.isFinite(0)` is true, so an ABSENT Retry-After —
         * the common case on a 500 — produced a zero wait and the exponential backoff
         * documented in docs/04 never ran at all. And when the header WAS present it was
         * honoured uncapped, so a "Retry-After: 1800" parked a whole discovery run inside
         * one fetch for half an hour. An HTTP-date value is NaN and falls through to
         * backoff, which is the right outcome.
         */
        const header = res.headers.get('retry-after');
        const seconds = header === null ? Number.NaN : Number(header);
        const waitMs =
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
            : backoffMs(attempt);
        logger.debug({ url: scrubUrl(url), status: res.status, waitMs }, 'retrying after backoff');
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new HttpError(`${res.status} ${res.statusText}`, res.status, url);

      const body = await res.text();
      rememberResponse(url, {
        body,
        etag: res.headers.get('etag') ?? undefined,
        lastModified: res.headers.get('last-modified') ?? undefined,
        at: Date.now(),
        status: res.status,
      });
      return body;
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      if (attempt === MAX_ATTEMPTS - 1) break;
      await sleep(backoffMs(attempt));
    }
  }

  throw lastErr instanceof Error ? lastErr : new HttpError('request failed after retries', 0, url);
}

/**
 * A documented API endpoint, parsed.
 *
 * `isDocumentedApi` defaults on here, so every call through this function skips robots.txt.
 * That is right for the endpoints it exists for — Greenhouse, Lever, Ashby and Adzuna all
 * publish these as APIs — and wrong for anything that renders a page for humans. A page
 * goes through politeFetch even when it happens to return JSON. Pass
 * `isDocumentedApi: false` if a caller is ever unsure; the default is a convenience, not a
 * claim about the URL.
 */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  return JSON.parse(await politeFetch(url, { isDocumentedApi: true, ...opts })) as T;
}

/**
 * The longest a server's Retry-After is allowed to hold up a run.
 *
 * Deliberately close to the backoff ceiling. Waiting longer than this is not politeness,
 * it is a run that appears to have hung.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/** Exponential backoff with full jitter. */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(30_000, 500 * 2 ** attempt);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
