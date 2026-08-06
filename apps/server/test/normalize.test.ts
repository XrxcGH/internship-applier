import { describe, expect, it } from 'vitest';
import {
  canonicalUrl,
  fingerprintTitle,
  normalizeCompany,
  normalizeTitle,
  parseCompensation,
  parseDurationWeeks,
  parseHybridDays,
  parsePositionType,
  parseSeason,
  parseTermDates,
  parseWorkArrangement,
  parseYear,
} from '../src/core/discovery/normalize';
import { decodeEntities, stripHtml } from '../src/core/discovery/sources/types';

const NOW = new Date('2026-08-03T00:00:00Z');

describe('season and year', () => {
  it('reads season and year out of a title', () => {
    expect(parseSeason('Software Engineer Intern - Summer 2027')).toBe('summer');
    expect(parseYear('Software Engineer Intern - Summer 2027', NOW)).toBe(2027);
  });

  it('prefers the year adjacent to the season word', () => {
    // "founded in 2019" must not win over the actual term.
    expect(parseYear('Intern, Summer 2027 — a team founded in 2019', NOW)).toBe(2027);
  });

  it('handles a two-digit year', () => {
    expect(parseYear("Summer '27 Analyst", NOW)).toBe(2027);
  });

  it('returns null rather than guessing', () => {
    expect(parseSeason('Software Engineer')).toBeNull();
    expect(parseYear('Software Engineer', NOW)).toBeNull();
    // Out of a plausible hiring range.
    expect(parseYear('Copyright 2011 Acme', NOW)).toBeNull();
  });
});

describe('position type', () => {
  it('recognises the full range, not just "internship"', () => {
    expect(parsePositionType('Co-op Engineer')).toBe('co_op');
    expect(parsePositionType('Research Experience for Undergraduates (REU)')).toBe('research');
    expect(parsePositionType('Summer Analyst Fellowship')).toBe('fellowship');
    expect(parsePositionType('Software Apprentice')).toBe('apprenticeship');
    expect(parsePositionType('New Grad Software Engineer')).toBe('new_grad');
    expect(parsePositionType('Externship - 2 weeks')).toBe('externship');
    expect(parsePositionType('SWE Intern')).toBe('internship');
  });

  it('prefers the title over a passing mention in the body', () => {
    expect(
      parsePositionType('Co-op Software Engineer', 'Our internship program also exists.'),
    ).toBe('co_op');
  });

  it('falls back to the description when the title is uninformative', () => {
    expect(parsePositionType('Engineering, Students', 'This is a 12-week internship.')).toBe(
      'internship',
    );
  });

  it('returns null when nothing matches', () => {
    expect(parsePositionType('Staff Engineer', 'Lead a team.')).toBeNull();
  });
});

describe('work arrangement', () => {
  it('distinguishes the arrangements', () => {
    expect(parseWorkArrangement('This is a hybrid role')).toBe('hybrid');
    expect(parseWorkArrangement('Fully remote position')).toBe('remote');
    expect(parseWorkArrangement('On-site in Boston')).toBe('onsite');
  });

  it('catches geo-restricted remote', () => {
    expect(parseWorkArrangement('Fully remote — must reside in California')).toBe(
      'remote_geo_restricted',
    );
  });

  /**
   * Real postings phrase this a dozen ways, and every one of them used to come back
   * `remote`. For a student who has remote turned off that is a filtered-out posting with
   * the explanation "This posting is remote and you have remote turned off." — the literal
   * opposite of what the posting says — and for everyone else it is a row labelled
   * "Remote" with the stated city discarded.
   */
  it('does not read a negation as remote, however it is worded', () => {
    for (const text of [
      'This role is not remote.',
      'no remote work',
      'Remote work is not available for this position',
      'Remote work is not offered.',
      'We do not offer remote work for this internship.',
      'This is an in-office role. Remote work is not available.',
      'Please note: remote work is not permitted.',
      'This position is not eligible for remote work.',
      'Candidates must work on-site; we are unable to accommodate remote arrangements.',
      'This role is 100% onsite in our New York office. This is not a remote internship.',
      'This is not a fully remote role; you will be in office 5 days',
    ]) {
      expect(parseWorkArrangement(text), text).toBe('onsite');
    }
  });

  /** "hybrid" appearing inside the list of things on offer is not an offer of hybrid. */
  it('does not read a negation as hybrid', () => {
    expect(parseWorkArrangement('No remote or hybrid options are available.')).toBe('onsite');
  });

  /**
   * The negation window stops at clause punctuation, so a "not" about something else in a
   * later sentence cannot cost a genuinely remote posting its arrangement.
   */
  it('does not let an unrelated negation cancel a real remote offer', () => {
    expect(parseWorkArrangement('Fully remote. You will not be required to relocate.')).toBe(
      'remote',
    );
    expect(parseWorkArrangement('This role is remote and is not restricted to any state.')).toBe(
      'remote',
    );
    expect(parseWorkArrangement('This is a hybrid role, not a remote one.')).toBe('hybrid');
  });

  it('reads hybrid days', () => {
    expect(parseHybridDays('3 days per week in office')).toBe(3);
    expect(parseHybridDays('hybrid role')).toBeNull();
  });
});

