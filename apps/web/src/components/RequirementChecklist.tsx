import type { RuleResult } from '@ia/shared';
import type { JobRequirementRow } from '../lib/matches';

/**
 * The trust surface of the whole application — docs/08 § Matches.
 *
 * Every rule shows its outcome, the reason, and the verbatim job-description text that
 * caused it. If the tool filtered something out, this is where the user checks whether
 * it was right. Colour is never the only signal: each state carries a mark and a label.
 */

const MARK: Record<RuleResult['status'], { glyph: string; label: string; color: string }> = {
  pass: { glyph: '✓', label: 'met', color: 'var(--verified)' },
  fail: { glyph: '✕', label: 'blocked', color: 'var(--redline)' },
  unknown: { glyph: '?', label: 'unresolved', color: 'var(--caution)' },
  not_applicable: { glyph: '–', label: 'not stated', color: 'var(--ink-faint)' },
};

const RULE_LABEL: Record<string, string> = {
  posting_open: 'Still open',
  deadline: 'Deadline',
  age_minimum: 'Minimum age',
  education_level: 'Education level',
  graduation_window: 'Graduation window',
  enrollment: 'Enrolment',
  work_authorization: 'Work authorization',
  citizenship: 'Citizenship / clearance',
  location: 'Location',
  term_overlap: 'Term overlap',
  experience_ceiling: 'Experience required',
  excluded_company: 'Your exclude list',
};

export function RequirementChecklist({
  rules,
  requirements,
}: {
  rules: RuleResult[];
  requirements: JobRequirementRow[];
}) {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  // Decisions first, non-applicable rules last — they're noise until you go looking.
  const order = { fail: 0, unknown: 1, pass: 2, not_applicable: 3 } as const;
  const sorted = [...rules].sort((a, b) => order[a.status] - order[b.status]);

  return (
    <ul className="space-y-3">
      {sorted.map((r) => {
        const mark = MARK[r.status];
        const quote = r.requirementId ? byId.get(r.requirementId)?.sourceQuote : r.evidence;

        return (
          <li key={r.rule} className="flex gap-3">
            <span
              aria-hidden
              className="u-data w-4 shrink-0 pt-0.5 text-center"
              style={{ color: mark.color }}
            >
              {mark.glyph}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[0.9375rem]">{RULE_LABEL[r.rule] ?? r.rule}</span>
                <span
                  className="u-data text-[0.6875rem] tracking-widest uppercase"
                  style={{ color: mark.color }}
                >
                  {mark.label}
                </span>
              </div>
              <p className="text-dim mt-0.5 text-[0.875rem]">{r.because}</p>
              {quote && (
                <blockquote className="u-quote mt-2 py-1">
                  {quote.length > 260 ? `${quote.slice(0, 260)}…` : quote}
                </blockquote>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const DIMENSION_LABEL: Record<string, string> = {
  requiredSkillCoverage: 'Required skills',
  preferredSkillCoverage: 'Preferred skills',
  roleAlignment: 'Role alignment',
  domainMatch: 'Industry',
  seniorityFit: 'Level',
  locationDesirability: 'Location',
  compensation: 'Pay',
  applyEffort: 'Effort',
};

/** The bars are the actual computation, not decoration — each shows its note. */
export function ScoreBreakdownBars({
  breakdown,
}: {
  breakdown: Record<string, unknown> & { notes?: Record<string, string> };
}) {
  const notes = breakdown.notes ?? {};
  const dims = Object.keys(DIMENSION_LABEL).filter((k) => typeof breakdown[k] === 'number');

  return (
    <ul className="space-y-2.5">
      {dims.map((k) => {
        const v = Math.max(0, Math.min(1, breakdown[k] as number));
        return (
          <li key={k}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[0.875rem]">{DIMENSION_LABEL[k]}</span>
              <span className="u-data text-faint text-[0.75rem]">{Math.round(v * 100)}</span>
            </div>
            <div className="bg-rule/50 mt-1 h-px w-full">
              <div
                className="h-px"
                style={{ width: `${v * 100}%`, backgroundColor: 'var(--accent)' }}
              />
            </div>
            {notes[k] && <p className="text-faint mt-1 text-[0.75rem]">{notes[k]}</p>}
          </li>
        );
      })}
    </ul>
  );
}
