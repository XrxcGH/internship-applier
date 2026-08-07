/**
 * The tracker's deterministic core.
 *
 * Three things here are load-bearing and the rest is arithmetic:
 *   - the tool cannot mark an application submitted, because it never submitted it;
 *   - a rate computed from five data points is refused rather than shown;
 *   - a CSV cell cannot become a spreadsheet formula.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import type { ApplicationStatus } from '@ia/shared';
import { buildApp } from '../src/app';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import {
  canTransition,
  BOARD_COLUMNS,
  columnFor,
  derive,
  GHOST_AFTER_DAYS,
  type TrackedApplication,
} from '../src/core/tracking/status';
import { computeStats, MIN_FOR_RATE } from '../src/core/tracking/stats';
import {
  buildReminders,
  draftFollowUp,
  FOLLOW_UP_AFTER_DAYS,
} from '../src/core/tracking/reminders';
import { toCsv } from '../src/core/tracking/exportCsv';

const NOW = new Date('2026-08-04T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

function app(over: Partial<TrackedApplication> = {}): TrackedApplication {
  return {
    id: 'a1',
    status: 'draft',
    company: 'Northwind Systems',
    title: 'Software Engineering Intern',
    applyUrl: 'https://example.com/apply',
    source: 'greenhouse',
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    submittedAt: null,
    respondedAt: null,
    advancedAt: null,
    deadlineAt: null,
    answerCount: 0,
    approvedCount: 0,
    ...over,
  };
}

describe('who may move an application forward', () => {
  it('lets the tool prepare but never submit', () => {
    expect(canTransition('draft', 'answers_ready', 'tool').ok).toBe(true);
    expect(canTransition('filled', 'awaiting_submit', 'tool').ok).toBe(true);

    const refused = canTransition('awaiting_submit', 'submitted', 'tool');
    expect(refused.ok).toBe(false);
    // The reason has to say WHY, not just "not allowed".
    expect(refused.ok === false && refused.reason).toMatch(/never submitted it/i);
  });

  it('lets the user report what happened in the world', () => {
    expect(canTransition('awaiting_submit', 'submitted', 'user').ok).toBe(true);
    expect(canTransition('submitted', 'interview', 'user').ok).toBe(true);
    expect(canTransition('interview', 'offer', 'user').ok).toBe(true);
  });

  it('does not insist on stages real hiring skips', () => {
    // Plenty of employers go straight from application to interview with no ack.
    expect(canTransition('submitted', 'interview', 'user').ok).toBe(true);
    expect(canTransition('submitted', 'offer', 'user').ok).toBe(true);
    // And a second interview round is not a new status.
    expect(canTransition('interview', 'interview', 'user').ok).toBe(true);
  });

  it('refuses to let anyone hand-set ghosted', () => {
    const r = canTransition('submitted', 'ghosted', 'user');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/worked out from how long/i);
  });

  it('treats finished applications as finished', () => {
    const r = canTransition('rejected', 'interview', 'user');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/has finished/i);
  });

  it('allows withdrawing from anywhere still open', () => {
    for (const s of [
      'draft',
      'answers_ready',
      'filled',
      'awaiting_submit',
      'submitted',
    ] as ApplicationStatus[]) {
      expect(canTransition(s, 'withdrawn', 'user').ok, s).toBe(true);
    }
  });
});

describe('what needs the user, one thing at a time', () => {
  it('puts a passed deadline above everything else', () => {
    const d = derive(
      app({ status: 'draft', deadlineAt: daysAgo(3), answerCount: 2, approvedCount: 2 }),
      NOW,
    );
    expect(d.attention).toBe('deadline_passed');
    expect(d.nudge).toMatch(/closed 3 days ago/);
  });

  it('warns before a deadline, in days', () => {
    const d = derive(app({ deadlineAt: daysAhead(3) }), NOW);
    expect(d.attention).toBe('deadline_soon');
    expect(d.nudge).toBe('This closes in 3 days.');
  });

  it('says "today" rather than "in 0 days"', () => {
    expect(derive(app({ deadlineAt: daysAhead(0) }), NOW).nudge).toBe('This closes today.');
  });

  it('surfaces a filled form waiting on the user', () => {
    const d = derive(app({ status: 'awaiting_submit' }), NOW);
    expect(d.attention).toBe('awaiting_your_submit');
    expect(d.nudge).toMatch(/submit it yourself/i);
  });

  it('counts the answers still needing approval', () => {
    const d = derive(app({ answerCount: 3, approvedCount: 1 }), NOW);
    expect(d.nudge).toBe('2 answers still need your approval.');
    expect(derive(app({ answerCount: 2, approvedCount: 1 }), NOW).nudge).toBe(
      '1 answer still needs your approval.',
    );
  });

  it('reports readiness once every answer is approved', () => {
    const d = derive(app({ answerCount: 2, approvedCount: 2 }), NOW);
    expect(d.attention).toBe('ready_to_fill');
  });

  it('derives ghosted from silence rather than asking', () => {
    const quiet = derive(
      app({ status: 'submitted', submittedAt: daysAgo(GHOST_AFTER_DAYS + 1) }),
      NOW,
    );
    expect(quiet.effectiveStatus).toBe('ghosted');
    // And says so kindly, because the user did not do anything wrong.
    expect(quiet.nudge).toMatch(/following up, or letting go/i);

    // The boundary day itself, because the rule is `>=` and nothing pinned that. The
    // comparable threshold in reminders.ts is tested at its exact boundary; this was the
    // odd one out.
    const exactly = derive(
      app({ status: 'submitted', submittedAt: daysAgo(GHOST_AFTER_DAYS) }),
      NOW,
    );
    expect(exactly.effectiveStatus).toBe('ghosted');

    const dayBefore = derive(
      app({ status: 'submitted', submittedAt: daysAgo(GHOST_AFTER_DAYS - 1) }),
      NOW,
    );
    expect(dayBefore.effectiveStatus).toBe('submitted');

    const recent = derive(app({ status: 'submitted', submittedAt: daysAgo(10) }), NOW);
    expect(recent.effectiveStatus).toBe('submitted');
    expect(recent.attention).toBe('none');
  });

  /**
   * The silence clock for an acknowledged application used to be anchored on `updatedAt`,
   * the row's generic last-modified stamp. Every status write rewrites that column, and
   * re-setting a status to the one it already has is a legal write, so a user tidying the
   * board and clicking "Acknowledged" on a card that already said Acknowledged reset four
   * months of silence to zero. The verdict could be postponed indefinitely by touching the
   * row, which is exactly the opposite of what a ghosting clock is for.
   */
  it('does not restart the ghosting clock when the row is merely touched', () => {
    const acknowledged = app({
      status: 'acknowledged',
      submittedAt: daysAgo(120),
      respondedAt: daysAgo(GHOST_AFTER_DAYS + 10),
      // Touched a minute ago, as a no-op status re-set leaves it.
      updatedAt: daysAgo(0),
    });

    const d = derive(acknowledged, NOW);
    expect(d.effectiveStatus).toBe('ghosted');
    expect(d.attention).toBe('silent');
    expect(d.daysQuiet).toBe(GHOST_AFTER_DAYS + 10);
    // And the number in the sentence is the number in the payload.
    expect(d.nudge).toBe(
      `No word for ${String(GHOST_AFTER_DAYS + 10)} days. Worth following up, or letting go.`,
    );
  });

  it('counts silence from the reply, not from the submission', () => {
    // Answered on day ten of ninety: quiet for eighty days, not ninety.
    const d = derive(
      app({ status: 'acknowledged', submittedAt: daysAgo(90), respondedAt: daysAgo(80) }),
      NOW,
    );
    expect(d.daysQuiet).toBe(80);
    expect(d.daysSinceSubmitted).toBe(90);

    // And an employer who wrote back recently is not silent at all, however long ago the
    // application went out.
    const recent = derive(
      app({ status: 'acknowledged', submittedAt: daysAgo(200), respondedAt: daysAgo(3) }),
      NOW,
    );
    expect(recent.effectiveStatus).toBe('acknowledged');
  });

  it('falls back to the submission date when no reply was ever recorded', () => {
    // Rows written before the status history was read carry no respondedAt.
    const d = derive(
      app({
        status: 'acknowledged',
        submittedAt: daysAgo(GHOST_AFTER_DAYS + 2),
        respondedAt: null,
        updatedAt: daysAgo(0),
      }),
      NOW,
    );
    expect(d.effectiveStatus).toBe('ghosted');
  });

  it('maps every status to a board column', () => {
    const all: ApplicationStatus[] = [
      'draft',
      'answers_ready',
      'filled',
      'awaiting_submit',
      'submitted',
      'acknowledged',
      'interview',
      'offer',
      'rejected',
      'withdrawn',
      'ghosted',
    ];
    // `toBeTruthy` asserted nothing here: columnFor ends in `?? 'closed'`, a non-empty
    // string, so it passed for any input whether BOARD_COLUMNS contained it or not. The
    // question is membership, so that is what this asks.
    for (const s of all) {
      expect(
        BOARD_COLUMNS.some((c) => c.statuses.includes(s)),
        `${s} is not in any board column, so it would silently land in "closed"`,
      ).toBe(true);
      expect(columnFor(s), s).toBe(BOARD_COLUMNS.find((c) => c.statuses.includes(s))!.key);
    }
  });
});

