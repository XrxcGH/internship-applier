/**
 * Turning a FormMap plus a profile into a list of intended values — docs/07 § Fill.
 *
 * Pure. No browser, no I/O, so what the tool is *about to type* is fully testable and can
 * be shown to the user before a single keystroke happens.
 *
 * THE PLAN IS ALLOWED TO BE INCOMPLETE. Every field the plan cannot fill confidently comes
 * back as a `skip` with a reason, and the reasons are the interesting output: "this is
 * yours to answer", "your profile has no GPA", "I could not tell what this field is".
 * A plan that silently omitted them would leave the user to discover the gaps by reading
 * the finished form, which is exactly the review burden this design tries to remove.
 */
import type { ApplicationAnswer, ConfirmedProfile, FormField } from '@ia/shared';
import { checkRedline } from './redlines';

export interface FillAction {
  field: FormField;
  value: string;
  /** Where the value came from, shown in the pre-submit review. */
  source: 'profile' | 'answer' | 'file';
  /** Absolute path, for file inputs. */
  filePath?: string;
}

export interface FillSkip {
  field: FormField;
  reason: 'redline' | 'unknown' | 'no_data' | 'needs_answer';
  note: string;
}

export interface FillPlan {
  actions: FillAction[];
  skips: FillSkip[];
}

export interface PlanInput {
  fields: FormField[];
  profile: ConfirmedProfile;
  /** Approved answers, keyed however the caller likes; matched by question text. */
  answers: ApplicationAnswer[];
  resumePath?: string;
}

const firstName = (full: string): string => full.trim().split(/\s+/)[0] ?? '';
const lastName = (full: string): string => {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1]! : '';
};

/** Most recent education entry, which is what an application means by "school". */
function currentEducation(p: ConfirmedProfile) {
  return [...p.education].sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''))[0];
}

const DEGREE_LABEL: Record<string, string> = {
  high_school: 'High School',
  associate: 'Associate',
  bachelor: "Bachelor's",
  master: "Master's",
  doctorate: 'Doctorate',
  other: 'Other',
};

/**
 * The value for one semantic, or null when the profile does not have it.
 *
 * Returning null rather than an empty string matters: an empty string is a value, and
 * typing one into a required field would satisfy the form's validation while telling the
 * employer nothing.
 */
export function valueFor(field: FormField, p: ConfirmedProfile): string | null {
  const edu = currentEducation(p);

  switch (field.semantic) {
    case 'first_name':
      return firstName(p.fullName) || null;
    case 'last_name':
      return lastName(p.fullName) || null;
    case 'full_name':
      return p.fullName || null;
    case 'email':
      return p.email || null;
    case 'phone':
      return p.phone ?? null;
    case 'address_line1':
      return p.address.line1 ?? null;
    case 'city':
      return p.address.city ?? p.locationPrefs.base.city ?? null;
    case 'region':
      return p.address.region ?? p.locationPrefs.base.region ?? null;
    case 'postal':
      return p.address.postal ?? null;
    case 'country':
      return p.address.country || null;
    case 'linkedin':
      return p.links.linkedin ?? null;
    case 'github':
      return p.links.github ?? null;
    case 'portfolio':
      return p.links.portfolio ?? null;
    case 'website':
      return p.links.portfolio ?? p.links.other[0] ?? null;
    case 'school':
      return edu?.institution ?? null;
    case 'degree':
      return edu ? (DEGREE_LABEL[edu.level] ?? edu.level) : null;
    case 'major':
      return edu?.fieldOfStudy ?? null;
    case 'gpa':
      return edu?.gpa ? String(edu.gpa.value) : null;
    case 'graduation_date':
      return edu?.endDate ?? p.derived.expectedGraduation ?? null;
    case 'enrollment_status':
      return p.derived.academicLevel === 'none' ? null : 'Currently enrolled';
    case 'work_auth':
      // The question is "are you authorized", and the profile knows.
      return p.workAuthorization.status === 'unknown'
        ? null
        : p.workAuthorization.needsSponsorship
          ? 'No'
          : 'Yes';
    case 'sponsorship_needed':
      return p.workAuthorization.status === 'unknown'
        ? null
        : p.workAuthorization.needsSponsorship
          ? 'Yes'
          : 'No';
    case 'start_date':
      return p.availability.start ?? null;
    case 'end_date':
      return p.availability.end ?? null;
    case 'hours_available':
      return p.availability.hoursPerWeek ? String(p.availability.hoursPerWeek) : null;
    case 'salary_expectation':
      return p.preferences.minStipend ? String(p.preferences.minStipend) : null;
    default:
      return null;
  }
}

