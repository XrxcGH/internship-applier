import { describe, expect, it } from 'vitest';
import { findTells, summarize } from '../src/core/writing/tellScrub';

const kinds = (text: string, opts = {}) => findTells(text, opts).map((t) => t.kind);

describe('lexical tells', () => {
  it('catches the openings that appear on half of all applications', () => {
    expect(kinds('I am writing to express my strong interest in this role.')).toContain(
      'cliche_opener',
    );
    expect(kinds('I am excited to apply for the Summer 2027 internship.')).toContain(
      'cliche_opener',
    );
    expect(kinds('As a passionate developer, I have always loved building.')).toContain(
      'cliche_opener',
    );
  });

  it('catches over-represented vocabulary', () => {
    for (const w of [
      'I want to delve into the problem.',
      'This is a testament to my growth.',
      'I leveraged my skills to build it.',
      'In the realm of distributed systems.',
      'I built a robust and seamless pipeline.',
      "In today's fast-paced world, engineers must adapt.",
    ]) {
      expect(kinds(w), w).toContain('overused_word');
    }
  });

  it('catches corporate register', () => {
    expect(kinds('I utilized Python in order to facilitate the analysis.')).toContain(
      'corporate_register',
    );
  });

  it('catches hollow intensifiers', () => {
    expect(kinds('I am truly passionate about this work.')).toContain('hollow_intensifier');
  });

  /** If this ever reaches a submitted application, something has gone badly wrong. */
  it('catches assistant voice', () => {
    expect(kinds('As an AI, I do not have personal experience with this.')).toContain(
      'assistant_voice',
    );
  });

  it('leaves plain, specific writing alone', () => {
    const good =
      "I spent last summer rewriting Acme's ingestion pipeline in Python. It was slow because " +
      'every row hit the database twice. I batched the writes. Latency dropped by about half, ' +
      "which mattered because the on-call rotation had been getting paged for it. That's the " +
      'kind of problem I want more of.';
    expect(findTells(good)).toEqual([]);
  });

  it('does not flag a word used in its literal sense where excluded', () => {
    expect(kinds('Use the menu to navigate to the settings page.')).not.toContain('overused_word');
  });
});

describe('structural tells', () => {
  /** The loudest one. Real writing lurches; generated prose paces evenly. */
  it('catches flattened sentence rhythm', () => {
    const flat =
      'I worked on the backend service for six months there. ' +
      'I improved the performance of several database queries. ' +
      'I collaborated with the team on the new feature set. ' +
      'I learned a great deal about distributed system design. ' +
      'I would like to continue this work at your company.';
    expect(kinds(flat)).toContain('uniform_rhythm');
  });

  it('does not flag writing with natural variation', () => {
    const varied =
      'I broke the build. Twice. The second time was worse, because I had convinced myself ' +
      'the first fix was solid and pushed it on a Friday afternoon without running the ' +
      'integration suite locally first. Now I run it. Every time.';
    expect(kinds(varied)).not.toContain('uniform_rhythm');
  });

  it('catches stacked formal connectives at paragraph starts', () => {
    const stacked =
      'I built the service and shipped it to production last spring.\n\n' +
      'Furthermore, I documented the whole deployment process for the team.\n\n' +
      'Moreover, I trained two new engineers on the on-call rotation schedule.';
    expect(kinds(stacked)).toContain('transition_stack');
  });

  it('catches triadic list overuse', () => {
    const triads =
      'I am organised, curious, and persistent in my work every day. ' +
      'The role needs planning, coordination, and follow-through from me. ' +
      'I bring energy, focus, and care to every single project I take on. ' +
      'My tools are Python, Postgres, and Docker for most of this work.';
    expect(kinds(triads)).toContain('triadic_overuse');
  });

  /**
   * Density is only a tell relative to how the person actually writes. Someone whose own
   * samples are full of em-dashes should not be told to remove them.
   */
  it('judges em-dash density against the writer, not an absolute', () => {
    const dashes =
      'I joined the team in June — the busiest month — and immediately broke the build — twice. ' +
      'The fix was simple — a missing index — but finding it took a week of digging.';

    // 5 em-dashes in 30 words is ~16.7 per 100, so it trips a normal baseline.
    expect(kinds(dashes)).toContain('em_dash_density');
    // The rule fires above twice the writer's own rate, so only someone who genuinely
    // writes this way (10 per 100) is left alone. That is the point: density is a tell
    // relative to the person, not an absolute.
    expect(kinds(dashes, { baselineEmDashPer100: 10 })).not.toContain('em_dash_density');
  });

  it('skips structural checks on text too short to judge', () => {
    expect(findTells('Short answer here.')).toEqual([]);
  });
});