describe('refusing to compute a rate from noise', () => {
  const submitted = (n: number, status: ApplicationStatus = 'rejected') =>
    Array.from({ length: n }, (_, i) =>
      app({ id: `s${String(i)}`, status, submittedAt: daysAgo(20) }),
    );

  it('returns null with a reason below the threshold', () => {
    const s = computeStats(submitted(5), NOW);
    expect(s.responseRate.value).toBeNull();
    expect(s.responseRate.denominator).toBe(5);
    expect(s.responseRate.why).toMatch(/mostly noise/i);
  });

  it('says so plainly when nothing has been submitted', () => {
    const s = computeStats([app(), app({ id: 'a2' })], NOW);
    expect(s.responseRate.why).toMatch(/no submitted applications yet/i);
    expect(s.notes.join(' ')).toMatch(/none submitted yet/i);
  });

  it('computes a rate once there is enough to compute one from', () => {
    const apps = [
      ...submitted(MIN_FOR_RATE, 'rejected'),
      ...Array.from({ length: MIN_FOR_RATE }, (_, i) =>
        app({ id: `i${String(i)}`, status: 'interview', submittedAt: daysAgo(20) }),
      ),
    ];
    const s = computeStats(apps, NOW);
    expect(s.responseRate.value).toBe(1);
    expect(s.responseRate.denominator).toBe(2 * MIN_FOR_RATE);
    expect(s.responseRate.why).toBeUndefined();
  });

  it('carries the counts even when it refuses the rate', () => {
    // Five submitted, and all five have heard back — a rejection is a response, so the
    // three rejections count alongside the two interviews. The percentage is withheld
    // only because five is under MIN_FOR_RATE, and the user should still see "5 of 5"
    // rather than a blank where the counts were.
    const s = computeStats(
      [
        ...submitted(3, 'rejected'),
        ...Array.from({ length: 2 }, (_, i) =>
          app({ id: `x${String(i)}`, status: 'interview', submittedAt: daysAgo(20) }),
        ),
      ],
      NOW,
    );
    expect(s.responseRate.numerator).toBe(5);
    expect(s.responseRate.denominator).toBe(5);
    expect(s.responseRate.value).toBeNull();
  });

  /**
   * The tile says "Reached interview", which is a claim about what has ever happened. An
   * interview is a status an application passes through on its way to a rejection or an
   * offer, so a count of who is sitting in `interview` right now answers a different
   * question — and answers this one with a confident, wrong zero.
   */
  it('counts interviews that ended in a rejection', () => {
    const apps = [
      ...Array.from({ length: 8 }, (_, i) =>
        app({ id: `r${String(i)}`, status: 'rejected', submittedAt: daysAgo(40) }),
      ),
      // Reached an interview, then were turned down. Honestly recorded, both transitions.
      ...Array.from({ length: 4 }, (_, i) =>
        app({
          id: `x${String(i)}`,
          status: 'rejected',
          submittedAt: daysAgo(40),
          respondedAt: daysAgo(30),
          advancedAt: daysAgo(25),
        }),
      ),
    ];

    const s = computeStats(apps, NOW);
    expect(s.funnel.submitted).toBe(12);
    expect(s.funnel.interviewing, 'nobody is mid-interview today').toBe(0);
    expect(s.funnel.reachedInterview, 'four of them got that far').toBe(4);
    expect(s.interviewRate.numerator).toBe(4);
    expect(s.interviewRate.denominator).toBe(12);
    expect(s.interviewRate.value).toBeCloseTo(0.33, 2);

    // The per-source column asks the same cumulative question and has to agree with it.
    expect(s.bySource.find((g) => g.key === 'greenhouse')?.advanced).toBe(4);
  });

  it('still counts an application currently sitting in an interview', () => {
    const s = computeStats(
      [
        ...Array.from({ length: 11 }, (_, i) =>
          app({ id: `r${String(i)}`, status: 'rejected', submittedAt: daysAgo(40) }),
        ),
        app({ id: 'live', status: 'interview', submittedAt: daysAgo(10) }),
      ],
      NOW,
    );
    expect(s.funnel.reachedInterview).toBe(1);
    expect(s.interviewRate.numerator).toBe(1);
  });

  it('does not blame the user for silence', () => {
    const s = computeStats(
      [app({ status: 'submitted', submittedAt: daysAgo(GHOST_AFTER_DAYS + 5) })],
      NOW,
    );
    expect(s.funnel.ghosted).toBe(1);
    expect(s.notes.join(' ')).toMatch(/says nothing about you/i);
  });
});

