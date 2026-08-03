/**
 * Match rationale — docs/05 § Stage 2.
 *
 * Two or three sentences that MUST include the honest downside. A ranking tool that only
 * tells you why things look good is a ranking tool you stop believing, and the user is
 * about to spend real effort on these.
 *
 * The deterministic version is the default and always available; the model version is an
 * optional polish pass. Both are built from the same computed breakdown and rule results,
 * so neither can invent a reason.
 */
import type { RuleResult, ScoreBreakdown } from '@ia/shared';
import type { EligibilityStatus } from './eligibility';
import type { ScoreOutcome } from './score';

export interface RationaleInput {
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

function strongest(b: ScoreBreakdown): keyof ScoreBreakdown {
  return (Object.keys(b) as Array<keyof ScoreBreakdown>).reduce((a, k) => (b[k] > b[a] ? k : a));
}

function weakest(b: ScoreBreakdown): keyof ScoreBreakdown {
  return (Object.keys(b) as Array<keyof ScoreBreakdown>).reduce((a, k) => (b[k] < b[a] ? k : a));
}

export function buildRationale(input: RationaleInput): string {
  const { eligibility, rules, score } = input;

  if (eligibility === 'ineligible') {
    const blockers = rules.filter((r) => r.status === 'fail');
    const first = blockers[0];
    const rest = blockers.length > 1 ? ` (plus ${blockers.length - 1} more)` : '';
    return `Filtered out: ${first?.because ?? 'a requirement was not met'}${rest} You can still open it and decide for yourself — nothing here is hidden.`;
  }

  const best = strongest(score.breakdown);
  const worst = weakest(score.breakdown);
  const parts: string[] = [];

  parts.push(`Worth a look because ${DIMENSION_LABEL[best]} — ${score.notes[best]}.`);

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

  if (score.breakdown[worst] < 0.6) {
    parts.push(
      `Most likely reason you'd be passed over: ${DIMENSION_WEAK[worst]} (${score.notes[worst]}).`,
    );
  } else if (unresolved.length === 0) {
    parts.push('Nothing stands out as a likely rejection reason, which is rarer than it sounds.');
  }

  return parts.join(' ');
}
