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
  // "engineer" is gone from this list: as a prefix stem it matched the word "Engineering"
  // inside science-FAIR names ("Sample Regional Science and Engineering Fair"), so a
  // debate-and-theatre student with a Behavioral Sciences award got software queries. The
  // terms that remain are ones only a software resume says — and "computer science" /
  // "usaco" / "algorithm" are what a competition-programming high schooler actually
  // prints, which used to evidence nothing at all.
  'software engineering': [
    'software',
    'developer',
    'programming',
    'backend',
    'frontend',
    'fullstack',
    'swe',
    'computer science',
    'usaco',
    'algorithm',
    'coding',
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
  // "product" alone matched "photograph products" in an Etsy-shop bullet and handed a
  // sticker seller a product-management family, which then evicted the marketing family
  // their state-championship award had genuinely earned. Only the qualified form counts.
  'product management': ['product manag', 'roadmap', 'pm', 'stakeholder'],
  // "design" alone is one of the commonest resume VERBS in every domain — "Designed
  // weekly practice plans" gave a swim coach UX queries — and it sits inside school names
  // ("Design and Architecture Senior High") and theatre credits ("Lighting Designer").
  // A genuine UX resume says ux/ui/figma/wireframe or a qualified "«x» design".
  design: [
    'ux',
    'ui',
    'figma',
    'prototyp',
    'wireframe',
    'user experience',
    'user interface',
    'graphic design',
    'product design',
    'visual design',
  ],
  'hardware engineering': ['hardware', 'circuit', 'pcb', 'embedded', 'fpga', 'verilog'],
  // FIRST alone is four seasons of a student's life, and the word "robotics" appeared
  // nowhere in this table — so the resumes most likely to say it (team captains, mentors,
  // competition volunteers) inferred no family from it and none of their searches asked
  // for robotics internships, which is the one query they would have typed themselves.
  robotics: ['robotics', 'robot', 'mechatronics', 'ros', 'first robotics'],
  'mechanical engineering': ['mechanical', 'cad', 'solidworks', 'thermodynamic'],
  'electrical engineering': ['electrical', 'signal', 'power systems'],
  'civil engineering': ['civil', 'structural', 'geotechnical'],
  // "biolog" is a word-START stem, so it cannot see itself inside "microbiology" — a
  // Regeneron ISEF Finalist in Microbiology whose resume never prints the bare word
  // "Biology" inferred no biology family and the search they would have typed never ran.
  // The sub-disciplines are stems of their own.
  biology: [
    'biology',
    'biolog',
    'microbiolog',
    'neurobiolog',
    'biochem',
    'genom',
    'molecular',
    'lab',
  ],
  chemistry: ['chemistry', 'chemical', 'organic synthesis'],
  finance: ['finance', 'financial', 'accounting', 'investment', 'valuation', 'trading'],
  consulting: ['consulting', 'strategy', 'advisory'],
  // The four families below exist because their students inferred NOTHING: a hospital
  // volunteer with HOSA honors, a swim coach who tutors at two community centers, an
  // editor-in-chief with CSPA and NSPA awards, and a debate captain who volunteered in a
  // state representative's office each fell to the "no role family could be inferred"
  // note — so the one search each of them would have typed by hand never ran. Terms are
  // deliberately qualified against prose homonyms: bare "editor" is a text editor, bare
  // "patient" is a temperament, bare "policy" is a privacy policy, bare "debate" is
  // "debated tradeoffs" in an engineering bullet.
  healthcare: [
    'hospital',
    'clinical',
    'patient care',
    'patient transport',
    'pre-med',
    'premed',
    'nursing',
    'medical',
    'medicine',
    'hosa',
    'public health',
    'healthcare',
    'health care',
  ],
  education: [
    'tutor',
    'teaching',
    'taught',
    'teacher',
    'mentor',
    'coach',
    'camp counselor',
    'classroom',
    'curriculum',
    'youth',
  ],
  journalism: [
    'journalism',
    'journalist',
    'newspaper',
    'yearbook',
    'editor-in-chief',
    'editorial',
    'news writing',
    'student press',
    'copy editor',
    'section editor',
    'broadcast journalism',
    'quill and scroll',
    'cspa',
    'nspa',
  ],
  'public policy': [
    'public policy',
    'legislative',
    'legislature',
    'model united nations',
    'model un',
    'mun',
    'mock trial',
    'debate team',
    'debate club',
    'debate captain',
    'debate tournament',
    'debater',
    'speech and debate',
    'speech & debate',
    'lincoln-douglas',
    'student government',
    'political science',
    'government',
    'civic',
    'pre-law',
  ],
  marketing: ['marketing', 'brand', 'seo', 'content', 'growth'],
  operations: ['operations', 'supply chain', 'logistics'],
  research: ['research', 'publication', 'thesis', 'laboratory'],
};

/**
 * Every place a taxonomy term appears in the corpus, as [start, end) spans.
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
 * catch "biological", "prototyp" to catch "prototyping" — EXCEPT in `stems: false` text,
 * where an employer name that merely begins with a stem ("Brandeis" under the "brand" stem)
 * must not mint a family it has no other evidence for.
 */
