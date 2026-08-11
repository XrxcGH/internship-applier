import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CandidateProfile, EducationEntry, ExperienceEntry } from '@ia/shared';
import { describe, expect, it } from 'vitest';
import { readUrlField } from '../src/lib/profileEdit';
import { savingProblems, tidyProfileLists } from '../src/pages/Onboarding';
import {
  CertificationsEditor,
  ExperienceEditor,
  LanguagesEditor,
  LinksEditor,
  ProjectsEditor,
  SkillsEditor,
} from '../src/components/ProfileEditors';

/**
 * The G1 editors for everything the reader pulls out of a resume that is not a school.
 *
 * The case that named the problem: a real resume came back as twenty-seven experience
 * entries, not one of which carried a single line printed underneath it, beside "Projects —
 * none found" and "Skills — none found". The confirm screen reported all of that as three
 * counts and a note saying entries were not editable yet, so the student could neither see
 * that the reader had dropped the description of everything they had done nor put any of it
 * back. That description is the evidence corpus every generated sentence is checked against,
 * and gate G3 refuses a sentence it cannot trace to a fact, with no override.
 *
 * G1 is the gate where an extraction error gets corrected. Anything the wizard cannot edit is
 * an extraction error made permanent, which is the same argument that built the education
 * editor one section up.
 */

function profile(over: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    education: [],
    experience: [],
    projects: [],
    skills: [],
    certifications: [],
    languages: [],
    links: { other: [] },
    ...over,
  } as unknown as CandidateProfile;
}

function role(over: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    organization: 'Sample Robotics',
    title: 'Team Captain',
    type: 'club',
    bullets: ['Ran the build season'],
    ...over,
  };
}

function school(over: Partial<EducationEntry> = {}): EducationEntry {
  return { institution: 'Sample High School', level: 'high_school', ...over };
}

/** Counts the amber "check this" marker the flagged controls render. */
function amberCount(html: string): number {
  return html.split('check this').length - 1;
}

function render(
  Editor: (props: never) => unknown,
  p: CandidateProfile,
  flagged: (path: string) => boolean = () => false,
): string {
  return renderToStaticMarkup(
    createElement(Editor as never, {
      profile: p,
      flagged,
      edit: () => undefined,
      editList: () => undefined,
    }),
  );
}

describe('readUrlField', () => {
  it('adds the scheme people leave off, which is what ingestion already does', () => {
    // `links` and a project's url are the profile's two z.string().url() fields, and a resume
    // writes an address the way it is read. Repairing one on the way in and not the other
    // would mean a link typed here failed the save that the same link read off a resume
    // passes.
    expect(readUrlField('github.com/rosa').url).toBe('https://github.com/rosa');
    expect(readUrlField('  linkedin.com/in/rosa  ').url).toBe('https://linkedin.com/in/rosa');
  });

  it('leaves a complete address alone', () => {
    expect(readUrlField('https://github.com/rosa').url).toBe('https://github.com/rosa');
    expect(readUrlField('http://example.com').url).toBe('http://example.com');
  });

  it('treats empty as a complete answer, because most people have no portfolio', () => {
    for (const raw of ['', '   ', null, undefined]) {
      expect(readUrlField(raw)).toEqual({ url: undefined, problem: null });
    }
  });

  it('names text that is not an address rather than storing it', () => {
    const { url, problem } = readUrlField('my github page');
    expect(url).toBeUndefined();
    expect(problem).toContain('my github page');
  });
});

describe('savingProblems', () => {
  it('names an entry whose title or organization was emptied, by the number on its card', () => {
    // Both are `.min(1)` on the schema, and the server answers a breach with "Profile did not
    // match the expected shape", naming no field at all.
    expect(
      savingProblems(
        profile({ experience: [role(), role({ title: '  ' }), role({ organization: '' })] }),
      ),
    ).toEqual(['Entry 2 has no title.', 'Entry 3 has no organization.']);
  });

  it('names a nameless project and an address that is not one', () => {
    expect(
      savingProblems(
        profile({
          projects: [
            { name: '', description: '', bullets: [] },
            { name: 'Parser', description: '', bullets: [], url: 'my repo' },
          ],
        }),
      ),
    ).toEqual(['Project 1 has no name.', 'Project 2: "my repo" is not a web address.']);
  });

  it('names a nameless skill and a link that cannot be stored', () => {
    expect(
      savingProblems(profile({ skills: [{ name: '', category: 'tool', evidence: [] }] })),
    ).toEqual(['Skill 1 has no name.']);
    expect(savingProblems(profile({ links: { other: [], github: 'not a url' } }))).toEqual([
      'Your github link: "not a url" is not a web address.',
    ]);
  });

  it('still names a school with no name, which was the whole list before the editors', () => {
    expect(savingProblems(profile({ education: [school({ institution: '' })] }))).toEqual([
      'School 1 has no name.',
    ]);
  });

  it('says nothing about a profile every control has left savable', () => {
    expect(
      savingProblems(
        profile({
          education: [school()],
          experience: [role()],
          projects: [{ name: 'Parser', description: 'A parser', bullets: [] }],
          skills: [{ name: 'Python', category: 'language', evidence: [] }],
          links: { other: [], github: 'github.com/rosa' },
        }),
      ),
    ).toEqual([]);
  });
});