/** Loose match between a form's question and an approved answer's question. */
function matchAnswer(field: FormField, answers: ApplicationAnswer[]): ApplicationAnswer | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const target = norm(field.label);
  if (!target) return null;

  let best: { a: ApplicationAnswer; score: number } | null = null;
  for (const a of answers) {
    const q = norm(a.questionText);
    const words = new Set(q.split(' ').filter((w) => w.length > 3));
    if (words.size === 0) continue;
    const hits = [...words].filter((w) => target.includes(w)).length;
    const score = hits / words.size;
    if (!best || score > best.score) best = { a, score };
  }
  return best && best.score >= 0.6 ? best.a : null;
}

export function buildFillPlan(input: PlanInput): FillPlan {
  const actions: FillAction[] = [];
  const skips: FillSkip[] = [];

  for (const field of input.fields) {
    // Belt and braces. The map already marked redlines, but this is the last gate before
    // a value is chosen, and it re-derives rather than trusting the label it was handed.
    const red = checkRedline({ label: field.label, name: field.locator });
    if (field.semantic === 'REDLINE' || red) {
      skips.push({
        field,
        reason: 'redline',
        note: red?.note ?? 'Left for you to complete.',
      });
      continue;
    }

    if (field.semantic === 'unknown') {
      skips.push({
        field,
        reason: 'unknown',
        note: 'This tool could not tell what this field is asking for, so it left it blank.',
      });
      continue;
    }

    if (field.control === 'file') {
      if (field.semantic === 'resume_upload' && input.resumePath) {
        actions.push({
          field,
          value: input.resumePath,
          source: 'file',
          filePath: input.resumePath,
        });
      } else {
        skips.push({
          field,
          reason: 'no_data',
          note:
            field.semantic === 'resume_upload'
              ? 'No resume file is attached to this application.'
              : 'Attach this file yourself.',
        });
      }
      continue;
    }

    if (field.semantic === 'essay') {
      const answer = matchAnswer(field, input.answers);
      if (!answer) {
        skips.push({
          field,
          reason: 'needs_answer',
          note: 'Add this question in the workspace and approve an answer for it first.',
        });
      } else if (!answer.approvedAt) {
        // Gate G3, enforced again here. An unapproved answer never reaches a form.
        skips.push({
          field,
          reason: 'needs_answer',
          note: 'You have not approved this answer yet.',
        });
      } else {
        const text = answer.finalText || answer.draftText;
        actions.push({
          field,
          // Respect the form's own budget rather than letting it truncate silently.
          value: field.maxLength ? text.slice(0, field.maxLength) : text,
          source: 'answer',
        });
      }
      continue;
    }

    const value = valueFor(field, input.profile);
    if (value === null || value === '') {
      skips.push({
        field,
        reason: 'no_data',
        note: `Your profile has no ${field.semantic.replace(/_/g, ' ')} to fill in.`,
      });
      continue;
    }

    actions.push({
      field,
      value: field.maxLength ? value.slice(0, field.maxLength) : value,
      source: 'profile',
    });
  }

  return { actions, skips };
}

/** Counts for the pre-submit review. */
export function summarizePlan(plan: FillPlan): string {
  const red = plan.skips.filter((s) => s.reason === 'redline').length;
  const other = plan.skips.length - red;
  return (
    `${plan.actions.length} field${plan.actions.length === 1 ? '' : 's'} to fill, ` +
    `${red} left for you, ${other} with nothing to put in ${other === 1 ? 'it' : 'them'}.`
  );
}
