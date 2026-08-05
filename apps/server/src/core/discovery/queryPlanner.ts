/**
 * Query planning — docs/04 § Query planning.
 *
 * Turns the confirmed profile plus the active filters into a bounded, INSPECTABLE set of
 * discovery targets. The user sees and can edit the plan before a run, because a search
 * tool whose queries you can't see is one you can't reason about when it misses things.
 *
 * Role families come from the profile deterministically and are filtered against a
 * curated taxonomy, so a bad inference can't send forty queries for a role the user has
 * no evidence for.
 */
import type { ConfirmedProfile, SearchFilters } from '@ia/shared';
import type { AtsSourceName } from './sources/ats';
import { slugCandidates } from './resolveCompany';

export interface PlannedTarget {
  source: AtsSourceName | 'adzuna' | 'usajobs' | 'github_list';
  board: string;
  /** Why this target is in the plan — shown next to each chip in the UI. */
  reason: string;
}

export interface QueryPlan {
  targets: PlannedTarget[];
  keywords: string[];
  roleFamilies: string[];
  termTokens: string[];
  locations: string[];
  notes: string[];
}

/**
 * Curated taxonomy. A role family only enters the plan if the profile actually evidences
 * it — this is the guard against a plan full of roles the user never did.
 */
const ROLE_TAXONOMY: Record<string, string[]> = {
  'software engineering': [
    'software',
    'engineer',
    'developer',
    'programming',
    'backend',
    'frontend',
    'fullstack',
    'swe',
  ],
  'data science': ['data', 'analytics', 'statistics', 'pandas', 'sql', 'analysis'],
  'machine learning': [
    'machine learning',
    'ml',
    'ai',
    'deep learning',
    'pytorch',
    'tensorflow',
    'nlp',
  ],
  'product management': ['product', 'roadmap', 'pm', 'stakeholder'],
  design: ['design', 'ux', 'ui', 'figma', 'prototyp'],
  'hardware engineering': ['hardware', 'circuit', 'pcb', 'embedded', 'fpga', 'verilog'],
  'mechanical engineering': ['mechanical', 'cad', 'solidworks', 'thermodynamic'],
  'electrical engineering': ['electrical', 'signal', 'power systems'],
  'civil engineering': ['civil', 'structural', 'geotechnical'],
  biology: ['biology', 'biolog', 'genom', 'molecular', 'lab'],
  chemistry: ['chemistry', 'chemical', 'organic synthesis'],
  finance: ['finance', 'financial', 'accounting', 'investment', 'valuation', 'trading'],
  consulting: ['consulting', 'strategy', 'advisory'],
  marketing: ['marketing', 'brand', 'seo', 'content', 'growth'],
  operations: ['operations', 'supply chain', 'logistics'],
  research: ['research', 'publication', 'thesis', 'laboratory'],
};

/**
 * Does a taxonomy term actually appear in the corpus?
 *
 * A bare `corpus.includes(t)` is what this used to be, and the short terms made a mockery
 * of the curated list that is supposed to stop a bad inference from sending forty queries
 * for a role the user has no evidence for: "ml" is inside "html", "ai" inside "email",
 * "training" and "detail", "ui" inside "building", "lab" inside "collaborate", "pm"
 * inside "rpm". A resume mentioning HTML and email got machine-learning queries.
 *
 * Short terms (three characters or fewer) must be whole words — they are acronyms, and an
 * acronym embedded in a longer word is a different word. Longer terms need only start at
 * a word boundary, because several entries are deliberate stems: "biolog" is meant to
 * catch "biological", "prototyp" to catch "prototyping".
 */
function termAppears(corpus: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = term.length <= 3 ? `\\b${escaped}\\b` : `\\b${escaped}`;
  return new RegExp(pattern, 'i').test(corpus);
}

export function inferRoleFamilies(profile: ConfirmedProfile): string[] {
  const corpus = [
    ...profile.skills.map((s) => s.name),
    ...profile.experience.map((e) => `${e.title} ${e.bullets.join(' ')}`),
    ...profile.projects.map((p) => `${p.name} ${p.description}`),
    ...profile.education.flatMap((e) => [e.fieldOfStudy ?? '', ...(e.coursework ?? [])]),
  ]
    .join(' ')
    .toLowerCase();

  const scored = Object.entries(ROLE_TAXONOMY)
    .map(([family, terms]) => ({
      family,
      hits: terms.filter((t) => termAppears(corpus, t)).length,
    }))
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  return scored.slice(0, 4).map((s) => s.family);
}

