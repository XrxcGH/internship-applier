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
