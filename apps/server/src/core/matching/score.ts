/**
 * Fit scoring — docs/05 § Stage 2.
 *
 * ADVISORY ONLY. This orders the review queue; it never filters anything out. Every
 * dimension is reported alongside the total so the bars in the UI are the actual
 * computation rather than a decoration.
 */
import type { ConfirmedProfile, JobRequirement, ScoreBreakdown } from '@ia/shared';
import type { PostingFacts } from './eligibility';

export interface ScoreWeights {
  requiredSkillCoverage: number;
  preferredSkillCoverage: number;
  roleAlignment: number;
  domainMatch: number;
  seniorityFit: number;
  locationDesirability: number;
  compensation: number;
  applyEffort: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  requiredSkillCoverage: 30,
  preferredSkillCoverage: 12,
  roleAlignment: 18,
  domainMatch: 10,
  seniorityFit: 10,
  locationDesirability: 8,
  compensation: 6,
  applyEffort: 6,
};

export interface ScoreInput {
  profile: ConfirmedProfile;
  posting: PostingFacts & {
    descriptionText: string;
    compensation: Record<string, unknown> | null;
    applyEffort: { steps: number; essayCount: number; estMinutes: number } | null;
    positionType: string | null;
  };
  requirements: JobRequirement[];
  weights?: ScoreWeights;
}

export interface ScoreOutcome {
  score: number;
  breakdown: ScoreBreakdown;
  /** Per-dimension notes, so the UI can explain each bar. */
  notes: Record<keyof ScoreBreakdown, string>;
}

function normalizeSkill(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#.]/g, '');
}

/** Common aliases. Deliberately small — a wrong alias inflates a score silently. */
const ALIASES: Record<string, string[]> = {
  javascript: ['js', 'node', 'nodejs'],
  typescript: ['ts'],
  python: ['py'],
  postgresql: ['postgres', 'psql'],
  kubernetes: ['k8s'],
  'c++': ['cpp'],
  'c#': ['csharp'],
};

function skillMatches(mine: Set<string>, wanted: string): boolean {
  const w = normalizeSkill(wanted);
  if (mine.has(w)) return true;
  for (const [canonical, alts] of Object.entries(ALIASES)) {
    const group = [normalizeSkill(canonical), ...alts.map(normalizeSkill)];
    if (group.includes(w) && group.some((g) => mine.has(g))) return true;
  }
  return false;
}

function coverage(mine: Set<string>, wanted: string[]): number {
  if (wanted.length === 0) return 1;
  return wanted.filter((w) => skillMatches(mine, w)).length / wanted.length;
}

const SENIORITY_TARGET: Record<string, string[]> = {
  pre_college: ['internship', 'externship', 'seasonal', 'volunteer'],
  entry_intern: ['internship', 'co_op', 'externship', 'research', 'apprenticeship'],
  experienced_intern: ['internship', 'co_op', 'fellowship', 'research', 'trainee_program'],
  new_grad: ['new_grad', 'fellowship', 'trainee_program', 'co_op'],
};

