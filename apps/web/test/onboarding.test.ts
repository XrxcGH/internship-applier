import { OPTIONAL_WIZARD_FIELDS, isDismissible } from '../src/lib/review';
import { readFileSync } from 'node:fs';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CandidateProfile, EducationEntry } from '@ia/shared';
import { describe, expect, it } from 'vitest';
import type * as api from '../src/lib/api';
import {
  blankInstitutions,
  EducationEditor,
  gpaBoxesFor,
  gpaBoxKey,
  mergeWithdrawn,
  nextReviewFlags,
  readGpaBoxes,
  tidyProfileLists,
  WithdrawnNotice,
} from '../src/pages/Onboarding';
// Moved out of the wizard when the experience, project and skill editors arrived and needed
// it too — a component file importing from a page is the wrong direction. The editors those
// helpers serve are covered in profileEditors.test.ts.
import { moveListItem } from '../src/lib/profileEdit';

/**
 * G1 is the gate where an extraction error gets corrected, so anything the wizard cannot
 * edit is an extraction error made permanent. These cover the education editor, which did
 * not exist: the confirm screen showed "Education: 2" and a note saying entries were not
 * editable, and every flag the extractor raised inside an education entry had one way off
 * the list, the button that deletes the flag and leaves the fact missing for good.
 *
 * The case that named the problem: a transcript printing only "4.32 weighted GPA". The
 * profile shape keeps a value and a scale, so the figure was dropped, `education.0.gpa` was
 * raised for the user to fix, and there was nowhere to fix it. A true sentence about that
 * GPA then came back `unsupported` at G3, which blocks with no override.
 */

function school(over: Partial<EducationEntry> = {}): EducationEntry {
  return {
    institution: 'Sample High School',
    level: 'high_school',
    endDate: '2026-06',
    coursework: ['AP Biology', 'AP Statistics'],
    honors: ['National Honor Society'],
    ...over,
  };
}

function profileWith(education: EducationEntry[]): CandidateProfile {
  return { education } as unknown as CandidateProfile;
}

function render(props: {
  entries: EducationEntry[];
  flagged?: (path: string) => boolean;
  typed?: Record<string, string>;
}): string {
  return renderToStaticMarkup(
    createElement(EducationEditor, {
      entries: props.entries,
      flagged: props.flagged ?? (() => false),
      typed: props.typed ?? {},
      onEntry: () => undefined,
      onTyped: () => undefined,
      // Add / move / remove are exercised by their own cases below; these renders are about
      // what a single row draws.
      onList: () => undefined,
    }),
  );
}

/** Counts the amber "check this" marker the flagged controls render. */
function amberCount(html: string): number {
  return html.split('check this').length - 1;
}

