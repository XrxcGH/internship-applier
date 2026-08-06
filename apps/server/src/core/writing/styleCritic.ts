/**
 * StyleCritic — docs/06 § ⑤.
 *
 * Measures the draft the same way `styleProfile.ts` measured the user's own writing, then
 * reports where the two diverge. Same instrument on both sides, so a difference is a real
 * difference and not an artefact of comparing a metric to an adjective.
 *
 * Deterministic and model-free. It runs with no API key, on every draft, and its output
 * is a set of numbers the user can see rather than a verdict they have to trust.
 *
 * This is NOT an AI-detector score, and it deliberately does not try to be one. It
 * answers a narrower question: does this read like the person who is about to sign it?
 * Chasing a detector's score would mean optimising against a black box that changes
 * without notice — see docs/06 for why that line is drawn where it is.
 */
import type { StyleProfile } from '@ia/shared';
import { computeStyleProfile, sentences, words } from './styleProfile';

export type DriftDimension =
  | 'sentence_length'
  | 'sentence_variation'
  | 'contractions'
  | 'vocabulary'
  | 'em_dash'
  | 'hedging'
  | 'paragraph_shape'
  | 'lists';

export interface Drift {
  dimension: DriftDimension;
  /** 0 = indistinguishable, 1 = as far off as this dimension gets. */
  severity: number;
  yours: string;
  draft: string;
  /** Second person, actionable, no jargon. */
  note: string;
}

export interface StyleReport {
  /** The draft, measured with the same instrument as the user's samples. */
  measured: StyleProfile;
  drift: Drift[];
  /**
   * 0-1. How close the draft sits to the user's measured voice overall, or `null` when no
   * comparison happened at all.
   *
   * Null rather than 1, because 1 is a claim. A two-word answer and a draft written before
   * the user had supplied any samples both used to score a flat 1 — a perfect voice match,
   * reported by a comparison that never ran. `tooShort` and `noBaseline` were added to say
   * so, and `describeMatch` reads them, but the number itself went on saying the old thing;
   * anything that renders the percentage instead of the sentence would show 100%.
   */
  match: number | null;
  /** True when the draft is too short to measure honestly. */
  tooShort: boolean;
  /**
   * True when there is nothing to measure AGAINST — no writing samples on file.
   *
   * Distinct from tooShort, and it has to be, because the report could not previously
   * tell a perfect match apart from a comparison that never happened: both produced
   * drift: [] and match: 1, and the G3 header cheerfully said "Reads like your other
   * writing" to a user who had supplied no other writing. In the gate where someone
   * decides whether to trust a draft, that is the one claim that must not be invented.
   */
  noBaseline: boolean;
}

/** Below this, sentence statistics are noise and reporting them would be dishonest. */
const MIN_SENTENCES = 4;

/**
 * Maps a raw difference onto 0-1 using the spread a person's own writing shows across
 * samples. `tolerance` is the difference that reads as "the same voice on a different
 * day"; `breaking` is where it reads as somebody else.
 */
function severity(diff: number, tolerance: number, breaking: number): number {
  if (diff <= tolerance) return 0;
  return Math.min(1, (diff - tolerance) / (breaking - tolerance));
}

const round = (n: number): number => Math.round(n * 100) / 100;