export function scoreMatch(input: ScoreInput): ScoreOutcome {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const { profile, posting, requirements } = input;

  const mine = new Set(profile.skills.map((s) => normalizeSkill(s.name)));
  const skillReqs = requirements.filter((r) => r.kind === 'skill');
  const required = skillReqs
    .filter((r) => r.necessity === 'required')
    .map((r) => (r.value as { name?: string }).name ?? '')
    .filter(Boolean);
  const preferred = skillReqs
    .filter((r) => r.necessity !== 'required')
    .map((r) => (r.value as { name?: string }).name ?? '')
    .filter(Boolean);

  const requiredCov = coverage(mine, required);
  const preferredCov = coverage(mine, preferred);

  // Role alignment: token overlap between the title and the user's own experience and
  // project vocabulary. Cheap, explainable, and no embedding dependency yet.
  const myVocab = new Set(
    [
      ...profile.experience.map((e) => e.title),
      ...profile.skills.map((s) => s.name),
      ...profile.projects.map((p) => p.name),
    ]
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((t) => t.length > 2),
  );
  const titleTokens = posting.title
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length > 2 && !['intern', 'internship', 'summer', 'the', 'and'].includes(t));
  const roleAlignment =
    titleTokens.length === 0
      ? 0.5
      : titleTokens.filter((t) => myVocab.has(t)).length / titleTokens.length;

  const industries = profile.preferences.industries.map((i) => i.toLowerCase());
  const domainMatch =
    industries.length === 0
      ? 0.5 // No stated preference is neutral, not a penalty.
      : industries.some((i) => posting.descriptionText.toLowerCase().includes(i))
        ? 1
        : 0.3;

  const wanted = SENIORITY_TARGET[profile.derived.seniorityBand] ?? [];
  const seniorityFit =
    posting.positionType === null ? 0.5 : wanted.includes(posting.positionType) ? 1 : 0.25;

  const prefs = profile.locationPrefs;
  const isRemote = posting.workArrangement === 'remote' || posting.locations.some((l) => l.remote);
  const inHome = posting.locations.some((l) =>
    (l.city ?? '').toLowerCase().includes(prefs.base.city.toLowerCase()),
  );
  const inTarget = posting.locations.some((l) =>
    prefs.relocateTo.some((t) => (l.city ?? '').toLowerCase().includes(t.toLowerCase())),
  );
  const locationDesirability = inHome ? 1 : isRemote ? 0.9 : inTarget ? 0.8 : 0.4;

  // Undisclosed pay is neutral (0.5), never a penalty — silence is not a low salary.
  const comp = posting.compensation;
  const compensation =
    comp === null
      ? 0.5
      : comp['unpaid'] === true
        ? 0.1
        : comp['academicCreditOnly'] === true
          ? 0.2
          : typeof comp['min'] === 'number'
            ? Math.min(1, Number(comp['min']) / hourlyTarget(String(comp['period'] ?? 'hour')))
            : 0.5;

  const effort = posting.applyEffort;
  const applyEffort =
    effort === null
      ? 0.6
      : Math.max(0, 1 - (effort.estMinutes / 60) * 0.5 - effort.essayCount * 0.12);

  const breakdown: ScoreBreakdown = {
    requiredSkillCoverage: requiredCov,
    preferredSkillCoverage: preferredCov,
    roleAlignment,
    domainMatch,
    seniorityFit,
    locationDesirability,
    compensation,
    applyEffort,
  };

  const total = (Object.keys(breakdown) as Array<keyof ScoreBreakdown>).reduce(
    (acc, k) => acc + breakdown[k] * w[k],
    0,
  );
  const maxTotal = Object.values(w).reduce((a, b) => a + b, 0);

  return {
    score: Math.round(Math.max(0, Math.min(100, (total / maxTotal) * 100))),
    breakdown,
    notes: {
      requiredSkillCoverage: required.length
        ? `${required.filter((r) => skillMatches(mine, r)).length}/${required.length} required skills matched`
        : 'no required skills listed',
      preferredSkillCoverage: preferred.length
        ? `${preferred.filter((r) => skillMatches(mine, r)).length}/${preferred.length} preferred skills matched`
        : 'no preferred skills listed',
      roleAlignment: `${Math.round(roleAlignment * 100)}% of the title's terms appear in your background`,
      domainMatch: industries.length
        ? 'against your stated industries'
        : 'no industry preference set',
      seniorityFit: posting.positionType
        ? `${posting.positionType} vs your ${profile.derived.seniorityBand} band`
        : 'position type not stated',
      locationDesirability: inHome
        ? 'in your home city'
        : isRemote
          ? 'remote'
          : inTarget
            ? 'a relocation target'
            : 'outside your stated areas',
      compensation:
        comp === null ? 'pay not disclosed — treated as neutral' : 'from the stated pay',
      applyEffort: effort
        ? `about ${effort.estMinutes} min, ${effort.essayCount} essay(s)`
        : 'effort unknown',
    },
  };
}

/** Rough "good intern pay" anchors used to normalise the compensation dimension. */
function hourlyTarget(period: string): number {
  switch (period) {
    case 'hour':
      return 45;
    case 'week':
      return 1800;
    case 'month':
      return 7800;
    case 'year':
      return 95_000;
    default:
      return 45;
  }
}
