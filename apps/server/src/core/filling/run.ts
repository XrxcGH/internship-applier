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
          skipped: run.result.results.filter((r) => r.status === 'skipped').length,
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

  const blocked = await detectIntervention(run.session.page);
  if (blocked) {
    run.state = 'awaiting_user';
    run.intervention = blocked;
    run.message = blocked.detail;
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
      status: r.status === 'ok' ? 'ok' : r.status === 'skipped' ? 'skipped' : 'failed',
      note: r.note,
    });
  });

  run.state = 'done';
  run.message = describeFill(run.result);

  publish({
    type: 'fill.done',
    applicationId: input.applicationId,
    filled: run.result.filled,
    skipped: run.result.results.filter((r) => r.status !== 'ok').length,
  });

  return run;
}

/**
 * Closes every open browser. Called on shutdown so a crashed server does not leave windows
 * scattered across the user's desktop.
 */
export async function closeAllRuns(): Promise<void> {
  await Promise.all([...runs.keys()].map((id) => discardRun(id)));
}
