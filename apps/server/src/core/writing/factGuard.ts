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
 *   2. MODEL (advisory) — BUILT AND TESTED, BUT NOT WIRED IN. Semantic claims the regexes
 *      cannot reach: "I led the migration" when the evidence says "helped with the
 *      migration". `mergeModelVerdicts` below implements the merge policy — the model may
 *      downgrade a verdict, never clear one — and the adversarial suite covers it, but no
 *      production path calls it. Neither `draftAnswer` nor the G3 route produces model
 *      verdicts today, so nothing at runtime ever emits a claim with decidedBy: 'model'.
 *
 *      Said plainly because the alternative is a comment that describes a check the user
 *      is relying on and that does not run: semantic overstatement is caught by the human
 *      at G3 and by nothing else. docs/06 and docs/11 say the same.
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
  return (
    s
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\b(inc|llc|ltd|corp|corporation|co|university|college|school)\b\.?/g, ' ')
      // A possessive before the punctuation strip, or after it. The claim side strips
      // "Dean's" down to "dean" when it extracts proper nouns, while this side turned the
      // same word into "dean s" — and that orphaned letter meant "Dean's List" from a
      // draft could never be found inside "Dean's List Semi-Finalist" from the profile,
      // so a true sentence about the user's own award was blocked as an invented name.
      // Both sides now shed the possessive the same way.
      .replace(/'s\b/g, '')
      .replace(/[^a-z0-9+#.]+/g, ' ')
      .replace(/\b[s]\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The forms of a phrase that differ only in the number of its last word: "rest api" and
 * "rest apis", "library" and "libraries". Every other word is left exactly as written.
 */
function inflections(phrase: string): string[] {
  const cut = phrase.lastIndexOf(' ');
  const head = cut < 0 ? '' : phrase.slice(0, cut + 1);
  const last = phrase.slice(cut + 1);
  const forms = new Set([last, `${last}s`, `${last}es`]);
  if (last.endsWith('s')) forms.add(last.slice(0, -1));
  if (last.endsWith('es')) forms.add(last.slice(0, -2));
  if (last.endsWith('ies')) forms.add(`${last.slice(0, -3)}y`);
  if (last.endsWith('y')) forms.add(`${last.slice(0, -1)}ies`);
  return [...forms].filter((f) => f.length > 0).map((f) => head + f);
}

/**
 * Word-boundary containment over normalised text. Stops "rust" matching "trust".
 *
 * A trailing plural is not a different fact. A profile whose skills list said "REST APIs"
 * did not support a draft that said "a REST API", so the user was blocked at G3 by a
 * message telling them "REST API" does not appear anywhere on their profile — untrue, about
 * a term one character away, on a screen with no override, and the only remedy it offered
 * (add the fact to your profile) had already been done. The rule is that only the LAST word
 * of a phrase is allowed to differ, and only in its number, singular or plural, whichever
 * side carries the ending.
 */
function containsPhrase(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const hay = ` ${haystack} `;
  return inflections(needle).some((f) => hay.includes(` ${f} `));
}

/**
 * Spelled-out counts, through ninety.
 *
 * This used to stop at twelve, which made the guard avoidable by anyone who writes numbers
 * out: "I worked at Kestrel Analytics for 20 years" was caught and blocked, while the same
 * sentence written "for twenty years" produced no duration at all, came back amber, and
 * was approvable at G3. The magnitudes worth inventing were exactly the ones missing.
 */
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
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * The compound form first, so "twenty-five years" is read as twenty-five rather than as a
 * bare "five" with the tens word left behind; then every single word longest-first, so
 * "seventeen" is not read as "seven" trailing a stray "teen".
 *
 * The digit branch carries its decimal tail for the same reason, and this one was worse.
 * "I worked in the lab for 2.5 years" matched at the word boundary between the dot and the
 * five, so a true sentence about a thirty-month job came back red at G3 saying: the draft
 * says "5 years". The user cannot find "5 years" in their draft, because they never wrote
 * it, and there is no override on that screen. It failed the other way round just as
 * quietly — "20.5 years" against a five-year entry also read as five, matched the profile,
 * and was waved through. The rule is that a number and its fractional part are one count,
 * never two, so nothing may be read as a count when a digit or a decimal point sits
 * directly in front of it.
 */
const COUNT_PATTERN = [
  String.raw`\d{1,2}(?:\.\d+)?`,
  String.raw`(?:${TENS.join('|')})[\s-](?:${ONES.join('|')})`,
  ...Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length),
].join('|');

/** Digits verbatim; words summed, so "twenty-five" is 25 rather than 20 or 5. */
function countOf(raw: string): number {
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw
    .toLowerCase()
    .split(/[\s-]+/)
    .reduce((sum, w) => sum + (NUMBER_WORDS[w] ?? 0), 0);
}

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

/**
 * "for two years", "over 18 months", "a three-month internship".
 *
 * The trailing "old" is excluded because an age is not a duration of work. Without that,
 * "I'm 19 years old and have been coding since high school" measured nineteen years
 * against the longest entry on the profile and came back red — "The draft says 19 years.
 * The longest matching entry on your profile is about 44 months." — on a sentence that is
 * both true and the most ordinary thing a student can write. The hyphenated adjective
 * ("as a 19-year-old sophomore") failed the same way, which is why the lookahead allows
 * for a hyphen as well as a space.
 */
export function extractDurations(text: string): DurationClaim[] {
  const out: DurationClaim[] = [];
  const re = new RegExp(
    String.raw`\b(?:for|over|across|spent|nearly|almost|about|around)?\s*(?<![\d.])(${COUNT_PATTERN})` +
      String.raw`[\s-]*(year|yr|month|mo|week)s?\b(?![\s-]*old\b)`,
    'gi',
  );

  for (const m of text.matchAll(re)) {
    const n = countOf(m[1]!);
    if (n <= 0) continue;
    const unit = m[2]!.toLowerCase();
    const months = unit.startsWith('y') ? n * 12 : unit.startsWith('w') ? n / 4.345 : n;
    out.push({ months, raw: m[0].trim() });
  }
  return out;
}

/** The denominator of "3.62/4.0" or "3.62 out of 4", and the tail of "on a 4.0 scale". */
const GPA_SCALE_TAIL = /\b(\d\.\d{1,2})\s*(?:\/|out of)\s*(?:4|4\.0|5|5\.0)\b/gi;
const GPA_SCALE_PHRASE = /\bon\s+a\s+\d(?:\.\d{1,2})?[\s-]*(?:point\s*)?scale\b/gi;

/**
 * Nouns that make a nearby whole number a count of something rather than a grade. "GPA
 * (last 2 years): 3.4" and "My GPA in my last 2 years was 3.4" both used to hand back the
 * 2 — the first number within twelve characters of the label — and the user was blocked at
 * G3 with "The draft says GPA 2; your profile says 3.4", which is not a sentence they can
 * act on because they never claimed a GPA of 2.
 */
const COUNT_NOUN_TAIL =
  /^\s*(?:year|semester|quarter|term|month|week|credit|hour|course|class)e?s?\b/i;

/** A grade, not an SAT score or a year: one leading digit, or any decimal under ten. */
const isGradeShaped = (token: string): boolean =>
  token.includes('.') ? Number(token) < 10 : token.length === 1;

/**
 * Every number this returns is a GPA the draft CLAIMS, so a scale must never come back.
 *
 * The scale is blanked out — padded with spaces, so no other match shifts — before the two
 * value-reading patterns run. Without that, "I graduated with a 3.62/4.0 GPA" hands the
 * number-leading pattern a clean "4.0 GPA" on the far side of the slash, and the draft
 * reads as claiming a 4.0 alongside the 3.62. That used to be papered over at comparison
 * time by treating the scale as an acceptable value, which exempted it everywhere rather
 * than only where it was a denominator: an invented "I hold a perfect 4.0 GPA" on a 3.62
 * profile came back green, with the profile line that says 3.62 attached beside it as its
 * supporting quote. On a 4.0 scale that was the one wrong GPA the guard let through, and
 * it is the one a person inflating their record would actually type.
 */
export function extractGpas(text: string): number[] {
  const out: number[] = [];
  const masked = text
    .replace(GPA_SCALE_TAIL, (m, value: string) => value.padEnd(m.length, ' '))
    .replace(GPA_SCALE_PHRASE, (m) => ' '.repeat(m.length));

  // "GPA: 3.62", "my GPA is a 3.9", "GPA (last 2 years): 3.4". Read forward to the end of
  // the clause and take the first number that can be a grade, rather than the first number
  // full stop — a count of years or semesters routinely sits between the label and the
  // value, and skipping it also stops the real GPA behind it from going unchecked.
  for (const label of masked.matchAll(/\bgpa\b/gi)) {
    const from = label.index + label[0].length;
    const window = masked.slice(from, from + 40).split(/[.!?;](?=\s|$)/)[0]!;
    for (const n of window.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
      if (!isGradeShaped(n[0])) continue;
      if (!n[0].includes('.') && COUNT_NOUN_TAIL.test(window.slice(n.index + n[0].length)))
        continue;
      out.push(Number(n[0]));
      break;
    }
  }
  // "3.9 GPA", "3.9 cumulative GPA", "3.968 weighted GPA" — the number can lead. Three
  // decimals, because transcripts print three: while this read two, "I have a 3.968 GPA"
  // extracted nothing at all, so the guard neither confirmed the true figure nor caught an
  // invented one — the number most worth checking was the one shape it could not see.
  for (const m of masked.matchAll(/\b(\d\.\d{1,3})\s+(?:\w+\s+){0,2}gpa\b/gi))
    out.push(Number(m[1]));
  // "3.45/4.0", "3.45 out of 4" — the numerator only, read from the unmasked text.
  for (const m of text.matchAll(GPA_SCALE_TAIL)) out.push(Number(m[1]));
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

    // Contraction, possessive and punctuation tails come off before the ordinary-word
    // check, or "I've" survives it as a name (see `withoutTail`) and so does any ordinary
    // word ending a sentence: "I started there in June." reached the check as "June." —
    // which is not in the list below — and was reported as an invented organisation.
    words = words.map((w) => trimEdges(withoutTail(w)));

    let peeledFromFront = 0;
    while (words.length > 0 && COMMON_CAPITALS.has(normalize(words[0]!))) {
      words = words.slice(1);
      peeledFromFront++;
    }
    while (words.length > 0 && COMMON_CAPITALS.has(normalize(words[words.length - 1]!))) {
      words = words.slice(0, -1);
    }

    // A lone capitalised word that opens the sentence is not a name. English capitalises
    // the first word of every sentence, so "Growing up, I fixed computers for my
    // neighbours" arrived as a claim about an employer called Growing, matched nothing on
    // the profile, and could not be approved at G3 — where there is no override. The words
    // that can open a sentence are the whole language, so the list below was never going
    // to finish: Getting, Debugging, Throughout, Beyond, Nothing, Everything and hundreds
    // more each blocked an honest draft. Checked after the peel, because "Everything I
    // know about SQL" is a two-word run that becomes the same lone opener once the "I"
    // comes off, and only when nothing was peeled off the FRONT, since "The Learning
    // Center" leaves a word that is not the one the sentence started with.
    //
    // What this gives up: a one-word employer mentioned ONLY as the first word of a
    // sentence. A real name almost always arrives as a multi-word run ("Kestrel
    // Analytics") or sits somewhere other than position 0 ("a team of six at Palantir"),
    // and both are still caught.
    if (m.index === 0 && peeledFromFront === 0 && words.length === 1) continue;

    const name = words.filter(Boolean).join(' ').trim();
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

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * "I interned at Acme", "I worked for Acme", "I spent two years at Acme" — the writer
 * placing their own history inside an organisation.
 *
 * Every verb here is past tense, and the only prepositions accepted are "at" and "for",
 * because the sentences this must NOT match are the ordinary content of a why-this-company
 * answer: "I want to intern at Acme", "I would love to work for Acme", "I have admired
 * Acme for years", "I worked with the Acme API on a side project". Those are wishes and
 * mentions, not claims of employment.
 */
/**
 * The verb list is what decides whether a bare acronym is an employer or a technology, so
 * it has to cover how people actually write about a job.
 *
 * Seven past-tense verbs was too narrow in both tense and vocabulary. "I am interning at
 * NCSA", "my internship at NASA", "I spent last summer at JPL" and "during my time at
 * MITRE" are all employment claims about an all-caps name, and every one of them slipped
 * the frame and was waved through unchecked — which is the direction that matters, because
 * this branch exists to let a technology past and a fabricated employer must not ride
 * along with it. The present and continuous forms and the noun forms are here for that
 * reason; "I deployed it to AWS" still names no affiliation and is still left alone.
 */
const affiliationFrame = (name: string): RegExp =>
  new RegExp(
    String.raw`(?:\b(?:i|we)\b[\w\s,'’-]{0,30}?\b(?:intern(?:ed|ing|s)?|work(?:ed|ing|s)?|stud(?:ied|ying|y)|spent|spend(?:ing)?|join(?:ed|ing)?|serv(?:ed|ing)?|hired|employed|volunteer(?:ed|ing)?|apprenticed)\b|\b(?:my|our)\b[\w\s,'’-]{0,20}?\b(?:internship|apprenticeship|fellowship|placement|role|position|job|time|tenure|summer|semester)\b)` +
      String.raw`[\w\s,'’-]{0,25}?\b(?:at|for|with)\s+` +
      escapeRegExp(name),
    'i',
  );

/**
 * A run made only of short all-caps words: API, CSV, SQL, REST API, HTTP.
 *
 * Written this way a name is as often a file format, a protocol or a language as it is an
 * employer, and nothing about the letters themselves can tell the two apart. Anything with
 * an ordinary word beside it — "IBM Research", "Kestrel Analytics" — is a name and does not
 * come through here.
 */
const isAcronymRun = (raw: string): boolean =>
  /^[A-Z][A-Z0-9]{1,4}(?:\s+[A-Z][A-Z0-9]{1,4})*$/.test(raw);

export interface DeterministicResult {
  verdict: ClaimVerdict | null;
  reason?: string;
  profileRef?: string;
  quote?: string;
}

/**
 * Returns a verdict only when it can prove something. `null` means "nothing checkable
 * here" and defers to the lexical pass — silence is never approval.
 *
 * `contextNames` are the company being applied to and the title of the role. The answer is
 * allowed to NAME them even though they are nowhere on the profile. Without that, every
 * answer that mentioned the employer it was addressed to came back with a blocking
 * `"Stripe" does not appear anywhere on your profile` — and naming the company is the most
 * ordinary thing a "why this company" answer can do. There is no override at G3, and the
 * only remedy that message leaves open is to put the company on the profile — which means
 * inventing a job there, the exact harm this file exists to prevent.
 *
 * Mentioning is all they buy. "I interned at Stripe" is still red, because that is a claim
 * about the writer's history and the profile does not contain it — see `affiliationFrame`.
 */
export function checkClaimDeterministically(
  claim: string,
  evidence: Evidence[],
  contextNames: string[] = [],
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

  // Names the application supplies. Kept apart from the profile's own, because they are
  // mentionable but not claimable.
  const contextNorms = contextNames.map(normalize).filter((n) => n.length > 1);

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
    //
    // Whole words here too, for the same reason as the organisation check below: a bare
    // `includes` let a claim naming MIT scope itself to an entry at "Summit Labs" and take
    // that entry's ceiling.
    const scoped = dated.filter((d) =>
      claimedNames.some((c) => d.names.some((n) => n === c.norm || containsPhrase(n, c.norm))),
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
    // Every extracted number has to match a GPA the profile holds. The scale gets no
    // exemption here — "a perfect 4.0" against a 3.62 profile is a fabrication like any
    // other. It is `extractGpas` that keeps a denominator from ever arriving as a claim.
    //
    // The weighted figure counts as one the profile holds. A transcript line reading
    // "4.321 weighted, 3.968 unweighted" is two true numbers about one student, and while
    // only the unweighted one was consulted, writing the weighted one blocked approval at
    // G3 with a message insisting the profile said otherwise — about the higher number,
    // the one an applicant most wants to state.
    const wrong = gpas.find(
      (g) =>
        !known.some(
          (k) =>
            Math.abs(k.value - g) < 0.005 ||
            (k.weighted !== undefined && Math.abs(k.weighted - g) < 0.005),
        ),
    );
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
    // Whole words, never bare letters. This used to be a plain `includes` both ways, so any
    // invented employer whose spelling happened to swallow a short name from the profile
    // was accepted in silence: a student with MIT on their profile could write "I interned
    // at Smith Barney last summer" and the guard raised nothing, because "smith barney"
    // contains "mit". "Summit Consulting" passed the same way, "Metaphor Systems" passed on
    // a profile holding Meta, and "Sapient" on one holding SAP. Green ticks on fabricated
    // employers are the worst thing this file can produce, because G3 is where the user
    // decides they have nothing left to check.
    //
    // The rule: one name vouches for another only when it appears inside it as a whole
    // word.
    const matches = (pool: string[]): boolean =>
      pool.some(
        (k) =>
          k === norm ||
          // "Rutgers" standing in for "Rutgers Learning Center" — the profile's own entity,
          // shortened by the writer.
          containsPhrase(k, norm) ||
          // "MIT Media Lab" built out of "MIT" — a division of somewhere the writer really
          // is. Two-letter runs get no say here, because the profile's titles land in this
          // pool alongside its employers and a "TA" or an "RA" would otherwise vouch for
          // any company that happens to start with those letters as a word.
          (k.length > 2 && containsPhrase(norm, k)),
      );

    if (matches([...knownNames]) || containsPhrase(normEvidence, norm)) continue;

    // The company being applied to may be named freely, but not worked at.
    if (matches(contextNorms)) {
      if (!affiliationFrame(raw).test(claim)) continue;
      return {
        verdict: 'unsupported',
        reason:
          `"${raw}" is the employer you are applying to, and your profile has no ` +
          `experience there. Say what draws you to them instead.`,
      };
    }

    // A bare acronym counts as an organisation only when the sentence puts the writer
    // inside it. Without this, "It replaced a CSV export", "The HTTP layer was the easy
    // part" and "I wrote a REST API for the billing service" were each reported as an
    // invented organisation and each blocked approval at G3, where there is no override —
    // three true sentences that any engineer would write, about a format, a protocol and an
    // interface. "I interned at IBM" is still read as employment and still red; "I deployed
    // it to AWS" is not a claim about working at AWS and is left alone.
    if (isAcronymRun(raw) && !affiliationFrame(raw).test(claim)) continue;

    return {
      verdict: 'unsupported',
      reason: `"${raw}" does not appear anywhere on your profile.`,
    };
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
 *
 * `contextNames` is the company and role the answer is being written for — see
 * `checkClaimDeterministically`. Every caller that knows them has to pass them, and leaving
 * them out costs something different on each side. On the G3 path the answer comes back
 * with a blocking claim over the company's own name and there is no override, so the user
 * is stuck. On the drafting path the flags are recomputed later and never reach the screen,
 * but the draft still spends its one revision rewriting a sentence that was never wrong,
 * and whatever that revision traded away to lose the company name is what the user reads.
 */
export function guardDraft(
  draft: string,
  evidence: Evidence[],
  contextNames: string[] = [],
): GuardResult {
  const checked: CheckedClaim[] = [];

  for (const c of splitClaims(draft)) {
    const det = checkClaimDeterministically(c.text, evidence, contextNames);
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
