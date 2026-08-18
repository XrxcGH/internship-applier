/**
 * Company → board resolution, and above all its manners: the resolver speaks to six
 * vendors on the open internet for every name typed into Discover, so what it does when a
 * vendor says "no" matters as much as what it does on a hit. A 404, a Workday 422 and a
 * tenant host that fails DNS are all the ordinary answer to "does this company use this
 * vendor?" and must pass in silence; and the Workday probe must stay inside its stated
 * bound, because the search space it probes is infinite and a resolver that wanders it is
 * a crawler.
 *
 * The other half of the same subject, and the reason the SmartRecruiters cases below exist:
 * a vendor can say "no" by answering 200. Every test here that routes a non-target URL to a
 * 404 is describing four of the five GET vendors; the fifth answers `totalFound: 0` for
 * every id there is, and a probe that read that as a board returned one for every name.
 *
 * The fetch mock replaces `globalThis.fetch` the way sources.test.ts does — the polite
 * fetcher in between is real, so these tests exercise the same retry and error paths the
 * live resolver goes through. Slugs are unique per test because the fetcher caches GET
 * bodies by URL for the life of the module.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCompany } from '../src/core/discovery/resolveCompany';
import { logger } from '../src/infra/logger';

const realFetch = globalThis.fetch;

interface SeenRequest {
  url: string;
  method: string;
  body: string | null;
}

let seen: SeenRequest[] = [];

/** Routes every request; returning an Error rejects the fetch with it. */
function install(route: (url: string) => Response | Error): void {
  seen = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const out = route(url);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }) as typeof globalThis.fetch;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const notFound = (): Response => new Response('Not Found', { status: 404 });

/**
 * What api.smartrecruiters.com really answers for an id it has no company for — and,
 * indistinguishably, for a real company with nothing posted today. Probed live against
 * "zzqqwwxxnotacompany", "qqq-www-eee-not-real", "acmewidget", and against `Ubisoft` and
 * `McDonalds`, which are real SmartRecruiters companies: all five answer exactly this.
 */
const srNothing = (): Response => json({ offset: 0, limit: 1, totalFound: 0, content: [] });

/** What the wd1/wd5 wildcard DNS answers for a name with no tenant behind it. */
const unprocessable = (): Response => new Response('{}', { status: 422 });

/** How undici surfaces a host name that does not resolve. */
const dnsFailure = (): Error =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
  });

const workdayRequests = (): SeenRequest[] => seen.filter((s) => s.url.includes('myworkdayjobs'));

/**
 * Makes the fetcher's sleeps instant without fake timers.
 *
 * The polite fetcher retries a failed request through several seconds of backoff, and its
 * token bucket sleeps for fractional milliseconds when a host's tokens run low. Vitest's
 * fake timers floor those fractions to zero, so the bucket's wait-and-recheck loop
 * re-slept for the same sub-millisecond wait forever and `runAllTimersAsync` aborted at
 * its ten-thousand-timer guard — intermittently, since reaching a fractional token state
 * depends on floating-point drift. This helper sidesteps the whole class: every
 * `setTimeout` advances a virtual `Date.now` by the FULL delay it asked for and fires on
 * the next real tick, so the bucket refills exactly as if the wait had happened and a
 * backoff of seconds costs one macrotask. The advance is at least a millisecond, because
 * the same floating-point convergence exists here too: a bucket left at 0.999... tokens
 * asks for an ever-smaller wait each round, and a clock that only advances by what was
 * asked never gets it over the line.
 */