describe('tidyProfileLists, beyond the school rows', () => {
  it('drops the bullets Add left empty, and trims the rest', () => {
    // A blank bullet is an evidence item whose text is the empty string: it matches nothing,
    // and it spends part of the retrieval budget that decides which real bullets drafting
    // gets to see.
    const tidied = tidyProfileLists(
      profile({ experience: [role({ bullets: ['  ', 'Ran the build season ', ''] })] }),
    );
    expect(tidied.experience[0]?.bullets).toEqual(['Ran the build season']);
  });

  it('repairs an address on the way out rather than failing the save on it', () => {
    const tidied = tidyProfileLists(
      profile({
        links: { other: [], github: 'github.com/rosa' },
        projects: [{ name: 'Parser', description: '', bullets: [], url: 'example.com/p' }],
      }),
    );
    expect(tidied.links.github).toBe('https://github.com/rosa');
    expect(tidied.projects[0]?.url).toBe('https://example.com/p');
  });

  it('keeps text that is not an address, because savingProblems is what names it', () => {
    // Silently deleting what somebody has just typed is the worse of the two failures.
    expect(tidyProfileLists(profile({ links: { other: [], github: 'my page' } })).links.github) //
      .toBe('my page');
  });

  it('turns an emptied address into absent rather than the empty string', () => {
    // '' is not a URL, so storing it would fail the very save this function exists to allow.
    expect(tidyProfileLists(profile({ links: { other: [], github: '  ' } })).links.github) //
      .toBeUndefined();
  });

  it('survives a profile carrying only some of its lists', () => {
    // This runs on whatever the wizard is holding, on the one code path between the user's
    // edits and the server, so an absent list has to be survivable rather than a throw.
    expect(() =>
      tidyProfileLists({ education: [school()] } as unknown as CandidateProfile),
    ).not.toThrow();
  });
});

describe('the experience editor on screen', () => {
  it('renders a control for every experience field, which is what G1 was missing', () => {
    const html = render(ExperienceEditor, profile({ experience: [role()] }));
    for (const label of [
      'Title',
      'Organization',
      'Kind',
      'Location',
      'Started',
      'Finished',
      'What you did',
      'Skills used here',
    ]) {
      expect(html, label).toContain(label);
    }
  });

  it('shows the lines an entry carries, so an entry with none reads as bare', () => {
    expect(render(ExperienceEditor, profile({ experience: [role()] }))).toContain(
      'Ran the build season',
    );
  });

  it('renders every entry of a long list rather than stopping at a round number', () => {
    // Twenty-seven activities is a real resume, not a pathological one. A list that quietly
    // truncates is an extraction error the user cannot see, let alone correct.
    const many = Array.from({ length: 27 }, (_, i) => role({ title: `Role ${i + 1}` }));
    const html = render(ExperienceEditor, profile({ experience: many }));
    expect(html).toContain('Role 1');
    expect(html).toContain('Role 27');
    expect(html).toContain('Entry 27');
  });

  it('marks a flagged experience field amber, the same as a flagged school field', () => {
    const html = render(
      ExperienceEditor,
      profile({ experience: [role()] }),
      (path) => path === 'experience.0.startDate',
    );
    expect(amberCount(html)).toBe(1);
  });

  it('offers a way to add an entry the reader missed entirely', () => {
    expect(render(ExperienceEditor, profile())).toContain('Add entry');
  });
});

describe('the remaining editors on screen', () => {
  it('gives a project every field the schema keeps', () => {
    const html = render(
      ProjectsEditor,
      profile({ projects: [{ name: 'Parser', description: 'A parser', bullets: ['Wrote it'] }] }),
    );
    for (const label of ['Name', 'Address', 'Description', 'What you did', 'Wrote it']) {
      expect(html, label).toContain(label);
    }
  });

  it('gives a skill its name and its kind, and a way to add one', () => {
    const html = render(
      SkillsEditor,
      profile({ skills: [{ name: 'SolidWorks', category: 'tool', evidence: [] }] }),
    );
    expect(html).toContain('SolidWorks');
    expect(html).toContain('Add skill');
  });

  it('gives a certification the date a duration claim counts from', () => {
    const html = render(
      CertificationsEditor,
      profile({ certifications: [{ name: 'CPR', issuer: 'American Red Cross', date: '2023-01' }] }),
    );
    for (const label of ['CPR', 'American Red Cross', 'Earned', 'Issued by']) {
      expect(html, label).toContain(label);
    }
  });

  it('gives a language and its proficiency', () => {
    const html = render(
      LanguagesEditor,
      profile({ languages: [{ name: 'Tagalog', proficiency: 'native' }] }),
    );
    expect(html).toContain('Tagalog');
    expect(html).toContain('native');
  });

  it('gives the three links that get typed into application forms', () => {
    const html = render(LinksEditor, profile({ links: { other: [], github: 'github.com/rosa' } }));
    for (const label of ['GitHub', 'LinkedIn', 'Portfolio', 'github.com/rosa']) {
      expect(html, label).toContain(label);
    }
  });

  it('says none found rather than nothing at all for a list the reader came back empty on', () => {
    // "Projects · none found" is the honest report of an extraction that found none AND of
    // one that dropped them all. The screen distinguishes the two with the line counts beside
    // it; what this editor must not do is render an empty space where a section should be.
    expect(render(ProjectsEditor, profile())).toContain('none found');
    expect(render(SkillsEditor, profile())).toContain('none found');
  });
});