/** "summer 2027 internship", "2027 summer analyst", … — from the filters, not hardcoded. */
export function termTokens(filters: SearchFilters): string[] {
  const seasons = filters.term.seasons.length ? filters.term.seasons : ['summer'];
  const years = filters.term.years.length ? filters.term.years : [new Date().getUTCFullYear() + 1];
  const types = filters.positionTypes.length ? filters.positionTypes : ['internship'];

  const out: string[] = [];
  for (const s of seasons) {
    for (const y of years) {
      for (const t of types.slice(0, 3)) {
        out.push(`${s.replace('_', ' ')} ${y} ${t.replace('_', '-')}`);
      }
    }
  }
  return [...new Set(out)];
}

export function planQueries(
  profile: ConfirmedProfile,
  filters: SearchFilters,
  knownBoards: PlannedTarget[] = [],
  opts: { maxTargets?: number } = {},
): QueryPlan {
  const notes: string[] = [];
  const roleFamilies = inferRoleFamilies(profile);
  if (roleFamilies.length === 0) {
    notes.push(
      'No role family could be inferred from your profile, so keyword search will be broad. ' +
        'Add skills or projects, or set role families in the filters.',
    );
  }

  const locations = [
    ...(filters.location.cities.length
      ? filters.location.cities
      : [profile.locationPrefs.base.city].filter(Boolean)),
    ...profile.locationPrefs.relocateTo,
    ...(profile.locationPrefs.remoteOk ? ['remote'] : []),
  ].filter(Boolean);

  const keywords = [
    ...roleFamilies,
    ...filters.role.roleFamilies,
    ...filters.role.titleIncludes,
  ].filter(Boolean);

  /**
   * Company targets the user pinned.
   *
   * A pinned name used to become exactly one Greenhouse target whose board was the name
   * with every non-alphanumeric character deleted. A company on Lever or Ashby, or one
   * whose Greenhouse token is hyphenated, produced a target that 404s — and the user, who
   * had explicitly asked for that company, got nothing back and no explanation.
   *
   * A board already resolved for that company is used as-is; otherwise every slug
   * candidate is tried across the three keyless vendors, and a note says the guess was
   * unverified so the resolve endpoint can be pointed at it.
   */
  const pinned: PlannedTarget[] = [];
  const promoted = new Set<PlannedTarget>();
  for (const c of filters.company.onlyCompanies) {
    const slugs = slugCandidates(c);
    const already = knownBoards.filter((b) => slugs.includes(b.board.toLowerCase()));
    if (already.length > 0) {
      for (const b of already) promoted.add(b);
      pinned.push(...already.map((b) => ({ ...b, reason: 'company you pinned' })));
      continue;
    }
    for (const source of ['greenhouse', 'lever', 'ashby'] as const) {
      pinned.push({ source, board: slugs[0]!, reason: 'company you pinned (board unverified)' });
    }
    notes.push(
      `"${c}" has no resolved board yet, so its name was guessed as "${slugs[0]!}" on ` +
        'Greenhouse, Lever and Ashby. Resolve it in Discover to search the right one.',
    );
  }

  // Pinned targets survive truncation, because the comment above is a promise: the user
  // asked for those by name. Slicing the concatenated list dropped them silently once the
  // pinned list alone exceeded the cap.
  const max = opts.maxTargets ?? 40;
  // A board promoted into the pinned list is not searched twice.
  const rest = knownBoards.filter((b) => !promoted.has(b));
  const room = Math.max(0, max - pinned.length);
  const targets = [...pinned, ...rest.slice(0, room)];
  const dropped = rest.length - room;

  if (dropped > 0) {
    notes.push(
      `Plan truncated to ${targets.length} targets (${dropped} dropped). Raise the cap or narrow the filters.`,
    );
  }
  if (targets.length === 0) {
    notes.push(
      'No company boards resolved yet. Add companies in Discover, or paste a job URL directly.',
    );
  }

  return {
    targets,
    keywords: [...new Set(keywords)],
    roleFamilies,
    termTokens: termTokens(filters),
    locations: [...new Set(locations)],
    notes,
  };
}
