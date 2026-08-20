import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier B: the model finds candidate URLs, and this process decides what becomes a posting.
 *
 * The properties held here are the sourcing policy itself. The model's word is never stored —
 * every posting comes out of `fetchManualPosting`, the robots-respecting reader — and the
 * boards whose terms refuse automated reads are dropped even when the model returns them
 * anyway. The model and the fetcher are both mocked because neither is what is under test:
 * what is under test is the adapter's refusals, its counts, and its honesty when either
 * dependency misbehaves.
 */

const h = vi.hoisted(() => ({
  answer: null as unknown,
  generateError: null as Error | null,
  generateCalls: [] as Array<Record<string, unknown>>,
  fetched: [] as string[],
  /** URLs whose fetch should throw, mapped to the message. */
  refuse: new Map<string, string>(),
}));

vi.mock('../src/infra/llm', async (importOriginal) => {
  // The real module, so NoModelAccessError stays the class the adapter's instanceof sees.
  const real = await importOriginal<object>();
  return {
    ...real,
    modelAccessLikely: vi.fn(() => true),
    generate: vi.fn(async (req: Record<string, unknown>) => {
      h.generateCalls.push(req);
      if (h.generateError) throw h.generateError;
      return { text: '', structured: h.answer, stopReason: 'end_turn', provider: 'claude_cli' };
    }),
  };
});

vi.mock('../src/core/discovery/manualPosting', () => ({
  fetchManualPosting: vi.fn(async (url: string) => {
    h.fetched.push(url);
    const refusal = h.refuse.get(url);
    if (refusal) throw new Error(refusal);
    return {
      posting: {
        externalId: null,
        canonicalUrl: url,
        applyUrl: url,
        company: 'Acme',
        companyDomain: null,
        title: 'Software Engineering Intern',
        descriptionHtml: null,
        descriptionText: 'Build things.',
        locations: [],
        positionType: 'internship',
        workArrangement: null,
        hybridDaysOnsite: null,
        remoteEligibleIn: [],
        programFlags: [],
        term: { season: null, year: null },
        compensation: null,
        requires: {},
        postedAt: null,
        closesAt: null,
        atsVendor: 'unknown',
      },
      usedJsonLd: true,
      notes: [],
    };
  }),
}));

const { isAggregatorUrl, isFurnitureTitle, isHostFragment, siftCandidates, webSearch } =
  await import('../src/core/discovery/sources/webSearch');
const { NoModelAccessError } = await import('../src/infra/llm');

function found(urls: string[]): unknown {
  return {
    results: urls.map((url, i) => ({ url, title: `Role ${i + 1}`, company: `Company ${i + 1}` })),
  };
}

beforeEach(() => {
  h.answer = found(['https://boards.greenhouse.io/acme/jobs/1']);
  h.generateError = null;
  h.generateCalls = [];
  h.fetched = [];
  h.refuse = new Map();
});

describe('isAggregatorUrl', () => {
  it('recognises the boards whose terms refuse automated reads, at any depth', () => {
    for (const url of [
      'https://www.linkedin.com/jobs/view/123',
      'https://indeed.com/viewjob?jk=abc',
      'https://de.indeed.com/viewjob?jk=abc',
      'https://app.joinhandshake.com/jobs/456',
      'https://www.glassdoor.com/job-listing/x',
    ]) {
      expect(isAggregatorUrl(url), url).toBe(true);
    }
  });

  it('does not read a company that merely contains the word', () => {
    // Host-suffix matching, not substring: monster.com is refused, monsterenergy.com and
    // notlinkedin.example are somebody's own sites.
    expect(isAggregatorUrl('https://careers.monsterenergy.com/jobs/1')).toBe(false);
    expect(isAggregatorUrl('https://notlinkedin.example/jobs/1')).toBe(false);
    expect(isAggregatorUrl('https://boards.greenhouse.io/acme/jobs/1')).toBe(false);
  });
});

