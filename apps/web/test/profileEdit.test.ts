import { describe, expect, it } from 'vitest';
import { remapTypedBoxes, dateProblem, indexRange, remapListFlags } from '../src/lib/profileEdit';
import { isAnswered } from '../src/lib/review';

/**
 * The three rules the G1 editors leaned on and did not have.
 *
 * Each one was found by reading the shipped editors rather than by a failing test, and each
 * one is the same shape of defect: the wizard let a user do something the rest of the system
 * had never had to cope with, and coped with it silently.
 */

describe('remapListFlags', () => {
  /**
   * Review flags are positional — `experience.3.startDate` — and nothing could move an entry
   * until the editors grew Up, Down and Remove. One click then made the gate's amber markers
   * point at the wrong rows.
   */
  it('follows an entry that moved up', () => {
    // Entries [a,b,c] with c flagged, c moved to the front: the flag moves with it.
    const moved = [2, 0, 1];
    expect(remapListFlags(['experience.2.startDate'], 'experience', moved)).toEqual([
      'experience.0.startDate',
    ]);
  });

  it('shifts the flags of everything after a removal', () => {
    // Remove entry 1 from [0,1,2,3]. The flag on 3 belongs to what is now 2.
    const moved = [0, 2, 3];
    expect(
      remapListFlags(['experience.0.type', 'experience.3.endDate'], 'experience', moved),
    ).toEqual(['experience.0.type', 'experience.2.endDate']);
  });

  it('drops the flags of an entry that was removed, because it described that entry', () => {
    expect(remapListFlags(['experience.1.startDate'], 'experience', [0, 2])).toEqual([]);
  });

  it('never leaves a flag addressing a row past the end of the list', () => {
    // The worst version: remove the LAST flagged entry and the flag points nowhere. No
    // control anywhere can render it, so it cannot be cleared in place — and G1 blocks until
    // the list is empty, so the only way forward is dismissing a flag for a row that is gone.
    const remaining = remapListFlags(
      ['experience.0.startDate', 'experience.2.startDate'],
      'experience',
      indexRange(3).filter((i) => i !== 2),
    );
    for (const flag of remaining) {
      expect(Number(/\.(\d+)\./.exec(flag)?.[1])).toBeLessThan(2);
    }
  });

  it('leaves every other list, and every flag that is not positional, alone', () => {
    const flags = ['dateOfBirth', 'education.1.gpa', 'skills', 'experience.1.type'];
    expect(remapListFlags(flags, 'experience', [1, 0])).toEqual([
      'dateOfBirth',
      'education.1.gpa',
      'skills',
      'experience.0.type',
    ]);
  });

  it('does not confuse one list with another whose name starts the same way', () => {
    expect(remapListFlags(['experienceExtra.0.x'], 'experience', [])).toEqual([
      'experienceExtra.0.x',
    ]);
  });

  it('never lists the same flag twice', () => {
    // G1 blocks until `needsReview` is empty and each flag is cleared one at a time, so a
    // duplicate is a click the user has to spend twice on one fact.
    const twice = ['experience.1.type', 'experience.1.type'];
    expect(remapListFlags(twice, 'experience', [1, 0])).toEqual(['experience.0.type']);
  });
});

describe('dateProblem', () => {
  /**
   * Every date box in the wizard is `<input type="month">`, which guarantees YYYY-MM in
   * Chrome. Firefox and desktop Safari do not implement it: the control degrades to a plain
   * text box, "June 2025" is stored verbatim, and the save comes back as "Profile did not
   * match the expected shape" naming no field — on a screen that can hold twenty-seven
   * entries with two date boxes each.
   */
  it('accepts the one shape the profile stores', () => {
    for (const ok of ['2027-06', '1999-01', '2030-12']) {
      expect(dateProblem(ok), ok).toBeNull();
    }
  });

  it('treats empty as a complete answer, because an absent date means ongoing', () => {
    for (const blank of ['', '   ', null, undefined]) {
      expect(dateProblem(blank)).toBeNull();
    }
  });

  it('names what a text box in Firefox actually receives', () => {
    for (const bad of ['June 2025', '2025-6', '06/2025', '2025', '2025-13', '2025-00']) {
      expect(dateProblem(bad), bad).toContain(bad.trim());
    }
  });
});

describe('isAnswered, on a list', () => {
  it('does not count an empty list as an answer', () => {
    // Every non-string counted as answered, so the `skills` corpus flag — raised when an
    // extraction came back with no skills at all — cleared on ANY touch of the skills
    // editor. Add a skill, remove it again: net change nothing, flag gone, Confirm unlocked.
    expect(isAnswered([])).toBe(false);
    expect(isAnswered([{ name: 'Python' }])).toBe(true);
  });

  it('still reads the scalar cases the six required facts depend on', () => {
    expect(isAnswered('')).toBe(false);
    expect(isAnswered('unknown')).toBe(false);
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered('citizen')).toBe(true);
    expect(isAnswered(0)).toBe(true);
  });
});

/**
 * The half-typed GPA text, which is what the student SEES.
 *
 * `typed` is keyed by position and `gpaBoxesFor` gives it precedence over the stored number,
 * so removing a school left a figure typed for row 1 sitting on row 2 — over whatever GPA
 * that school really had — and nothing warned, because from the editor's side the text was
 * simply still there. `needsReview` was already remapped on that path; this was not.
 */
describe('remapTypedBoxes', () => {
  const boxes = {
    'education.0.gpa.value': '3.9',
    'education.1.gpa.value': '3.5',
    'education.2.gpa.value': '4.0',
    'experience.0.title': 'kept',
  };

  it('moves each row’s text to where that row went', () => {
    // Removing the middle school: new 0 holds old 0, new 1 holds old 2.
    expect(remapTypedBoxes(boxes, 'education', [0, 2])).toEqual({
      'education.0.gpa.value': '3.9',
      'education.1.gpa.value': '4.0',
      'experience.0.title': 'kept',
    });
  });

  it('drops the text belonging to a row that is gone', () => {
    // The removed row's index is absent from the permutation, which is what says "gone"
    // rather than "moved" — the same signal remapListFlags reads.
    const after = remapTypedBoxes(boxes, 'education', [0, 2]);
    expect(Object.values(after)).not.toContain('3.5');
  });

  it('swaps two rows’ text with them', () => {
    expect(remapTypedBoxes(boxes, 'education', [1, 0, 2])).toMatchObject({
      'education.0.gpa.value': '3.5',
      'education.1.gpa.value': '3.9',
      'education.2.gpa.value': '4.0',
    });
  });

  it('leaves another list’s keys alone', () => {
    expect(remapTypedBoxes(boxes, 'education', [0, 1, 2])['experience.0.title']).toBe('kept');
  });

  it('agrees with remapListFlags, which walks the same permutation', () => {
    // The two run on one list change and would corrupt each other if they disagreed about
    // what the permutation means.
    const moved = [0, 2];
    expect(remapListFlags(['education.2.gpa'], 'education', moved)).toEqual(['education.1.gpa']);
    expect(remapTypedBoxes({ 'education.2.gpa.value': 'x' }, 'education', moved)).toEqual({
      'education.1.gpa.value': 'x',
    });
  });
});
