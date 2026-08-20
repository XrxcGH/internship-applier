/**
 * robots.txt, and what happens when a host will not hand one over — docs/04 § Politeness.
 *
 * RFC 9309 § 2.3.1 gives three different answers for three different failures, and the
 * fetcher collapsed them into one: anything that was not a 200 fell into the same
 * catch-and-carry-on as a DNS failure, cached an empty disallow set for the life of the
 * process, and read as "nothing here is off limits". A site in a maintenance window served
 * 503 for its robots.txt and had its whole careers section crawled — including, once the
 * maintenance ended, the paths it had been disallowing all along.
 *
 * These run against real local servers rather than a stubbed `fetch`, because the thing
 * under test is what the fetcher does with a status code it was handed, and a stub would be
 * the test asserting its own assumption about how the request is made. Each case gets its
 * own server, so each gets its own origin — the robots cache is keyed by origin and lives
 * for the life of the process.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError, politeFetch } from '../src/infra/http/fetcher';

interface Reply {
  status: number;
  body: string;
}

const running: Server[] = [];

afterEach(() => {
  while (running.length > 0) running.pop()?.close();
});

/** A host on a fresh port, so it gets a robots cache entry of its own. */
async function host(reply: (url: string) => Reply): Promise<string> {
  const server = createServer((req, res) => {
    const out = reply(req.url ?? '/');
    res.writeHead(out.status, { 'content-type': 'text/plain' });
    res.end(out.body);
  });
  running.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}`;
}

const page = (url: string): Reply =>
  url === '/robots.txt' ? { status: 404, body: '' } : { status: 200, body: `page ${url}` };

describe('a robots.txt that could not be read', () => {
  /**
   * Every status that means "ask me later", not only the 503 that started this. 429 is in
   * here because it is the one case the status class does not tell you about: it is not a
   * 5xx, and grouping it by its class would read a rate limit as the site having said
   * nothing at all.
   */
  it.each([[429], [500], [502], [503]])(
    'refuses the fetch on %i, and says the file was unreadable rather than inventing a rule',
    async (status) => {
      const origin = await host((url) =>
        url === '/robots.txt' ? { status, body: 'maintenance' } : page(url),
      );

      const err = await politeFetch(`${origin}/careers/1`).then(
        () => null,
        (e: unknown) => e as HttpError,
      );

      expect(err).toBeInstanceOf(HttpError);
      expect(err?.status).toBe(403);
      // The refusal is shown to the user on the source-health line, so "robots.txt
      // disallows /careers/" would be a false claim about a file nobody managed to read.
      expect(err?.message).toMatch(/robots\.txt could not be read/);
      expect(err?.message).toContain(String(status));
      expect(err?.message).not.toMatch(/disallows/);
    },
  );

  it.each([[404], [403], [410]])(
    'treats %i as the site having said nothing, and fetches',
    async (status) => {
      // Absent is not the same as unavailable. A site with no robots.txt to serve has not
      // restricted anything, and refusing here would turn every board without one into a
      // dead source.
      const origin = await host((url) =>
        url === '/robots.txt' ? { status, body: '' } : page(url),
      );
      expect(await politeFetch(`${origin}/careers/1`)).toBe('page /careers/1');
    },
  );
});

describe('a robots.txt that states a rule', () => {
  it('obeys the disallowed path and leaves the rest of the site alone', async () => {
    const origin = await host((url) =>
      url === '/robots.txt'
        ? { status: 200, body: 'User-agent: *\nDisallow: /careers/\n' }
        : page(url),
    );

    const err = await politeFetch(`${origin}/careers/x`).then(
      () => null,
      (e: unknown) => e as HttpError,
    );
    expect(err?.status).toBe(403);
    expect(err?.message).toMatch(/disallows/);

    // A rule that refused everything would be indistinguishable from a broken parse.
    expect(await politeFetch(`${origin}/jobs/x`)).toBe('page /jobs/x');
  });
});

describe('a request that carries a body', () => {
  /**
   * `jsonBody` exists for exactly one endpoint family: Workday's board API answers only to
   * POST, with the same query every visitor's browser sends to render the company's own
   * careers page. Two properties matter and both are held here.
   */
  it('sends a POST with the JSON body and the right content type', async () => {
    let seen: { method?: string; type?: string; body?: string } = {};
    const server = createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(404).end();
        return;
      }
      let chunks = '';
      req.on('data', (c: Buffer) => (chunks += c.toString()));
      req.on('end', () => {
        seen = { method: req.method, type: req.headers['content-type'], body: chunks };
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    await politeFetch(`${origin}/wday/cxs/acme/External/jobs`, {
      isDocumentedApi: true,
      jsonBody: { appliedFacets: {}, limit: 1, offset: 0, searchText: 'intern' },
    });
    expect(seen.method).toBe('POST');
    expect(seen.type).toBe('application/json');
    expect(JSON.parse(seen.body ?? '{}')).toMatchObject({ searchText: 'intern' });
  });

  /**
   * The response cache is keyed by URL alone. Two different queries POST to one URL, so a
   * cached answer would hand the second query the first query's postings; a body request
   * must neither read the cache nor write it.
   */
  it('never serves a POST from the cache a GET filled, and never fills it', async () => {
    let calls = 0;
    const origin = await host((url) => {
      if (url === '/robots.txt') return { status: 404, body: '' };
      calls++;
      return { status: 200, body: `answer ${String(calls)}` };
    });

    // A GET primes the cache; the POSTs must not see it, and must each hit the server.
    expect(await politeFetch(`${origin}/jobs`, { isDocumentedApi: true })).toBe('answer 1');
    expect(
      await politeFetch(`${origin}/jobs`, { isDocumentedApi: true, jsonBody: { offset: 0 } }),
    ).toBe('answer 2');
    expect(
      await politeFetch(`${origin}/jobs`, { isDocumentedApi: true, jsonBody: { offset: 20 } }),
    ).toBe('answer 3');
    // And the POSTs must not have poisoned the cache for the next GET.
    expect(await politeFetch(`${origin}/jobs`, { isDocumentedApi: true })).toBe('answer 1');
  });
});

/**
 * Where a redirect actually goes is a host nobody checked.
 *
 * Node's fetch defaults to `redirect: 'follow'`, so a 301 to another origin was fetched with
 * that origin's robots.txt never read, its rate-limit bucket never touched, and the sourcing
 * rule never re-applied — every caller checks the string it is about to pass, and nothing
 * re-checked the destination. Aggregator listings are reached through exactly this shape: a
 * short link, or an employer page that bounces to a board.
 */

/** A host that can answer with headers, which the plain helper above cannot. */
async function hostWithHeaders(
  reply: (url: string) => { status: number; body: string; headers?: Record<string, string> },
): Promise<string> {
  const server = createServer((req, res) => {
    const out = reply(req.url ?? '/');
    res.writeHead(out.status, { 'content-type': 'text/plain', ...(out.headers ?? {}) });
    res.end(out.body);
  });
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('following a redirect', () => {
  it('reads the DESTINATION host robots.txt, not the one it started at', async () => {
    // The whole point. The first host allows everything; the second forbids the path the
    // redirect lands on, and that refusal has to be the one that counts.
    const blocked = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 200, body: 'User-agent: *\nDisallow: /private' }
        : { status: 200, body: 'secret' },
    );
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : { status: 301, body: '', headers: { location: `${blocked}/private/job` } },
    );

    await expect(politeFetch(`${start}/go`)).rejects.toThrow(/robots\.txt disallows \/private/);
  });

  it('follows one that is allowed, and answers with the destination body', async () => {
    const target = await hostWithHeaders((url) =>
      url === '/robots.txt' ? { status: 404, body: '' } : { status: 200, body: 'arrived' },
    );
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : { status: 302, body: '', headers: { location: `${target}/job` } },
    );

    await expect(politeFetch(`${start}/go`)).resolves.toBe('arrived');
  });

  it('resolves a relative Location against the address it came from', async () => {
    // Legal and common, and a naive `new URL(location)` would throw on it.
    const server = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : url === '/go'
          ? { status: 302, body: '', headers: { location: '/landed' } }
          : { status: 200, body: 'relative ok' },
    );
    await expect(politeFetch(`${server}/go`)).resolves.toBe('relative ok');
  });

  // Six sequential round trips against a live local server, each a full re-entry with its
  // own robots read. It fits inside the default timeout alone and not always under the load
  // of the whole suite, which is a property of the harness rather than of the code.
  it('gives up on a cycle rather than recursing forever', { timeout: 20_000 }, async () => {
    const server = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : { status: 302, body: '', headers: { location: '/loop' } },
    );
    // `rps` raised only so the test is not fighting the rate limiter: every hop is a full
    // re-entry and takes its own token, so five hops at the default 1/s is five seconds — the
    // limiter doing its job, and longer than the default test timeout.
    await expect(politeFetch(`${server}/loop`, { rps: 50 })).rejects.toThrow(
      /More than 5 redirects/,
    );
  });

  it('refuses a redirect that lands on a board this tool will not open', async () => {
    // The one check that cannot wait for the recursion: politeFetch does not know its
    // caller's policy, but it does know no path in this app may open these hosts.
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : {
            status: 301,
            body: '',
            headers: { location: 'https://www.linkedin.com/jobs/view/123' },
          },
    );
    await expect(politeFetch(`${start}/go`)).rejects.toThrow(/does not\s+open/);
  });

  it('says so when a redirect names nowhere to go', async () => {
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt' ? { status: 404, body: '' } : { status: 302, body: '' },
    );
    await expect(politeFetch(`${start}/go`)).rejects.toThrow(/no Location header/);
  });
});