describe('siftCandidates', () => {
  it('drops aggregators, junk and repeats, and counts each by reason', () => {
    // Each count becomes its own sentence in the run report. Lumped together, the one that
    // matters — the policy refusals — would be invisible.
    const sift = siftCandidates(
      [
        { url: 'https://boards.greenhouse.io/acme/jobs/1' },
        { url: 'https://www.linkedin.com/jobs/view/9' },
        { url: 'not a url' },
        { url: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=x' },
        { url: 'https://jobs.lever.co/beta/2' },
      ],
      10,
    );
    expect(sift.candidates.map((c) => c.url)).toEqual([
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://jobs.lever.co/beta/2',
    ]);
    expect(sift.aggregators).toBe(1);
    expect(sift.malformed).toBe(1);
    // The utm-tagged copy canonicalizes onto the first URL, which is how search results
    // ordinarily repeat themselves.
    expect(sift.duplicates).toBe(1);
    expect(sift.overCap).toBe(0);
  });

  it('counts what falls past the cap rather than hiding it', () => {
    const urls = Array.from({ length: 8 }, (_, i) => ({
      url: `https://boards.greenhouse.io/c${i}/jobs/1`,
    }));
    const sift = siftCandidates(urls, 5);
    expect(sift.candidates.map((c) => c.url)).toHaveLength(5);
    expect(sift.overCap).toBe(3);
  });

  it('refuses non-http schemes outright', () => {
    const sift = siftCandidates(
      [{ url: 'ftp://example.com/x' }, { url: 'javascript:alert(1)' }],
      5,
    );
    expect(sift.candidates.map((c) => c.url)).toEqual([]);
    expect(sift.malformed).toBe(2);
  });
});

describe('the web_search adapter', () => {
  it('stores what the PAGES say, fetched by this process — never the model’s word', async () => {
    h.answer = found(['https://boards.greenhouse.io/acme/jobs/1', 'https://jobs.lever.co/beta/2']);
    const result = await webSearch.fetch({ keywords: ['robotics intern'], location: 'Boston' });

    expect(result.postings).toHaveLength(2);
    // Every posting came through the mocked fetchManualPosting, which is the robots path.
    expect(h.fetched).toEqual([
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://jobs.lever.co/beta/2',
    ]);
    // And the model was actually asked to search.
    expect(h.generateCalls[0]).toMatchObject({ purpose: 'web_discovery', webSearch: true });
  });

  it('drops an aggregator link the model returned anyway, and says so', async () => {
    h.answer = found([
      'https://www.linkedin.com/jobs/view/9',
      'https://boards.greenhouse.io/acme/jobs/1',
    ]);
    const result = await webSearch.fetch({});

    expect(h.fetched).toEqual(['https://boards.greenhouse.io/acme/jobs/1']);
    expect(result.notes.join(' ')).toMatch(/dropped 1 aggregator link/i);
  });

  it('reports pages it could not read as a gap, and keeps the ones it could', async () => {
    h.answer = found([
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://careers.blocked.example/jobs/2',
    ]);
    h.refuse.set('https://careers.blocked.example/jobs/2', 'robots.txt disallows /jobs/2');
    const result = await webSearch.fetch({});

    expect(result.postings).toHaveLength(1);
    expect(result.gaps?.join(' ')).toMatch(/1 of 2 pages/);
    expect(result.gaps?.join(' ')).toMatch(/robots\.txt disallows/);
  });

  it('answers missing model access with a gap, not a throw', async () => {
    // The web not being searched is coverage the user asked for and did not get. A quiet
    // zero would read as "the web had nothing".
    h.generateError = new NoModelAccessError('No ANTHROPIC_API_KEY is configured.');
    const result = await webSearch.fetch({});
    expect(result.postings).toEqual([]);
    expect(result.gaps?.join(' ')).toMatch(/no model access/i);
    expect(h.fetched).toEqual([]);
  });

  it('answers an unreadable model reply with a gap, not garbage', async () => {
    h.answer = { shrug: true };
    const result = await webSearch.fetch({});
    expect(result.postings).toEqual([]);
    expect(result.gaps?.join(' ')).toMatch(/could not be read/i);
  });

  it('says plainly when the search found nothing, without calling it a gap', async () => {
    // Nothing was truncated or refused; the web genuinely had no answer for this brief.
    h.answer = found([]);
    const result = await webSearch.fetch({ keywords: ['underwater basket weaving intern'] });
    expect(result.postings).toEqual([]);
    expect(result.gaps).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/found no open postings/i);
  });

  it('honours the candidate cap and reports the remainder', async () => {
    h.answer = found(
      Array.from({ length: 14 }, (_, i) => `https://boards.greenhouse.io/c${i}/jobs/1`),
    );
    const result = await webSearch.fetch({ limit: 3 });
    expect(h.fetched).toHaveLength(3);
    expect(result.notes.join(' ')).toMatch(/left 11 unfetched/);
  });

  it('sends the brief it was given, and defaults to the product’s premise', async () => {
    await webSearch.fetch({ keywords: ['summer 2027 internship', 'robotics'] });
    expect(String(h.generateCalls[0]?.['user'])).toMatch(/summer 2027 internship, robotics/);

    h.generateCalls = [];
    await webSearch.fetch({});
    // "internship" is not an invented role; it is what the tool exists to find, and the
    // same default the keyed aggregators use.
    expect(String(h.generateCalls[0]?.['user'])).toMatch(/Roles and keywords: internship/);
  });
});

