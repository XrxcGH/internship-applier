/**
 * CSV export — docs/11 § M7, and docs/10 § "your data is yours".
 *
 * Exists so the tracker is not a place data goes to be trapped. A student who wants their
 * application list in a spreadsheet, or who stops using this tool entirely, should be able
 * to leave with everything in one click.
 *
 * Written by hand rather than with a library because the escaping rules are four lines and
 * the failure mode of getting them wrong is loud rather than subtle.
 */
import type { TrackedApplication } from './status';
import { derive } from './status';

/**
 * RFC 4180 escaping, plus one thing it does not cover.
 *
 * A field beginning with `=`, `+`, `-`, or `@` is executed as a formula when the file is
 * opened in Excel or Sheets. A job title like "=Senior Engineer" is not plausible, but a
 * company name pulled off the internet is untrusted text, and a CSV that can run a formula
 * on the user's machine is a real problem with a one-character fix.
 */
function cell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

const COLUMNS = [
  'Company',
  'Role',
  'Status',
  'Needs attention',
  'Answers approved',
  'Deadline',
  'Submitted',
  'Days since submitted',
  'Source',
  'Apply URL',
  'Created',
] as const;

export function toCsv(apps: TrackedApplication[], now = new Date()): string {
  const rows = apps.map((a) => {
    const d = derive(a, now);
    return [
      a.company,
      a.title,
      d.effectiveStatus,
      d.nudge ?? '',
      `${String(a.approvedCount)} of ${String(a.answerCount)}`,
      a.deadlineAt?.slice(0, 10) ?? '',
      a.submittedAt?.slice(0, 10) ?? '',
      d.daysSinceSubmitted ?? '',
      a.source ?? '',
      a.applyUrl,
      a.createdAt.slice(0, 10),
    ].map(cell);
  });

  // CRLF, because that is what RFC 4180 says and what Excel expects.
  return [COLUMNS.map(cell).join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}

export function csvFilename(now = new Date()): string {
  return `applications-${now.toISOString().slice(0, 10)}.csv`;
}
