/**
 * One fill run, start to pause to finish — docs/07 § Pause/resume.
 *
 * A run is a long-lived thing with a browser attached, so it lives in memory keyed by
 * application and is driven by three calls: start, continue, discard. It deliberately does
 * NOT run to completion in one request: a login wall or a bot check has to stop it and
 * hand the browser to the person, and that only works if the run can be suspended with the
 * page still open in front of them.
 *
 * WHAT IT NEVER DOES. It never submits, never types a password, never solves a challenge.
 * When it cannot proceed it says why and waits.
 */
import type { ApplicationAnswer, ConfirmedProfile } from '@ia/shared';
import { publish } from '../../infra/events';
import { logger } from '../../infra/logger';
import { detectIntervention, openSession, type BrowserSession, type Intervention } from './browser';
import { executePlan, describeFill, type FillResult } from './fill';
import { buildFormMap, summarizeMap, type FormMap } from './formMap';
import { buildFillPlan, type FillPlan } from './plan';

export type RunState = 'opening' | 'reading' | 'awaiting_user' | 'filling' | 'done' | 'failed';

export interface FillRun {
  applicationId: string;
  state: RunState;
  url: string;
  session?: BrowserSession;
  map?: FormMap;
  plan?: FillPlan;
  result?: FillResult;
  intervention?: Intervention;
  message: string;
  startedAt: string;
}

/** Live runs. One per application; starting a second discards the first. */
const runs = new Map<string, FillRun>();

export function getRun(applicationId: string): FillRun | undefined {
  return runs.get(applicationId);
}

/**
 * One definition of "skipped", so the event stream and the serialized run cannot disagree.
 *
 * The `fill.done` event used to count everything that was not `ok`, so a run with ten filled
 * fields, two mismatches and one skip announced three skipped fields while GET /fill reported
 * one, and a UI showing live totals beside the fetched run showed two different numbers for
 * the same fields. Mismatches and failures now travel in their own counts, so narrowing this
 * one to a genuine skip drops nothing on the floor.
 */
function countSkipped(result: FillResult): number {
  return result.results.filter((r) => r.status === 'skipped').length;
}

/** Everything the UI needs, minus the things that cannot be serialized. */
export function serializeRun(run: FillRun) {
  return {
    applicationId: run.applicationId,
    state: run.state,
    url: run.url,
    message: run.message,
    startedAt: run.startedAt,
    intervention: run.intervention ?? null,
    summary: run.map ? summarizeMap(run.map) : null,
    fields: run.result?.results.map((r) => ({
      label: r.field.label,
      semantic: r.field.semantic,
      redlineCategory: r.field.redlineCategory ?? null,
      status: r.status,
      readBack: r.readBack ?? null,
      note: r.note ?? null,
    })),
    counts: run.result
      ? {
          filled: run.result.filled,
          mismatched: run.result.mismatched,
          failed: run.result.failed,
          skipped: countSkipped(run.result),
        }
      : null,
  };
}

export async function discardRun(applicationId: string): Promise<void> {
  const run = runs.get(applicationId);
  if (!run) return;
  await run.session?.close();
  runs.delete(applicationId);
}

export interface StartInput {
  applicationId: string;
  applyUrl: string;
  profile: ConfirmedProfile;
  answers: ApplicationAnswer[];
  resumePath?: string;
  /** Tests only. A real run is always watched. */
  headless?: boolean;
}

/**
 * Opens the page and reads it. Stops before typing anything.
 *
 * Reading and filling are separate steps on purpose: it means the user sees what the tool
 * found, and what it intends to leave alone, while the form is still untouched.
 */
