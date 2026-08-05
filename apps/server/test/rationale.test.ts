/**
 * The rationale is the only sentence most postings ever get read for, so it is held to
 * the same standard as a rule result: it may not assert something nobody checked.
 */
import { describe, expect, it } from 'vitest';
import type { RuleResult, ScoreBreakdown } from '@ia/shared';
import { buildRationale } from '../src/core/matching/rationale';
import type { ScoreOutcome } from '../src/core/matching/score';

const KEYS: Array<keyof ScoreBreakdown> = [
  'requiredSkillCoverage',
  'preferredSkillCoverage',
  'roleAlignment',
  'domainMatch',
  'seniorityFit',
  'locationDesirability',
  'compensation',
  'applyEffort',
];

function outcome(
  breakdown: Partial<ScoreBreakdown>,
  evidence: Partial<Record<keyof ScoreBreakdown, boolean>>,
): ScoreOutcome {
  const b = {} as ScoreBreakdown;
  const e = {} as Record<keyof ScoreBreakdown, boolean>;
  const notes = {} as Record<keyof ScoreBreakdown, string>;
  for (const k of KEYS) {
    b[k] = breakdown[k] ?? 0.5;
    e[k] = evidence[k] ?? false;
    notes[k] = `note for ${k}`;
  }
  return { score: 50, breakdown: b, evidence: e, notes };
}

const passRule: RuleResult = { rule: 'age_minimum', status: 'pass', because: 'fine' };

describe('buildRationale', () => {
  /**
   * An empty required-skill list used to score a perfect 1.0, which beat every real
   * dimension and produced "Worth a look because the required skills line up — no
   * required skills listed": a sentence that argues with itself. Because the
   * deterministic extractor never emits a skill requirement, that was every eligible
   * match on any run without a model.
   */
  it('never names a dimension that had no data behind it', () => {
    const text = buildRationale({
      company: 'Acme',
      title: 'SWE Intern',
      eligibility: 'eligible',
      rules: [passRule],
      score: outcome({ requiredSkillCoverage: 1, seniorityFit: 0.9 }, { seniorityFit: true }),
    });
    expect(text).not.toMatch(/required skills line up/);
    expect(text).toMatch(/the level fits where you are/);
  });

  it('says so plainly when no dimension has any evidence at all', () => {
    const text = buildRationale({
      company: 'Acme',
      title: 'SWE Intern',
      eligibility: 'eligible',
      rules: [passRule],
      score: outcome({ requiredSkillCoverage: 1 }, {}),
    });
    expect(text).toMatch(/says too little to rank it/i);
    expect(text).not.toMatch(/Worth a look because/);
  });

  it('still leads with the strongest dimension that does have evidence', () => {
    const text = buildRationale({
      company: 'Acme',
      title: 'SWE Intern',
      eligibility: 'eligible',
      rules: [passRule],
      score: outcome(
        { requiredSkillCoverage: 0.9, compensation: 0.4 },
        { requiredSkillCoverage: true, compensation: true },
      ),
    });
    expect(text).toMatch(/the required skills line up/);
    expect(text).toMatch(/the pay is low or unpaid/);
  });

  it('always includes a downside, which is the whole point of the sentence', () => {
    const text = buildRationale({
      company: 'Acme',
      title: 'SWE Intern',
      eligibility: 'eligible',
      rules: [{ rule: 'location', status: 'unknown', because: 'Based in Austin, TX.' }],
      score: outcome({ roleAlignment: 0.95 }, { roleAlignment: true }),
    });
    expect(text).toMatch(/Unresolved:/);
  });
});
