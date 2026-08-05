/**
 * FactGuard — docs/06 § ④.
 *
 * The reason this tool is safe to point at a job application. Every claim in a draft is
 * checked against the evidence set the draft was built from; anything that cannot be
 * traced is flagged and blocks approval at gate G3.
 *
 * TWO LAYERS, and the order matters:
 *
 *   1. DETERMINISTIC (this file, no model). Durations, GPAs, organisation and institution
 *      names, and skills are extracted from the draft and compared to the evidence. These
 *      are the highest-consequence errors and the ones a model is least reliable at
 *      catching in its own output — "I worked there for two years" when the profile says
 *      three months is a factual claim with a right answer, not a judgement call. No API
 *      key required and fully testable, so the adversarial suite runs on every commit.
 *
 *   2. MODEL (draft.ts, advisory). Semantic claims the regexes cannot reach — "I led the
 *      migration" when the evidence says "helped with the migration". Layered on top of
 *      the deterministic pass, never instead of it. See `mergeModelVerdicts`.
 *
 * TWO FAILURE DIRECTIONS, weighted deliberately. A missed fabrication is worse than a
 * spurious flag — but only just. A guard that lights up every other sentence trains the
 * user to click through warnings, which destroys its value entirely. So each check below
 * fires only when it can point at something specific, and the checks that cannot be made
 * precise (durations with no named employer) are deliberately permissive.
 */
import type { ClaimVerdict } from '@ia/shared';
import type { Evidence } from './retrieve';
import { tokens } from './retrieve';

export interface Claim {
  text: string;
  span: { start: number; end: number };
}

export interface CheckedClaim {
  claim: string;
  span: { start: number; end: number };
  verdict: ClaimVerdict;
  /** Which evidence item supports it, when one does. */
  profileRef: string | null;
  /** The supporting evidence text, for the G3 evidence panel. */
  quote: string | null;
  /** Why it failed, in words the user can act on. */
  reason?: string;
  /** Which layer decided. Deterministic verdicts are not overridable by the model. */
  decidedBy: 'deterministic' | 'model';
}

// ─────────────────────────────────────────────── segmentation

/**
 * Sentence-level, with clause splitting only where punctuation makes coordination
 * unambiguous (`, and` / `, but` / `; then`). A bare "and" is left alone: splitting
 * "research and development" into two claims invents a fabrication that isn't there.
 * Under-splitting costs little — the deterministic checks scan the whole claim text
 * regardless of how it was cut, and only the lexical score gets diluted.
 */
export function splitClaims(text: string): Claim[] {
  const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
  const out: Claim[] = [];
  let offset = 0;

  for (const s of seg.segment(text)) {
    const sentence = s.segment;
    const base = text.indexOf(sentence, offset);
    if (base < 0) continue;
    offset = base + sentence.length;
    if (!/\p{L}/u.test(sentence)) continue;

    const parts = sentence.split(/[,;]\s+(?:and then|and also|and|but|then)\s+(?=\p{L})/giu);
    let local = 0;
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length < 12 || !/\p{L}/u.test(trimmed)) continue;
      const idx = sentence.indexOf(trimmed, local);
      local = idx + trimmed.length;
      out.push({ text: trimmed, span: { start: base + idx, end: base + idx + trimmed.length } });
    }
  }
  return out;
}

// ─────────────────────────────────────────────── normalisation

/** Lowercase, strip corporate and academic suffixes, collapse to comparable words. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|university|college|school)\b\.?/g, ' ')
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-boundary containment over normalised text. Stops "rust" matching "trust". */
function containsPhrase(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/** Months between two YYYY-MM values. */
function monthsBetween(start: string, end: string): number {
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  if (!sy || !sm || !ey || !em) return 0;
  return Math.max(0, (ey - sy) * 12 + (em - sm));
}

function nowYearMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────── atom extraction

export interface DurationClaim {
  months: number;
  raw: string;
}

/** "for two years", "over 18 months", "a three-month internship". */
export function extractDurations(text: string): DurationClaim[] {
  const out: DurationClaim[] = [];
  const re =
    /\b(?:for|over|across|spent|nearly|almost|about|around)?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]*(year|yr|month|mo|week)s?\b/gi;

  for (const m of text.matchAll(re)) {
    const rawN = m[1]!.toLowerCase();
    const n = /^\d+$/.test(rawN) ? Number(rawN) : (NUMBER_WORDS[rawN] ?? 0);
    if (n <= 0) continue;
    const unit = m[2]!.toLowerCase();
    const months = unit.startsWith('y') ? n * 12 : unit.startsWith('w') ? n / 4.345 : n;
    out.push({ months, raw: m[0].trim() });
  }
  return out;
}

