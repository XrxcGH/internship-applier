/**
 * Machine-register detection — docs/06 § ⑥ Tell-scrub.
 *
 * WHAT THIS IS FOR, precisely: generated application answers should read like the person
 * who is going to sign them, because they are that person's facts in that person's voice
 * and they will edit and submit them personally. Text that reads as machine-written is
 * worse writing, and on an application it also misrepresents who did the thinking.
 *
 * WHAT THIS IS NOT FOR: defeating AI-detection tools. Nothing here is tuned against a
 * classifier, and the AI-disclosure question on an application form is redlined — the
 * tool leaves it blank for the user to answer (docs/07 § Redlines). If someone wants to
 * disclose, this changes nothing about that; it just means the prose isn't stilted.
 *
 * Everything FLAGS rather than silently rewrites. The user decides.
 *
 * The same detector runs over this app's own interface copy, in a test, because a tool
 * that lectures you about machine-sounding prose while writing "seamlessly leverage your
 * unique journey" on its own buttons has no standing.
 */

export type TellKind =
  | 'cliche_opener'
  | 'overused_word'
  | 'hollow_intensifier'
  | 'corporate_register'
  | 'transition_stack'
  | 'triadic_overuse'
  | 'uniform_rhythm'
  | 'em_dash_density'
  | 'symmetric_paragraphs'
  | 'assistant_voice'
  | 'contrast_reframe'
  | 'false_payoff'
  | 'summary_closer'
  | 'low_lexical_diversity'
  | 'repeated_openers';

export interface Tell {
  kind: TellKind;
  /** What was found, verbatim. */
  match: string;
  span: { start: number; end: number };
  /** Why it reads as machine-written, in the second person. */
  note: string;
  /** A concrete replacement where one exists. */
  suggestion?: string;
}

// ─────────────────────────────────────────────────────── lexical tells

const CLICHE_OPENERS: Array<[RegExp, string]> = [
  [
    /\bI am (?:writing to |reaching out to )?(?:express|convey) my (?:strong )?interest\b/gi,
    'Say what drew you to it instead.',
  ],
  [
    /\bI am (?:very |extremely |truly )?excited to (?:apply|submit)\b/gi,
    'Open with something only you could write.',
  ],
  [/\bI am thrilled (?:to|at the opportunity)\b/gi, 'Open with something only you could write.'],
  [
    /\bIt is with great (?:enthusiasm|excitement|interest)\b/gi,
    'Cut it and start with the substance.',
  ],
  [
    /\bAs a (?:passionate|dedicated|motivated|driven) \w+/gi,
    'Show it with a specific rather than claiming it.',
  ],
  [
    /\bI believe I would be (?:a |an )?(?:great|perfect|excellent|ideal) fit\b/gi,
    'Say what you would do, not how well you would fit.',
  ],
  [
    /\bThank you for (?:your time and )?consideration\b/gi,
    'Fine in a letter, filler in a form answer.',
  ],
];

/**
 * Words that are not wrong but are wildly over-represented in generated prose. Flagged,
 * never auto-removed — "navigate" is a perfectly good word when you mean it literally.
 */