function fastForwardSleeps(): void {
  const realSetTimeout = globalThis.setTimeout;
  let virtualNow = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => virtualNow);
  vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
    virtualNow += Math.max(1, ms ?? 0);
    return realSetTimeout(fn, 0);
  }) as unknown as typeof setTimeout);
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the SmartRecruiters and Workable probes', () => {
  it('reports the totalFound a SmartRecruiters board states, not the page it fetched', async () => {
    // The probe asks for a single row; totalFound rides along on it. Counting rows would
    // cap every SmartRecruiters board at the page size, the mistake the Lever probe
    // already documents.
    const warn = vi.spyOn(logger, 'warn');
    install((url) =>
      url.includes('api.smartrecruiters.com/v1/companies/srfixture/postings')
        ? json({ offset: 0, limit: 1, totalFound: 240, content: [{ id: '1' }] })
        : url.includes('myworkdayjobs')
          ? unprocessable()
          : notFound(),
    );

    const found = await resolveCompany('Srfixture');
    expect(found.matches).toEqual([
      { source: 'smartrecruiters', board: 'srfixture', jobCount: 240, fromFullName: true },
    ]);
    expect(found.notes).toEqual([]);
    // The five 404s and six Workday 422s around the hit are ordinary answers, not noise.
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts the jobs a Workable widget lists', async () => {
    install((url) =>
      url.includes('apply.workable.com/api/v1/widget/accounts/wkfixture')
        ? json({ name: 'Wk Fixture', description: '<p>hi</p>', jobs: [{}, {}, {}] })
        : url.includes('myworkdayjobs')
          ? unprocessable()
          : notFound(),
    );

    expect((await resolveCompany('Wkfixture')).matches).toEqual([
      { source: 'workable', board: 'wkfixture', jobCount: 3, fromFullName: true },
    ]);
  });

  /**
   * The 200 that means nothing.
   *
   * SmartRecruiters does not 404 an id it has no company for; it answers 200 with
   * `totalFound: 0`. Read as a hit, that returned a SmartRecruiters board for EVERY name
   * typed into Discover — including names of companies that do not exist — so the resolver
   * always had at least one match, the "no board answered" branch of the Discover screen
   * became unreachable, and an invented board is a fact the student cannot check.
   */
  it('does not report a SmartRecruiters board for a name it answered 200 with nothing for', async () => {
    install((url) =>
      url.includes('api.smartrecruiters.com')
        ? srNothing()
        : url.includes('myworkdayjobs')
          ? unprocessable()
          : notFound(),
    );

    const found = await resolveCompany('Zzqqwwxxnotafixture');
    expect(found.matches).toEqual([]);
    // And the loss is said out loud, because an empty list otherwise reads as "no board at
    // any of these vendors" — a claim this probe cannot make about SmartRecruiters.
    expect(found.notes).toHaveLength(1);
    expect(found.notes[0]).toMatch(/SmartRecruiters/);
  });

  /**
   * The consequence that made it worse than a wrong row: `found.length > 0` ended the walk,
   * so the phantom match on candidate 1 stopped the resolver before the hyphenated slug
   * where the company's real, 41-job Greenhouse board actually lives.
   */
  it('goes on to the next slug candidate when the only answers proved nothing', async () => {
    install((url) =>
      url === 'https://boards-api.greenhouse.io/v1/boards/hyphen-fixture/jobs'
        ? json({ jobs: Array.from({ length: 41 }, (_, i) => ({ id: i })) })
        : url.includes('api.smartrecruiters.com')
          ? srNothing()
          : url.includes('myworkdayjobs')
            ? unprocessable()
            : notFound(),
    );

    const found = await resolveCompany('Hyphen Fixture Co');
    expect(found.matches).toEqual([
      { source: 'greenhouse', board: 'hyphen-fixture', jobCount: 41, fromFullName: true },
    ]);
  });

  /**
   * The first word of a two-word company is somebody else's whole name. "Vector Health"
   * yields the slug "vector", and ashby:vector is a real board with real openings at a
   * different company; ten of ten realistic two-word names hit a live board this way when
   * it was measured. The answer is still worth showing — it may well be the right board —
   * but the caller that writes resolutions into the database must be able to tell it apart,
   * or an unverified guess becomes an enabled search target for a company nobody named.
   */
  it('marks a board found only under the first word as not from the full name', async () => {
    install((url) =>
      url === 'https://api.ashbyhq.com/posting-api/job-board/vector'
        ? json({ jobs: Array.from({ length: 7 }, (_, i) => ({ id: i })) })
        : url.includes('api.smartrecruiters.com')
          ? srNothing()
          : url.includes('myworkdayjobs')
            ? unprocessable()
            : notFound(),
    );

    const found = await resolveCompany('Vector Health');
    expect(found.matches).toEqual([
      { source: 'ashby', board: 'vector', jobCount: 7, fromFullName: false },
    ]);
  });

  /**
   * A one-word company name is not a truncation of itself.
   *
   * A different slug from the case above on purpose: the fetcher caches a GET body by URL
   * for the life of the process, so two tests asking the same board URL would have the
   * second one silently assert against the first one's answer.
   */
  it('does not mark a single-word company as a first-word guess', async () => {
    install((url) =>
      url === 'https://api.ashbyhq.com/posting-api/job-board/solofixture'
        ? json({ jobs: [{ id: 1 }] })
        : url.includes('api.smartrecruiters.com')
          ? srNothing()
          : url.includes('myworkdayjobs')
            ? unprocessable()
            : notFound(),
    );

    const found = await resolveCompany('SoloFixture');
    expect(found.matches).toEqual([
      { source: 'ashby', board: 'solofixture', jobCount: 1, fromFullName: true },
    ]);
  });

  /**
   * SmartRecruiters answers 200 with totalFound:0 for every id there is, so this note rides
   * on essentially every resolve. It used to end by telling the reader to go and open the
   * company's board and paste a URL — right when nothing answered, and quite wrong when the
   * same response had just handed them a board with openings on it. The fact is always said;
   * only the advice moves.
   */
  it('tells the reader what to do about the unchecked vendor, and it depends', async () => {
    install((url) =>
      url === 'https://boards-api.greenhouse.io/v1/boards/foundco/jobs'
        ? json({ jobs: [{ id: 1 }, { id: 2 }] })
        : url.includes('api.smartrecruiters.com')
          ? srNothing()
          : url.includes('myworkdayjobs')
            ? unprocessable()
            : notFound(),
    );
    const found = await resolveCompany('Foundco');
    expect(found.matches.length).toBeGreaterThan(0);
    const said = found.notes.join(' ');
    // The fact still gets said: one board found is not "and nowhere else".
    expect(said).toMatch(/SmartRecruiters/);
    expect(said).toMatch(/not everywhere this company posts/);
    // And not the advice meant for a reader who has nothing.
    expect(said).not.toMatch(/paste one of its job URLs/);
  });

  it('keeps the paste-a-URL advice when nothing answered at all', async () => {
    install((url) =>
      url.includes('api.smartrecruiters.com')
        ? srNothing()
        : url.includes('myworkdayjobs')
          ? unprocessable()
          : notFound(),
    );
    const found = await resolveCompany('Missingco');
    expect(found.matches).toEqual([]);
    expect(found.notes.join(' ')).toMatch(/paste one of its job URLs/);
  });

  /**
   * A 200 whose body is not a board at all is drift, not a board with zero jobs. Every
   * count used to end in `?? 0`, so an Ashby deprecation notice served with a 200 was
   * reported to the user as "this company's ATS is Ashby, with nothing posted".
   */
  it('logs a 200 that is not a board answer instead of reporting a board', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    install((url) =>
      url.includes('api.ashbyhq.com')
        ? json({ errors: ['this endpoint has moved'] })
        : url.includes('api.smartrecruiters.com')
          ? srNothing()
          : url.includes('myworkdayjobs')
            ? unprocessable()
            : notFound(),
    );

    const found = await resolveCompany('Driftfixture');
    expect(found.matches).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('a board with nothing posted', () => {
  /**
   * The rule the SmartRecruiters change must not quietly repeal: for the four vendors that
   * 404 a name they have no company for, a 200 carrying an empty jobs array IS the answer
   * to the question the caller asked — which vendor this company uses — and is returned
   * with a count of zero. `apply.workable.com/.../accounts/stripe` is a live example: a
   * real account, named, with nothing open.
   */
  it('is still returned by the vendors whose 200 proves the board exists', async () => {
    install((url) =>
      url.includes('apply.workable.com/api/v1/widget/accounts/emptyboardfixture')
        ? json({ name: 'Emptyboardfixture', description: null, jobs: [] })
        : url.includes('api.smartrecruiters.com')
          ? srNothing()
          : url.includes('myworkdayjobs')
            ? unprocessable()
            : notFound(),
    );

    expect((await resolveCompany('Emptyboardfixture')).matches).toEqual([
      { source: 'workable', board: 'emptyboardfixture', jobCount: 0, fromFullName: true },
    ]);
  });

  /**
   * ...but it does not end the multi-candidate walk, and this is the sibling of the
   * SmartRecruiters bug rather than the bug itself. A slug can belong to a DIFFERENT
   * company at another vendor, so a zero-count hit on candidate 1 is exactly the case
   * candidates 2 and 3 exist for. Stopping on one buried a 41-job board again.
   */
  it('does not stop the walk, and the board with openings sorts above it', async () => {
    install((url) =>
      url === 'https://boards-api.greenhouse.io/v1/boards/quiet-fixture/jobs'
        ? json({ jobs: Array.from({ length: 41 }, (_, i) => ({ id: i })) })
        : url.includes('apply.workable.com/api/v1/widget/accounts/quietfixture')
          ? json({ name: 'Quietfixture, somebody else entirely', description: null, jobs: [] })
          : url.includes('api.smartrecruiters.com')
            ? srNothing()
            : url.includes('myworkdayjobs')
              ? unprocessable()
              : notFound(),
    );

    expect((await resolveCompany('Quiet Fixture Co')).matches).toEqual([
      { source: 'greenhouse', board: 'quiet-fixture', jobCount: 41, fromFullName: true },
      { source: 'workable', board: 'quietfixture', jobCount: 0, fromFullName: true },
    ]);
  });

  /**
   * And the walking-on stays inside the bound the header states. Three slug candidates that
   * each turn up nothing but an empty board is the most expensive shape there is now, and
   * it costs what a company with no board anywhere has always cost.
   */
  it('costs no more than the stated 33 requests even when every candidate is walked', async () => {
    install((url) =>
      url.includes('apply.workable.com/api/v1/widget/accounts/')
        ? json({ name: 'Boundless', description: null, jobs: [] })
        : url.includes('api.smartrecruiters.com')
          ? srNothing()
          : url.includes('myworkdayjobs')
            ? unprocessable()
            : notFound(),
    );

    const found = await resolveCompany('Boundless Zero Co');
    expect(found.matches.map((m) => m.board)).toEqual([
      'boundlesszero',
      'boundless-zero',
      'boundless',
    ]);
    expect(seen).toHaveLength(33);
  });
});

describe('the Workday probe', () => {
  it('resolves a board as tenant@host/site and stops probing at the hit', async () => {
    install((url) =>
      url === 'https://wdfixture.wd1.myworkdayjobs.com/wday/cxs/wdfixture/External/jobs'
        ? json({ total: 57, jobPostings: [{ title: 'Intern' }] })
        : notFound(),
    );

    const found = await resolveCompany('Wdfixture');
    expect(found.matches).toEqual([
      { source: 'workday', board: 'wdfixture@wd1/External', jobCount: 57, fromFullName: true },
    ]);

    // Site order is [slug, External, careers]: the slug site 404s, External hits, and
    // nothing after the hit — not careers, not anything on wd5 — is asked for.
    expect(workdayRequests().map((s) => s.url)).toEqual([
      'https://wdfixture.wd1.myworkdayjobs.com/wday/cxs/wdfixture/wdfixture/jobs',
      'https://wdfixture.wd1.myworkdayjobs.com/wday/cxs/wdfixture/External/jobs',
    ]);
    // And the probe is the documented POST asking for a single posting, not a page pull.
    const hit = workdayRequests()[1]!;
    expect(hit.method).toBe('POST');
    expect(JSON.parse(hit.body ?? '')).toMatchObject({ limit: 1, offset: 0 });
  });

  it('never exceeds the stated bound: six POSTs beside five GETs for one slug candidate', async () => {
    // "Boundfixture" yields exactly one slug candidate, so the whole resolve is one
    // round: 5 GET probes plus 2 hosts × 3 sites. The resolver's header comment states
    // 11 per candidate and 33 worst-case; this is the test that keeps the number honest.
    const warn = vi.spyOn(logger, 'warn');
    install(() => notFound());

    expect((await resolveCompany('Boundfixture')).matches).toEqual([]);
    expect(workdayRequests()).toHaveLength(6);
    expect(seen).toHaveLength(11);
    // 404 on every probe is the ordinary "no board anywhere" answer and logs nothing.
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a tenant host that fails DNS as "not Workday" — silent, and the host is not re-asked', async () => {
    // The fetcher retries a DNS failure through its whole backoff budget before giving
    // up, so the sleeps are fast-forwarded; the assertions below count distinct URLs,
    // not fetch attempts, because the retries belong to the fetcher's policy, not ours.
    const warn = vi.spyOn(logger, 'warn');
    install((url) => (url.includes('myworkdayjobs') ? dnsFailure() : notFound()));

    fastForwardSleeps();
    const found = await resolveCompany('Deadhostfixture');

    expect(found.matches).toEqual([]);
    // No warning: a name that is not a Workday tenant is the common case for every
    // resolve, and a warn per slug would bury the log lines that mean something.
    expect(warn).not.toHaveBeenCalled();
    // One probe per host and no more. A dead host cannot hold any site, and each dead
    // fetch already costs the fetcher's full retry budget, so the remaining site
    // candidates on that host are skipped rather than paid for twice more.
    const distinct = [...new Set(workdayRequests().map((s) => s.url))];
    expect(distinct).toEqual([
      'https://deadhostfixture.wd1.myworkdayjobs.com/wday/cxs/deadhostfixture/deadhostfixture/jobs',
      'https://deadhostfixture.wd5.myworkdayjobs.com/wday/cxs/deadhostfixture/deadhostfixture/jobs',
    ]);
  });

  it('still warns when a probe fails in a way that means "never actually checked"', async () => {
    // The silence above is deliberate, not missing: an answer that is neither a hit nor
    // any form of "no board here" — a 500, say — means the vendor was not checked, and
    // the caller sees the same empty result as a company with no board. That ambiguity
    // is exactly what the existing GET probes log, and Workday keeps the same rule.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    install((url) =>
      url.includes('myworkdayjobs') ? new Response('oops', { status: 500 }) : notFound(),
    );

    fastForwardSleeps();
    expect((await resolveCompany('Failfixture')).matches).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
