/**
 * Match rationale — docs/05 § Stage 2.
 *
 * Two or three sentences that MUST include the honest downside. A ranking tool that only
 * tells you why things look good is a ranking tool you stop believing, and the user is
 * about to spend real effort on these.
 *
 * Written entirely in TypeScript from the computed breakdown and the rule results, so it
 * cannot invent a reason and it reads the same with or without an API key.
 *
 * Not built: the model polish pass docs/05 describes. If one is added it has to take the
 * same breakdown as its only source of facts, for the same reason.
 */
import type { RuleResult, ScoreBreakdown } from '@ia/shared';
import type { EligibilityStatus } from './eligibility';
import type { ScoreOutcome } from './score';

export interface RationaleInput {
  /**
   * Which posting this is. The sentences below never name it — the rationale sits under
   * the company and title on screen, so repeating them would only cost the reader room —
   * but a model pass would need them, and every caller has them to hand.
   */
  company: string;
  title: string;
  eligibility: EligibilityStatus;
  rules: RuleResult[];
  score: ScoreOutcome;
}

const DIMENSION_LABEL: Record<keyof ScoreBreakdown, string> = {
  requiredSkillCoverage: 'the required skills line up',
  preferredSkillCoverage: 'you cover most of the nice-to-haves',
  roleAlignment: 'the role matches what you have actually done',
  domainMatch: 'the industry is one you said you wanted',
  seniorityFit: 'the level fits where you are',
  locationDesirability: 'the location works for you',
  compensation: 'the pay is good',
  applyEffort: 'the application is quick',
};

const DIMENSION_WEAK: Record<keyof ScoreBreakdown, string> = {
  requiredSkillCoverage: 'you match few of the required skills',
  preferredSkillCoverage: 'you cover few of the preferred skills',
  roleAlignment: "the role is a step away from what's on your resume",
  domainMatch: 'the industry is outside what you said you wanted',
  seniorityFit: 'the level is a stretch from where you are',
  locationDesirability: 'the location is outside your stated areas',
  compensation: 'the pay is low or unpaid',
  applyEffort: 'the application is long',
};

/**
 * Only dimensions with something behind them can be a reason.
 *
 * A dimension scored neutrally for lack of data is not evidence of anything, and saying
 * so out loud produced "Worth a look because the required skills line up — no required
 * skills listed". If nothing has evidence, there is no honest superlative to name.
 */
function scored(s: ScoreOutcome): Array<keyof ScoreBreakdown> {
  return (Object.keys(s.breakdown) as Array<keyof ScoreBreakdown>).filter((k) => s.evidence[k]);
}

function strongest(s: ScoreOutcome): keyof ScoreBreakdown | null {
  const keys = scored(s);
  return keys.reduce<keyof ScoreBreakdown | null>(
    (a, k) => (a === null || s.breakdown[k] > s.breakdown[a] ? k : a),
    null,
  );
}

function weakest(s: ScoreOutcome): keyof ScoreBreakdown | null {
  const keys = scored(s);
  return keys.reduce<keyof ScoreBreakdown | null>(
    (a, k) => (a === null || s.breakdown[k] < s.breakdown[a] ? k : a),
    null,
  );
}

export function buildRationale(input: RationaleInput): string {
  const { eligibility, rules, score } = input;

  if (eligibility === 'ineligible') {
    const blockers = rules.filter((r) => r.status === 'fail');
    const first = blockers[0];
    // Its own sentence. Every `because` string already ends in a full stop, so the
    // parenthetical used to float unpunctuated between two complete sentences — sloppy
    // anywhere, and this is the drawer that exists so the user can catch the tool
    // being wrong.
    const rest =
      blockers.length > 1
        ? ` Plus ${String(blockers.length - 1)} other blocker${blockers.length === 2 ? '' : 's'}.`
        : '';
    return `Filtered out: ${first?.because ?? 'a requirement was not met.'}${rest} You can still open it and decide for yourself — nothing here is hidden.`;
  }

  const best = strongest(score);
  const worst = weakest(score);
  const parts: string[] = [];

  parts.push(
    best
      ? `Worth a look because ${DIMENSION_LABEL[best]} — ${score.notes[best]}.`
      : 'Eligible, but the posting says too little to rank it on anything: no skills, ' +
          'level, pay, or location to compare against. Open it and judge for yourself.',
  );

  // The honest downside, always. Either an unresolved eligibility question or the
  // weakest scoring dimension.
  const unresolved = rules.filter((r) => r.status === 'unknown');
  if (unresolved.length > 0) {
    parts.push(
      `Unresolved: ${unresolved[0]!.because}${
        unresolved.length > 1
          ? ` And ${unresolved.length - 1} other thing(s) couldn't be checked.`
          : ''
      }`,
    );
  }

  if (worst && score.breakdown[worst] < 0.6) {
    parts.push(
      `Most likely reason you'd be passed over: ${DIMENSION_WEAK[worst]} (${score.notes[worst]}).`,
    );
  } else if (unresolved.length === 0 && worst) {
    parts.push('Nothing stands out as a likely rejection reason, which is rarer than it sounds.');
  }

  return parts.join(' ');
}
