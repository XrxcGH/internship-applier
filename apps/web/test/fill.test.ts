import { describe, expect, it } from 'vitest';
import { samePage, skipReason } from '../src/lib/fill';

/**
 * The review panel warns when the browser read a form at an address other than the one
 * saved with the application. The warning is only worth anything if it stays quiet when
 * nothing is wrong.
 */
describe('samePage', () => {
  it('ignores the slash a browser adds to a bare origin', () => {
    expect(samePage('https://jobs.example', 'https://jobs.example/')).toBe(true);
    expect(samePage('https://jobs.example/apply', 'https://jobs.example/apply#')).toBe(true);
    expect(samePage('https://jobs.example/apply', ' https://jobs.example/apply ')).toBe(true);
  });

  it('still reports a redirect, another host, and a step further into a wizard', () => {
    expect(samePage('https://jobs.example/apply', 'https://jobs.example/login?next=/apply')).toBe(
      false,
    );
    expect(samePage('https://jobs.example/apply', 'https://boards.other.test/x')).toBe(false);
    expect(samePage('https://jobs.example/apply/', 'https://jobs.example/apply/step2')).toBe(false);
  });

  it('stays quiet on the changes that keep the same page', () => {
    // A link saved as http:// is upgraded to https:// on load. This screen folds that away
    // deliberately — the server's sameDocument does NOT (it compares origin, scheme and all),
    // so the two are not the same test — because a soft "the page moved" warning that fires on
    // a benign upgrade is the cry-wolf this function exists to avoid.
    expect(samePage('http://jobs.acme.com/apply', 'https://jobs.acme.com/apply')).toBe(true);
    // A host capitalised in one place and not the other.
    expect(samePage('https://JOBS.ACME.COM/apply', 'https://jobs.acme.com/apply')).toBe(true);
    // The source tag a Greenhouse or Lever board appends the moment the form opens.
    expect(samePage('https://jobs.acme.com/apply', 'https://jobs.acme.com/apply?gh_src=abc')).toBe(
      true,
    );
    expect(samePage('https://jobs.example/apply', 'https://jobs.example/apply?source=web')).toBe(
      true,
    );
  });

  it('keeps a different subdomain a real difference, as the server does', () => {
    // www and the bare host can serve different content, so this is a genuine move, not noise.
    expect(samePage('https://www.acme.com/apply', 'https://acme.com/apply')).toBe(false);
  });

  it('falls back to a trim when an address will not parse', () => {
    expect(samePage('not a url', 'not a url')).toBe(true);
    expect(samePage('not a url', 'other junk')).toBe(false);
  });
});

/**
 * Every field the last run left behind has to come with a reason, because a row with
 * nothing beside it reads as a field that needs nothing.
 */
describe('skipReason', () => {
  it('names the redline when the record names one', () => {
    expect(skipReason({ label: 'SSN', reason: 'redline', category: 'government_id' })).toBe(
      'A government id question. This tool never fills one of these in for you.',
    );
  });

  it('still explains a redline that was stored without a category', () => {
    expect(skipReason({ label: 'Attest', reason: 'redline' })).toContain('never fills');
  });

  it('has words for every reason the fill run can store', () => {
    // These four are what routes/filling.ts writes. One added there without one added here
    // would show the user a blank line where the explanation goes.
    for (const reason of ['redline', 'unclassified', 'no_match', 'failed'] as const) {
      expect(skipReason({ label: 'x', reason })).not.toBe('');
      expect(skipReason({ label: 'x', reason })).not.toContain('undefined');
    }
  });

  it('does not claim an unfilled box is empty when the tool typed into it', () => {
    // `failed` is also what a read-back mismatch is stored as, so the box may hold half a
    // sentence rather than nothing at all.
    expect(skipReason({ label: 'Name', reason: 'failed' })).toContain('may be wrong');
  });
});
