/**
 * The documents, checked against the code instead of against a memory of the code.
 *
 * README.md said "505 tests" for four commits after the suite had passed a thousand, and
 * docs/04 described a "16-family taxonomy" that had grown to 21, a `resolveCompany` domain
 * fallback that was never built, and a stage-2 fingerprint built from `normalizeTitle` when
 * the code had moved to `fingerprintTitle`. Every one of those drifted silently because
 * nothing in apps/server/test, apps/web/test or packages/shared/test opened a .md file, so
 * a wrong number in a document cost nothing until a reader believed it.
 *
 * The rule this file follows: a countable claim in a document is asserted against whatever
 * in the code DETERMINES the number, never against a second copy of the number. Where the
 * value is exported it is imported and measured; where it is a module-private constant the
 * declaration itself is matched, so moving the constant is what breaks the test rather than
 * a paraphrase in the prose.
 *
 * One claim is deliberately absent: the size of this test suite. Counting the tests from
 * inside the tests is circular, it would fail on every commit that adds a case, and a
 * green-but-meaningless assertion is worse than no assertion. The README no longer states
 * a test count at all — it points at `npm test`, which answers the question honestly at the
 * moment it is asked — and the first check below is what keeps a number from creeping back.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfirmedProfile, SearchFilters } from '@ia/shared';
import { ROLE_TAXONOMY, planQueries } from '../src/core/discovery/queryPlanner';
import { ALL_SOURCES } from '../src/core/discovery/run';
import { canonicalUrl, fingerprintTitle, normalizeTitle } from '../src/core/discovery/normalize';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * Markdown here is hard-wrapped at 96 columns, so a sentence is routinely split across two
 * lines and "21-family\ntaxonomy" would not match a regex written the way the phrase reads.
 * Every prose assertion runs against the whitespace-collapsed form, or a harmless reflow
 * would look like a fact changing.
 */
function flat(md: string): string {
  return md.replace(/\s+/g, ' ');
}

function walk(dir: string, keep: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full, keep);
    return keep.test(e.name) ? [full] : [];
  });
}

const README = read('README.md');
const DOC04 = read('docs/04-job-discovery.md');
const FLAT_README = flat(README);
const FLAT_DOC04 = flat(DOC04);

/** Spelled-out counts in the prose, so "Six of those ship today" can be measured. */
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

