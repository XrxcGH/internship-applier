/**
 * The application status model — docs/11 § M7.
 *
 * ONE RULE SHAPES THIS FILE. The tool may move an application forward only as far as
 * `awaiting_submit`. Everything from `submitted` onward is the user reporting what
 * happened in the world, because the tool never submitted anything and has no way to know.
 * That is gate G4 extended into the tracker rather than a separate policy.
 *
 * `ghosted` is the exception in the other direction: it is DERIVED, never set. An employer
 * does not send a rejection you can record. Silence past a threshold is what it is, and
 * calling it a status the user has to click would be asking them to declare their own
 * rejection.
 */
import type { ApplicationStatus } from '@ia/shared';

/** Who is allowed to move an application into each status. */
export const SET_BY: Record<ApplicationStatus, 'tool' | 'user' | 'derived'> = {
  draft: 'tool',
  answers_ready: 'tool',
  filled: 'tool',
  awaiting_submit: 'tool',
  // Everything below happened outside this app.
  submitted: 'user',
  acknowledged: 'user',
  interview: 'user',
  offer: 'user',
  rejected: 'user',
  withdrawn: 'user',
  ghosted: 'derived',
};

/**
 * Legal next statuses.
 *
 * Deliberately permissive after `submitted`: real hiring processes skip stages, and a
 * state machine that refuses "submitted → interview" because no acknowledgement was
 * recorded would be wrong about the world rather than protecting anything.
 */
const NEXT: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: ['answers_ready', 'withdrawn'],
  answers_ready: ['filled', 'draft', 'withdrawn'],
  filled: ['awaiting_submit', 'answers_ready', 'withdrawn'],
  awaiting_submit: ['submitted', 'filled', 'withdrawn'],
  submitted: ['acknowledged', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted'],
  acknowledged: ['interview', 'offer', 'rejected', 'withdrawn', 'ghosted'],
  interview: ['interview', 'offer', 'rejected', 'withdrawn', 'ghosted'],
  offer: ['rejected', 'withdrawn'],
  rejected: [],
  withdrawn: [],
  ghosted: ['acknowledged', 'interview', 'offer', 'rejected', 'withdrawn'],
};

export interface TransitionRefusal {
  ok: false;
  reason: string;
}

export type TransitionResult = { ok: true } | TransitionRefusal;

export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
  by: 'tool' | 'user',
): TransitionResult {
  if (from === to) return { ok: true };

  if (SET_BY[to] === 'derived') {
    return {
      ok: false,
      reason: 'Ghosted is worked out from how long it has been quiet, not set by hand.',
    };
  }

  if (by === 'tool' && SET_BY[to] === 'user') {
    return {
      ok: false,
      reason:
        `Only you can mark an application ${to}. This tool never submitted it and has no ` +
        'way to know what happened after.',
    };
  }

  if (!NEXT[from].includes(to)) {
    return {
      ok: false,
      reason:
        NEXT[from].length === 0
          ? `An application that is ${from} has finished. Reopening it is not a state change.`
          : `Cannot go from ${from} to ${to}. From here: ${NEXT[from].join(', ')}.`,
    };
  }

  return { ok: true };
}

// ────────────────────────────────────────────────────────────── derived state

/** Silence past this many days reads as ghosted. */
export const GHOST_AFTER_DAYS = 45;

/** A deadline closer than this is worth surfacing. */
export const DEADLINE_SOON_DAYS = 7;

export const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(from: string, to: Date | string): number {
  const end = to instanceof Date ? to.getTime() : new Date(to).getTime();
  return Math.floor((end - new Date(from).getTime()) / DAY_MS);
}

export interface TrackedApplication {
  id: string;
  status: ApplicationStatus;
  company: string;
  title: string;
  applyUrl: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  /**
   * When the employer first responded, from the status-change history.
   *
   * Needed because reply time was being measured from submission to NOW, which is not a
   * reply time at all — it climbed by a day every day for applications answered months
   * ago. Null when nothing has come back yet.
   */
  respondedAt: string | null;
  deadlineAt: string | null;
  answerCount: number;
  approvedCount: number;
}

export type Attention =
  | 'deadline_soon'
  | 'deadline_passed'
  | 'unfinished'
  | 'ready_to_fill'
  | 'awaiting_your_submit'
  | 'silent'
  | 'none';