describe('readGpaBoxes', () => {
  it('keeps the unweighted figure with its scale, and the weighted one beside them', () => {
    expect(readGpaBoxes({ value: '3.968', scale: '4', weighted: '4.32' })).toEqual({
      gpa: { value: 3.968, scale: 4, weighted: 4.32 },
      note: null,
    });
  });

  it('keeps three decimals, because transcripts print three', () => {
    // Rounding 3.968 to 3.97 puts a figure on the profile that the student never had, and
    // then contradicts their own true sentence with it at G3.
    expect(readGpaBoxes({ value: '3.968', scale: '4.000', weighted: '' }).gpa).toEqual({
      value: 3.968,
      scale: 4,
    });
  });

  it('accepts a weighted figure above the scale, which is the ordinary high-school shape', () => {
    expect(readGpaBoxes({ value: '3.968', scale: '4', weighted: '4.321' }).gpa).toEqual({
      value: 3.968,
      scale: 4,
      weighted: 4.321,
    });
  });

  it('never copies the weighted figure into the unweighted slot to complete the pair', () => {
    // The reported case, and the false-green half of it. Filling the missing half from the
    // weighted number would store an unweighted GPA the student never earned and hand a
    // fabricated sentence about it a green tick at the gate built to catch one.
    const read = readGpaBoxes({ value: '', scale: '4', weighted: '4.32' });
    expect(read.gpa).toBeUndefined();
    expect(read.note).toContain('unweighted number');
  });

  it('says out loud that a weighted-only figure is not stored yet', () => {
    const read = readGpaBoxes({ value: '', scale: '', weighted: '4.32' });
    expect(read.gpa).toBeUndefined();
    expect(read.note).toBeTruthy();
  });

  it('says the same for an unweighted figure with no scale, which is the mirror case', () => {
    const read = readGpaBoxes({ value: '3.9', scale: '', weighted: '' });
    expect(read.gpa).toBeUndefined();
    expect(read.note).toBeTruthy();
  });

  it('leaves a student with no GPA alone', () => {
    // Three empty boxes are a complete answer for someone whose school does not publish
    // one. Nagging here would put a note on every education entry in the app.
    expect(readGpaBoxes({ value: '', scale: '', weighted: '' })).toEqual({
      gpa: undefined,
      note: null,
    });
  });

  it('treats a blank box as absent rather than as zero', () => {
    // Number('') is 0, and a zero on the profile is a number FactGuard will contradict a
    // true sentence with.
    expect(readGpaBoxes({ value: '', scale: '4', weighted: '' }).gpa).toBeUndefined();
    expect(readGpaBoxes({ value: '   ', scale: '   ', weighted: '' }).gpa).toBeUndefined();
  });

  it('stores a real zero, which is not the same thing', () => {
    expect(readGpaBoxes({ value: '0', scale: '4', weighted: '' }).gpa).toEqual({
      value: 0,
      scale: 4,
    });
  });

  it('names the box that does not hold a number, and stores nothing from the row', () => {
    const read = readGpaBoxes({ value: 'four point one', scale: '4', weighted: '' });
    expect(read.gpa).toBeUndefined();
    expect(read.note).toContain('Unweighted GPA');
    expect(read.note).toContain('four point one');
  });

  it('refuses a negative figure and an infinity', () => {
    expect(readGpaBoxes({ value: '-3.9', scale: '4', weighted: '' }).gpa).toBeUndefined();
    expect(readGpaBoxes({ value: '3.9', scale: '4', weighted: 'Infinity' }).gpa).toBeUndefined();
  });

  it('refuses a scale of zero, which is a denominator that cannot exist', () => {
    // A GPA of 0 is a fact and is stored above; a GPA out of 0 is not. The one "any number at
    // or above zero" predicate reads all three boxes, and a 0 in the scale box reached the
    // profile, where the evidence line quoted "GPA 3.9/0" back to the student at G3 as the
    // proof that their own sentence was real.
    const read = readGpaBoxes({ value: '3.9', scale: '0', weighted: '' });
    expect(read.gpa).toBeUndefined();
    expect(read.note).toContain('Scale');
    expect(read.note).toContain('out of');
    expect(readGpaBoxes({ value: '3.9', scale: '0.0', weighted: '4.2' }).gpa).toBeUndefined();
  });

  it('still names the scale box rather than going quiet about it', () => {
    // The note is the whole affordance here: nothing else on the screen says why the row
    // stopped storing.
    expect(readGpaBoxes({ value: '3.9', scale: '0', weighted: '' }).note).toBeTruthy();
  });
});

/**
 * The keystroke that takes a GPA the profile already held back off it.
 *
 * Everything below drives the shipped row handler, because the rule is a decision the handler
 * makes per edit and not a property of `readGpaBoxes`. A correct 3.9/4 was deleted by one
 * "4.0 scale" typed into the scale box: nothing was flagged, so `remaining` stayed 0 and
 * Confirm was live, the server takes a profile with no GPA happily, and the student's own true
 * sentence about that GPA then came back `unsupported` at G3, where there is no override.
 */