describe('README.md', () => {
  /**
   * The anti-drift guard, and the reason this file exists at all. "505 tests" was wrong for
   * four commits; its replacement, "1249 tests across 42 files", was wrong within the hour
   * (46 files by the time the audit ran) and put TWO volatile numbers in the sentence where
   * there had been one. A count of the suite cannot be checked from inside the suite without
   * circularity, so the honest move is not to state it.
   */
  it('states no test count, because no test can check one without counting itself', () => {
    expect(FLAT_README).not.toMatch(/\b[\d,]+ tests\b/);
    expect(FLAT_README).not.toMatch(/\b\d+ (?:test )?files\b/);
  });

  it('points at the command that answers the question instead', () => {
    expect(FLAT_README).toMatch(/`npm test`/);
  });

  it('names only npm scripts that exist', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    // `npm run x` is always a script. The bare form may be npm's own command instead —
    // `npm install` and `npm audit` are named in the README and belong to npm, not to us.
    const NPM_OWN = new Set(['install', 'audit', 'ci', 'init']);
    const named = [...README.matchAll(/`npm (run )?([a-z][a-z:]*)`/g)];
    expect(named.length).toBeGreaterThan(0);
    for (const [, isRun, cmd] of named) {
      const known = cmd! in pkg.scripts || (isRun === undefined && NPM_OWN.has(cmd!));
      expect({ cmd, known }).toEqual({ cmd, known: true });
    }
  });

  /**
   * Both directions. A dead link is the obvious failure; a doc added to docs/ and never
   * linked from the README is the one that actually happens, and it makes the documentation
   * table read as complete when it is not — the same dishonesty the run summary's `skipped`
   * list exists to avoid. This counts links anywhere in the README, not table rows, because
   * several docs are also linked from the prose and either place is a way in.
   */
  it('links every doc in docs/, and nothing that is not there', () => {
    const linked = new Set([...README.matchAll(/\(docs\/([0-9a-z-]+\.md)\)/g)].map((m) => m[1]!));
    const onDisk = new Set(
      readdirSync(path.join(REPO_ROOT, 'docs')).filter((f) => f.endsWith('.md')),
    );
    for (const doc of linked)
      expect({ doc, exists: onDisk.has(doc) }).toEqual({ doc, exists: true });
    for (const doc of onDisk)
      expect({ doc, linked: linked.has(doc) }).toEqual({ doc, linked: true });
  });

  /**
   * "none of the per-vendor ATS adapters (Greenhouse, Lever, Ashby, Workday) is built" is
   * the correction the last repair made to a sentence that had claimed they existed and
   * were merely untested. The claim is checkable: core/filling holds the generic mapper and
   * no vendor file.
   */
  it('is right that no per-vendor ATS fill adapter is built', () => {
    expect(FLAT_README).toMatch(/none of the per-vendor ATS adapters/);
    const filling = readdirSync(path.join(REPO_ROOT, 'apps/server/src/core/filling'));
    expect(filling.filter((f) => /greenhouse|lever|ashby|workday/i.test(f))).toEqual([]);
    expect(filling).toContain('formMap.ts');
  });

  /**
   * The § Environment block said "Python 3.14.6, pip 26.1.2 — present" on a machine with no
   * interpreter at all: `python --version` and `py -V` both fail and the only python.exe is
   * the 0-byte Microsoft Store alias. That is the same drift as the test count, one heading
   * down — a pinned measurement nothing re-measures.
   *
   * Only the durable half is asserted here. Whether an interpreter is installed is a fact
   * about the reader's machine, not about this repo, so a test that demanded its absence
   * would go red for any contributor who has Python for other work. What the repo can be
   * held to is that it does not need one.
   */
  it('is right that nothing here runs a Python process', () => {
    expect(FLAT_README).toMatch(/Python — \*\*not used\*\*/);
    const sources = [
      ...walk(path.join(REPO_ROOT, 'apps'), /\.tsx?$/),
      ...walk(path.join(REPO_ROOT, 'packages'), /\.tsx?$/),
    ];
    expect(sources.length).toBeGreaterThan(0);
    for (const f of sources) {
      const spawnsPython =
        /(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"`]py(?:thon3?)?['"`]/.test(
          readFileSync(f, 'utf8'),
        );
      expect({ f, spawnsPython }).toEqual({ f, spawnsPython: false });
    }
  });

  /**
   * The Node version in that same block is a measurement and will differ on another machine,
   * so it cannot be asserted equal to anything. It CAN be held to the floor the repo itself
   * declares: a README that told a reader to run this on a Node older than `engines` would be
   * wrong on every machine, not just this one.
   */
  it('claims a Node version that satisfies the engines floor', () => {
    const claimed = Number(/Node v(\d+)\.\d+\.\d+/.exec(FLAT_README)?.[1]);
    const pkg = JSON.parse(read('package.json')) as { engines: { node: string } };
    const floor = Number(/(\d+)/.exec(pkg.engines.node)?.[1]);
    expect(floor).toBeGreaterThan(0);
    expect(claimed).toBeGreaterThanOrEqual(floor);
  });

  it('names an environment variable the server actually reads', () => {
    expect(FLAT_README).toMatch(/`ANTHROPIC_API_KEY`/);
    const serverFiles = walk(path.join(REPO_ROOT, 'apps/server/src'), /\.ts$/);
    const readers = serverFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('ANTHROPIC_API_KEY'),
    );
    expect(readers.length).toBeGreaterThan(0);
  });
});

describe('docs/04 — job discovery, § Query planning', () => {
  /**
   * The taxonomy grew from 16 to 21 families while the document went on saying 16. It is
   * exported for exactly this: counting the keys is the only reading that cannot disagree
   * with the object, and re-parsing the source text was worse than useless — the naive line
   * regex returned 24, because the table's own comments contain commas and colons.
   */
  it('states the taxonomy size that ROLE_TAXONOMY actually has', () => {
    const claimed = /(\d+)-family taxonomy/.exec(FLAT_DOC04);
    expect(claimed?.[1]).toBe(String(Object.keys(ROLE_TAXONOMY).length));
  });

  it('states the target cap planQueries actually applies', () => {
    const claimed = Number(/capped at (\d+)/.exec(FLAT_DOC04)?.[1]);
    expect(claimed).toBeGreaterThan(0);
    const boards = Array.from({ length: claimed * 3 }, (_, i) => ({
      source: 'greenhouse' as const,
      board: `b${i}`,
      reason: 'resolved',
    }));
    const plan = planQueries(profileFixture(), filtersFixture(), boards);
    expect(plan.targets).toHaveLength(claimed);
  });

  it('states the number of role families a plan keeps', () => {
    const claimed = Number(/top (\d+)/.exec(FLAT_DOC04)?.[1]);
    expect(claimed).toBeGreaterThan(0);
    const evidenced = Object.entries(ROLE_TAXONOMY).map(([, terms]) => terms[0]!);
    const plan = planQueries(
      profileFixture({ skills: evidenced.map((name) => ({ name })) }),
      filtersFixture(),
    );
    expect(plan.roleFamilies).toHaveLength(claimed);
  });

  /**
   * The document quotes the whole-word threshold as a number of characters. It is a
   * module-private constant in an expression, so the declaration is what gets matched.
   */
  it('states the stem length above which a prefix match is allowed', () => {
    const word = /terms of (\w+) characters or fewer/.exec(FLAT_DOC04)?.[1]?.toLowerCase() ?? '';
    const claimed = WORD_NUMBERS[word];
    expect(claimed).toBeGreaterThan(0);
    expect(read('apps/server/src/core/discovery/queryPlanner.ts')).toMatch(
      new RegExp(`term\\.length > ${claimed}`),
    );
  });
});

describe('docs/04 — job discovery, § Sourcing policy and § Normalization', () => {
  it('counts the sources that ship as the runner counts them', () => {
    const claimed = /(\w+) of those ship today/.exec(FLAT_DOC04)?.[1]?.toLowerCase() ?? '';
    expect(WORD_NUMBERS[claimed]).toBe(Object.keys(ALL_SOURCES).length);
  });

  /**
   * The audit finding this file was written for. The document called `gaps` "the subset of
   * those notes"; no shipped adapter does that — adzuna and usajobs return `notes: []` beside
   * a populated `gaps`, and github_list returns a status line in one and a different
   * coverage-loss line in the other. It matters because run.ts CONCATENATES the two arrays,
   * so an adapter author who followed the document and wrote the gap line into both would
   * have it printed twice in the report the user reads.
   */
  it('does not call `gaps` a subset of `notes`', () => {
    expect(FLAT_DOC04).not.toMatch(/`gaps` is the subset of those notes/);
    expect(FLAT_DOC04).toMatch(/not a subset of `notes`/);
    const aggregators = read('apps/server/src/core/discovery/sources/aggregators.ts');
    expect(aggregators).toMatch(/return \{ postings, notes: \[\], gaps \};/);
    expect(read('apps/server/src/core/discovery/run.ts')).toMatch(
      /report\.notes = \[\.\.\.result\.notes, \.\.\.\(result\.gaps \?\? \[\]\)\];/,
    );
  });

  /**
   * Both directions, which is the whole point and is what this check was missing.
   *
   * It used to read the field names OUT of the document and assert each one exists in
   * `types.ts` — so it stayed green while `closed?: string[]` was added to the interface and
   * the document went on quoting a three-field shape. That is the worst way for this
   * particular fact to rot: an adapter author following the doc would throw away the closure
   * evidence the field exists to carry, which is precisely the bug that field was added to
   * fix. A quoted shape has to name every member the interface has.
   */
  it('quotes the SourceResult shape the interface declares, member for member', () => {
    const quoted = /`fetch` returns `\{([^`]+)\}`/.exec(FLAT_DOC04)?.[1];
    expect(quoted).toBeTruthy();

    const types = read('apps/server/src/core/discovery/sources/types.ts');
    const body = /export interface SourceResult \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';
    const declared = [...body.matchAll(/^\s{2}(\w+)(\??):/gm)].map((m) => `${m[1]!}${m[2]!}`);
    expect(declared.length).toBeGreaterThan(3);

    for (const member of declared) {
      expect({ member, quoted: quoted!.includes(`${member}:`) }).toEqual({ member, quoted: true });
    }
  });

  /**
   * The same shape of miss one section over: § Run reporting listed the totals a summary
   * carries, `closed` landed on `RunSummary`, and nothing held the sentence to the type.
   */
  it('names every total the run summary actually carries', () => {
    const listed = /Run totals carry ([^.]+?), plus a `skipped` list/.exec(FLAT_DOC04)?.[1] ?? '';
    expect(listed).toBeTruthy();

    const run = read('apps/server/src/core/discovery/run.ts');
    const body = /export interface RunSummary \{([\s\S]*?)\n\}/.exec(run)?.[1] ?? '';
    const counted = [...body.matchAll(/^\s{2}(\w+): number;/gm)].map((m) => m[1]!);
    // `targets` is the size of the plan rather than a total about postings, and the sentence
    // is about what a run turned up.
    for (const total of counted.filter((c) => c !== 'targets')) {
      expect({ total, listed: listed.includes(total) }).toEqual({ total, listed: true });
    }
  });
});

describe('docs/04 — job discovery, § Dedupe', () => {
  it('names the function stage 2 actually builds its key from', () => {
    const dedupe = read('apps/server/src/core/discovery/dedupe.ts');
    const key = /return \[([^\]]*)\]\.join\('\|'\)/.exec(dedupe)?.[1] ?? '';
    expect(key).toContain('fingerprintTitle');
    expect(key).not.toContain('normalizeTitle(');
    expect(FLAT_DOC04).toMatch(/fingerprintTitle\(title\)/);
    expect(FLAT_DOC04).not.toMatch(/normalizeTitle\(title\)` \+/);
  });

  /**
   * The document justifies the cautious form with three specific pairs that must not merge.
   * Asserting the sentences without asserting the behaviour would be back to checking a copy
   * of the fact, so the pairs are run through the function.
   */
  it('is right that the fingerprint keeps roman numerals, season words and years', () => {
    expect(fingerprintTitle('Machine Learning Intern I')).not.toBe(
      fingerprintTitle('Machine Learning Intern II'),
    );
    expect(fingerprintTitle('Software Engineer Intern (Summer 2026)')).not.toBe(
      fingerprintTitle('Software Engineer Intern (Fall 2026)'),
    );
    // ...and the aggressive form, which the document assigns to stage 3, does collapse them.
    expect(normalizeTitle('Machine Learning Intern I')).toBe(
      normalizeTitle('Machine Learning Intern II'),
    );
  });

  it('is right that a labelled requisition id is stripped', () => {
    expect(fingerprintTitle('Data Analyst Intern (Req #9931)')).toBe(
      fingerprintTitle('Data Analyst Intern'),
    );
    expect(fingerprintTitle('Data Analyst Intern (Job ID 4471)')).toBe(
      fingerprintTitle('Data Analyst Intern'),
    );
  });

  it('lists the tracking parameters stage 1 actually strips', () => {
    const listed = [
      ...(/Strip tracking params \(([^)]*)\)/.exec(FLAT_DOC04)?.[1] ?? '').matchAll(
        /`([a-z_*-]+)`/g,
      ),
    ].map((m) => m[1]!.replace(/\*$/, ''));
    expect(listed).not.toHaveLength(0);
    for (const param of listed) {
      const url = canonicalUrl(
        `https://example.com/j/1?${param}${param.endsWith('_') ? 'x' : ''}=v`,
      );
      expect({ param, url }).toEqual({ param, url: 'https://example.com/j/1' });
    }
  });
});

describe('docs/04 — job discovery, § Freshness and § Politeness', () => {
  const refresh = read('apps/server/src/core/discovery/refresh.ts');
  const fetcher = read('apps/server/src/infra/http/fetcher.ts');
  const run = read('apps/server/src/core/discovery/run.ts');

  it('states the staleness window refresh.ts declares', () => {
    const claimed = Number(/Not seen in (\d+) days/.exec(FLAT_DOC04)?.[1]);
    expect(refresh).toMatch(new RegExp(`const STALE_DAYS = ${claimed};`));
  });

  it('states the URL-check page size refresh.ts defaults to', () => {
    const claimed = Number(/(\d+) rows per call by default/.exec(FLAT_DOC04)?.[1]);
    expect(refresh).toMatch(new RegExp(`opts\\.limit \\?\\? ${claimed}`));
  });

  it('states the only two statuses that close a posting', () => {
    const claimed = /Only (\d{3}) and (\d{3}) close a posting/.exec(FLAT_DOC04);
    expect(refresh).toMatch(
      new RegExp(`err\\.status === ${claimed?.[1]} \\|\\| err\\.status === ${claimed?.[2]}`),
    );
  });

  it('states the worker count runDiscovery defaults to', () => {
    const claimed = Number(/\*\*(\d+)\*\* workers by default/.exec(FLAT_DOC04)?.[1]);
    expect(run).toMatch(new RegExp(`opts\\.concurrency \\?\\? ${claimed}`));
  });

  it('states the rate limit, retry cap, attempt count and cache TTL the fetcher declares', () => {
    expect(fetcher).toMatch(
      new RegExp(`const DEFAULT_RPS = ${/default (\d+) rps/.exec(FLAT_DOC04)?.[1]};`),
    );
    // The constant is written with a numeric separator, so 60s is `60_000`, not `60000`.
    expect(fetcher).toMatch(
      new RegExp(`const MAX_RETRY_AFTER_MS = ${/capped at (\d+)s/.exec(FLAT_DOC04)?.[1]}_000;`),
    );
    expect(fetcher).toMatch(
      new RegExp(`const MAX_ATTEMPTS = ${/(\d+) attempts max/.exec(FLAT_DOC04)?.[1]};`),
    );
    expect(fetcher).toMatch(
      new RegExp(
        `const CACHE_TTL_MS = ${/(\d+)h default TTL/.exec(FLAT_DOC04)?.[1]} \\* 60 \\* 60 \\* 1000;`,
      ),
    );
  });

  it('quotes the User-Agent the fetcher actually sends', () => {
    const quoted = /User-Agent: `([^`]+)`/.exec(FLAT_DOC04)?.[1];
    expect(quoted).toBeTruthy();
    expect(fetcher).toContain(`const USER_AGENT = '${quoted}'`);
  });

  it('states the status a robots.txt-disallowed path raises', () => {
    const claimed = /A disallowed path raises a (\d{3})/.exec(FLAT_DOC04)?.[1];
    expect(fetcher).toMatch(
      new RegExp(`robots\\.txt disallows \\$\\{u\\.pathname\\}\`, ${claimed}`),
    );
  });
});