describe('term dates and duration', () => {
  it('parses an explicit window', () => {
    expect(parseTermDates('Runs June 2027 - August 2027')).toEqual({
      start: '2027-06',
      end: '2027-08',
    });
  });

  it('parses weeks and months', () => {
    expect(parseDurationWeeks('a 12 week internship')).toBe(12);
    expect(parseDurationWeeks('10-12 weeks')).toBe(11);
    expect(parseDurationWeeks('6 month co-op')).toBe(26);
  });
});

describe('compensation', () => {
  it('reads hourly ranges', () => {
    expect(parseCompensation('$25 - $35 per hour')).toMatchObject({
      min: 25,
      max: 35,
      period: 'hour',
    });
  });

  it('marks unpaid and credit-only explicitly', () => {
    expect(parseCompensation('This is an unpaid internship')).toMatchObject({ unpaid: true });
    expect(parseCompensation('Offered for academic credit only')).toMatchObject({
      academicCreditOnly: true,
    });
  });

  it('infers a period from magnitude when the unit is missing', () => {
    expect(parseCompensation('$30')).toMatchObject({ period: 'hour' });
    expect(parseCompensation('$95,000')).toMatchObject({ period: 'year' });
  });

  /** Silence about pay is not a claim of unpaid — see the filter rules in docs/05. */
  it('returns null when pay is simply not mentioned', () => {
    expect(parseCompensation('Great team, great mission.')).toBeNull();
  });
});

