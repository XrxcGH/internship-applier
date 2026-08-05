/**
 * Evidence retrieval — docs/06 § ① Retrieval, not invention.
 *
 * The drafting prompt never sees the whole profile. It sees a bounded set of facts
 * relevant to the question, each carrying a `ref` that points back at where it came from.
 * Two reasons, and the second is the important one:
 *
 *   - a smaller prompt drafts better;
 *   - every sentence the model writes has to be traceable to one of these items, and
 *     FactGuard checks exactly that. Facts that were never supplied cannot be "supported".
 *
 * Deterministic: keyword and skill overlap, no model call, no embeddings yet.
 */
import type { ConfirmedProfile } from '@ia/shared';

export interface Evidence {
  /** Stable path back into the profile, e.g. "experience.0.bullets.2". */
  ref: string;
  kind: 'experience' | 'project' | 'education' | 'skill' | 'certification' | 'identity';
  /** The verbatim fact. FactGuard compares generated claims against this text. */
  text: string;
  /** Structured values pulled out for the deterministic checks. */
  facts: {
    organization?: string;
    title?: string;
    institution?: string;
    startDate?: string;
    endDate?: string;
    gpa?: { value: number; scale: number };
    skills?: string[];
  };
  score: number;
}

const STOPWORDS = new Set(
  (
    'the a an and or but of to in for on with at by from as is are was were be been it this that ' +
    'you your we our i my me they their what how why when which who whom will would can could ' +
    'about tell us describe give example time why do did does have has had ' +
    // Function words long enough to survive the length filter. Kept here rather than in a
    // second list so retrieval and FactGuard score against the same notion of "content".
    'where while there then than also just very really still after before because though into ' +
    'over more most much some any all like being them these those such under both each ' +
    'through during without within across among between able'
  ).split(' '),
);

/** Content tokens — shared by retrieval scoring and FactGuard's support scoring. */
export function tokens(s: string): string[] {
  return (
    (s.toLowerCase().match(/[\p{L}0-9+#.]+/gu) ?? [])
      // The dot is in the class so "node.js" and ".NET" survive whole, but it also glued
      // the full stop onto the last word of every sentence: "store." never matched the
      // evidence token "store", so each claim quietly lost a content word and coverage
      // came out low enough to push honest sentences from green to amber.
      .map((t) => t.replace(/^\.+|\.+$/g, ''))
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

function overlap(a: Set<string>, b: string[]): number {
  if (b.length === 0) return 0;
  let hits = 0;
  for (const t of b) if (a.has(t)) hits++;
  return hits / b.length;
}

export interface RetrieveOptions {
  /** Hard cap on what reaches the prompt. */
  limit?: number;
  /** Posting text, so "why this role" pulls the relevant side of the profile. */
  postingContext?: string;
}

/**
 * Builds the evidence set for one question.
 *
 * Identity facts are always included regardless of score: a draft that cannot name the
 * user's own school or current role is worse than one with a slightly larger prompt.
 */
export function retrieveEvidence(
  profile: ConfirmedProfile,
  question: string,
  opts: RetrieveOptions = {},
): Evidence[] {
  const query = new Set([...tokens(question), ...tokens(opts.postingContext ?? '')]);
  const items: Evidence[] = [];

  profile.experience.forEach((e, i) => {
    const skills = e.skills ?? [];
    e.bullets.forEach((b, j) => {
      items.push({
        ref: `experience.${i}.bullets.${j}`,
        kind: 'experience',
        text: b,
        facts: {
          organization: e.organization,
          title: e.title,
          startDate: e.startDate,
          endDate: e.endDate,
          skills,
        },
        score: overlap(query, tokens(`${b} ${e.title} ${skills.join(' ')}`)) + 0.15,
      });
    });

    // The role itself, even when its bullets don't match — dates and titles are the
    // facts most often misstated, so they must be in the evidence set to be checkable.
    items.push({
      ref: `experience.${i}`,
      kind: 'experience',
      text: `${e.title} at ${e.organization} (${e.startDate ?? 'date not stated'} to ${e.endDate ?? 'present'})`,
      facts: {
        organization: e.organization,
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate,
        skills,
      },
      score: overlap(query, tokens(`${e.title} ${e.organization}`)) + 0.3,
    });
  });

  profile.projects.forEach((p, i) => {
    items.push({
      ref: `projects.${i}`,
      kind: 'project',
      text: `${p.name}: ${p.description}${p.bullets.length ? ` ${p.bullets.join(' ')}` : ''}`,
      facts: { title: p.name, skills: p.skills ?? [] },
      score:
        overlap(query, tokens(`${p.name} ${p.description} ${(p.skills ?? []).join(' ')}`)) + 0.1,
    });
  });

  profile.education.forEach((e, i) => {
    const course = (e.coursework ?? []).join(', ');
    items.push({
      ref: `education.${i}`,
      kind: 'education',
      text:
        `${e.level} in ${e.fieldOfStudy ?? 'an unspecified field'} at ${e.institution}` +
        `${e.endDate ? `, ending ${e.endDate}` : ''}` +
        `${e.gpa ? `, GPA ${e.gpa.value}/${e.gpa.scale}` : ''}` +
        `${course ? `. Coursework: ${course}` : ''}`,
      facts: {
        institution: e.institution,
        startDate: e.startDate,
        endDate: e.endDate,
        gpa: e.gpa,
      },
      score: overlap(query, tokens(`${e.fieldOfStudy ?? ''} ${e.institution} ${course}`)) + 0.25,
    });
  });

  const skillNames = profile.skills.map((s) => s.name);
  if (skillNames.length > 0) {
    items.push({
      ref: 'skills',
      kind: 'skill',
      text: `Skills: ${skillNames.join(', ')}`,
      facts: { skills: skillNames },
      score: overlap(query, tokens(skillNames.join(' '))) + 0.2,
    });
  }

  profile.certifications.forEach((c, i) => {
    items.push({
      ref: `certifications.${i}`,
      kind: 'certification',
      text: `${c.name}${c.issuer ? ` from ${c.issuer}` : ''}`,
      facts: { title: c.name, organization: c.issuer },
      score: overlap(query, tokens(c.name)) + 0.05,
    });
  });

  const limit = opts.limit ?? 14;
  const ranked = items.sort((a, b) => b.score - a.score);

  // Always keep at least one education and one experience item if the profile has them,
  // even when the question is about something else. Each missing kind takes its own slot
  // at the tail: both used to be written into the last one, so a profile where neither
  // made the cut got its education item and then had it overwritten by the experience
  // one, and a true "my GPA is 3.8" sentence was blocked for having no education fact to
  // check against.
  const chosen = ranked.slice(0, limit);
  const topUps = (['education', 'experience'] as const)
    .filter((kind) => !chosen.some((c) => c.kind === kind))
    .map((kind) => ranked.find((r) => r.kind === kind))
    .filter((e): e is Evidence => e !== undefined);
  topUps.forEach((item, i) => {
    const slot = chosen.length - 1 - i;
    if (slot >= 0) chosen[slot] = item;
  });
  return chosen;
}

/** The evidence block as the drafting prompt sees it. */
export function formatEvidence(evidence: Evidence[]): string {
  return evidence.map((e) => `[${e.ref}] ${e.text}`).join('\n');
}