export function extractGpas(text: string): number[] {
  const out: number[] = [];
  // "GPA: 3.62", "my GPA is a 3.9"
  for (const m of text.matchAll(/\bgpa\b[^0-9]{0,12}(\d(?:\.\d{1,2})?)/gi)) out.push(Number(m[1]));
  // "3.9 GPA", "3.9 cumulative GPA" — the number can lead.
  for (const m of text.matchAll(/\b(\d\.\d{1,2})\s+(?:\w+\s+){0,2}gpa\b/gi)) out.push(Number(m[1]));
  // "3.45/4.0", "3.45 out of 4"
  for (const m of text.matchAll(/\b(\d\.\d{1,2})\s*(?:\/|out of)\s*(?:4|4\.0|5|5\.0)\b/gi)) {
    out.push(Number(m[1]));
  }
  return [...new Set(out)];
}

/**
 * Capitalised words that are not proper nouns. Only ones that plausibly open a sentence
 * or follow a comma need to be here — mid-sentence capitals in English prose are
 * overwhelmingly names.
 */
const COMMON_CAPITALS = new Set(
  (
    'i we my our the a an this that it they he she there here his her its ' +
    'and but or so if then now yet also still just when while where because since ' +
    'after before during although though however whether what how why which who ' +
    'last next every each most both one two three four five several many some ' +
    'working building learning studying writing given having being doing using ' +
    'january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday ' +
    'summer spring fall autumn winter today yesterday tomorrow ' +
    'instead rather besides meanwhile later once twice often sometimes always never ' +
    'perhaps maybe within without between among across over under ' +
    // Contraction stems: what "Don't" or "Wasn't" reduces to once its tail is removed by
    // `withoutTail`. Without these a negated sentence opener reads as a company name.
    'do does did don doesn didn won couldn shouldn wouldn isn aren wasn weren haven ' +
    'hasn hadn let'
  ).split(' '),
);

const NAME_RUN = /\b[A-Z][\w&.'-]*(?:\s+(?:of\s+)?[A-Z][\w&.'-]*){0,3}/g;

/**
 * Trailing punctuation belongs to the sentence, not the name. Without this, a name at the
 * end of a sentence arrives as "TypeScript." and matches nothing on the profile — which
 * looks exactly like a fabrication.
 */
const trimEdges = (w: string): string => w.replace(/^[.'&-]+/, '').replace(/[.'&-]+$/, '');

/**
 * The word without its contraction or possessive tail.
 *
 * Two bugs lived here, and the first was severe. `normalize` turns an apostrophe into a
 * space, so "I've" became "i ve" — which is not in COMMON_CAPITALS, so it was treated as
 * a proper noun, found nowhere on the profile, and marked `unsupported`. That is a
 * BLOCKING verdict: any answer that opened "I've been writing Python since..." could not
 * be approved at G3. Naturally written prose was the failure case.
 *
 * The second is quieter but wrong in the other direction: "Google's search team" gave
 * "google s", which matches no employer, so a genuine fabrication about a real company
 * could be reported against the wrong name. Taking the head of the word fixes both.
 */