describe('docs/04 — job discovery, § Pipeline reporting', () => {
  it('names routes that are actually declared', () => {
    const routeFiles = walk(path.join(REPO_ROOT, 'apps/server/src/routes'), /\.ts$/)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const declared = new Set(
      [...routeFiles.matchAll(/app\.(?:get|post|put|patch|delete)(?:<[^>]*>)?\('([^']+)'/g)].map(
        (m) => m[1]!,
      ),
    );
    const named = new Set([...DOC04.matchAll(/`(?:GET|POST) (\/api\/[^`]+)`/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(0);
    for (const route of named) {
      expect({ route, declared: declared.has(route) }).toEqual({ route, declared: true });
    }
  });

  it('names the SSE events the runner actually publishes', () => {
    const run = read('apps/server/src/core/discovery/run.ts');
    const named = [...DOC04.matchAll(/`(discovery\.[a-z_]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const event of named) {
      expect({ event, published: run.includes(`type: '${event}'`) }).toEqual({
        event,
        published: true,
      });
    }
  });

  /**
   * Two claims of ABSENCE, which are the ones a reader has no way to check and the ones that
   * rot first: something gets wired up and the paragraph saying it is not wired up survives.
   */
  it('is right that nothing in the web app subscribes to the stream', () => {
    expect(FLAT_DOC04).toMatch(/`EventSource` appears nowhere in `apps\/web\/src`/);
    for (const f of walk(path.join(REPO_ROOT, 'apps/web/src'), /\.tsx?$/)) {
      expect({ f, uses: readFileSync(f, 'utf8').includes('EventSource') }).toEqual({
        f,
        uses: false,
      });
    }
  });

  it('is right that no server file reads BRAVE_SEARCH_API_KEY', () => {
    expect(FLAT_DOC04).toMatch(/`BRAVE_SEARCH_API_KEY` in `\.env\.example` is read by nothing/);
    for (const f of walk(path.join(REPO_ROOT, 'apps/server/src'), /\.ts$/)) {
      expect({ f, reads: readFileSync(f, 'utf8').includes('BRAVE_SEARCH_API_KEY') }).toEqual({
        f,
        reads: false,
      });
    }
  });
});

function profileFixture(over: Record<string, unknown> = {}): ConfirmedProfile {
  return {
    id: 'p1',
    fullName: 'A',
    email: 'a@b.c',
    skills: [],
    experience: [],
    projects: [],
    education: [],
    locationPrefs: {
      base: { city: 'Boston', region: 'MA', country: 'US' },
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    ...over,
  } as unknown as ConfirmedProfile;
}

function filtersFixture(over: Record<string, unknown> = {}): SearchFilters {
  return {
    term: { seasons: ['summer'], years: [2027] },
    positionTypes: ['internship'],
    role: { roleFamilies: [], titleIncludes: [], titleExcludes: [] },
    location: { cities: [], remote: true },
    company: { onlyCompanies: [], excludeCompanies: [] },
    ...over,
  } as unknown as SearchFilters;
}