const OVERUSED: Array<[RegExp, string]> = [
  // Inflections matter: "leveraged" and "delving" are the forms that actually turn up.
  [/\bdelv(?:e|es|ing|ed)\b/gi, 'dig into, look at'],
  [/\btapestry\b/gi, 'cut it'],
  [/\blandscape\b(?! architect| design| gardening)/gi, 'field, area'],
  [/\brealm\b/gi, 'area, field'],
  [/\btestament to\b/gi, 'shows, proves'],
  [/\bleverag(?:e|es|ing|ed)\b/gi, 'use'],
  [/\bharness(?:es|ing|ed)?\b/gi, 'use'],
  [/\bnavigat(?:e|ing|ed)\b(?! to| the (?:site|page|menu))/gi, 'handle, work through'],
  [/\bfoster(?:ing|ed)?\b/gi, 'build, encourage'],
  [/\bunderscor(?:e|es|ing|ed)\b/gi, 'shows, highlights'],
  [/\bpivotal\b/gi, 'key, important'],
  [/\bmyriad\b/gi, 'many'],
  [/\bplethora\b/gi, 'plenty of'],
  [/\bembark(?:ing|ed)? on\b/gi, 'start'],
  [/\bunlock(?:ing)? (?:the )?(?:potential|value|insights)\b/gi, 'cut it'],
  [/\belevat(?:e|ing|ed) (?!the (?:train|track))/gi, 'improve, raise'],
  [/\bempower(?:ing|ed|s)?\b/gi, 'let, help'],
  [/\bseamless(?:ly)?\b/gi, 'smooth, without friction'],
  [/\brobust\b/gi, 'solid, reliable'],
  [/\bcutting[- ]edge\b/gi, 'new, current'],
  [/\bgame[- ]chang(?:er|ing)\b/gi, 'cut it'],
  [/\bin today's (?:fast[- ]paced|ever[- ]changing|digital) world\b/gi, 'cut the whole clause'],
  [/\bat the intersection of\b/gi, 'cut it'],
  [/\bdeep dive\b/gi, 'close look'],
  [/\bsynerg(?:y|ies|istic)\b/gi, 'cut it'],
  [/\bholistic\b/gi, 'whole, complete'],
  [/\bmeticulous(?:ly)?\b/gi, 'careful, carefully'],
  [/\bvibrant\b/gi, 'cut it'],
  [/\bwealth of experience\b/gi, 'say how much'],
  // Currently-fashionable models lean hard on these two.
  [
    /\bquiet(?:ly)?\s+(?:confiden\w+|rebellion|power\w*|growing|truth|revolution)\b/gi,
    'cut "quiet"',
  ],
  [/\b(?:a strong |the )signal that\b|\bsends? the signal\b/gi, 'say what it shows'],
  [/\bshed(?:ding)? light on\b/gi, 'explain, show'],
  [/\bpav(?:e|ing|ed) the way\b/gi, 'led to'],
  [/\bever[- ]evolving\b/gi, 'changing'],
  [/\bboasts?\b/gi, 'has'],
  [/\bshowcas(?:e|es|ing|ed)\b/gi, 'show'],
  [/\b(?:stands|serves) as a\b/gi, 'is'],
  [/\bdiv(?:e|es|ing|ed) into\b(?! the (?:pool|water))/gi, 'look at, start on'],
  [/\bcrucial\b/gi, 'important, necessary'],
  [/\bvital\b(?! signs| organ)/gi, 'important'],
  [/\bnotably\b/gi, 'usually removable'],
  [/\brich (?:history|tapestry|tradition)\b/gi, 'be specific'],
  [/\bthe world of\b/gi, 'cut it'],
];

const HOLLOW_INTENSIFIERS: Array<[RegExp, string]> = [
  [/\btruly (?:passionate|excited|believe|unique)\b/gi, 'cut "truly"'],
  [/\bincredibly (?:passionate|excited|proud|grateful)\b/gi, 'cut "incredibly"'],
  [/\bextremely (?:passionate|excited|motivated)\b/gi, 'cut "extremely"'],
  [/\bdeeply (?:passionate|committed|resonate)\b/gi, 'cut "deeply"'],
  [/\bvery (?:passionate|excited)\b/gi, 'cut "very"'],
];

const CORPORATE: Array<[RegExp, string]> = [
  [/\butiliz(?:e|es|ing|ed)\b/gi, 'use'],
  [/\bfacilitat(?:e|es|ing|ed)\b/gi, 'help, run'],
  [/\bendeavou?r\b/gi, 'try, effort'],
  [/\bcommenc(?:e|ed|ing)\b/gi, 'start'],
  [/\bin order to\b/gi, 'to'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bwith regard(?:s)? to\b/gi, 'about'],
  [/\ba wide (?:range|array|variety) of\b/gi, 'name them'],
];

/**
 * The contrast reframe: "It's not just X, it's Y." Reported as one of the most reliable
 * current giveaways — it performs insight without adding information, and models reach
 * for it constantly. Rare in unselfconscious human writing.
 */
const CONTRAST_REFRAME: Array<[RegExp, string]> = [
  [
    /\b(?:it'?s|this is|that'?s) not (?:just|only|merely|simply) [^.,;!?]{2,50}[,—-]\s*(?:it'?s|this is|that'?s)\b/gi,
    'State the second half and drop the first.',
  ],
  [
    /\b(?:it'?s|this) (?:isn'?t|is not) (?:about|a) [^.,;!?]{2,50}[,—-]\s*(?:it'?s|it is)\b/gi,
    'Say the thing directly.',
  ],
  // A comma almost always sits before "but also", so it must not be excluded here.
  [/\bnot only [^.;!?]{2,60}\bbut also\b/gi, 'Two plain sentences read better.'],
  [/\bmore than (?:just )?a\b[^.,;!?]{2,40}[—-]/gi, 'Cut the setup.'],
];

/** Openers that promise a payoff and deliver a generality. */
const FALSE_PAYOFF: Array<[RegExp, string]> = [
  [
    /\bhere'?s the (?:kicker|thing|breakdown|catch|secret|reality|part most people miss)\b/gi,
    'Cut it and make the point.',
  ],
  [/\bthe best part\?/gi, 'Cut it.'],
  [/\bbut here'?s (?:the thing|why)\b/gi, 'Cut it.'],
  [/\bwhat (?:most people|nobody) (?:tells?|realiz)\w*\b/gi, 'Cut it.'],
  [/\blet(?:'?s| us) be (?:clear|honest)\b/gi, 'Cut it.'],
  [/\bit'?s worth noting\b/gi, 'If it is worth noting, just note it.'],
  [/\bwhen it comes to\b/gi, 'Name the subject directly.'],
  [/\brest assured\b/gi, 'Cut it.'],
  [/\blook no further\b/gi, 'Cut it.'],
  [/\bwhether you'?re\b[^.]{2,60}\bor\b/gi, 'Address the actual reader.'],
];

/** A wrap-up line in a short answer reads like an essay template. */
const SUMMARY_CLOSER: Array<[RegExp, string]> = [
  [/\bin (?:short|conclusion|summary|essence)\b/gi, 'Short answers do not need a summary.'],
  [/\bat the end of the day\b/gi, 'Cut it.'],
  [/\bthe bottom line is\b/gi, 'Cut it.'],
  [/\bultimately,/gi, 'Usually removable.'],
  [/\b(?:firstly|secondly|thirdly|lastly)\b/gi, 'First, second — or no marker at all.'],
];

const ASSISTANT_VOICE: Array<[RegExp, string]> = [
  [/\bAs an? (?:AI|language model|assistant)\b/gi, 'This should never appear on an application.'],
  [
    /\bI (?:do not|don't) have personal (?:experience|opinions|feelings)\b/gi,
    'This should never appear on an application.',
  ],
  [/\bI hope this (?:helps|email finds you well)\b/gi, 'Cut it.'],
  [/\bCertainly!|\bOf course!|\bGreat question\b/gi, 'Chat filler — cut it.'],
];

// ─────────────────────────────────────────────────────── structural tells

const PARAGRAPH_OPENER_TRANSITIONS =
  /^(?:Furthermore|Moreover|Additionally|In addition|Consequently|Therefore|Thus|Nevertheless|Nonetheless)\b/i;

/** "X, Y, and Z" — one is fine; four in a row is a rhythm nobody writes by accident. */
const TRIAD = /\b[\w'-]+, [\w'-]+,? and [\w'-]+\b/g;

/** Excluded from the lexical-diversity measure: everyone repeats these. */
const FUNCTION_WORDS = new Set(
  (
    'that this with have from they were been will your what when which their there would could ' +
    'about into more than then them some other over also after your been because while'
  ).split(' '),
);

export interface ScrubOptions {
  /**
   * The user's own measured em-dash rate per 100 words, from their StyleProfile. Density
   * is only a tell relative to how the person actually writes; some people genuinely
   * love em-dashes.
   */
  baselineEmDashPer100?: number;
  /** The user's measured sentence-length stdev. Below this reads as flattened. */
  baselineSentenceStdev?: number;
  /**
   * Below this word count the structural checks are skipped. Kept low (25) because short
   * application answers are exactly where flattened rhythm shows, and a higher floor
   * silently skipped them. The real guards are the per-check minimums below: four
   * sentences for rhythm, three triads, two stacked paragraph openers.
   */
  minWordsForStructural?: number;
}

function scanPatterns(
  text: string,
  patterns: Array<[RegExp, string]>,
  kind: TellKind,
  note: string,
): Tell[] {
  const out: Tell[] = [];
  for (const [re, suggestion] of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue;
      out.push({
        kind,
        match: m[0],
        span: { start: m.index, end: m.index + m[0].length },
        note,
        suggestion,
      });
    }
  }
  return out;
}

function splitSentences(text: string): string[] {
  const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
  return [...seg.segment(text)].map((s) => s.segment.trim()).filter((s) => /\p{L}/u.test(s));
}

const countWords = (s: string): number => (s.match(/[\p{L}'-]+/gu) ?? []).length;

/**
 * Em-dashes, including the double hyphen people type when they have no — key.
 * `styleProfile.ts` measures the user's baseline with this, and the density tell below
 * compares against that baseline, so both sides have to count the same thing — otherwise
 * someone who writes "--" gets a baseline they can never trip and the tell dies silently.
 */
export const EM_DASH = /—|--/g;

export function countEmDashes(text: string): number {
  return (text.match(EM_DASH) ?? []).length;
}

export function findTells(text: string, opts: ScrubOptions = {}): Tell[] {
  const tells: Tell[] = [
    ...scanPatterns(
      text,
      CLICHE_OPENERS,
      'cliche_opener',
      'Opening that appears on a huge share of applications.',
    ),
    ...scanPatterns(
      text,
      OVERUSED,
      'overused_word',
      'Heavily over-represented in generated prose.',
    ),
    ...scanPatterns(
      text,
      HOLLOW_INTENSIFIERS,
      'hollow_intensifier',
      'The intensifier adds nothing.',
    ),
    ...scanPatterns(
      text,
      CORPORATE,
      'corporate_register',
      'Stiffer than how people actually talk.',
    ),
    ...scanPatterns(text, ASSISTANT_VOICE, 'assistant_voice', 'Chat-assistant phrasing.'),
    ...scanPatterns(
      text,
      CONTRAST_REFRAME,
      'contrast_reframe',
      'Performs insight without adding any.',
    ),
    ...scanPatterns(text, FALSE_PAYOFF, 'false_payoff', 'Promises a payoff it does not deliver.'),
    ...scanPatterns(text, SUMMARY_CLOSER, 'summary_closer', 'Essay-template scaffolding.'),
  ];

  const totalWords = countWords(text);
  const minWords = opts.minWordsForStructural ?? 25;
  if (totalWords < minWords) return dedupe(tells);

  // Stacked transitions at paragraph starts.
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const openers = paragraphs.filter((p) => PARAGRAPH_OPENER_TRANSITIONS.test(p));
  if (openers.length >= 2) {
    const first = openers[0]!;
    const start = text.indexOf(first);
    tells.push({
      kind: 'transition_stack',
      match: first.slice(0, 40),
      span: { start: Math.max(0, start), end: Math.max(0, start) + 40 },
      note: `${openers.length} paragraphs open with a formal connective (Furthermore, Moreover…). Start one of them with the point instead.`,
    });
  }

  // Triadic list overuse.
  const triads = [...text.matchAll(TRIAD)];
  if (triads.length >= 3) {
    const m = triads[0]!;
    tells.push({
      kind: 'triadic_overuse',
      match: m[0],
      span: { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length },
      note: `${triads.length} "X, Y, and Z" lists. Break one into a plain sentence — the repeated rhythm is a strong tell.`,
    });
  }

  // Flattened sentence rhythm — the loudest structural tell there is.
  const sents = splitSentences(text);
  if (sents.length >= 4) {
    const lens = sents.map(countWords);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / (lens.length - 1));
    // A measured stdev of zero means one sentence of sample, not a writer with no rhythm
    // at all, so it falls back to the generic floor rather than switching the loudest
    // structural check off for anyone who supplied a single line of writing.
    const floor = opts.baselineSentenceStdev ? opts.baselineSentenceStdev * 0.6 : 4;
    if (sd < floor) {
      tells.push({
        kind: 'uniform_rhythm',
        match: `${sents.length} sentences averaging ${mean.toFixed(0)} words`,
        span: { start: 0, end: Math.min(60, text.length) },
        note: `Sentence lengths barely vary (spread of ${sd.toFixed(1)}). Real writing lurches — a three-word sentence next to a long one. This is the single loudest tell.`,
      });
    }
  }

  // Em-dash density, relative to how this person actually writes.
  const emDashes = countEmDashes(text);
  const per100 = (emDashes / Math.max(1, totalWords)) * 100;
  const baseline = opts.baselineEmDashPer100 ?? 0.5;
  if (emDashes >= 2 && per100 > Math.max(baseline * 2, 1.2)) {
    const first = text.match(/—|--/);
    const idx = first?.index ?? 0;
    tells.push({
      kind: 'em_dash_density',
      match: first?.[0] ?? '—',
      span: { start: idx, end: idx + (first?.[0].length ?? 1) },
      note: `${emDashes} em-dashes in ${totalWords} words (${per100.toFixed(1)} per 100${
        opts.baselineEmDashPer100 !== undefined ? `, versus your usual ${baseline}` : ''
      }). Swap some for a period or a comma.`,
    });
  }

  /**
   * Lexical diversity (type-token ratio). The stylometry literature consistently finds
   * higher lexical repetitiveness in machine-generated text: it reaches for the same
   * content words rather than varying them. Measured over content words only, since
   * function words repeat in everyone's writing, and on a fixed-size window because raw
   * TTR falls as text gets longer regardless of who wrote it.
   */
  const content = (text.toLowerCase().match(/[\p{L}'-]+/gu) ?? []).filter(
    (w) => w.length > 3 && !FUNCTION_WORDS.has(w),
  );
  if (content.length >= 40) {
    const window = content.slice(0, 120);
    const ttr = new Set(window).size / window.length;
    if (ttr < 0.62) {
      tells.push({
        kind: 'low_lexical_diversity',
        match: `${new Set(window).size} distinct words in ${window.length}`,
        span: { start: 0, end: Math.min(60, text.length) },
        note: `The same words keep coming back (diversity ${ttr.toFixed(2)}). Naming things specifically once beats naming them vaguely three times.`,
      });
    }
  }

  /**
   * Repeated sentence openers. "I did X. I did Y. I did Z." is the single most common
   * shape of a generated application answer, and among the easiest things to fix.
   */
  if (sents.length >= 4) {
    const firstWords = sents.map((s) => (s.match(/[\p{L}']+/u)?.[0] ?? '').toLowerCase());
    const counts = new Map<string, number>();
    for (const w of firstWords) if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
    const [word, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (n >= 3 && n / sents.length >= 0.5) {
      tells.push({
        kind: 'repeated_openers',
        match: `${n} sentences start with "${word}"`,
        span: { start: 0, end: Math.min(60, text.length) },
        note: `${n} of ${sents.length} sentences open with "${word}". Vary how they start, or join two of them.`,
      });
    }
  }

  // Paragraphs machined to the same length.
  if (paragraphs.length >= 3) {
    const lens = paragraphs.map(countWords);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / (lens.length - 1));
    if (mean > 25 && sd / mean < 0.15) {
      tells.push({
        kind: 'symmetric_paragraphs',
        match: `${paragraphs.length} paragraphs of ~${mean.toFixed(0)} words`,
        span: { start: 0, end: Math.min(60, text.length) },
        note: 'Every paragraph is nearly the same length. People write one long one and one short one.',
      });
    }
  }

  return dedupe(tells);
}

function dedupe(tells: Tell[]): Tell[] {
  const seen = new Set<string>();
  return tells
    .filter((t) => {
      const k = `${t.kind}|${t.span.start}|${t.match.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.span.start - b.span.start);
}

/** One-line summary for a UI badge. */
export function summarize(tells: Tell[]): string {
  if (tells.length === 0) return 'Nothing here reads as machine-written.';
  const byKind = new Map<TellKind, number>();
  for (const t of tells) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
  return [...byKind.entries()].map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ');
}
