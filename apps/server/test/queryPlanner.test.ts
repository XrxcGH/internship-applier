/**
 * Query planning, and specifically the guard the file's own header promises: that a role
 * family only enters the plan when the profile actually evidences it.
 */
import { describe, expect, it } from 'vitest';
import type { ConfirmedProfile, SearchFilters } from '@ia/shared';
import { inferRoleFamilies, planQueries } from '../src/core/discovery/queryPlanner';

function profile(over: Record<string, unknown> = {}): ConfirmedProfile {
  return {
    id: 'p1',
    fullName: 'A',
    email: 'a@b.c',
    skills: [],
    experience: [],
    projects: [],
    education: [],
    locationPrefs: {
      base: { city: 'Boston', region: 'MA', country: 'US' },
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    ...over,
  } as unknown as ConfirmedProfile;
}

function filters(over: Record<string, unknown> = {}): SearchFilters {
  return {
    term: { seasons: ['summer'], years: [2027] },
    positionTypes: ['internship'],
    role: { roleFamilies: [], titleIncludes: [], titleExcludes: [] },
    location: { cities: [], remote: true },
    company: { onlyCompanies: [], excludeCompanies: [] },
    ...over,
  } as unknown as SearchFilters;
}

describe('inferRoleFamilies', () => {
  /**
   * Every one of these was a real substring hit before the matcher required word
   * boundaries: "ml" inside "html", "ai" inside "email"/"training"/"detail", "ui" inside
   * "building", "lab" inside "collaborate", "pm" inside "rpm". A web-development resume
   * came back as a machine-learning candidate and got the queries to match.
   */
  it('does not read machine learning out of HTML, email and training', () => {
    const p = profile({
      skills: [{ name: 'HTML' }, { name: 'CSS' }],
      experience: [
        {
          title: 'Web Assistant',
          bullets: ['Sent email campaigns', 'Attended training', 'Collaborated on details'],
        },
      ],
    });
    expect(inferRoleFamilies(p)).not.toContain('machine learning');
  });

  it('does not read design out of "building"', () => {
    const p = profile({
      experience: [{ title: 'Helper', bullets: ['Building shelves in the workshop'] }],
    });
    expect(inferRoleFamilies(p)).not.toContain('design');
  });

  it('still finds a family the profile genuinely evidences', () => {
    const p = profile({
      skills: [{ name: 'PyTorch' }, { name: 'ML' }],
      experience: [{ title: 'Research Assistant', bullets: ['Deep learning for NLP'] }],
    });
    expect(inferRoleFamilies(p)).toContain('machine learning');
  });

  it('keeps the deliberate stems working', () => {
    const p = profile({
      education: [{ fieldOfStudy: 'Molecular Biology', coursework: ['Genomics'] }],
    });
    expect(inferRoleFamilies(p)).toContain('biology');
  });

  /**
   * The "robot" stem prefix-matched two idioms that are not robotics: "robots.txt" (an SEO
   * artefact) and "robotic process automation" (an ops one). A marketing or operations resume
   * was handed a robotics family and its queries — the substring-into-unrelated-resume failure
   * the word-boundary work in this file exists to end.
   */
  it('does not read robotics out of robots.txt or robotic process automation', () => {
    const seo = profile({
      skills: [{ name: 'SEO' }, { name: 'Content' }],
      experience: [{ title: 'Marketing Assistant', bullets: ['Configured robots.txt for SEO'] }],
    });
    expect(inferRoleFamilies(seo)).not.toContain('robotics');

    const ops = profile({
      skills: [{ name: 'Operations' }],
      experience: [
        { title: 'Ops Analyst', bullets: ['Automated invoicing with robotic process automation'] },
      ],
    });
    expect(inferRoleFamilies(ops)).not.toContain('robotics');
  });

  /**
   * Organisation names feed the corpus so a robotics club states the family in the org, but
   * under a prefix stem "Brandeis University" scored the "brand" (marketing) term and a
   * dining-services campus job — the common freshman shape — minted an evidence-free marketing
   * family. Org names match as whole words only.
   */
  it('does not mint a family from a prefix of an organisation name', () => {
    const p = profile({
      experience: [
        { title: 'Dining Services Assistant', organization: 'Brandeis University', bullets: [] },
      ],
    });
    expect(inferRoleFamilies(p)).not.toContain('marketing');
  });

  /**
   * "FIRST Robotics" is hit by "robotics", by the "robot" stem and by "first robotics" at once.
   * Counting matched terms let one water-handing line score robotics 3 and evict a family the
   * resume genuinely evidenced from the four-slot plan. Overlapping matches are one piece of
   * evidence, so a single FIRST mention must not outrank a real, separately-evidenced family.
   */
  it('does not let one robotics mention evict a genuinely evidenced family', () => {
    const p = profile({
      skills: [{ name: 'Figma' }, { name: 'pandas' }, { name: 'SQL' }],
      experience: [
        {
          title: 'Data Analyst',
          bullets: ['Handed out water at a FIRST Robotics event', 'Built dashboards in SQL'],
        },
      ],
      projects: [{ name: 'UX prototype', description: 'Designed a Figma prototype for the UI' }],
    });
    const families = inferRoleFamilies(p);
    expect(families).toContain('design');
    expect(families).toContain('data science');
  });

  /**
   * The true positive the robotics family exists for: a FIRST-shaped history states robotics in
   * the org name and in an award, and both have to keep inferring it.
   */
  it('still infers robotics from real robotics evidence in org and honors', () => {
    const p = profile({
      experience: [
        { title: 'Team Captain', organization: 'Sample Robotics', bullets: [] },
        { title: 'Mentor', organization: 'Gourd Bots, FIRST Robotics Competition', bullets: [] },
      ],
      education: [
        {
          fieldOfStudy: 'Mechanical Engineering',
          honors: ["Dean's List, FIRST Robotics Competition"],
        },
      ],
    });
    expect(inferRoleFamilies(p)).toContain('robotics');
  });
});

describe('pinned companies', () => {
  /**
   * A pinned name became one Greenhouse target with every non-alphanumeric character
   * deleted. A company on Lever, or one whose Greenhouse token is hyphenated, produced a
   * target that 404s — for the one company the user asked for by name.
   */
  it('tries every keyless vendor when the board has not been resolved', () => {
    const plan = planQueries(
      profile(),
      filters({
        company: { onlyCompanies: ['Acme Robotics, Inc.'], excludeCompanies: [] },
      }),
    );
    const sources = plan.targets.map((t) => t.source);
    expect(sources).toContain('greenhouse');
    expect(sources).toContain('lever');
    expect(sources).toContain('ashby');
    expect(plan.notes.join(' ')).toMatch(/no resolved board yet/i);
  });

  it('uses an already-resolved board instead of guessing', () => {
    const plan = planQueries(
      profile(),
      filters({ company: { onlyCompanies: ['Acme'], excludeCompanies: [] } }),
      [{ source: 'lever', board: 'acme', reason: 'resolved' }],
    );
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({ source: 'lever', board: 'acme' });
    expect(plan.notes.join(' ')).not.toMatch(/no resolved board yet/i);
  });

  /**
   * "Never truncated away" was the comment; slicing the concatenated array made it false
   * as soon as the pinned list alone reached the cap.
   */
  it('never drops a pinned company to make room for a known board', () => {
    const known = Array.from({ length: 10 }, (_, i) => ({
      source: 'greenhouse' as const,
      board: `board${String(i)}`,
      reason: 'known',
    }));
    const plan = planQueries(
      profile(),
      filters({ company: { onlyCompanies: ['Pinned'], excludeCompanies: [] } }),
      known,
      { maxTargets: 4 },
    );
    expect(plan.targets.filter((t) => t.reason.startsWith('company you pinned'))).toHaveLength(3);
    expect(plan.targets).toHaveLength(4);
    expect(plan.notes.join(' ')).toMatch(/truncated/i);
  });
});
