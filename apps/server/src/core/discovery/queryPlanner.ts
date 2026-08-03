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
      hits: terms.filter((t) => corpus.includes(t)).length,
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

  // Company targets the user pinned always come first and are never truncated away.
  const pinned: PlannedTarget[] = filters.company.onlyCompanies.map((c) => ({
    source: 'greenhouse',
    board: c.toLowerCase().replace(/[^a-z0-9]/g, ''),
    reason: 'company you pinned',
  }));

  const max = opts.maxTargets ?? 40;
  const combined = [...pinned, ...knownBoards];
  const targets = combined.slice(0, max);

  if (combined.length > max) {
    notes.push(
      `Plan truncated to ${max} targets (${combined.length - max} dropped). Raise the cap or narrow the filters.`,
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
