import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROLE_FAMILIES } from '@ia/shared';
import { PreferencesEditor } from '../src/components/ProfileEditors';

/**
 * The block of the profile that had no interface at all, and the sentence it turns on.
 *
 * `preferences` was invisible and uneditable while `industries` fed the score and role
 * families were INFERRED from the resume with no way to remove one — so a student whose
 * resume mentions a single coding class got software-engineering queries for as long as they
 * owned the profile, and the plan's own note told them to change something they could not
 * reach. Choosing here replaces the inference outright; choosing nothing still means "read it
 * off my resume", and the copy says which of the two is in force.
 *
 * Rendered by nothing until now, including that sentence.
 */
function render(over: Partial<Parameters<typeof PreferencesEditor>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(PreferencesEditor, {
      preferences: {
        roleFamilies: [],
        industries: [],
        excludeCompanies: [],
        companySizes: [],
        ...over.preferences,
      },
      inferred: over.inferred,
      onChange: () => undefined,
    }),
  );
}

describe('PreferencesEditor', () => {
  it('offers every family the planner knows, and no others', () => {
    // A family offered here that the planner does not know would store a preference that
    // silently searches for nothing. ROLE_FAMILIES is the shared list both sides are typed
    // against, which is what stops the two drifting.
    //
    // COUNTED, NOT JUST CONTAINED. This used to loop ROLE_FAMILIES asserting `toContain`,
    // which is satisfied by rendering the whole list plus anything else — the exact half of
    // the property the title claims ("and no others") went unchecked. Adding a bogus family
    // to the component left it green.
    const offered = [...render().matchAll(/aria-pressed="(?:true|false)"[^>]*>([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(new Set(offered)).toEqual(new Set(ROLE_FAMILIES));
    expect(offered).toHaveLength(ROLE_FAMILIES.length);
  });

  it('says the resume is being read when nothing has been picked', () => {
    expect(render()).toMatch(/read off your resume/i);
    expect(render()).not.toMatch(/Your resume is not consulted/i);
  });

  it('says the resume is NOT consulted once something has been picked', () => {
    // The whole point of the change: an explicit answer replaces the inference rather than
    // being added to it, and the student is told which is in force.
    const html = render({ preferences: { roleFamilies: ['journalism'] } as never });
    expect(html).toMatch(/Searches use exactly what you pick/i);
    expect(html).toMatch(/resume is not consulted/i);
  });

  it('marks the picked families pressed and the rest not', () => {
    const html = render({ preferences: { roleFamilies: ['robotics'] } as never });
    expect(html).toMatch(/aria-pressed="true"[^>]*>robotics/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>software engineering/);
  });

  it('shows what the resume currently suggests, but only while nothing is picked', () => {
    // Once a choice is made the inference is not in force, and showing it would imply it
    // still counted for something.
    expect(render({ inferred: ['robotics', 'design'] })).toMatch(/Read off your resume right now/i);
    expect(
      render({ inferred: ['robotics'], preferences: { roleFamilies: ['finance'] } as never }),
    ).not.toMatch(/Read off your resume right now/i);
  });

  it('offers a way back to the inference', () => {
    // A choice with no undo is a trap: the student cannot get back to "just read my resume".
    expect(render({ preferences: { roleFamilies: ['finance'] } as never })).toMatch(
      /go back to reading my resume/i,
    );
    expect(render()).not.toMatch(/go back to reading my resume/i);
  });

  it('renders the two list editors that feed scoring and filtering', () => {
    const html = render();
    expect(html).toMatch(/Industries you care about/i);
    expect(html).toMatch(/Companies to keep out/i);
    // Industries rank and never filter, which is the difference worth stating.
    expect(html).toMatch(/Used to rank, never to filter/i);
  });
});