describe('identity normalisation', () => {
  it('strips tracking params and normalises the host', () => {
    expect(canonicalUrl('https://WWW.Example.com/jobs/1?utm_source=x&gh_src=y&b=2#top')).toBe(
      'https://example.com/jobs/1?b=2',
    );
  });

  it('collapses title noise so the same req matches', () => {
    expect(normalizeTitle('Software Engineer Intern (Summer 2027) - Req #12345')).toBe(
      'software engineer intern',
    );
    expect(normalizeTitle('Software Engineer II')).toBe('software engineer');
  });

  /**
   * On a Greenhouse board the team name in brackets is often the only difference between
   * two separate requisitions. Deleting it made them the same title, dedupe treated the
   * second as a copy, and the user never saw that the other opening existed.
   */
  it('keeps a bracketed team name, because it is what tells two openings apart', () => {
    expect(normalizeTitle('Software Engineer Intern (Backend)')).not.toBe(
      normalizeTitle('Software Engineer Intern (Frontend)'),
    );
    expect(normalizeTitle('Research Intern [Ads]')).not.toBe(
      normalizeTitle('Research Intern [Payments]'),
    );
    expect(normalizeTitle('Software Engineer Intern (Backend)')).toBe(
      'software engineer intern backend',
    );
  });

  /**
   * The dedupe fingerprint merges on this key alone, so it has to hold on to every token
   * that could mean a second opening — a level, or a term. A Summer and a Fall requisition
   * merging is not just a lost row: the survivor is the Summer one, and a student who is
   * only free in the fall is then told they are ineligible for a job that was open to them.
   */
  it('keeps levels and terms in the identity form, which stage-2 dedupe merges on', () => {
    expect(fingerprintTitle('Machine Learning Intern I')).not.toBe(
      fingerprintTitle('Machine Learning Intern II'),
    );
    expect(fingerprintTitle('Software Engineer Intern - Summer 2026')).not.toBe(
      fingerprintTitle('Software Engineer Intern - Fall 2026'),
    );
    expect(fingerprintTitle('Software Engineer Intern (Backend)')).not.toBe(
      fingerprintTitle('Software Engineer Intern (Frontend)'),
    );
  });

  /**
   * Boards write the term inside brackets at least as often as after a dash, so a rule that
   * only protects the dashed form protects the rarer half. "(Summer 2026)" and "(Fall 2026)"
   * are two openings a year apart, and "(II)" and "(III)" are two levels.
   */
  it('keeps a level or a term that is written inside the brackets', () => {
    expect(fingerprintTitle('Software Engineer Intern (Summer 2026)')).not.toBe(
      fingerprintTitle('Software Engineer Intern (Fall 2026)'),
    );
    expect(fingerprintTitle('Data Science Intern [Summer 2026]')).not.toBe(
      fingerprintTitle('Data Science Intern [Summer 2027]'),
    );
    expect(fingerprintTitle('Software Engineer Intern (II)')).not.toBe(
      fingerprintTitle('Software Engineer Intern (III)'),
    );
    expect(fingerprintTitle('Software Engineer Intern (Summer 2026)')).toBe(
      'software engineer intern summer 2026',
    );
  });

  /**
   * A requisition id is the one part of a title that belongs to the listing rather than to
   * the job, so it is the only thing the identity form is allowed to throw away — otherwise
   * one board's "Req #9931" would be enough to make the same opening look like two.
   */
  it('still drops requisition ids from the identity form, bracketed or not', () => {
    expect(fingerprintTitle('Software Engineer Intern - Req #9931')).toBe(
      'software engineer intern',
    );
    expect(fingerprintTitle('Software Engineer Intern (Req #9931)')).toBe(
      'software engineer intern',
    );
    expect(fingerprintTitle('Software Engineer Intern (Job ID 4471)')).toBe(
      'software engineer intern',
    );
  });

  /**
   * Two boards spelling one job differently are a different source by definition, so the
   * pair that has to collapse is stage 3's problem, and stage 3 uses the aggressive form.
   */
  it('collapses two spellings of one job in the token-matching form', () => {
    expect(normalizeTitle('Software Engineer Intern (Summer 2027)')).toBe(
      normalizeTitle('Software Engineer Intern - Req #9931'),
    );
  });

  it('collapses company suffixes', () => {
    expect(normalizeCompany('Acme, Inc.')).toBe('acme');
    expect(normalizeCompany('ACME LLC')).toBe('acme');
  });
});

describe('reading HTML out of a feed', () => {
  /**
   * Greenhouse returns its job content ESCAPED. Stripping tags first finds none to strip,
   * and stripHtml's own decode step then puts the markup back as literal text — so every
   * requirement parser and the model read "<p>" and "<li>" as part of the job
   * description, and the UI rendered them on screen.
   */
  it('decodes an escaped document before the tags are stripped', () => {
    const escaped =
      '&lt;p&gt;About the role&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;';
    const text = stripHtml(decodeEntities(escaped));
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).toMatch(/About the role/);
    expect(text).toMatch(/Python/);
  });

  it('leaves an already-plain document alone', () => {
    expect(stripHtml(decodeEntities('<p>About the role</p>'))).toBe('About the role');
  });

  it('decodes the ampersand last, so an escaped entity does not become a tag', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('handles the quotes and apostrophes a job description is full of', () => {
    expect(decodeEntities('We&#39;re hiring &quot;interns&quot; &amp; grads')).toBe(
      'We\'re hiring "interns" & grads',
    );
  });
});