describe('the row handler when a stored GPA goes', () => {
  type Node = { type: unknown; props: Record<string, unknown> };

  function walk(node: unknown, out: Node[]): void {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, out);
      return;
    }
    if (!isValidElement(node)) return;
    const el = node as { type: unknown; props: Record<string, unknown> };
    out.push({ type: el.type, props: el.props });
    // Every component in this editor is hook-free, so calling it by hand yields the same
    // elements with the same handlers the browser would get.
    if (typeof el.type === 'function') {
      walk((el.type as (p: unknown) => unknown)(el.props), out);
      return;
    }
    walk((el.props as { children?: unknown }).children, out);
  }

  interface Edit {
    next: EducationEntry;
    clears?: string;
    options?: { raise?: boolean };
  }

  /** Types into one labelled box of a one-school editor and returns what the row asked for. */
  function typeInto(
    entry: EducationEntry,
    label: string,
    text: string,
    typed: Record<string, string> = {},
  ): Edit {
    let edit: Edit | null = null;
    const out: Node[] = [];
    walk(
      createElement(EducationEditor, {
        entries: [entry],
        flagged: () => false,
        typed,
        onList: () => undefined,
        onEntry: (_i, next, clears, options) => {
          edit = { next, clears, options };
        },
        onTyped: () => undefined,
      }),
      out,
    );
    const box = out.find((n) => typeof n.type === 'function' && n.props.label === label);
    if (!box) throw new Error(`no control labelled ${label}`);
    (box.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: text } });
    if (!edit) throw new Error('the row asked for no edit');
    return edit;
  }

  const held = school({ gpa: { value: 3.9, scale: 4 } });

  it('raises the flag again on the keystroke that empties a GPA the row held', () => {
    for (const [label, text] of [
      ['Scale', '4.0 scale'],
      ['Weighted GPA', '4.32 weighted'],
      ['Unweighted GPA', 'three point nine'],
      ['Scale', '0'],
      ['Scale', ''],
    ] as const) {
      const edit = typeInto(held, label, text);
      expect(edit.next.gpa, `${label} = ${text}`).toBeUndefined();
      expect(edit.options?.raise, `${label} = ${text}`).toBe(true);
      // Which is what holds Confirm: the gate blocks while `needsReview` is not empty.
      expect(nextReviewFlags([], 'education.0.gpa', edit.next.gpa, edit.options)).toEqual([
        'education.0.gpa',
      ]);
    }
  });

  it('raises nothing on a row that never held a GPA, which is the other failure direction', () => {
    // The blanket `raise: false` exists for this student: their school publishes no GPA, and a
    // flag invented here is work at a gate that blocks on its list being empty, with no fact
    // behind it to clear it.
    const none = school({ gpa: undefined });
    for (const [label, text] of [
      ['Weighted GPA', '4.32 weighted'],
      ['Unweighted GPA', 'none'],
      ['Unweighted GPA', ''],
      ['Scale', '0'],
      ['Scale', '4'],
    ] as const) {
      const edit = typeInto(none, label, text);
      expect(edit.options?.raise, `${label} = ${text}`).toBe(false);
      expect(nextReviewFlags([], 'education.0.gpa', edit.next.gpa, edit.options)).toEqual([]);
    }
  });

  it('raises nothing while the row still holds a GPA', () => {
    const edit = typeInto(held, 'Unweighted GPA', '3.8');
    expect(edit.next.gpa).toEqual({ value: 3.8, scale: 4 });
    expect(edit.options?.raise).toBe(false);
  });

  it('clears the flag again the moment a real number is back behind it', () => {
    // Raising has to be reversible by typing, or it would be the same dead end the button
    // that deletes a flag was.
    const emptied = school({ gpa: undefined });
    const typed = { [gpaBoxKey(0, 'value')]: '3.9', [gpaBoxKey(0, 'scale')]: 'four' };
    const edit = typeInto(emptied, 'Scale', '4', typed);
    expect(edit.next.gpa).toEqual({ value: 3.9, scale: 4 });
    expect(
      nextReviewFlags(['education.0.gpa'], 'education.0.gpa', edit.next.gpa, edit.options),
    ).toEqual([]);
  });

  it('keeps what the student typed on screen while the row stores nothing', () => {
    // The figure comes off the profile, but the characters stay in the box: a box that
    // emptied itself under the person mid-keystroke is the thing this editor exists to stop.
    const html = render({
      entries: [school({ gpa: undefined })],
      typed: { [gpaBoxKey(0, 'scale')]: '4.0 scale' },
    });
    expect(html).toContain('4.0 scale');
    expect(html).toContain('has come off your profile');
  });
});