describe('naming a posting whose page states none', () => {
  it('keeps the search result’s name only when the page yields furniture', async () => {
    // The first live run stored "Untitled posting @ salesforce" and "Jobs @ ashbyhq" for
    // real Summer 2027 roles: JS-rendered pages hand the raw-HTML reader nothing, and the
    // real names sat unread in the search results the model had already returned. The page
    // stays the authority on every fact; this only fills a name the page did not state.
    const { fetchManualPosting } = await import('../src/core/discovery/manualPosting');
    vi.mocked(fetchManualPosting).mockResolvedValueOnce({
      posting: {
        canonicalUrl: 'https://acme.wd5.myworkdayjobs.com/ext/job/x',
        applyUrl: 'https://acme.wd5.myworkdayjobs.com/ext/job/x',
        company: 'acme',
        title: 'Untitled posting',
      } as never,
      usedJsonLd: false,
      notes: [],
    });
    h.answer = {
      results: [
        {
          url: 'https://acme.wd5.myworkdayjobs.com/ext/job/x',
          title: 'Summer 2027 Intern - Software Engineer',
          company: 'Acme Corporation',
        },
      ],
    };

    const result = await webSearch.fetch({});
    expect(result.postings[0]).toMatchObject({
      title: 'Summer 2027 Intern - Software Engineer',
      company: 'Acme Corporation',
    });
    expect(result.notes.join(' ')).toMatch(/kept the search result's own name/);
  });

  it('never overrides a page that names itself', async () => {
    // The default mock returns a real title and a company that is not a hostname fragment,
    // with usedJsonLd true — the model's flashier naming must lose to it.
    h.answer = {
      results: [
        {
          url: 'https://boards.greenhouse.io/acme/jobs/1',
          title: 'A Grander-Sounding Title',
          company: 'A Different Company',
        },
      ],
    };
    const result = await webSearch.fetch({});
    expect(result.postings[0]).toMatchObject({
      title: 'Software Engineering Intern',
      company: 'Acme',
    });
    expect(result.notes.join(' ')).not.toMatch(/kept the search result/);
  });
});

describe('the naming heuristics', () => {
  it('reads page furniture as furniture', () => {
    for (const t of ['Untitled posting', 'Jobs', 'Careers', 'Open Positions', 'x']) {
      expect(isFurnitureTitle(t), t).toBe(true);
    }
    for (const t of ['Software Engineering Intern', 'Robotics Intern (Summer 2027)']) {
      expect(isFurnitureTitle(t), t).toBe(false);
    }
  });

  it('reads a vendor hostname fragment as no company at all', () => {
    // "job-boards" and "ashbyhq" name the ATS, not the employer — and a fingerprint built
    // from them will not merge with the same posting found through the real adapter.
    expect(isHostFragment('job-boards', 'https://job-boards.greenhouse.io/spacex/jobs/1')).toBe(
      true,
    );
    expect(isHostFragment('ashbyhq', 'https://jobs.ashbyhq.com/skydio/1')).toBe(true);
    expect(isHostFragment('salesforce', 'https://salesforce.wd12.myworkdayjobs.com/x')).toBe(true);
    expect(isHostFragment('', 'https://example.com/x')).toBe(true);
    // A company the page genuinely stated survives, even when it happens to match nothing.
    expect(isHostFragment('Verne Robotics', 'https://jobs.ashbyhq.com/Verne%20Robotics/1')).toBe(
      false,
    );
  });
});
