import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATOR_REFUSAL, isAggregatorUrl } from '../src/core/discovery/sourcingPolicy';
import { SourceRefusedError, startRun } from '../src/core/filling/run';

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

/**
 * The file with its comments removed.
 *
 * This test greps each URL-opening file for the policy, and `core/filling/run.ts` explains in
 * prose why the policy exists — including the sentence "`isAggregatorUrl` had exactly one
 * caller in the whole repo". That sentence satisfied the grep, so deleting the import and the
 * guard itself left this test passing, on the check standing in for the one runtime test the
 * signed-in browser path did not have. A comment describing a rule is not the rule.
 */
function codeOf(rel: string): string {
  // Line by line, not by regex over the whole file. A block-comment pattern cannot tell a
  // comment from a string that happens to contain one, and the very handler this test exists
  // to find is registered against a glob containing a slash-star — which sent a lazy block
  // matcher off to the next star-slash and swallowed the code in between.
  return read(rel)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
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
    {
      file: 'core/filling/browser.ts',
      why: 'is a real browser that follows redirects on its own, carrying the signed-in profile',
    },
  ];

  for (const { file, why } of CALLERS) {
    it(`${file} — ${why}`, () => {
      // A CALL, in code with the comments stripped — not the identifier appearing anywhere.
      expect(codeOf(file)).toMatch(/isAggregatorUrl\s*\(/);
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

/**
 * The guard on the signed-in browser, which is the highest-consequence one and had no test.
 *
 * Grepping the whole test tree for `SourceRefusedError` or `SOURCE_REFUSED` returned nothing
 * before this, so neither the refusal in `startRun` nor the 400 the route maps it to was
 * covered — while the source-level check that stood in for them was satisfied by a comment.
 */
describe('the fill path refuses a board this tool will not open', () => {
  it('refuses before the browser is launched', async () => {
    // Ordering is the point: the refusal has to come before `openSession`, because launching
    // the persistent context is what puts the student's logins in play.
    await expect(
      startRun({
        applicationId: 'app_test',
        applyUrl: 'https://www.linkedin.com/jobs/view/123',
        profile: {} as never,
        answers: [],
      }),
    ).rejects.toBeInstanceOf(SourceRefusedError);
  });

  it('carries the refusal message that names the way forward', async () => {
    const err = await startRun({
      applicationId: 'app_test',
      applyUrl: 'https://app.joinhandshake.com/jobs/1',
      profile: {} as never,
      answers: [],
    }).catch((e: unknown) => e as SourceRefusedError);
    expect(err).toBeInstanceOf(SourceRefusedError);
    const refused = err as SourceRefusedError;
    expect(refused.code).toBe('SOURCE_REFUSED');
    expect(refused.message).toMatch(/paste its text/i);
  });

  it('checks where the browser LANDED, not only where it was sent', () => {
    // A real browser follows 3xx, meta-refresh and `location =` by itself, so the string
    // checked before `goto` is not necessarily the host that ends up with the session. Read
    // off the source because reaching it at runtime needs a live redirecting server; what is
    // pinned is that the check exists on both paths and reads the CURRENT url.
    const code = codeOf('core/filling/run.ts');
    expect(code).toMatch(/function refuseIfAggregator/);
    expect(code).toMatch(/run\.session\?\.page\.url\(\)/);
    // After the navigation, and again before anything is typed.
    expect(code).toMatch(/goto\([\s\S]{0,120}refuseIfAggregator\(run\)/);
    const drive = code.slice(code.indexOf('async function drive'));
    expect(drive.slice(0, 600)).toMatch(/refuseIfAggregator\(run\)/);
  });

  it('aborts the request in the browser itself, so nothing reaches the host', () => {
    // Stronger than checking the URL afterwards: a route handler refuses the REQUEST, so no
    // cookies, no Referer and no TLS handshake reach a site this tool has promised not to
    // visit. Scoped to document navigations so a page's fonts and images still load.
    const code = codeOf('core/filling/browser.ts');
    expect(code).toMatch(/context\.route\(/);
    expect(code).toMatch(/resourceType\(\) === 'document'/);
    expect(code).toMatch(/route\.abort\(/);
  });
});