describe('reporting', () => {
  it('summarises for a badge', () => {
    expect(summarize([])).toMatch(/nothing/i);
    expect(summarize(findTells('I am truly passionate and utilized synergy.'))).toMatch(/\d/);
  });

  it('returns spans that map back onto the text', () => {
    const text = 'I want to delve into this work.';
    const t = findTells(text)[0]!;
    expect(text.slice(t.span.start, t.span.end).toLowerCase()).toBe(t.match.toLowerCase());
  });

  it('offers a concrete replacement, not just a complaint', () => {
    const t = findTells('I utilized the framework.')[0]!;
    expect(t.suggestion).toBe('use');
  });
});

/**
 * Patterns added after researching what actually characterises machine-generated prose
 * (stylometry literature plus current editorial reporting). Sources in docs/06.
 */
describe('researched patterns', () => {
  it('catches the contrast reframe, the most reported current giveaway', () => {
    expect(kinds("It's not just a job, it's a chance to build something.")).toContain(
      'contrast_reframe',
    );
    expect(kinds("This isn't about the money, it's about the work.")).toContain('contrast_reframe');
    expect(kinds('Not only did I ship it, but also I documented it.')).toContain(
      'contrast_reframe',
    );
  });

  it('catches false-payoff openers', () => {
    expect(kinds("Here's the kicker: the build was broken all along.")).toContain('false_payoff');
    expect(kinds("It's worth noting that I also led the migration.")).toContain('false_payoff');
    expect(kinds('When it comes to backend work, I have plenty to say.')).toContain('false_payoff');
  });

  it('catches essay-template closers in a short answer', () => {
    expect(kinds('In short, I would bring focus and care to the team.')).toContain(
      'summary_closer',
    );
    expect(kinds('Firstly, I am organised. Secondly, I am fast.')).toContain('summary_closer');
  });

  it('catches the currently-fashionable vocabulary', () => {
    expect(kinds('I bring a quiet confidence to every project.')).toContain('overused_word');
    expect(kinds('The results shed light on the bottleneck.')).toContain('overused_word');
    expect(kinds('This paved the way for the new architecture.')).toContain('overused_word');
    expect(kinds('It is crucial that the pipeline stays fast.')).toContain('overused_word');
  });

  /** Higher lexical repetitiveness is one of the most consistent findings in the literature. */
  it('catches low lexical diversity', () => {
    const repetitive = Array.from(
      { length: 12 },
      (_, i) =>
        `The project team worked on the project system because the project system needed project work ${i}.`,
    ).join(' ');
    expect(kinds(repetitive)).toContain('low_lexical_diversity');
  });

  it('does not flag varied vocabulary as repetitive', () => {
    const varied =
      'I rebuilt the ingestion path last spring after it started dropping rows under load. ' +
      'The culprit turned out to be a connection pool sized for a much smaller service. ' +
      'Widening it helped, but the real fix was batching writes instead of firing one per record. ' +
      'Latency halved. On-call stopped getting paged at three in the morning, which is the ' +
      'only metric anyone actually remembered afterwards.';
    expect(kinds(varied)).not.toContain('low_lexical_diversity');
  });

  it('catches repeated sentence openers', () => {
    const same =
      'I built the ingestion service for the payments team last spring. ' +
      'I improved its throughput considerably over the following two months. ' +
      'I wrote the deployment documentation that the team still uses today. ' +
      'I trained two new engineers on the on-call rotation as well.';
    expect(kinds(same)).toContain('repeated_openers');
  });

  it('leaves good specific writing alone across every new check', () => {
    const good =
      'Last spring I rewrote how our ingestion path talks to Postgres. Every row was hitting ' +
      'the database twice, which nobody had noticed because the tables were small when it ' +
      'shipped. Batching the writes cut latency roughly in half. What stuck with me was how ' +
      'long the problem had been sitting there in plain sight.';
    expect(findTells(good)).toEqual([]);
  });
});
