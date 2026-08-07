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
  parseRequirements,
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

  /**
   * "programme?" made the `?` bind to the final "e" alone, so the pattern matched the British
   * spelling and the typo "programm" and missed "Graduate Program" — which is how most of the
   * boards this reads from write it. A posting with no position type scores as a half-match on
   * type fit and reports no seniority explanation at all.
   */
  it('reads a programme and a program, and a new grad hyphenated or not', () => {
    expect(parsePositionType('Graduate Program 2027')).toBe('new_grad');
    expect(parsePositionType('Graduate Programme 2027')).toBe('new_grad');
    expect(parsePositionType('New-Grad Software Engineer')).toBe('new_grad');
    expect(parsePositionType('Rotational Program 2027')).toBe('trainee_program');
    expect(parsePositionType('Rotational Programme 2027')).toBe('trainee_program');
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
  /**
   * A claim about this role beats a mention of another one, whichever arrangement is
   * mentioned. The remote half of this was fixed first and the onsite half was not, so
   * "This role is onsite in Boston. Our hybrid teams meet on Wednesdays" still came back
   * hybrid — telling a student who can commute that a job in their own city was out of
   * reach, because a sentence about somebody else's team was ranked above the one about
   * theirs.
   */
  it('lets a claim about this role beat a passing mention of another', () => {
    const cases: Array<[string, string | null]> = [
      ['This internship is 100% remote. Our hybrid employees get a commuter benefit.', 'remote'],
      ['This role is onsite in Boston. Our hybrid teams meet on Wednesdays.', 'onsite'],
      ['You will work on-site five days a week. We also have hybrid roles elsewhere.', 'onsite'],
      ["You'll be based in the office. Some teams are hybrid.", 'onsite'],
    ];
    for (const [text, want] of cases) {
      expect(parseWorkArrangement(text), text).toBe(want);
    }
  });

  /** A bare mention is still worth something when nothing claims anything. */
  it('falls back to a bare mention only when no claim is made', () => {
    expect(parseWorkArrangement('Hybrid.')).toBe('hybrid');
    expect(parseWorkArrangement('This position is hybrid, three days a week in office.')).toBe(
      'hybrid',
    );
  });

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

  /**
   * The hybrid branch used to run first on the bare word, so one "hybrid" anywhere in the text
   * beat an explicit "100% remote". The word turns up in benefits paragraphs, in culture prose
   * about other teams, and in comparisons — and a student with hybrid turned off, which is the
   * ordinary setting for someone who cannot commute, was told the posting was hybrid and never
   * saw a job that was open to them.
   */
  it('does not let a passing mention of hybrid beat an explicit remote offer', () => {
    for (const text of [
      'This internship is 100% remote. Our hybrid employees receive a commuter benefit.',
      'This role is fully remote. Other teams at the company work a hybrid schedule.',
      'Unlike our hybrid roles, this position is fully remote.',
      'Remote-first internship. We reimburse coworking space for hybrid staff.',
    ]) {
      expect(parseWorkArrangement(text), text).toBe('remote');
    }
  });

  /** A hybrid claim about THIS job still wins; only the passing mention loses. */
  it('keeps hybrid when the posting says the role itself is hybrid', () => {
    expect(parseWorkArrangement('This position is hybrid, 3 days a week onsite.')).toBe('hybrid');
    expect(parseWorkArrangement('Hybrid: 2 days a week in the office.')).toBe('hybrid');
  });

  /**
   * A description that states two arrangements is describing two jobs, and neither answer is
   * true of the one in front of the user. Unknown shows a badge; picking one filters the
   * posting out of somebody's queue with a confident sentence about it.
   */
  it('answers unknown when the text states two arrangements for two roles', () => {
    expect(
      parseWorkArrangement(
        'We are hiring two interns: one role is hybrid with 3 days onsite, and one is 100% remote.',
      ),
    ).toBeNull();
    expect(
      parseWorkArrangement('This position is onsite in Austin; the other opening is 100% remote.'),
    ).toBeNull();
  });

  /**
   * The negation used to be any "no"/"not" within forty characters of the word, which is a
   * rule about distance rather than meaning. Each of these is a genuinely remote posting that
   * came back `onsite`: labelled with the opposite of what it says, ranked lower for it, and
   * shown with a sentence about commuting from the user's home city.
   */
  it('does not read an unrelated negation in the same sentence as a denial of remote', () => {
    for (const text of [
      'This is a fully remote internship. No relocation support for this remote position.',
      'We do not have an office - this is a remote position.',
      'This is a remote role. There is no fixed schedule for remote team members.',
      'This is a remote role. There is no dress code for remote employees.',
    ]) {
      expect(parseWorkArrangement(text), text).toBe('remote');
    }
  });

  /**
   * The same rule has to hold for the other direction, because a posting wrongly labelled
   * remote is filtered out of the queue of everyone who has remote turned off — with the
   * sentence "This posting is remote and you have remote turned off." on a job in their city.
   */
  it('does not let a passing mention of remote beat an explicit onsite role', () => {
    expect(
      parseWorkArrangement('This position is onsite in Austin. Some remote work may be possible.'),
    ).toBe('onsite');
    expect(parseWorkArrangement('This role is 100% on-site. Our recruiters work remote.')).toBe(
      'onsite',
    );
  });

  /**
   * The two denial lists were written out separately and drifted: hybrid never learned the
   * "unavailable" spelling remote knew, so a posting saying hybrid was unavailable was read as
   * an offer of hybrid. They are built from one template now, and both spellings have to work
   * for both words.
   */
  it('denies hybrid in every wording it denies remote', () => {
    expect(parseWorkArrangement('Hybrid work is unavailable for this position.')).not.toBe(
      'hybrid',
    );
    expect(parseWorkArrangement('We do not offer hybrid schedules for interns.')).not.toBe(
      'hybrid',
    );
    expect(parseWorkArrangement('This role is on-site. Hybrid work is unavailable.')).toBe(
      'onsite',
    );
    expect(parseWorkArrangement('Remote work is unavailable for this position.')).toBe('onsite');
  });

  /**
   * The location word is written on either side of the count, and the pattern only read one of
   * them — so a posting parseWorkArrangement called hybrid had no number saying how much
   * commuting that meant. The bare "in" it used to accept for "in office" matched the "in"
   * inside "internship", which turned a full-time job into five days of commuting.
   */
  it('reads hybrid days whichever side the office is written on', () => {
    expect(parseHybridDays('3 days per week in office')).toBe(3);
    expect(parseHybridDays('3 days onsite per week.')).toBe(3);
    expect(parseHybridDays('Hybrid: 3 days in office per week.')).toBe(3);
    expect(parseHybridDays('Hybrid: 2 days a week onsite.')).toBe(2);
    expect(parseHybridDays('Employees are in the office 4 days per week.')).toBe(4);
    expect(parseHybridDays('hybrid role')).toBeNull();
    expect(parseHybridDays('This is a 5 days a week internship.')).toBeNull();
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

  /**
   * The first week figure in the text used to win outright, so a posting that mentions its
   * leave policy, its onboarding or its application deadline before its own length was stored
   * as a two-week internship. Nothing filters on the field yet; the day a "at least 8 weeks"
   * filter is switched on, those are the postings that vanish.
   */
  it('takes the length of the job, not the first span of time in the text', () => {
    expect(
      parseDurationWeeks(
        'Interns receive 2 weeks of paid time off. The program runs 12 weeks over the summer.',
      ),
    ).toBe(12);
    expect(parseDurationWeeks('Our onboarding takes 1 week. This is a 12 week internship.')).toBe(
      12,
    );
    expect(parseDurationWeeks('Applications close in 2 weeks. The internship runs 12 weeks.')).toBe(
      12,
    );
    expect(parseDurationWeeks('The internship is 12 weeks long.')).toBe(12);
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

  /**
   * The word "unpaid" used to decide the pay on its own, ahead of every other check. It fires
   * on benefits boilerplate that a large share of US postings carry, and each hit scored the
   * posting 0.1 on pay and told the user "the pay is low or unpaid" about a job paying $45
   * an hour.
   */
  it('does not read unpaid leave, or a denial of unpaid work, as an unpaid internship', () => {
    for (const text of [
      'Software Engineering Intern. Pay: $45/hour. Benefits include paid and unpaid leave options.',
      'Interns are paid $50 per hour. We also support unpaid volunteer days.',
      'This internship pays $38/hour. Note: we never ask interns to work unpaid overtime.',
      'Compensation: $42/hour. Unpaid time off may be requested with manager approval.',
      'This is not an unpaid internship; interns are paid $30/hour.',
      'Unlike unpaid internships, ours pays $45 per hour.',
    ]) {
      expect(parseCompensation(text), text).not.toMatchObject({ unpaid: true });
      expect(parseCompensation(text)?.period, text).toBe('hour');
    }
  });

  /** A posting that really is unpaid still says so, and a stray dollar figure does not undo it. */
  it('still reads a genuinely unpaid internship', () => {
    expect(parseCompensation('This is an unpaid internship')).toMatchObject({ unpaid: true });
    expect(
      parseCompensation('This is an unpaid internship. Transportation is reimbursed up to $200.'),
    ).toMatchObject({ unpaid: true });
  });
});

describe('application demands', () => {
  /**
   * Every key spelled its own negation rule and each got it wrong in its own direction: a
   * posting saying it does not want a cover letter was recorded as demanding one, and the
   * commonest way of asking for references — "a cover letter and two references" — was
   * recorded as not asking for them.
   */
  it('reads a demand and a release of one, in either wording', () => {
    expect(parseRequirements('A cover letter is not required.')).toMatchObject({
      coverLetter: false,
    });
    expect(parseRequirements('A cover letter is not necessary.')).toMatchObject({
      coverLetter: false,
    });
    expect(parseRequirements('No cover letter needed.')).toMatchObject({ coverLetter: false });
    expect(parseRequirements('Cover letter optional.')).toMatchObject({ coverLetter: false });
    expect(parseRequirements('References are not required at this stage.')).toMatchObject({
      references: false,
    });
    expect(parseRequirements('Please submit a cover letter and two references.')).toMatchObject({
      coverLetter: true,
      references: true,
    });
    expect(parseRequirements('An unofficial transcript is required.')).toMatchObject({
      transcript: true,
    });
    expect(parseRequirements('A transcript is not required.')).toMatchObject({ transcript: false });
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
   * What the two helpers do when they are composed in this order, which is all this can
   * check: the order is written here in the test body, so it is `decodeEntities` and
   * `stripHtml` under test and not the caller that has to get the order right. The
   * Greenhouse adapter's own ordering is pinned in sources.test.ts, where the adapter is
   * actually driven.
   */
  it('an escaped document decoded first has no markup left after stripping', () => {
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