describe('reminders are drafts, never sends', () => {
  it('waits two weeks before suggesting a follow-up', () => {
    const early = buildReminders([app({ status: 'submitted', submittedAt: daysAgo(5) })], NOW);
    expect(early.filter((r) => r.kind === 'follow_up')).toHaveLength(0);

    const due = buildReminders(
      [app({ status: 'submitted', submittedAt: daysAgo(FOLLOW_UP_AFTER_DAYS) })],
      NOW,
    );
    expect(due.filter((r) => r.kind === 'follow_up')).toHaveLength(1);
  });

  it('stops suggesting one once silence has run long enough to mean no', () => {
    const gone = buildReminders(
      [app({ status: 'submitted', submittedAt: daysAgo(GHOST_AFTER_DAYS + 5) })],
      NOW,
    );
    expect(gone.filter((r) => r.kind === 'follow_up')).toHaveLength(0);
  });

  it('sorts the most urgent first', () => {
    const rs = buildReminders(
      [
        app({ id: 'b', status: 'submitted', submittedAt: daysAgo(20) }),
        app({ id: 'a', status: 'draft', deadlineAt: daysAgo(1) }),
      ],
      NOW,
    );
    expect(rs[0]!.applicationId).toBe('a');
  });

  it('drafts a follow-up in the same plain register as the answers', () => {
    const text = draftFollowUp(app({ status: 'submitted', submittedAt: daysAgo(15) }), NOW);
    expect(text).toContain('Subject:');
    // The vocabulary the tell-scrub blocks must not appear in something the user sends.
    expect(text).not.toMatch(/reach out|circle back|touch base|synerg|leverage|delve/i);
    expect(text).not.toContain('—');
    expect(text.split('\n').length).toBeLessThan(14);
  });

  /**
   * The timing phrase was "two weeks ago" for anything under 21 days, so a follow-up
   * drafted the day after applying opened with a plain untruth. In a tool that checks
   * every drafted sentence against the profile before it goes near an employer, outgoing
   * correspondence does not get an exemption.
   */
  it('does not claim two weeks have passed when they have not', () => {
    const yesterday = draftFollowUp(app({ status: 'submitted', submittedAt: daysAgo(1) }), NOW);
    expect(yesterday).not.toMatch(/two weeks ago/);
    expect(yesterday).toMatch(/yesterday/);

    const threeDays = draftFollowUp(app({ status: 'submitted', submittedAt: daysAgo(3) }), NOW);
    expect(threeDays).toMatch(/3 days ago/);

    const lastWeek = draftFollowUp(app({ status: 'submitted', submittedAt: daysAgo(9) }), NOW);
    expect(lastWeek).toMatch(/last week/);
  });

  it('says something honest when there is no submission date at all', () => {
    expect(draftFollowUp(app({ status: 'submitted', submittedAt: null }), NOW)).toMatch(/recently/);
  });
});

