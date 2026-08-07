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
    gpa?: { value: number; scale: number; weighted?: number };
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
 * Who the writer is, in one line. Always included, whatever the question is about.
 *
 * FactGuard treats a proper noun with nothing behind it as a fabrication, so before this
 * existed "I'm based in New Brunswick" was blocked at G3 with `"New Brunswick" does not
 * appear anywhere on your profile` — a true sentence, about a fact the profile holds, with
 * no override available and no way to satisfy the message it offered. The user's own name
 * failed the same way whenever a draft signed off with it.
 */
function identityEvidence(profile: ConfirmedProfile): Evidence | null {
  const name = profile.fullName?.trim() ?? '';
  const base = profile.locationPrefs?.base;
  const place = [base?.city, base?.region]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(', ');
  if (!name && !place) return null;

  const text = name && place ? `${name}, based in ${place}` : name || `Based in ${place}`;
  return { ref: 'identity', kind: 'identity', text, facts: {}, score: 1 };
}

/**
 * Builds the evidence set for one question.
 *
 * The identity line above is always included regardless of score. Everything else is
 * ranked by keyword overlap and cut at `limit`, with one education and one experience item
 * topped up at the tail if the ranking dropped them — a draft that cannot name the user's
 * own school or current role is worse than one with a slightly larger prompt.
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
    //
    // The location belongs in the text for the opposite reason. It was left out, so
    // "I interned at Acme Analytics in Columbus" came back blocking at G3 with
    // `"Columbus" does not appear anywhere on your profile` — while the profile held
    // exactly that city on exactly that job. There is no override at G3, and the fix the
    // message suggests was already done.
    items.push({
      ref: `experience.${i}`,
      kind: 'experience',
      text:
        `${e.title} at ${e.organization}${e.location ? ` in ${e.location}` : ''} ` +
        `(${e.startDate ?? 'date not stated'} to ${e.endDate ?? 'present'})`,
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
    // Honors are evidence, and for a student early in their path they are most of it. A
    // resume whose experience section is titles without bullets carries its substance in
    // the awards — and while these were left out of the text, every true sentence about
    // one ("I was a Dean's List semifinalist") was blocked at G3 as an invented name,
    // because the only place the award existed was a field nothing quoted.
    const honors = (e.honors ?? []).join(', ');
    items.push({
      ref: `education.${i}`,
      kind: 'education',
      text:
        `${e.level} in ${e.fieldOfStudy ?? 'an unspecified field'} at ${e.institution}` +
        `${e.endDate ? `, ending ${e.endDate}` : ''}` +
        `${e.gpa ? `, GPA ${e.gpa.value}/${e.gpa.scale}` : ''}` +
        `${e.gpa?.weighted ? ` (${e.gpa.weighted} weighted)` : ''}` +
        `${course ? `. Coursework: ${course}` : ''}` +
        `${honors ? `. Honors: ${honors}` : ''}`,
      facts: {
        institution: e.institution,
        startDate: e.startDate,
        endDate: e.endDate,
        gpa: e.gpa,
      },
      score:
        overlap(query, tokens(`${e.fieldOfStudy ?? ''} ${e.institution} ${course} ${honors}`)) +
        0.25,
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

  const identity = identityEvidence(profile);
  const limit = Math.max(0, (opts.limit ?? 14) - (identity ? 1 : 0));
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
  return identity ? [identity, ...chosen] : chosen;
}

/** The evidence block as the drafting prompt sees it. */
export function formatEvidence(evidence: Evidence[]): string {
  return evidence.map((e) => `[${e.ref}] ${e.text}`).join('\n');
}