export async function startRun(input: StartInput): Promise<FillRun> {
  await discardRun(input.applicationId);

  const run: FillRun = {
    applicationId: input.applicationId,
    state: 'opening',
    url: input.applyUrl,
    message: 'Opening the application page.',
    startedAt: new Date().toISOString(),
  };
  runs.set(input.applicationId, run);

  try {
    run.session = await openSession({ headless: input.headless ?? false });
    await run.session.page.goto(input.applyUrl, { waitUntil: 'domcontentloaded' });

    run.state = 'reading';
    const blocked = await detectIntervention(run.session.page);
    if (blocked) {
      run.state = 'awaiting_user';
      run.intervention = blocked;
      run.message = blocked.detail;
      publish({
        type: 'fill.needs_input',
        applicationId: input.applicationId,
        reason: blocked.reason,
        detail: blocked.detail,
      });
      return run;
    }

    run.map = await buildFormMap(run.session.page);
    run.plan = buildFillPlan({
      fields: run.map.fields,
      profile: input.profile,
      answers: input.answers,
      resumePath: input.resumePath,
    });
    run.message = summarizeMap(run.map);
    return run;
  } catch (err) {
    run.state = 'failed';
    run.message = err instanceof Error ? err.message : String(err);
    logger.error({ err, applicationId: input.applicationId }, 'fill run failed to start');
    return run;
  }
}

/**
 * Types the plan. Requires a run that has already read the page.
 *
 * Re-reads the form first: the user may have signed in, dismissed a banner, or advanced a
 * wizard step since the map was built, and filling against a stale map is how a value ends
 * up in the wrong box.
 */
export async function continueRun(input: StartInput): Promise<FillRun> {
  const run = runs.get(input.applicationId);
  if (!run?.session) {
    throw new Error('No open fill run for this application. Start one first.');
  }

  // Everything past this point ends in a state the user can act on, the same way starting a
  // run does. A throw from the re-read or from the fill used to leave the run parked in
  // `reading` or `filling` forever: the route reported the error, but the screen kept
  // offering "Fill the form" — the card is deliberately withheld from a `failed` run
  // precisely because its only outcome is the same error a second time — and the run's own
  // message still described the page as it looked before anything went wrong.
  try {
    const blocked = await detectIntervention(run.session.page);
    if (blocked) {
      run.state = 'awaiting_user';
      run.intervention = blocked;
      run.message = blocked.detail;
      // The same announcement start makes. An intervention that appears BETWEEN start and
      // continue — a login wall behind a wizard step, a bot check the first interaction
      // triggered — is the one a watching UI is least expecting, and without this it reached
      // nobody: the run parked in awaiting_user and the screen sat unchanged until someone
      // reloaded it by hand.
      publish({
        type: 'fill.needs_input',
        applicationId: input.applicationId,
        reason: blocked.reason,
        detail: blocked.detail,
      });
      return run;
    }

    run.intervention = undefined;
    run.state = 'reading';
    run.map = await buildFormMap(run.session.page);
    run.plan = buildFillPlan({
      fields: run.map.fields,
      profile: input.profile,
      answers: input.answers,
      resumePath: input.resumePath,
    });

    run.state = 'filling';
    run.result = await executePlan(run.session.page, run.plan, (r) => {
      publish({
        type: 'fill.step',
        applicationId: input.applicationId,
        field: r.field.label,
        status: r.status,
        note: r.note,
      });
    });

    run.state = 'done';
    run.message = describeFill(run.result);

    // All four outcomes, because this is the last thing a stream consumer ever hears about
    // the run. Announcing only `filled` and `skipped` meant a run that typed five values and
    // had three of them quietly rejected by the page signed off as "5 filled, 0 skipped":
    // the two counts that carried the bad news had nowhere to go, and a screen watching the
    // stream showed a clean run over a form with three wrong boxes in it.
    publish({
      type: 'fill.done',
      applicationId: input.applicationId,
      filled: run.result.filled,
      mismatched: run.result.mismatched,
      failed: run.result.failed,
      skipped: countSkipped(run.result),
    });

    return run;
  } catch (err) {
    run.state = 'failed';
    run.message = err instanceof Error ? err.message : String(err);
    logger.error({ err, applicationId: input.applicationId }, 'fill run failed while continuing');
    // Rethrown rather than returned, because the route turns this into the 502 the review
    // screen already knows how to show. Marking the run is what the caller cannot do.
    throw err;
  }
}

/**
 * Closes every open browser. Called on shutdown so a crashed server does not leave windows
 * scattered across the user's desktop.
 */
export async function closeAllRuns(): Promise<void> {
  await Promise.all([...runs.keys()].map((id) => discardRun(id)));
}