describe('gpaBoxesFor', () => {
  it('shows what the profile holds until the user has typed', () => {
    const entry = school({ gpa: { value: 3.968, scale: 4, weighted: 4.32 } });
    expect(gpaBoxesFor(entry, 0, {})).toEqual({ value: '3.968', scale: '4', weighted: '4.32' });
  });

  it('shows nothing for a school whose GPA was dropped during ingestion', () => {
    expect(gpaBoxesFor(school(), 0, {})).toEqual({ value: '', scale: '', weighted: '' });
  });

  it('lets a half-typed decimal stand, since the profile cannot hold one', () => {
    // A box bound to the parsed number cannot be typed into: "3." parses to 3, the box
    // re-renders as "3", and the decimal point is gone before the next digit lands.
    const entry = school({ gpa: { value: 3, scale: 4 } });
    const typed = { [gpaBoxKey(0, 'value')]: '3.' };
    expect(gpaBoxesFor(entry, 0, typed).value).toBe('3.');
  });

  it('keeps a typed blank blank rather than falling back to the stored number', () => {
    const entry = school({ gpa: { value: 3.9, scale: 4 } });
    expect(gpaBoxesFor(entry, 0, { [gpaBoxKey(0, 'value')]: '' }).value).toBe('');
  });

  it('does not let one row read another row', () => {
    const entry = school({ gpa: { value: 3.9, scale: 4 } });
    expect(gpaBoxesFor(entry, 1, { [gpaBoxKey(0, 'value')]: '2.2' }).value).toBe('3.9');
  });

  it('keeps the scale on screen while the unweighted figure is half typed', () => {
    // The row handler records all three boxes on every keystroke. Without that, typing "3."
    // stores no GPA at all, `entry.gpa` goes undefined, and the scale box falls back to it
    // and empties itself under the user mid-keystroke.
    const entry = school({ gpa: undefined });
    const typed = {
      [gpaBoxKey(0, 'value')]: '3.',
      [gpaBoxKey(0, 'scale')]: '4',
      [gpaBoxKey(0, 'weighted')]: '4.32',
    };
    expect(gpaBoxesFor(entry, 0, typed)).toEqual({ value: '3.', scale: '4', weighted: '4.32' });
  });
});

/**
 * The clearing rule, which is the whole of what G1 promises. `patch` calls this and nothing
 * else, so these cases are the shipped rule rather than a second copy of it.
 *
 * Both directions matter here. A flag must not clear while the fact behind it is still
 * missing, and a flag must not be invented on a field the extractor was happy with.
 */