function termSpans(corpus: string, term: string, stems: boolean): Array<[number, number]> {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = stems && term.length > 3 ? `\\b${escaped}` : `\\b${escaped}\\b`;
  const re = new RegExp(pattern, 'gi');
  const out: Array<[number, number]> = [];
  for (const m of corpus.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * How many DISTINCT pieces of evidence a family has in a corpus.
 *
 * Counting matched terms let one string stand for several: "FIRST Robotics" is hit by
 * "robotics", by the "robot" stem, and by "first robotics" all at once, so a single
 * water-handing volunteer line scored robotics 3 and evicted a family the resume genuinely
 * evidenced from the four-slot plan. Overlapping matches describe the same evidence, so they
 * are merged and counted once; two separate mentions in different parts of the corpus still
 * count as two.
 */
function evidenceCount(corpus: string, terms: string[], stems: boolean): number {
  const spans = terms.flatMap((t) => termSpans(corpus, t, stems)).sort((a, b) => a[0] - b[0]);
  let count = 0;
  let lastEnd = -1;
  for (const [start, end] of spans) {
    if (start >= lastEnd) {
      count++;
      lastEnd = end;
    } else if (end > lastEnd) {
      lastEnd = end;
    }
  }
  return count;
}

/**
 * Idioms that borrow a taxonomy stem without being its evidence, scrubbed before matching
 * rather than by narrowing the stem, because the genuine uses must keep counting:
 *
 *   - "robots.txt" is an SEO artefact and "robotic process automation" an ops one — the
 *     "robot" stem matched both, and a marketing resume was handed robotics queries;
 *   - "tutorial(s)" starts with the "tutor" stem, so following a React tutorial would
 *     read as teaching experience;
 *   - "self-taught" and "taught/teaching myself" describe learning, not teaching; being
 *     "mentored by" someone is receiving mentorship, not giving it. Each would mint an
 *     education family for a resume with no teaching in it;
 *   - a clock time is not a job title. "PM" is the product-management acronym and is only
 *     two letters, so it matches as a whole word — and the first resume any of this is
 *     built for says "Worked 4 to 9 PM shifts on weekends", which handed a cashier a
 *     product-management search plan. Hourly students write their hours down; this has to
 *     read them as hours.
 */
function scrubFalseSignals(corpus: string): string {
  return corpus
    .replace(/\brobots\.txt\b/gi, ' ')
    .replace(/\brobotic process automation\b/gi, ' ')
    .replace(/\btutorials?\b/gi, ' ')
    .replace(/\bself-taught\b/gi, ' ')
    .replace(/\b(?:taught|teaching)\s+myself\b/gi, ' ')
    .replace(/\bmentored by\b/gi, ' ')
    .replace(/\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?(?!\w)/gi, ' ')
    .replace(/\b[ap]\.?m\.?\s+(?=shift|slot|hours|block|rush|closing|opening)/gi, ' ');
}

export function inferRoleFamilies(profile: ConfirmedProfile): string[] {
  // Titles, bullets, projects and coursework are where a stem is meant to reach ("biolog" ->
  // "biological"), so they carry stems.
  const stemCorpus = scrubFalseSignals(
    [
      ...profile.skills.map((s) => s.name),
      ...profile.experience.map((e) => `${e.title} ${e.bullets.join(' ')}`),
      ...profile.projects.map((p) => `${p.name} ${p.description}`),
      ...profile.education.flatMap((e) => [
        e.fieldOfStudy ?? '',
        ...(e.coursework ?? []),
        ...(e.honors ?? []),
      ]),
    ]
      .join(' ')
      .toLowerCase(),
  );

  // Organisation names are evidence too — a robotics club is stated in the org, not the
  // bullets — but only as whole words. Under a prefix stem "Brandeis University" scored the
  // "brand" (marketing) term and a dining-services campus job minted marketing queries; a
  // whole-word match still reads "Sample Robotics" as robotics without inventing the rest.
  let orgCorpus = scrubFalseSignals(
    profile.experience
      .map((e) => e.organization ?? '')
      .join(' ')
      .toLowerCase(),
  );

  // A school's NAME is identity, not role evidence. Young resumes write clubs as
  // "Student Ambassador, Design and Architecture Senior High", and the school name's own
  // words minted a design family with zero design work behind it. The institution field is
  // already kept out of the corpus; it gets the same treatment when it reappears inside an
  // experience organisation, while the rest of that org line ("Speech & Debate Team",
  // written after the school's name) keeps counting.
  for (const e of profile.education) {
    const inst = e.institution?.toLowerCase().trim();
    if (inst && inst.length > 3) orgCorpus = orgCorpus.split(inst).join(' ');
  }

  const scored = Object.entries(ROLE_TAXONOMY)
    .map(([family, terms]) => ({
      family,
      hits: evidenceCount(stemCorpus, terms, true) + evidenceCount(orgCorpus, terms, false),
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
