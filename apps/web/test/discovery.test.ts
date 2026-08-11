import { describe, expect, it } from 'vitest';
import {
  alreadyStored,
  boardMeaning,
  durationLabel,
  mergeTargets,
  needsBoard,
  runHeadline,
  sourceLabel,
  splitCompanies,
  targetKey,
  whenLabel,
  whyCannotRun,
  type RunSummary,
  type RunTarget,
} from '../src/lib/discovery';

/**
 * The pure helpers behind the Discover screen.
 *
 * Everything here decides something the user then spends real requests on — which boards a
 * run fetches, whether the Run button is live, and what the summary says happened — so each
 * one is decidable in a test rather than only by pressing the button and watching.
 */

function target(over: Partial<RunTarget> = {}): RunTarget {
  return { source: 'greenhouse', board: 'acme', reason: 'resolved', ...over };
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'r1',
    startedAt: '2026-08-11T10:00:00.000Z',
    finishedAt: '2026-08-11T10:00:12.000Z',
    targets: 1,
    found: 0,
    new: 0,
    duplicates: 0,
    bySource: [],
    skipped: [],
    ...over,
  };
}

describe('mergeTargets', () => {
  it('refuses a board already in the list, whatever brought it there', () => {
    // The planner knows boards a previous run resolved, and "Find their boards" resolves
    // the same company by hand. Sending greenhouse:acme twice fetches it twice, counts it
    // twice in `found`, and files the second copy under duplicates — so the report reads
    // as though the board had answered one query with another query's jobs.
    const list = mergeTargets(
      [target({ reason: 'already resolved from a previous run' })],
      [target({ reason: 'company you pinned' })],
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toBe('already resolved from a previous run');
  });

  it('tells two vendors of the same company apart', () => {
    const list = mergeTargets(
      [target({ source: 'greenhouse', board: 'acme' })],
      [target({ source: 'lever', board: 'acme' })],
    );
    expect(list.map(targetKey)).toEqual(['greenhouse:acme', 'lever:acme']);
  });

  it('keeps the order things were added in', () => {
    const list = mergeTargets(
      [target({ board: 'a' })],
      [target({ board: 'b' }), target({ board: 'a' }), target({ board: 'c' })],
    );
    expect(list.map((t) => t.board)).toEqual(['a', 'b', 'c']);
  });

  it('leaves the list it was given alone', () => {
    const before = [target({ board: 'a' })];
    mergeTargets(before, [target({ board: 'b' })]);
    expect(before).toHaveLength(1);
  });
});

describe('splitCompanies', () => {
  it('accepts commas, semicolons and one per line', () => {
    expect(splitCompanies('Figma, Stripe; Anthropic\nLinear')).toEqual([
      'Figma',
      'Stripe',
      'Anthropic',
      'Linear',
    ]);
  });

  it('drops a repeat regardless of case, keeping the spelling first written', () => {
    // The planner turns each unresolved name into three unverified board guesses, so a
    // list holding both spellings spends six of a forty-target cap on one company.
    expect(splitCompanies('Stripe, stripe, STRIPE')).toEqual(['Stripe']);
  });

  it('is empty for whitespace and stray separators', () => {
    expect(splitCompanies('')).toEqual([]);
    expect(splitCompanies('   ')).toEqual([]);
    expect(splitCompanies(',,;\n , ')).toEqual([]);
  });
});

describe('whyCannotRun', () => {
  it('will not send an empty list, which the server answers with a 400', () => {
    expect(whyCannotRun([])).toMatch(/Nothing to search/);
  });

  it('refuses a company board with no board name', () => {
    // Greenhouse, Lever and Ashby each answer an empty board with a note rather than an
    // error — "no board token supplied" — so the target costs a slot, reports zero found,
    // and looks from the outside like a company with nothing open.
    for (const source of ['greenhouse', 'lever', 'ashby']) {
      expect(needsBoard(source)).toBe(true);
      expect(whyCannotRun([target({ source, board: '' })])).toMatch(/no board name/);
      expect(whyCannotRun([target({ source, board: '   ' })])).toMatch(/no board name/);
    }
  });

  it('allows the sources that never take one', () => {
    for (const source of ['github_list', 'adzuna', 'usajobs']) {
      expect(needsBoard(source)).toBe(false);
      expect(whyCannotRun([target({ source, board: '' })])).toBeNull();
    }
  });

  it('holds the list to the ceiling the run endpoint declares', () => {
    const many = Array.from({ length: 201 }, (_, i) => target({ board: `b${String(i)}` }));
    expect(whyCannotRun(many)).toMatch(/at most 200/);
    expect(whyCannotRun(many.slice(0, 200))).toBeNull();
  });
});

describe('runHeadline', () => {
  it('accounts for every posting fetched', () => {
    // "412 fetched, 3 new" on its own reads as though 409 postings went missing. They were
    // stored by an earlier run, which is the ordinary outcome of searching a board twice.
    const s = summary({ found: 412, new: 3, duplicates: 9 });
    expect(alreadyStored(s)).toBe(400);
    expect(runHeadline(s)).toBe('412 postings fetched · 3 new · 400 already stored · 9 merged');
  });

  it('says none rather than zero when a run turned up nothing unseen', () => {
    expect(runHeadline(summary({ found: 40, new: 0 }))).toBe(
      '40 postings fetched · none new · 40 already stored',
    );
  });

  it('does not claim a posting was already stored when the arithmetic goes the other way', () => {
    // `found` counts what the adapters returned and `new` counts rows inserted; a posting
    // pasted by URL between the fetch and the insert is enough to make new exceed the gap,
    // and a negative "-1 already stored" would be a nonsense the user has to explain.
    expect(alreadyStored(summary({ found: 2, new: 3 }))).toBe(0);
    expect(runHeadline(summary({ found: 2, new: 3 }))).toBe('2 postings fetched · 3 new');
  });

  it('counts one posting in the singular', () => {
    expect(runHeadline(summary({ found: 1, new: 1 }))).toBe('1 posting fetched · 1 new');
  });

  it('says plainly when every source came back with nothing', () => {
    expect(runHeadline(summary())).toBe('No source returned a posting.');
  });
});

describe('durationLabel', () => {
  it('picks the unit that reads', () => {
    const at = (ms: number): string =>
      durationLabel(
        '2026-08-11T10:00:00.000Z',
        new Date(Date.parse('2026-08-11T10:00:00.000Z') + ms).toISOString(),
      );
    expect(at(420)).toBe('420ms');
    expect(at(12_000)).toBe('12s');
    expect(at(95_000)).toBe('1m 35s');
  });

  it('says so rather than inventing a number it cannot compute', () => {
    expect(durationLabel('whenever', '2026-08-11T10:00:00.000Z')).toBe('unknown');
    expect(durationLabel('2026-08-11T10:00:12.000Z', '2026-08-11T10:00:00.000Z')).toBe('unknown');
  });
});

describe('whenLabel', () => {
  const ago = (ms: number): string => whenLabel(new Date(Date.now() - ms).toISOString());

  it('answers in the coarsest unit that still answers the question', () => {
    expect(ago(5_000)).toBe('just now');
    expect(ago(7 * 60_000)).toBe('7m ago');
    expect(ago(3 * 3_600_000)).toBe('3h ago');
    expect(ago(30 * 3_600_000)).toBe('yesterday');
    expect(ago(5 * 86_400_000)).toBe('5d ago');
  });

  it('does not read a clock that moved as a run from the future', () => {
    expect(ago(-60_000)).toBe('just now');
  });

  it('does not print an unreadable timestamp back at the user', () => {
    expect(whenLabel('whenever')).toBe('at an unknown time');
  });
});

describe('the source table', () => {
  it('names every source the runner knows, and passes an unknown one through', () => {
    expect(sourceLabel('github_list')).toBe('Community list');
    expect(sourceLabel('usajobs')).toBe('USAJOBS');
    expect(sourceLabel('greenhouse')).toBe('Greenhouse');
    expect(sourceLabel('something_new')).toBe('something_new');
  });

  it('says what the board field means, so an empty box is never a mystery', () => {
    expect(boardMeaning('greenhouse')).toMatch(/Greenhouse board URL/);
    expect(boardMeaning('adzuna')).toMatch(/not used/);
    expect(boardMeaning('github_list')).toMatch(/upcoming season/);
  });
});