describe('nextReviewFlags', () => {
  const EDU = { raise: false } as const;

  it('will not clear a flagged GPA while the number is still gone', () => {
    // The reported case. Typing the weighted figure into a box, on its own, stores nothing,
    // so the flag has to survive the keystroke.
    const weightedOnly = readGpaBoxes({ value: '', scale: '', weighted: '4.32' }).gpa;
    expect(nextReviewFlags(['education.0.gpa'], 'education.0.gpa', weightedOnly, EDU)).toEqual([
      'education.0.gpa',
    ]);
    const withScale = readGpaBoxes({ value: '', scale: '4', weighted: '4.32' }).gpa;
    expect(nextReviewFlags(['education.0.gpa'], 'education.0.gpa', withScale, EDU)).toEqual([
      'education.0.gpa',
    ]);
  });

  it('clears it the moment a real GPA is behind it', () => {
    const { gpa } = readGpaBoxes({ value: '3.968', scale: '4', weighted: '4.32' });
    expect(
      nextReviewFlags(['dateOfBirth', 'education.0.gpa'], 'education.0.gpa', gpa, EDU),
    ).toEqual(['dateOfBirth']);
  });

  it('will not clear a flagged school name that has been emptied', () => {
    expect(
      nextReviewFlags(['education.0.institution'], 'education.0.institution', '', EDU),
    ).toEqual(['education.0.institution']);
  });

  it('clears a flagged level on any choice, including the one that raised it', () => {
    // 'other' is the honest answer for a homeschool co-op or a dual-enrollment academy, and
    // confirming it IS the correction the flag was asking for.
    expect(nextReviewFlags(['education.0.level'], 'education.0.level', 'other', EDU)).toEqual([]);
  });

  it('clears a flagged date once one is typed, and holds it while it is blank', () => {
    // These are raised only for a date the resume stated and the schema could not take, so a
    // blank is not an answer to them either. The "I have checked this" button is still the
    // way out for a student who has no date to give.
    for (const field of ['startDate', 'endDate']) {
      const path = `education.0.${field}`;
      expect(nextReviewFlags([path], path, '2026-06', EDU)).toEqual([]);
      expect(nextReviewFlags([path], path, undefined, EDU)).toEqual([path]);
    }
  });

  it('invents no flag on an education field nobody flagged', () => {
    // Clearing a graduation date a student never had, or half-typing a GPA and thinking
    // better of it, must not add work to a gate that blocks on its list being empty.
    for (const field of ['gpa', 'startDate', 'endDate', 'fieldOfStudy', 'coursework', 'honors']) {
      for (const index of [0, 7, 26]) {
        expect(
          nextReviewFlags(['dateOfBirth'], `education.${index}.${field}`, undefined, EDU),
        ).toEqual(['dateOfBirth']);
      }
    }
  });

  it('still raises the six facts G1 exists to collect, which is the opposite direction', () => {
    // Without `raise`, someone could type a date of birth, delete it, watch the flag go, and
    // confirm a profile with no date of birth in it. The education option must not reach these.
    expect(nextReviewFlags([], 'dateOfBirth', null)).toEqual(['dateOfBirth']);
    expect(nextReviewFlags([], 'workAuthorization.status', 'unknown')).toEqual([
      'workAuthorization.status',
    ]);
    expect(nextReviewFlags([], 'locationPrefs.base.city', '  ')).toEqual([
      'locationPrefs.base.city',
    ]);
    expect(nextReviewFlags(['dateOfBirth'], 'dateOfBirth', '2008-03-04')).toEqual([]);
  });

  it('leaves an optional wizard field alone whatever it holds', () => {
    expect(nextReviewFlags(['pronouns'], 'pronouns', '')).toEqual([]);
  });

  it('never lists the same flag twice', () => {
    expect(nextReviewFlags(['dateOfBirth'], 'dateOfBirth', null)).toEqual(['dateOfBirth']);
  });
});

