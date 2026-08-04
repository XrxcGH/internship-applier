/**
 * Measures a user's writing voice — docs/06 § Building the voice model.
 *
 * Plain text analysis, no model call. The metrics are the target that generated answers
 * are checked against in M5.
 *
 * The important one is sentence-length STANDARD DEVIATION. Uniform sentence length is the
 * single loudest tell of machine-generated prose, and almost nobody writes that way; the
 * mean on its own tells you very little.
 */
import type { StyleProfile } from '@ia/shared';

/**
 * Abbreviations whose trailing period is not a sentence end. `Intl.Segmenter` does not
 * handle these for English — it splits "I met Dr. Smith." into two sentences — which
 * inflates the sentence count and deflates mean sentence length. Since sentence length
 * and its variance are the headline metrics here, that error matters, so the periods are
 * masked before segmenting and restored afterwards.
 */
const TITLES = [
  'Dr',
  'Mr',
  'Mrs',
  'Ms',
  'Prof',
  'Sr',
  'Jr',
  'St',
  'Mt',
  'Rev',
  'Gen',
  'Sen',
  'Rep',
];

const AMBIGUOUS = [
  'vs',
  'etc',
  'approx',
  'est',
  'dept',
  'univ',
  'Inc',
  'Ltd',
  'Co',
  'Corp',
  'No',
  'Fig',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Jun',
  'Jul',
  'Aug',
  'Sept',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** A sentinel that cannot occur in real prose, used to hide non-terminal periods. */
const DOT = String.fromCharCode(0x0001);

/**
 * Titles are always followed by a name, so their period is never a sentence end — mask
 * unconditionally.
 */
const TITLE_RE = new RegExp(`\\b(${TITLES.join('|')})\\.`, 'g');

/**
 * Everything else is genuinely ambiguous: "Acme Inc. It is fine" ends a sentence, while
 * "5 in. of rain" does not. The workable signal is what follows — a capital letter starts
 * a new sentence, a lowercase one continues the current one. Mask only the latter.
 */
const AMBIGUOUS_RE = new RegExp(`\\b(${AMBIGUOUS.join('|')})\\.(?=\\s*[a-z,;:)])`, 'g');

/** Dotted initialisms: e.g., i.e., U.S., Ph.D. Same following-case rule. */
const INITIALISM_RE = /\b(?:[A-Za-z]\.){2,}(?=\s*[a-z,;:)])/g;

export function sentences(text: string): string[] {
  const masked = text
    .replace(INITIALISM_RE, (m) => m.replaceAll('.', DOT))
    .replace(TITLE_RE, (_, a: string) => `${a}${DOT}`)
    .replace(AMBIGUOUS_RE, (_, a: string) => `${a}${DOT}`);

  const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
  return [...seg.segment(masked)]
    .map((s) => s.segment.replaceAll(DOT, '.').trim())
    .filter((s) => s.length > 0 && /\p{L}/u.test(s));
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

const CONTRACTIONS =
  /\b\w+'(?:s|t|re|ve|ll|d|m)\b|\b(?:can't|won't|don't|isn't|aren't|wasn't|weren't|didn't|doesn't|haven't|hasn't|hadn't|shouldn't|wouldn't|couldn't)\b/gi;

const FIRST_PERSON = /\b(?:i|me|my|mine|myself|we|us|our|ours)\b/gi;

const HEDGES =
  /\b(?:maybe|perhaps|possibly|probably|might|somewhat|fairly|rather|arguably|i think|i believe|it seems|kind of|sort of|a bit|generally|typically|usually)\b/gi;

const TRANSITIONS = [
  'however',
  'but',
  'so',
  'and',
  'because',
  'although',
  'while',
  'though',
  'meanwhile',
  'still',
  'yet',
  'then',
  'also',
  'plus',
  'anyway',
  'furthermore',
  'moreover',
  'additionally',
  'consequently',
  'therefore',
  'thus',
  'nevertheless',
  'nonetheless',
];

/**
 * Rough frequency banding. A high share of long, low-frequency words reads formal; a
 * high share of short common words reads plain.
 */
const COMMON_WORDS = new Set(
  (
    'the be to of and a in that have i it for not on with he as you do at this but his by from ' +
    'they we say her she or an will my one all would there their what so up out if about who get ' +
    'which go me when make can like time no just him know take people into year your good some ' +
    'could them see other than then now look only come its over think also back after use two how ' +
    'our work first well way even new want because any these give day most us'
  ).split(' '),
);

function vocabularyTier(ws: string[]): StyleProfile['vocabularyTier'] {
  if (ws.length === 0) return 'plain';
  const uncommonLong = ws.filter((w) => w.length >= 8 && !COMMON_WORDS.has(w)).length / ws.length;
  if (uncommonLong > 0.14) return 'formal';
  if (uncommonLong > 0.07) return 'mixed';
  return 'plain';
}