export interface Derived {
  /** `ghosted` when silence has run long, otherwise the stored status. */
  effectiveStatus: ApplicationStatus;
  attention: Attention;
  /** One sentence, in the second person, saying what to do. Null when nothing is needed. */
  nudge: string | null;
  daysSinceSubmitted: number | null;
  daysUntilDeadline: number | null;
}

/**
 * What this application needs from the user right now.
 *
 * Returns exactly one thing. A tracker that reports four concurrent concerns per row is a
 * tracker nobody reads, so the checks are ordered by urgency and the first one wins.
 */
export function derive(app: TrackedApplication, now = new Date()): Derived {
  const daysSinceSubmitted = app.submittedAt ? daysBetween(app.submittedAt, now) : null;
  const daysUntilDeadline = app.deadlineAt ? -daysBetween(app.deadlineAt, now) : null;

  const openStatuses: ApplicationStatus[] = ['draft', 'answers_ready', 'filled', 'awaiting_submit'];
  const isOpen = openStatuses.includes(app.status);

  const silent =
    app.status === 'submitted' &&
    daysSinceSubmitted !== null &&
    daysSinceSubmitted >= GHOST_AFTER_DAYS;

  const effectiveStatus: ApplicationStatus = silent ? 'ghosted' : app.status;

  // Urgency order. A closing deadline on an unfinished application beats everything,
  // because it is the only concern here with a hard stop.
  if (isOpen && daysUntilDeadline !== null && daysUntilDeadline < 0) {
    return {
      effectiveStatus,
      attention: 'deadline_passed',
      nudge:
        `This closed ${String(Math.abs(daysUntilDeadline))} ` +
        `day${Math.abs(daysUntilDeadline) === 1 ? '' : 's'} ago and was never submitted.`,
      daysSinceSubmitted,
      daysUntilDeadline,
    };
  }

  if (isOpen && daysUntilDeadline !== null && daysUntilDeadline <= DEADLINE_SOON_DAYS) {
    return {
      effectiveStatus,
      attention: 'deadline_soon',
      nudge:
        daysUntilDeadline === 0
          ? 'This closes today.'
          : `This closes in ${String(daysUntilDeadline)} day${daysUntilDeadline === 1 ? '' : 's'}.`,
      daysSinceSubmitted,
      daysUntilDeadline,
    };
  }

  if (app.status === 'awaiting_submit') {
    return {
      effectiveStatus,
      attention: 'awaiting_your_submit',
      nudge: 'The form is filled. Read it and submit it yourself.',
      daysSinceSubmitted,
      daysUntilDeadline,
    };
  }

  if (isOpen && app.answerCount > 0 && app.approvedCount === app.answerCount) {
    return {
      effectiveStatus,
      attention: 'ready_to_fill',
      nudge: 'Every answer is approved. This one is ready to fill.',
      daysSinceSubmitted,
      daysUntilDeadline,
    };
  }

  if (isOpen) {
    const left = app.answerCount - app.approvedCount;
    return {
      effectiveStatus,
      attention: 'unfinished',
      nudge:
        app.answerCount === 0
          ? 'No questions added yet.'
          : // The verb has to agree too, not just the noun.
            `${String(left)} answer${left === 1 ? '' : 's'} still need${left === 1 ? 's' : ''} your approval.`,
      daysSinceSubmitted,
      daysUntilDeadline,
    };
  }

  if (silent) {
    return {
      effectiveStatus,
      attention: 'silent',
      nudge: `No word for ${String(daysSinceSubmitted)} days. Worth following up, or letting go.`,
      daysSinceSubmitted,
      daysUntilDeadline,
    };
  }

  return {
    effectiveStatus,
    attention: 'none',
    nudge: null,
    daysSinceSubmitted,
    daysUntilDeadline,
  };
}

/** Board columns, in the order a person thinks about them. */
export const BOARD_COLUMNS: Array<{ key: string; label: string; statuses: ApplicationStatus[] }> = [
  { key: 'preparing', label: 'Preparing', statuses: ['draft', 'answers_ready', 'filled'] },
  { key: 'to_submit', label: 'Ready for you', statuses: ['awaiting_submit'] },
  { key: 'waiting', label: 'Waiting', statuses: ['submitted', 'acknowledged'] },
  { key: 'talking', label: 'Talking', statuses: ['interview'] },
  { key: 'closed', label: 'Closed', statuses: ['offer', 'rejected', 'withdrawn', 'ghosted'] },
];

export function columnFor(status: ApplicationStatus): string {
  return BOARD_COLUMNS.find((c) => c.statuses.includes(status))?.key ?? 'closed';
}