describe('moveListItem', () => {
  it('moves an item up and down', () => {
    expect(moveListItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveListItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });

  it('leaves the list alone at the edges and out of range', () => {
    // "Move up" on the first row would otherwise splice undefined into a student's honors.
    expect(moveListItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveListItem(['a', 'b'], 1, 2)).toEqual(['a', 'b']);
    expect(moveListItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    expect(moveListItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    expect(moveListItem([], 0, 0)).toEqual([]);
  });

  it('does not mutate what it was given', () => {
    const items = ['a', 'b', 'c'];
    moveListItem(items, 0, 2);
    expect(items).toEqual(['a', 'b', 'c']);
  });

  it('walks an item the whole length of a long list', () => {
    const many = Array.from({ length: 26 }, (_, i) => `Honor ${i + 1}`);
    let moved = many;
    for (let i = 25; i > 0; i--) moved = moveListItem(moved, i, i - 1);
    expect(moved[0]).toBe('Honor 26');
    expect(moved).toHaveLength(26);
  });
});

describe('tidyProfileLists', () => {
  it('drops the rows Add left empty and trims the rest', () => {
    // The education evidence line joins these with commas, so abandoned rows put ", , ,"
    // into the text FactGuard quotes back as proof that an award is real.
    const tidied = tidyProfileLists(
      profileWith([school({ honors: ['  ', 'National Honor Society  ', ''] })]),
    );
    expect(tidied.education[0]?.honors).toEqual(['National Honor Society']);
  });

  it('leaves a list the extractor never produced absent rather than empty', () => {
    const tidied = tidyProfileLists(profileWith([school({ coursework: undefined })]));
    expect(tidied.education[0]?.coursework).toBeUndefined();
  });

  it('keeps every one of a long honors list', () => {
    const many = Array.from({ length: 26 }, (_, i) => `Honor ${i + 1}`);
    expect(tidyProfileLists(profileWith([school({ honors: many })])).education[0]?.honors).toEqual(
      many,
    );
  });

  it('leaves the rest of the entry untouched', () => {
    const entry = school({ gpa: { value: 3.968, scale: 4, weighted: 4.32 } });
    const tidied = tidyProfileLists(profileWith([entry]));
    expect(tidied.education[0]?.gpa).toEqual({ value: 3.968, scale: 4, weighted: 4.32 });
    expect(tidied.education[0]?.endDate).toBe('2026-06');
  });
});

describe('blankInstitutions', () => {
  it('names every row whose school name was emptied', () => {
    // The schema insists on a school name, and the server answers a missing one with a shape
    // error that names no row at all.
    const rows = blankInstitutions(
      profileWith([school(), school({ institution: '  ' }), school({ institution: '' })]),
    );
    expect(rows).toEqual([1, 2]);
  });

  it('says nothing about a profile whose rows all have names', () => {
    expect(blankInstitutions(profileWith([school(), school()]))).toEqual([]);
    expect(blankInstitutions(profileWith([]))).toEqual([]);
  });
});

describe('the education editor on screen', () => {
  it('renders a control for every education field, which is what G1 was missing', () => {
    const html = render({ entries: [school()] });
    for (const label of [
      'School',
      'Level',
      'Field of study',
      'Started',
      'Finishes',
      'Unweighted GPA',
      'Scale',
      'Weighted GPA',
      'Coursework',
      'Honors',
    ]) {
      expect(html).toContain(label);
    }
  });

  it('shows what the entry already holds', () => {
    const html = render({
      entries: [
        school({ fieldOfStudy: 'Biology', gpa: { value: 3.968, scale: 4, weighted: 4.32 } }),
      ],
    });
    expect(html).toContain('Sample High School');
    expect(html).toContain('Biology');
    expect(html).toContain('3.968');
    expect(html).toContain('4.32');
    expect(html).toContain('AP Statistics');
    expect(html).toContain('National Honor Society');
  });

  it('carries the amber onto all three GPA boxes when the GPA is flagged', () => {
    // The extractor raises one flag for the whole GPA, because a weighted-only transcript is
    // missing the unweighted number AND the scale. Marking one box would say the other two
    // were fine.
    const html = render({ entries: [school()], flagged: (p) => p === 'education.0.gpa' });
    expect(amberCount(html)).toBe(3);
  });

  it('carries the amber onto the other education flags the extractor raises', () => {
    for (const field of ['level', 'startDate', 'endDate']) {
      const html = render({ entries: [school()], flagged: (p) => p === `education.0.${field}` });
      expect(amberCount(html)).toBe(1);
    }
  });

  it('flags the right entry when several schools are on the profile', () => {
    const html = render({
      entries: [school({ institution: 'First' }), school({ institution: 'Second' })],
      flagged: (p) => p === 'education.1.gpa',
    });
    expect(amberCount(html)).toBe(3);
  });

  it('shows no amber at all when nothing is flagged', () => {
    expect(amberCount(render({ entries: [school(), school()] }))).toBe(0);
  });

  it('says on screen that a weighted-only figure is not stored yet', () => {
    const html = render({
      entries: [school()],
      typed: { [gpaBoxKey(0, 'weighted')]: '4.32' },
    });
    expect(html).toContain('unweighted number');
  });

  it('renders all twenty-six honors, and gives every one its own controls', () => {
    // A rising freshman applies on a resume that is mostly awards. A list that quietly
    // stopped at some round number would be an extraction error nobody could see.
    const many = Array.from({ length: 26 }, (_, i) => `Honor ${i + 1}`);
    const html = render({ entries: [school({ honors: many })] });
    for (const honor of many) expect(html).toContain(honor);
    expect(html).toContain('aria-label="Honor 26"');
    expect(html).toContain('aria-label="Move honor 26 up"');
    expect(html).toContain('aria-label="Remove honor 26"');
    expect(html).toContain('aria-label="Move honor 1 down"');
  });

  it('offers an add control for both lists even when they are empty', () => {
    const html = render({ entries: [school({ coursework: [], honors: [] })] });
    expect(html).toContain('Add course');
    expect(html).toContain('Add honor');
  });

  it('offers a correction when the reader found no school at all', () => {
    // The only action here used to be uploading a different file, which is not a correction:
    // a resume whose education section was misread had no way to be fixed by hand.
    const html = render({ entries: [] });
    expect(html).toContain('none found');
    expect(html).toContain('Add one here');
    expect(html).toContain('Add a school');
  });

  it('lets a school be removed and reordered, like every other list on this screen', () => {
    // ProfileEditors states the rule this broke: anything the wizard cannot edit is an
    // extraction error made permanent. The blocking notice even tells the user to "remove the
    // row outright", which was impossible for a school.
    const html = render({ entries: [school(), school({ institution: 'Second' })] });
    expect(html).toContain('Remove school 1');
    expect(html).toContain('Move school 1 down');
    expect(html).toContain('Move school 2 up');
  });
});

/**
 * Every button that sends this profile to the server, held while a school row has no name.
 *
 * A name the schema insists on, deleted by hand, makes the server answer "Profile did not
 * match the expected shape" naming no row at all, which is the wall the caution notice was
 * written to replace. Save, Continue and Confirm were held and "I have checked this" was not
 * — and that button is rendered only while a flag is still open, which is precisely the state
 * the hold is for. It is asserted against the source because the condition lives on four
 * separate buttons inside a hook-driven screen, and the failure being guarded is a fifth save
 * path being added without it.
 */
describe('the save buttons', () => {
  it('holds every path that writes the profile while a school row has no name', () => {
    const src = readFileSync(new URL('../src/pages/Onboarding.tsx', import.meta.url), 'utf8');
    const found = new Map<string, string>();
    // A fixed window rather than a match up to the closing angle bracket: the hold itself
    // contains "> 0", so a lazy match ends inside the condition and never reaches the onClick.
    for (const m of src.matchAll(/<Button/g)) {
      const el = src.slice(m.index, m.index + 260);
      const call = /persist\(\)|checkedOff\(|confirm\(\)/.exec(el)?.[0];
      if (!call) continue;
      found.set(`${call}@${String(m.index)}`, /disabled=\{([^}]*)\}/.exec(el)?.[1] ?? '(nothing)');
    }
    const calls = [...found.keys()].map((k) => k.split('@')[0]!);
    // Four persist() callers: Save and "Save and continue" on the confirm step, and Save
    // and "Save and go back" on the facts step — which had no way to save at all until the
    // six facts typed there were found to live only in React state.
    expect(calls.filter((c) => c === 'persist()')).toHaveLength(4);
    expect([...new Set(calls)].sort()).toEqual(['checkedOff(', 'confirm()', 'persist()']);
    for (const [call, hold] of found) expect(hold, call).toContain('nameless.length > 0');
  });
});

/**
 * What a save cost at G3, said on the screen that cost it.
 *
 * The server re-checks every approved answer against the profile a write just stored and takes
 * the approval off the ones it no longer supports. The client threw that list away, so
 * correcting a school name here silently un-approved an answer and said nothing: the student
 * went on believing a sentence was approved that the app had un-approved, and the first news of
 * it was the fill refusing at G4, three screens from the reason.
 */
describe('mergeWithdrawn', () => {
  const w = (answerId: string, question: string): api.WithdrawnApproval => ({
    answerId,
    applicationId: 'app1',
    question,
    claims: [{ claim: 'I designed the intake mechanism in Onshape.', reason: 'not on file' }],
  });

  it('counts an answer both writes report only once', () => {
    // "I have checked this" saves and then clears a flag, and each write answers with its own
    // sweep. An answer loses its approval once, so "2 answers" when one did is the app being
    // wrong about the thing it is apologising for.
    expect(mergeWithdrawn([w('a', 'Why us?')], [w('a', 'Why us?')])).toHaveLength(1);
  });

  it('keeps an answer only the second write took', () => {
    const merged = mergeWithdrawn([w('a', 'Why us?')], [w('a', 'Why us?'), w('b', 'A project?')]);
    expect(merged.map((x) => x.answerId)).toEqual(['a', 'b']);
  });

  it('is empty when neither write cost anything', () => {
    expect(mergeWithdrawn([], [])).toEqual([]);
  });
});

describe('WithdrawnNotice', () => {
  const item: api.WithdrawnApproval = {
    answerId: 'a1',
    applicationId: 'app1',
    question: 'Why do you want this internship?',
    claims: [
      {
        claim: 'I designed the intake mechanism in Onshape.',
        reason: '"Onshape" does not appear anywhere on your profile.',
      },
    ],
  };

  const text = (items: api.WithdrawnApproval[]): string =>
    renderToStaticMarkup(createElement(WithdrawnNotice, { items }))
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

  it('says nothing when a save cost nothing', () => {
    expect(text([])).toBe('');
  });

  it('names the count, the question, and the claim that lost it', () => {
    const said = text([item]);
    expect(said).toContain('one answer');
    expect(said).toContain('Why do you want this internship?');
    expect(said).toContain('I designed the intake mechanism in Onshape.');
    expect(said).toContain('does not appear anywhere on your profile');
    // The student has to know both that it is not approved any more and that nothing left
    // the machine because of it.
    expect(said).toContain('G3');
    expect(said).toContain('Nothing was sent anywhere');
  });

  it('counts more than one, and lists every question', () => {
    const said = text([item, { ...item, answerId: 'a2', question: 'Tell us about a project.' }]);
    expect(said).toContain('2 answers');
    expect(said).toContain('Tell us about a project.');
  });

  it('prints every claim on an answer that lost several', () => {
    const said = text([
      {
        ...item,
        claims: [
          ...item.claims,
          { claim: 'I led the build team.', reason: 'no matching entry on your profile.' },
        ],
      },
    ]);
    expect(said).toContain('I led the build team.');
  });
});

/**
 * A field whose blank is a real answer must not be able to lock the gate.
 *
 * Clearing the phone box raised a `phone` flag by `nextReviewFlags`'s default, the flag was
 * not dismissible because `phone` sat in ANSWERED_IN_WIZARD, and the server refuses to
 * confirm a profile while any flag stands — so the only way out of G1 was to type a number
 * the user had deliberately declined to give. The shared schema says `phone` is optional;
 * this is that fact, held on the client side that has to honour it.
 */
describe('optional wizard fields', () => {
  it('does not re-raise a flag when an optional field is emptied', () => {
    for (const path of ['pronouns', 'phone']) {
      expect(OPTIONAL_WIZARD_FIELDS.has(path), path).toBe(true);
      expect(nextReviewFlags(['other'], path, ''), path).toEqual(['other']);
      expect(nextReviewFlags([path, 'other'], path, ''), path).toEqual(['other']);
    }
  });

  it('offers a way to clear the flag rather than a dead instruction', () => {
    // `isDismissible` is what decides between an "I have checked this" button and a sentence
    // pointing at a control. An optional field must get the button, or its flag is permanent.
    for (const path of ['pronouns', 'phone']) {
      expect(isDismissible(path), path).toBe(true);
    }
  });

  it('still holds the facts a resume genuinely cannot contain', () => {
    // The other direction: these are not optional, and emptying one must re-raise.
    for (const path of ['dateOfBirth', 'workAuthorization.status', 'locationPrefs.base.city']) {
      expect(OPTIONAL_WIZARD_FIELDS.has(path), path).toBe(false);
      expect(nextReviewFlags([], path, ''), path).toEqual([path]);
    }
  });
});