const withoutTail = (w: string): string => w.replace(/[’'](s|ve|m|re|ll|d|t)?$/i, '');

/**
 * Names in the shape of an employer, school, product, or technology.
 *
 * Ordinary capitalised words are peeled off either end of a run, so "Working at Acme
 * Analytics" yields "Acme Analytics" rather than a run that matches nothing.
 */
export function extractProperNouns(text: string): string[] {
  const out = new Set<string>();

  for (const m of text.matchAll(NAME_RUN)) {
    let words = m[0].split(/\s+/);

    // A lone -ly word opening a sentence is a sentence adverb: "Honestly, I..." /
    // "Eventually I...". This does mean a company whose name ends in -ly gets missed at
    // position 0 — accepted, because the alternative flags a stock English opener in
    // every other draft, and the same name is still caught anywhere else in the sentence.
    if (m.index === 0 && words.length === 1 && /ly$/i.test(trimEdges(words[0]!))) continue;

    // Contraction and possessive tails come off before the ordinary-word check, or
    // "I've" survives it as a name. See `withoutTail`.
    words = words.map(withoutTail);

    while (words.length > 0 && COMMON_CAPITALS.has(normalize(words[0]!))) words = words.slice(1);
    while (words.length > 0 && COMMON_CAPITALS.has(normalize(words[words.length - 1]!))) {
      words = words.slice(0, -1);
    }

    const name = words.map(trimEdges).filter(Boolean).join(' ').trim();
    if (name.length > 2 && normalize(name).length > 1) out.add(name);
  }
  return [...out];
}

/** Technologies presented as things the writer has used. */
export function extractClaimedSkills(text: string): string[] {
  const out = new Set<string>();
  const re =
    /\b(?:using|used|use|with|in|built\s+(?:in|with)|written\s+in|experience\s+(?:in|with)|proficient\s+(?:in|with)|familiar\s+with|worked\s+(?:in|with))\s+([A-Z][\w+#.]*)/g;
  for (const m of text.matchAll(re)) {
    const s = trimEdges(m[1]!);
    if (s.length > 1 && !COMMON_CAPITALS.has(normalize(s))) out.add(s);
  }
  return [...out];
}

// ─────────────────────────────────────────────── deterministic pass

const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|me|my|mine|we|we've|our)\b/i;

/**
 * A duration only means "how long I did this" when the sentence is about doing
 * something. Without this, "I've followed Acme for ten years" gets measured against an
 * internship and flagged as inflated.
 */
const DURATION_CONTEXT =
  /\b(work(?:ed|ing|s)?|intern(?:ed|ing|ship)?|spent|studi(?:ed|es|ing)|experience|employ(?:ed|ment)|role|position|job|tenure|program(?:med|ming)|cod(?:ed|ing)|develop(?:ed|ing|ment)|build(?:ing)?|built|us(?:ed|ing)|writing|wrote|led|ran|taught|research(?:ed|ing)?)\b/i;

/**
 * Sentences of intent or feeling rather than fact. Only consulted when the sentence
 * contains nothing checkable at all — see `isVerifiableClaim`.
 */
const OPINION_MARKER =
  /\b(want|wanted|hope|hoping|wish|would love|would like|excited|eager|interested|drawn to|passionate|believe|think|feel|admire|appreciate|curious|looking forward|aim to|plan to|goal|attracted)\b/i;

/**
 * "I <did> <something>" — an assertion that the writer performed an act.
 *
 * This is the gate on whether weak lexical support is allowed to BLOCK. Low overlap on
 * "I wrote a distributed key-value store" is a fabricated project and has to be red. Low
 * overlap on "It was not glamorous work" is a person describing how a job felt, and
 * flagging that red teaches the user to ignore the guard — which is the one outcome that
 * makes every other check here worthless. Evaluative and copular sentences get amber.
 */
const ACTION_CLAIM =
  /\b(?:i|we)\s+(?:\w+ly\s+)?(?:have\s+|had\s+|also\s+)?(?:built|wrote|created|designed|developed|led|managed|shipped|launched|implemented|architected|founded|ran|organized|organised|published|presented|won|earned|received|completed|deployed|maintained|migrated|automated|scaled|reduced|increased|improved|taught|tutored|mentored|interned|worked|studied|researched|analyzed|analysed|tested|debugged|refactored|optimized|optimised|contributed|coded|programmed)\b/i;

export interface DeterministicResult {
  verdict: ClaimVerdict | null;
  reason?: string;
  profileRef?: string;
  quote?: string;
}

/**
 * Returns a verdict only when it can prove something. `null` means "nothing checkable
 * here" and defers to the lexical pass — silence is never approval.
 */
export function checkClaimDeterministically(
  claim: string,
  evidence: Evidence[],
): DeterministicResult {
  const normEvidence = normalize(evidence.map((e) => e.text).join(' \n '));

  // Names the profile actually contains, from its structured fields.
  const knownNames = new Set<string>();
  for (const e of evidence) {
    for (const n of [e.facts.organization, e.facts.institution, e.facts.title]) {
      const norm = n ? normalize(n) : '';
      if (norm) knownNames.add(norm);
    }
  }

  const claimedNames = extractProperNouns(claim)
    .map((raw) => ({ raw, norm: normalize(raw) }))
    .filter((n) => n.norm.length > 1);

  // ── durations. "Two years" against a three-month internship is the classic inflation.
  const durations = extractDurations(claim);
  if (durations.length > 0 && FIRST_PERSON.test(claim) && DURATION_CONTEXT.test(claim)) {
    const dated = evidence
      .filter((e) => e.facts.startDate)
      .map((e) => ({
        ref: e.ref,
        text: e.text,
        months: monthsBetween(e.facts.startDate!, e.facts.endDate ?? nowYearMonth()),
        names: [e.facts.organization, e.facts.institution, e.facts.title]
          .filter((v): v is string => Boolean(v))
          .map(normalize),
      }));

    // Scope to the entity the claim names, when it names one the profile knows. An
    // unscoped claim is measured against the longest span on the profile — permissive on
    // purpose, since "three years of Python" isn't tied to any single entry.
    const scoped = dated.filter((d) =>
      claimedNames.some((c) => d.names.some((n) => n === c.norm || n.includes(c.norm))),
    );
    const pool = scoped.length > 0 ? scoped : dated;

    if (pool.length > 0) {
      const longest = pool.reduce((x, y) => (y.months > x.months ? y : x));
      // 25% plus a month of slack — people round honestly, and everyone calls a ten-week
      // internship "three months".
      const ceiling = Math.max(longest.months * 1.25, longest.months + 1);
      const over = durations.find((d) => d.months > ceiling);
      if (over) {
        return {
          verdict: 'overstated',
          reason:
            `The draft says "${over.raw}". The longest matching entry on your profile is ` +
            `about ${Math.round(longest.months)} month${Math.round(longest.months) === 1 ? '' : 's'}.`,
          profileRef: longest.ref,
          quote: longest.text,
        };
      }
    }
  }

  // ── GPA. A number with exactly one right answer.
  const gpas = extractGpas(claim);
  if (gpas.length > 0) {
    const known = evidence.filter((e) => e.facts.gpa).map((e) => ({ ref: e.ref, ...e.facts.gpa! }));
    if (known.length === 0) {
      return {
        verdict: 'unsupported',
        reason: 'The draft states a GPA, but there is no GPA on your profile to check it against.',
      };
    }
    const wrong = gpas.find((g) => !known.some((k) => Math.abs(k.value - g) < 0.005));
    if (wrong !== undefined) {
      const k = known[0]!;
      return {
        verdict: 'unsupported',
        reason: `The draft says GPA ${wrong}; your profile says ${k.value} on a ${k.scale}-point scale.`,
        profileRef: k.ref,
      };
    }
  }

  // ── organisations, schools, products. The invented-employer case.
  for (const { raw, norm } of claimedNames) {
    const known = [...knownNames].some((k) => k === norm || k.includes(norm) || norm.includes(k));
    if (!known && !containsPhrase(normEvidence, norm)) {
      return {
        verdict: 'unsupported',
        reason: `"${raw}" does not appear anywhere on your profile.`,
      };
    }
  }

  // ── skills claimed but not held.
  const heldSkills = new Set(evidence.flatMap((e) => (e.facts.skills ?? []).map(normalize)));
  for (const raw of extractClaimedSkills(claim)) {
    const norm = normalize(raw);
    if (norm.length < 2) continue;
    if (!heldSkills.has(norm) && !containsPhrase(normEvidence, norm)) {
      return {
        verdict: 'unsupported',
        reason: `The draft claims experience with "${raw}", which is not on your profile.`,
      };
    }
  }

  return { verdict: null };
}

/**
 * True when the sentence asserts something about the writer's history.
 *
 * Motivation and interest ("I'd like to work on developer tooling") cannot have profile
 * evidence and are not claims. Those are skipped rather than flagged — but only when the
 * sentence contains nothing checkable at all, so a fabrication cannot hide behind an
 * opinion frame: "I'd love to bring the Rust experience I gained at Google" still has a
 * name and a skill in it, and still gets checked.
 */
export function isVerifiableClaim(claim: string): boolean {
  const hasAtoms =
    extractProperNouns(claim).length > 0 ||
    extractDurations(claim).length > 0 ||
    extractGpas(claim).length > 0 ||
    extractClaimedSkills(claim).length > 0 ||
    /\d/.test(claim);
  if (hasAtoms) return true;
  return !OPINION_MARKER.test(claim);
}

// ─────────────────────────────────────────────── lexical support

/**
 * How much of the claim's content is traceable to the evidence set at all. Coverage is
 * measured against the union of the evidence — a claim may legitimately draw on two
 * facts — while `ref` points at whichever single item contributed most, since that is
 * what the G3 panel shows beside the highlight.
 */
function supportFor(
  claim: string,
  evidence: Evidence[],
): { ref: string; text: string; coverage: number } | null {
  const claimTokens = [...new Set(tokens(claim))];
  if (claimTokens.length === 0 || evidence.length === 0) return null;

  const perItem = evidence.map((e) => ({ e, set: new Set(tokens(e.text)) }));
  const union = new Set(perItem.flatMap((p) => [...p.set]));
  const coverage = claimTokens.filter((t) => union.has(t)).length / claimTokens.length;

  let best = perItem[0]!;
  let bestHits = -1;
  for (const p of perItem) {
    const hits = claimTokens.filter((t) => p.set.has(t)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = p;
    }
  }
  return { ref: best.e.ref, text: best.e.text, coverage };
}

export interface GuardResult {
  claims: CheckedClaim[];
  /** Red verdicts. A non-empty list blocks approval at G3. */
  blocking: CheckedClaim[];
  summary: { supported: number; inferred: number; unsupported: number; overstated: number };
}

function summarize(claims: CheckedClaim[]): GuardResult {
  const count = (v: ClaimVerdict): number => claims.filter((c) => c.verdict === v).length;
  return {
    claims,
    blocking: claims.filter((c) => c.verdict === 'unsupported' || c.verdict === 'overstated'),
    summary: {
      supported: count('supported'),
      inferred: count('inferred'),
      unsupported: count('unsupported'),
      overstated: count('overstated'),
    },
  };
}

/**
 * The deterministic pass. Always runs, needs no API key, and its rejections are final.
 */
export function guardDraft(draft: string, evidence: Evidence[]): GuardResult {
  const checked: CheckedClaim[] = [];

  for (const c of splitClaims(draft)) {
    const det = checkClaimDeterministically(c.text, evidence);
    if (det.verdict) {
      checked.push({
        claim: c.text,
        span: c.span,
        verdict: det.verdict,
        profileRef: det.profileRef ?? null,
        quote: det.quote ?? null,
        reason: det.reason,
        decidedBy: 'deterministic',
      });
      continue;
    }

    // Nothing provably wrong. If there is also nothing to verify, it isn't a claim.
    if (!isVerifiableClaim(c.text)) continue;

    const support = supportFor(c.text, evidence);
    const coverage = support?.coverage ?? 0;

    // Weak overlap only turns red for a claim that asserts an act. Anything else stays
    // amber: the lexical layer is a heuristic, and heuristics do not get to hard-block.
    const verdict: ClaimVerdict =
      coverage >= 0.5
        ? 'supported'
        : coverage >= 0.25 || !ACTION_CLAIM.test(c.text)
          ? 'inferred'
          : 'unsupported';

    checked.push({
      claim: c.text,
      span: c.span,
      verdict,
      profileRef: verdict === 'unsupported' ? null : (support?.ref ?? null),
      quote: verdict === 'unsupported' ? null : (support?.text ?? null),
      reason:
        verdict === 'unsupported'
          ? 'Nothing in the retrieved evidence backs this up. Rewrite it, or add the fact to your profile.'
          : coverage < 0.25
            ? 'Only loosely tied to your profile. Worth a second read before you approve it.'
            : undefined,
      decidedBy: 'deterministic',
    });
  }

  return summarize(checked);
}

/**
 * Merges model verdicts into a deterministic result.
 *
 * The model may DOWNGRADE a claim — spot a semantic overstatement the regexes missed —
 * but may never UPGRADE one the deterministic layer rejected. A model that talks itself
 * out of a caught fabrication is precisely the failure this design exists to prevent.
 */
export function mergeModelVerdicts(
  base: GuardResult,
  modelVerdicts: Array<{ claim: string; verdict: ClaimVerdict; reason?: string }>,
): GuardResult {
  const SEVERITY: Record<ClaimVerdict, number> = {
    supported: 0,
    inferred: 1,
    overstated: 2,
    unsupported: 3,
  };

  return summarize(
    base.claims.map((c) => {
      const m = modelVerdicts.find((v) => v.claim.trim() === c.claim.trim());
      if (!m || SEVERITY[m.verdict] <= SEVERITY[c.verdict]) return c;
      return {
        ...c,
        verdict: m.verdict,
        reason: m.reason ?? c.reason,
        decidedBy: 'model' as const,
      };
    }),
  );
}
