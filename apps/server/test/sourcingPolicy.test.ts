import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATOR_REFUSAL, isAggregatorUrl } from '../src/core/discovery/sourcingPolicy';

/**
 * The promise the paste path is built on, held everywhere instead of in one adapter.
 *
 * `POST /api/discovery/paste` exists so a student can bring a Handshake, LinkedIn or Indeed
 * posting WITHOUT this tool contacting those sites, and it stores their address as the
 * posting's identity on the explicit undertaking that storing an address is not visiting one.
 *
 * That undertaking was false in three places at once, and none of them was the adapter that
 * owned the rule. `refreshPostings` walks open postings and fetches every `canonical_url`;
 * `POST /api/discovery/manual` fetched whatever URL it was handed; and the fill engine
 * navigates a PERSISTENT, SIGNED-IN Chromium profile to `apply_url`. So the careful path
 * armed three later visits, the last of them carrying the student's own session — which for
 * Handshake is their university's careers account.
 *
 * `isAggregatorUrl` had exactly one caller in the entire repo when that was found. These
 * tests exist so the next subsystem that opens a URL cannot quietly become the fourth.
 */

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function read(rel: string): string {
  return readFileSync(path.join(SERVER_SRC, rel), 'utf8');
}

describe('which hosts this tool refuses to open', () => {
  it('refuses the four boards named in the policy, on any country domain', () => {
    for (const url of [
      'https://www.linkedin.com/jobs/view/1',
      'https://linkedin.cn/jobs/view/1',
      'https://www.indeed.com/viewjob?jk=x',
      'https://de.indeed.com/viewjob?jk=x',
      'https://www.glassdoor.com/job-listing/x',
      'https://www.glassdoor.co.uk/job-listing/x',
      'https://app.joinhandshake.com/jobs/1',
      'https://www.monster.de/jobs/1',
    ]) {
      expect(isAggregatorUrl(url), url).toBe(true);
    }
  });

  it('refuses one wearing credentials, a port, or capitals', () => {
    // All three are parsed by `URL`, not by the brand list, which is why the check reads
    // `hostname` rather than the raw string. A rule that a query string could walk past is
    // not a rule.
    expect(isAggregatorUrl('https://someone@www.linkedin.com/jobs/view/1')).toBe(true);
    expect(isAggregatorUrl('https://WWW.LINKEDIN.COM/jobs/view/1')).toBe(true);
    expect(isAggregatorUrl('https://www.linkedin.com:443/jobs/view/1')).toBe(true);
    expect(isAggregatorUrl('https://careers.acme.com/x?ref=https://linkedin.com/jobs/1')).toBe(
      false,
    );
  });

  it('opens an employer whose own name or subdomain resembles one', () => {
    // The cost of being wrong in this direction is a real posting silently refused AND the
    // student told somebody else's terms forbade it, which is a false statement about a third
    // party. `talent` is on the list; `talent.acme.com` is an ordinary careers subdomain.
    for (const url of [
      'https://talent.acme.com/jobs/1',
      'https://indeed.acme.com/careers',
      'https://careers.monsterenergy.com/jobs/1',
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://jobs.ashbyhq.com/acme/1',
      'https://acme.wd1.myworkdayjobs.com/ext/job/x',
    ]) {
      expect(isAggregatorUrl(url), url).toBe(false);
    }
  });

  it('says nothing about a string that is not a URL', () => {
    // "Not a URL" is a different complaint with a different message, and every caller
    // validates shape before asking this.
    expect(isAggregatorUrl('not a url')).toBe(false);
    expect(isAggregatorUrl('')).toBe(false);
  });
});

/**
 * Asserted against the SOURCE, because the property is "no subsystem opens a URL without
 * asking". That is a fact about which files consult the rule, and no runtime test of one code
 * path can establish it — the bug was three separate paths that each looked reasonable alone.
 */
describe('every subsystem that opens a URL consults the policy', () => {
  const CALLERS: Array<{ file: string; why: string }> = [
    {
      file: 'core/discovery/refresh.ts',
      why: 'walks open postings and fetches each stored canonical_url',
    },
    {
      file: 'core/discovery/sources/webSearch.ts',
      why: 'fetches every candidate page the model names',
    },
    {
      file: 'core/filling/run.ts',
      why: 'navigates the signed-in browser profile to apply_url',
    },
    {
      file: 'routes/discovery.ts',
      why: 'fetches whatever URL the manual paste-a-URL route is given',
    },
  ];

  for (const { file, why } of CALLERS) {
    it(`${file} — ${why}`, () => {
      expect(read(file)).toMatch(/isAggregatorUrl/);
    });
  }

  it('keeps the rule in one place, so a copy cannot drift out of step', () => {
    // Before this it lived inside sources/webSearch.ts, where it read as a detail of one
    // adapter — which is exactly why three other subsystems never found it.
    const policy = read('core/discovery/sourcingPolicy.ts');
    expect(policy).toMatch(/AGGREGATOR_BRANDS/);
    for (const brand of ['linkedin', 'indeed', 'glassdoor', 'joinhandshake']) {
      expect(policy).toContain(`'${brand}'`);
    }
  });

  it('offers the student the path that does work, rather than only a refusal', () => {
    // A refusal with no way forward reads as a dead end, when the tool has a whole path
    // built for exactly this posting.
    expect(AGGREGATOR_REFUSAL).toMatch(/paste its text/i);
    expect(AGGREGATOR_REFUSAL).toMatch(/Handshake, LinkedIn or Indeed/);
  });
});
