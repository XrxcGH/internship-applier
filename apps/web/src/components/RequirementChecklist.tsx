import { Check, CircleHelp, Minus, X, type LucideIcon } from 'lucide-react';
import type { RuleResult } from '@ia/shared';
import type { JobRequirementRow } from '../lib/matches';

/**
 * The trust surface of the whole application — docs/08 § Matches.
 *
 * Every rule shows its outcome, the reason, and the verbatim job-description text that
 * caused it. If the tool filtered something out, this is where the user checks whether
 * it was right. Colour is never the only signal: each state carries a mark and a label.
 */

/**
 * A drawn mark per state, not a typed character.
 *
 * These were literal glyphs — '✓', '✕', '?', '–' — set in the mono face, so their weight and
 * size drifted with whatever font actually loaded and the en dash for "not stated" read as a
 * hyphen at small sizes. A Lucide icon is a stroked SVG that inherits `currentColor` and
 * scales with the box, so all four now share one optical weight.
 *
 * The label beside each is what carries the meaning to a screen reader and to anyone who
 * cannot separate the hues; the icon and the colour are the fast path for everyone else.
 * That pairing is what let the palette quieten its signal colours this far.
 */
const MARK: Record<RuleResult['status'], { Icon: LucideIcon; label: string; color: string }> = {
  pass: { Icon: Check, label: 'met', color: 'var(--verified)' },
  fail: { Icon: X, label: 'blocked', color: 'var(--redline)' },
  unknown: { Icon: CircleHelp, label: 'unresolved', color: 'var(--caution)' },
  not_applicable: { Icon: Minus, label: 'not stated', color: 'var(--ink-faint)' },
};

const RULE_LABEL: Record<string, string> = {
  posting_open: 'Still open',
  deadline: 'Deadline',
  age_minimum: 'Minimum age',
  education_level: 'Education level',
  graduation_window: 'Graduation window',
  enrollment: 'Enrollment',
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
            <mark.Icon
              aria-hidden
              size={16}
              strokeWidth={2}
              className="mt-1 shrink-0"
              style={{ color: mark.color }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-base">{RULE_LABEL[r.rule] ?? r.rule}</span>
                <span
                  className="u-data text-2xs tracking-widest uppercase"
                  style={{ color: mark.color }}
                >
                  {mark.label}
                </span>
              </div>
              <p className="text-dim mt-0.5 text-sm">{r.because}</p>
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
              <span className="text-sm">{DIMENSION_LABEL[k]}</span>
              <span className="u-data text-faint text-2xs">{Math.round(v * 100)}</span>
            </div>
            <div className="bg-rule/50 mt-1 h-px w-full">
              <div
                className="h-px"
                style={{ width: `${v * 100}%`, backgroundColor: 'var(--accent)' }}
              />
            </div>
            {notes[k] && <p className="text-faint mt-1 text-2xs">{notes[k]}</p>}
          </li>
        );
      })}
    </ul>
  );
}