describe('reply time', () => {
  /**
   * This was measured from submission to NOW, so the figure under "Typical reply time"
   * climbed by one every day, forever, for applications answered months ago.
   */
  it('measures to the response, not to the present', () => {
    const apps = Array.from({ length: 3 }, (_, i) =>
      app({
        id: `r${String(i)}`,
        status: 'rejected',
        submittedAt: daysAgo(100),
        respondedAt: daysAgo(90),
      }),
    );
    expect(computeStats(apps, NOW).medianDaysToResponse).toBe(10);

    // A year later, the same applications still took ten days.
    const later = new Date(NOW.getTime() + 365 * 86_400_000);
    expect(computeStats(apps, later).medianDaysToResponse).toBe(10);
  });

  it('ignores applications that have not heard back', () => {
    const apps = [
      app({ id: 'x1', status: 'submitted', submittedAt: daysAgo(30) }),
      app({ id: 'x2', status: 'submitted', submittedAt: daysAgo(10) }),
    ];
    expect(computeStats(apps, NOW).medianDaysToResponse).toBeNull();
  });
});

describe('CSV export', () => {
  it('round-trips ordinary values', () => {
    const csv = toCsv([app({ company: 'Northwind', title: 'Intern' })], NOW);
    expect(csv.split('\r\n')[0]).toContain('Company');
    expect(csv).toContain('Northwind');
  });

  it('escapes commas, quotes, and newlines', () => {
    const csv = toCsv([app({ company: 'Acme, Inc. "The" Co', title: 'A\nB' })], NOW);
    expect(csv).toContain('"Acme, Inc. ""The"" Co"');
    expect(csv).toContain('"A\nB"');
  });

  it('defuses a cell that would run as a spreadsheet formula', () => {
    // Company names come off the internet. A CSV that executes on open is a real problem.
    for (const dangerous of ['=1+1', '+cmd', '-2', '@SUM(A1)']) {
      const csv = toCsv([app({ company: dangerous })], NOW);
      expect(csv, dangerous).toContain(`'${dangerous}`);
    }
  });

  it('uses CRLF, which is what the format says and what Excel expects', () => {
    expect(toCsv([app()], NOW)).toContain('\r\n');
  });
});