export function critiqueStyle(draft: string, yours: StyleProfile | undefined): StyleReport {
  const measured = computeStyleProfile([{ id: 'draft', content: draft }]);
  const sentenceCount = sentences(draft).length;
  const tooShort = sentenceCount < MIN_SENTENCES || words(draft).length < 40;

  if (!yours || tooShort) {
    return { measured, drift: [], match: null, tooShort, noBaseline: !yours };
  }

  const drift: Drift[] = [];
  /**
   * Every dimension that was measured, including the ones too small to be worth telling
   * the user about. The overall score divides by this, not by `drift.length`.
   *
   * Averaging over the reported drifts alone made the number go UP when a draft got
   * worse: a draft with one problem at 0.20 scored 0.80, and the same draft with a second
   * problem at 0.16 added to it scored 0.81. Anything showing that figure as a percentage
   * would tell a user their answer had improved because it picked up a new tell.
   */
  const measuredSeverities: number[] = [];
  const add = (d: Drift): void => {
    measuredSeverities.push(d.severity);
    if (d.severity > 0.15) drift.push(d);
  };

  // ── Sentence variation. The headline metric: uniform rhythm is the loudest tell there
  // is, and it is the one thing generated text reliably gets wrong.
  const varDiff = Math.abs(measured.sentenceLengthStdev - yours.sentenceLengthStdev);
  add({
    dimension: 'sentence_variation',
    severity: severity(varDiff, 2, 8),
    yours: `varies by ${yours.sentenceLengthStdev}`,
    draft: `varies by ${measured.sentenceLengthStdev}`,
    note:
      measured.sentenceLengthStdev < yours.sentenceLengthStdev
        ? 'Your sentences swing between short and long more than this draft does. It reads flatter than you do. Try cutting one sentence in half.'
        : 'This draft swings between very short and very long sentences more than your own writing does.',
  });

  // ── Mean sentence length.
  const lenDiff = Math.abs(measured.meanSentenceLength - yours.meanSentenceLength);
  add({
    dimension: 'sentence_length',
    severity: severity(lenDiff, 3, 12),
    yours: `${yours.meanSentenceLength} words`,
    draft: `${measured.meanSentenceLength} words`,
    note:
      measured.meanSentenceLength > yours.meanSentenceLength
        ? 'The sentences here run longer than yours usually do.'
        : 'The sentences here are shorter and clippier than you normally write.',
  });

  // ── Contractions. Their absence is the single easiest formality tell to fix.
  const conDiff = Math.abs(measured.contractionRate - yours.contractionRate);
  add({
    dimension: 'contractions',
    severity: severity(conDiff, 0.5, 3),
    yours: `${yours.contractionRate} per 100 words`,
    draft: `${measured.contractionRate} per 100 words`,
    note:
      measured.contractionRate < yours.contractionRate
        ? 'You use contractions more than this draft does. Writing out "do not" and "I have" is what makes it sound stiff.'
        : 'This draft uses more contractions than you typically do.',
  });

  // ── Register.
  const TIER = { plain: 0, mixed: 1, formal: 2 } as const;
  const tierDiff = Math.abs(TIER[measured.vocabularyTier] - TIER[yours.vocabularyTier]);
  add({
    dimension: 'vocabulary',
    severity: tierDiff === 0 ? 0 : tierDiff === 1 ? 0.4 : 0.9,
    yours: yours.vocabularyTier,
    draft: measured.vocabularyTier,
    note:
      TIER[measured.vocabularyTier] > TIER[yours.vocabularyTier]
        ? 'The word choice is more formal than yours. Swap the longest words for the ones you would actually say.'
        : 'The word choice is plainer than your usual register.',
  });

  // ── Em dashes. Called out on its own because it is the most-cited machine tell, and
  // because a draft can be perfect everywhere else and still give itself away here.
  const emDiff = measured.punctuation.emDash - yours.punctuation.emDash;
  add({
    dimension: 'em_dash',
    severity: emDiff <= 0 ? 0 : severity(emDiff, 0.3, 2),
    yours: `${yours.punctuation.emDash} per 100 words`,
    draft: `${measured.punctuation.emDash} per 100 words`,
    note: 'There are more em dashes here than you use. It is the most-noticed tell there is; a comma or a period does the same work.',
  });

  // ── Hedging.
  const hedgeDiff = Math.abs(measured.hedgeRate - yours.hedgeRate);
  add({
    dimension: 'hedging',
    severity: severity(hedgeDiff, 0.5, 3),
    yours: `${yours.hedgeRate} per 100 words`,
    draft: `${measured.hedgeRate} per 100 words`,
    note:
      measured.hedgeRate < yours.hedgeRate
        ? 'This states things more flatly than you usually do. You hedge a little, and that reads as a person thinking.'
        : 'There is more hedging here than in your own writing.',
  });

  // ── Paragraph shape.
  if (yours.paragraphMeanSentences > 0 && measured.paragraphMeanSentences > 0) {
    const paraDiff = Math.abs(measured.paragraphMeanSentences - yours.paragraphMeanSentences);
    add({
      dimension: 'paragraph_shape',
      severity: severity(paraDiff, 1, 4),
      yours: `${yours.paragraphMeanSentences} sentences per paragraph`,
      draft: `${measured.paragraphMeanSentences} sentences per paragraph`,
      note: 'The paragraphs are a different shape from the ones in your samples.',
    });
  }

  // ── Lists where the person never uses them.
  if (yours.listUsage === 'never' && measured.listUsage !== 'never') {
    add({
      dimension: 'lists',
      severity: 0.7,
      yours: 'prose',
      draft: 'bulleted',
      note: 'You write in prose. Bullets in an application answer read as generated.',
    });
  }

  drift.sort((a, b) => b.severity - a.severity);

  // Worst dimension dominates: one loud tell sinks a draft that is average everywhere
  // else, which is how a reader experiences it.
  const worst = drift.length > 0 ? drift[0]!.severity : 0;
  const mean =
    measuredSeverities.reduce((a, s) => a + s, 0) / Math.max(1, measuredSeverities.length);
  return {
    measured,
    drift,
    match: round(1 - (worst * 0.6 + mean * 0.4)),
    tooShort: false,
    noBaseline: false,
  };
}

/** One line for the G3 header. */
export function describeMatch(report: StyleReport): string {
  if (report.noBaseline) {
    return 'No writing samples yet, so voice was not measured. Add a few under Voice.';
  }
  if (report.tooShort) return 'Too short to measure against your voice.';
  if (report.drift.length === 0) return 'Reads like your other writing.';
  const worst = report.drift[0]!;
  return `Biggest mismatch: ${worst.dimension.replace(/_/g, ' ')} — yours ${worst.yours}, this ${worst.draft}.`;
}
