/**
 * Outcome statistics — docs/11 § M7.
 *
 * THE HARD PART HERE IS NOT ARITHMETIC. A student applying to internships will have five
 * applications before they have fifty, and "40% response rate" computed over five is
 * noise presented as insight. Worse, it is noise that changes behaviour: someone reads
 * "Greenhouse postings respond 3x more often" off six data points and stops applying
 * through Lever.
 *
 * So every rate carries the count it came from, and a rate below `MIN_FOR_RATE`
 * observations is returned as `null` with a reason rather than as a number. The UI shows
 * the reason. This is the same instinct as the rest of the app: say what is not known,
 * rather than presenting a confident-looking figure that is mostly variance.
 */
import type { ApplicationStatus } from '@ia/shared';
import type { TrackedApplication } from './status';
import { daysBetween, derive } from './status';

/**
 * Below this many decided applications, a percentage is not worth showing.
 *
 * Ten is not a statistical claim, it is a judgement: at ten, one outcome moves the figure
 * by ten points, which is visibly coarse; at five, one outcome moves it twenty and the
 * number looks precise while meaning nothing.
 */
export const MIN_FOR_RATE = 10;

export interface Rate {
  /** Null when there is not enough to say. */
  value: number | null;
  numerator: number;
  denominator: number;
  /** Present when `value` is null: why not. */
  why?: string;
}

function rate(numerator: number, denominator: number, what: string): Rate {
  if (denominator < MIN_FOR_RATE) {
    return {
      value: null,
      numerator,
      denominator,
      why:
        denominator === 0
          ? `No ${what} yet.`
          : `Only ${String(denominator)} ${what} so far. A percentage from that would be mostly noise.`,
    };
  }
  return { value: Math.round((numerator / denominator) * 100) / 100, numerator, denominator };
}

export const RESPONDED: ApplicationStatus[] = ['acknowledged', 'interview', 'offer', 'rejected'];
const ADVANCED: ApplicationStatus[] = ['interview', 'offer'];
const DECIDED: ApplicationStatus[] = ['interview', 'offer', 'rejected', 'ghosted', 'acknowledged'];

export interface Funnel {
  total: number;
  preparing: number;
  awaitingSubmit: number;
  submitted: number;
  responded: number;
  interviewing: number;
  offers: number;
  rejected: number;
  ghosted: number;
  withdrawn: number;
}

export interface GroupStat {
  key: string;
  submitted: number;
  responded: number;
  advanced: number;
  responseRate: Rate;
}

export interface Stats {
  funnel: Funnel;
  responseRate: Rate;
  interviewRate: Rate;
  /** Median days from submitting to the first sign of life. Null when too few. */
  medianDaysToResponse: number | null;
  bySource: GroupStat[];
  /** Plain sentences. The UI shows these instead of inviting the user to interpret rates. */
  notes: string[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round(((s[mid - 1]! + s[mid]!) / 2) * 10) / 10;
}

function groupBy(apps: TrackedApplication[], key: (a: TrackedApplication) => string): GroupStat[] {
  const groups = new Map<string, TrackedApplication[]>();
  for (const a of apps) {
    const k = key(a);
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }

  return [...groups.entries()]
    .map(([k, list]) => {
      const submitted = list.filter((a) => a.submittedAt).length;
      const responded = list.filter((a) => RESPONDED.includes(a.status)).length;
      const advanced = list.filter((a) => ADVANCED.includes(a.status)).length;
      return {
        key: k,
        submitted,
        responded,
        advanced,
        responseRate: rate(responded, submitted, 'submitted applications'),
      };
    })
    .sort((a, b) => b.submitted - a.submitted);
}

export function computeStats(apps: TrackedApplication[], now = new Date()): Stats {
  const derived = apps.map((a) => ({ app: a, d: derive(a, now) }));
  const effective = (a: TrackedApplication) =>
    derived.find((x) => x.app.id === a.id)?.d.effectiveStatus ?? a.status;

  const counted = apps.map((a) => ({ ...a, status: effective(a) }));

  const funnel: Funnel = {
    total: counted.length,
    preparing: counted.filter((a) => ['draft', 'answers_ready', 'filled'].includes(a.status))
      .length,
    awaitingSubmit: counted.filter((a) => a.status === 'awaiting_submit').length,
    submitted: counted.filter((a) => a.submittedAt !== null).length,
    // Ever heard back, not currently sitting in a status that means it. An acknowledgement
    // followed by long silence reads as ghosted, and counting only the present status would
    // quietly drop it back out of "responded" — the response rate would fall week by week
    // for applications that did, in fact, respond.
    responded: counted.filter((a) => a.respondedAt !== null || RESPONDED.includes(a.status)).length,
    interviewing: counted.filter((a) => a.status === 'interview').length,
    offers: counted.filter((a) => a.status === 'offer').length,
    rejected: counted.filter((a) => a.status === 'rejected').length,
    ghosted: counted.filter((a) => a.status === 'ghosted').length,
    withdrawn: counted.filter((a) => a.status === 'withdrawn').length,
  };

  /**
   * Response time, measured only where both ends are genuinely known.
   *
   * This used to read `daysSinceSubmitted`, which is submission-to-NOW — nothing about
   * the response entered the calculation, so the number shown under "Typical reply time"
   * climbed by one every day, forever, for applications that were answered in March. Both
   * ends now come from timestamps: submission, and the first status change into a
   * responded state.
   */
  const responseDays = apps
    .filter((a) => a.submittedAt !== null && a.respondedAt !== null)
    .map((a) => daysBetween(a.submittedAt!, a.respondedAt!))
    .filter((d) => d >= 0);

  const decidedCount = counted.filter((a) => DECIDED.includes(a.status)).length;

  const notes: string[] = [];
  if (funnel.total === 0) {
    notes.push('Nothing tracked yet. Approve a posting in the queue to start.');
  } else if (funnel.submitted === 0) {
    notes.push(
      `${String(funnel.total)} application${funnel.total === 1 ? '' : 's'} in progress, none submitted yet. ` +
        'Outcome figures start once you have submitted some.',
    );
  } else if (decidedCount < MIN_FOR_RATE) {
    notes.push(
      `${String(funnel.submitted)} submitted, ${String(decidedCount)} decided. ` +
        'Too few to draw rates from yet, so the counts below are just counts.',
    );
  }

  if (funnel.ghosted > 0) {
    notes.push(
      `${String(funnel.ghosted)} went quiet with no reply. That is normal and says nothing about you.`,
    );
  }
  if (funnel.awaitingSubmit > 0) {
    notes.push(
      `${String(funnel.awaitingSubmit)} ${funnel.awaitingSubmit === 1 ? 'is' : 'are'} filled and waiting for you to submit.`,
    );
  }

  return {
    funnel,
    responseRate: rate(funnel.responded, funnel.submitted, 'submitted applications'),
    interviewRate: rate(
      funnel.interviewing + funnel.offers,
      funnel.submitted,
      'submitted applications',
    ),
    medianDaysToResponse: responseDays.length >= 3 ? median(responseDays) : null,
    bySource: groupBy(apps, (a) => a.source ?? 'unknown'),
    notes,
  };
}
