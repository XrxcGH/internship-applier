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

export interface FetchOptions {
  /** Requests per second for this host. Defaults to 1. */
  rps?: number;
  headers?: Record<string, string>;
  /** Skip robots.txt. Only for documented API endpoints, never for page fetches. */
  isDocumentedApi?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
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

/** Conservative parse: collects Disallow paths that apply to `*` or to us. */
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
      let applies = false;
      for (const raw of (await res.text()).split('\n')) {
        const line = raw.split('#')[0]!.trim();
        const [k, ...rest] = line.split(':');
        const key = k?.toLowerCase().trim();
        const value = rest.join(':').trim();
        if (key === 'user-agent') {
          applies = value === '*' || USER_AGENT.toLowerCase().startsWith(value.toLowerCase());
        } else if (key === 'disallow' && applies && value) {
          paths.add(value);
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
      if (p === '/' || u.pathname.startsWith(p)) {
        throw new HttpError(`robots.txt disallows ${u.pathname}`, 403, url);
      }
    }
  }

  const hit = cache.get(url);
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
        cache.set(url, { ...hit, at: Date.now() });
        return hit.body;
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffMs(attempt);
        logger.debug({ url, status: res.status, waitMs }, 'retrying after backoff');
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new HttpError(`${res.status} ${res.statusText}`, res.status, url);

      const body = await res.text();
      cache.set(url, {
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

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  return JSON.parse(await politeFetch(url, { isDocumentedApi: true, ...opts })) as T;
}

/** Exponential backoff with full jitter. */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(30_000, 500 * 2 ** attempt);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Test-only. */
export function resetHttpState(): void {
  buckets.clear();
  cache.clear();
  robots.clear();
}