/**
 * Gate G4 is the strongest promise this app makes: nothing here submits an application, so
 * the only way a row becomes `submitted` is a person saying they did it. Half of that is
 * structural — there is no submit endpoint — and the other half is this route refusing to
 * take the claim on trust. Both halves are checked below, because the machine-checkable one
 * was decorative for a while: the schema asked for `{ confirmed: true }` and the route never
 * read a body, so any request that reached the URL stamped `submitted` on whatever it found,
 * including a draft with no approved answers.
 */
describe('marking submitted takes the user at their word, and asks for it', () => {
  let server: FastifyInstance;
  let profileId: string;

  beforeAll(async () => {
    runMigrations();
    server = await buildApp({ skipAuth: true });
    await server.ready();

    profileId = ulid();
    db.insert(schema.profile)
      .values({ id: profileId, fullName: 'x', email: 'x', payload: {}, derived: {} } as never)
      .run();
  });

  afterAll(async () => {
    await server.close();
  });

  /** A posting, a match, and an application sitting in `status`. Returns the application id. */
  function seed(status: ApplicationStatus): string {
    const postingId = ulid();
    db.insert(schema.jobPosting)
      .values({
        id: postingId,
        canonicalUrl: `https://example.com/j/${postingId}`,
        applyUrl: `https://example.com/j/${postingId}/apply`,
        company: 'Northwind Systems',
        title: 'Software Engineering Intern',
        descriptionText: 'Summer internship.',
        fingerprint: postingId,
      })
      .run();

    const matchId = ulid();
    db.insert(schema.match)
      .values({
        id: matchId,
        postingId,
        profileId,
        eligibility: 'eligible',
        rules: [],
        blockers: [],
        score: 80,
        breakdown: {},
        rationale: 'test',
      })
      .run();

    const id = ulid();
    db.insert(schema.application)
      .values({ id, matchId, status, applyUrl: `https://example.com/j/${postingId}/apply` })
      .run();
    return id;
  }

  const markSubmitted = (id: string, payload?: Record<string, unknown>) => {
    const url = `/api/applications/${id}/mark-submitted`;
    return payload === undefined
      ? server.inject({ method: 'POST', url })
      : server.inject({ method: 'POST', url, payload });
  };

  it('records the submission when the user confirms it', async () => {
    const id = seed('awaiting_submit');
    const res = await markSubmitted(id, { confirmed: true });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('submitted');
    expect(res.json().submittedAt).toBeTruthy();

    // The event log says who did it, because that distinction is the whole design.
    const marked = db
      .select()
      .from(schema.applicationEvent)
      .all()
      .find((e) => e.applicationId === id && e.type === 'marked_submitted')!;
    expect((marked.payload as { by: string }).by).toBe('user');
  });

  it('refuses a request that never says the user confirmed anything', async () => {
    const id = seed('awaiting_submit');

    for (const payload of [undefined, {}, { confirmed: false }, { confirmed: 'yes' }]) {
      const res = await markSubmitted(id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('CONFIRMATION_REQUIRED');
    }

    // Nothing was written on the way to any of those refusals.
    const row = db
      .select()
      .from(schema.application)
      .all()
      .find((a) => a.id === id)!;
    expect(row.status).toBe('awaiting_submit');
    expect(row.submittedAt).toBeNull();
  });

  it('refuses to call an application submitted that was never even filled', async () => {
    // A draft has no approved answers and no filled form. Whatever the caller confirmed,
    // it was not this application going to an employer.
    const id = seed('draft');
    const res = await markSubmitted(id, { confirmed: true });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');

    const row = db
      .select()
      .from(schema.application)
      .all()
      .find((a) => a.id === id)!;
    expect(row.status).toBe('draft');
    expect(row.submittedAt).toBeNull();
  });

  it('still has no endpoint that does the submitting', async () => {
    const id = seed('awaiting_submit');
    for (const url of [
      `/api/applications/${id}/submit`,
      `/api/applications/${id}/fill/submit`,
      `/api/applications/${id}/send`,
    ]) {
      expect((await server.inject({ method: 'POST', url })).statusCode, url).toBe(404);
    }
  });
});