export interface SampleInput {
  id: string;
  content: string;
}

export function computeStyleProfile(samples: SampleInput[], now = new Date()): StyleProfile {
  const text = samples.map((s) => s.content).join('\n\n');
  const ws = words(text);
  const sents = sentences(text);
  const lengths = sents.map((s) => words(s).length).filter((n) => n > 0);
  const per100 = (n: number) => (ws.length === 0 ? 0 : round((n / ws.length) * 100));

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const transitionCounts = TRANSITIONS.map((t) => ({
    t,
    n: (text.toLowerCase().match(new RegExp(`\\b${t}\\b`, 'g')) ?? []).length,
  }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);

  const listLines = text.split('\n').filter((l) => /^\s*(?:[-*•]|\d+[.)])\s/.test(l)).length;
  const totalLines = Math.max(1, text.split('\n').length);
  const listRatio = listLines / totalLines;

  return {
    meanSentenceLength: round(lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length)),
    sentenceLengthStdev: round(stdev(lengths)),
    contractionRate: per100((text.match(CONTRACTIONS) ?? []).length),
    firstPersonRate: per100((text.match(FIRST_PERSON) ?? []).length),
    vocabularyTier: vocabularyTier(ws),
    punctuation: {
      emDash: per100((text.match(/—|--/g) ?? []).length),
      semicolon: per100((text.match(/;/g) ?? []).length),
      parenthetical: per100((text.match(/\(/g) ?? []).length),
      exclamation: per100((text.match(/!/g) ?? []).length),
    },
    paragraphMeanSentences: round(
      paragraphs.length === 0
        ? 0
        : paragraphs.map((p) => sentences(p).length).reduce((a, b) => a + b, 0) / paragraphs.length,
    ),
    listUsage: listRatio > 0.15 ? 'common' : listRatio > 0.02 ? 'rare' : 'never',
    favoredTransitions: transitionCounts.slice(0, 6).map((x) => x.t),
    hedgeRate: per100((text.match(HEDGES) ?? []).length),
    openingPatterns: sents
      .slice(0, 12)
      .map((s) => words(s).slice(0, 3).join(' '))
      .filter(Boolean),
    sampleIds: samples.map((s) => s.id),
    computedAt: now.toISOString(),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** How much material we have, so the UI can say "enough" rather than showing a raw count. */
export function sampleAdequacy(totalWords: number): {
  level: 'none' | 'thin' | 'enough' | 'plenty';
  message: string;
} {
  if (totalWords === 0) {
    return {
      level: 'none',
      message:
        'No samples yet. Without them, drafts use a neutral voice and will need heavier editing.',
    };
  }
  if (totalWords < 300) {
    return {
      level: 'thin',
      message: `${totalWords} words. Enough to start, but 300+ makes the voice match noticeably better.`,
    };
  }
  if (totalWords < 1000) {
    return { level: 'enough', message: `${totalWords} words — enough to measure your voice.` };
  }
  return { level: 'plenty', message: `${totalWords} words — plenty.` };
}

/** Plain-language description of the measured voice, shown back to the user. */
export function describeStyle(p: StyleProfile): string[] {
  const out: string[] = [];

  out.push(
    p.sentenceLengthStdev > 7
      ? `You vary sentence length a lot (averaging ${p.meanSentenceLength} words, but swinging by ${p.sentenceLengthStdev}). That variation is the hardest thing for generated text to imitate, and the most valuable thing here.`
      : `Your sentences stay fairly even in length (about ${p.meanSentenceLength} words, varying by ${p.sentenceLengthStdev}).`,
  );

  if (p.contractionRate > 1.5) out.push("You use contractions freely — don't, it's, I've.");
  else if (p.contractionRate < 0.3)
    out.push('You rarely use contractions, which reads more formal.');

  // These keys go straight into a sentence the user reads, so they need English names.
  // Without the map it says "You reach for emDash and parenthetical more than most people."
  const PUNCTUATION_NAME: Record<keyof StyleProfile['punctuation'], string> = {
    emDash: 'em dashes',
    semicolon: 'semicolons',
    parenthetical: 'parentheses',
    exclamation: 'exclamation marks',
  };

  const punct = Object.entries(p.punctuation)
    .filter(([, v]) => v > 0.4)
    .map(([k]) => PUNCTUATION_NAME[k as keyof StyleProfile['punctuation']]);
  if (punct.length) out.push(`You reach for ${punct.join(' and ')} more than most people.`);

  if (p.favoredTransitions.length) {
    out.push(`You lean on "${p.favoredTransitions.slice(0, 3).join('", "')}" to connect ideas.`);
  }

  out.push(
    p.vocabularyTier === 'formal'
      ? 'Your vocabulary sits on the formal side.'
      : p.vocabularyTier === 'plain'
        ? 'You write in plain, everyday words.'
        : 'Your vocabulary mixes plain and formal registers.',
  );

  return out;
}
